/**
 * E-RECHNUNG-04D — der XRechnung-CII-Renderer.
 *
 * Die Goldfiles in `__goldfiles__` sind keine erfundenen Wunschdateien: Es
 * sind genau die Bytes, die der **offizielle KoSIT-Validator 1.6.3** mit der
 * Konfiguration XRechnung 3.0.2 / 2026-08-31 angenommen hat. Weicht der
 * Renderer davon ab, hat sich etwas geändert, das erneut offiziell geprüft
 * werden muss — deshalb der byte-genaue Vergleich statt eines strukturellen.
 *
 * Geprüft wird ausserdem das, was ein Validator nicht sieht: dass zweimal
 * Rendern dieselben Bytes ergibt, dass Freitexte korrekt maskiert werden und
 * dass kein Fall ein XML bekommt, den 04C abgelehnt hat.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCanonicalEInvoice } from './canonicalEInvoiceBuilder';
import { renderXRechnungCii, XRECHNUNG_CII } from './xrechnungCiiRenderer';
import { XRECHNUNG_BINDING_KIND, buildXRechnungFileName } from './xrechnungArtifactService';
import {
  escapeXmlAttribute,
  escapeXmlText,
  formatXmlAmount,
  formatXmlDate102,
  formatXmlQuantity,
} from './einvoiceXmlWriter';
import { EINVOICE_STANDARDS } from './einvoiceStandards';
import type {
  CompanyProfile,
  CustomerBilling,
  TaxStatus,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../types/models';

const GOLD = path.resolve(__dirname, '__goldfiles__');
const gold = (name: string) => readFileSync(path.join(GOLD, `${name}.xml`), 'utf8');
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Dieselben Bausteine, aus denen die geprüften Dateien entstanden sind */
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
  vatId: 'DE987654321',
  buyerReference: 'TEST-BUYER-REF-A',
  leitwegId: 'TEST-LEITWEG-A',
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
    id: 'inv-04d',
    number: '2026-0042',
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

/** Rendert und verlangt Erfolg — der Normalfall in diesen Tests. */
function xml(inv: VorgangInvoice): string {
  const canonical = buildCanonicalEInvoice(inv);
  expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
  if (!canonical.ok) throw new Error('canonical');
  const rendered = renderXRechnungCii(canonical.value);
  expect(rendered.ok, rendered.ok ? '' : JSON.stringify(rendered.issues)).toBe(true);
  if (!rendered.ok) throw new Error('render');
  return rendered.xml;
}

/** Gibt es für diesen Beleg ein XML? Für die Fälle, die keines bekommen dürfen. */
function rendersAtAll(inv: VorgangInvoice): boolean {
  const canonical = buildCanonicalEInvoice(inv);
  if (!canonical.ok) return false;
  return renderXRechnungCii(canonical.value).ok;
}

/* ------------------------------------------------------------------ */

describe('A — die offiziell geprüften Dateien', () => {
  /*
   * Jede dieser Dateien wurde mit dem KoSIT-Validator 1.6.3 und der
   * Konfiguration XRechnung 3.0.2 / 2026-08-31 geprüft und angenommen
   * (XSD, EN16931-CII-Schematron und XRechnung-CIUS-Schematron, alle valid).
   */
  const faelle: Array<[string, () => VorgangInvoice]> = [
    ['01-standard-19', () => invoice()],
    [
      '03-reverse-charge',
      () =>
        invoice({
          taxStatus: 'reverse_charge_13b',
          amount: 160,
          legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
        }),
    ],
    [
      '04-kleinunternehmer',
      () =>
        invoice({
          taxStatus: 'kleinunternehmer_19',
          amount: 160,
          legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
        }),
    ],
    [
      '08-abschlag-pauschal',
      () =>
        invoice({
          type: 'abschlag',
          abschlagNumber: 1,
          number: '2026-0046',
          calculationMode: 'fixed_amount',
          fixedAmountNet: 500,
          positions: [],
          subtotal: 500,
          amount: 595,
        }),
    ],
    [
      '10-korrektur',
      () =>
        invoice({
          number: '2026-0048',
          cancelledAt: '2026-09-25T10:00:00.000Z',
          cancellationKind: 'correction',
          cancelReason: 'Falscher Leistungszeitraum',
        }),
    ],
    [
      '11-sonderzeichen',
      () =>
        invoice({
          number: '2026-0049',
          companySnapshot: { ...SELLER, companyName: 'Çırmak & Söhne <Test>' },
          positions: [
            line({
              description: 'Prüfung & Abdichtung "Flachdach" <Nord> — Ø 12 mm, 100 % dicht',
            }),
          ],
        }),
    ],
  ];

  it.each(faelle)('T17/T18: %s bleibt byte- und prüfwertgleich', (name, build) => {
    const erzeugt = xml(build());
    expect(erzeugt).toBe(gold(name));
    expect(sha256(erzeugt)).toBe(sha256(gold(name)));
  });
});

