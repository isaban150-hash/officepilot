/**
 * FINANZ-CORE-01A (AUS-18) — ZUGFeRD (EN 16931) erbt die XRechnung-Pflichten nicht mehr.
 *
 * Bisher baute der ZUGFeRD-Weg das kanonische Modell mit denselben Pflichten wie die
 * XRechnung: Käuferreferenz (BR-DE-15), Ansprechpartner mit Telefon und E-Mail
 * (BR-DE-2/5/6/7) und beide elektronischen Adressen. EN 16931 verlangt keine davon —
 * ein Betrieb ohne Käuferreferenz bekam trotzdem kein ZUGFeRD.
 *
 *  P1  Profil `xrechnung` meldet die vier Angaben, Profil `en16931` baut ohne sie
 *  P2  EN 16931 bleibt EN 16931: Verkäuferkennung (BR-CO-26), Anschrift, IBAN, § 13b
 *  P3  ein Teilkontakt (nur Telefon) erscheint genau so, nichts wird ergänzt
 *  P4  das ZUGFeRD-XML ohne diese Angaben: kein leeres Element
 *  P5  vollständige Belege: das ZUGFeRD-XML ist in beiden Profilen byte-gleich
 *  P6  der XRechnung-Renderer weist ein Modell ohne Pflichtangaben ab
 *  P7  das hybride Dokument entsteht (PDF/A-3U mit eingebettetem XML)
 *  P8  die Meldungen nennen jetzt ausdrücklich die XRechnung
 *
 * Mit FC01A_EINVOICE_EXPORT=<Verzeichnis> schreibt P7 die Dokumente für die externe
 * Prüfung (Mustang) heraus; ohne die Variable wird nichts geschrieben.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildCanonicalEInvoice } from '../canonicalEInvoiceBuilder';
import type { CanonicalEInvoiceProfile } from '../canonicalEInvoice';
import { describeCanonicalIssue } from '../einvoiceIssueText';
import { renderXRechnungCii } from '../xrechnungCiiRenderer';
import { renderZugferdEn16931Cii } from './zugferdEn16931Renderer';
import { buildZugferdInvoice } from './zugferdArtifactService';
import type {
  CompanyProfile,
  CustomerBilling,
  TaxStatus,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../../types/models';
import { alsInhaber } from '../../../test/workspaceRoleTestUtils';

// SYS-04 (systemische Gesamtnacharbeit): Bei eingerichteter Cloud gibt eine unbekannte Sitzung keine Rechnung mehr aus.
// Diese Tests prüfen Inhalte der Ausgabe und laufen deshalb ausdrücklich als Inhaber (auch nach restoreAllMocks).
beforeEach(() => alsInhaber());

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
  return {
    id: 'p1',
    description: 'Wartung',
    quantity: 2,
    unit: 'Stunden',
    unitPrice: 80,
    lineTotal: 160,
    ...o,
  } as VorgangInvoiceLine;
}

function invoice(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  const positions = o.positions ?? [line()];
  const subtotal = o.subtotal ?? positions.reduce((s, p) => s + p.lineTotal, 0);
  const st: TaxStatus = o.taxStatus ?? 'standard_19';
  const rate = st === 'standard_19' ? 19 : st === 'standard_7' ? 7 : 0;
  const amount = o.amount ?? Math.round(subtotal * (100 + rate)) / 100;
  return {
    id: 'inv-aus18',
    number: '2026-0418',
    type: 'rechnung',
    positions,
    subtotal,
    taxStatus: st,
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
    currencyCode: 'EUR',
    customerSnapshot: { ...BUYER },
    companySnapshot: { ...SELLER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...o,
  } as unknown as VorgangInvoice;
}

/** Ein Beleg ohne die vier XRechnung-Angaben — für EN 16931 vollständig. */
const SCHLANK = invoice({
  customerSnapshot: { ...BUYER, buyerReference: '', email: '', contactPerson: '' },
  companySnapshot: { ...SELLER, contactPerson: '', phone: '', email: '' } as CompanyProfile,
});

/** Nur eine Telefonnummer, kein Ansprechpartner. */
const TEILKONTAKT = invoice({
  customerSnapshot: { ...BUYER, buyerReference: '' },
  companySnapshot: { ...SELLER, contactPerson: '' } as CompanyProfile,
});

const codes = (result: ReturnType<typeof buildCanonicalEInvoice>) => (result.ok ? [] : result.issues.map((i) => i.code));

