/**
 * P0/P1-INTEGRITAET 01B / P1 — eine erledigte Forderung schliesst ihre
 * automatische Überfälligkeitsaufgabe („Zahlung prüfen: Rechnung …").
 *
 * Geprüft über die echten Wege: ausdrückliche Zahlung (`recordPayment`),
 * Storno (`cancelFinalizedInvoice`, Cloud-RPC gestubbt) und ein angewendeter
 * Cloud-Abgleich (`applySyncPullCandidateSafely`). Eine Teilzahlung lässt die
 * Aufgabe offen, manuelle Aufgaben bleiben unberührt, nach einer Rücknahme
 * entsteht eine neue offene Episode.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { hydrateVorgangStore, getVorgangInvoice } from '../vorgangService';
import { recordPayment, removePayment } from '../invoicePaymentService';
import { syncOverdueInvoiceTasks } from '../taskEngineService';
import { getAllTasksFromStore, setTaskStoreForTests } from '../taskStore';
import { completeSettledInvoicePaymentTasks } from './invoicePaymentTaskSync';
import { isTaskDone, isTaskOpen, normalizeTask } from '../taskNormalize';
import { cancelFinalizedInvoice } from './invoiceCancellationService';
import * as invoiceCloud from './workspaceInvoiceCloudService';
import * as workspacePayload from '../workspace/workspaceSyncPayloadService';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { applySyncPullCandidateSafely } from '../sync/syncPullPersistService';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncCoordinatorForTests } from '../sync/syncCoordinator';
import type { AppPersistedState, Task, VorgangInvoice } from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';

const VORGANG = 'v-p1';
const INVOICE = 'inv-p1';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE,
    number: 'RE-2026-101',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      { id: 'l1', orderPositionId: 'op1', description: 'Leistung', quantity: 10, unit: 'Stunden', unitPrice: 100, lineTotal: 1000 },
    ],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    sentAt: '2026-06-01T12:00:00.000Z',
    paymentDueDate: '2026-06-15',
    customerSnapshot: { name: 'Beispiel Kunde', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function setup(invoice: VorgangInvoice = rechnung()): void {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Bad Beispiel', invoices: [invoice] })]);
  setTaskStoreForTests([]);
  expect(syncOverdueInvoiceTasks('2026-09-01')).toHaveLength(1);
}

const overdueTasks = (): Task[] =>
  getAllTasksFromStore().filter((task) => task.taskKind === 'payment_overdue' && task.sourceId === INVOICE);
const openOverdue = () => overdueTasks().filter((task) => isTaskOpen(task));
const doneOverdue = () => overdueTasks().filter((task) => !isTaskOpen(task) && Boolean(task.completedAt));

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests();
  resetSyncChangeTrackerForTests();
  resetSyncCoordinatorForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P1 — ausdrückliche Zahlung', () => {
  it('Vollzahlung → Aufgabe erledigt', () => {
    setup();
    expect(openOverdue()).toHaveLength(1);
    expect(recordPayment(VORGANG, INVOICE, { amount: 1190, date: '2026-09-01' }).success).toBe(true);
    expect(openOverdue()).toHaveLength(0);
    expect(doneOverdue()).toHaveLength(1);
  });

  it('Teilzahlung mit Rest → offen; Restzahlung → erledigt', () => {
    setup();
    expect(recordPayment(VORGANG, INVOICE, { amount: 500, date: '2026-09-01' }).success).toBe(true);
    expect(openOverdue(), 'Teilzahlung darf nicht schliessen').toHaveLength(1);
    expect(recordPayment(VORGANG, INVOICE, { amount: 690, date: '2026-09-02' }).success).toBe(true);
    expect(openOverdue()).toHaveLength(0);
    expect(doneOverdue()).toHaveLength(1);
  });

  it('Skonto mit Rest 0 → erledigt', () => {
    setup(rechnung({ skontoText: '2% Skonto bei Zahlung innerhalb von 10 Tagen', paymentDueDate: '2026-06-30' }));
    // 2 % von 1190 = 23,80 → 1166,20 fristgerecht gezahlt.
    expect(recordPayment(VORGANG, INVOICE, { amount: 1166.2, date: '2026-06-05' }).success).toBe(true);
    expect(openOverdue()).toHaveLength(0);
    expect(doneOverdue()).toHaveLength(1);
  });

  it('Überzahlung → erledigt', () => {
    setup();
    const result = recordPayment(VORGANG, INVOICE, { amount: 1300, date: '2026-09-01' }, { confirmOverpayment: true });
    expect(result.success).toBe(true);
    expect(openOverdue()).toHaveLength(0);
    expect(doneOverdue()).toHaveLength(1);
  });

  it('manuelle Aufgabe und andere Aufgabenarten bleiben unberührt', () => {
    setup();
    const auto = overdueTasks()[0];
    // Manuell angelegt, gleicher Rechnungsbezug — darf nie automatisch schliessen.
    const manuell = normalizeTask({
      id: 'task-manuell',
      title: 'Zahlung prüfen: Rechnung RE-2026-101',
      category: 'zahlungen',
      priority: 'hoch',
      linkedVorgangId: VORGANG,
      linkedInvoiceId: INVOICE,
      sourceType: 'invoice',
      sourceId: INVOICE,
      taskKind: 'payment_overdue',
      autoCreated: false,
    });
    // Automatisch, aber andere Aufgabenart zur selben Rechnung.
    const andereArt = normalizeTask({
      id: 'task-andere-art',
      title: 'Rechnung versenden',
      category: 'zahlungen',
      priority: 'mittel',
      linkedInvoiceId: INVOICE,
      sourceType: 'invoice',
      sourceId: INVOICE,
      taskKind: 'invoice_send',
      autoCreated: true,
    } as Parameters<typeof normalizeTask>[0]);
    setTaskStoreForTests([auto, manuell, andereArt]);
    const vorher = getAllTasksFromStore().filter((task) => task.id !== auto.id);
    expect(vorher.every((task) => isTaskOpen(task))).toBe(true);

    expect(recordPayment(VORGANG, INVOICE, { amount: 1190, date: '2026-09-01' }).success).toBe(true);

    expect(doneOverdue()).toHaveLength(1);
    for (const task of vorher) {
      const nachher = getAllTasksFromStore().find((item) => item.id === task.id);
      expect(nachher?.status, `„${task.title}" wurde verändert`).toBe(task.status);
      expect(nachher?.completedAt).toBe(task.completedAt);
    }
  });

  it('Rücknahme → neue offene Episode möglich, alte Aufgabe bleibt Historie', () => {
    setup();
    const paid = recordPayment(VORGANG, INVOICE, { amount: 1190, date: '2026-09-01' });
    expect(paid.success).toBe(true);
    const first = doneOverdue()[0];
    expect(first).toBeTruthy();

    const paymentId = getVorgangInvoice(VORGANG, INVOICE)!.payments![0].id;
    expect(removePayment(VORGANG, INVOICE, paymentId).success).toBe(true);
    // Die bestehende Überfälligkeitsprüfung legt die neue Episode an.
    expect(syncOverdueInvoiceTasks('2026-09-03')).toHaveLength(1);

    expect(openOverdue()).toHaveLength(1);
    expect(openOverdue()[0].id).not.toBe(first.id);
    expect(isTaskDone(getAllTasksFromStore().find((task) => task.id === first.id)!)).toBe(true);
  });
});

describe('P1 — Storno', () => {
  it('Storno → erledigt', async () => {
    setup();
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue('00000000-0000-0000-0000-0000000e0001');
    vi.spyOn(invoiceCloud, 'rpcCancelWorkspaceInvoice').mockImplementation(async () => ({
      invoice: {
        ...rechnung(),
        cancelledAt: '2026-09-02T10:00:00.000Z',
        cancelReason: 'Doppelt erstellt',
        cancellationKind: 'internal',
      },
    }) as never);

    const result = await cancelFinalizedInvoice({ vorgangId: VORGANG, invoiceId: INVOICE, reason: 'Doppelt erstellt' });
    expect(result.ok).toBe(true);
    expect(openOverdue()).toHaveLength(0);
    expect(doneOverdue()).toHaveLength(1);
  });
});

/** Der Cloud-Stand: dieselbe Rechnung, mit einer Zahlung von einem anderen Gerät. */
function withRemotePayment(local: AppPersistedState, amount: number): AppPersistedState {
  expect(local.invoiceEntries?.some((entry) => entry.invoice.id === INVOICE)).toBe(true);
  return {
    ...local,
    invoiceEntries: (local.invoiceEntries ?? []).map((entry) =>
      entry.invoice.id === INVOICE
        ? {
            ...entry,
            invoice: {
              ...entry.invoice,
              payments: [{ id: 'pay-remote', date: '2026-09-01', amount, createdAt: '2026-09-01T10:00:00.000Z' }],
            } as VorgangInvoice,
          }
        : entry,
    ),
  };
}

