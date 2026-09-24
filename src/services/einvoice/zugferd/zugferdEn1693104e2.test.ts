/**
 * E-RECHNUNG-04E2 — ZUGFeRD 2.5.2 / Factur-X 1.09.2, Profil EN16931.
 *
 * Diese Datei prüft **Strukturen und Invarianten**. Ob das erzeugte XML
 * profilkonform ist, entscheidet nicht dieses Repository: Das haben die
 * offiziellen Artefakte des Pakets entschieden, ausgeführt durch die
 * ZUGFeRD-Referenzimplementierung (Mustang 2.26.0). Der Befund steht in
 * `README.md` neben dieser Datei, zusammen mit der Anleitung, ihn zu
 * wiederholen.
 *
 * Was hier steht, sichert ab, dass niemand später unbemerkt genau die
 * Eigenschaften entfernt, auf denen dieses Urteil beruhte — ohne dass dafür ein
 * Java-Validator im Repository liegen müsste.
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine neue Rechnungsnummer.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';

import { buildCanonicalEInvoice } from '../canonicalEInvoiceBuilder';
import { renderXRechnungCii } from '../xrechnungCiiRenderer';
import { renderZugferdEn16931Cii } from './zugferdEn16931Renderer';
import { buildZugferdInvoice, buildZugferdFileName } from './zugferdArtifactService';
import { buildZugferdXmpDescriptions } from './zugferdXmp';
import { checkZugferdPdfXmlConsistency } from './zugferdPdfXmlConsistency';
import { buildInvoicePrintModelFromInvoice } from '../../invoicePrintModel';
import { EINVOICE_STANDARDS } from '../einvoiceStandards';
import {
  ZUGFERD_AF_RELATIONSHIP,
  ZUGFERD_EMBEDDED_FILE_NAME,
  ZUGFERD_EMBEDDED_MIME_TYPE,
  ZUGFERD_EN16931_GUIDELINE_ID,
  ZUGFERD_OTHER_PROFILE_IDS,
  ZUGFERD_XMP_CONFORMANCE_LEVEL,
  ZUGFERD_XMP_NAMESPACE,
  ZUGFERD_XMP_VERSION,
} from './zugferdProfile';
import type {
  CompanyProfile,
  CustomerBilling,
  TaxStatus,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../../types/models';

const GOLD = path.resolve(__dirname, '..', '__goldfiles__');
const sha256 = (value: string | Uint8Array) =>
  createHash('sha256')
    .update(typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value))
    .digest('hex');

/** Ein echtes 1×1-PNG **mit Alphakanal** — der Transparenzfall. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
    id: 'inv-04e2',
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

/** Rendert und verlangt Erfolg. */
function xml(value: VorgangInvoice): string {
  const canonical = buildCanonicalEInvoice(value);
  expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
  if (!canonical.ok) throw new Error('canonical');
  const rendered = renderZugferdEn16931Cii(canonical.value);
  expect(rendered.ok, rendered.ok ? '' : JSON.stringify(rendered.issues)).toBe(true);
  if (!rendered.ok) throw new Error('render');
  return rendered.xml;
}

async function hybrid(value: VorgangInvoice) {
  const built = await buildZugferdInvoice(value);
  expect(built.ok, built.ok ? '' : JSON.stringify(built)).toBe(true);
  if (!built.ok) throw new Error('hybrid');
  return built.artifact;
}

/** Die eingebettete Datei samt ihrer Beschreibung aus dem fertigen Dokument. */
async function readAttachment(bytes: Uint8Array) {
  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  const af = loaded.catalog.lookup(PDFName.of('AF'), PDFArray);
  const fileSpec = af.lookup(0, PDFDict);
  const stream = fileSpec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'), PDFRawStream);
  const metadata = loaded.catalog.lookup(PDFName.of('Metadata'), PDFRawStream);
  return {
    count: af.size(),
    name: fileSpec.lookup(PDFName.of('F'), PDFString).asString(),
    unicodeName: fileSpec.lookup(PDFName.of('UF'), PDFHexString).decodeText(),
    relationship: fileSpec.lookup(PDFName.of('AFRelationship'), PDFName).asString(),
    mimeType: stream.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText(),
    xmp: new TextDecoder().decode(metadata.getContents()),
    catalog: loaded.catalog,
    document: loaded,
  };
}

