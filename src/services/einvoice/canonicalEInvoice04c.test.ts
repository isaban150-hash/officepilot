/**
 * E-RECHNUNG-04C — das Canonical-Modell und seine fail-closed-Prüfung.
 *
 * Der Schwerpunkt liegt nicht auf dem Glücksfall, sondern auf dem, was der
 * Builder **verweigert**: Er darf keine Stammdaten nachladen, keinen Code
 * raten, keine Summe neu erfinden und keinen Rechtsgrund unterstellen. Jeder
 * dieser Fehler erzeugte eine Rechnung, die durch jede Prüfung liefe und
 * trotzdem etwas Falsches behauptete.
 *
 * Kein XML, keine Serialisierung — das kommt in 04D.
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import { buildCanonicalEInvoice, FIXED_AMOUNT_LINE_DESCRIPTION } from './canonicalEInvoiceBuilder';
import { UNIT_CODES, resolveUnitCode } from './einvoiceCodes';
import { INVOICE_CURRENCY_CODE } from './einvoiceStandards';
import { ORDER_UNITS } from '../orderUnits';
import type {
  CanonicalEInvoiceIssueCode,
  CanonicalEInvoiceResult,
} from './canonicalEInvoice';
import type {
  CompanyProfile,
  CustomerBilling,
  TaxStatus,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../types/models';

/* ------------------------------------------------------------------ */
/* Bausteine                                                           */
/* ------------------------------------------------------------------ */

// FINANZ-CORE-01A (AUS-06) — BT-27 = Firmenname plus Rechtsform („Cirmak Haustechnik GmbH").
const SELLER: CompanyProfile = {
  companyName: 'Cirmak Haustechnik',
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  countryCode: 'DE',
  contactPerson: 'Herr Cirmak',
  phone: '0201 999999',
  email: 'buero@cirmak.invalid',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE111111111',
  registrationAuthority: 'Amtsgericht Essen',
  registrationNumber: 'HRB 12345',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'WELADED1ESN',
  accountHolder: 'Cirmak Haustechnik GmbH',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
} as unknown as CompanyProfile;

const BUYER: CustomerBilling = {
  name: 'AZ Testbau GmbH',
  contactPerson: 'Frau Meier',
  street: 'Industriestrasse 12',
  zip: '33602',
  city: 'Bielefeld',
  email: 'buero@az-testbau.invalid',
  phone: '0521 4711',
  countryCode: 'DE',
  vatId: 'DE-KUNDE-A',
  buyerReference: 'TEST-BUYER-REF-A',
  // FINANZ-CORE-01A (KUN-07) — kein öffentlicher Auftraggeber; die Leitweg-ID hat eigene Fälle (K1/K2).
};

function line(overrides: Partial<VorgangInvoiceLine> = {}): VorgangInvoiceLine {
  const base = {
    id: 'p1',
    description: 'Wartung',
    quantity: 2,
    unit: 'Stunden',
    unitPrice: 80,
    lineTotal: 160,
    ...overrides,
  } as VorgangInvoiceLine;
  return base;
}

