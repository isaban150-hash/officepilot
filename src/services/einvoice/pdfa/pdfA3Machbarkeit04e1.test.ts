/**
 * E-RECHNUNG-04E1 — der PDF/A-3-Unterbau für die spätere ZUGFeRD-Rechnung.
 *
 * Diese Datei prüft **Struktur**, nicht Konformität. Die Konformität entscheidet
 * ein externer Prüfer, nicht eine Behauptung im eigenen Repository: veraPDF
 * 1.30.2 (greenfield) urteilte über neun Belegvarianten mit 148 bestandenen und
 * null fehlgeschlagenen Regeln, während dieselbe Datei ohne XMP an Regel
 * `6.6.2.1-1` scheiterte. Wie dieser Lauf wiederholt wird, steht in `README.md`
 * neben dieser Datei.
 *
 * Was hier steht, ist die Absicherung dagegen, dass jemand später unbemerkt
 * genau die Strukturen entfernt, auf denen dieses Urteil beruhte — ohne dass
 * dafür ein Java-Validator im Repository liegen müsste.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';

import {
  generateApprovedInvoicePdf,
  generateArchivalInvoicePdfA3,
} from '../../invoicePdfService';
import { DEFAULT_COMPANY_PROFILE } from '../../../data/companyProfileDefaults';
import type { VorgangInvoice } from '../../../types/models';
import { attachPdfAFile, buildDeterministicFileId } from './pdfaDocument';
import { buildPdfAXmp, formatXmpDate } from './pdfaXmp';
import {
  PDFA_CONFORMANCE,
  PDFA_OUTPUT_INTENT_SUBTYPE,
  PDFA_PART,
  PDFA_PRODUCER,
} from './pdfaProfile';

/** Ein echtes 1×1-PNG **mit Alphakanal** — der Transparenzfall. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  phone: '+49 89 123456',
  email: 'rechnung@muster-handwerk.de',
  taxNumber: '143/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse München',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'COBADEFFXXX',
  invoiceFooterNotes: 'Vielen Dank.',
};

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-pdfa',
    number: '2026-0042',
    type: 'rechnung',
    positions: [
      {
        id: 'l1',
        orderPositionId: 'o1',
        description: 'Fliesenarbeiten Bad',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
    ],
    subtotal: 520,
    taxStatus: 'standard_19',
    amount: 618.8,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      street: 'Musterweg 1',
      zip: '10115',
      city: 'Berlin',
    },
    companySnapshot,
    ...overrides,
  } as VorgangInvoice;
}

function manyPositions(count: number): VorgangInvoice['positions'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `l${index}`,
    orderPositionId: `o${index}`,
    description: `Position ${index + 1} — Trockenbau, Wandfläche Süd, Abschnitt ${index + 1}`,
    quantity: 2,
    unit: 'm²',
    unitPrice: 50,
    lineTotal: 100,
  })) as VorgangInvoice['positions'];
}

async function pdfaOf(value: VorgangInvoice): Promise<Uint8Array> {
  const result = await generateArchivalInvoicePdfA3(value);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('pdfa failed');
  return result.bytes;
}

async function normalOf(value: VorgangInvoice): Promise<Uint8Array> {
  const result = await generateApprovedInvoicePdf(value);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('pdf failed');
  return result.bytes;
}

/** Schneidet jeden gezeichneten Text samt Position mit, ohne das Zeichnen zu unterbinden. */
function captureDrawnText(): string[] {
  const drawn: string[] = [];
  const original = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (
    this: PDFPage,
    text: string,
    options?: Parameters<PDFPage['drawText']>[1],
  ) {
    drawn.push(`${text}@${options?.x ?? '-'},${options?.y ?? '-'},${options?.size ?? '-'}`);
    return original.call(this, text, options);
  });
  return drawn;
}

/** Das XMP-Paket aus dem fertigen Dokument — als Text, so wie es dort steht. */
async function readXmp(bytes: Uint8Array): Promise<string> {
  const loaded = await PDFDocument.load(bytes);
  const metadata = loaded.catalog.lookup(PDFName.of('Metadata'), PDFRawStream);
  return new TextDecoder().decode(metadata.getContents());
}

