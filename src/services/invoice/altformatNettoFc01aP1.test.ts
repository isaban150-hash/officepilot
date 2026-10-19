/**
 * FC01A-P1-Restkorrektur (#8, Altformat) — Netto und Umsatzsteuer abgezogener Abschläge.
 *
 * WEISS-Recheck zu Bericht 13: Ein umsatzsteuerpflichtiger Altabschlag ohne gespeichertes Netto
 * (`subtotal`) galt in der gemeinsamen Aufteilung als „netto = brutto“. Aus 400,00 netto /
 * 476,00 brutto mit 9,52 Skonto wurde „466,48 EUR gezahlt (netto 468,00 EUR, USt −1,52 EUR)“
 * statt netto 392,00 / USt 74,48.
 *
 *  S   Aufteilung (`splitAbschlagDeductions`, `reliableDeductionNetCents`): nie Brutto als Netto;
 *      steuerfrei ohne Netto = Brutto; widersprüchlich = unbekannt; Cent-Rundung, 7 %.
 *  E   XRechnung und ZUGFeRD: kein Beleg mit unbekanntem Netto, Befund `prepayment_net_unreliable`.
 *  P   PDF/Druck: keine erfundenen Netto-/Steuerwerte, Skonto-Zeile unverändert richtig.
 *  X   Steuerberaterexport: kein Brutto als Netto, Ersatzrechnung mit Prüfhinweis.
 *  V   Freigabe: lokale Sperre `abschlag_net_unreliable`, Serverabweisung mit Text.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reliableDeductionNetCents, splitAbschlagDeductions, frozenSettlementShare } from './abschlagSkontoSplit';
import * as invoiceRegistry from './invoiceRegistryService';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { buildCanonicalEInvoice } from '../einvoice/canonicalEInvoiceBuilder';
import { prepaymentSettlementsFor } from '../einvoice/einvoicePrepaymentSettlements';
import { renderXRechnungCii } from '../einvoice/xrechnungCiiRenderer';
import { describeCanonicalIssue } from '../einvoice/einvoiceIssueText';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { hasUnreliableAbschlagNet, validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { buildSchlussrechnungDraft } from '../invoiceService';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { bg, de, t, tr } from '../../i18n';
import type { AbschlagDeduction, CompanyProfile, CustomerBilling, VorgangInvoice, VorgangInvoiceLine } from '../../types/models';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';

// SYS-04 (systemische Gesamtnacharbeit): Bei eingerichteter Cloud gibt eine unbekannte Sitzung keine Rechnung mehr aus.
// Diese Tests prüfen Inhalte der Ausgabe und laufen deshalb ausdrücklich als Inhaber (auch nach restoreAllMocks).
beforeEach(() => alsInhaber());

const SKONTO = '2 % Skonto bei Zahlung innerhalb von 10 Tagen';
const RC_HINWEIS = 'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.';
const KU_HINWEIS = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.';

/* ------------------------------------------------------------------ Belege (wie einvoiceFachabschlussFc01a) */
const SELLER = {
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
  iban: 'DE89370400440532013000',
  bic: 'WELADED1ESN',
  accountHolder: 'Cirmak Haustechnik GmbH',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
  invoiceFooterNotes: '',
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

function beleg(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-p1alt',
    number: '2026-0091',
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

function zahlung(id: string, amount: number, date: string) {
  return { id, amount, date, createdAt: `${date}T09:00:00.000Z` };
}

function abschlag(id: string, number: string, o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return beleg({ id, number, type: 'abschlag', status: 'versendet', issueDate: '2026-08-01', date: '2026-08-01', positions: [], subtotal: 400, amount: 476, ...o });
}

/* Der Altabschlag aus WEISS' Nachstellung: 400/476 bei 19 %, fristgerecht 466,48 + 9,52 Skonto — ohne gespeichertes Netto. */
const ALT_19 = abschlag('alt19', '2026-0081', {
  subtotal: undefined as unknown as number,
  skontoText: SKONTO,
  payments: [zahlung('p-alt19', 466.48, '2026-08-05')],
});
const NEU_19 = abschlag('neu19', '2026-0082', { skontoText: SKONTO, payments: [zahlung('p-neu19', 466.48, '2026-08-05')] });
const ALT_19_VOLL = abschlag('alt19v', '2026-0083', { subtotal: undefined as unknown as number, payments: [zahlung('p-alt19v', 476, '2026-08-05')] });
const ALT_13B = abschlag('alt13b', '2026-0084', {
  subtotal: undefined as unknown as number,
  taxStatus: 'reverse_charge_13b',
  amount: 400,
  legalNotices: [RC_HINWEIS],
  skontoText: SKONTO,
  payments: [zahlung('p-alt13b', 392, '2026-08-05')],
});
const ALT_KU = abschlag('altku', '2026-0085', {
  subtotal: undefined as unknown as number,
  taxStatus: 'kleinunternehmer_19',
  amount: 400,
  legalNotices: [KU_HINWEIS],
  payments: [zahlung('p-altku', 400, '2026-08-05')],
});
const RUNDUNG_19 = abschlag('r19', '2026-0086', {
  subtotal: 333.33,
  amount: 396.66,
  skontoText: SKONTO,
  payments: [zahlung('p-r19', 388.73, '2026-08-05')],
});
const ABSCHLAEGE: Record<string, VorgangInvoice> = Object.fromEntries(
  [ALT_19, NEU_19, ALT_19_VOLL, ALT_13B, ALT_KU, RUNDUNG_19].map((a) => [a.id, a]),
);

/** Ein Abzug, wie ihn die Freigabe einfriert: Angaben des Abschlags (fehlt dort das Netto, fehlt es hier). */
function abzug(a: VorgangInvoice, paid?: number, skonto?: number): AbschlagDeduction {
  return {
    invoiceId: a.id,
    invoiceNumber: a.number,
    abschlagNumber: 1,
    date: '2026-08-01',
    ...(Number.isFinite(a.subtotal) ? { subtotal: a.subtotal } : {}),
    amount: a.amount,
    ...(paid !== undefined ? { paidAmount: paid, skontoAmount: skonto ?? 0 } : {}),
  } as AbschlagDeduction;
}

const SCHLUSS_ALT_19 = beleg({ id: 'inv-s-alt19', number: '2026-0101', type: 'schluss', amount: 714, previousAbschlagDeductions: [abzug(ALT_19, 466.48, 9.52)] });
const SCHLUSS_NEU_19 = beleg({ id: 'inv-s-neu19', number: '2026-0102', type: 'schluss', amount: 714, previousAbschlagDeductions: [abzug(NEU_19, 466.48, 9.52)] });
const SCHLUSS_ALT_19_VOLL = beleg({ id: 'inv-s-alt19v', number: '2026-0103', type: 'schluss', amount: 714, previousAbschlagDeductions: [abzug(ALT_19_VOLL)] });
const SCHLUSS_ALT_13B = beleg({
  id: 'inv-s-alt13b', number: '2026-0104', type: 'schluss', taxStatus: 'reverse_charge_13b', amount: 600, legalNotices: [RC_HINWEIS],
  previousAbschlagDeductions: [abzug(ALT_13B, 392, 8)],
});
const SCHLUSS_ALT_KU = beleg({
  id: 'inv-s-altku', number: '2026-0105', type: 'schluss', taxStatus: 'kleinunternehmer_19', amount: 600, legalNotices: [KU_HINWEIS],
  previousAbschlagDeductions: [abzug(ALT_KU)],
});
const SCHLUSS_RUNDUNG_19 = beleg({
  id: 'inv-s-r19', number: '2026-0106', type: 'schluss', amount: 793.34, previousAbschlagDeductions: [abzug(RUNDUNG_19, 388.73, 7.93)],
});

beforeEach(() => {
  vi.spyOn(invoiceRegistry, 'findInvoiceById').mockImplementation((invoiceId: string) => ABSCHLAEGE[invoiceId]);
});
afterEach(() => (vi.restoreAllMocks(), alsInhaber()));

/* ------------------------------------------------------------------ S Aufteilung */
describe('FC01A-P1-Restkorrektur S — die gemeinsame Aufteilung', () => {
  const split19 = (d: AbschlagDeduction) => splitAbschlagDeductions([d], { subtotalNet: 1000, taxRate: 19 }, frozenSettlementShare);

  it('S1 WEISS: 19 %, Skonto, Altabschlag ohne Netto — Netto unbekannt, nie 468,00/−1,52', () => {
    const split = split19(abzug(ALT_19, 466.48, 9.52));
    expect(split.netReliable).toBe(false);
    expect(split.parts[0]).toMatchObject({ billed: 476, billedNet: null, paid: 466.48, paidNet: null, paidTax: null, skonto: 9.52, skontoNet: 8, skontoTax: 1.52 });
  });

  it('S2 mit gespeichertem Netto die erwartete Aufteilung: gezahlt 392,00 + 74,48, Skonto 8,00 + 1,52', () => {
    const split = split19(abzug(NEU_19, 466.48, 9.52));
    expect(split.netReliable).toBe(true);
    expect(split.parts[0]).toMatchObject({ billedNet: 400, paidNet: 392, paidTax: 74.48, skontoNet: 8, skontoTax: 1.52 });
  });

  it('S3 ohne Skonto: auch der voll bezahlte Altabschlag mit Umsatzsteuer hat kein verlässliches Netto', () => {
    const split = split19(abzug(ALT_19_VOLL));
    expect(split.netReliable).toBe(false);
    expect(split.parts[0]).toMatchObject({ billed: 476, billedNet: null, paidNet: null, paidTax: null });
  });

  it('S4 ohne Umsatzsteuer (§ 13b, § 19) ist Netto = Brutto, auch mit Skonto', () => {
    const rc = splitAbschlagDeductions([abzug(ALT_13B, 392, 8)], { subtotalNet: 1000, taxRate: 0 }, frozenSettlementShare);
    expect(rc.netReliable).toBe(true);
    expect(rc.parts[0]).toMatchObject({ billedNet: 400, paidNet: 392, paidTax: 0, skontoNet: 8, skontoTax: 0 });
    expect(reliableDeductionNetCents(abzug(ALT_KU), 0)).toBe(40000);
  });

  it('S5 widersprüchlich: Netto passt nicht zum Satz → unbekannt (19 % und ohne Umsatzsteuer)', () => {
    expect(reliableDeductionNetCents({ ...abzug(NEU_19), subtotal: 390 }, 19)).toBeNull();
    expect(reliableDeductionNetCents({ ...abzug(ALT_KU), subtotal: 336.13 }, 0)).toBeNull();
    // Derselbe Abzug zum falschen Satz (Abschlag 19 %, Beleg 7 %) passt ebenfalls nicht.
    expect(reliableDeductionNetCents(abzug(NEU_19), 7)).toBeNull();
  });

  it('S6 Cent-Rundung: 333,33 / 396,66 bei 19 % passt; mit Skonto gehen Netto und Steuer auf den Cent auf', () => {
    expect(reliableDeductionNetCents(abzug(RUNDUNG_19), 19)).toBe(33333);
    expect(reliableDeductionNetCents({ ...abzug(RUNDUNG_19), subtotal: 333.34 }, 19)).toBeNull();
    const split = splitAbschlagDeductions([abzug(RUNDUNG_19, 388.73, 7.93)], { subtotalNet: 1000, taxRate: 19 }, frozenSettlementShare);
    const p = split.parts[0]!;
    expect(split.netReliable).toBe(true);
    expect(Math.round((p.paidNet! + p.skontoNet) * 100)).toBe(33333);
    expect(Math.round((p.paidTax! + p.skontoTax) * 100)).toBe(6333);
    expect(Math.round((p.paidNet! + p.paidTax!) * 100)).toBe(38873);
  });

  it('S7 7 %: 100 / 107 passt, ohne Netto unbekannt', () => {
    expect(reliableDeductionNetCents({ ...abzug(NEU_19), subtotal: 100, amount: 107 }, 7)).toBe(10000);
    expect(reliableDeductionNetCents({ ...abzug(ALT_19_VOLL), amount: 107 }, 7)).toBeNull();
  });
});

/* ------------------------------------------------------------------ E XRechnung / ZUGFeRD */
describe('FC01A-P1-Restkorrektur E — XRechnung und ZUGFeRD', () => {
  it('E1 WEISS-Fall: keine XRechnung und kein ZUGFeRD, Befund prepayment_net_unreliable mit Text', async () => {
    const { buildZugferdInvoice } = await import('../einvoice/zugferd/zugferdArtifactService');
    const canonical = buildCanonicalEInvoice(SCHLUSS_ALT_19, { prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS_ALT_19) });
    expect(canonical.ok).toBe(false);
    if (canonical.ok) return;
    const befund = canonical.issues.find((issue) => issue.code === 'prepayment_net_unreliable');
    expect(befund?.path).toBe('previousAbschlagDeductions[0]');
    expect(describeCanonicalIssue(befund!)).toContain('nicht verlässlich gespeichert');
    const hybrid = await buildZugferdInvoice(SCHLUSS_ALT_19);
    expect(hybrid.ok).toBe(false);
    if (!hybrid.ok && hybrid.reason === 'canonical_incomplete') {
      expect(hybrid.issues.map((issue) => issue.code)).toContain('prepayment_net_unreliable');
    } else {
      throw new Error(`unerwartet: ${JSON.stringify(hybrid)}`);
    }
  });

  it('E2 ohne Skonto ebenso gesperrt (die Steuer der Vorauszahlung wäre nicht ausweisbar)', () => {
    const canonical = buildCanonicalEInvoice(SCHLUSS_ALT_19_VOLL, { prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS_ALT_19_VOLL) });
    expect(canonical.ok).toBe(false);
    if (!canonical.ok) expect(canonical.issues.map((issue) => issue.code)).toContain('prepayment_net_unreliable');
  });

  it('E3 mit gespeichertem Netto: die Notiz nennt 392,00 / 74,48, die XRechnung entsteht', () => {
    const canonical = buildCanonicalEInvoice(SCHLUSS_NEU_19, { prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS_NEU_19) });
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (!canonical.ok) return;
    const notiz = canonical.value.notes.join(' | ');
    expect(notiz).toContain('466,48 EUR gezahlt (netto 392,00 EUR, USt 74,48 EUR) von 476,00 EUR brutto');
    expect(notiz).not.toContain('468,00');
    expect(notiz).not.toContain('-1,52');
    const xml = renderXRechnungCii(canonical.value);
    expect(xml.ok).toBe(true);
    if (xml.ok) expect(xml.xml).toContain('<ram:TotalPrepaidAmount>466.48</ram:TotalPrepaidAmount>');
  });

  it('E4 steuerfreie Altabschläge ohne Netto bleiben exportierbar (§ 13b mit Skonto, § 19)', () => {
    for (const s of [SCHLUSS_ALT_13B, SCHLUSS_ALT_KU]) {
      const canonical = buildCanonicalEInvoice(s, { prepaymentSettlements: prepaymentSettlementsFor(s) });
      expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    }
  });

  it('E5 Cent-Rundung 333,33 / 396,66 mit Skonto: XRechnung entsteht, Notiz geht auf den Cent auf', () => {
    const canonical = buildCanonicalEInvoice(SCHLUSS_RUNDUNG_19, { prepaymentSettlements: prepaymentSettlementsFor(SCHLUSS_RUNDUNG_19) });
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (canonical.ok) expect(canonical.value.notes.join(' | ')).toMatch(/388,73 EUR gezahlt \(netto \d+,\d\d EUR, USt \d+,\d\d EUR\)/);
  });

  /* Nachweis-Export für KoSIT und Mustang; läuft nur mit gesetztem FC01A_EINVOICE_OUT. */
  it.skipIf(!process.env.FC01A_EINVOICE_OUT)('EX schreibt die Altformat-Fälle für KoSIT und Mustang', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { buildZugferdInvoice } = await import('../einvoice/zugferd/zugferdArtifactService');
    const ziel = process.env.FC01A_EINVOICE_OUT!;
    mkdirSync(ziel, { recursive: true });
    for (const [name, s] of [
      ['p1alt-19-skonto-mit-netto', SCHLUSS_NEU_19],
      ['p1alt-19-skonto-rundung', SCHLUSS_RUNDUNG_19],
      ['p1alt-13b-skonto-ohne-netto', SCHLUSS_ALT_13B],
      ['p1alt-kleinunternehmer-ohne-netto', SCHLUSS_ALT_KU],
    ] as const) {
      const canonical = buildCanonicalEInvoice(s, { prepaymentSettlements: prepaymentSettlementsFor(s) });
      expect(canonical.ok).toBe(true);
      if (!canonical.ok) continue;
      const rendered = renderXRechnungCii(canonical.value);
      expect(rendered.ok).toBe(true);
      if (rendered.ok) writeFileSync(path.join(ziel, `xrechnung-${name}.xml`), rendered.xml, 'utf8');
      const hybrid = await buildZugferdInvoice(s);
      expect(hybrid.ok, hybrid.ok ? '' : JSON.stringify(hybrid)).toBe(true);
      if (hybrid.ok) writeFileSync(path.join(ziel, `zugferd-${name}.pdf`), hybrid.artifact.bytes);
    }
  });
});

