/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N07/N08/N10/N11) — die Monatsübergabe.
 *
 * WEISS N07: Belegdatum 30.09., Eingang 02.10. — September 0 unklare Eingänge, Oktober 1.
 * WEISS N08: derselbe ungebuchte Eingang auf „abgelegt" — danach 0 unklare Eingänge.
 * WEISS N10: offene Steueraufgabe ohne Fälligkeit — September 1 fehlender Punkt, Oktober 1.
 * WEISS N11: ein Monat mit einer Mitarbeiterzahlung und sonst nichts — Status „empty".
 *
 *  M1–M3  Belegmonat statt Eingangsmonat; gebucht in einem anderen Monat ist erledigt
 *  A1–A2  abgelegt, aber ungebucht, bleibt offen; ausdrücklich verbunden ist erledigt
 *  T1–T3  undatierte Steueraufgabe: allgemeiner Hinweis, kein „fehlt" in jedem Monat;
 *         Fälligkeit oder verknüpfter Beleg geben den Monat
 *  L1–L3  „leer" nur ohne jede Übergabequelle (Mitarbeiterzahlung, ungeklärter Beleg)
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { collectSteuerberaterMonthFindings, getSteuerberaterMonthOverview } from '../steuerberaterOverviewService';
import { hydrateInboxStore } from '../inboxService';
import { hydrateExpenseStore } from '../expenseStore';
import { hydrateTaskStore } from '../taskService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateEmployeePaymentStore, hydrateEmployeeStore } from '../employee/employeeStore';
import { setAccountingStoreForTests } from '../accounting/accountingStore';
import { setAccountingPeriodStoreForTests } from '../accounting/accountingPeriodStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { resetTestStores } from '../../test/resetStores';
import type { InboxItem, Task } from '../../types/models';
import type { Expense } from '../../types/expense';
import type { EmployeePayment } from '../../types/employee';

function eingang(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-n07',
    title: 'Rechnung Baustoff Süd',
    documentType: 'eingangsrechnung',
    sender: 'Baustoff Süd GmbH',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'steuerberater_vorbereiten',
    digitalFolder: { id: 'dig', name: 'Eingang', path: '/Eingang/' },
    paperFiling: { folderId: 'f', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: '2026-10-02T08:00:00.000Z',
    recognizedData: { Datum: '30.09.2026', Betrag: '119,00 €' },
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    ...overrides,
  } as InboxItem;
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-n07',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'BS-1',
    title: 'Material',
    description: '',
    issueDate: '2026-09-30',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'baustoff süd gmbh|bs-1',
    tags: [],
    linkedInboxId: 'inbox-n07',
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

function steueraufgabe(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-n10',
    title: 'Fahrtenbuch an den Steuerberater',
    description: '',
    status: 'open',
    priority: 'mittel',
    category: 'steuern',
    sourceType: 'manual',
    taskKind: 'steuerberater_export',
    dedupeKey: 'n10',
    autoCreated: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    type: 'steuerberater_export',
    ...overrides,
  } as Task;
}

function mitarbeiterzahlung(overrides: Partial<EmployeePayment> = {}): EmployeePayment {
  return {
    id: 'emp-pay-n11',
    employeeId: 'emp-1',
    employeeName: 'Max Muster',
    kind: 'advance',
    amount: 200,
    paymentDate: '2026-08-14',
    paymentMethod: 'cash',
    receiptReference: 'MZ-2026-001',
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  } as EmployeePayment;
}

const unklar = (monthKey: string) => collectSteuerberaterMonthFindings(monthKey).unclearDocuments.map((doc) => doc.id);
const monat = (monthKey: string) => getSteuerberaterMonthOverview(new Date(2026, 9, 12), 'de-DE', monthKey);

beforeEach(() => {
  resetTestStores();
  hydrateInboxStore([]);
  hydrateExpenseStore([]);
  hydrateTaskStore([]);
  hydrateInvoiceStore([]);
  hydrateEmployeeStore([]);
  hydrateEmployeePaymentStore([]);
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000fc0a1',
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
});

