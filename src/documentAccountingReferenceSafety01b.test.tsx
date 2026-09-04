/**
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — eine Mahnung erzeugt keine zweite
 * Verbindlichkeit.
 *
 * Belegter Fehler: „Zahlung prüfen" auf einer Mahnung lief über
 * `createExpenseFromInbox` → `addExpense`. Eine Mahnung ist aber kein Beleg,
 * sondern ein Verweis auf einen bereits vorhandenen. Wer zweimal darauf tippte,
 * hatte die Schuld doppelt in den Büchern.
 *
 * Geprüft wird deshalb zuerst die Wirkung: **Wie viele Ausgaben stehen danach
 * im Speicher?** Erst danach, ob der richtige Beleg gefunden wurde.
 *
 * Synthetische Daten, kein Netz, keine echte Buchung.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createAuftragInboxItem } from './test/fixtures';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { addExpense, getAllExpenses, getExpenseById } from './services/expenseService';
import { hydrateExpenseStore } from './services/expenseStore';
import { recordExpensePayment } from './services/expensePaymentService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateStoresFromStorage, persistAll } from './services/persistenceService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import {
  confirmDocumentFinanceReference,
  isFinanceReferenceOnlyKind,
  resolveDocumentFinanceReference,
} from './services/documentFinanceReferenceService';
import {
  executeDocumentAction,
  isDocumentActionAvailable,
} from './services/officeActionService';
import type { InboxItem } from './types/models';

const SUPPLIER_A = 'Muster GmbH';
const SUPPLIER_B = 'Andere Bau GmbH';
const INVOICE_NUMBER = 'RE-4711';
const DUNNING_ID = 'inbox-mahnung-01b';

let root: Root;
let host: HTMLDivElement;
let currentPath = '';

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

/** Eine eingegangene Mahnung — kein Beleg, ein Verweis. */
function dunningItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({ id: DUNNING_ID }),
    title: 'Mahnung zu Rechnung RE-4711',
    sender: SUPPLIER_A,
    classifiedKind: 'mahnung',
    documentType: 'eingangsrechnung',
    recommendedAction: 'zahlung_pruefen',
    recognizedData: {
      Rechnungsnummer: INVOICE_NUMBER,
      Betrag: '491,20',
      Absender: SUPPLIER_A,
    },
    ...overrides,
  } as InboxItem;
}