function zugferdXml(value: VorgangInvoice, profile: CanonicalEInvoiceProfile): string {
  const canonical = buildCanonicalEInvoice(value, { profile });
  expect(canonical.ok, JSON.stringify(codes(canonical))).toBe(true);
  if (!canonical.ok) throw new Error('canonical');
  const rendered = renderZugferdEn16931Cii(canonical.value);
  expect(rendered.ok, rendered.ok ? '' : JSON.stringify(rendered.issues)).toBe(true);
  if (!rendered.ok) throw new Error('render');
  return rendered.xml;
}

/** Der Abschnitt eines Elements (erstes Vorkommen) — für Aussagen je Partei. */
function abschnitt(xml: string, element: string): string {
  const start = xml.indexOf(`<${element}>`);
  const end = xml.indexOf(`</${element}>`);
  expect(start, element).toBeGreaterThanOrEqual(0);
  return xml.slice(start, end);
}

describe('AUS-18 — Profil des Builders', () => {
  it('P1: XRechnung meldet die vier Angaben, EN 16931 baut ohne sie', () => {
    expect(codes(buildCanonicalEInvoice(SCHLANK))).toEqual(
      expect.arrayContaining([
        'seller_electronic_address_missing',
        'seller_contact_missing',
        'buyer_electronic_address_missing',
        'buyer_reference_missing',
      ]),
    );
    // Der Standard bleibt die strengere Prüfung.
    expect(codes(buildCanonicalEInvoice(SCHLANK, { profile: 'xrechnung' }))).toEqual(
      codes(buildCanonicalEInvoice(SCHLANK)),
    );

    const en = buildCanonicalEInvoice(SCHLANK, { profile: 'en16931' });
    expect(en.ok, JSON.stringify(codes(en))).toBe(true);
    if (!en.ok) return;
    expect(en.value.seller.electronicAddress).toBeUndefined();
    expect(en.value.seller.contact).toBeUndefined();
    expect(en.value.buyer.electronicAddress).toBeUndefined();
    expect(en.value.buyer.buyerReference).toBeUndefined();
    // Nichts wird aus anderen Feldern ergänzt.
    expect(JSON.stringify(en.value.buyer)).not.toContain('2026-0418');
  });

  it('P2: EN 16931 bleibt EN 16931 — Kennung, Anschrift, IBAN und § 13b gelten weiter', () => {
    const ohneKennung = invoice({
      companySnapshot: { ...SELLER, vatId: '', registrationNumber: '' } as CompanyProfile,
    });
    expect(codes(buildCanonicalEInvoice(ohneKennung, { profile: 'en16931' }))).toContain('seller_identifier_missing');

    const ohneAnschrift = invoice({ customerSnapshot: { ...BUYER, street: '' } });
    expect(codes(buildCanonicalEInvoice(ohneAnschrift, { profile: 'en16931' }))).toContain('buyer_address_incomplete');

    const ohneIban = invoice({ companySnapshot: { ...SELLER, iban: '' } as CompanyProfile });
    expect(codes(buildCanonicalEInvoice(ohneIban, { profile: 'en16931' }))).toContain('payment_iban_missing');

    const reverseCharge = invoice({
      taxStatus: 'reverse_charge_13b',
      customerSnapshot: { ...BUYER, vatId: '' },
      legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).'],
    } as Partial<VorgangInvoice>);
    expect(codes(buildCanonicalEInvoice(reverseCharge, { profile: 'en16931' }))).toContain(
      'buyer_vat_id_missing_for_reverse_charge',
    );
  });

  it('P3: ein Teilkontakt erscheint genau so — Telefon und E-Mail, kein erfundener Name', () => {
    const en = buildCanonicalEInvoice(TEILKONTAKT, { profile: 'en16931' });
    expect(en.ok, JSON.stringify(codes(en))).toBe(true);
    if (!en.ok) return;
    expect(en.value.seller.contact).toEqual({ phone: '0201 999999', email: 'buero@cirmak.invalid' });

    const seller = abschnitt(zugferdXml(TEILKONTAKT, 'en16931'), 'ram:SellerTradeParty');
    expect(seller).toContain('<ram:DefinedTradeContact>');
    expect(seller).not.toContain('<ram:PersonName>');
    expect(seller).toContain('<ram:CompleteNumber>0201 999999</ram:CompleteNumber>');
    expect(seller).toContain('<ram:URIID>buero@cirmak.invalid</ram:URIID>');

    // Für die XRechnung bleibt der unvollständige Kontakt ein Befund.
    expect(codes(buildCanonicalEInvoice(TEILKONTAKT))).toContain('seller_contact_missing');
  });
});

