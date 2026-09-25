/**
 * FINANZCORE-05C — Überzahlung, Rechnung und Ausgabe nach denselben Regeln.
 *
 * Geprüft wird die Rechenebene: Statusableitung, Schwelle für die
 * Bestätigung, Rücknahme einer Zahlung, und dass ein überbezahlter Beleg
 * weder unter den offenen Forderungen noch unter den offenen
 * Verbindlichkeiten auftaucht.
 *
 * Der Dialog selbst steht in `expenseOverpaymentDialog05c.test.tsx`.
 *
 * Zwei Dinge stehen hier bewusst **doppelt** — einmal für die Rechnung, einmal
 * für die Ausgabe, mit denselben Zahlen (119 / 70 / 130). Genau darum geht es
 * in diesem Block: Die beiden Seiten sollen sich gleich verhalten, und das
 * sieht man nur, wenn man beide dasselbe fragt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  calculateOverpaidAmount,
  getPaymentOverpayAmount,
  isSettledPaymentStatus,
  requiresOverpaymentConfirmation,
  resolveSettlementStatus,
} from './paymentSemantics';
import {
  calculatePaymentSummary,
  canRecordInvoicePayment,
  recordPayment,
  removePayment,
} from '../invoicePaymentService';
import {
  calculateExpensePaymentSummary,
  canRecordExpensePayment,
  recordExpensePayment,
  removeExpensePayment,
} from '../expensePaymentService';
import { summarizeInvoiceOverview } from '../invoiceOverviewService';
import { summarizeExpenseOverview } from '../expenseOverviewService';
import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { setExpenseStoreForTests, getExpenseFromStoreById } from '../expenseStore';
import { normalizeExpense } from '../expenseNormalize';
import { createTestVorgang } from '../../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';

/* ------------------------------------------------------------------ */
/* Vorlagen — beide Seiten mit demselben Beleg: 119,00 EUR             */
/* ------------------------------------------------------------------ */

const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-05c';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0500',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 100,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerSnapshot: {
      name: 'Test Kunde',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  };
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-05c',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-05C',
    title: '05C TEST',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

function zahlung(amount: number, id: string) {
  return { id, date: '2026-06-05', amount, createdAt: '2026-06-05T08:00:00.000Z' };
}

beforeEach(() => {
  resetTestStores();
  hydrateVorgangStore([createTestVorgang({ invoices: [rechnung()] })]);
  setExpenseStoreForTests([]);
});

/* ================================================================== */
/* A — die gemeinsame Regel                                           */
/* ================================================================== */

