/**
 * FINANZ-CORE-01A (WEISS-Recheck N02-R1/R2) — gezahlt und Skonto getrennt; Skonto nur in der Frist.
 *
 * WEISS N02-R1: Abschlag 476 € (400 + 76), fristgerecht 466,48 € gezahlt und 9,52 € Skonto — die
 * E-Rechnung führte BT-113 = 476,00 €; das Skonto stand nur in der Notiz. BT-113 ist aber der
 * tatsächlich gezahlte Betrag; ein erlassener Betrag wird durch eine Notiz nicht zur Zahlung.
 * WEISS N02-R2: Der Server nahm einen erst nach Fristablauf zu 98 % gezahlten Abschlag als beglichen.
 *
 *  A1–A6  Aufteilung (rein): ohne Skonto unverändert; Skonto exakt; Rundung über BT-114;
 *         mehrere Abschläge; steuerfreier Beleg; Zahlung über dem Betrag; exaktes Netto neben
 *         dem Näherungswert
 *  F1–F4  Freigabe: friert gezahlt/Skonto ein; verspätetes Skonto sperrt; Teilzahlung in der Frist
 *         und Rest danach sperrt, bis voll bezahlt (dann ohne Skonto); die Vorschau teilt nur
 *         fristgerecht beglichene Abschläge auf
 *  P1     PDF: gezahlter Teil und Skonto als eigene Zeilen; „Bereits berechnet" und Restbetrag gleich
 *  K1     der Korrekturbeleg bucht gezahlt und Skonto gegen
 *  X1     XRechnung und ZUGFeRD: Nachlass, BT-107 und BT-114 in der Reihenfolge des Schemas
 *  V1     Cloud-Prüfer: die Aufteilung steht nur vollständig im Beleg
 *  S1     Serverabweisungen nennen Aufteilung und Skontofrist
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFPage } from 'pdf-lib';

import { frozenSettlementShare, splitAbschlagDeductions } from './abschlagSkontoSplit';
import { liveSettlementShareOf } from './abschlagSettlement';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { buildInvoiceCorrectionModel } from './invoiceCorrectionModel';
import { buildWorkspaceInvoiceFinalizePayload, classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { buildSchlussrechnungDraft, finalizeInvoiceDraft } from '../invoiceService';
import { getOpenAmount } from '../invoicePaymentService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateDocumentStore } from '../documentService';
import { buildCanonicalEInvoice } from '../einvoice/canonicalEInvoiceBuilder';
import { renderXRechnungCii } from '../einvoice/xrechnungCiiRenderer';
import { renderZugferdEn16931Cii } from '../einvoice/zugferd/zugferdEn16931Renderer';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { t } from '../../i18n';
import type { AbschlagDeduction, CompanyProfile, InvoiceDraft, InvoicePayment, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-test-1';
const SKONTO = '2 % Skonto bei Zahlung innerhalb von 10 Tagen';

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

function abzug(o: Partial<AbschlagDeduction> = {}): AbschlagDeduction {
  return { invoiceId: 'inv-ab-1', invoiceNumber: '2026-0017', abschlagNumber: 1, date: '2026-09-01', subtotal: 400, amount: 476, ...o };
}

/** Pauschalabschlag 400 netto / 476 brutto vom 01.09.2026 (Skontofrist bis 11.09.2026). */
function abschlag(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ab-1',
    number: '2026-0017',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: 400,
    positions: [],
    subtotal: 400,
    taxStatus: 'standard_19',
    amount: 476,
    status: 'versendet',
    date: '2026-09-01',
    issueDate: '2026-09-01',
    createdAt: '2026-09-01T10:00:00.000Z',
    skontoText: SKONTO,
    payments: [],
    ...o,
  };
}

function prepare(ab: VorgangInvoice): InvoiceDraft {
  hydrateVorgangStore([
    createTestVorgang({
      orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 10 })],
      invoices: [ab],
    }),
  ]);
  const draft = buildSchlussrechnungDraft(VORGANG_ID, testSetup);
  expect(draft, 'Schlussrechnungsentwurf konnte nicht gebaut werden').not.toBeNull();
  return { ...draft!, servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-30', servicePeriodConfirmed: true };
}

