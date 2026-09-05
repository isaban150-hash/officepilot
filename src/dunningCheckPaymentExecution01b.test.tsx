/**
 * DUNNING-CHECK-PAYMENT-EXECUTION-01B — „Prüfen, ob schon bezahlt" führt
 * wirklich zur Prüfung.
 *
 * Realbefund iPhone/Safari: Die Mahnung war korrekt dargestellt, die
 * Hauptaktion hiess richtig „Prüfen, ob schon bezahlt" — und beim Tippen
 * geschah für den Nutzer nichts Erkennbares.
 *
 * Technisch lief der Klick vollständig durch: `delegate: 'expandDetails'`
 * klappte „Weitere Optionen" auf. Nur lag dieser Bereich unterhalb des
 * Sichtfelds, ohne Scroll, ohne Fokus, ohne Meldung — und beantwortete die
 * Zahlungsfrage ohnehin nicht.
 *
 * **Warum diese Datei existiert:** Die Suite `dunningPrimaryActionRouting01b`
 * endete an der Servicegrenze (`executeDocumentAction` liefert `delegate`) —
 * genau dort, wo der Fehler lag. Hier wird deshalb echt gerendert und echt
 * geklickt.
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
import { addExpense, getAllExpenses } from './services/expenseService';
import { hydrateExpenseStore } from './services/expenseStore';
import { recordExpensePayment } from './services/expensePaymentService';
import { hydrateVorgangStore } from './services/vorgangService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import {
  confirmDocumentFinanceReference,
  resolveDocumentFinanceReference,
} from './services/documentFinanceReferenceService';
import { executeScanResultAction } from './services/officeActionService';
import type { InboxItem } from './types/models';

const SUPPLIER_A = 'Westfalen Testlieferant fuer OfficePilot';
const SUPPLIER_B = 'Andere Bau GmbH';
const INVOICE_NUMBER = 'RE-4711';
const DUNNING_ID = 'inbox-mahnung-exec-01b';

let root: Root;
let host: HTMLDivElement;
let currentPath = '';
let scrolled: string[] = [];

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

/** Eine eingegangene Mahnung — kein Beleg, ein Verweis. */
function dunningItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({ id: DUNNING_ID }),
    title: `Mahnung zu Rechnung ${INVOICE_NUMBER}`,
    sender: SUPPLIER_A,
    classifiedKind: 'mahnung',
    documentType: 'eingangsrechnung',
    recommendedAction: 'zahlung_pruefen',
    markedAsCompanyDocument: true,
    recognizedData: {
      Rechnungsnummer: INVOICE_NUMBER,
      Betrag: '486,20',
      Absender: SUPPLIER_A,
      Lieferant: SUPPLIER_A,
    },
    ...overrides,
  } as InboxItem;
}