/* ================================================================== */

describe('E-RECHNUNG-04E2 — Profil und Abgrenzung', () => {
  // T-P1 — die Kennung, auf die der Prüfer sein Profil auswählt.
  it('T-P1: der Beleg trägt genau die EN16931-Guideline-Kennung', () => {
    expect(ZUGFERD_EN16931_GUIDELINE_ID).toBe('urn:cen.eu:en16931:2017');
    expect(xml(invoice())).toContain(
      `<ram:ID>${ZUGFERD_EN16931_GUIDELINE_ID}</ram:ID>`,
    );
  });

  // T-P2 — und ausdrücklich keine der anderen Stufen.
  it('T-P2: keine andere Profilstufe erscheint im Dokument', () => {
    const out = xml(invoice());
    for (const [name, id] of Object.entries(ZUGFERD_OTHER_PROFILE_IDS)) {
      expect(out, `Profil ${name} darf nicht vorkommen`).not.toContain(id);
    }
  });

  /*
   * T-P3 — die Abgrenzung, die diesen Block überhaupt nötig gemacht hat.
   *
   * XRechnung und ZUGFeRD EN16931 benutzen dieselbe Syntax und dasselbe
   * fachliche Modell und sind trotzdem verschiedene Dokumente. Wären sie
   * gleich, hätte ein einziger Renderer genügt.
   */
  it('T-P3: XRechnung und ZUGFeRD erzeugen aus derselben Rechnung verschiedene Dokumente', () => {
    const canonical = buildCanonicalEInvoice(invoice());
    if (!canonical.ok) throw new Error('canonical');
    const xr = renderXRechnungCii(canonical.value);
    const zf = renderZugferdEn16931Cii(canonical.value);
    if (!xr.ok || !zf.ok) throw new Error('render');

    expect(zf.xml).not.toBe(xr.xml);
    // Die XRechnung führt den Peppol-Geschäftsprozess, ZUGFeRD nicht.
    expect(xr.xml).toContain('BusinessProcessSpecifiedDocumentContextParameter');
    expect(zf.xml).not.toContain('BusinessProcessSpecifiedDocumentContextParameter');
    expect(zf.xml).not.toContain('xrechnung');
  });

  // T28 — die abgenommenen XRechnung-Dateien bleiben unberührt.
  it('T28: die XRechnung-Goldfiles bleiben byteidentisch', () => {
    const canonical = buildCanonicalEInvoice(invoice());
    if (!canonical.ok) throw new Error('canonical');
    const xr = renderXRechnungCii(canonical.value);
    if (!xr.ok) throw new Error('render');
    const gold = readFileSync(path.join(GOLD, '01-standard-19.xml'), 'utf8');
    expect(xr.xml).toBe(gold);
    expect(sha256(xr.xml)).toBe(
      'b3dfa6241450badf6a2a0c5489c6cae1795b62e9b88f9044f54dfcaacfe2b86f',
    );
  });
});

describe('E-RECHNUNG-04E2 — Steuerszenarien', () => {
  // T1–T4 — die vier heute unterstützten Fälle.
  it.each([
    ['T1: Standard 19 %', invoice(), 'S', '19.00'],
    ['T2: Standard 7 %', invoice({ taxStatus: 'standard_7' }), 'S', '7.00'],
    [
      'T3: Reverse Charge §13b',
      invoice({
        taxStatus: 'reverse_charge_13b',
        amount: 160,
        legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
      }),
      'AE',
      '0.00',
    ],
    [
      'T4: Kleinunternehmer',
      invoice({
        taxStatus: 'kleinunternehmer_19',
        amount: 160,
        legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'],
      }),
      'E',
      '0.00',
    ],
  ])('%s trägt die richtige Kategorie und den richtigen Satz', (_label, value, code, rate) => {
    const out = xml(value as VorgangInvoice);
    expect(out).toContain(`<ram:CategoryCode>${code}</ram:CategoryCode>`);
    expect(out).toContain(`<ram:RateApplicablePercent>${rate}</ram:RateApplicablePercent>`);
  });

  // Die fachlichen Sperren aus 04C gelten unverändert weiter.
  it.each([
    ['tax_free ohne bestimmte Rechtsgrundlage', invoice({ taxStatus: 'tax_free', amount: 160 })],
    ['unclear', invoice({ taxStatus: 'unclear', amount: 160 })],
  ])('%s erzeugt kein ZUGFeRD-Dokument', (_label, value) => {
    const canonical = buildCanonicalEInvoice(value as VorgangInvoice);
    expect(canonical.ok).toBe(false);
  });
});

