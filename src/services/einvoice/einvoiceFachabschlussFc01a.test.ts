/**
 * FINANZ-CORE-01A Fortsetzung — E-Rechnung im Fachabschluss.
 *
 *  E1  IBAN und BIC stehen ohne Leerzeichen im XML (EIN-09)
 *  E2  PDF und ZUGFeRD-XML beschreiben dieselbe Schlussrechnung mit Abzügen und denselben
 *      Verkäufernamen samt Rechtsform (D1, AUS-06); eine abweichende Abzugssumme fällt auf
 *  E3  die Korrektur-XRechnung (381) hängt am Korrekturbeleg, nie am Original; das Original
 *      bekommt nach dem Storno keine neue Datei (AUS-08/STO-09)
 *  N02 (WEISS-Nacharbeit) BT-113 nur für beglichene Abschläge: Skonto-Begleichung mit
 *      getrennter Notiz; teilbezahlt oder unbekannt → keine XRechnung, kein ZUGFeRD
 *
 * Die Goldfiles 10 (Korrektur 381), 12 (Schlussrechnung mit Abzügen) und 13 (Leitweg-ID)
 * hat der KoSIT-Validator 1.6.3 mit XRechnung 3.0.2 angenommen; ihren Bytevergleich führt
 * `xrechnungCii04d.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCanonicalEInvoice } from './canonicalEInvoiceBuilder';
import { prepaymentSettlementsFor } from './einvoicePrepaymentSettlements';
import * as invoiceRegistry from '../invoice/invoiceRegistryService';
import { renderXRechnungCii } from './xrechnungCiiRenderer';
import { checkZugferdPdfXmlConsistency } from './zugferd/zugferdPdfXmlConsistency';
import { ensureXRechnungArtifact, readXRechnungArtifact } from './xrechnungArtifactService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { PRIVATE_RETENTION_NOTICE } from '../invoiceTaxService';
import { hydrateDocumentFileStore } from '../documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { hydrateDocumentStore } from '../documentService';
import { clearDocumentBlobStoreForTests } from '../storage/documentBlobIndexedDbService';
import { resetTestStores } from '../../test/resetStores';
import type { CompanyDocument, CompanyProfile, CustomerBilling, VorgangInvoice, VorgangInvoiceLine } from '../../types/models';

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
  bankName: 'Sparkasse',
  iban: 'de89 3704 0044 0532 0130 00',
  bic: 'welad ed1esn',
  accountHolder: 'Cirmak Haustechnik GmbH',
  registrationAuthority: 'Amtsgericht Essen',
  registrationNumber: 'HRB 12345',
  managingDirector: 'Saban Irmak',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
  invoiceFooterNotes: 'Vielen Dank für Ihren Auftrag.',
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
  vatId: 'DE987654321',
  buyerReference: 'TEST-BUYER-REF-A',
};

function line(o: Partial<VorgangInvoiceLine> = {}): VorgangInvoiceLine {
  return { id: 'p1', description: 'Wartung', quantity: 10, unit: 'Stunden', unitPrice: 100, lineTotal: 1000, ...o } as VorgangInvoiceLine;
}

function invoice(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-fc01a',
    number: '2026-0061',
    type: 'rechnung',
    positions: [line()],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: '2026-09-24',
    createdAt: '2026-09-24T08:00:00.000Z',
    issueDate: '2026-09-24',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-24',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-08',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { ...BUYER },
    companySnapshot: { ...SELLER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...o,
  } as unknown as VorgangInvoice;
}

const SCHLUSS = invoice({
  type: 'schluss',
  amount: 714,
  previousAbschlagDeductions: [
    { invoiceId: 'a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476 },
  ],
});

/*
 * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — die abgezogenen Abschläge selbst: bezahlt,
 * mit Skonto beglichen, unbezahlt. Ihr Zahlungsstand kommt wie im Betrieb aus dem
 * Rechnungsbestand (`findInvoiceById`); BT-113 entsteht nur für beglichene Abschläge.
 */
function abschlag(id: string, number: string, o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return invoice({
    id,
    number,
    type: 'abschlag',
    status: 'versendet',
    issueDate: '2026-08-01',
    date: '2026-08-01',
    positions: [],
    subtotal: 400,
    amount: 476,
    ...o,
  });
}

function zahlung(id: string, amount: number, date: string) {
  return { id, amount, date, createdAt: `${date}T09:00:00.000Z` };
}

