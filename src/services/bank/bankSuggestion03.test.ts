/**
 * BANKABGLEICH-V1 BLOCK 3 — Zuordnungsvorschläge.
 *
 * Geprüft wird die eine Eigenschaft, auf die es bei Geld ankommt: Der Dienst
 * behauptet nie mehr, als er belegen kann. Er schlägt vor, er nennt Gründe,
 * er gibt Mehrdeutigkeit zu — und er rührt keinen Cent an.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBankSuggestions,
  normalizeDocumentNumber,
  normalizePartyName,
} from './bankSuggestionService';
import {
  commitBankImport,
  listBankTransactions,
  resetBankTransactionsForTests,
} from './bankTransactionStore';
import { createBankAccount, resetBankAccountsForTests } from './bankAccountStore';
import { parseBankStatementCsv } from './bankStatementCsvService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateExpenseStore, getExpenseStoreSnapshot } from '../expenseStore';
import type { Expense } from '../../types/expense';
import type { StoredInvoiceEntry, VorgangInvoice } from '../../types/models';
import type { BankTransaction } from '../../types/bankTransaction';

const HEUTE = '2026-10-10';

/* -------------------------------------------------------------------------- */
/* Testbestand                                                                 */
/* -------------------------------------------------------------------------- */

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-0014',
    status: 'versendet',
    date: '2026-10-01',
    issueDate: '2026-10-01',
    type: 'schlussrechnung',
    positions: [],
    subtotal: 2000,
    taxStatus: 'standard_19',
    taxAmount: 380,
    total: 2380,
    /* `getOpenAmount` rechnet gegen `amount` — nicht gegen `total`. */
    amount: 2380,
    payments: [],
    customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
    ...overrides,
  } as unknown as VorgangInvoice;
}