describe('B — Kennungen und Codes', () => {
  it('die Guideline-Kennung ist die, auf die der Validator sein CII-Szenario auswählt', () => {
    expect(XRECHNUNG_CII.guidelineId).toBe(
      'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
    );
    expect(XRECHNUNG_CII.guidelineId).toContain(EINVOICE_STANDARDS.xrechnung.generation);
    expect(xml(invoice())).toContain(`<ram:ID>${XRECHNUNG_CII.guidelineId}</ram:ID>`);
  });

  it('T1/T20: die Standardrechnung trägt Typ 380 und Kategorie S', () => {
    const out = xml(invoice());
    expect(out).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(out).toContain('<ram:CategoryCode>S</ram:CategoryCode>');
    expect(out).toContain('<ram:RateApplicablePercent>19.00</ram:RateApplicablePercent>');
  });

  it('T2: 7 % bleibt Kategorie S mit anderem Satz', () => {
    const out = xml(invoice({ taxStatus: 'standard_7' }));
    expect(out).toContain('<ram:CategoryCode>S</ram:CategoryCode>');
    expect(out).toContain('<ram:RateApplicablePercent>7.00</ram:RateApplicablePercent>');
  });

  it('T3: §13b wird AE mit Begründung und Käufer-USt-IdNr.', () => {
    const out = xml(
      invoice({
        taxStatus: 'reverse_charge_13b',
        amount: 160,
        legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
      }),
    );
    expect(out).toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
    expect(out).toContain('<ram:ExemptionReason>Steuerschuldnerschaft');
    expect(out).toContain('<ram:ID schemeID="VA">DE987654321</ram:ID>');
  });

  it('T4: Kleinunternehmer wird E mit §-19-Begründung', () => {
    const out = xml(
      invoice({
        taxStatus: 'kleinunternehmer_19',
        amount: 160,
        legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
      }),
    );
    expect(out).toContain('<ram:CategoryCode>E</ram:CategoryCode>');
    expect(out).toContain('<ram:ExemptionReason>Gemäß § 19 UStG');
  });

  it('T22/T23/T25: die Bau-Belegarten bekommen ihre eigenen Codes', () => {
    /*
     * BR-DE-17 lässt neben 380 ausdrücklich 326 (Teilrechnung), 875
     * (Abschlagsrechnung) und 877 (Schlussrechnung) zu. Alle drei auf 380
     * abzubilden wäre zulässig und ärmer — der Empfänger sähe nicht, welche
     * Art Beleg er bekommt.
     */
    expect(xml(invoice({ type: 'teilrechnung' }))).toContain('<ram:TypeCode>326</ram:TypeCode>');
    expect(xml(invoice({ type: 'abschlag', abschlagNumber: 1 }))).toContain(
      '<ram:TypeCode>875</ram:TypeCode>',
    );
    expect(xml(invoice({ type: 'schluss' }))).toContain('<ram:TypeCode>877</ram:TypeCode>');
  });

  it('T27: die Korrektur trägt Typ 384 und die Ursprungsnummer', () => {
    const out = xml(
      invoice({
        number: '2026-0048',
        cancelledAt: '2026-09-25T10:00:00.000Z',
        cancellationKind: 'correction',
        cancelReason: 'Falscher Leistungszeitraum',
      }),
    );
    expect(out).toContain('<ram:TypeCode>384</ram:TypeCode>');
    expect(out).toContain('<ram:IssuerAssignedID>2026-0048</ram:IssuerAssignedID>');
  });

  it('T5/T6/T7/T8: Käuferreferenz, beide Adressen und Währung stehen im XML', () => {
    const out = xml(invoice());
    expect(out).toContain('<ram:BuyerReference>TEST-BUYER-REF-A</ram:BuyerReference>');
    expect(out).toContain('<ram:URIID schemeID="EM">buero@cirmak.invalid</ram:URIID>');
    expect(out).toContain('<ram:URIID schemeID="EM">buero@az-testbau.invalid</ram:URIID>');
    expect(out).toContain('<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>');
    expect(out).toContain('currencyID="EUR"');
  });

  it('T9–T13: die Einheitencodes stehen an der Menge', () => {
    const out = xml(
      invoice({
        positions: [
          line({ id: 'p1', description: 'Fläche', quantity: 10, unit: 'm²' as never, unitPrice: 10, lineTotal: 100 }),
          line({ id: 'p2', description: 'Leitung', quantity: 5, unit: 'Meter' as never, unitPrice: 10, lineTotal: 50 }),
          line({ id: 'p3', description: 'Arbeit', quantity: 1, unit: 'Stunden' as never, unitPrice: 80, lineTotal: 80 }),
          line({ id: 'p4', description: 'Teile', quantity: 4, unit: 'Stück' as never, unitPrice: 5, lineTotal: 20 }),
          line({ id: 'p5', description: 'Anfahrt', quantity: 1, unit: 'Pauschal' as never, unitPrice: 40, lineTotal: 40 }),
        ],
        subtotal: 290,
        amount: 345.1,
      }),
    );
    for (const code of ['MTK', 'MTR', 'HUR', 'H87', 'LS']) {
      expect(out, code).toContain(`unitCode="${code}"`);
    }
  });
});