const COMPANY = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  countryCode: 'DE',
  contactPerson: 'Frau Beispiel',
  phone: '0521 4711',
  email: 'buero@beispiel.invalid',
  taxNumber: '11/222/33333',
  vatId: 'DE111111111',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'WELADED1ESN',
} as unknown as CompanyProfile;

/** Freigegebene Schlussrechnung 650 netto / 773,50 brutto, Abzug 476 (466,48 gezahlt + 9,52 Skonto). */
function schluss(deduction: AbschlagDeduction = abzug({ paidAmount: 466.48, skontoAmount: 9.52 })): VorgangInvoice {
  return {
    id: 'inv-schluss-skonto',
    number: '2026-0024',
    type: 'schluss',
    positions: [
      { id: 'line-1', orderPositionId: 'op-test-1', description: 'Fliesenarbeiten', quantity: 10, unit: 'Stunden', unitPrice: 65, lineTotal: 650 },
    ],
    subtotal: 650,
    taxStatus: 'standard_19',
    amount: 297.5,
    status: 'vorbereitet',
    date: '2026-09-30',
    createdAt: '2026-09-30T10:00:00.000Z',
    issueDate: '2026-09-30',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-30',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-14',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH', contactPerson: 'Herr Kunde', street: 'Musterweg 1', zip: '12345', city: 'Beispielstadt',
      email: 'kunde@beispiel.invalid', phone: '', countryCode: 'DE', buyerReference: 'REF-1',
    },
    companySnapshot: COMPANY,
    legalNotices: [],
    previousAbschlagDeductions: [deduction],
    introText: 'Einleitung',
    closingText: 'Schluss',
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
  } as unknown as VorgangInvoice;
}

