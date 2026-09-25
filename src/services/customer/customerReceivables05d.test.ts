/**
 * FINANZCORE-05D — Kundensaldo, offene Posten und Altersstruktur.
 *
 * Alle Datumsfälle laufen gegen ein **festes** Betrachtungsdatum
 * (`HEUTE`). Ein Aging-Test, der von der Systemuhr abhängt, wechselt
 * irgendwann still die Schublade und meldet dann einen Fehler, den es nie gab.
 *
 * Die Zahlungsregeln selbst werden hier nicht wiederholt — die stehen in
 * `paymentOverpayment05c.test.ts`. Geprüft wird, dass der Kundensaldo sie
 * unverändert übernimmt, statt neben ihnen eine zweite Rechnung aufzumachen.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveAgingBucket,
  summarizeCustomerReceivables,
  RECEIVABLES_AGING_BUCKETS,
} from './customerReceivablesService';
import { getKundenWorkspace } from '../kundenWorkspaceService';
import { calculatePaymentSummary, recordPayment, removePayment } from '../invoicePaymentService';
import { getAllInvoiceOverview } from '../invoiceOverviewService';
import { hydrateVorgangStore, getAllVorgaenge } from '../vorgangService';
import { hydrateCustomerStore } from '../customerStoreService';
import { resolveInvoiceCustomerId } from '../invoice/invoiceCustomerRelation';
import { createTestVorgang } from '../../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import type { Customer, VorgangInvoice } from '../../types/models';
import type { InvoiceOverviewItem } from '../invoiceOverviewService';

/* ------------------------------------------------------------------ */
/* Festes Betrachtungsdatum                                            */
/* ------------------------------------------------------------------ */

const HEUTE = '2026-09-24';