/** Der vollständig gepflegte Beleg — Ausgangspunkt jeder Abweichung. */
function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  const positions = overrides.positions ?? [line()];
  const subtotal =
    overrides.subtotal ?? positions.reduce((sum, p) => sum + p.lineTotal, 0);
  const taxStatus: TaxStatus = overrides.taxStatus ?? 'standard_19';
  const rate = taxStatus === 'standard_19' ? 19 : taxStatus === 'standard_7' ? 7 : 0;
  const amount = overrides.amount ?? Math.round(subtotal * (100 + rate)) / 100;
  return {
    id: 'inv-04c',
    number: '2026-0042',
    type: 'rechnung',
    positions,
    subtotal,
    taxStatus,
    amount,
    status: 'vorbereitet',
    date: '2026-09-23',
    createdAt: '2026-09-23T08:00:00.000Z',
    issueDate: '2026-09-23',
    servicePeriodFrom: '2026-09-20',
    servicePeriodTo: '2026-09-23',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-07',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: INVOICE_CURRENCY_CODE,
    customerSnapshot: { ...BUYER },
    companySnapshot: { ...SELLER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as unknown as VorgangInvoice;
}

const codes = (result: CanonicalEInvoiceResult): CanonicalEInvoiceIssueCode[] =>
  result.ok ? [] : result.issues.map((i) => i.code);

function erwarteFehler(result: CanonicalEInvoiceResult, code: CanonicalEInvoiceIssueCode) {
  expect(result.ok, 'unerwartet erfolgreich: ' + JSON.stringify(codes(result))).toBe(false);
  expect(codes(result)).toContain(code);
}

/* ------------------------------------------------------------------ */

describe('A — der vollständige Happy Path', () => {
  it('T1: eine gepflegte 19-%-Rechnung ergibt ein Canonical-Modell', () => {
    const result = buildCanonicalEInvoice(invoice());
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    const c = result.value;

    expect(c.documentKind).toBe('invoice');
    expect(c.businessProcess).toBe('standard_billing');
    expect(c.currencyCode).toBe('EUR');
    expect(c.issueDate).toBe('2026-09-23');
    expect(c.servicePeriod).toEqual({ from: '2026-09-20', to: '2026-09-23' });

    expect(c.seller.name).toBe('Cirmak Haustechnik GmbH');
    expect(c.seller.address).toEqual({
      street: 'Ruhrallee 5', zip: '45138', city: 'Essen', countryCode: 'DE',
    });
    expect(c.seller.electronicAddress).toEqual({ scheme: 'email', value: 'buero@cirmak.invalid' });
    expect(c.seller.vatId).toBe('DE111111111');
    expect(c.seller.registrationNumber).toBe('HRB 12345');

    expect(c.buyer.address.countryCode).toBe('DE');
    expect(c.buyer.electronicAddress.value).toBe('buero@az-testbau.invalid');
    expect(c.buyer.buyerReference).toBe('TEST-BUYER-REF-A');
    expect(c.buyer.leitwegId).toBeUndefined();
    expect(c.notes).toEqual([]);
    expect(c.totals.prepaidAmount).toBe(0);

    expect(c.payment.means).toBe('credit_transfer');
    expect(c.payment.transfer.iban).toBe('DE89370400440532013000');
    expect(c.payment.transfer.bic).toBe('WELADED1ESN');
    expect(c.payment.dueDate).toBe('2026-10-07');

    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({
      position: 1, unit: 'Stunden', unitCode: 'HUR', quantity: 2, unitPrice: 80, lineNetAmount: 160,
    });
    expect(c.lines[0]!.synthetic).toBeUndefined();

    expect(c.tax).toEqual([
      { category: 'standard', rate: 19, taxableAmount: 160, taxAmount: 30.4 },
    ]);
    expect(c.totals).toMatchObject({
      lineNetTotal: 160, taxExclusiveAmount: 160, taxAmount: 30.4,
      taxInclusiveAmount: 190.4, payableAmount: 190.4,
    });
    // Kein Layout, kein Logo, keine Überschrift im Modell.
    expect(JSON.stringify(c)).not.toMatch(/logo|template|documentTitle/i);
  });

  it('T2: 7 % ergibt dieselbe Kategorie mit anderem Satz', () => {
    const result = buildCanonicalEInvoice(invoice({ taxStatus: 'standard_7' }));
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.tax[0]).toMatchObject({ category: 'standard', rate: 7, taxAmount: 11.2 });
    expect(result.value.totals.payableAmount).toBe(171.2);
  });
});

describe('B — Steuer', () => {
  it('T3: §13b wird Reverse Charge mit Satz 0 und Begründung', () => {
    const result = buildCanonicalEInvoice(
      invoice({
        taxStatus: 'reverse_charge_13b',
        amount: 160,
        legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
      }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.tax[0]).toMatchObject({ category: 'reverse_charge', rate: 0, taxAmount: 0 });
    expect(result.value.tax[0]!.exemptionReason).toContain('§ 13b');
    expect(result.value.totals.payableAmount).toBe(160);
  });

  it('T4: §13b ohne Käufer-USt-IdNr. wird abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({
          taxStatus: 'reverse_charge_13b',
          amount: 160,
          legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
          customerSnapshot: { ...BUYER, vatId: '' },
        }),
      ),
      'buyer_vat_id_missing_for_reverse_charge',
    );
  });

  it('T5: Kleinunternehmer wird steuerbefreit mit §-19-Hinweis', () => {
    const result = buildCanonicalEInvoice(
      invoice({
        taxStatus: 'kleinunternehmer_19',
        amount: 160,
        legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
      }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.tax[0]).toMatchObject({ category: 'exempt', rate: 0, taxAmount: 0 });
    expect(result.value.tax[0]!.exemptionReason).toContain('§ 19');
  });

  it('eine Befreiung ohne Rechtsgrund wird abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({ taxStatus: 'kleinunternehmer_19', amount: 160, legalNotices: [] }),
      ),
      'tax_exemption_reason_missing',
    );
  });

  it('T6: tax_free ist nicht eindeutig zuzuordnen und wird abgewiesen', () => {
    /*
     * „Steuerfrei / ohne USt" ist ein Sammelstatus: Dahinter können Befreiung,
     * Ausfuhr, innergemeinschaftliche Lieferung oder ein nicht steuerbarer
     * Umsatz stehen. Der Beleg speichert den Rechtsgrund nicht — nur einen frei
     * konfigurierbaren Hinweistext. Eine Kategorie zu wählen hiesse, dem
     * Empfänger einen Grund zu nennen, den der Betrieb nie angegeben hat.
     */
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({
          taxStatus: 'tax_free',
          amount: 160,
          legalNotices: ['Die Leistung ist ohne Umsatzsteuer.'],
        }),
      ),
      'tax_status_unsupported',
    );
  });

  it('T7: unclear wird immer abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ taxStatus: 'unclear', amount: 160 })),
      'tax_status_unclear',
    );
  });
});