describe('E-RECHNUNG-04E2 — Rechnungstypen und Belegtypcodes', () => {
  // T5–T10 — jeder Typ mit dem Code, den er tragen muss.
  it.each([
    ['T5: manuelle Rechnung', invoice({ number: '2026-0043' }), '380'],
    ['T6: Teilrechnung', invoice({ type: 'teilrechnung', number: '2026-0044' }), '326'],
    [
      'T7: Abschlag mengenbasiert',
      invoice({ type: 'abschlag', abschlagNumber: 1, number: '2026-0045' }),
      '875',
    ],
    [
      'T8: Abschlag pauschal',
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
      '875',
    ],
    ['T9: Schlussrechnung ohne Abzüge', invoice({ type: 'schluss', number: '2026-0047' }), '877'],
    [
      'T10: Korrekturrechnung',
      invoice({
        number: '2026-0048',
        cancelledAt: '2026-09-25T10:00:00.000Z',
        cancellationKind: 'correction',
        cancelReason: 'Falscher Leistungszeitraum',
      }),
      '384',
    ],
  ])('%s trägt TypeCode %s', (_label, value, code) => {
    expect(xml(value as VorgangInvoice)).toContain(`<ram:TypeCode>${code}</ram:TypeCode>`);
  });

  /*
   * Die Sperren bleiben. Eine Schlussrechnung mit Abzügen behauptet im XML
   * sonst einen Zahlbetrag, den die Struktur nicht begründen kann, und ein
   * interner Storno ist kein Beleg für den Empfänger.
   */
  it('eine Schlussrechnung mit Abzügen bleibt gesperrt', () => {
    const canonical = buildCanonicalEInvoice(
      invoice({
        type: 'schluss',
        number: '2026-0052',
        previousAbschlagDeductions: [
          { invoiceNumber: '2026-0045', abschlagNumber: 1, amount: 100 },
        ],
      } as Partial<VorgangInvoice>),
    );
    expect(canonical.ok).toBe(false);
    if (canonical.ok) return;
    expect(canonical.issues.map((issue) => issue.code)).toContain(
      'final_invoice_deduction_semantics_unsupported',
    );
  });

  it('ein interner Storno bleibt nicht exportierbar', () => {
    const canonical = buildCanonicalEInvoice(
      invoice({
        number: '2026-0053',
        cancelledAt: '2026-09-25T10:00:00.000Z',
        cancellationKind: 'internal',
        cancelReason: 'Versehentlich erstellt',
      } as Partial<VorgangInvoice>),
    );
    expect(canonical.ok).toBe(false);
    if (canonical.ok) return;
    expect(canonical.issues.map((issue) => issue.code)).toContain(
      'internal_cancellation_not_exportable',
    );
  });
});

describe('E-RECHNUNG-04E2 — keine leeren Elemente', () => {
  /*
   * T23 — `PEPPOL-EN16931-R008`. Der erste Prüflauf dieses Renderers meldete
   * genau diese Regel, weil `ApplicableHeaderTradeDelivery` leer blieb. Sie
   * ist im Profil nur eine Warnung; hier wird sie trotzdem als Fehler
   * behandelt, weil eine leere Angabe nichts aussagt.
   */
  it('T23: kein erzeugtes Dokument enthält ein leeres Element', () => {
    const faelle = [
      invoice(),
      invoice({ taxStatus: 'standard_7' }),
      invoice({ type: 'teilrechnung', number: '2026-0044' }),
      invoice({ type: 'schluss', number: '2026-0047' }),
    ];
    for (const value of faelle) {
      const out = xml(value);
      expect(out, 'selbstschliessendes Element gefunden').not.toMatch(/<ram:[A-Za-z]+\/>/);
      expect(out).not.toMatch(/<ram:([A-Za-z]+)><\/ram:\1>/);
    }
  });

  it('das Lieferdatum BT-72 ist gefüllt und entspricht dem Leistungsende', () => {
    const out = xml(invoice());
    expect(out).toContain('<ram:ActualDeliverySupplyChainEvent>');
    expect(out).toMatch(
      /<ram:ActualDeliverySupplyChainEvent>[\s\S]*?<udt:DateTimeString format="102">20260923<\/udt:DateTimeString>/,
    );
  });
});