function seedExpense(supplierName: string, grossAmount = 486.2): string {
  const result = addExpense({
    title: `Rechnung ${INVOICE_NUMBER}`,
    category: 'material',
    supplierName,
    invoiceNumber: INVOICE_NUMBER,
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
  hydrateExpenseStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([dunningItem()]);
  currentPath = '';
  scrolled = [];
  /*
   * happy-dom kennt `scrollIntoView` nicht. Der Aufruf wird deshalb
   * aufgezeichnet — geprüft wird, dass die Aktion den Bezugsbeleg-Bereich zum
   * Ziel macht, nicht das Scrollverhalten des Browsers.
   */
  Element.prototype.scrollIntoView = function scrollIntoViewStub(this: Element) {
    scrolled.push(this.getAttribute('data-testid') ?? '');
  };
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
              path: '/ausgaben',
              element: createElement(
                'div',
                { 'data-testid': 'expenses-page' },
                createElement(PathProbe),
              ),
            }),
            createElement(Route, {
              path: '/ausgaben/:id',
              element: createElement(
                'div',
                { 'data-testid': 'expense-page' },
                createElement(PathProbe),
              ),
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

/** Die Hauptaktion der kanonischen Ansicht. */
function primaryButton(): HTMLButtonElement {
  const button = find('document-review-apply-button');
  expect(button, 'Hauptaktion nicht gefunden').not.toBeNull();
  return button as HTMLButtonElement;
}

describe('DUNNING-CHECK-PAYMENT-EXECUTION-01B — not_found', () => {
  it('R1: der Klick führt sichtbar zum Bezugsbeleg-Bereich und bietet einen echten Schritt', async () => {
    expect(resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!).status).toBe(
      'not_found',
    );
    await renderDetail();

    expect(primaryButton().textContent).toContain('Prüfen, ob schon bezahlt');
    await click(primaryButton());

    expect(scrolled, 'Der Bezugsbeleg-Bereich wurde nicht angesteuert').toContain(
      'document-finance-reference-section',
    );
    expect(document.activeElement).toBe(find('document-finance-reference-section'));
    expect(find('document-finance-reference-status')?.textContent).toContain(
      'Keine passende Rechnung',
    );
    // Der echte nächste Schritt — keine leere Auswahl.
    expect(find('document-finance-reference-browse'), 'Kein Weg zu den Ausgaben')
      .not.toBeNull();
    expect(find('document-finance-reference-candidates')).toBeNull();
  });

  it('R2: der Klick legt keine Ausgabe an', async () => {
    await renderDetail();
    const before = getAllExpenses().length;

    await click(primaryButton());

    expect(getAllExpenses().length, 'Die Zahlungsprüfung hat gebucht').toBe(before);
    expect(getInboxItemById(DUNNING_ID)?.financeReference ?? null).toBeNull();
  });

  it('R15: der Klick öffnet nicht lediglich „Weitere Optionen"', async () => {
    await renderDetail();
    await click(primaryButton());

    // Der Bereich bleibt eingeklappt: die Prüfung gehört in den Hauptfluss.
    expect(find('document-review-more-content')).toBeNull();
  });

  it('R19: „Ausgaben durchsuchen" öffnet die vorhandene Übersicht', async () => {
    await renderDetail();
    await click(primaryButton());
    await click(find('document-finance-reference-browse')!);

    expect(currentPath).toBe('/ausgaben');
    expect(getAllExpenses().length).toBe(0);
  });
});

describe('DUNNING-CHECK-PAYMENT-EXECUTION-01B — ambiguous', () => {
  let idA = '';
  let idB = '';

  beforeEach(() => {
    /*
     * Dieselbe Rechnungsnummer beim selben Lieferanten zweimal — über
     * `addExpense` ist das nicht herstellbar, dort greift die Dublettensperre
     * (`expense.duplicate`). `ambiguous` beschreibt also einen Bestand, der aus
     * Import oder Altdaten stammt. Der Store wird deshalb direkt befüllt; an
     * der Dublettensperre ändert dieser Block nichts.
     */
    idA = seedExpense(SUPPLIER_A, 486.2);
    const seeded = getAllExpenses()[0]!;
    idB = 'exp-dunning-exec-b';
    hydrateExpenseStore([seeded, { ...seeded, id: idB, grossAmount: 512.4 }]);
    expect(resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!).status).toBe(
      'ambiguous',
    );
  });

  it('R3/R4: der Klick zeigt die vorhandenen Kandidaten mit unterscheidbaren Angaben', async () => {
    await renderDetail();
    await click(primaryButton());

    expect(scrolled).toContain('document-finance-reference-section');
    const list = find('document-finance-reference-candidates');
    expect(list, 'Kandidaten wurden nicht angezeigt').not.toBeNull();
    expect(find(`document-finance-reference-candidate-${idA}`)).not.toBeNull();
    expect(find(`document-finance-reference-candidate-${idB}`)).not.toBeNull();
    // Unterscheidbar: die Beträge trennen die beiden Belege.
    expect(list!.textContent).toContain('486,20');
    expect(list!.textContent).toContain('512,40');
  });

  it('R5: „Öffnen" auf Kandidat A führt genau zu A', async () => {
    await renderDetail();
    await click(primaryButton());
    await click(find(`document-finance-reference-candidate-open-${idA}`)!);

    expect(currentPath).toBe(`/ausgaben/${idA}`);
    expect(currentPath).not.toBe(`/ausgaben/${idB}`);
  });

  it('R6: „Zuordnen" verknüpft genau den gewählten Kandidaten — bewusst und einzeln', async () => {
    await renderDetail();
    await click(primaryButton());
    await click(find(`document-finance-reference-candidate-link-${idB}`)!);

    const reference = getInboxItemById(DUNNING_ID)?.financeReference;
    expect(reference, 'Keine Verknüpfung entstanden').toBeTruthy();
    expect(reference?.targetId).toBe(idB);
    expect(getAllExpenses().length).toBe(2);
  });

  it('R7: ohne Nutzerwahl entsteht keine Verknüpfung', async () => {
    await renderDetail();
    await click(primaryButton());

    expect(
      getInboxItemById(DUNNING_ID)?.financeReference ?? null,
      'Es wurde automatisch zugeordnet',
    ).toBeNull();
  });
});

describe('DUNNING-CHECK-PAYMENT-EXECUTION-01B — conflict und paid_conflict', () => {
  it('R8: conflict führt zum Bezugsbeleg-Bereich und bietet einen sicheren Prüfweg', async () => {
    // Bestätigte Verknüpfung, deren Beleg eine andere Nummer trägt → conflict.
    const otherId = seedExpense(SUPPLIER_B);
    confirmDocumentFinanceReference(DUNNING_ID, {
      targetType: 'expense',
      targetId: otherId,
    });
    hydrateInboxStore([
      { ...getInboxItemById(DUNNING_ID)!, recognizedData: { Rechnungsnummer: 'RE-9999' } },
    ]);
    expect(resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!).status).toBe(
      'conflict',
    );

    await renderDetail();
    await click(primaryButton());

    expect(scrolled).toContain('document-finance-reference-section');
    expect(find('document-finance-reference-status')?.textContent).toContain('widersprechen');
    expect(find('document-finance-reference-browse')).not.toBeNull();
    // Keine automatische Zuordnung: die bestehende Verknüpfung bleibt, wie sie war.
    expect(getInboxItemById(DUNNING_ID)?.financeReference?.targetId).toBe(otherId);
  });

  it('R9/R10: paid_conflict zeigt den Beleg samt „Öffnen" und ändert nichts', async () => {
    const expenseId = seedExpense(SUPPLIER_A);
    const paid = recordExpensePayment(expenseId, { date: '2026-08-15', amount: 486.2 });
    expect(paid.success, JSON.stringify(paid)).toBe(true);
    expect(resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!).status).toBe(
      'paid_conflict',
    );

    await renderDetail();
    await click(primaryButton());

    expect(scrolled).toContain('document-finance-reference-section');
    expect(find('document-finance-reference-target')).not.toBeNull();
    expect(find('document-finance-reference-open'), 'Kein Weg zum Beleg').not.toBeNull();
    // Verknüpfen bleibt bei Konflikt gesperrt.
    expect(find('document-finance-reference-link')).toBeNull();
    // R10 — keine Mutation durch den blossen Klick.
    expect(getAllExpenses().length).toBe(1);
    expect(getInboxItemById(DUNNING_ID)?.financeReference ?? null).toBeNull();
  });
});