describe('C — Einheitencodes', () => {
  const faelle: Array<[string, string]> = [
    ['m²', 'MTK'],
    ['Meter', 'MTR'],
    ['Stunden', 'HUR'],
    ['Stück', 'H87'],
    ['Pauschal', 'LS'],
  ];

  it.each(faelle)('T8–T12: %s wird zu %s', (unit, code) => {
    const result = buildCanonicalEInvoice(
      invoice({ positions: [line({ unit: unit as never, quantity: 1, unitPrice: 100, lineTotal: 100 })], subtotal: 100, amount: 119 }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines[0]!.unitCode).toBe(code);
    expect(result.value.lines[0]!.unit, 'die Einheit des Belegs bleibt erhalten').toBe(unit);
  });

  it('T13: eine unbekannte Einheit wird abgewiesen, nie auf Stück zurückgesetzt', () => {
    const result = buildCanonicalEInvoice(
      invoice({ positions: [line({ unit: 'Fuhre' as never })] }),
    );
    erwarteFehler(result, 'unit_code_unknown');
    expect(JSON.stringify(result)).not.toContain('H87');
  });

  it('die Zuordnung deckt genau die OfficeTakt-Einheiten ab', () => {
    // Läuft eine der beiden Listen weg, bietet die App eine Einheit an, die
    // der Export abweist — oder umgekehrt.
    expect(Object.keys(UNIT_CODES).sort()).toEqual([...ORDER_UNITS].sort());
    expect(resolveUnitCode('  ')).toBeUndefined();
    expect(resolveUnitCode(undefined)).toBeUndefined();
  });
});

describe('D — Käufer und Verkäufer', () => {
  /*
   * FINANZ-CORE-01A (KUN-07) — bei einem öffentlichen Auftraggeber ist die Leitweg-ID BT-10.
   */
  it('K1: die Leitweg-ID ist die Käuferreferenz; eine abweichende Referenz wird Belegnotiz', () => {
    const result = buildCanonicalEInvoice(
      invoice({ customerSnapshot: { ...BUYER, leitwegId: '04011000-12345-67', buyerReference: 'Bestellung 4711' } }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.buyer.buyerReference).toBe('04011000-12345-67');
    expect(result.value.notes).toEqual(['Käuferreferenz: Bestellung 4711']);
  });

  it('K2: eine Leitweg-ID allein genügt; gleiche Werte ergeben keine Notiz', () => {
    const nurLeitweg = buildCanonicalEInvoice(
      invoice({ customerSnapshot: { ...BUYER, leitwegId: '04011000-12345-67', buyerReference: '' } }),
    );
    expect(nurLeitweg.ok, JSON.stringify(codes(nurLeitweg))).toBe(true);
    const gleich = buildCanonicalEInvoice(
      invoice({ customerSnapshot: { ...BUYER, leitwegId: '04011000-12345-67', buyerReference: '04011000-12345-67' } }),
    );
    expect(gleich.ok && gleich.value.notes).toEqual([]);
  });

  it('T14: fehlende Käuferreferenz wird abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ customerSnapshot: { ...BUYER, buyerReference: '' } })),
      'buyer_reference_missing',
    );
  });

  it('kein Ersatz für die Käuferreferenz wird erfunden', () => {
    const result = buildCanonicalEInvoice(
      invoice({ customerSnapshot: { ...BUYER, buyerReference: undefined } }),
    );
    expect(result.ok).toBe(false);
    // Weder Rechnungsnummer noch Kundenname rutschen an ihre Stelle.
    expect(JSON.stringify(result)).not.toContain('2026-0042');
  });

  it('T15: fehlendes Käuferland wird abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({ customerSnapshot: { ...BUYER, countryCode: undefined } }),
      ),
      'buyer_country_missing',
    );
  });

  it('T16/T17: fehlende elektronische Adressen werden abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ customerSnapshot: { ...BUYER, email: '' } })),
      'buyer_electronic_address_missing',
    );
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ companySnapshot: { ...SELLER, email: '' } })),
      'seller_electronic_address_missing',
    );
  });

  it('eine unvollständige Anschrift und fehlende Steuerkennung werden benannt', () => {
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ customerSnapshot: { ...BUYER, street: '' } })),
      'buyer_address_incomplete',
    );
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({ companySnapshot: { ...SELLER, taxNumber: '', vatId: '' } }),
      ),
      'seller_tax_identity_missing',
    );
  });

  it('eine Steuernummer allein genügt — ein Kleinbetrieb hat oft keine USt-IdNr.', () => {
    const result = buildCanonicalEInvoice(
      invoice({ companySnapshot: { ...SELLER, vatId: '' } }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
  });

  it('T-IBAN: fehlende Bankverbindung wird abgewiesen, nicht nachgeladen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ companySnapshot: { ...SELLER, iban: '' } })),
      'payment_iban_missing',
    );
  });
});