describe('A — die geteilte Rechenregel', () => {
  it('A1: der Zustand eines positiven Belegs über die ganze Spanne', () => {
    const fall = (paid: number, open: number, overdue = false) =>
      resolveSettlementStatus({
        paidAmount: paid,
        openAmount: open,
        overpaidAmount: calculateOverpaidAmount(119, paid),
        overdue,
      });

    expect(fall(0, 119)).toBe('offen');
    expect(fall(0, 119, true)).toBe('ueberfaellig');
    expect(fall(70, 49)).toBe('teilbezahlt');
    expect(fall(70, 49, true)).toBe('ueberfaellig');
    expect(fall(119, 0)).toBe('bezahlt');
    expect(fall(130, 0)).toBe('ueberbezahlt');
  });

  /*
   * A2 — der Kern von 05C. Bis hierher fiel die Überzahlung durch
   * `openAmount <= 0` auf „bezahlt", und der Status verschwieg, dass Geld zu
   * viel da ist.
   */
  it('A2: überbezahlt ist nicht dasselbe wie bezahlt', () => {
    const ueberbezahlt = resolveSettlementStatus({
      paidAmount: 130,
      openAmount: 0,
      overpaidAmount: 11,
      overdue: false,
    });
    expect(ueberbezahlt).toBe('ueberbezahlt');
    expect(ueberbezahlt).not.toBe('bezahlt');
  });

  /*
   * A3 — überfällig kann nur sein, was aussteht. Ein überbezahlter Beleg hat
   * keinen offenen Betrag mehr, also schlägt die Frist nicht mehr durch.
   */
  it('A3: eine Überzahlung steht über der Überfälligkeit', () => {
    expect(
      resolveSettlementStatus({ paidAmount: 130, openAmount: 0, overpaidAmount: 11, overdue: true }),
    ).toBe('ueberbezahlt');
  });

  it('A4: die Schwelle für die Bestätigung liegt genau bei „mehr als offen“', () => {
    expect(requiresOverpaymentConfirmation(49, 20)).toBe(false);
    expect(requiresOverpaymentConfirmation(49, 49)).toBe(false);
    expect(requiresOverpaymentConfirmation(49, 49.01)).toBe(true);
    expect(requiresOverpaymentConfirmation(49, 60)).toBe(true);
    expect(getPaymentOverpayAmount(49, 60)).toBe(11);
    expect(getPaymentOverpayAmount(49, 20)).toBe(0);
  });

  it('A5: abgegolten heißt bezahlt oder überbezahlt', () => {
    expect(isSettledPaymentStatus('bezahlt')).toBe(true);
    expect(isSettledPaymentStatus('ueberbezahlt')).toBe(true);
    expect(isSettledPaymentStatus('offen')).toBe(false);
    expect(isSettledPaymentStatus('teilbezahlt')).toBe(false);
    expect(isSettledPaymentStatus('ueberfaellig')).toBe(false);
    // Gutschrift und Storno sind keine abgegoltenen Forderungen, sondern etwas anderes.
    expect(isSettledPaymentStatus('gutschrift')).toBe(false);
    expect(isSettledPaymentStatus('storniert')).toBe(false);
  });

  /*
   * A6 — die Überzahlung entsteht aus geflossenem Geld, nie aus einem
   * Vorzeichen. Genau diese Verwechslung war der Befund von 05B-FIX2.
   */
  it('A6: ein negativer Belegbetrag erzeugt für sich keine Überzahlung', () => {
    expect(calculateOverpaidAmount(119, 0)).toBe(0);
    expect(calculateOverpaidAmount(119, 130)).toBe(11);
    expect(calculateOverpaidAmount(Number.NaN, 130)).toBe(0);
  });
});

/* ================================================================== */
/* T — Rechnungen                                                      */
/* ================================================================== */