async function readOutputIntent(bytes: Uint8Array): Promise<PDFDict> {
  const loaded = await PDFDocument.load(bytes);
  const intents = loaded.catalog.lookup(PDFName.of('OutputIntents'), PDFArray);
  expect(intents.size()).toBe(1);
  return intents.lookup(0, PDFDict);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E-RECHNUNG-04E1 — PDF/A-3 Metadaten', () => {
  // T1 — die Info-Dictionary trägt, was PDF/A erwartet.
  it('T1: Titel, Ersteller, Produzent und Zeitpunkte stehen im Dokument', async () => {
    /*
     * `updateMetadata: false` ist hier wesentlich und kein Detail: `pdf-lib`
     * überschreibt beim Laden standardmässig `/Producer` und `/ModDate` mit
     * eigenen Werten. Ohne diesen Schalter prüfte der Test, was der Ladevorgang
     * hineingeschrieben hat, und nicht, was im Dokument steht.
     */
    const loaded = await PDFDocument.load(await pdfaOf(invoice()), { updateMetadata: false });

    expect(loaded.getTitle()).toBe('Rechnung 2026-0042');
    expect(loaded.getCreator()).toBe('OfficeTakt');
    expect(loaded.getProducer()).toBe(PDFA_PRODUCER);
    // Der Zeitpunkt kommt aus dem Rechnungsdatum, nicht von der Uhr.
    expect(loaded.getCreationDate()?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(loaded.getModificationDate()?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  // T2 — der Standardteil.
  it('T2: pdfaid:part weist Teil 3 aus', async () => {
    expect(await readXmp(await pdfaOf(invoice()))).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(PDFA_PART).toBe(3);
  });

  // T3 — die Konformitätsstufe. Siehe `pdfaProfile` für die Begründung.
  it('T3: pdfaid:conformance weist Stufe U aus', async () => {
    expect(await readXmp(await pdfaOf(invoice()))).toContain(
      '<pdfaid:conformance>U</pdfaid:conformance>',
    );
    expect(PDFA_CONFORMANCE).toBe('U');
  });

  // T4 — ein kaputtes XMP wäre schlimmer als gar keines.
  it('T4: das XMP-Paket ist wohlgeformtes XML und synchron zur Info-Dictionary', async () => {
    const xmp = await readXmp(await pdfaOf(invoice()));

    expect(xmp.startsWith('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>')).toBe(true);
    expect(xmp.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true);

    const parsed = new DOMParser().parseFromString(xmp, 'application/xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);

    /*
     * Die Synchronität ist der Punkt, an dem PDF/A-Dokumente in der Praxis am
     * häufigsten scheitern: XMP und Info-Dictionary sagen Verschiedenes.
     */
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Rechnung 2026-0042</rdf:li>');
    expect(xmp).toContain('<xmp:CreatorTool>OfficeTakt</xmp:CreatorTool>');
    expect(xmp).toContain(`<pdf:Producer>${PDFA_PRODUCER}</pdf:Producer>`);
    expect(xmp).toContain('<xmp:CreateDate>2026-06-01T00:00:00Z</xmp:CreateDate>');
    expect(xmp).toContain('<xmp:ModifyDate>2026-06-01T00:00:00Z</xmp:ModifyDate>');
  });

  // T4b — leere Angaben werden weggelassen, nicht leer geschrieben.
  it('T4b: nicht gesetzte optionale Felder erscheinen gar nicht', () => {
    const xmp = buildPdfAXmp({
      title: 'Rechnung 1',
      creatorTool: 'OfficeTakt',
      producer: PDFA_PRODUCER,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      modifiedAt: new Date('2026-01-02T03:04:05.000Z'),
      author: '   ',
      subject: '',
    });

    expect(xmp).not.toContain('dc:creator');
    expect(xmp).not.toContain('dc:description');
    expect(formatXmpDate(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z');
  });

  // T4c — Sonderzeichen in Metadaten dürfen das XMP nicht zerbrechen.
  it('T4c: spitze Klammern und Ampersand im Titel werden maskiert', () => {
    const xmp = buildPdfAXmp({
      title: 'Rechnung <A & B> "Süd"',
      creatorTool: 'OfficeTakt',
      producer: PDFA_PRODUCER,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      modifiedAt: new Date('2026-01-02T03:04:05.000Z'),
    });

    expect(xmp).toContain('Rechnung &lt;A &amp; B&gt; "Süd"');
    const parsed = new DOMParser().parseFromString(xmp, 'application/xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
  });
});

describe('E-RECHNUNG-04E1 — OutputIntent und Farbprofil', () => {
  // T5 — ohne OutputIntent ist jedes DeviceRGB im Dokument bedeutungslos.
  it('T5: der OutputIntent liegt am Katalog und nennt GTS_PDFA1', async () => {
    const intent = await readOutputIntent(await pdfaOf(invoice()));

    expect(intent.lookup(PDFName.of('Type'), PDFName).asString()).toBe('/OutputIntent');
    expect(intent.lookup(PDFName.of('S'), PDFName).asString()).toBe(
      `/${PDFA_OUTPUT_INTENT_SUBTYPE}`,
    );
    expect(intent.lookup(PDFName.of('OutputConditionIdentifier'), PDFString).asString()).toBe(
      'sRGB IEC61966-2.1',
    );
  });

  // T6 — das Profil ist wirklich eingebettet und wirklich das aus dem Repository.
  it('T6: das ICC-Profil ist byteidentisch eingebettet und als dreikanalig ausgewiesen', async () => {
    const intent = await readOutputIntent(await pdfaOf(invoice()));
    const profile = intent.lookup(PDFName.of('DestOutputProfile'), PDFRawStream);

    expect(profile.dict.lookup(PDFName.of('N'), PDFNumber).asNumber()).toBe(3);

    const embedded = profile.getContents();
    const onDisk = new Uint8Array(
      await readFile(path.resolve(process.cwd(), 'src/assets/color/sRGB2014.icc')),
    );
    expect(embedded).toEqual(onDisk);

    /*
     * Und es ist ein echtes Profil, kein Platzhalter: Die ICC-Kopfdaten müssen
     * ein Anzeigeprofil für RGB ausweisen. Ein OutputIntent mit einem Profil
     * falscher Geräteklasse wäre ungültig — siehe `src/assets/color/README.md`.
     */
    const kopf = (offset: number): string =>
      new TextDecoder('latin1').decode(embedded.slice(offset, offset + 4));
    expect(kopf(36)).toBe('acsp');
    expect(kopf(12)).toBe('mntr');
    expect(kopf(16)).toBe('RGB ');
  });
});

describe('E-RECHNUNG-04E1 — Schriften', () => {
  // T7 — Stufe U steht und fällt mit den Schriften.
  it('T7: alle Schriften sind eingebettet, keine Standardschrift bleibt übrig', async () => {
    const loaded = await PDFDocument.load(await pdfaOf(invoice()));

    let embeddedFontFiles = 0;
    const baseFonts: string[] = [];
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      if (object.has(PDFName.of('FontFile2'))) embeddedFontFiles += 1;
      const baseFont = object.get(PDFName.of('BaseFont'));
      if (baseFont instanceof PDFName) baseFonts.push(baseFont.asString());
    }

    expect(embeddedFontFiles).toBeGreaterThan(0);
    expect(baseFonts.length).toBeGreaterThan(0);
    for (const baseFont of baseFonts) {
      expect(baseFont).toContain('LiberationSans');
      // Keine stille Systemschrift: Helvetica & Co. dürfen nicht auftauchen.
      expect(baseFont).not.toMatch(/Helvetica|Courier|Times|Symbol|ZapfDingbats/);
    }
  });
});

describe('E-RECHNUNG-04E1 — das sichtbare Dokument bleibt unverändert', () => {
  // T8 — PDF/A ist eine Verpackung, kein Redesign.
  it('T8: normales PDF und PDF/A zeichnen denselben Text an denselben Stellen', async () => {
    const normal = captureDrawnText();
    await normalOf(invoice());
    const normalCopy = [...normal];
    vi.restoreAllMocks();

    const archival = captureDrawnText();
    await pdfaOf(invoice());

    expect(archival).toEqual(normalCopy);
    expect(normalCopy.length).toBeGreaterThan(20);
  });

  // T9 — eine lange Rechnung bricht weiterhin gleich um.
  it('T9: eine mehrseitige Rechnung behält Seitenzahl und Umbrüche', async () => {
    const lang = invoice({ positions: manyPositions(60), subtotal: 6000, amount: 7140 });

    const normal = captureDrawnText();
    const normalBytes = await normalOf(lang);
    const normalCopy = [...normal];
    vi.restoreAllMocks();

    const archival = captureDrawnText();
    const archivalBytes = await pdfaOf(lang);

    expect(archival).toEqual(normalCopy);
    expect((await PDFDocument.load(archivalBytes)).getPageCount()).toBe(
      (await PDFDocument.load(normalBytes)).getPageCount(),
    );
    expect((await PDFDocument.load(archivalBytes)).getPageCount()).toBeGreaterThan(1);
  });

  // T10 — ein Logo mit Alphakanal ist der Fall, an dem PDF/A gern scheitert.
  it('T10: ein transparentes Logo wird eingebettet und bleibt erhalten', async () => {
    const mitLogo = invoice({
      companySnapshot: {
        ...companySnapshot,
        logoDataUrl: `data:image/png;base64,${PNG_BASE64}`,
      },
    } as Partial<VorgangInvoice>);

    const loaded = await PDFDocument.load(await pdfaOf(mitLogo));
    let images = 0;
    let softMasks = 0;
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFRawStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.asString() === '/Image') images += 1;
      if (dict.has(PDFName.of('SMask'))) softMasks += 1;
    }

    expect(images).toBeGreaterThan(0);
    // Die Transparenz bleibt erhalten — sie wird nicht wegnormalisiert.
    expect(softMasks).toBeGreaterThan(0);
  });

  // T11 — der Realfall aus PDF-TEXT-RENDERING-01B, jetzt auch im Archivbeleg.
  it('T11: Umlaute, türkische Zeichen und Typografie überstehen die Verpackung', async () => {
    const unicode = invoice({
      companySnapshot: { ...companySnapshot, companyName: 'Çırmak Şahin Ağaç İşleri GmbH' },
      positions: [
        {
          id: 'l1',
          orderPositionId: 'o1',
          description: 'Sonderzeichen: € § ½ – — „ " ± × ÷ ≤ ≥ • † ‰',
          quantity: 1,
          unit: 'Pauschal',
          unitPrice: 520,
          lineTotal: 520,
        },
      ],
    } as Partial<VorgangInvoice>);

    const drawn = captureDrawnText();
    await pdfaOf(unicode);

    const text = drawn.join('\n');
    expect(text).toContain('Çırmak Şahin Ağaç İşleri GmbH');
    expect(text).toContain('€');
    expect(text).toContain('§');
    expect(text).not.toContain('?rmak');
  });
});

describe('E-RECHNUNG-04E1 — alle Belegarten', () => {
  // T12/T13/T14 — die Steuerfälle und die freie Rechnung.
  it.each([
    ['T12: §13b Reverse Charge', invoice({ taxStatus: 'reverse_charge_13b', amount: 520 })],
    ['T13: Kleinunternehmer', invoice({ taxStatus: 'kleinunternehmer_19', amount: 520 })],
    [
      'T14: manuelle Rechnung ohne Auftrag',
      invoice({ vorgangTitle: undefined, baustelle: undefined } as Partial<VorgangInvoice>),
    ],
  ])('%s ergibt ein vollständiges PDF/A-Dokument', async (_label, value) => {
    const bytes = await pdfaOf(value);
    const loaded = await PDFDocument.load(bytes);

    expect(loaded.catalog.has(PDFName.of('Metadata'))).toBe(true);
    expect(loaded.catalog.has(PDFName.of('OutputIntents'))).toBe(true);
    expect(await readXmp(bytes)).toContain('<pdfaid:part>3</pdfaid:part>');
  });
});

describe('E-RECHNUNG-04E1 — keine Aussenwelt im Archivbeleg', () => {
  // T15 — ein Archivbeleg, der etwas nachlädt, ist kein Archivbeleg.
  it('T15: das Dokument enthält keine externen oder ausführbaren Verweise', async () => {
    const loaded = await PDFDocument.load(await pdfaOf(invoice()));

    const verboten = ['JavaScript', 'JS', 'Launch', 'URI', 'GoToR', 'Movie', 'Sound', 'RichMedia'];
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFRawStream ? object.dict : object;
      if (!(dict instanceof PDFDict)) continue;
      for (const key of verboten) {
        expect(
          dict.has(PDFName.of(key)),
          `unerwarteter Eintrag /${key} im Dokument`,
        ).toBe(false);
      }
    }

    expect(loaded.catalog.has(PDFName.of('OpenAction'))).toBe(false);
    expect(loaded.catalog.has(PDFName.of('AcroForm'))).toBe(false);
  });

  // T16 — trotz aller Struktur bleibt es ein ganz gewöhnlich lesbares PDF.
  it('T16: das Dokument lässt sich normal öffnen und trägt eine Dokumentkennung', async () => {
    const bytes = await pdfaOf(invoice());

    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(0);

    // Regel 6.1.3-1: ohne /ID im Trailer ist das Dokument nicht konform.
    const id = loaded.context.trailerInfo.ID as PDFArray;
    expect(id.size()).toBe(2);
    expect(id.lookup(0, PDFHexString).asString()).toBe(id.lookup(1, PDFHexString).asString());
  });
});

describe('E-RECHNUNG-04E1 — Determinismus', () => {
  // T17 — derselbe Beleg zweimal erzeugt ist zweimal dieselbe Datei.
  it('T17: zweimaliges Erzeugen liefert byteidentische Dokumente', async () => {
    const [erst, zweit] = [await pdfaOf(invoice()), await pdfaOf(invoice())];
    expect(zweit).toEqual(erst);
  });

  // T18 — und die Dokumentkennung ist abgeleitet, nicht gewürfelt.
  it('T18: die Dokumentkennung hängt am Beleg, nicht an der Uhr', () => {
    const a = buildDeterministicFileId('officetakt:invoice:2026-0042:2026-06-01');
    expect(buildDeterministicFileId('officetakt:invoice:2026-0042:2026-06-01')).toBe(a);
    expect(buildDeterministicFileId('officetakt:invoice:2026-0043:2026-06-01')).not.toBe(a);
    expect(a).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe('E-RECHNUNG-04E1 — Vorbereitung der Einbettung für 04E2', () => {
  /*
   * T19/T20 — die Struktur, auf der ZUGFeRD später aufsetzt. Ausdrücklich noch
   * **keine** ZUGFeRD-Rechnung: Hier wird nur nachgewiesen, dass ein PDF/A-3
   * einen Anhang so tragen kann, wie der Standard es verlangt. Eingebettet wird
   * dabei eine echte, vom KoSIT-Validator akzeptierte XRechnung und keine
   * Attrappe.
   */
  async function mitAnhang(): Promise<PDFDocument> {
    const basis = await PDFDocument.load(await pdfaOf(invoice()), { updateMetadata: false });
    const xml = await readFile(
      path.resolve(process.cwd(), 'src/services/einvoice/__goldfiles__/01-standard-19.xml'),
    );
    attachPdfAFile(basis, {
      fileName: 'rechnung.xml',
      mimeType: 'application/xml',
      relationship: 'Alternative',
      bytes: new Uint8Array(xml),
      description: 'Strukturierte Rechnungsdaten',
      modifiedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    return PDFDocument.load(await basis.save(), { updateMetadata: false });
  }

  it('T19: der Anhang trägt Dateiname, Medientyp und Beziehung', async () => {
    const loaded = await mitAnhang();

    const af = loaded.catalog.lookup(PDFName.of('AF'), PDFArray);
    expect(af.size()).toBe(1);
    const fileSpec = af.lookup(0, PDFDict);

    expect(fileSpec.lookup(PDFName.of('Type'), PDFName).asString()).toBe('/Filespec');
    expect(fileSpec.lookup(PDFName.of('F'), PDFString).asString()).toBe('rechnung.xml');
    expect(fileSpec.lookup(PDFName.of('UF'), PDFHexString).decodeText()).toBe('rechnung.xml');
    /*
     * `Alternative` ist die Beziehung, die eine hybride Rechnung braucht: Das
     * XML ist eine gleichwertige Darstellung desselben Belegs, kein Beiwerk.
     */
    expect(fileSpec.lookup(PDFName.of('AFRelationship'), PDFName).asString()).toBe('/Alternative');

    const embedded = fileSpec
      .lookup(PDFName.of('EF'), PDFDict)
      .lookup(PDFName.of('F'), PDFRawStream);
    expect(embedded.dict.lookup(PDFName.of('Type'), PDFName).asString()).toBe('/EmbeddedFile');
    expect(embedded.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText()).toBe(
      'application/xml',
    );
  });

  it('T20: der Anhang hängt zugleich im Namensbaum und verdrängt nichts', async () => {
    const loaded = await mitAnhang();

    const names = loaded.catalog
      .lookup(PDFName.of('Names'), PDFDict)
      .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray);
    expect(names.size()).toBe(2);
    expect(names.lookup(0, PDFHexString).decodeText()).toBe('rechnung.xml');

    // Metadaten und OutputIntent überstehen das Anhängen unbeschadet.
    expect(loaded.catalog.has(PDFName.of('Metadata'))).toBe(true);
    expect(loaded.catalog.has(PDFName.of('OutputIntents'))).toBe(true);
  });
});