describe('N02-R1 A — die Aufteilung je Abzug', () => {
  const RECHNUNG = { subtotalNet: 1000, taxRate: 19 };

  it('A1: ohne Skonto unverändert — gezahlt = abgezogen, kein Nachlass, keine Rundung', () => {
    const split = splitAbschlagDeductions([abzug()], RECHNUNG, () => null);
    expect(split).toMatchObject({ hasSkonto: false, paidTotal: 476, skontoTotal: 0, skontoNetTotal: 0, taxAfterSkonto: 190, roundingAmount: 0 });
    expect(split.parts[0]).toMatchObject({ paid: 476, paidNet: 400, paidTax: 76, skonto: 0, skontoNet: 0, skontoTax: 0 });
  });

  it('A2: 466,48 gezahlt + 9,52 Skonto — Teilentgelt 392 + 74,48, Nachlass 8,00 + 1,52, Steuer danach 188,48', () => {
    const eingefroren = abzug({ paidAmount: 466.48, skontoAmount: 9.52 });
    expect(frozenSettlementShare(eingefroren)).toEqual({ paid: 466.48, skonto: 9.52 });
    expect(frozenSettlementShare(abzug())).toBeNull();
    const split = splitAbschlagDeductions([eingefroren], RECHNUNG, frozenSettlementShare);
    expect(split).toMatchObject({ hasSkonto: true, paidTotal: 466.48, skontoTotal: 9.52, skontoNetTotal: 8, skontoTaxTotal: 1.52, taxAfterSkonto: 188.48, roundingAmount: 0 });
    expect(split.parts[0]).toMatchObject({ paid: 466.48, paidNet: 392, paidTax: 74.48, skonto: 9.52, skontoNet: 8, skontoTax: 1.52 });
  });

  it('A3: geht der Nachlass wegen der Rundung nicht auf, steht der Cent in BT-114', () => {
    const split = splitAbschlagDeductions([abzug({ paidAmount: 468.83, skontoAmount: 7.17 })], RECHNUNG, frozenSettlementShare);
    expect(split).toMatchObject({ skontoNetTotal: 6.03, taxAfterSkonto: 188.85, roundingAmount: 0.01 });
    // BR-S-09 (Steuer = Basis × Satz) und BR-CO-16 (BT-115 = BT-112 − BT-113 + BT-114 = Restbetrag 714).
    expect(Math.round((1000 - 6.03) * 19)).toBe(18885);
    expect(Math.round((1000 - 6.03 + 188.85 - 468.83 + 0.01) * 100)).toBe(71400);
  });

  it('A4: mehrere Abschläge — das Netto des Skontos verteilt sich, jede Zeile bleibt stimmig', () => {
    const abzuege = [
      abzug({ invoiceId: 'a', invoiceNumber: '2026-0001', paidAmount: 466.48, skontoAmount: 9.52 }),
      abzug({ invoiceId: 'b', invoiceNumber: '2026-0002', subtotal: 200, amount: 238 }),
      abzug({ invoiceId: 'c', invoiceNumber: '2026-0003', subtotal: 100, amount: 119, paidAmount: 116.62, skontoAmount: 2.38 }),
    ];
    const split = splitAbschlagDeductions(abzuege, { subtotalNet: 2000, taxRate: 19 }, frozenSettlementShare);
    expect(split.paidTotal).toBe(466.48 + 238 + 116.62);
    expect(Math.round(split.parts.reduce((sum, part) => sum + part.skontoNet, 0) * 100)).toBe(Math.round(split.skontoNetTotal * 100));
    for (const part of split.parts) {
      expect(Math.round((part.paidNet + part.skontoNet) * 100)).toBe(Math.round(part.billedNet * 100));
      expect(Math.round((part.paid + part.skonto) * 100)).toBe(Math.round(part.billed * 100));
    }
    expect(split.parts[1]).toMatchObject({ paid: 238, skonto: 0, skontoNet: 0 });
    // Netto des Skontos 10,00 € (11,90 € / 1,19) anteilig: 8,00 € auf Abschlag a, 2,00 € auf Abschlag c.
    expect(split.parts[0]).toMatchObject({ skontoNet: 8, skontoTax: 1.52 });
    expect(split.parts[2]).toMatchObject({ skontoNet: 2, skontoTax: 0.38 });
  });

  it('A5: steuerfreier Beleg — Skonto ist ganz Netto; eine „Zahlung" über dem Betrag ist kein Skonto', () => {
    const frei = splitAbschlagDeductions([abzug({ subtotal: 476, paidAmount: 466.48, skontoAmount: 9.52 })], { subtotalNet: 1000, taxRate: 0 }, frozenSettlementShare);
    expect(frei).toMatchObject({ skontoNetTotal: 9.52, skontoTaxTotal: 0, taxAfterSkonto: 0, roundingAmount: 0 });
    const ueber = splitAbschlagDeductions([abzug()], RECHNUNG, () => ({ paid: 480, skonto: 5 }));
    expect(ueber).toMatchObject({ hasSkonto: false, paidTotal: 476 });
  });

  it('A6: liegt das genau aufgehende Netto neben dem Näherungswert, wird es gefunden — kein Rundungscent', () => {
    // Netto 1.000,01 €: 2,04 € / 1,19 = 1,71 € ließe einen Cent offen; mit 1,72 € geht der Nachlass
    // genau auf (Steuer 190,00 → 189,68 €, Minderung 0,32 €; 1,72 + 0,32 = 2,04).
    const split = splitAbschlagDeductions(
      [abzug({ paidAmount: 473.96, skontoAmount: 2.04 })],
      { subtotalNet: 1000.01, taxRate: 19 },
      frozenSettlementShare,
    );
    expect(split).toMatchObject({ skontoNetTotal: 1.72, skontoTaxTotal: 0.32, taxAfterSkonto: 189.68, roundingAmount: 0 });
  });
});