describe('T — Rechnungen', () => {
  const laden = (): VorgangInvoice =>
    getVorgangById(VORGANG_ID)!.invoices.find((i) => i.id === INVOICE_ID)!;

  const buchen = (amount: number, confirm = false) =>
    recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-06-08', amount }, {
      confirmOverpayment: confirm ? true : undefined,
    });

  it('T1: 119 / bezahlt 0 => offen', () => {
    const s = calculatePaymentSummary(laden());
    expect(s.status).toBe('offen');
    expect(s.openAmount).toBe(119);
    expect(s.overpaidAmount).toBe(0);
  });

  it('T2: 119 / bezahlt 70 => teilbezahlt, offen 49', () => {
    expect(buchen(70).success).toBe(true);
    const s = calculatePaymentSummary(laden());
    expect(s.status).toBe('teilbezahlt');
    expect(s.openAmount).toBe(49);
    expect(s.overpaidAmount).toBe(0);
  });

  it('T3: 119 / bezahlt 119 => bezahlt', () => {
    expect(buchen(119).success).toBe(true);
    const s = calculatePaymentSummary(laden());
    expect(s.status).toBe('bezahlt');
    expect(s.openAmount).toBe(0);
    expect(s.overpaidAmount).toBe(0);
  });

  it('T4: 119 / bezahlt 130 => überbezahlt, Überzahlung 11', () => {
    expect(buchen(70).success).toBe(true);
    expect(buchen(60, true).success).toBe(true);
    const s = calculatePaymentSummary(laden());
    expect(s.paidAmount).toBe(130);
    expect(s.openAmount).toBe(0);
    expect(s.overpaidAmount).toBe(11);
    expect(s.status).toBe('ueberbezahlt');
  });

  it('T5: eine überbezahlte Rechnung zählt nicht zu den offenen Forderungen', () => {
    buchen(70);
    buchen(60, true);
    const totals = summarizeInvoiceOverview();
    expect(totals.openReceivables).toBe(0);
    expect(totals.openInvoiceCount).toBe(0);
    // Und der offene Betrag wird durch die Überzahlung nicht negativ.
    expect(totals.openReceivables).toBeGreaterThanOrEqual(0);
    expect(totals.paidTotal).toBe(130);
  });

  /* T6/T7/T8 — die Schwelle, an der die Rückfrage kommt. */
  it('T6: eine Zahlung über dem offenen Betrag wird ohne Bestätigung abgelehnt', () => {
    buchen(70);
    const result = buchen(60);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('payment.overpaymentConfirmationRequired');
    // Nichts gebucht: der Stand ist unverändert.
    expect(calculatePaymentSummary(laden()).paidAmount).toBe(70);
  });

  it('T7: eine Zahlung genau in Höhe des offenen Betrags braucht keine Bestätigung', () => {
    buchen(70);
    expect(buchen(49).success).toBe(true);
    expect(calculatePaymentSummary(laden()).status).toBe('bezahlt');
  });

  it('T8: eine Zahlung unter dem offenen Betrag braucht keine Bestätigung', () => {
    buchen(70);
    expect(buchen(20).success).toBe(true);
    expect(calculatePaymentSummary(laden()).status).toBe('teilbezahlt');
  });

  it('T9: mit ausdrücklicher Bestätigung wird die Überzahlung gespeichert', () => {
    buchen(70);
    const result = buchen(60, true);
    expect(result.success).toBe(true);
    expect(laden().payments).toHaveLength(2);
    expect(calculatePaymentSummary(laden()).overpaidAmount).toBe(11);
  });

  /*
   * T11 — nach Voll- oder Überzahlung verschwindet die normale Aktion. Bis 05C
   * war die einzige Bedingung „nicht storniert"; ein fachlicher Grund für
   * weitere Zahlungen auf einen ausgeglichenen Beleg war nirgends hinterlegt.
   */
  it('T11: bezahlt und überbezahlt bieten keine normale Zahlungsaktion mehr', () => {
    expect(canRecordInvoicePayment(laden())).toBe(true);
    buchen(70);
    expect(canRecordInvoicePayment(laden())).toBe(true);
    buchen(49);
    expect(canRecordInvoicePayment(laden())).toBe(false);
  });

  it('T11b: auch die überbezahlte Rechnung bietet keine weitere Zahlung an', () => {
    buchen(70);
    buchen(60, true);
    expect(calculatePaymentSummary(laden()).status).toBe('ueberbezahlt');
    expect(canRecordInvoicePayment(laden())).toBe(false);
  });

  /*
   * T12 — der Kontrollfall aus dem Auftrag. Der Status ist abgeleitet, also
   * darf nach der Rücknahme nichts von „überbezahlt" hängen bleiben.
   */
  it('T12: die Rücknahme einer Überzahlung leitet den Zustand neu ab', () => {
    buchen(70);
    buchen(60, true);
    const zuViel = laden().payments!.find((p) => p.amount === 60)!;

    const removed = removePayment(VORGANG_ID, INVOICE_ID, zuViel.id);
    expect(removed.success).toBe(true);
    if (!removed.success) return;

    const s = calculatePaymentSummary(removed.invoice);
    expect(s.paidAmount).toBe(70);
    expect(s.openAmount).toBe(49);
    expect(s.overpaidAmount).toBe(0);
    expect(s.status).toBe('teilbezahlt');
    // Auch das gespeicherte Feld darf nicht stehen bleiben.
    expect(removed.invoice.paymentStatus).toBe('teilbezahlt');
    // Und die Aktion ist wieder verfügbar.
    expect(canRecordInvoicePayment(removed.invoice)).toBe(true);
  });

  it('T12b: nach Rücknahme aller Zahlungen gilt wieder die normale Regel', () => {
    buchen(130, true);
    const alle = [...laden().payments!];
    for (const p of alle) removePayment(VORGANG_ID, INVOICE_ID, p.id);

    const s = calculatePaymentSummary(laden());
    expect(s.paidAmount).toBe(0);
    expect(s.openAmount).toBe(119);
    expect(s.status).toBe('offen');
    expect(laden().paymentStatus).toBe('offen');
  });

  /*
   * T13 — Skonto. `getOpenAmount` liefert 0, sobald der verminderte Betrag
   * fristgerecht geflossen ist, obwohl **weniger** als der volle Betrag
   * gezahlt wurde. Würde die Überzahlung am offenen Betrag hängen statt am
   * Rechnungsbetrag, wäre dieser Beleg fälschlich „überbezahlt".
   */
  it('T13: ein per Skonto ausgeglichener Beleg bleibt bezahlt, nicht überbezahlt', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [rechnung({ skontoText: '2% Skonto bei Zahlung innerhalb von 10 Tagen' })],
      }),
    ]);
    // 2 % von 119,00 = 2,38 → zahlbar 116,62, fristgerecht am 2026-06-05.
    const result = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-06-05', amount: 116.62 }, {});
    expect(result.success).toBe(true);

    const s = calculatePaymentSummary(laden());
    expect(s.openAmount).toBe(0);
    expect(s.overpaidAmount).toBe(0);
    expect(s.status).toBe('bezahlt');
  });

  /* T14 — der Storno behält seinen Vorrang vor jeder Betragsrechnung. */
  it('T14: eine stornierte Rechnung bleibt storniert, auch mit Überzahlung', () => {
    buchen(130, true);
    const storniert = { ...laden(), cancelledAt: '2026-06-10T10:00:00.000Z' };
    const s = calculatePaymentSummary(storniert);
    expect(s.status).toBe('storniert');
    expect(s.openAmount).toBe(0);
    expect(canRecordInvoicePayment(storniert)).toBe(false);
  });
});