describe('DUNNING-CHECK-PAYMENT-EXECUTION-01B — eindeutige Fälle bleiben unverändert', () => {
  it('R11: exact navigiert weiterhin direkt zum Beleg, ohne Umweg', async () => {
    const expenseId = seedExpense(SUPPLIER_A);
    expect(resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!).status).toBe('exact');

    await renderDetail();
    await click(primaryButton());

    expect(currentPath).toBe(`/ausgaben/${expenseId}`);
    // Kein Fokus-Umweg: der eindeutige Fall bleibt Navigation.
    expect(scrolled).not.toContain('document-finance-reference-section');
  });

  it('R12: already_linked öffnet ebenfalls das bestehende Ziel', async () => {
    const expenseId = seedExpense(SUPPLIER_A);
    confirmDocumentFinanceReference(DUNNING_ID, {
      targetType: 'expense',
      targetId: expenseId,
    });
    expect(resolveDocumentFinanceReference(getInboxItemById(DUNNING_ID)!).status).toBe(
      'already_linked',
    );

    await renderDetail();
    await click(primaryButton());

    expect(currentPath).toBe(`/ausgaben/${expenseId}`);
  });
});

describe('DUNNING-CHECK-PAYMENT-EXECUTION-01B — keine Regression', () => {
  it('R13: die Mahnung behält sichtbar die Zahlungsprüfung als Hauptaktion', async () => {
    await renderDetail();

    const label = primaryButton().textContent ?? '';
    expect(label).toContain('Prüfen, ob schon bezahlt');
    expect(label).not.toContain('Vorgang');
    expect(label).not.toContain('Ausgabe erfassen');
  });

  it('R14: eine Zahlungserinnerung verhält sich gleich', async () => {
    hydrateInboxStore([dunningItem({ classifiedKind: 'zahlungserinnerung' })]);
    await renderDetail();

    expect(primaryButton().textContent).toContain('Prüfen, ob schon bezahlt');
    await click(primaryButton());

    expect(scrolled).toContain('document-finance-reference-section');
    expect(getAllExpenses().length).toBe(0);
  });

  /*
   * R16 — `expandDetails` wurde nicht umgedeutet. Der andere Nutzer des
   * Delegates behält seine Bedeutung.
   */
  it('R16: expandDetails bleibt für die Scan-Prüfung unverändert', () => {
    const item = createAuftragInboxItem({ id: 'inbox-scan-exec', recommendedAction: 'klaeren' });
    const result = executeScanResultAction('review', item);

    expect(result.ok).toBe(true);
    expect(result.ok && result.kind).toBe('delegate');
    expect(result.ok && result.kind === 'delegate' && result.delegate).toBe('expandDetails');
  });
});
