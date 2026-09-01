/**
 * PDF-TEXT-RENDERING-01B — Unicode im Rechnungs-PDF und die doppelte Projektzeile.
 *
 * Zwei belegte Fehler, sonst nichts:
 *
 * 1. Alles ausserhalb Latin-1 wurde zu `?`. Auf einer Rechnung ist der Aussteller
 *    eine Rechtsangabe — aus `Çırmak` durfte nie `Ç?rmak` werden, und eine
 *    Transliteration zu `Cirmak` wäre eine Fälschung.
 * 2. Vorgangstitel und Baustelle tragen häufig denselben Text; die Zeile erschien
 *    dann zweimal untereinander.
 *
 * Geprüft wird an dem, was das PDF tatsächlich zeichnet: `drawText` wird
 * mitgeschnitten (und weiterhin ausgeführt), zusätzlich werden die erzeugten
 * Bytes geladen. Kein Netz, keine gespeicherten Daten.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFPage } from 'pdf-lib';

import { generateApprovedInvoicePdf, toPdfSafeText } from '../invoicePdfService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { VorgangInvoice } from '../../types/models';

/** Der Name aus dem Realfall — mit `ı` (U+0131) ausserhalb von Latin-1. */
const TURKISH_COMPANY = 'Çırmak Şahin Ağaç İşleri GmbH';
const PROJECT_TITLE = '"BV Testzentrum – Süd';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  phone: '+49 89 123456',
  email: 'rechnung@muster-handwerk.de',
  taxNumber: '143/123/45678',
  invoiceFooterNotes: 'Vielen Dank.',
};

function finalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-pdf-text',
    number: '2026-0042',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Fliesenarbeiten Bad',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 55,
        lineTotal: 440,
      },
    ],
    subtotal: 440,
    taxStatus: 'standard_19',
    amount: 523.6,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '10115',
      city: 'Berlin',
      email: '',
      phone: '',
    },
    companySnapshot: { ...companySnapshot },
    legalNotices: [],
    ...overrides,
  } as unknown as VorgangInvoice;
}

/** Schneidet jeden gezeichneten Text mit, ohne das Zeichnen zu unterbinden. */
function captureDrawnText(): string[] {
  const drawn: string[] = [];
  const original = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (
    this: PDFPage,
    text: string,
    options?: Parameters<PDFPage['drawText']>[1],
  ) {
    drawn.push(text);
    return original.call(this, text, options);
  });
  return drawn;
}

/**
 * Die eingebetteten Schriftdateien im fertigen PDF.
 *
 * Nicht über den rohen Bytestrom gesucht: `pdf-lib` legt Objekte komprimiert in
 * Objektströmen ab, dort steht `/FontFile2` nirgends im Klartext. Nach dem Laden
 * liegen die Wörterbücher wieder einzeln vor.
 */
async function inspectFonts(bytes: Uint8Array): Promise<{
  embeddedFontFiles: number;
  baseFonts: string[];
}> {
  const loaded = await PDFDocument.load(bytes);
  let embeddedFontFiles = 0;
  const baseFonts: string[] = [];

  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.has(PDFName.of('FontFile2'))) embeddedFontFiles += 1;
    const baseFont = object.get(PDFName.of('BaseFont'));
    if (baseFont instanceof PDFName) baseFonts.push(baseFont.asString());
  }

  return { embeddedFontFiles, baseFonts };
}