describe('AUS-18 — Renderer', () => {
  it('P4: das ZUGFeRD-XML ohne die Angaben enthält kein leeres Element', () => {
    const xml = zugferdXml(SCHLANK, 'en16931');
    expect(xml).not.toContain('<ram:BuyerReference');
    expect(xml).not.toContain('<ram:URIUniversalCommunication');
    expect(abschnitt(xml, 'ram:SellerTradeParty')).not.toContain('<ram:DefinedTradeContact');
    expect(abschnitt(xml, 'ram:BuyerTradeParty')).not.toContain('<ram:DefinedTradeContact');
    // Kein Element ohne Inhalt.
    expect(xml).not.toMatch(/<ram:[A-Za-z]+\/>/);
    expect(xml).not.toMatch(/<ram:([A-Za-z]+)><\/ram:\1>/);
    // Was der Beleg trägt, steht weiter da.
    expect(xml).toContain('<ram:Name>AZ Testbau GmbH</ram:Name>');
    expect(xml).toContain('schemeID="VA">DE111111111</ram:ID>');
  });

  it('P5: vollständige Belege — das ZUGFeRD-XML ist in beiden Profilen byte-gleich', () => {
    for (const value of [
      invoice(),
      invoice({ taxStatus: 'kleinunternehmer_19', amount: 160, legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'] } as Partial<VorgangInvoice>),
      invoice({ customerSnapshot: { ...BUYER, leitwegId: '04011000-12345-67' } }),
    ]) {
      expect(zugferdXml(value, 'en16931')).toBe(zugferdXml(value, 'xrechnung'));
    }
  });

  it('P6: der XRechnung-Renderer weist ein Modell ohne Pflichtangaben ab', () => {
    const en = buildCanonicalEInvoice(SCHLANK, { profile: 'en16931' });
    expect(en.ok).toBe(true);
    if (!en.ok) return;
    const rendered = renderXRechnungCii(en.value);
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.issues[0]?.code).toBe('xml_value_invalid');
    expect(rendered.issues[0]?.detail).toMatch(/^xrechnung_required_missing:/);

    // Ein vollständiger Beleg rendert als XRechnung wie bisher.
    const voll = buildCanonicalEInvoice(invoice(), { profile: 'xrechnung' });
    expect(voll.ok && renderXRechnungCii(voll.value).ok).toBe(true);
  });
});

describe('AUS-18 — hybrides Dokument und Meldungen', () => {
  it('P7: ZUGFeRD entsteht ohne Käuferreferenz, Käufer-E-Mail und Ansprechpartner', async () => {
    const built = await buildZugferdInvoice(SCHLANK);
    expect(built.ok, built.ok ? '' : JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    expect(built.artifact.byteSize).toBeGreaterThan(1000);
    expect(built.artifact.xml).not.toContain('<ram:BuyerReference');
    expect(built.artifact.xml).not.toContain('<ram:URIUniversalCommunication');

    const teil = await buildZugferdInvoice(TEILKONTAKT);
    expect(teil.ok, teil.ok ? '' : JSON.stringify(teil)).toBe(true);
    const voll = await buildZugferdInvoice(invoice());
    expect(voll.ok, voll.ok ? '' : JSON.stringify(voll)).toBe(true);

    const ziel = process.env.FC01A_EINVOICE_EXPORT;
    if (ziel && built.ok && teil.ok && voll.ok) {
      mkdirSync(ziel, { recursive: true });
      writeFileSync(path.join(ziel, 'zugferd-aus18-schlank.pdf'), built.artifact.bytes);
      writeFileSync(path.join(ziel, 'zugferd-aus18-schlank.xml'), built.artifact.xml);
      writeFileSync(path.join(ziel, 'zugferd-aus18-teilkontakt.pdf'), teil.artifact.bytes);
      writeFileSync(path.join(ziel, 'zugferd-aus18-voll.pdf'), voll.artifact.bytes);
    }
  });

  it('P8: die vier Meldungen nennen die XRechnung', () => {
    for (const code of [
      'seller_electronic_address_missing',
      'seller_contact_missing',
      'buyer_electronic_address_missing',
      'buyer_reference_missing',
    ] as const) {
      expect(describeCanonicalIssue({ code, path: 'x', severity: 'error' })).toContain('XRechnung');
    }
    // Allgemeine Befunde bleiben allgemein.
    expect(describeCanonicalIssue({ code: 'seller_identifier_missing', path: 'x', severity: 'error' })).toContain(
      'E-Rechnung',
    );
  });
});