/* ------------------------------------------------------------------ P PDF / Druck */
describe('FC01A-P1-Restkorrektur P — PDF und Druckansicht', () => {
  it('P1 WEISS-Fall: gezahlter Teil ohne erfundenes Netto/USt, Skonto-Zeile 8,00 / 1,52', () => {
    const model = buildInvoicePrintModelFromInvoice(SCHLUSS_ALT_19);
    const zeile = model.summary.deductionLines?.[0];
    expect(zeile).toMatchObject({ label: 'Abschlag 1', amount: 466.48, paidPart: true });
    expect(zeile?.netAmount).toBeUndefined();
    expect(zeile?.taxAmount).toBeUndefined();
    expect(model.summary.skontoLines).toEqual([
      { label: 'Skonto auf Abschlag 1', invoiceNumber: '2026-0081', amount: 9.52, netAmount: 8, taxAmount: 1.52 },
    ]);
    expect(model.summary.deductionsNetTotal).toBeUndefined();
    expect(JSON.stringify(model.summary)).not.toContain('468');
  });

  it('P2 mit gespeichertem Netto: 392,00 / 74,48 wie in der E-Rechnung', () => {
    const model = buildInvoicePrintModelFromInvoice(SCHLUSS_NEU_19);
    expect(model.summary.deductionLines?.[0]).toMatchObject({ amount: 466.48, netAmount: 392, taxAmount: 74.48, paidPart: true });
  });

  async function gezeichneterText(s: VorgangInvoice): Promise<string> {
    const { PDFPage } = await import('pdf-lib');
    const { generateApprovedInvoicePdf } = await import('../invoicePdfService');
    const gezeichnet: string[] = [];
    const original = PDFPage.prototype.drawText;
    const spion = vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: InstanceType<typeof PDFPage>, text, options) {
      gezeichnet.push(String(text));
      return original.call(this, text, options);
    });
    const result = await generateApprovedInvoicePdf(s);
    spion.mockRestore();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return gezeichnet.join('\n');
  }

  it('P4 das gerenderte PDF des WEISS-Falls: kein 468,00 und kein −1,52; Skonto 8,00 / 1,52', async () => {
    const text = await gezeichneterText(SCHLUSS_ALT_19);
    expect(text).toContain('466,48');
    expect(text).not.toContain('468,00');
    expect(text).not.toContain('-1,52');
    expect(text).toContain('netto 8,00 €, USt 1,52 €');
  });

  it('P5 das gerenderte PDF mit gespeichertem Netto: netto 392,00 €, USt 74,48 €', async () => {
    const text = await gezeichneterText(SCHLUSS_NEU_19);
    expect(text).toContain('netto 392,00 €, USt 74,48 €');
    expect(text).toContain('netto 8,00 €, USt 1,52 €');
  });

  it('P3 widersprüchliches Netto ohne Skonto: keine Netto-/Steuerangabe statt einer falschen', () => {
    const s = beleg({ type: 'schluss', amount: 714, previousAbschlagDeductions: [{ ...abzug(NEU_19), subtotal: 390 }] });
    const zeile = buildInvoicePrintModelFromInvoice(s).summary.deductionLines?.[0];
    expect(zeile).toMatchObject({ amount: 476 });
    expect(zeile?.netAmount).toBeUndefined();
    expect(zeile?.taxAmount).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ X Steuerberaterexport */
describe('FC01A-P1-Restkorrektur X — Steuerberaterexport', () => {
  function belegZeile(s: VorgangInvoice) {
    const model = buildMonatsmappeModel({ monthKey: '2026-09', invoices: [{ invoice: s, vorgangId: 'v-1' }], expenses: [], documents: [], inboxItems: [], fileRefs: [] });
    return model.ausgangsrechnungen.find((b) => b.id === s.id)!;
  }

  it('X1 mit gespeichertem Netto: netto 600,00, Steuer 114,00 (Rest nach Abzug 400/476)', () => {
    expect(belegZeile(SCHLUSS_NEU_19)).toMatchObject({ netto: 600, steuer: 114, brutto: 714 });
  });

  it('X2 Altabschlag mit Umsatzsteuer ohne Netto: kein Brutto als Netto, Ersatzrechnung mit Prüfhinweis', () => {
    const zeile = belegZeile(SCHLUSS_ALT_19);
    // Bisher: Ersatzrechnung ohne Hinweis. Nie 1000 − 476 = 524 als Netto.
    expect(zeile).toMatchObject({ netto: 600, steuer: 114, brutto: 714 });
    expect(zeile.hinweis).toContain('Bitte prüfen: Netto/USt eines Abschlags sind nicht verlässlich gespeichert');
  });

  it('X3 steuerfreier Altabschlag ohne Netto: Netto = Brutto, kein Prüfhinweis', () => {
    const zeile = belegZeile(SCHLUSS_ALT_KU);
    expect(zeile).toMatchObject({ netto: 600, steuer: 0, brutto: 600 });
    expect(zeile.hinweis).not.toContain('Bitte prüfen');
  });
});

/* ------------------------------------------------------------------ V Freigabe */
describe('FC01A-P1-Restkorrektur V — Freigabe', () => {
  const finde = (id: string) => ABSCHLAEGE[id];

  it('V1 lokale Regel: Umsatzsteuer ohne Netto, unklarer Steuerfall und Widerspruch sperren; steuerfrei nicht', () => {
    expect(hasUnreliableAbschlagNet('standard_19', [abzug(ALT_19, 466.48, 9.52)], finde)).toBe(true);
    expect(hasUnreliableAbschlagNet('standard_19', [abzug(NEU_19, 466.48, 9.52)], finde)).toBe(false);
    expect(hasUnreliableAbschlagNet('standard_19', [{ ...abzug(NEU_19), subtotal: 390 }], finde)).toBe(true);
    expect(hasUnreliableAbschlagNet('reverse_charge_13b', [abzug(ALT_13B, 392, 8)], finde)).toBe(false);
    expect(hasUnreliableAbschlagNet('kleinunternehmer_19', [abzug(ALT_KU)], finde)).toBe(false);
    // Ohne Steuerstatus am Abschlag (Altbestand) oder „unklar": kein verlässliches Netto.
    expect(hasUnreliableAbschlagNet('kleinunternehmer_19', [abzug(ALT_KU)], () => ({ ...ALT_KU, taxStatus: undefined }) as unknown as VorgangInvoice)).toBe(true);
    expect(hasUnreliableAbschlagNet('kleinunternehmer_19', [abzug(ALT_KU)], () => ({ ...ALT_KU, taxStatus: 'unclear' }) as VorgangInvoice)).toBe(true);
  });

  it('V2 die Schlussrechnung zum Altabschlag (19 %) ist im echten Freigabeweg gesperrt', () => {
    const ab = { ...ALT_19_VOLL, id: 'inv-ab-alt', number: '2026-0087', abschlagNumber: 1, calculationMode: 'fixed_amount', fixedAmountNet: 400 } as VorgangInvoice;
    hydrateVorgangStore([createTestVorgang({ orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 10 })], invoices: [ab] })]);
    const entwurf = buildSchlussrechnungDraft('v-test-1', testSetup);
    expect(entwurf).not.toBeNull();
    const draft = { ...entwurf!, taxStatus: 'standard_19' as const, servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-30', servicePeriodConfirmed: true };
    // Bis Bericht 14 ergänzte der lokale Vorgangsspeicher ein fehlendes Netto mit dem Brutto (476);
    // seit der Restkorrektur „lokaler Altbestand“ (Bericht 15) bleibt es fehlend. Beide Male sperrt
    // die Regel: ohne verlässliches Netto bei 19 % kein Abzug.
    expect(draft.previousAbschlagDeductions[0]?.subtotal).toBeUndefined();
    const codes = validateInvoiceDraftForApproval(draft, draft.companySnapshot, getVorgangById('v-test-1'), { reverseCharge13bConfirmed: true })
      .blockingErrors.map((issue) => issue.code);
    expect(codes).toContain('abschlag_net_unreliable');
    expect(t('invoice.validation.abschlagNetUnreliable')).toContain('§ 14 Abs. 5 UStG');
  });

  it('V3 die Serverabweisung hat ihren Text, auch in Türkisch und Bulgarisch', () => {
    const message = 'invoice_abschlag_net_unreliable';
    expect(serverRejectionMessageKey(`ERROR: ${message}`)).toBe('invoice.approve.abschlagNetUnreliable');
    expect(classifyInvoiceCloudErrorForTests({ message, code: 'P0001' }).code).toBe('tax_status_mismatch');
    for (const key of ['invoice.validation.abschlagNetUnreliable', 'invoice.approve.abschlagNetUnreliable'] as const) {
      expect(de[key]).toContain('Netto');
      expect(tr[key]).toBeTruthy();
      expect(bg[key]).toBeTruthy();
    }
  });
});