describe('N02-R1/R2 F — Freigabe der Schlussrechnung', () => {
  beforeEach(() => hydrateVorgangStore([]));

  it('F1: fristgerechtes Skonto — die Freigabe friert gezahlt und Skonto ein; Restbetrag unverändert', () => {
    const draft = prepare(abschlag({ payments: [zahlung('p1', 466.48, '2026-09-05')] }));
    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.previousAbschlagDeductions).toEqual([abzug({ paidAmount: 466.48, skontoAmount: 9.52 })]);
    expect(result.invoice.amount).toBeCloseTo(297.5, 2);
    const summary = buildInvoicePrintModelFromInvoice(result.invoice).summary;
    expect(summary).toMatchObject({ deductionsTotal: 476, deductionsPaidTotal: 466.48, skontoTotal: 9.52, amountDue: 297.5 });
  });

  it('F2: Skonto erst nach der Frist (98 % am 25.09.) — nicht beglichen, keine Schlussrechnung', () => {
    const ab = abschlag({ payments: [zahlung('p1', 466.48, '2026-09-25')] });
    expect(getOpenAmount(ab)).toBe(9.52);
    const result = finalizeInvoiceDraft(VORGANG_ID, prepare(ab), testSetup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.validation?.blockingErrors.map((issue) => issue.code)).toContain('abschlag_unpaid');
    expect(getVorgangById(VORGANG_ID)!.invoices.filter((invoice) => invoice.type === 'schluss')).toHaveLength(0);
  });

  it('F3: 300 in der Frist, 166,48 danach — gesperrt; mit dem Rest voll bezahlt und ohne Skonto', () => {
    const teil = abschlag({ payments: [zahlung('p1', 300, '2026-09-05'), zahlung('p2', 166.48, '2026-09-25')] });
    expect(finalizeInvoiceDraft(VORGANG_ID, prepare(teil), testSetup).ok).toBe(false);
    const voll = abschlag({ payments: [...(teil.payments ?? []), zahlung('p3', 9.52, '2026-09-26')] });
    const result = finalizeInvoiceDraft(VORGANG_ID, prepare(voll), testSetup);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.previousAbschlagDeductions).toEqual([abzug({ paidAmount: 476, skontoAmount: 0 })]);
  });

  it('F4: die Vorschau zeigt die Aufteilung nur für fristgerecht beglichene Abschläge', () => {
    const vorschau = (ab: VorgangInvoice) => liveSettlementShareOf(() => ab)(abzug());
    expect(vorschau(abschlag({ payments: [zahlung('p1', 466.48, '2026-09-05')] }))).toEqual({ paid: 466.48, skonto: 9.52 });
    expect(vorschau(abschlag({ payments: [zahlung('p1', 466.48, '2026-09-25')] }))).toBeNull();
    expect(vorschau(abschlag({ payments: [zahlung('p1', 476, '2026-09-25')] }))).toEqual({ paid: 476, skonto: 0 });
    expect(vorschau(abschlag())).toBeNull();
  });
});