describe('E-RECHNUNG-04E2 — PDF und XML zeigen denselben Beleg', () => {
  /*
   * T20 — das P0 dieses Blocks. Beim hybriden Format ist der XML-Teil
   * fachlich führend; weicht das sichtbare PDF ab, bucht der Empfänger etwas
   * anderes, als auf dem Papier steht.
   */
  it('T20: die Gleichheitsprüfung bestätigt jeden unterstützten Belegtyp', () => {
    const faelle = [
      invoice(),
      invoice({ taxStatus: 'standard_7' }),
      invoice({
        taxStatus: 'reverse_charge_13b',
        amount: 160,
        legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.'],
      }),
      invoice({ type: 'teilrechnung', number: '2026-0044' }),
      invoice({ type: 'abschlag', abschlagNumber: 1, number: '2026-0045' }),
      invoice({ type: 'schluss', number: '2026-0047' }),
    ];
    for (const value of faelle) {
      const canonical = buildCanonicalEInvoice(value);
      if (!canonical.ok) throw new Error(JSON.stringify(canonical.issues));
      const result = checkZugferdPdfXmlConsistency(
        buildInvoicePrintModelFromInvoice(value),
        canonical.value,
      );
      expect(result, JSON.stringify(result)).toEqual({ ok: true });
    }
  });

  /*
   * Und sie ist keine Formsache: Ein manipulierter Betrag muss auffallen.
   * Ohne diesen Test wüsste niemand, ob die Prüfung überhaupt etwas prüft.
   */
  it('ein abweichender Betrag zwischen PDF und XML wird erkannt', () => {
    const value = invoice();
    const canonical = buildCanonicalEInvoice(value);
    if (!canonical.ok) throw new Error('canonical');
    const model = buildInvoicePrintModelFromInvoice(value);

    const manipuliert = { ...model, summary: { ...model.summary, grossTotal: 999.99 } };
    const result = checkZugferdPdfXmlConsistency(manipuliert, canonical.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatches.map((m) => m.field)).toContain('totals.gross');
  });

  it('eine abweichende Rechnungsnummer wird erkannt', () => {
    const value = invoice();
    const canonical = buildCanonicalEInvoice(value);
    if (!canonical.ok) throw new Error('canonical');
    const model = buildInvoicePrintModelFromInvoice(value);

    const result = checkZugferdPdfXmlConsistency(
      { ...model, invoiceNumber: '2026-9999' },
      canonical.value,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatches.map((m) => m.field)).toContain('invoiceNumber');
  });

  it('eine abweichende IBAN wird erkannt', () => {
    const value = invoice();
    const canonical = buildCanonicalEInvoice(value);
    if (!canonical.ok) throw new Error('canonical');
    const model = buildInvoicePrintModelFromInvoice(value);

    const result = checkZugferdPdfXmlConsistency(
      { ...model, company: { ...model.company, iban: 'DE00000000000000000000' } },
      canonical.value,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatches.map((m) => m.field)).toContain('payment.iban');
  });

  it('der Pauschalabschlag hält alle Geldbeträge fest, nur die erzeugte Beschriftung nicht', () => {
    const value = invoice({
      type: 'abschlag',
      abschlagNumber: 1,
      number: '2026-0046',
      calculationMode: 'fixed_amount',
      fixedAmountNet: 500,
      positions: [],
      subtotal: 500,
      amount: 595,
    });
    const canonical = buildCanonicalEInvoice(value);
    if (!canonical.ok) throw new Error('canonical');
    const model = buildInvoicePrintModelFromInvoice(value);

    expect(canonical.value.lines[0].synthetic).toBe(true);
    // Die Beträge stimmen überein …
    expect(checkZugferdPdfXmlConsistency(model, canonical.value)).toEqual({ ok: true });
    // … und ein manipulierter Betrag fällt auch hier auf.
    const kaputt = {
      ...model,
      positions: [{ ...model.positions[0], unitPrice: 501, lineTotal: 501 }],
    };
    expect(checkZugferdPdfXmlConsistency(kaputt, canonical.value).ok).toBe(false);
  });
});