/* ================================================================== */
/* U — Ausgaben                                                        */
/* ================================================================== */

describe('U — Ausgaben', () => {
  const laden = (): Expense => getExpenseFromStoreById('exp-05c')!;

  const buchen = (amount: number, confirm = false) =>
    recordExpensePayment('exp-05c', { date: '2026-06-08', amount }, {
      confirmOverpayment: confirm ? true : undefined,
    });

  beforeEach(() => {
    setExpenseStoreForTests([ausgabe()]);
  });

  it('U1: 119 / bezahlt 0 => offen', () => {
    const s = calculateExpensePaymentSummary(laden());
    expect(s.status).toBe('offen');
    expect(s.openAmount).toBe(119);
    expect(s.overpaidAmount).toBe(0);
  });

  it('U2: 119 / bezahlt 70 => teilbezahlt, offen 49', () => {
    expect(buchen(70).success).toBe(true);
    const s = calculateExpensePaymentSummary(laden());
    expect(s.status).toBe('teilbezahlt');
    expect(s.openAmount).toBe(49);
  });

  it('U3: 119 / bezahlt 119 => bezahlt', () => {
    expect(buchen(119).success).toBe(true);
    const s = calculateExpensePaymentSummary(laden());
    expect(s.status).toBe('bezahlt');
    expect(s.openAmount).toBe(0);
    expect(s.overpaidAmount).toBe(0);
  });

  /* U4 — der Kontrollfall aus Abschnitt M des Auftrags. */
  it('U4: 119 / bezahlt 70 + 60 => überbezahlt, Überzahlung 11', () => {
    expect(buchen(70).success).toBe(true);
    expect(buchen(60, true).success).toBe(true);
    const s = calculateExpensePaymentSummary(laden());
    expect(s.paidAmount).toBe(130);
    expect(s.openAmount).toBe(0);
    expect(s.overpaidAmount).toBe(11);
    expect(s.status).toBe('ueberbezahlt');
  });

  it('U5: eine überbezahlte Ausgabe zählt nicht zu den offenen Verbindlichkeiten', () => {
    buchen(70);
    buchen(60, true);
    const totals = summarizeExpenseOverview();
    expect(totals.openLiabilities).toBe(0);
    expect(totals.openExpenseCount).toBe(0);
    expect(totals.openLiabilities).toBeGreaterThanOrEqual(0);
    expect(totals.overdueExpenseCount).toBe(0);
  });

  it('U6: eine Zahlung über dem offenen Betrag wird ohne Bestätigung abgelehnt', () => {
    buchen(70);
    const result = buchen(60);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('payment.overpaymentConfirmationRequired');
    // U10 — abgelehnt heißt: nichts gespeichert.
    expect(laden().payments).toHaveLength(1);
    expect(calculateExpensePaymentSummary(laden()).paidAmount).toBe(70);
  });

  it('U7: eine Zahlung genau in Höhe des offenen Betrags braucht keine Bestätigung', () => {
    buchen(70);
    expect(buchen(49).success).toBe(true);
    expect(calculateExpensePaymentSummary(laden()).status).toBe('bezahlt');
  });

  it('U8: eine Zahlung unter dem offenen Betrag braucht keine Bestätigung', () => {
    buchen(70);
    expect(buchen(20).success).toBe(true);
    expect(calculateExpensePaymentSummary(laden()).status).toBe('teilbezahlt');
  });

  it('U9: mit ausdrücklicher Bestätigung wird die Überzahlung gespeichert', () => {
    buchen(70);
    expect(buchen(60, true).success).toBe(true);
    expect(laden().payments).toHaveLength(2);
    expect(calculateExpensePaymentSummary(laden()).overpaidAmount).toBe(11);
  });

  it('U11: bezahlt und überbezahlt bieten keine normale Zahlungsaktion mehr', () => {
    expect(canRecordExpensePayment(laden())).toBe(true);
    buchen(70);
    expect(canRecordExpensePayment(laden())).toBe(true);
    buchen(60, true);
    expect(calculateExpensePaymentSummary(laden()).status).toBe('ueberbezahlt');
    expect(canRecordExpensePayment(laden())).toBe(false);
  });

  it('U12: die Rücknahme einer Überzahlung leitet den Zustand neu ab', () => {
    buchen(70);
    buchen(60, true);
    const zuViel = laden().payments!.find((p) => p.amount === 60)!;

    const removed = removeExpensePayment('exp-05c', zuViel.id);
    expect(removed.success).toBe(true);
    if (!removed.success) return;

    const s = calculateExpensePaymentSummary(removed.expense);
    expect(s.paidAmount).toBe(70);
    expect(s.openAmount).toBe(49);
    expect(s.overpaidAmount).toBe(0);
    expect(s.status).toBe('teilbezahlt');
    expect(removed.expense.paymentStatus).toBe('teilbezahlt');
    expect(canRecordExpensePayment(removed.expense)).toBe(true);
  });

  it('U12b: nach Rücknahme aller Zahlungen gilt wieder die normale Regel', () => {
    buchen(130, true);
    for (const p of [...laden().payments!]) removeExpensePayment('exp-05c', p.id);
    const s = calculateExpensePaymentSummary(laden());
    expect(s.paidAmount).toBe(0);
    expect(s.openAmount).toBe(119);
    expect(s.status).toBe('offen');
  });

  /* ---- U13/U14 — 05B-FIX2 bleibt unangetastet ---- */

  it('U13: eine Gutschrift behält den Status Gutschrift', () => {
    setExpenseStoreForTests([
      ausgabe({ id: 'exp-credit', netAmount: -100, taxAmount: -19, grossAmount: -119 }),
    ]);
    const credit = getExpenseFromStoreById('exp-credit')!;
    const s = calculateExpensePaymentSummary(credit);
    expect(s.status).toBe('gutschrift');
  });

  /*
   * U14 — die entscheidende Abgrenzung dieses Blocks: Die neue
   * Überzahlungsformel darf den negativen Beleg nicht wieder einfangen. Bei
   * brutto −119 und null Zahlungen ergäbe `max(0, bezahlt − brutto)` genau
   * 119 — die Überzahlung, die 05B-FIX2 beseitigt hat.
   */
  it('U14: eine Gutschrift bekommt keine Überzahlung und keine Zahlungsaktion', () => {
    setExpenseStoreForTests([
      ausgabe({ id: 'exp-credit', netAmount: -100, taxAmount: -19, grossAmount: -119 }),
    ]);
    const credit = getExpenseFromStoreById('exp-credit')!;
    const s = calculateExpensePaymentSummary(credit);

    expect(s.overpaidAmount).toBe(0);
    expect(s.openAmount).toBe(0);
    expect(canRecordExpensePayment(credit)).toBe(false);

    const result = recordExpensePayment('exp-credit', { date: '2026-06-08', amount: 10 }, {
      confirmOverpayment: true,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.payment.notPayable');
  });

  /* U16 — die Kennung bleibt eine echte UUID (05B). */
  it('U16: auch die bestätigte Überzahlung bekommt eine UUID', () => {
    buchen(70);
    const result = buchen(60, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.payment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /* U17 — ein stornierter Beleg bleibt storniert. */
  it('U17: Storno behält Vorrang vor der Überzahlung', () => {
    buchen(130, true);
    const storniert = { ...laden(), cancelledAt: '2026-06-10T10:00:00.000Z' };
    expect(calculateExpensePaymentSummary(storniert).status).toBe('storniert');
    expect(canRecordExpensePayment(storniert)).toBe(false);
  });
});