/** Die ursprüngliche Lieferantenrechnung, bereits als Ausgabe erfasst. */
function seedExpense(
  supplierName: string,
  invoiceNumber: string,
  grossAmount = 486.2,
): string {
  const result = addExpense({
    title: `Rechnung ${invoiceNumber}`,
    category: 'material',
    supplierName,
    invoiceNumber,
    issueDate: '2026-08-01',
    paymentDueDate: '2026-08-31',
    grossAmount,
    status: 'gebucht',
  });
  expect(result.success, JSON.stringify(result)).toBe(true);
  return result.success ? result.expense.id : '';
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  hydrateExpenseStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([dunningItem()]);
  currentPath = '';
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(rounds = 30): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderDetail(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${DUNNING_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement(
                'div',
                null,
                createElement(PathProbe),
                createElement(EingangDetailPage),
              ),
            }),
            createElement(Route, {
              path: '/ausgaben/:id',
              element: createElement('div', { 'data-testid': 'expense-page' },
                createElement(PathProbe)),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle(10);
}

describe('DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — Dienst', () => {
  /*
   * R1 — der gefährliche Ist-Fall.
   *
   * Die Zusicherung ist bewusst die Zahl der Ausgaben, nicht das Rückgabewert-
   * Objekt: Genau daran wäre der Fehler unsichtbar geblieben.
   */
  it('R1: „Zahlung prüfen" auf einer Mahnung legt keine zweite Ausgabe an', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    const item = getInboxItemById(DUNNING_ID)!;

    const result = executeDocumentAction('check_payment', item);

    expect(result.ok).toBe(true);
    expect(getAllExpenses(), 'Eine zweite Verbindlichkeit ist entstanden').toHaveLength(1);
    expect(getAllExpenses()[0]!.id).toBe(expenseId);
  });

  // R4 — Nummer und Lieferant stimmen: eindeutig.
  it('R4: Rechnungsnummer plus Lieferant ergeben einen eindeutigen Bezug', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);

    expect(match.status).toBe('exact');
    expect(match.matched?.targetId).toBe(expenseId);
    expect(match.direction).toBe('incoming_payable');
  });

  /*
   * R2 — der wichtigste Fall.
   *
   * Eine Mahnung ist kein Beweis dafür, dass wir nicht gezahlt haben. Zahlungen
   * und Status bleiben unangetastet.
   */
  it('R2: eine Mahnung zu einer bezahlten Rechnung meldet den Konflikt', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    expect(
      recordExpensePayment(expenseId, { date: '2026-08-20', amount: 486.2 }).success,
    ).toBe(true);
    const before = getExpenseById(expenseId)!;

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);
    const action = executeDocumentAction('check_payment', getInboxItemById(DUNNING_ID)!);

    expect(match.status).toBe('paid_conflict');
    expect(match.matched?.openAmount).toBe(0);
    expect(action.ok).toBe(true);
    expect(getAllExpenses(), 'Neue Ausgabe trotz bezahlter Rechnung').toHaveLength(1);
    const after = getExpenseById(expenseId)!;
    expect(after.paymentStatus).toBe(before.paymentStatus);
    expect(after.payments).toHaveLength(1);
    expect(after.grossAmount).toBe(before.grossAmount);
  });

  // R3 — Teilzahlung: gefunden, offener Rest bleibt Wahrheit.
  it('R3: eine teilbezahlte Rechnung wird gefunden und behält ihren Restbetrag', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    expect(recordExpensePayment(expenseId, { date: '2026-08-20', amount: 200 }).success).toBe(true);

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);

    expect(match.status).toBe('exact');
    expect(match.matched?.paidAmount).toBe(200);
    expect(match.matched?.openAmount).toBeCloseTo(286.2, 2);
    expect(getAllExpenses()).toHaveLength(1);
  });

  /*
   * R5 — dieselbe Nummer bei zwei Lieferanten.
   *
   * Die Gegenpartei gehört zur Identität; eine globale Nummernsuche mit erstem
   * Treffer wäre ein Buchungsfehler.
   */
  it('R5: dieselbe Rechnungsnummer bei zwei Lieferanten trifft nur den richtigen', () => {
    const expenseA = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    seedExpense(SUPPLIER_B, INVOICE_NUMBER);

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);

    expect(match.status).toBe('exact');
    expect(match.matched?.targetId).toBe(expenseA);
    expect(match.matched?.supplierName).toBe(SUPPLIER_A);
  });

  // R6 — ohne Nummer wird nicht verbunden, und schon gar nicht angelegt.
  it('R6: ohne Rechnungsnummer entsteht kein Bezug und keine Ausgabe', () => {
    seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    hydrateInboxStore([
      dunningItem({ recognizedData: { Betrag: '486,20', Absender: SUPPLIER_A } }),
    ]);

    const item = getInboxItemById(DUNNING_ID)!;
    const match = resolveDocumentFinanceReference(item);
    executeDocumentAction('check_payment', item);

    expect(match.status).toBe('not_found');
    expect(match.matched).toBeNull();
    expect(getAllExpenses()).toHaveLength(1);
  });

  /*
   * R7 — Mahnkosten.
   *
   * Der höhere Betrag darf den Treffer nicht zerstören, muss aber sichtbar
   * bleiben. Der Ursprungsbeleg wird nicht angefasst.
   */
  it('R7: eine Betragsabweichung bleibt sichtbar und ändert die Rechnung nicht', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER, 486.2);

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);

    expect(match.status).toBe('exact');
    expect(match.amountMismatch, 'Mahnkosten wurden nicht als Abweichung gemeldet').toBe(true);
    expect(match.documentAmount).toBeCloseTo(491.2, 2);
    expect(getExpenseById(expenseId)!.grossAmount).toBe(486.2);
  });

  // R8 — eine bestätigte Verbindung wird nicht verdoppelt.
  it('R8: eine bestätigte Verknüpfung meldet sich als bereits verbunden', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    expect(
      confirmDocumentFinanceReference(DUNNING_ID, { targetType: 'expense', targetId: expenseId }).ok,
    ).toBe(true);

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);
    const second = confirmDocumentFinanceReference(DUNNING_ID, {
      targetType: 'expense',
      targetId: expenseId,
    });

    expect(match.status).toBe('already_linked');
    expect(match.matched?.targetId).toBe(expenseId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_linked');
  });

  /*
   * R9 — die bestätigte Wahrheit wird nie still umgehängt.
   *
   * Eine spätere Neuerkennung, die auf einen anderen Beleg zeigt, ist ein
   * Prüffall — kein Anlass, die geprüfte Zuordnung zu ändern.
   */
  it('R9: neue Erkennung hängt eine bestätigte Verknüpfung nicht um', () => {
    const expenseX = seedExpense(SUPPLIER_A, 'RE-1000');
    seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    expect(
      confirmDocumentFinanceReference(DUNNING_ID, { targetType: 'expense', targetId: expenseX }).ok,
    ).toBe(true);

    const match = resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!);

    expect(match.status).toBe('conflict');
    expect(getInboxItemById(DUNNING_ID)!.financeReference?.targetId).toBe(expenseX);
  });

  /*
   * R10 — der legitime Weg bleibt.
   *
   * Eine echte Eingangsrechnung muss weiterhin als Ausgabe erfassbar sein; der
   * Fix darf nicht zu „nie wieder eine Ausgabe aus dem Eingang" werden.
   */
  it('R10: eine normale Eingangsrechnung wird weiterhin als Ausgabe erfasst', () => {
    hydrateInboxStore([
      dunningItem({
        id: DUNNING_ID,
        title: 'Rechnung RE-9000',
        classifiedKind: 'eingangsrechnung',
        recognizedData: { Rechnungsnummer: 'RE-9000', Betrag: '119,00', Absender: SUPPLIER_A },
      }),
    ]);
    const item = getInboxItemById(DUNNING_ID)!;

    expect(isDocumentActionAvailable('record_expense', item, 'eingangsrechnung')).toBe(true);
    const result = executeDocumentAction('record_expense', item, {
      classifiedKind: 'eingangsrechnung',
    });

    expect(result.ok).toBe(true);
    expect(getAllExpenses(), 'Der legitime Erfassungsweg ist kaputt').toHaveLength(1);
    expect(getAllExpenses()[0]!.invoiceNumber).toBe('RE-9000');
  });

  // R11 — die Zahlungserinnerung ist genauso geschützt.
  it('R11: eine Zahlungserinnerung legt ebenfalls keine Ausgabe an', () => {
    seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    hydrateInboxStore([dunningItem({ classifiedKind: 'zahlungserinnerung' })]);
    const item = getInboxItemById(DUNNING_ID)!;

    expect(isFinanceReferenceOnlyKind('zahlungserinnerung')).toBe(true);
    expect(isDocumentActionAvailable('record_expense', item, 'zahlungserinnerung')).toBe(false);
    executeDocumentAction('check_payment', item, { classifiedKind: 'zahlungserinnerung' });

    expect(getAllExpenses()).toHaveLength(1);
  });

  // R14 — die bestätigte Verbindung überlebt einen Neustart.
  it('R14: eine bestätigte Verknüpfung überlebt die Re-Hydrierung', () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    expect(
      confirmDocumentFinanceReference(DUNNING_ID, { targetType: 'expense', targetId: expenseId }).ok,
    ).toBe(true);
    expect(persistAll().success).toBe(true);

    hydrateInboxStore([]);
    expect(getInboxItemById(DUNNING_ID)).toBeUndefined();
    hydrateStoresFromStorage();

    expect(getInboxItemById(DUNNING_ID)?.financeReference?.targetId).toBe(expenseId);
  });
});