describe('N02-R1 P/K — PDF und Korrekturbeleg', () => {
  beforeEach(() => {
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore(COMPANY);
    hydrateVorgangStore([createTestVorgang()]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('P1: das PDF setzt den gezahlten Teil ab und nennt das Skonto als eigene Zeile', async () => {
    const gezeichnet: string[] = [];
    const original = PDFPage.prototype.drawText;
    vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text, options) {
      gezeichnet.push(String(text));
      return original.call(this, text, options);
    });
    const result = await generateApprovedInvoicePdf(schluss());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const text = gezeichnet.join('\n');
    expect(text).toContain('Abschlag 1 (2026-0017), gezahlt: -466,48 € (netto 392,00 €, USt 74,48 €)');
    expect(text).toContain('Skonto auf Abschlag 1 (2026-0017): -9,52 € (netto 8,00 €, USt 1,52 €)');
    expect(text).toContain('Bereits berechnet: 476,00 € (netto 400,00 €, USt 76,00 €)');
    expect(text).toContain('Fälliger Betrag: 297,50 €');
  });

  it('K1: der Korrekturbeleg bucht gezahlt und Skonto gegen', () => {
    const korrektur = buildInvoiceCorrectionModel(schluss(), { cancelledAt: '2026-10-05T10:00:00.000Z', cancelReason: 'Test' });
    expect(korrektur.summary.deductionLines[0]).toMatchObject({ amount: -466.48, paidPart: true });
    expect(korrektur.summary.skontoLines?.[0]).toMatchObject({ amount: -9.52 });
    expect(korrektur.summary).toMatchObject({ deductionsTotal: -476, deductionsPaidTotal: -466.48, skontoTotal: -9.52 });
  });
});

describe('N02-R1 X — E-Rechnung im Schema', () => {
  it('X1: Nachlass vor den Zahlungsbedingungen, BT-107 und BT-114 an ihrer Stelle — in XRechnung und ZUGFeRD', () => {
    for (const [deduction, rundung] of [
      [abzug({ paidAmount: 466.48, skontoAmount: 9.52 }), false],
      [abzug({ paidAmount: 468.83, skontoAmount: 7.17 }), true],
    ] as const) {
      const invoice = schluss(deduction);
      const canonical = buildCanonicalEInvoice(invoice, {
        prepaymentSettlements: [{ invoiceId: 'inv-ab-1', paid: deduction.paidAmount!, skonto: deduction.skontoAmount!, settled: true }],
      });
      expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
      if (!canonical.ok) return;
      for (const rendered of [renderXRechnungCii(canonical.value), renderZugferdEn16931Cii(canonical.value)]) {
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) continue;
        const xml = rendered.xml;
        const pos = (needle: string) => xml.indexOf(needle);
        expect(pos('<ram:SpecifiedTradeAllowanceCharge>')).toBeGreaterThan(pos('</ram:BillingSpecifiedPeriod>'));
        expect(pos('<ram:SpecifiedTradeAllowanceCharge>')).toBeLessThan(pos('<ram:SpecifiedTradePaymentTerms>'));
        expect(xml).toMatch(/<ram:ChargeIndicator>\s*<udt:Indicator>false<\/udt:Indicator>\s*<\/ram:ChargeIndicator>/);
        expect(xml).toContain('<ram:ReasonCode>95</ram:ReasonCode>');
        expect(xml).toContain('<ram:Reason>Skonto auf Abschlag 1 (Rechnung 2026-0017)</ram:Reason>');
        const summen = ['<ram:LineTotalAmount>650.00', '<ram:AllowanceTotalAmount>', '<ram:TaxBasisTotalAmount>', '<ram:TaxTotalAmount', '<ram:GrandTotalAmount>', '<ram:TotalPrepaidAmount>', '<ram:DuePayableAmount>297.50'];
        const stellen = summen.map((needle) => xml.lastIndexOf(needle));
        expect(stellen.every((stelle) => stelle > 0), JSON.stringify(stellen)).toBe(true);
        expect([...stellen].sort((a, b) => a - b)).toEqual(stellen);
        if (rundung) {
          expect(xml.indexOf('<ram:RoundingAmount>')).toBeGreaterThan(xml.lastIndexOf('<ram:TaxTotalAmount'));
          expect(xml.indexOf('<ram:RoundingAmount>')).toBeLessThan(xml.indexOf('<ram:GrandTotalAmount>'));
        } else {
          expect(xml).not.toContain('<ram:RoundingAmount>');
        }
      }
    }
  });
});

describe('N02-R1 V/S — Prüfer und Serverabweisungen', () => {
  it('V1: der Cloud-Prüfer nimmt die Aufteilung nur vollständig an', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(schluss());
    expect(validateWorkspaceInvoiceCloudPayload(payload).ok).toBe(true);
    const unvollstaendig = {
      ...payload,
      previousAbschlagDeductions: [{ ...abzug(), paidAmount: 466.48 }],
    };
    const result = validateWorkspaceInvoiceCloudPayload(unvollstaendig);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('settlement:incomplete');
  });

  it('S1: „Aufteilung passt nicht" und „Skonto nach Fristablauf" haben eigene Texte', () => {
    const message = 'invoice_abschlag_settlement_mismatch';
    expect(serverRejectionMessageKey(`ERROR: ${message}`)).toBe('invoice.approve.abschlagSettlementMismatch');
    expect(classifyInvoiceCloudErrorForTests({ message, code: 'P0001' }).code).toBe('totals_mismatch');
    expect(t('invoice.approve.abschlagSettlementMismatch')).toContain('gezahlt und Skonto');
    expect(t('invoice.approve.abschlagUnpaid')).toContain('Skontofrist');
    expect(t('invoice.validation.abschlagUnpaid')).toContain('Skontofrist');
  });
});