/** Ein Fälligkeitsdatum, das am Stichtag genau `days` Tage zurückliegt. */
function faelligVor(days: number): string {
  const due = new Date(`${HEUTE}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() - days);
  return due.toISOString().slice(0, 10);
}

const KUNDE_A = 'cust-a';
const KUNDE_B = 'cust-b';

function kunde(id: string, name: string): Customer {
  return {
    id,
    name,
    street: 'Industriestrasse 12',
    zip: '33602',
    city: 'Bielefeld',
    createdAt: '2026-01-01T10:00:00.000Z',
  } as Customer;
}

let laufendeNummer = 0;

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  laufendeNummer += 1;
  const amount = overrides.amount ?? 119;
  return {
    id: `inv-${laufendeNummer}`,
    number: `2026-${String(1000 + laufendeNummer)}`,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Leistung',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: amount,
        lineTotal: amount,
      },
    ],
    subtotal: amount,
    taxStatus: 'standard_19',
    amount,
    // Ohne Versandmarkierung ist eine Rechnung nie überfällig — bestehende Regel.
    status: 'versendet',
    sentAt: '2026-06-01',
    sentVia: 'email',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerId: KUNDE_A,
    customerSnapshot: {
      name: 'AZ Testbau GmbH',
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

function zahlung(amount: number, id: string, date = '2026-06-05') {
  return { id, date, amount, createdAt: `${date}T08:00:00.000Z` };
}

/** Die Rechnungen als Übersichtseinträge — dieselbe Quelle wie die Oberfläche. */
function uebersicht(...invoices: VorgangInvoice[]): InvoiceOverviewItem[] {
  hydrateVorgangStore([createTestVorgang({ invoices })]);
  return getAllInvoiceOverview(HEUTE);
}

function saldo(...invoices: VorgangInvoice[]) {
  return summarizeCustomerReceivables(uebersicht(...invoices), HEUTE);
}

beforeEach(() => {
  resetTestStores();
  laufendeNummer = 0;
  hydrateCustomerStore([kunde(KUNDE_A, 'AZ Testbau GmbH'), kunde(KUNDE_B, 'Nordbau GmbH')]);
});

/* ================================================================== */
/* V — Kernsaldo                                                      */
/* ================================================================== */

describe('V — Kernsaldo', () => {
  it('V1: ein Kunde ohne Rechnung hat Saldo 0', () => {
    const s = summarizeCustomerReceivables([], HEUTE);
    expect(s.openReceivables).toBe(0);
    expect(s.overdueReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(0);
    expect(s.netBalance).toBe(0);
    expect(s.openInvoiceCount).toBe(0);
    expect(s.openItems).toHaveLength(0);
    expect(s.overpaidItems).toHaveLength(0);
    expect(s.isSettled).toBe(true);
  });

  it('V2: eine offene Rechnung über 119 ergibt offen 119', () => {
    const s = saldo(rechnung());
    expect(s.openReceivables).toBe(119);
    expect(s.netBalance).toBe(119);
    expect(s.openInvoiceCount).toBe(1);
    expect(s.openItems[0].openAmount).toBe(119);
    expect(s.openItems[0].invoiceAmount).toBe(119);
    expect(s.openItems[0].paidAmount).toBe(0);
    expect(s.isSettled).toBe(false);
  });

  it('V3: 119 / bezahlt 70 ergibt offen 49', () => {
    const s = saldo(rechnung({ payments: [zahlung(70, 'p1')] }));
    expect(s.openReceivables).toBe(49);
    expect(s.partialInvoiceCount).toBe(1);
    expect(s.openItems[0].paidAmount).toBe(70);
    expect(s.openItems[0].openAmount).toBe(49);
  });

  it('V4: 119 / bezahlt 119 ergibt offen 0', () => {
    const s = saldo(rechnung({ payments: [zahlung(119, 'p1')] }));
    expect(s.openReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(0);
    expect(s.netBalance).toBe(0);
    expect(s.openInvoiceCount).toBe(0);
    expect(s.isSettled).toBe(true);
  });

  it('V5: 119 / bezahlt 130 ergibt ein Guthaben von 11', () => {
    const s = saldo(rechnung({ payments: [zahlung(130, 'p1')] }));
    expect(s.openReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(11);
    expect(s.netBalance).toBe(-11);
    expect(s.overpaidInvoiceCount).toBe(1);
    // Die überbezahlte Rechnung gehört nicht unter die offenen Posten.
    expect(s.openItems).toHaveLength(0);
    expect(s.overpaidItems[0].overpaidAmount).toBe(11);
    expect(s.isSettled).toBe(false);
  });

  /*
   * V6/V7 — der Kontrollfall aus Abschnitt F. Der Saldo fasst zusammen, er
   * bucht nicht: Rechnung A bleibt mit vollen 100 offen, obwohl anderswo 20
   * zu viel liegen.
   */
  it('V6/V7: offen 100 und Überzahlung 20 ergeben Saldo 80, ohne A zu schliessen', () => {
    const a = rechnung({ amount: 100 });
    const b = rechnung({ amount: 50, payments: [zahlung(70, 'p1')] });
    const s = saldo(a, b);

    expect(s.openReceivables).toBe(100);
    expect(s.overpaidCredit).toBe(20);
    expect(s.netBalance).toBe(80);

    // Rechnung A ist unverändert offen — keine stille Verrechnung.
    expect(s.openItems).toHaveLength(1);
    expect(s.openItems[0].number).toBe(a.number);
    expect(s.openItems[0].openAmount).toBe(100);
    expect(s.openItems[0].paidAmount).toBe(0);

    // Und B steht getrennt als Guthaben.
    expect(s.overpaidItems).toHaveLength(1);
    expect(s.overpaidItems[0].number).toBe(b.number);
  });

  it('V8: eine stornierte Rechnung zählt weder offen noch als Guthaben', () => {
    const s = saldo(
      rechnung({ cancelledAt: '2026-07-01T10:00:00.000Z', paymentStatus: 'storniert' }),
      rechnung({
        amount: 50,
        cancelledAt: '2026-07-01T10:00:00.000Z',
        paymentStatus: 'storniert',
        payments: [zahlung(80, 'p1')],
      }),
    );
    expect(s.openReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(0);
    expect(s.netBalance).toBe(0);
    expect(s.openItems).toHaveLength(0);
    expect(s.overpaidItems).toHaveLength(0);
    expect(s.aging.notDue).toBe(0);
  });

  /*
   * V9 — Skonto. Die kanonische Summary sagt „offen 0"; würde der Saldo selbst
   * `betrag − bezahlt` rechnen, entstünde hier eine Forderung von 2,38, die es
   * fachlich nicht gibt.
   */
  it('V9: eine per Skonto ausgeglichene Rechnung zählt 0 offen', () => {
    const invoice = rechnung({
      skontoText: '2% Skonto bei Zahlung innerhalb von 10 Tagen',
      payments: [zahlung(116.62, 'p1', '2026-06-05')],
    });
    // Vorbedingung: die vorhandene Regel sieht die Rechnung als beglichen.
    const summary = calculatePaymentSummary(invoice, HEUTE);
    expect(summary.openAmount).toBe(0);
    expect(summary.status).toBe('bezahlt');

    const s = saldo(invoice);
    expect(s.openReceivables).toBe(0);
    expect(s.overdueReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(0);
    expect(s.netBalance).toBe(0);
    expect(s.isSettled).toBe(true);
  });

  it('V10: zwei Kunden werden sauber getrennt', () => {
    const items = uebersicht(
      rechnung({ amount: 100, customerId: KUNDE_A }),
      rechnung({ amount: 250, customerId: KUNDE_B }),
    );
    const vorgaenge = new Map(getAllVorgaenge().map((v) => [v.id, v]));
    const fuer = (id: string) =>
      items.filter(
        (item) =>
          resolveInvoiceCustomerId(
            item.invoice,
            item.vorgangId === null ? null : vorgaenge.get(item.vorgangId) ?? null,
          ) === id,
      );

    expect(summarizeCustomerReceivables(fuer(KUNDE_A), HEUTE).openReceivables).toBe(100);
    expect(summarizeCustomerReceivables(fuer(KUNDE_B), HEUTE).openReceivables).toBe(250);
  });

  /*
   * V11 — Workspace-Isolation. Der Dienst liest ausschliesslich aus dem
   * Speicher des aktiven Workspace; nach einem Wechsel darf keine Zahl des
   * vorigen übrig bleiben. Nachgestellt durch erneutes Befüllen des Speichers,
   * was der Workspace-Wechsel genau so tut.
   */
  it('V11: nach einem Workspace-Wechsel bleibt keine Rechnung des vorigen übrig', () => {
    const ersterSaldo = saldo(rechnung({ amount: 100, customerId: KUNDE_A }));
    expect(ersterSaldo.openReceivables).toBe(100);

    // Zweiter Workspace: derselbe Kunde, andere Rechnung.
    const zweiterSaldo = saldo(rechnung({ amount: 42, customerId: KUNDE_A }));
    expect(zweiterSaldo.openReceivables).toBe(42);
    expect(zweiterSaldo.openItems).toHaveLength(1);

    // Und ein leerer Workspace hat keinen Saldo.
    hydrateVorgangStore([]);
    expect(
      summarizeCustomerReceivables(getAllInvoiceOverview(HEUTE), HEUTE).openReceivables,
    ).toBe(0);
  });
});

/* ================================================================== */
/* W — Altersstruktur                                                 */
/* ================================================================== */

describe('W — Altersstruktur', () => {
  it('die Schwellen der Schubladen', () => {
    expect(resolveAgingBucket(0)).toBe('notDue');
    expect(resolveAgingBucket(1)).toBe('days1to30');
    expect(resolveAgingBucket(30)).toBe('days1to30');
    expect(resolveAgingBucket(31)).toBe('days31to60');
    expect(resolveAgingBucket(60)).toBe('days31to60');
    expect(resolveAgingBucket(61)).toBe('days61to90');
    expect(resolveAgingBucket(90)).toBe('days61to90');
    expect(resolveAgingBucket(91)).toBe('over90');
  });

  it('W1: eine nicht fällige Rechnung steht unter „Nicht fällig“', () => {
    const s = saldo(rechnung({ amount: 500, paymentDueDate: '2099-01-01' }));
    expect(s.aging.notDue).toBe(500);
    expect(s.overdueReceivables).toBe(0);
    expect(s.overdueInvoiceCount).toBe(0);
  });

  it('W2–W5: jede Überfälligkeit landet in ihrer Schublade', () => {
    const s = saldo(
      rechnung({ amount: 200, paymentDueDate: faelligVor(10) }),
      rechnung({ amount: 300, paymentDueDate: faelligVor(45) }),
      rechnung({ amount: 100, paymentDueDate: faelligVor(75) }),
      rechnung({ amount: 400, paymentDueDate: faelligVor(200) }),
    );
    expect(s.aging.days1to30).toBe(200);
    expect(s.aging.days31to60).toBe(300);
    expect(s.aging.days61to90).toBe(100);
    expect(s.aging.over90).toBe(400);
    expect(s.aging.notDue).toBe(0);
    expect(s.overdueReceivables).toBe(1000);
    expect(s.overdueInvoiceCount).toBe(4);
  });

  it('W6: eine teilbezahlte Rechnung steht nur mit ihrem Restbetrag im Bucket', () => {
    const s = saldo(
      rechnung({ amount: 119, paymentDueDate: faelligVor(10), payments: [zahlung(70, 'p1')] }),
    );
    expect(s.aging.days1to30).toBe(49);
    expect(s.openReceivables).toBe(49);
    expect(s.overdueReceivables).toBe(49);
  });

  it('W7: eine bezahlte Rechnung erscheint nicht im Aging', () => {
    const s = saldo(
      rechnung({ amount: 119, paymentDueDate: faelligVor(10), payments: [zahlung(119, 'p1')] }),
    );
    for (const bucket of RECEIVABLES_AGING_BUCKETS) expect(s.aging[bucket]).toBe(0);
  });

  it('W8: eine überbezahlte Rechnung erscheint nicht im Aging', () => {
    const s = saldo(
      rechnung({ amount: 119, paymentDueDate: faelligVor(10), payments: [zahlung(130, 'p1')] }),
    );
    for (const bucket of RECEIVABLES_AGING_BUCKETS) expect(s.aging[bucket]).toBe(0);
    expect(s.overpaidCredit).toBe(11);
  });

  it('W9: eine stornierte Rechnung erscheint nicht im Aging', () => {
    const s = saldo(
      rechnung({
        amount: 119,
        paymentDueDate: faelligVor(200),
        cancelledAt: '2026-07-01T10:00:00.000Z',
        paymentStatus: 'storniert',
      }),
    );
    for (const bucket of RECEIVABLES_AGING_BUCKETS) expect(s.aging[bucket]).toBe(0);
  });

  it('W10: die Summe aller Schubladen ergibt die offenen Forderungen', () => {
    const s = saldo(
      rechnung({ amount: 500, paymentDueDate: '2099-01-01' }),
      rechnung({ amount: 200, paymentDueDate: faelligVor(10) }),
      rechnung({ amount: 100, paymentDueDate: faelligVor(75) }),
      rechnung({ amount: 119, paymentDueDate: faelligVor(45), payments: [zahlung(70, 'p1')] }),
      // Diese zählen nicht mit: bezahlt, überbezahlt, storniert.
      rechnung({ amount: 119, payments: [zahlung(119, 'p2')] }),
      rechnung({ amount: 119, payments: [zahlung(130, 'p3')] }),
      rechnung({ amount: 80, cancelledAt: '2026-07-01T10:00:00.000Z', paymentStatus: 'storniert' }),
    );

    const summe = RECEIVABLES_AGING_BUCKETS.reduce((acc, b) => acc + s.aging[b], 0);
    expect(Math.round(summe * 100) / 100).toBe(s.openReceivables);
    expect(s.openReceivables).toBe(849);
  });

  /*
   * Eine Rechnung ohne Fälligkeitsdatum bekommt keine erfundene Frist. Sie ist
   * nach der vorhandenen Regel nicht überfällig und steht deshalb unter
   * „Nicht fällig" — sichtbar, aber ohne Druck.
   */
  it('W11: eine Rechnung ohne Fälligkeitsdatum steht unter „Nicht fällig“', () => {
    const s = saldo(rechnung({ amount: 300, paymentDueDate: undefined }));
    expect(s.aging.notDue).toBe(300);
    expect(s.overdueReceivables).toBe(0);
    expect(s.openItems[0].dueDate).toBeUndefined();
    expect(s.openItems[0].overdueDays).toBe(0);
  });

  /*
   * Und eine noch nicht versendete Rechnung ebenfalls nicht: `isInvoiceOverdue`
   * verlangt den Versandstatus. Keine zweite Definition von „überfällig".
   *
   * 01H — sie steht aber nicht mehr unter „Nicht fällig", sondern unter
   * „Noch nicht versendet". Mit einem Datum 200 Tage in der Vergangenheit las
   * sich „Nicht fällig" wie ein Rechenfehler (Befund aus der Gesamtabnahme).
   */
  it('W12: eine vorbereitete Rechnung wird nicht überfällig und steht unter „Noch nicht versendet“', () => {
    const s = saldo(
      rechnung({
        amount: 300,
        status: 'vorbereitet',
        sentAt: undefined,
        sentVia: undefined,
        paymentDueDate: faelligVor(200),
      }),
    );
    expect(s.aging.over90).toBe(0);
    expect(s.aging.notDue).toBe(0);
    expect(s.aging.notSent).toBe(300);
    expect(s.overdueReceivables).toBe(0);
    expect(s.openItems[0].agingBucket).toBe('notSent');
    expect(s.openItems[0].overdueDays).toBe(0);
  });

  it('die offenen Posten stehen überfällig zuerst, ältestes zuerst', () => {
    const s = saldo(
      rechnung({ amount: 10, paymentDueDate: '2099-01-01' }),
      rechnung({ amount: 20, paymentDueDate: faelligVor(5) }),
      rechnung({ amount: 30, paymentDueDate: faelligVor(120) }),
    );
    expect(s.openItems.map((i) => i.openAmount)).toEqual([30, 20, 10]);
  });
});

/* ================================================================== */
/* Q — sofortige Aktualisierung                                       */
/* ================================================================== */

describe('Q — der Saldo wird bei jedem Lesen abgeleitet', () => {
  const VORGANG_ID = 'v-test-1';

  function aktuellerSaldo() {
    return summarizeCustomerReceivables(getAllInvoiceOverview(HEUTE), HEUTE);
  }

  it('Zahlung, Überzahlung und Rücknahme schlagen sofort durch', () => {
    const invoice = rechnung({ id: 'inv-live', amount: 119 });
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    expect(aktuellerSaldo().openReceivables).toBe(119);

    // Teilzahlung
    recordPayment(VORGANG_ID, 'inv-live', { date: '2026-06-08', amount: 70 }, {});
    expect(aktuellerSaldo().openReceivables).toBe(49);

    // Überzahlung
    recordPayment(
      VORGANG_ID,
      'inv-live',
      { date: '2026-06-09', amount: 60 },
      { confirmOverpayment: true },
    );
    let s = aktuellerSaldo();
    expect(s.openReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(11);
    expect(s.netBalance).toBe(-11);

    // Rücknahme der Überzahlung — der vorherige Zustand kehrt zurück.
    const zuViel = getAllVorgaenge()[0].invoices.find((i) => i.id === 'inv-live')!
      .payments!.find((p) => p.amount === 60)!;
    removePayment(VORGANG_ID, 'inv-live', zuViel.id);
    s = aktuellerSaldo();
    expect(s.openReceivables).toBe(49);
    expect(s.overpaidCredit).toBe(0);
    expect(s.netBalance).toBe(49);
    expect(s.openItems).toHaveLength(1);
    expect(s.overpaidItems).toHaveLength(0);
  });

  /*
   * Nichts wird gespeichert: Derselbe Speicherinhalt ergibt nach erneutem
   * Befüllen dasselbe Ergebnis. Ein veralteter Saldo kann gar nicht entstehen,
   * weil es keinen gibt.
   */
  it('nach erneutem Hydrieren steht derselbe Saldo', () => {
    const invoice = rechnung({ id: 'inv-reload', amount: 119, payments: [zahlung(70, 'p1')] });
    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    const vorher = aktuellerSaldo();

    hydrateVorgangStore([createTestVorgang({ invoices: [invoice] })]);
    const nachher = aktuellerSaldo();

    expect(nachher.openReceivables).toBe(vorher.openReceivables);
    expect(nachher.netBalance).toBe(vorher.netBalance);
    expect(nachher.aging).toEqual(vorher.aging);
  });
});

/* ================================================================== */
/* Kundenakte — der Dienst hängt an der vorhandenen Zuordnung          */
/* ================================================================== */

describe('Kundenakte', () => {
  it('die Akte liefert den Saldo genau der Rechnungen dieses Kunden', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-a',
        customerId: KUNDE_A,
        invoices: [
          rechnung({ amount: 100, customerId: KUNDE_A }),
          rechnung({ amount: 119, customerId: KUNDE_A, payments: [zahlung(130, 'p1')] }),
        ],
      }),
      createTestVorgang({
        id: 'v-b',
        customerId: KUNDE_B,
        invoices: [rechnung({ amount: 250, customerId: KUNDE_B })],
      }),
    ]);

    const a = getKundenWorkspace('customer', KUNDE_A, HEUTE);
    expect(a).not.toBeNull();
    expect(a!.receivables.openReceivables).toBe(100);
    expect(a!.receivables.overpaidCredit).toBe(11);
    expect(a!.receivables.netBalance).toBe(89);

    const b = getKundenWorkspace('customer', KUNDE_B, HEUTE);
    expect(b!.receivables.openReceivables).toBe(250);
    expect(b!.receivables.overpaidCredit).toBe(0);
  });

  /*
   * Eine Namensänderung darf historische Rechnungen nicht verlieren: Die
   * Zuordnung hängt an der stabilen Kennung, nie am Namen.
   */
  it('eine Namensänderung verliert keine Rechnung', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-a',
        customerId: KUNDE_A,
        invoices: [rechnung({ amount: 100, customerId: KUNDE_A })],
      }),
    ]);
    expect(getKundenWorkspace('customer', KUNDE_A, HEUTE)!.receivables.openReceivables).toBe(100);

    hydrateCustomerStore([kunde(KUNDE_A, 'AZ Testbau GmbH & Co. KG'), kunde(KUNDE_B, 'Nordbau GmbH')]);
    expect(getKundenWorkspace('customer', KUNDE_A, HEUTE)!.receivables.openReceivables).toBe(100);
  });
});

/* ================================================================== */
/* Y — 05B / 05C bleiben unberührt                                     */
/* ================================================================== */

describe('Y — Regression 05B / 05C', () => {
  it('Y1: 119 / bezahlt 70 fliesst mit 49 in den Kundensaldo', () => {
    const s = saldo(rechnung({ amount: 119, payments: [zahlung(70, 'p1')] }));
    expect(s.openReceivables).toBe(49);
  });

  it('Y3: die überbezahlte Ausgangsrechnung ergibt ein Guthaben, keine Forderung', () => {
    const s = saldo(rechnung({ amount: 119, payments: [zahlung(130, 'p1')] }));
    expect(s.overpaidCredit).toBe(11);
    expect(s.openReceivables).toBe(0);
    expect(s.openItems).toHaveLength(0);
  });

  /*
   * Y2 — die Lieferantenseite gehört nicht hierher. Der Kundensaldo liest
   * ausschliesslich Ausgangsrechnungen; eine Ausgabe oder Lieferanten-
   * gutschrift (05B TEST CREDIT) kommt in dieser Rechenkette gar nicht vor.
   * Belegt durch die Eingangsseite dieser Funktion: sie nimmt
   * `InvoiceOverviewItem`, nicht `Expense`.
   */
  it('Y2: der Kundensaldo kennt nur Ausgangsrechnungen', () => {
    hydrateVorgangStore([]);
    const s = summarizeCustomerReceivables(getAllInvoiceOverview(HEUTE), HEUTE);
    expect(s.openReceivables).toBe(0);
    expect(s.overpaidCredit).toBe(0);
    expect(s.isSettled).toBe(true);
  });

  /*
   * Die Absicherung gegen einen negativen Belegbetrag: Ohne tatsächlich
   * geflossenes Geld entsteht kein Guthaben. Sonst läge hier dieselbe
   * Verwechslung vor, die 05B-FIX2 auf der Ausgabenseite beseitigt hat.
   */
  it('ein negativer Rechnungsbetrag ohne Zahlung erzeugt kein Guthaben', () => {
    const s = saldo(rechnung({ amount: -119 }));
    expect(s.overpaidCredit).toBe(0);
    expect(s.overpaidItems).toHaveLength(0);
    expect(s.openReceivables).toBe(0);
    expect(s.netBalance).toBe(0);
  });
});

/* ================================================================== */
/* 01H — „Nicht fällig" gegen „Noch nicht versendet"                  */
/* ================================================================== */

/*
 * Befund aus der Gesamtabnahme: Eine Rechnung mit vergangenem
 * Fälligkeitsdatum stand unter „Nicht fällig", weil sie noch nicht versendet
 * war. Die Fälligkeitsregel ist richtig und bleibt — Zahlung wird erst nach
 * dem Versand erwartet (`isExpectingPayment`). Falsch war nur die Schublade.
 */
describe('01H — Fälligkeit und Versandstatus im Aging', () => {
  const unversendet = { status: 'vorbereitet' as const, sentAt: undefined, sentVia: undefined };

  it('zukünftige Fälligkeit, versendet: „Nicht fällig“', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: '2026-10-15' }));
    expect(s.aging.notDue).toBe(100);
    expect(s.aging.notSent).toBe(0);
    expect(s.openItems[0].overdueDays).toBe(0);
  });

  it('heute fällig, versendet: noch nicht überfällig', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: HEUTE }));
    expect(s.aging.notDue).toBe(100);
    expect(s.aging.days1to30).toBe(0);
    expect(s.overdueReceivables).toBe(0);
  });

  it('gestern fällig, versendet: 1 Tag überfällig', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: faelligVor(1) }));
    expect(s.aging.days1to30).toBe(100);
    expect(s.aging.notDue).toBe(0);
    expect(s.openItems[0].overdueDays).toBe(1);
    expect(s.overdueReceivables).toBe(100);
  });

  it('vergangenes Datum, nicht versendet: „Noch nicht versendet“, nicht überfällig', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: faelligVor(40), ...unversendet }));
    expect(s.aging.notSent).toBe(100);
    expect(s.aging.notDue).toBe(0);
    expect(s.aging.days31to60).toBe(0);
    expect(s.overdueReceivables).toBe(0);
    expect(s.openItems[0].status).not.toBe('ueberfaellig');
  });

  it('zukünftiges Datum, nicht versendet: ebenfalls „Noch nicht versendet“', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: '2099-01-01', ...unversendet }));
    expect(s.aging.notSent).toBe(100);
    expect(s.aging.notDue).toBe(0);
  });

  it('kein Fälligkeitsdatum, versendet: „Nicht fällig“ ohne erfundene Frist', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: undefined }));
    expect(s.aging.notDue).toBe(100);
    expect(s.openItems[0].dueDate).toBeUndefined();
  });

  it('kein Fälligkeitsdatum, nicht versendet: „Noch nicht versendet“', () => {
    const s = saldo(rechnung({ amount: 100, paymentDueDate: undefined, ...unversendet }));
    expect(s.aging.notSent).toBe(100);
    expect(s.openItems[0].dueDate).toBeUndefined();
  });

  it('die Summe aller Schubladen ergibt weiterhin die offenen Forderungen', () => {
    const s = saldo(
      rechnung({ amount: 100, paymentDueDate: faelligVor(40), ...unversendet }),
      rechnung({ amount: 200, paymentDueDate: '2099-01-01' }),
      rechnung({ amount: 300, paymentDueDate: faelligVor(10) }),
    );
    const summe = RECEIVABLES_AGING_BUCKETS.reduce((acc, b) => acc + s.aging[b], 0);
    expect(Math.round(summe * 100) / 100).toBe(s.openReceivables);
    expect(s.openReceivables).toBe(600);
  });
});