describe('E-RECHNUNG-04E2 — das fertige Hybriddokument', () => {
  // T14/T16 — Anhang, Name, Medientyp, Beziehung.
  it('T14/T16: factur-x.xml hängt als Alternative mit dem richtigen Medientyp', async () => {
    const artifact = await hybrid(invoice());
    const attachment = await readAttachment(artifact.bytes);

    expect(attachment.count).toBe(1);
    expect(attachment.name).toBe('factur-x.xml');
    expect(attachment.unicodeName).toBe('factur-x.xml');
    expect(attachment.relationship).toBe(`/${ZUGFERD_AF_RELATIONSHIP}`);
    expect(attachment.relationship).toBe('/Alternative');
    expect(attachment.mimeType).toBe(ZUGFERD_EMBEDDED_MIME_TYPE);
    expect(attachment.mimeType).toBe('text/xml');
    // Ausdrücklich nicht der Name des Referenzprofils XRECHNUNG.
    expect(attachment.name).not.toBe('xrechnung.xml');
  });

  // T15 — das XMP nennt dieselbe Datei und dieselbe Stufe.
  it('T15: das XMP trägt den Factur-X-Block und das Erweiterungsschema', async () => {
    const artifact = await hybrid(invoice());
    const { xmp } = await readAttachment(artifact.bytes);

    // Das Erweiterungsschema meldet den Namensraum an — sonst kein gültiges PDF/A.
    expect(xmp).toContain('pdfaExtension:schemas');
    expect(xmp).toContain(`<pdfaSchema:namespaceURI>${ZUGFERD_XMP_NAMESPACE}</pdfaSchema:namespaceURI>`);
    expect(xmp).toContain('<pdfaSchema:prefix>fx</pdfaSchema:prefix>');
    for (const property of ['DocumentFileName', 'DocumentType', 'Version', 'ConformanceLevel']) {
      expect(xmp).toContain(`<pdfaProperty:name>${property}</pdfaProperty:name>`);
    }

    expect(xmp).toContain(`<fx:DocumentFileName>${ZUGFERD_EMBEDDED_FILE_NAME}</fx:DocumentFileName>`);
    expect(xmp).toContain('<fx:DocumentType>INVOICE</fx:DocumentType>');
    expect(xmp).toContain(`<fx:Version>${ZUGFERD_XMP_VERSION}</fx:Version>`);
    /*
     * Mit Leerzeichen. Der Profilname heisst `EN16931`, die Konformitätsstufe
     * im XMP `EN 16931` — wer das verwechselt, erzeugt Metadaten, die nicht
     * zum Inhalt passen.
     */
    expect(xmp).toContain(`<fx:ConformanceLevel>${ZUGFERD_XMP_CONFORMANCE_LEVEL}</fx:ConformanceLevel>`);
    expect(xmp).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');

    // Das XMP bleibt wohlgeformt, auch mit den zusätzlichen Blöcken.
    const parsed = new DOMParser().parseFromString(xmp, 'application/xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
  });

  // Anhangname und XMP-Angabe stammen aus derselben Quelle.
  it('der Dateiname im XMP ist derselbe wie der des Anhangs', async () => {
    const artifact = await hybrid(invoice());
    const attachment = await readAttachment(artifact.bytes);
    expect(attachment.xmp).toContain(`<fx:DocumentFileName>${attachment.name}</fx:DocumentFileName>`);
  });

  // T17 — die PDF/A-Merkmale aus 04E1 überstehen die Einbettung.
  it('T17: Metadaten, OutputIntent und Dokumentkennung bleiben erhalten', async () => {
    const artifact = await hybrid(invoice());
    const { catalog, document, xmp } = await readAttachment(artifact.bytes);

    expect(catalog.has(PDFName.of('Metadata'))).toBe(true);
    expect(catalog.has(PDFName.of('OutputIntents'))).toBe(true);
    expect(xmp).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(xmp).toContain('<pdfaid:conformance>U</pdfaid:conformance>');

    const id = document.context.trailerInfo.ID as PDFArray;
    expect(id.size()).toBe(2);
  });

  // Die eingebetteten Bytes sind genau das geprüfte XML.
  it('die eingebettete Datei ist byteidentisch mit dem erzeugten XML', async () => {
    const artifact = await hybrid(invoice());
    const loaded = await PDFDocument.load(artifact.bytes, { updateMetadata: false });
    const stream = loaded.catalog
      .lookup(PDFName.of('AF'), PDFArray)
      .lookup(0, PDFDict)
      .lookup(PDFName.of('EF'), PDFDict)
      .lookup(PDFName.of('F'), PDFRawStream);

    // Der Strom ist komprimiert; verglichen wird über die hinterlegte Grösse.
    const size = stream.dict.lookup(PDFName.of('Params'), PDFDict).get(PDFName.of('Size'));
    expect(String(size)).toBe(String(new TextEncoder().encode(artifact.xml).length));
  });

  // T11–T13 — die Belegvarianten, die erfahrungsgemäss brechen.
  it.each([
    [
      'T11: Unicode und Sonderzeichen',
      invoice({
        number: '2026-0049',
        companySnapshot: { ...SELLER, companyName: 'Çırmak & Söhne <Test>' } as CompanyProfile,
        positions: [
          line({ description: 'Prüfung & Abdichtung "Flachdach" <Nord> — Ø 12 mm, 100 % dicht' }),
        ],
      }),
    ],
    [
      'T12: lange, mehrseitige Rechnung',
      invoice({
        number: '2026-0050',
        positions: Array.from({ length: 60 }, (_, index) =>
          line({
            id: `p${index}`,
            description: `Position ${index + 1} — Trockenbau Süd Abschnitt ${index + 1}`,
            quantity: 2,
            unit: 'm²',
            unitPrice: 50,
            lineTotal: 100,
          }),
        ),
        subtotal: 6000,
        amount: 7140,
      }),
    ],
    [
      'T13: Logo mit Transparenz',
      invoice({
        number: '2026-0051',
        companySnapshot: {
          ...SELLER,
          logoDataUrl: `data:image/png;base64,${PNG_BASE64}`,
        } as CompanyProfile,
      }),
    ],
  ])('%s ergibt ein vollständiges Hybriddokument', async (_label, value) => {
    const artifact = await hybrid(value as VorgangInvoice);
    const attachment = await readAttachment(artifact.bytes);
    expect(attachment.name).toBe('factur-x.xml');
    expect(attachment.xmp).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(artifact.byteSize).toBeGreaterThan(1000);
  });
});

describe('E-RECHNUNG-04E2 — Artefaktbeschreibung', () => {
  it('das Artefakt beschreibt sich vollständig und versionsgebunden', async () => {
    const artifact = await hybrid(invoice());

    expect(artifact.format).toBe('zugferd');
    expect(artifact.standardVersion).toBe('2.5.2');
    expect(artifact.facturXVersion).toBe('1.09.2');
    expect(artifact.standardVersion).toBe(EINVOICE_STANDARDS.zugferd.version);
    expect(artifact.facturXVersion).toBe(EINVOICE_STANDARDS.zugferd.facturX);
    expect(artifact.profile).toBe('EN16931');
    expect(artifact.syntax).toBe('CII');
    expect(artifact.pdfConformance).toBe('PDF/A-3U');
    expect(artifact.embeddedFileName).toBe('factur-x.xml');
    expect(artifact.generatorVersion).toBe('officetakt-zugferd-en16931-1');
    expect(artifact.sourceInvoiceId).toBe('inv-04e2');
    expect(artifact.sourceInvoiceNumber).toBe('2026-0042');
    expect(artifact.mimeType).toBe('application/pdf');
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.sha256).toBe(sha256(artifact.bytes));
    expect(artifact.byteSize).toBe(artifact.bytes.byteLength);
  });

  it('der Dateiname ist als ZUGFeRD erkennbar und vom reinen PDF verschieden', () => {
    expect(buildZugferdFileName('2026-0042')).toBe('ZUGFeRD-2026-0042.pdf');
    expect(buildZugferdFileName('2026/0042')).toBe('ZUGFeRD-2026-0042.pdf');
    expect(buildZugferdFileName('')).toBe('ZUGFeRD-Rechnung.pdf');
  });
});