describe('E — Währung und Altbestand', () => {
  it('T18/T27: ein Beleg von vor 04B liefert saubere Befunde statt eines Absturzes', () => {
    const alt = invoice({
      currencyCode: undefined,
      customerSnapshot: {
        name: 'AZ Testbau GmbH',
        contactPerson: '',
        street: 'Industriestrasse 12',
        zip: '33602',
        city: 'Bielefeld',
        email: 'buero@az-testbau.invalid',
        phone: '',
      },
    });
    const result = buildCanonicalEInvoice(alt);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(codes(result)).toEqual(
      expect.arrayContaining(['currency_missing', 'buyer_country_missing', 'buyer_reference_missing']),
    );
    // Kein Stammdaten-Rückgriff: nichts wurde ergänzt.
    expect(JSON.stringify(result)).not.toContain('EUR');
  });
});

describe('F — Belegarten', () => {
  it('T19: die manuelle Rechnung nimmt denselben Weg', () => {
    const result = buildCanonicalEInvoice(invoice({ id: 'inv-manuell' }));
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('invoice');
    // Kein Auftragsbezug wird erfunden.
    expect(result.value.references.orderReference).toBeUndefined();
    expect(result.value.references.precedingInvoiceNumbers).toEqual([]);
  });

  it('T20: die Teilrechnung bildet nur ihre finalisierten Mengen ab', () => {
    const result = buildCanonicalEInvoice(
      invoice({
        type: 'teilrechnung',
        positions: [line({ orderPositionId: 'op1', quantity: 2, lineTotal: 160 })],
      }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('partial_invoice');
    expect(result.value.lines[0]!.quantity, 'keine offene Auftragsmenge').toBe(2);
    expect(result.value.totals.lineNetTotal).toBe(160);
  });

  it('T21: der mengenbasierte Abschlag wirkt nur über seine Positionen', () => {
    const result = buildCanonicalEInvoice(
      invoice({ type: 'abschlag', abschlagNumber: 1, positions: [line()] }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('prepayment_invoice_quantity');
    // Keine Doppelwirkung: verbrauchte Menge ist kein zusätzlicher Abzug.
    expect(result.value.totals.billedPrepayments).toEqual([]);
    expect(result.value.totals.payableAmount).toBe(190.4);
  });

  it('T22: der Pauschalabschlag bekommt genau eine kenntlich gemachte Zeile', () => {
    const result = buildCanonicalEInvoice(
      invoice({
        type: 'abschlag',
        abschlagNumber: 1,
        calculationMode: 'fixed_amount',
        fixedAmountNet: 500,
        positions: [],
        subtotal: 500,
        amount: 595,
      }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('prepayment_invoice_fixed');
    expect(result.value.lines).toHaveLength(1);
    expect(result.value.lines[0]).toMatchObject({
      description: FIXED_AMOUNT_LINE_DESCRIPTION,
      quantity: 1,
      unit: 'Pauschal',
      unitCode: 'LS',
      unitPrice: 500,
      lineNetAmount: 500,
      synthetic: true,
    });
    // Die Summe bleibt exakt die des Belegs.
    expect(result.value.totals.lineNetTotal).toBe(500);
    expect(result.value.totals.payableAmount).toBe(595);
  });

  it('ein Pauschalabschlag ohne gültigen Betrag wird abgewiesen', () => {
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({
          type: 'abschlag',
          calculationMode: 'fixed_amount',
          fixedAmountNet: 0,
          positions: [],
          subtotal: 0,
          amount: 0,
        }),
      ),
      'fixed_amount_net_invalid',
    );
  });

  it('T23: eine Schlussrechnung mit Abzügen trägt sie als BT-113 und nennt sie in der Belegnotiz', () => {
    /*
     * FINANZ-CORE-01A (D1) — die Abzüge belegen, dass abgerechnet wurde, nicht dass
     * bezahlt wurde. Die Schlussrechnung zieht genau diese Beträge ab (PDF „Bereits
     * berechnet"); BT-113 ist das einzige Element, das den Zahlbetrag senkt, ohne die
     * Steuer der Gesamtleistung zu ändern. Die Notiz sagt ausdrücklich „bereits berechnet".
     */
    const schluss = (amount: number) =>
      invoice({
        type: 'schluss',
        subtotal: 1000,
        amount,
        positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
        previousAbschlagDeductions: [
          { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476 },
        ],
      });
    // FINANZ-CORE-01A (WEISS N02/D1) — BT-113 nur mit belegter Zahlung des Abschlags.
    const bezahlt = { prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 476, skonto: 0, settled: true }] };
    const result = buildCanonicalEInvoice(schluss(714), bezahlt);
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.totals.prepaidAmount).toBe(476);
    expect(result.value.totals.payableAmount).toBe(714);
    expect(result.value.totals.billedPrepayments[0]).toMatchObject({ paidAmount: 476, skontoAmount: 0 });
    expect(result.value.notes).toEqual([
      'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0031 vom 01.08.2026) 476,00 EUR brutto (netto 400,00 EUR, USt 76,00 EUR)',
    ]);
    // Brutto 1.190 minus 476 ist 714 — ein anderer Zahlbetrag ist widersprüchlich.
    erwarteFehler(buildCanonicalEInvoice(schluss(690), bezahlt), 'money_inconsistent');
  });

  /*
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — BT-113 ist der bereits gezahlte Betrag.
   * Ein unbezahlter, teilbezahlter oder unbelegter Abschlag steht dort nie.
   */
  describe('N02 — abgezogene Abschläge nur beglichen', () => {
    const schluss = () =>
      invoice({
        type: 'schluss',
        subtotal: 1000,
        amount: 714,
        positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
        previousAbschlagDeductions: [
          { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476 },
        ],
      });

    it('N02a: ohne Zahlungsnachweis keine E-Rechnung (der Befund nennt den Abschlag)', () => {
      const result = buildCanonicalEInvoice(schluss());
      erwarteFehler(result, 'prepayment_not_settled');
      if (result.ok) return;
      expect(result.issues.find((issue) => issue.code === 'prepayment_not_settled')?.path).toBe(
        'previousAbschlagDeductions[0]',
      );
    });

    it('N02b: ein unbezahlter und ein teilbezahlter Abschlag sind nicht beglichen', () => {
      erwarteFehler(
        buildCanonicalEInvoice(schluss(), { prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 0, skonto: 0, settled: false }] }),
        'prepayment_not_settled',
      );
      erwarteFehler(
        buildCanonicalEInvoice(schluss(), { prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 200, skonto: 0, settled: false }] }),
        'prepayment_not_settled',
      );
    });

    it('N02c: der Nachweis eines anderen Abschlags zählt nicht', () => {
      erwarteFehler(
        buildCanonicalEInvoice(schluss(), { prepaymentSettlements: [{ invoiceId: 'inv-anders', paid: 476, skonto: 0, settled: true }] }),
        'prepayment_not_settled',
      );
    });

    /*
     * WEISS-Recheck N02-R1 — BT-113 ist nur das tatsächlich Gezahlte. Das gewährte Skonto ist
     * eine Entgeltminderung und steht als Nachlass auf Belegebene (BG-20); es mindert
     * Bemessungsgrundlage und Steuer. Der Zahlbetrag bleibt der Restbetrag des Belegs.
     * (Ersetzt den früheren Vertrag „voller Abzug in BT-113, Skonto nur in der Notiz".)
     */
    const mitAufteilung = (paidAmount: number, skontoAmount: number) =>
      invoice({
        ...schluss(),
        previousAbschlagDeductions: [
          { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476, paidAmount, skontoAmount },
        ],
      });

    it('N02d: Altbeleg mit Skonto ohne eingefrorene Aufteilung — keine E-Rechnung', () => {
      erwarteFehler(
        buildCanonicalEInvoice(schluss(), {
          prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 466.48, skonto: 9.52, settled: true }],
        }),
        'prepayment_skonto_unfrozen',
      );
    });

    it('N02e: mit Skonto beglichen — BT-113 nur gezahlt, Skonto als Nachlass, Steuer gemindert', () => {
      const result = buildCanonicalEInvoice(mitAufteilung(466.48, 9.52), {
        prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 466.48, skonto: 9.52, settled: true }],
      });
      expect(result.ok, JSON.stringify(codes(result))).toBe(true);
      if (!result.ok) return;
      expect(result.value.totals).toMatchObject({
        lineNetTotal: 1000,
        allowanceTotal: 8,
        taxExclusiveAmount: 992,
        taxAmount: 188.48,
        taxInclusiveAmount: 1180.48,
        prepaidAmount: 466.48,
        payableAmount: 714,
      });
      expect(result.value.totals.roundingAmount).toBeUndefined();
      expect(result.value.tax).toEqual([{ category: 'standard', rate: 19, taxableAmount: 992, taxAmount: 188.48 }]);
      expect(result.value.allowances).toEqual([
        { amount: 8, reason: 'Skonto auf Abschlag 1 (Rechnung 2026-0031)', reasonCode: '95', category: 'standard', rate: 19 },
      ]);
      expect(result.value.totals.billedPrepayments[0]).toMatchObject({ paidAmount: 466.48, skontoAmount: 9.52 });
      expect(result.value.notes).toEqual([
        'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0031 vom 01.08.2026) 466,48 EUR gezahlt (netto 392,00 EUR, USt 74,48 EUR) von 476,00 EUR brutto',
        'Skonto auf Abschlag 1 (Rechnung 2026-0031): 9,52 EUR brutto (netto 8,00 EUR, USt 1,52 EUR), als Nachlass auf Belegebene ausgewiesen (Entgeltminderung).',
      ]);
    });

    it('N02f: voll bezahlt (Aufteilung 476/0 oder keine) — alles wie bisher, kein Nachlass', () => {
      for (const beleg of [mitAufteilung(476, 0), schluss()]) {
        const result = buildCanonicalEInvoice(beleg, {
          prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 476, skonto: 0, settled: true }],
        });
        expect(result.ok, JSON.stringify(codes(result))).toBe(true);
        if (!result.ok) return;
        expect(result.value.totals).toMatchObject({ taxExclusiveAmount: 1000, taxAmount: 190, taxInclusiveAmount: 1190, prepaidAmount: 476, payableAmount: 714 });
        expect(result.value.allowances).toBeUndefined();
        expect(result.value.totals.allowanceTotal).toBeUndefined();
        expect(result.value.notes).toEqual([
          'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0031 vom 01.08.2026) 476,00 EUR brutto (netto 400,00 EUR, USt 76,00 EUR)',
        ]);
      }
    });

    it('N02g: zahlt der Kunde das Skonto später nach, bleibt der Beleg, wie er freigegeben wurde', () => {
      const result = buildCanonicalEInvoice(mitAufteilung(466.48, 9.52), {
        prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 476, skonto: 0, settled: true }],
      });
      expect(result.ok, JSON.stringify(codes(result))).toBe(true);
      if (!result.ok) return;
      expect(result.value.totals.prepaidAmount).toBe(466.48);
      expect(result.value.totals.allowanceTotal).toBe(8);
    });

    it('N02h: geht der Nachlass wegen der Rundung nicht auf, gleicht BT-114 den Cent aus (BR-CO-16)', () => {
      // 7,17 € Skonto: Netto 6,03 € → Steuer 188,85 € (Minderung 1,15 €); 6,03 + 1,15 = 7,18 → Rundung +0,01.
      const result = buildCanonicalEInvoice(mitAufteilung(468.83, 7.17), {
        prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 468.83, skonto: 7.17, settled: true }],
      });
      expect(result.ok, JSON.stringify(codes(result))).toBe(true);
      if (!result.ok) return;
      const t = result.value.totals;
      expect(t).toMatchObject({ allowanceTotal: 6.03, taxExclusiveAmount: 993.97, taxAmount: 188.85, taxInclusiveAmount: 1182.82, prepaidAmount: 468.83, roundingAmount: 0.01, payableAmount: 714 });
      // BR-S-09: Steuer = Bemessungsgrundlage × Satz; BR-CO-16: BT-115 = BT-112 − BT-113 + BT-114.
      expect(Math.round(993.97 * 19)).toBe(18885);
      expect(Math.round((t.taxInclusiveAmount - t.prepaidAmount + (t.roundingAmount ?? 0)) * 100)).toBe(71400);
    });
  });

  /*
   * FC01A-Nacharbeit (A1) — § 14 Abs. 5 Satz 2 UStG: In der Schlussrechnung sind die
   * vereinnahmten Teilentgelte **und die auf sie entfallenden Steuerbeträge** abzusetzen.
   * BT-113 kennt nur einen Bruttobetrag; die Notiz nennt deshalb je Abschlag Netto und USt —
   * dieselben Werte wie PDF und Ansicht. Ohne Steuer bleibt der Text, wie er war.
   */
  describe('A1 — Netto und USt je abgezogenem Abschlag in der Notiz', () => {
    const notizAbzuege = (notes: readonly string[]) => notes.find((note) => note.startsWith('Abzüglich bereits bezahlter Abschläge:'));

    it('A1a: zwei Abschläge mit 19 %: jeder mit eigenem Netto und eigener USt, Netto + USt = Brutto', () => {
      const result = buildCanonicalEInvoice(
        invoice({
          type: 'schluss',
          subtotal: 1000,
          amount: 476,
          positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
          previousAbschlagDeductions: [
            { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476 },
            { invoiceId: 'inv-a2', invoiceNumber: '2026-0035', abschlagNumber: 2, date: '2026-09-01', subtotal: 200, amount: 238 },
          ],
        }),
        {
          prepaymentSettlements: [
            { invoiceId: 'inv-a1', paid: 476, skonto: 0, settled: true },
            { invoiceId: 'inv-a2', paid: 238, skonto: 0, settled: true },
          ],
        },
      );
      expect(result.ok, JSON.stringify(codes(result))).toBe(true);
      if (!result.ok) return;
      expect(result.value.totals).toMatchObject({ taxAmount: 190, prepaidAmount: 714, payableAmount: 476 });
      expect(notizAbzuege(result.value.notes)).toBe(
        'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0031 vom 01.08.2026) 476,00 EUR brutto (netto 400,00 EUR, USt 76,00 EUR); Abschlag 2 (Rechnung 2026-0035 vom 01.09.2026) 238,00 EUR brutto (netto 200,00 EUR, USt 38,00 EUR)',
      );
    });

    it('A1b: § 13b — kein Steuerbetrag im Abschlag, die Notiz bleibt ohne Steuerangabe', () => {
      const result = buildCanonicalEInvoice(
        invoice({
          type: 'schluss',
          taxStatus: 'reverse_charge_13b',
          subtotal: 1000,
          amount: 600,
          legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
          positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
          previousAbschlagDeductions: [
            { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 400 },
          ],
        }),
        { prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 400, skonto: 0, settled: true }] },
      );
      expect(result.ok, JSON.stringify(codes(result))).toBe(true);
      if (!result.ok) return;
      expect(result.value.tax[0]).toMatchObject({ category: 'reverse_charge', taxAmount: 0 });
      expect(notizAbzuege(result.value.notes)).toBe(
        'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0031 vom 01.08.2026) 400,00 EUR brutto',
      );
    });

    /*
     * FC01A-P1-Restkorrektur (#8, Altformat) — Regeländerung: Bisher entstand hier eine E-Rechnung,
     * deren Notiz die Steuer der Vorauszahlung wegließ. § 14 Abs. 5 Satz 2 UStG verlangt sie; ohne
     * gespeichertes Netto ist sie bei 19 % nicht verlässlich bestimmbar. Jetzt entsteht kein Beleg.
     */
    it('A1c: Altbestand ohne Netto im Abzug bei 19 % — keine geratene Steuer und keine E-Rechnung', () => {
      const result = buildCanonicalEInvoice(
        invoice({
          type: 'schluss',
          subtotal: 1000,
          amount: 714,
          positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
          previousAbschlagDeductions: [
            { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', amount: 476 } as never,
          ],
        }),
        { prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 476, skonto: 0, settled: true }] },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(codes(result)).toContain('prepayment_net_unreliable');
    });

    it('A1d: Altbestand ohne Netto im Abzug bei § 13b — Netto = Brutto, die Notiz bleibt ohne Steuerangabe', () => {
      const result = buildCanonicalEInvoice(
        invoice({
          type: 'schluss',
          taxStatus: 'reverse_charge_13b',
          subtotal: 1000,
          amount: 600,
          legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
          positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
          previousAbschlagDeductions: [
            { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', amount: 400 } as never,
          ],
        }),
        { prepaymentSettlements: [{ invoiceId: 'inv-a1', paid: 400, skonto: 0, settled: true }] },
      );
      expect(result.ok, JSON.stringify(codes(result))).toBe(true);
      if (!result.ok) return;
      expect(notizAbzuege(result.value.notes)).toBe(
        'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0031 vom 01.08.2026) 400,00 EUR brutto',
      );
    });
  });

  it('eine Schlussrechnung ohne Abzüge ist eine gewöhnliche Rechnung', () => {
    const result = buildCanonicalEInvoice(
      invoice({ type: 'schluss', previousAbschlagDeductions: [] }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('final_invoice');
  });
});