describe('DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — Oberfläche', () => {
  /*
   * R12 — der echte produktive Weg.
   *
   * Die Dokumentdetailseite wird gemountet, nichts wird vorbereitet, und die
   * Zusicherung ist wieder die Zahl der Ausgaben.
   */
  it('R12: die Detailseite einer Mahnung zeigt den Beleg und bucht nichts', async () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);

    await renderDetail();

    expect(find('document-finance-reference'), 'Keine Belegprüfung sichtbar').not.toBeNull();
    expect(find('document-finance-reference-target')?.textContent).toContain(INVOICE_NUMBER);
    expect(find('document-finance-reference-amount-mismatch')).not.toBeNull();
    expect(getAllExpenses(), 'Allein das Öffnen hat gebucht').toHaveLength(1);

    await click(find('document-finance-reference-open')!);
    expect(currentPath).toBe(`/ausgaben/${expenseId}`);
    expect(getAllExpenses()).toHaveLength(1);
  });

  /*
   * R13 — Confirm-first.
   *
   * Der Vorschlag darf sichtbar sein; die Verbindung entsteht erst durch den
   * ausdrücklichen Klick.
   */
  it('R13: die Verknüpfung entsteht erst nach ausdrücklicher Bestätigung', async () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);

    await renderDetail();
    expect(
      getInboxItemById(DUNNING_ID)?.financeReference,
      'Verknüpfung ohne Bestätigung entstanden',
    ).toBeUndefined();

    await click(find('document-finance-reference-link')!);

    const reference = getInboxItemById(DUNNING_ID)?.financeReference;
    expect(reference?.targetId).toBe(expenseId);
    expect(reference?.direction).toBe('incoming_payable');
    expect(reference?.confirmedAt).toBeTruthy();
    expect(getAllExpenses(), 'Die Bestätigung hat gebucht').toHaveLength(1);
  });

  // Bei bereits bezahlter Rechnung gibt es keine Verknüpfungs- oder Buchungsaktion.
  it('R2b: bei bereits bezahlter Rechnung bietet die Seite keine Buchungsaktion an', async () => {
    const expenseId = seedExpense(SUPPLIER_A, INVOICE_NUMBER);
    expect(recordExpensePayment(expenseId, { date: '2026-08-20', amount: 486.2 }).success).toBe(true);

    await renderDetail();

    expect(find('document-finance-reference-status')?.textContent).toContain('bereits als bezahlt');
    expect(find('document-finance-reference-link'), 'Verknüpfen trotz Konflikt angeboten')
      .toBeNull();
    expect(find('document-finance-reference-open')).not.toBeNull();
    expect(getAllExpenses()).toHaveLength(1);
  });
});