const ABSCHLAEGE: Record<string, VorgangInvoice> = {
  a1: abschlag('a1', '2026-0031', { payments: [zahlung('p-a1', 476, '2026-08-10')] }),
  a2: abschlag('a2', '2026-0032', {
    skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
    payments: [zahlung('p-a2', 466.48, '2026-08-05')],
  }),
  a3: abschlag('a3', '2026-0033', { payments: [zahlung('p-a3', 200, '2026-08-05')] }),
  // WEISS-Recheck N02-R1 — 106 netto / 126,14 brutto, fristgerecht mit 2 % Skonto: 123,62 gezahlt, 2,52 Skonto.
  a4: abschlag('a4', '2026-0034', {
    subtotal: 106,
    amount: 126.14,
    skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
    payments: [zahlung('p-a4', 123.62, '2026-08-05')],
  }),
};

/* WEISS-Recheck N02-R1 — so friert die Freigabe den mit Skonto beglichenen Abschlag ein. */
const SCHLUSS_SKONTO = invoice({
  id: 'inv-fc01a-skonto',
  number: '2026-0063',
  type: 'schluss',
  amount: 714,
  previousAbschlagDeductions: [
    { invoiceId: 'a2', invoiceNumber: '2026-0032', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476, paidAmount: 466.48, skontoAmount: 9.52 },
  ],
});

/*
 * WEISS-Recheck N02-R1 — für die externe Prüfung: Netto 1.234,56 €, Skonto 2,52 € — der Nachlass
 * (2,12 €) geht nicht genau auf, BT-114 gleicht den Cent aus (BR-CO-16).
 */
const SCHLUSS_SKONTO_RUNDUNG = invoice({
  id: 'inv-fc01a-skonto-rundung',
  number: '2026-0066',
  type: 'schluss',
  positions: [line({ quantity: 1, unit: 'Pauschal', unitPrice: 1234.56, lineTotal: 1234.56 })],
  subtotal: 1234.56,
  amount: 1342.99,
  previousAbschlagDeductions: [
    { invoiceId: 'a4', invoiceNumber: '2026-0034', abschlagNumber: 1, date: '2026-08-01', subtotal: 106, amount: 126.14, paidAmount: 123.62, skontoAmount: 2.52 },
  ],
});

/* WEISS-Recheck N02-R1 — für die externe Prüfung: ein Abschlag voll bezahlt, einer mit Skonto beglichen. */
const SCHLUSS_MEHRERE_SKONTO = invoice({
  id: 'inv-fc01a-mehrere-skonto',
  number: '2026-0067',
  type: 'schluss',
  positions: [line({ quantity: 20, lineTotal: 2000 })],
  subtotal: 2000,
  amount: 1428,
  previousAbschlagDeductions: [
    { invoiceId: 'a1', invoiceNumber: '2026-0031', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476, paidAmount: 476, skontoAmount: 0 },
    { invoiceId: 'a2', invoiceNumber: '2026-0032', abschlagNumber: 2, date: '2026-08-01', subtotal: 400, amount: 476, paidAmount: 466.48, skontoAmount: 9.52 },
  ],
});

/* Ein Altbeleg: freigegeben, bevor gezahlt und Skonto getrennt festgehalten wurden. */
const SCHLUSS_SKONTO_ALT = invoice({
  id: 'inv-fc01a-skonto-alt',
  number: '2026-0065',
  type: 'schluss',
  amount: 714,
  previousAbschlagDeductions: [
    { invoiceId: 'a2', invoiceNumber: '2026-0032', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476 },
  ],
});

const SCHLUSS_TEILBEZAHLT = invoice({
  id: 'inv-fc01a-teil',
  number: '2026-0064',
  type: 'schluss',
  amount: 714,
  previousAbschlagDeductions: [
    { invoiceId: 'a3', invoiceNumber: '2026-0033', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476 },
  ],
});