describe('C — Maskierung und Zeichen', () => {
  it('T14: Sonderzeichen werden maskiert, nicht verfälscht', () => {
    expect(escapeXmlText('Çırmak & Söhne <Test>')).toBe('Çırmak &amp; Söhne &lt;Test&gt;');
    expect(escapeXmlAttribute('a"b\'c&d')).toBe('a&quot;b&apos;c&amp;d');
    // Keine HTML-Entitäten: Umlaute bleiben Umlaute.
    expect(escapeXmlText('Prüfung Ø')).toBe('Prüfung Ø');
    // Emoji sind gültiges XML 1.0 und bleiben erhalten.
    expect(escapeXmlText('Abnahme 🏠')).toBe('Abnahme 🏠');
  });

  it('die Maskierung landet tatsächlich im Dokument', () => {
    const out = xml(
      invoice({
        companySnapshot: { ...SELLER, companyName: 'Çırmak & Söhne <Test>' },
        positions: [line({ description: 'Prüfung & Abdichtung "Flachdach" <Nord>' })],
      }),
    );
    expect(out).toContain('<ram:Name>Çırmak &amp; Söhne &lt;Test&gt;</ram:Name>');
    expect(out).toContain('Prüfung &amp; Abdichtung "Flachdach" &lt;Nord&gt;');
    // Kein rohes `&` ausserhalb einer Entität.
    expect(out).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('T15: XML-unzulässige Steuerzeichen brechen ab, statt still zu verschwinden', () => {
    const canonical = buildCanonicalEInvoice(
      invoice({ positions: [line({ description: `Wartung\u0000Ende` })] }),
    );
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const rendered = renderXRechnungCii(canonical.value);
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.issues[0]!.code).toBe('xml_control_character');
    // Tabulator und Zeilenumbruch sind dagegen erlaubt.
    expect(escapeXmlText('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('D — Zahlen, Daten, leere Elemente', () => {
  it('Beträge immer mit Punkt und zwei Stellen, nie lokalisiert', () => {
    expect(formatXmlAmount(1234.5)).toBe('1234.50');
    expect(formatXmlAmount(0)).toBe('0.00');
    expect(formatXmlAmount(-0)).toBe('0.00');
    expect(formatXmlAmount(0.1 + 0.2)).toBe('0.30');
    expect(formatXmlAmount(1e21)).not.toContain('e');
  });

  it('Mengen ohne nachlaufende Nullen, Daten im Format 102', () => {
    expect(formatXmlQuantity(2)).toBe('2');
    expect(formatXmlQuantity(2.5)).toBe('2.5');
    expect(formatXmlDate102('2026-09-23')).toBe('20260923');
    expect(() => formatXmlDate102('23.09.2026')).toThrow();
  });

  it('T19: optionale Angaben ohne Wert erzeugen kein leeres Element', () => {
    const out = xml(
      invoice({
        companySnapshot: { ...SELLER, registrationNumber: '' },
        customerSnapshot: { ...BUYER, contactPerson: '', vatId: '' },
        skontoText: '',
      }),
    );
    expect(out).not.toContain('SpecifiedLegalOrganization');
    expect(out).not.toContain('DefinedTradeContact>\n        <ram:PersonName></ram:PersonName>');
    expect(out).not.toMatch(/<ram:[A-Za-z]+><\/ram:[A-Za-z]+>/);
    // Die einzige bewusste Ausnahme ist das im Schema verlangte Pflichtelement.
    const leer = out.match(/<ram:[A-Za-z]+\/>/g) ?? [];
    expect(leer).toEqual(['<ram:ApplicableHeaderTradeDelivery/>']);
  });
});

describe('E — was kein XML bekommen darf', () => {
  it('T26: Schlussrechnung mit Abzügen', () => {
    expect(
      rendersAtAll(
        invoice({
          type: 'schluss',
          subtotal: 1000,
          amount: 690,
          positions: [line({ quantity: 10, unitPrice: 100, lineTotal: 1000 })],
          previousAbschlagDeductions: [
            { invoiceId: 'a1', invoiceNumber: '2026-0031', date: '2026-08-01', subtotal: 400, amount: 476 },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('T28/T29/T30/T31: interner Storno, tax_free, unclear und Altbeleg', () => {
    expect(
      rendersAtAll(invoice({ cancelledAt: '2026-09-25T10:00:00.000Z', cancellationKind: 'internal' })),
      'interner Storno',
    ).toBe(false);
    expect(rendersAtAll(invoice({ taxStatus: 'tax_free', amount: 160 })), 'tax_free').toBe(false);
    expect(rendersAtAll(invoice({ taxStatus: 'unclear', amount: 160 })), 'unclear').toBe(false);
    expect(
      rendersAtAll(
        invoice({
          currencyCode: undefined,
          customerSnapshot: {
            name: 'AZ Testbau GmbH', contactPerson: '', street: 'Industriestrasse 12',
            zip: '33602', city: 'Bielefeld', email: 'x@y.invalid', phone: '',
          },
        }),
      ),
      'Altbeleg',
    ).toBe(false);
  });

  it('ohne Ansprechpartner des Verkäufers gibt es kein XML', () => {
    /*
     * XRechnung verlangt die Gruppe "Seller contact" (BR-DE-2) mit Name,
     * Telefon und E-Mail (BR-DE-5/6/7). Der offizielle Validator hat genau das
     * an der ersten erzeugten Datei beanstandet.
     */
    const canonical = buildCanonicalEInvoice(
      invoice({ companySnapshot: { ...SELLER, contactPerson: '', phone: '' } }),
    );
    expect(canonical.ok).toBe(false);
    if (canonical.ok) return;
    expect(canonical.issues.map((i) => i.code)).toContain('seller_contact_missing');
  });
});

describe('F — Artefakt', () => {
  it('T34: der Dateiname entsteht nur aus der Rechnungsnummer', () => {
    expect(buildXRechnungFileName('2026-0023')).toBe('XRechnung-2026-0023.xml');
    // Kein Pfadwechsel, kein Verzeichnisaufstieg, kein Freitext.
    expect(buildXRechnungFileName('../../etc/passwd')).toBe('XRechnung-etc-passwd.xml');
    expect(buildXRechnungFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('XRechnung-a-b-c-d-e-f-g-h-i-j.xml');
    expect(buildXRechnungFileName('')).toBe('XRechnung-Rechnung.xml');
  });

  it('T32/T33: gleiche Bytes sind dieselbe Datei, andere Bytes eine neue', () => {
    /*
     * E-RECHNUNG-04D3 — die Wiederverwendung hängt seit der gemeinsamen
     * Dateiarchitektur an der Inhaltsadressierung, nicht mehr an einem
     * versionsgebundenen Schlüssel. Zweimal dasselbe erzeugen ergibt denselben
     * Prüfwert und damit dieselbe Datei; ändert sich der Erzeuger, entstehen
     * andere Bytes und eine **neue** Datei — die alte bleibt unter ihrem Hash
     * liegen und wird von nichts überschrieben.
     */
    const quelle = invoice();
    expect(sha256(xml(quelle))).toBe(sha256(xml(quelle)));

    // Die Rolle, unter der die Datei am Beleg hängt, ist festgelegt.
    expect(XRECHNUNG_BINDING_KIND).toBe('structured');
  });
});

describe('G — Determinismus', () => {
  it('T16/T17/T18: zweimal rendern ergibt identische Bytes und denselben Prüfwert', () => {
    const quelle = invoice({
      positions: [line({ id: 'p1' }), line({ id: 'p2', description: 'Anfahrt', unit: 'Pauschal' as never, quantity: 1, unitPrice: 40, lineTotal: 40 })],
      subtotal: 200,
      amount: 238,
    });
    const a = xml(quelle);
    const b = xml(quelle);
    expect(a).toBe(b);
    expect(sha256(a)).toBe(sha256(b));
    // Kein Zeitstempel und keine erzeugte Kennung im Dokument.
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