describe('G — Korrektur und Storno', () => {
  it('T24: die Korrektur ist ein eigener Beleg mit eigener Nummer und Bezug auf ihr Original', () => {
    const storniert = invoice({
      status: 'versendet',
      cancelledAt: '2026-09-25T10:00:00.000Z',
      cancellationKind: 'correction',
      cancelReason: 'Falscher Leistungszeitraum',
      correctionNumber: '2026-0050',
    });
    const result = buildCanonicalEInvoice(storniert, { variant: 'correction' });
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('correction');
    // FINANZ-CORE-01A (SQL-11/AUS-08) — BT-1 ist die eigene Nummer, BT-2 das Korrekturdatum.
    expect(result.value.sourceInvoiceNumber).toBe('2026-0050');
    expect(result.value.issueDate).toBe('2026-09-25');
    expect(result.value.payment.means).toBe('settlement');
    expect(result.value.payment.transfer).toBeUndefined();
    expect(result.value.payment.dueDate).toBeUndefined();
    expect(result.value.references.correction).toEqual({
      originalInvoiceId: 'inv-04c',
      originalInvoiceNumber: '2026-0042',
      originalIssueDate: '2026-09-23',
      reason: 'Falscher Leistungszeitraum',
    });
    // Das stornierte Original bekommt keine neue E-Rechnung; eine Korrektur ohne Nummer keine.
    erwarteFehler(buildCanonicalEInvoice(storniert), 'cancelled_original_not_exportable');
    erwarteFehler(
      buildCanonicalEInvoice({ ...storniert, correctionNumber: undefined }, { variant: 'correction' }),
      'correction_number_missing',
    );
    erwarteFehler(buildCanonicalEInvoice(invoice(), { variant: 'correction' }), 'correction_not_available');
  });

  it('T25: ein interner Storno ist kein exportierbarer Beleg', () => {
    const result = buildCanonicalEInvoice(
      invoice({
        cancelledAt: '2026-09-25T10:00:00.000Z',
        cancellationKind: 'internal',
        cancelReason: 'Vor Versand zurückgezogen',
      }),
    );
    erwarteFehler(result, 'internal_cancellation_not_exportable');
    expect(codes(result), 'ein einziger, klarer Grund').toHaveLength(1);
  });

  it('ein nicht freigegebener Entwurf ist keine Quelle', () => {
    erwarteFehler(
      buildCanonicalEInvoice(invoice({ status: 'entwurf' as never })),
      'source_not_finalized',
    );
  });
});