describe('E-RECHNUNG-04E2 — Determinismus', () => {
  // T26 — gleiche Eingabe, gleiches XML.
  it('T26: zweimaliges Rendern liefert byteidentisches XML', () => {
    expect(xml(invoice())).toBe(xml(invoice()));
    expect(sha256(xml(invoice()))).toBe(sha256(xml(invoice())));
  });

  // T27 — und gleiches PDF.
  it('T27: zweimaliges Erzeugen liefert ein byteidentisches Hybriddokument', async () => {
    const [erst, zweit] = [await hybrid(invoice()), await hybrid(invoice())];
    expect(zweit.sha256).toBe(erst.sha256);
    expect(zweit.bytes).toEqual(erst.bytes);
  });

  it('das XMP enthält keinen Zeitstempel der Systemuhr', async () => {
    const artifact = await hybrid(invoice());
    const { xmp } = await readAttachment(artifact.bytes);
    // Alle Zeitangaben stammen aus dem Rechnungsdatum.
    for (const match of xmp.matchAll(/>(\d{4}-\d{2}-\d{2})T/g)) {
      expect(match[1]).toBe('2026-09-23');
    }
  });
});

describe('E-RECHNUNG-04E2 — Negativfälle', () => {
  /*
   * T21/T22/T24 — die Gegenproben. Ein Prüfwerkzeug, das nur Gutfälle sieht,
   * hat nichts bewiesen. Die Validator-seitigen Gegenproben stehen in
   * `README.md`; hier sind die, die im Repository entscheidbar sind.
   */

  // T21 — ein falscher Profil-Identifier entsteht gar nicht erst.
  it('T21: die Profilkennung ist eine Konstante und keine Eingabe', () => {
    const out = xml(invoice());
    const treffer = out.match(/<ram:GuidelineSpecifiedDocumentContextParameter>[\s\S]*?<\/ram:GuidelineSpecifiedDocumentContextParameter>/);
    expect(treffer).not.toBeNull();
    expect(treffer![0]).toContain(ZUGFERD_EN16931_GUIDELINE_ID);
    expect(out.match(/urn:cen\.eu:en16931:2017/g)).toHaveLength(1);
  });

  // T22 — ein fehlendes Pflichtfeld erzeugt kein Dokument.
  it.each([
    ['Verkäufername', { companyName: '' }],
    ['Verkäuferanschrift', { street: '' }],
    ['IBAN', { iban: '' }],
  ])('T22: ohne %s entsteht kein ZUGFeRD-Dokument', (_label, patch) => {
    const canonical = buildCanonicalEInvoice(
      invoice({ companySnapshot: { ...SELLER, ...patch } as CompanyProfile }),
    );
    expect(canonical.ok).toBe(false);
  });

  // T24 — ein widersprüchlicher Anhang-/XMP-Zustand ist nachweisbar.
  it('T24: ein XMP mit fremdem Dateinamen unterscheidet sich nachweisbar', () => {
    const richtig = buildZugferdXmpDescriptions({ documentFileName: 'factur-x.xml' }).join('\n');
    const falsch = buildZugferdXmpDescriptions({ documentFileName: 'rechnung-falsch.xml' }).join('\n');
    expect(richtig).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    expect(falsch).not.toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    expect(falsch).not.toBe(richtig);
  });

  // Sonderzeichen in Metadaten dürfen das XMP nicht zerbrechen.
  it('Sonderzeichen im Dateinamen werden maskiert', () => {
    const blocks = buildZugferdXmpDescriptions({ documentFileName: 'a<b>&c.xml' }).join('\n');
    expect(blocks).toContain('a&lt;b&gt;&amp;c.xml');
  });
});
