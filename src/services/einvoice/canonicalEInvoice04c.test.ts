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

const SELLER: CompanyProfile = {
  companyName: 'Cirmak Haustechnik GmbH',
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
  leitwegId: 'TEST-LEITWEG-A',
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
    expect(c.buyer.leitwegId).toBe('TEST-LEITWEG-A');

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

  it('T23: eine Schlussrechnung mit Abzügen wird ausdrücklich noch nicht abgebildet', () => {
    /*
     * Die Abzüge belegen, dass abgerechnet wurde — nicht, dass bezahlt wurde.
     * Der Zahlungsstand liegt in `payments`/`paymentStatus` und verlässt den
     * Client nicht einmal. Sie als gezahlten Betrag auszuweisen wäre eine
     * Behauptung über Geldflüsse, die OfficeTakt nicht kennt.
     */
    erwarteFehler(
      buildCanonicalEInvoice(
        invoice({
          type: 'schluss',
          subtotal: 1000,
          amount: 690,
          positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
          previousAbschlagDeductions: [
            { invoiceId: 'inv-a1', invoiceNumber: '2026-0031', date: '2026-08-01', subtotal: 400, amount: 476 },
          ],
        }),
      ),
      'final_invoice_deduction_semantics_unsupported',
    );
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
  it('T24: der Korrekturbeleg trägt die Referenz auf sein Original', () => {
    const result = buildCanonicalEInvoice(
      invoice({
        cancelledAt: '2026-09-25T10:00:00.000Z',
        cancellationKind: 'correction',
        cancelReason: 'Falscher Leistungszeitraum',
      }),
    );
    expect(result.ok, JSON.stringify(codes(result))).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentKind).toBe('correction');
    expect(result.value.references.correction).toEqual({
      originalInvoiceId: 'inv-04c',
      originalInvoiceNumber: '2026-0042',
      originalIssueDate: '2026-09-23',
      reason: 'Falscher Leistungszeitraum',
    });
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