describe('H — Geld wird geprüft, nie neu erfunden', () => {
  it('T29/T30: die Summen stammen aus dem Beleg', () => {
    // 3 × 33,33 = 99,99 — eine Summe, die eine Neuberechnung leicht verschiebt.
    const result = buildCanonicalEInvoice(
      invoice({
        positions: [line({ quantity: 3, unitPrice: 33.33, lineTotal: 99.99 })],
        subtotal: 99.99,
        amount: 118.99,
      }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.totals.taxExclusiveAmount).toBe(99.99);
    expect(result.value.totals.taxAmount).toBe(19);
    expect(result.value.totals.taxInclusiveAmount).toBe(118.99);
    expect(result.value.totals.payableAmount).toBe(118.99);
  });

  it('ein in sich widersprüchlicher Beleg wird abgewiesen, nicht korrigiert', () => {
    const zeile = buildCanonicalEInvoice(
      invoice({ positions: [line({ lineTotal: 999 })], subtotal: 999, amount: 1188.81 }),
    );
    erwarteFehler(zeile, 'money_inconsistent');

    const summe = buildCanonicalEInvoice(invoice({ subtotal: 150 }));
    erwarteFehler(summe, 'money_inconsistent');

    const brutto = buildCanonicalEInvoice(invoice({ amount: 200 }));
    erwarteFehler(brutto, 'money_inconsistent');
  });
});

describe('I — Snapshot-Integrität und Determinismus', () => {
  it('T26: der Builder liest ausschliesslich den Beleg', () => {
    /*
     * Es gibt keinen zweiten Parameter für Stammdaten — der Builder *kann*
     * nichts nachladen. Geprüft wird die sichtbare Folge: Zwei Belege mit
     * verschiedenen eingefrorenen Werten ergeben verschiedene Modelle, und der
     * ältere bleibt beim älteren Wert.
     */
    const a = buildCanonicalEInvoice(invoice());
    const b = buildCanonicalEInvoice(
      invoice({
        id: 'inv-neu',
        customerSnapshot: { ...BUYER, buyerReference: 'TEST-BUYER-REF-B', vatId: 'DE-KUNDE-B' },
      }),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.buyer.buyerReference).toBe('TEST-BUYER-REF-A');
    expect(a.value.buyer.vatId).toBe('DE-KUNDE-A');
    expect(b.value.buyer.buyerReference).toBe('TEST-BUYER-REF-B');
    expect(b.value.buyer.vatId).toBe('DE-KUNDE-B');
  });

  it('T28: zweimal bauen ergibt exakt dasselbe', () => {
    const quelle = invoice({
      positions: [line({ id: 'p1' }), line({ id: 'p2', description: 'Anfahrt', unit: 'Pauschal', quantity: 1, unitPrice: 40, lineTotal: 40 })],
      subtotal: 200,
      amount: 238,
    });
    const a = buildCanonicalEInvoice(quelle);
    const b = buildCanonicalEInvoice(quelle);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (!a.ok) return;
    // Stabile Kennungen und Reihenfolge — nichts wird erzeugt.
    expect(a.value.lines.map((l) => [l.id, l.position])).toEqual([
      ['p1', 1],
      ['p2', 2],
    ]);
  });

  it('auch die Befunde sind deterministisch geordnet', () => {
    const kaputt = invoice({
      currencyCode: undefined,
      customerSnapshot: { ...BUYER, countryCode: undefined, buyerReference: '' },
    });
    expect(JSON.stringify(buildCanonicalEInvoice(kaputt))).toBe(
      JSON.stringify(buildCanonicalEInvoice(kaputt)),
    );
  });
});
