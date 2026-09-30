/**
 * STEUERBERATER & BUCHFUEHRUNGSINTELLIGENZ 02B / Block 4 — Aufgaben-Integrität.
 *
 *   - Reines Anzeigen (Heute, Eingang, Aufgaben, Assistent) schreibt keine
 *     Aufgabe mehr.
 *   - Vollzahlung schliesst die Auto-Aufgabe; eine Teilzahlung lässt sie offen,
 *     aktualisiert aber offenen Betrag und Priorität.
 *   - Eine Zahlungsrücknahme erzeugt die neue Episode sofort — lokal und beim
 *     Cloud-Abgleich.
 *   - Manuelle Wiedervorlagen bleiben unangetastet.
 *   - Der tägliche Abgleich beim App-Start läuft einmal je Tag.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { HeutePage } from '../../pages/HeutePage';
import { EingangPage } from '../../pages/EingangPage';
import { AufgabenPage } from '../../pages/AufgabenPage';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore, getVorgangInvoice } from '../vorgangService';
import { recordPayment, removePayment } from '../invoicePaymentService';
import { getAllTasksFromStore, setTaskStoreForTests } from '../taskStore';
import { isTaskOpen, normalizeTask } from '../taskNormalize';
import { scanPendingItems } from '../pendingEngineService';
import { answerQuestion } from '../officeAssistantService';
import {
  reconcileInvoicePaymentTasks,
  runDailyInvoicePaymentTaskReconcile,
  resetDailyInvoicePaymentTaskReconcileForTests,
} from './invoicePaymentTaskSync';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { applySyncPullCandidateSafely } from '../sync/syncPullPersistService';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncCoordinatorForTests } from '../sync/syncCoordinator';
import type { AppPersistedState, Task, VorgangInvoice } from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';

const VORGANG = 'v-02b';
const INVOICE = 'inv-02b';
const TODAY = '2026-09-01';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE,
    number: 'RE-2026-201',
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

const overdueTasks = (): Task[] =>
  getAllTasksFromStore().filter((task) => task.taskKind === 'payment_overdue' && task.sourceId === INVOICE);
const openOverdue = () => overdueTasks().filter((task) => isTaskOpen(task));

function seed(invoice: VorgangInvoice = rechnung()): void {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Bad Beispiel', invoices: [invoice] })]);
  setTaskStoreForTests([]);
}

beforeEach(() => {
  localStorage.clear();
  resetSyncOutboxForTests();
  resetSyncChangeTrackerForTests();
  resetSyncCoordinatorForTests();
  resetDailyInvoicePaymentTaskReconcileForTests();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('02B / A — kein persistentes Schreiben durch reines Anzeigen', () => {
  it('Heute, Eingang, Aufgaben, Pending-Scan und Assistent legen keine Aufgabe an', async () => {
    seed();
    const before = JSON.stringify(getAllTasksFromStore());
    expect(before).toBe('[]');

    renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 }}>
          <HeutePage />
        </AppProvider>
      </MemoryRouter>,
    );
    renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 }}>
          <EingangPage />
        </AppProvider>
      </MemoryRouter>,
    );
    // Aufgaben-Seite mit echten Effekten (früher schrieb ihr Effekt).
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 }}>
            <AufgabenPage />
          </AppProvider>
        </MemoryRouter>,
      );
    });
    act(() => root.unmount());

    scanPendingItems(TODAY);
    answerQuestion('Was ist heute wichtig?', TODAY);

    expect(JSON.stringify(getAllTasksFromStore())).toBe(before);
  });

  it('der ausdrückliche Abgleich (App-Start/Sync/Aktion) legt die Aufgabe an — genau einmal', () => {
    seed();
    expect(reconcileInvoicePaymentTasks({ today: TODAY }).created).toHaveLength(1);
    expect(reconcileInvoicePaymentTasks({ today: TODAY }).created).toHaveLength(0);
    expect(openOverdue()).toHaveLength(1);
  });

  it('der tägliche App-Start-Abgleich läuft einmal je Tag', () => {
    seed();
    expect(runDailyInvoicePaymentTaskReconcile(new Date('2026-09-01T08:00:00.000Z'))).toBe(true);
    expect(runDailyInvoicePaymentTaskReconcile(new Date('2026-09-01T18:00:00.000Z'))).toBe(false);
    expect(runDailyInvoicePaymentTaskReconcile(new Date('2026-09-02T08:00:00.000Z'))).toBe(true);
    expect(openOverdue()).toHaveLength(1);
  });
});

describe('02B / B–D — Zahlung, Teilzahlung, Rücknahme, manuelle Wiedervorlage', () => {
  it('Teilzahlung: Aufgabe bleibt offen, offener Betrag und Priorität werden aktualisiert', () => {
    seed();
    reconcileInvoicePaymentTasks({ today: TODAY });
    const vorher = openOverdue()[0];
    expect(vorher.priority).toBe('kritisch'); // 1.190 € offen
    expect(vorher.description).toContain('1.190,00');

    expect(recordPayment(VORGANG, INVOICE, { amount: 500, date: TODAY }).success).toBe(true);
    const nachher = openOverdue();
    expect(nachher).toHaveLength(1);
    expect(nachher[0].id).toBe(vorher.id);
    expect(nachher[0].description).toContain('690,00');
    expect(nachher[0].priority).toBe('hoch');
  });

  it('Vollzahlung schliesst die Auto-Aufgabe', () => {
    seed();
    reconcileInvoicePaymentTasks({ today: TODAY });
    expect(recordPayment(VORGANG, INVOICE, { amount: 1190, date: TODAY }).success).toBe(true);
    expect(openOverdue()).toHaveLength(0);
  });

  it('Rücknahme: neue offene Episode sofort, ohne späteren Scan; alte bleibt Historie', () => {
    seed();
    reconcileInvoicePaymentTasks({ today: TODAY });
    recordPayment(VORGANG, INVOICE, { amount: 1190, date: TODAY });
    const erledigt = overdueTasks()[0];
    expect(isTaskOpen(erledigt)).toBe(false);

    const paymentId = getVorgangInvoice(VORGANG, INVOICE)!.payments![0].id;
    expect(removePayment(VORGANG, INVOICE, paymentId).success).toBe(true);

    expect(openOverdue()).toHaveLength(1);
    expect(openOverdue()[0].id).not.toBe(erledigt.id);
    expect(isTaskOpen(getAllTasksFromStore().find((task) => task.id === erledigt.id)!)).toBe(false);
  });

  it('manuelle Wiedervorlage zur Zahlungsfrist bleibt nach Zahlung und Abgleich unangetastet', () => {
    seed();
    const wiedervorlage = normalizeTask({
      id: 'task-wv',
      title: 'Wiedervorlage: Zahlung RE-2026-201 prüfen',
      category: 'zahlungen',
      priority: 'mittel',
      dueDate: '2026-06-20',
      linkedInvoiceId: INVOICE,
      sourceType: 'manual',
      taskKind: 'document_reminder',
      autoCreated: false,
    } as Parameters<typeof normalizeTask>[0]);
    setTaskStoreForTests([wiedervorlage]);
    reconcileInvoicePaymentTasks({ today: TODAY });
    recordPayment(VORGANG, INVOICE, { amount: 1190, date: TODAY });
    reconcileInvoicePaymentTasks({ today: TODAY });

    const danach = getAllTasksFromStore().find((task) => task.id === 'task-wv')!;
    expect(isTaskOpen(danach)).toBe(true);
    expect(danach.description).toBe(wiedervorlage.description);
    expect(danach.priority).toBe('mittel');
  });
});

describe('02B / B — Sync/Pull konsistent', () => {
  function report(): SyncCoordinatorReport {
    return {
      ...createEmptySyncSimulationReport('2026-09-02T10:00:00.000Z'),
      retryAttempts: 0,
      uploadCount: 0,
      downloadCount: 0,
    } as SyncCoordinatorReport;
  }

  function withPayments(local: AppPersistedState, payments: VorgangInvoice['payments']): AppPersistedState {
    return {
      ...local,
      invoiceEntries: (local.invoiceEntries ?? []).map((entry) =>
        entry.invoice.id === INVOICE ? { ...entry, invoice: { ...entry.invoice, payments } as VorgangInvoice } : entry,
      ),
    };
  }

  it('eine Rücknahme auf einem anderen Gerät öffnet beim Abgleich die neue Episode', () => {
    seed(rechnung({ payments: [{ id: 'pay-1', date: TODAY, amount: 1190, createdAt: '2026-09-01T10:00:00.000Z' }] }));
    // Zu Beginn bezahlt: eine frühere Episode ist erledigt.
    const alt = normalizeTask({
      id: 'task-alt', title: 'Zahlung prüfen: Rechnung RE-2026-201', category: 'zahlungen', priority: 'kritisch',
      linkedInvoiceId: INVOICE, sourceType: 'invoice', sourceId: INVOICE, taskKind: 'payment_overdue', autoCreated: true,
      dedupeKey: `invoice:${INVOICE}:payment_overdue`, status: 'done', completedAt: '2026-09-01T11:00:00.000Z',
    } as Parameters<typeof normalizeTask>[0]);
    setTaskStoreForTests([alt]);
    persistAll();

    const remote = withPayments(buildPersistedStateSnapshot(), []);
    expect(applySyncPullCandidateSafely({ state: remote, report: report() }).persisted).toBe(true);

    expect(openOverdue()).toHaveLength(1);
    expect(isTaskOpen(getAllTasksFromStore().find((task) => task.id === 'task-alt')!)).toBe(false);
  });

  it('eine Teilzahlung auf einem anderen Gerät aktualisiert die offene Aufgabe beim Abgleich', () => {
    seed();
    reconcileInvoicePaymentTasks({ today: TODAY });
    persistAll();
    const remote = withPayments(buildPersistedStateSnapshot(), [
      { id: 'pay-remote', date: TODAY, amount: 500, createdAt: '2026-09-01T10:00:00.000Z' },
    ]);
    expect(applySyncPullCandidateSafely({ state: remote, report: report() }).persisted).toBe(true);
    const offen = openOverdue();
    expect(offen).toHaveLength(1);
    expect(offen[0].description).toContain('690,00');
  });
});