describe('N07 — Belegmonat', () => {
  it('M1: Belegdatum 30.09., Eingang 02.10. → September, nicht Oktober', () => {
    hydrateInboxStore([eingang()]);
    expect(unklar('2026-09')).toEqual(['inbox-n07']);
    expect(unklar('2026-10')).toEqual([]);
  });

  it('M2: ohne lesbares Belegdatum zählt der Eingangstag (Europe/Berlin)', () => {
    // 30.09. 23:30 UTC ist in Berlin schon der 01.10.
    hydrateInboxStore([eingang({ recognizedData: {}, receivedAt: '2026-09-30T23:30:00.000Z' })]);
    expect(unklar('2026-10')).toEqual(['inbox-n07']);
    expect(unklar('2026-09')).toEqual([]);
  });

  it('M3: gebucht im Belegmonat ist in jedem Monat erledigt', () => {
    hydrateInboxStore([eingang({ recognizedData: {}, receivedAt: '2026-10-02T08:00:00.000Z' })]);
    hydrateExpenseStore([ausgabe()]);
    expect(unklar('2026-09')).toEqual([]);
    expect(unklar('2026-10')).toEqual([]);
  });
});

describe('N08 — abgelegt ist nicht gebucht', () => {
  it('A1: ein abgelegter, ungebuchter Beleg bleibt in der Übergabe', () => {
    hydrateInboxStore([eingang({ status: 'abgelegt' })]);
    expect(unklar('2026-09')).toEqual(['inbox-n07']);
  });

  it('A2: ausdrücklich mit einer Ausgabe verbunden ist erledigt', () => {
    hydrateInboxStore([
      eingang({
        status: 'abgelegt',
        financeReference: {
          direction: 'incoming_payable',
          targetType: 'expense',
          targetId: 'exp-anders',
          referenceNumber: 'BS-1',
          counterpartyKey: 'baustoff süd',
          confirmedAt: '2026-10-03T10:00:00.000Z',
        },
      }),
    ]);
    expect(unklar('2026-09')).toEqual([]);
  });
});

describe('N10 — Steueraufgaben ohne Monatsbezug', () => {
  it('T1: ohne Fälligkeit und Beleg — allgemeiner Hinweis, in keinem Monat „fehlt"', () => {
    hydrateTaskStore([steueraufgabe()]);
    for (const key of ['2026-09', '2026-10']) {
      const befund = collectSteuerberaterMonthFindings(key);
      expect(befund.missingItems.map((item) => item.id)).not.toContain('task-n10');
      expect(befund.generalTaxTasks.map((item) => item.id)).toEqual(['task-n10']);
    }
    expect(monat('2026-10').generalTaxTasks).toEqual([{ id: 'task-n10', title: 'Fahrtenbuch an den Steuerberater' }]);
  });

  it('T2: mit Fälligkeit nur in ihrem Monat', () => {
    hydrateTaskStore([steueraufgabe({ dueDate: '2026-09-30' })]);
    expect(collectSteuerberaterMonthFindings('2026-09').missingItems.map((item) => item.id)).toContain('task-n10');
    expect(collectSteuerberaterMonthFindings('2026-10').missingItems.map((item) => item.id)).not.toContain('task-n10');
    expect(collectSteuerberaterMonthFindings('2026-10').generalTaxTasks).toEqual([]);
  });

  it('T3: mit verknüpftem Beleg im Belegmonat', () => {
    hydrateInboxStore([eingang()]);
    hydrateTaskStore([steueraufgabe({ linkedInboxId: 'inbox-n07' })]);
    expect(collectSteuerberaterMonthFindings('2026-09').missingItems.map((item) => item.id)).toContain('task-n10');
    expect(collectSteuerberaterMonthFindings('2026-10').missingItems.map((item) => item.id)).not.toContain('task-n10');
  });
});

describe('N11 — „leer" nur ohne jede Übergabequelle', () => {
  it('L1: nur eine Mitarbeiterzahlung — nicht leer', () => {
    hydrateEmployeePaymentStore([mitarbeiterzahlung()]);
    const august = monat('2026-08');
    expect(august.employeePaymentCount).toBe(1);
    expect(august.documentCount).toBe(0);
    expect(august.state).not.toBe('empty');
  });

  it('L2: nur ein ungeklärter Beleg — nicht leer', () => {
    hydrateInboxStore([eingang()]);
    const september = monat('2026-09');
    expect(september.documentCount).toBe(0);
    expect(september.unclearDocuments).toHaveLength(1);
    expect(september.state).not.toBe('empty');
  });

  it('L3: wirklich nichts — leer', () => {
    expect(monat('2026-07').state).toBe('empty');
  });
});