describe('P1 — Cloud-/Sync-Zahlungsstand', () => {
  function report(): SyncCoordinatorReport {
    return {
      ...createEmptySyncSimulationReport('2026-09-02T10:00:00.000Z'),
      retryAttempts: 0,
      uploadCount: 0,
      downloadCount: 0,
    } as SyncCoordinatorReport;
  }

  it('eine Zahlung von einem anderen Gerät schliesst die Aufgabe beim Anwenden des Abgleichs', () => {
    setup();
    persistAll();
    const local = buildPersistedStateSnapshot();
    const remote = withRemotePayment(local, 1190);

    const applied = applySyncPullCandidateSafely({ state: remote, report: report() });
    expect(applied.persisted).toBe(true);
    expect(openOverdue()).toHaveLength(0);
    expect(doneOverdue()).toHaveLength(1);
  });

  it('eine Teilzahlung aus dem Abgleich lässt die Aufgabe offen', () => {
    setup();
    persistAll();
    const local = buildPersistedStateSnapshot();
    const remote = withRemotePayment(local, 200);

    expect(applySyncPullCandidateSafely({ state: remote, report: report() }).persisted).toBe(true);
    expect(openOverdue()).toHaveLength(1);
  });

  it('der Abgleich ohne Rechnungsbezug schliesst nichts (keine erfundene Erledigung)', () => {
    setup();
    expect(completeSettledInvoicePaymentTasks()).toEqual([]);
    expect(openOverdue()).toHaveLength(1);
  });
});