async function pdfOf(invoice: VorgangInvoice): Promise<Uint8Array> {
  const result = await generateApprovedInvoicePdf(invoice);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('pdf failed');
  return result.bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PDF-TEXT-RENDERING-01B — Unicode', () => {
  // U1 — nur Steuerzeichen fallen weg, sonst nichts.
  it('U1: toPdfSafeText entfernt Steuerzeichen und lässt Text unangetastet', () => {
    const withControls = `A${String.fromCharCode(0)}B${String.fromCharCode(7)}C`;
    expect(toPdfSafeText(withControls)).toBe('ABC');
    expect(toPdfSafeText('Zeile\nZeile\tSpalte')).toBe('Zeile\nZeile\tSpalte');
  });

  // U2 — der Realfall.
  it('U2: türkische Zeichen bleiben unverändert erhalten', () => {
    expect(toPdfSafeText(TURKISH_COMPANY)).toBe(TURKISH_COMPANY);
    expect(toPdfSafeText('Çırmak')).not.toContain('?');
    expect(toPdfSafeText('Çırmak')).not.toBe('Cirmak');
  });

  // U3 — Typografie: Striche, Anführungszeichen, Euro, Paragraf.
  it('U3: typografische Zeichen werden nicht ersetzt', () => {
    const typography = '– — „Zitat“ € § •';
    expect(toPdfSafeText(typography)).toBe(typography);
  });

  // U4 — deutsche Sonderzeichen bleiben selbstverständlich erhalten.
  it('U4: Umlaute und ß bleiben erhalten', () => {
    expect(toPdfSafeText('Werkstraße München Öl Über')).toBe('Werkstraße München Öl Über');
  });

  // U5 — das erzeugte PDF ist gültig und trägt eine eingebettete Schrift.
  it('U5: das PDF ist ladbar und bettet eine TrueType-Schrift ein', async () => {
    const bytes = await pdfOf(
      finalizedInvoice({
        companySnapshot: { ...companySnapshot, companyName: TURKISH_COMPANY },
      } as Partial<VorgangInvoice>),
    );

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(0);

    const { embeddedFontFiles, baseFonts } = await inspectFonts(bytes);
    // `FontFile2` gibt es nur bei einer wirklich eingebetteten TrueType-Schrift.
    expect(embeddedFontFiles).toBeGreaterThan(0);
    expect(baseFonts.some((name) => name.includes('LiberationSans'))).toBe(true);
    // Keine der WinAnsi-Standardschriften mehr.
    expect(baseFonts.some((name) => /\/Helvetica/.test(name))).toBe(false);
  });

  // U6 — beide Schnitte werden eingebettet, nicht nur der Regular.
  it('U6: Regular und Bold sind beide eingebettet', async () => {
    const { embeddedFontFiles } = await inspectFonts(await pdfOf(finalizedInvoice()));
    expect(embeddedFontFiles).toBeGreaterThanOrEqual(2);
  });

  // U7 — kein Zeichen wird beim Zeichnen durch `?` ersetzt.
  it('U7: der gezeichnete Firmenname enthält kein Fragezeichen', async () => {
    const drawn = captureDrawnText();
    await pdfOf(
      finalizedInvoice({
        companySnapshot: { ...companySnapshot, companyName: TURKISH_COMPANY },
      } as Partial<VorgangInvoice>),
    );

    expect(drawn).toContain(TURKISH_COMPANY);
    expect(drawn.some((line) => line.includes('?'))).toBe(false);
  });
});

describe('PDF-TEXT-RENDERING-01B — Projektzeile', () => {
  // P1 — der belegte Fehler: gleicher Text, zweimal gedruckt.
  it('P1: identischer Titel und Baustelle erscheinen nur einmal', async () => {
    const drawn = captureDrawnText();
    await pdfOf(
      finalizedInvoice({
        vorgangTitle: PROJECT_TITLE,
        baustelle: PROJECT_TITLE,
      } as Partial<VorgangInvoice>),
    );

    expect(drawn.filter((line) => line === PROJECT_TITLE)).toHaveLength(1);
  });

  // P2 — unterschiedliche Angaben bleiben beide stehen.
  it('P2: unterschiedliche Werte werden weiterhin beide gedruckt', async () => {
    const drawn = captureDrawnText();
    await pdfOf(
      finalizedInvoice({
        vorgangTitle: PROJECT_TITLE,
        baustelle: 'Musterweg 1, 10115 Berlin',
      } as Partial<VorgangInvoice>),
    );

    expect(drawn).toContain(PROJECT_TITLE);
    expect(drawn).toContain('Musterweg 1, 10115 Berlin');
  });

  /*
   * P3 — hier wird nichts bereinigt.
   *
   * Das führende `"` stammt aus den Vorgangsdaten und ist ein eigener Fehler.
   * Das PDF gibt wieder, was gespeichert ist; still zu korrigieren würde den
   * Datenfehler verstecken.
   */
  it('P3: das führende Anführungszeichen bleibt stehen', async () => {
    const drawn = captureDrawnText();
    await pdfOf(finalizedInvoice({ vorgangTitle: PROJECT_TITLE } as Partial<VorgangInvoice>));

    expect(drawn).toContain(PROJECT_TITLE);
  });

  // P4 — ohne Baustelle bleibt es bei einer Zeile, ohne Leerzeile.
  it('P4: ohne Baustelle wird keine zweite Zeile gezeichnet', async () => {
    const drawn = captureDrawnText();
    await pdfOf(
      finalizedInvoice({ vorgangTitle: PROJECT_TITLE, baustelle: '' } as Partial<VorgangInvoice>),
    );

    expect(drawn.filter((line) => line === PROJECT_TITLE)).toHaveLength(1);
    expect(drawn).not.toContain('');
  });
});