beforeEach(() => {
  vi.spyOn(invoiceRegistry, 'findInvoiceById').mockImplementation((invoiceId: string) => ABSCHLAEGE[invoiceId]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FINANZ-CORE-01A — E-Rechnung im Fachabschluss', () => {
  it('E1 IBAN und BIC ohne Leerzeichen und in Grossbuchstaben', () => {
    const canonical = buildCanonicalEInvoice(invoice());
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.payment.transfer).toEqual(
      expect.objectContaining({ iban: 'DE89370400440532013000', bic: 'WELADED1ESN' }),
    );
    const rendered = renderXRechnungCii(canonical.value);
    expect(rendered.ok && rendered.xml).toContain('<ram:IBANID>DE89370400440532013000</ram:IBANID>');
  });

  it('E2 PDF und XML einer Schlussrechnung mit Abzügen stimmen überein — samt Rechtsform', () => {
    const canonical = buildCanonicalEInvoice(SCHLUSS, { prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS) });
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.seller.name).toBe('Cirmak Haustechnik GmbH');
    const model = buildInvoicePrintModelFromInvoice(SCHLUSS);
    expect(checkZugferdPdfXmlConsistency(model, canonical.value)).toEqual({ ok: true });

    // Eine abweichende Abzugssumme im XML fällt auf.
    const verfaelscht = {
      ...canonical.value,
      totals: { ...canonical.value.totals, prepaidAmount: 400 },
    };
    const result = checkZugferdPdfXmlConsistency(model, verfaelscht);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.mismatches.map((m) => m.field)).toContain('totals.prepaid');
  });

  /*
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — BT-113 ist der bereits gezahlte Betrag.
   */
  /*
   * WEISS-Recheck N02-R1 — ersetzt den früheren Vertrag („476 in BT-113, Skonto nur in der Notiz"):
   * BT-113 ist nur das Gezahlte; das Skonto ist ein Nachlass auf Belegebene mit Steuer; PDF,
   * XRechnung und ZUGFeRD zeigen dieselbe Aufteilung.
   */
  it('N02a mit Skonto beglichen: BT-113 nur gezahlt, Skonto als Nachlass — PDF und XML stimmen, ZUGFeRD entsteht', async () => {
    const { buildZugferdInvoice } = await import('./zugferd/zugferdArtifactService');
    const settlements = prepaymentSettlementsFor(SCHLUSS_SKONTO);
    expect(settlements).toEqual([{ invoiceId: 'a2', paid: 466.48, skonto: 9.52, settled: true }]);
    const canonical = buildCanonicalEInvoice(SCHLUSS_SKONTO, { prepaymentSettlements: settlements });
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.totals).toMatchObject({
      lineNetTotal: 1000,
      allowanceTotal: 8,
      taxExclusiveAmount: 992,
      taxAmount: 188.48,
      taxInclusiveAmount: 1180.48,
      prepaidAmount: 466.48,
      payableAmount: 714,
    });
    expect(canonical.value.notes).toEqual(
      expect.arrayContaining([
        'Abzüglich bereits bezahlter Abschläge: Abschlag 1 (Rechnung 2026-0032 vom 01.08.2026) 466,48 EUR gezahlt von 476,00 EUR brutto',
        'Skonto auf Abschlag 1 (Rechnung 2026-0032): 9,52 EUR brutto (netto 8,00 EUR, USt 1,52 EUR), als Nachlass auf Belegebene ausgewiesen (Entgeltminderung).',
      ]),
    );

    // Das PDF zeigt dieselbe Aufteilung: gezahlt (vereinnahmtes Teilentgelt samt Steuer) und Skonto.
    const model = buildInvoicePrintModelFromInvoice(SCHLUSS_SKONTO);
    expect(model.summary.deductionLines).toEqual([
      { label: 'Abschlag 1', invoiceNumber: '2026-0032', amount: 466.48, netAmount: 392, taxAmount: 74.48, paidPart: true },
    ]);
    expect(model.summary.skontoLines).toEqual([
      { label: 'Skonto auf Abschlag 1', invoiceNumber: '2026-0032', amount: 9.52, netAmount: 8, taxAmount: 1.52 },
    ]);
    expect(model.summary).toMatchObject({ deductionsTotal: 476, deductionsPaidTotal: 466.48, skontoNetTotal: 8, amountDue: 714 });
    expect(checkZugferdPdfXmlConsistency(model, canonical.value)).toEqual({ ok: true });

    // Ein XML, das das Skonto wieder als Zahlung führt, widerspricht dem PDF.
    const alt = { ...canonical.value, totals: { ...canonical.value.totals, prepaidAmount: 476 } };
    const widerspruch = checkZugferdPdfXmlConsistency(model, alt);
    expect(widerspruch.ok).toBe(false);
    if (!widerspruch.ok) expect(widerspruch.mismatches.map((m) => m.field)).toContain('totals.prepaid');
    // Ebenso ein XML ohne den Nachlass (BT-107) oder mit ungeminderter Steuer (BT-110).
    const ohneNachlass = { ...canonical.value.totals };
    delete ohneNachlass.allowanceTotal;
    for (const [feld, totals] of [
      ['totals.allowance', ohneNachlass],
      ['totals.tax', { ...canonical.value.totals, taxAmount: 190 }],
    ] as const) {
      const falsch = checkZugferdPdfXmlConsistency(model, { ...canonical.value, totals });
      expect(falsch.ok, feld).toBe(false);
      if (!falsch.ok) expect(falsch.mismatches.map((m) => m.field)).toContain(feld);
    }

    const rendered = renderXRechnungCii(canonical.value);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.xml).toContain('<ram:TotalPrepaidAmount>466.48</ram:TotalPrepaidAmount>');
      expect(rendered.xml).toContain('<ram:AllowanceTotalAmount>8.00</ram:AllowanceTotalAmount>');
      expect(rendered.xml).toContain('<ram:TaxBasisTotalAmount>992.00</ram:TaxBasisTotalAmount>');
      expect(rendered.xml).toContain('<ram:DuePayableAmount>714.00</ram:DuePayableAmount>');
    }
    const hybrid = await buildZugferdInvoice(SCHLUSS_SKONTO);
    expect(hybrid.ok, hybrid.ok ? '' : JSON.stringify(hybrid)).toBe(true);
  });

  it('N02a2 Altbeleg mit Skonto ohne eingefrorene Aufteilung: keine XRechnung und kein ZUGFeRD', async () => {
    const { buildZugferdInvoice } = await import('./zugferd/zugferdArtifactService');
    const canonical = buildCanonicalEInvoice(SCHLUSS_SKONTO_ALT, {
      prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS_SKONTO_ALT),
    });
    expect(canonical.ok).toBe(false);
    if (!canonical.ok) expect(canonical.issues.map((issue) => issue.code)).toContain('prepayment_skonto_unfrozen');
    const hybrid = await buildZugferdInvoice(SCHLUSS_SKONTO_ALT);
    expect(hybrid.ok).toBe(false);
  });

  it('N02b teilbezahlter oder unbekannter Abschlag: keine XRechnung und kein ZUGFeRD', async () => {
    const { buildZugferdInvoice } = await import('./zugferd/zugferdArtifactService');
    expect(prepaymentSettlementsFor(SCHLUSS_TEILBEZAHLT)).toEqual([
      { invoiceId: 'a3', paid: 200, skonto: 0, settled: false },
    ]);
    const canonical = buildCanonicalEInvoice(SCHLUSS_TEILBEZAHLT, {
      prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS_TEILBEZAHLT),
    });
    expect(canonical.ok).toBe(false);
    if (!canonical.ok) expect(canonical.issues.map((issue) => issue.code)).toContain('prepayment_not_settled');
    const hybrid = await buildZugferdInvoice(SCHLUSS_TEILBEZAHLT);
    expect(hybrid.ok).toBe(false);
    if (!hybrid.ok && hybrid.reason === 'canonical_incomplete') {
      expect(hybrid.issues.map((issue) => issue.code)).toContain('prepayment_not_settled');
    } else {
      throw new Error(`unerwartet: ${JSON.stringify(hybrid)}`);
    }
    // Ein Abschlag, den der Bestand nicht kennt, ist nicht als bezahlt belegt.
    vi.spyOn(invoiceRegistry, 'findInvoiceById').mockReturnValue(undefined);
    expect(prepaymentSettlementsFor(SCHLUSS)).toEqual([{ invoiceId: 'a1', paid: 0, skonto: 0, settled: false }]);
  });

  /*
   * Nachweis-Export für die externe Prüfung (KoSIT für XRechnung, Mustang für ZUGFeRD).
   * Läuft nur mit gesetztem FC01A_EINVOICE_OUT und schreibt ausschliesslich dorthin.
   */
  it.skipIf(!process.env.FC01A_EINVOICE_OUT)('X schreibt XRechnung und ZUGFeRD-PDF für die externe Prüfung', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { buildZugferdInvoice } = await import('./zugferd/zugferdArtifactService');
    const ziel = process.env.FC01A_EINVOICE_OUT!;
    mkdirSync(ziel, { recursive: true });
    const faelle: Array<[string, VorgangInvoice]> = [
      ['standard-19', invoice()],
      ['schluss-abzuege', SCHLUSS],
      // FINANZ-CORE-01A (WEISS N02/D1) — Abschlag mit Skonto beglichen.
      ['schluss-abzuege-skonto', SCHLUSS_SKONTO],
      // WEISS-Recheck N02-R1 — Rundungscent in BT-114; zwei Abschläge, einer mit Skonto.
      ['schluss-skonto-rundung', SCHLUSS_SKONTO_RUNDUNG],
      ['schluss-mehrere-skonto', SCHLUSS_MEHRERE_SKONTO],
      [
        'kleinunternehmer',
        invoice({
          taxStatus: 'kleinunternehmer_19',
          amount: 1000,
          legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
        }),
      ],
      [
        'reverse-charge',
        invoice({
          taxStatus: 'reverse_charge_13b',
          amount: 1000,
          legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
        }),
      ],
      // FINANZ-CORE-01A (AUS-11/EIN-07) — der Aufbewahrungshinweis als Belegnotiz, nie als Befreiungsgrund.
      ['aufbewahrung', invoice({ legalNotices: [PRIVATE_RETENTION_NOTICE] })],
      [
        'kleinunternehmer-aufbewahrung',
        invoice({
          taxStatus: 'kleinunternehmer_19',
          amount: 1000,
          legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', PRIVATE_RETENTION_NOTICE],
        }),
      ],
    ];
    for (const [name, beleg] of faelle) {
      const canonical = buildCanonicalEInvoice(beleg, { prepaymentSettlements: prepaymentSettlementsFor(beleg) });
      expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
      if (!canonical.ok) continue;
      const rendered = renderXRechnungCii(canonical.value);
      if (rendered.ok) writeFileSync(path.join(ziel, `xrechnung-${name}.xml`), rendered.xml, 'utf8');
      const hybrid = await buildZugferdInvoice(beleg);
      expect(hybrid.ok, hybrid.ok ? '' : JSON.stringify(hybrid)).toBe(true);
      if (hybrid.ok) writeFileSync(path.join(ziel, `zugferd-${name}.pdf`), hybrid.artifact.bytes);
    }
  });

  describe('E3 die Korrektur-XRechnung am Korrekturbeleg', () => {
    const STORNIERT = invoice({
      status: 'versendet',
      cancelledAt: '2026-09-25T10:00:00.000Z',
      cancellationKind: 'correction',
      cancelReason: 'Falscher Leistungszeitraum',
      correctionDocumentId: 'corr-inv-fc01a',
      correctionNumber: '2026-0062',
    });
    const original = {
      id: 'doc-inv-fc01a',
      title: '2026-0061 – Rechnung',
      category: 'ausgangsrechnung',
      classifiedKind: 'ausgangsrechnung',
      linkedInvoiceId: STORNIERT.id,
      createdAt: '2026-09-24T08:00:00.000Z',
      tags: [],
    } as unknown as CompanyDocument;
    const korrektur = {
      id: 'corr-inv-fc01a',
      title: 'Rechnungskorrektur 2026-0062 zu Rechnung 2026-0061',
      category: 'ausgangsrechnung',
      classifiedKind: 'rechnungskorrektur',
      linkedInvoiceId: STORNIERT.id,
      createdAt: '2026-09-25T10:00:00.000Z',
      tags: [],
    } as unknown as CompanyDocument;

    beforeEach(async () => {
      resetTestStores();
      await clearDocumentBlobStoreForTests();
      hydrateDocumentStore([original, korrektur] as never);
      hydrateDocumentFileStore([], {});
      hydrateDocumentFileRepresentationBindingStore([]);
    });
    afterEach(() => {
      resetTestStores();
      vi.restoreAllMocks();
    });

    it('legt die Gutschrift am Korrekturbeleg ab und lässt das Original unangetastet', async () => {
      const result = await ensureXRechnungArtifact(STORNIERT, { variant: 'correction' });
      expect(result.ok, result.ok ? '' : JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.artifact.sourceInvoiceNumber).toBe('2026-0062');
      expect(result.artifact.fileName).toBe('XRechnung-Korrektur-2026-0062.xml');
      const xml = new TextDecoder().decode(result.artifact.bytes);
      expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
      expect(xml).toContain('<ram:ID>2026-0062</ram:ID>');

      const bindungen = getDocumentFileRepresentationBindingStoreSnapshot();
      expect(bindungen).toHaveLength(1);
      expect(bindungen[0]!.documentId).toBe('corr-inv-fc01a');

      // Wiederholt: dieselbe Datei; das Original hat weiterhin keine.
      const wieder = await ensureXRechnungArtifact(STORNIERT, { variant: 'correction' });
      expect(wieder.ok && wieder.reused).toBe(true);
      expect(await readXRechnungArtifact(STORNIERT)).toBeNull();

      // Für das stornierte Original entsteht keine neue Datei.
      const neuesOriginal = await ensureXRechnungArtifact(STORNIERT);
      expect(neuesOriginal.ok).toBe(false);
      if (!neuesOriginal.ok && neuesOriginal.reason === 'canonical_incomplete') {
        expect(neuesOriginal.issues.map((i) => i.code)).toContain('cancelled_original_not_exportable');
      }
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toHaveLength(1);
    });
  });
});