function eintrag(invoice: VorgangInvoice): StoredInvoiceEntry {
  return { invoice, vorgangId: null };
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Handel GmbH',
    invoiceNumber: 'LR-2026-55123',
    title: 'Materiallieferung',
    description: '',
    issueDate: '2026-10-01',
    paymentDueDate: '2026-10-20',
    taxStatus: 'standard_19',
    netAmount: 1000,
    taxAmount: 190,
    grossAmount: 1190.5,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'baustoff handel gmbh|lr-2026-55123',
    tags: [],
    digitalFolder: { id: 'd', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'T' },
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Eine Bankbewegung über den echten Importweg — kein handgebautes Objekt. */
function bewegung(zeile: string, kontoName = 'Geschäftskonto'): BankTransaction {
  const csv = parseBankStatementCsv(
    ['Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag', zeile].join('\n'),
    'auszug.csv',
  );
  if (!csv.ok) throw new Error(`nicht lesbar: ${csv.problem}`);
  const konto = createBankAccount(kontoName);
  const importId = commitBankImport(csv.preview, konto.id).importId;
  /* listBankTransactions sortiert neueste zuerst — der Index allein traegt nicht. */
  const neu = listBankTransactions().find((eintrag) => eintrag.importId === importId);
  if (!neu) throw new Error('Bewegung nicht gefunden');
  return neu;
}

function vorschlagFuer(t: BankTransaction) {
  return buildBankSuggestions([t]).get(t.id)!;
}

describe('BANKABGLEICH-03 Zuordnungsvorschläge', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
    hydrateVorgangStore([]);
    hydrateInvoiceStore([]);
    hydrateExpenseStore([]);
  });

  /* ---- Normalisierung ---- */

  it('N1 — Trennzeichen fallen weg, Ziffern bleiben', () => {
    expect(normalizeDocumentNumber('RE-2026-0014')).toBe('RE20260014');
    expect(normalizeDocumentNumber('RE 2026 0014')).toBe('RE20260014');
    expect(normalizeDocumentNumber('RE/2026/0014')).toBe('RE20260014');
    /* Führende Nullen bleiben — sonst wären zwei echte Rechnungen eine. */
    expect(normalizeDocumentNumber('RE-2026-14')).not.toBe(normalizeDocumentNumber('RE-2026-0014'));
  });

  it('N2 — Rechtsform und Schreibweise sind kein Unterschied, der Name schon', () => {
    expect(normalizePartyName('Westfalen Projektbau GmbH')).toBe('westfalen projektbau');
    expect(normalizePartyName('WESTFALEN  PROJEKTBAU  gmbh')).toBe('westfalen projektbau');
    expect(normalizePartyName('Müller Bau')).not.toBe(normalizePartyName('Meyer Bau'));
  });

  /* ---- A–E: Eingänge gegen Rechnungen ---- */

  it('A — Rechnungsnummer im Zweck und exakter offener Betrag ergibt den stärksten Vorschlag', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.direction).toBe('incoming');
    expect(ergebnis.ambiguous).toBe(false);
    expect(ergebnis.candidates[0]).toMatchObject({
      targetType: 'invoice',
      documentNumber: 'RE-2026-0014',
      grade: 'sehr_passend',
      openCents: 238000,
    });
    expect(ergebnis.candidates[0]?.reasons).toContain('invoice_number_in_purpose');
    expect(ergebnis.candidates[0]?.reasons).toContain('amount_matches_open');
  });

  it('B — exakter Betrag und passender Kunde ohne Nummer ergibt einen sinnvollen Vorschlag', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Ueberweisung;2.380,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.candidates[0]?.grade).toBe('passend');
    expect(ergebnis.candidates[0]?.reasons).toContain('counterparty_matches');
    expect(ergebnis.candidates[0]?.reasons).not.toContain('invoice_number_in_purpose');
  });

  it('C — gleicher Betrag bei mehreren Rechnungen ist mehrdeutig, kein Treffer', () => {
    hydrateInvoiceStore([
      eintrag(rechnung({ id: 'inv-1', number: 'RE-2026-0001' })),
      eintrag(rechnung({ id: 'inv-2', number: 'RE-2026-0002' })),
      eintrag(rechnung({ id: 'inv-3', number: 'RE-2026-0003' })),
    ]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Ueberweisung;2.380,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.ambiguous).toBe(true);
    expect(ergebnis.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('D — Nummer stimmt, Betrag weicht ab: Kandidat mit sichtbarem Grund', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.300,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.candidates[0]?.grade).toBe('passend');
    expect(ergebnis.candidates[0]?.reasons).toContain('amount_differs');
    expect(ergebnis.candidates[0]?.reasons).not.toContain('amount_matches_open');
  });

  it('E — ohne tragendes Signal gibt es keinen Vorschlag', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Fremde Firma AG;Irgendwas;77,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.candidates).toEqual([]);
    expect(ergebnis.ambiguous).toBe(false);
  });

  /* ---- F–H: Richtung ---- */

  it('F — ein Ausgang findet die passende Ausgabe', () => {
    hydrateExpenseStore([ausgabe()]);
    const t = bewegung('05.10.2026;Baustoff Handel GmbH;Rechnung LR-2026-55123;-1.190,50');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.direction).toBe('outgoing');
    expect(ergebnis.candidates[0]).toMatchObject({
      targetType: 'expense',
      grade: 'sehr_passend',
      openCents: 119050,
    });
  });

  it('G — ein Ausgang schlägt keine Ausgangsrechnung vor', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;-2.380,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.direction).toBe('outgoing');
    expect(ergebnis.candidates).toEqual([]);
  });

  it('H — ein Eingang schlägt keine Ausgabe vor', () => {
    hydrateExpenseStore([ausgabe()]);
    const t = bewegung('05.10.2026;Baustoff Handel GmbH;Rechnung LR-2026-55123;1.190,50');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.direction).toBe('incoming');
    expect(ergebnis.candidates).toEqual([]);
  });

  /* ---- I–L: Zahlungsstand ---- */

  it('I — eine vollständig bezahlte Rechnung ist kein Kandidat', () => {
    hydrateInvoiceStore([
      eintrag(
        rechnung({
          payments: [{ id: 'p1', date: '2026-10-02', amount: 2380, createdAt: '2026-10-02T10:00:00.000Z' }],
        }),
      ),
    ]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');

    expect(vorschlagFuer(t).candidates).toEqual([]);
  });

  it('J — eine vollständig bezahlte Ausgabe ist kein Kandidat', () => {
    hydrateExpenseStore([
      ausgabe({
        paymentStatus: 'bezahlt',
        payments: [{ id: 'p1', date: '2026-10-02', amount: 1190.5, createdAt: '2026-10-02T10:00:00.000Z' }],
      }),
    ]);
    const t = bewegung('05.10.2026;Baustoff Handel GmbH;Rechnung LR-2026-55123;-1.190,50');

    expect(vorschlagFuer(t).candidates).toEqual([]);
  });

  it('K — bei einer teilbezahlten Rechnung zählt der offene Rest', () => {
    hydrateInvoiceStore([
      eintrag(
        rechnung({
          total: 1000,
          amount: 1000,
          subtotal: 840.34,
          taxAmount: 159.66,
          payments: [{ id: 'p1', date: '2026-10-02', amount: 600, createdAt: '2026-10-02T10:00:00.000Z' }],
        }),
      ),
    ]);
    /* 400 ist der offene Rest — nicht 1000. */
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Restzahlung;400,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.candidates[0]?.openCents).toBe(40000);
    expect(ergebnis.candidates[0]?.reasons).toContain('amount_matches_open');
  });

  it('L — bei einer teilbezahlten Ausgabe zählt ebenfalls der offene Rest', () => {
    hydrateExpenseStore([
      ausgabe({
        grossAmount: 1000,
        paymentStatus: 'teilbezahlt',
        payments: [{ id: 'p1', date: '2026-10-02', amount: 600, createdAt: '2026-10-02T10:00:00.000Z' }],
      }),
    ]);
    const t = bewegung('05.10.2026;Baustoff Handel GmbH;Restzahlung;-400,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.candidates[0]?.openCents).toBe(40000);
  });

  /* ---- M–R: Grenzfälle ---- */

  it('M — zwei gleiche offene Rechnungen desselben Kunden bleiben mehrdeutig', () => {
    hydrateInvoiceStore([
      eintrag(rechnung({ id: 'inv-1', number: 'RE-2026-0001' })),
      eintrag(rechnung({ id: 'inv-2', number: 'RE-2026-0002' })),
    ]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung;2.380,00');

    expect(vorschlagFuer(t).ambiguous).toBe(true);
  });

  it('N — ohne Rechnungen im Betrieb gibt es keine Kandidaten', () => {
    /* Der Bestand ist je Betrieb; ein leerer Bestand kann nichts vorschlagen. */
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');
    expect(vorschlagFuer(t).candidates).toEqual([]);
  });

  it('O — ein ähnlicher, aber anderer Firmenname ist kein Treffer', () => {
    hydrateInvoiceStore([
      eintrag(rechnung({ customerSnapshot: { name: 'Meyer Bau GmbH' } as never })),
    ]);
    const t = bewegung('04.10.2026;Mueller Bau;Ueberweisung;99,00');

    expect(vorschlagFuer(t).candidates).toEqual([]);
  });

  it('P — zwei echte identische Bewegungen werden einzeln bewertet', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const csv = parseBankStatementCsv(
      [
        'Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag',
        '04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00',
        '04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00',
      ].join('\n'),
      'auszug.csv',
    );
    if (!csv.ok) throw new Error('nicht lesbar');
    const konto = createBankAccount('Geschäftskonto');
    commitBankImport(csv.preview, konto.id);

    const alle = listBankTransactions();
    expect(alle).toHaveLength(2);
    const ergebnisse = buildBankSuggestions(alle);
    expect(ergebnisse.size).toBe(2);
    for (const t of alle) {
      expect(ergebnisse.get(t.id)?.candidates[0]?.grade).toBe('sehr_passend');
    }
  });

  it('Q — das Konto beeinflusst den Rechnungskandidaten nicht', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const a = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00', 'Konto A');
    const b = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00', 'Konto B');

    expect(a.accountKey).not.toBe(b.accountKey);
    expect(vorschlagFuer(a).candidates[0]?.targetId).toBe(vorschlagFuer(b).candidates[0]?.targetId);
  });

  it('R — der Betragsvergleich läuft in Cent, nicht über Gleitkommazahlen', () => {
    hydrateInvoiceStore([eintrag(rechnung({ total: 1190.5, amount: 1190.5, subtotal: 1000, taxAmount: 190.5 }))]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Ueberweisung;1.190,50');

    expect(vorschlagFuer(t).candidates[0]?.openCents).toBe(119050);
    expect(vorschlagFuer(t).candidates[0]?.reasons).toContain('amount_matches_open');
  });

  it('S — eine Buchung vor dem Belegdatum bleibt sichtbar, wird aber benannt', () => {
    hydrateInvoiceStore([eintrag(rechnung({ issueDate: '2026-10-08', date: '2026-10-08' }))]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.candidates[0]).toBeDefined();
    expect(ergebnis.candidates[0]?.reasons).toContain('date_before_document');
  });

  it('T — eine zu kurze Nummer im Zweck gilt nicht als Nummernsignal', () => {
    hydrateInvoiceStore([eintrag(rechnung({ number: '14' }))]);
    const t = bewegung('04.10.2026;Fremde Firma;Betrag 14 Euro Vorgang 14;99,00');

    expect(vorschlagFuer(t).candidates).toEqual([]);
  });

  it('U — schwaechere Kandidaten zaehlen nicht zur Mehrdeutigkeit (sichtbar gefunden)', () => {
    /*
     * Zwei gleich gute und ein schwaecherer Kandidat sind **zwei**
     * Moeglichkeiten, nicht drei. Die Zahl in der Oberflaeche darf die
     * Unklarheit nicht uebertreiben.
     */
    hydrateInvoiceStore([
      eintrag(rechnung({ id: 'inv-1', number: 'RE-2026-0001' })),
      eintrag(rechnung({ id: 'inv-2', number: 'RE-2026-0002' })),
      eintrag(rechnung({ id: 'inv-3', number: 'RE-2026-0003', total: 50, amount: 50 })),
    ]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Ueberweisung;2.380,00');

    const ergebnis = vorschlagFuer(t);
    expect(ergebnis.ambiguous).toBe(true);
    const beste = ergebnis.candidates[0]!.grade;
    expect(ergebnis.candidates.filter((k) => k.grade === beste)).toHaveLength(2);
    /* Der dritte passt nur ueber die Gegenpartei und ist schwaecher. */
    expect(ergebnis.candidates.length).toBeGreaterThan(2);
  });

  /* ---- Keine Geldwirkung ---- */

  it('Z1 — Vorschläge berechnen ruft keine Zahlungsfunktion auf', async () => {
    const invoicePayments = await import('../invoicePaymentService');
    const expensePayments = await import('../expensePaymentService');
    const recordPayment = vi.spyOn(invoicePayments, 'recordPayment');
    const removePayment = vi.spyOn(invoicePayments, 'removePayment');
    const recordExpensePayment = vi.spyOn(expensePayments, 'recordExpensePayment');
    const removeExpensePayment = vi.spyOn(expensePayments, 'removeExpensePayment');

    hydrateInvoiceStore([eintrag(rechnung())]);
    hydrateExpenseStore([ausgabe()]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');
    buildBankSuggestions([t]);

    expect(recordPayment).not.toHaveBeenCalled();
    expect(removePayment).not.toHaveBeenCalled();
    expect(recordExpensePayment).not.toHaveBeenCalled();
    expect(removeExpensePayment).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('Z2 — Rechnungs- und Ausgabenstand bleiben unverändert', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    hydrateExpenseStore([ausgabe()]);
    const vorherAusgabe = JSON.stringify(getExpenseStoreSnapshot());

    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');
    buildBankSuggestions([t]);

    const nachher = getExpenseStoreSnapshot();
    expect(JSON.stringify(nachher)).toBe(vorherAusgabe);
    expect(nachher[0]?.paymentStatus).toBe('offen');
    expect(nachher[0]?.payments ?? []).toHaveLength(0);
  });

  it('Z3 — der Vorschlag trägt keine Kennung einer Zahlung und kein Prozentmass', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');
    const kandidat = vorschlagFuer(t).candidates[0] as unknown as Record<string, unknown>;

    for (const feld of ['paymentId', 'confidence', 'score', 'probability']) {
      expect(kandidat).not.toHaveProperty(feld);
    }
  });

  it('Z4 — derselbe Bestand ergibt zweimal dasselbe Ergebnis', () => {
    hydrateInvoiceStore([eintrag(rechnung())]);
    const t = bewegung('04.10.2026;Westfalen Projektbau GmbH;Zahlung RE-2026-0014;2.380,00');

    expect(JSON.stringify(vorschlagFuer(t))).toBe(JSON.stringify(vorschlagFuer(t)));
  });
});

/* HEUTE bleibt ungenutzt, wenn die Übersicht ihr eigenes Datum bestimmt. */
void HEUTE;
