import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessTextQuality,
  isLikelyPdfGarbageChunk,
  isReadableLine,
  isStructuredNumericLine,
  sanitizeExtractedText,
} from './textQualityService';
import { extractBillOfQuantitiesPositions } from './billOfQuantitiesExtractionService';
import { textItemsToPageText } from './pdfDocumentService';
import { shouldRunPdfOcr } from './pdfOcrFallbackService';

/**
 * TEXT-QUALITY-STRUCTURED-NUMERIC-LINES-01B — Zahlenzeilen sind Inhalt.
 *
 * In tabellarischen Belegen steht die tragende Information häufig in einer
 * Zeile ohne jedes Wort: Einzelpreis und Gesamtpreis einer Position. Solche
 * Zeilen fielen bisher aus dem Text, und mit ihnen die Beträge — die
 * Positionserkennung fand danach nichts mehr.
 *
 * ⚠️ Der zweite Teil dieser Datei prüft bewusst den **App-Textpfad**: erst die
 * echte Zeilenrekonstruktion, dann `sanitizeExtractedText`, dann der
 * Positionsextraktor. Genau diese Reihenfolge fehlte bisher in allen Tests —
 * sie prüften den Extraktor am rohen Text und konnten den Verlust deshalb
 * nicht sehen.
 */

/** Dieselbe Rekonstruktion, die auch die Anwendung beim Upload verwendet. */
async function readAppText(documentId: string): Promise<string> {
  const pdfPath = join(process.cwd(), 'test-world', 'documents', documentId, 'source.pdf');
  const bytes = new Uint8Array(readFileSync(pdfPath));

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    verbosity: 0,
    useWorkerFetch: false,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      pages.push(textItemsToPageText(content.items as Parameters<typeof textItemsToPageText>[0]));
    }
    return pages.join('\n').trim();
  } finally {
    await pdf.destroy();
  }
}

describe('Textqualität — strukturierte Zahlenzeilen', () => {
  it('behält eine gewöhnliche Textzeile', () => {
    const line = 'Heizungsrohrleitung verlegen und dämmen';
    expect(isReadableLine(line)).toBe(true);
    expect(sanitizeExtractedText(line)).toBe(line);
  });

  it('behält eine Preiszeile ohne jedes Wort', () => {
    const line = '12,50 € 1.200,00 €';
    expect(isStructuredNumericLine(line)).toBe(true);
    expect(isLikelyPdfGarbageChunk(line)).toBe(false);
    expect(isReadableLine(line)).toBe(true);
    expect(sanitizeExtractedText(line)).toBe(line);
  });

  it('behält eine tabellarische Mengen-/Betragsfolge', () => {
    const line = '96 12,50 1.200,00';
    expect(isStructuredNumericLine(line)).toBe(true);
    expect(isReadableLine(line)).toBe(true);
  });

  it('akzeptiert eine einzelne nackte Zahl weiterhin nicht als Inhalt', () => {
    /* Seitenzahl, Jahreszahl, lose Ziffernfolge — keine Betragsform. */
    for (const line of ['7', '2026', '123456', '0000000000000000']) {
      expect(isStructuredNumericLine(line), line).toBe(false);
      expect(isReadableLine(line), line).toBe(false);
    }
  });

  it('lässt die Garbage- und Cryptic-Prüfung unverändert scharf', () => {
    for (const line of ['endobj', 'BT', '/Type /Page', '12 34 re']) {
      expect(isLikelyPdfGarbageChunk(line), line).toBe(true);
      expect(isReadableLine(line), line).toBe(false);
    }
    expect(isReadableLine('§±¶•‡◊∆ø∂ƒ©˙∆˚¬…æ')).toBe(false);

    /*
     * Bekannte Grenze, unverändert und hier nur festgehalten: Ein
     * Zeichenketten-Operator wie `q 1 0 0 1 0 0 cm` gilt schon vor dieser
     * Änderung nicht als Rauschen — sein Anteil sinnvoller Zeichen liegt über
     * der Schwelle. Das ist kein neuer Effekt und wird hier nicht behoben.
     */
    expect(isStructuredNumericLine('q 1 0 0 1 0 0 cm')).toBe(false);
  });

  it('bewertet erkennbar kaputten Text weiterhin als nicht lesbar', () => {
    const broken = assessTextQuality('BT\nendobj\n/Type /Page\nq 1 0 0 1 0 0 cm');
    expect(broken.readable).toBe(false);
    expect(shouldRunPdfOcr(broken)).toBe(true);
  });

  it('bewertet gewöhnlichen Fliesstext weiterhin als lesbar', () => {
    const good = assessTextQuality(
      [
        'Werkvertrag zwischen Auftraggeber und Auftragnehmer',
        'Der Auftragnehmer übernimmt die nachstehend aufgeführten Werkleistungen.',
        'Die Vergütung erfolgt nach tatsächlich erbrachter Leistung.',
      ].join('\n'),
    );
    expect(good.readable).toBe(true);
    expect(shouldRunPdfOcr(good)).toBe(false);
  });
});

describe('Textqualität — App-Textpfad bis zum Positionsextraktor', () => {
  it('DOC-00036: der sanitisierte App-Text trägt die Positionen weiterhin', async () => {
    const appText = sanitizeExtractedText(await readAppText('DOC-00036'));
    const positions = extractBillOfQuantitiesPositions(appText);

    console.log(`  DOC-00036 App-Text → Positionen: ${positions.length}`);
    expect(positions).toHaveLength(3);
  });

  it('DOC-00001: ein Vertrag ohne Leistungsverzeichnis bleibt ohne Positionen', async () => {
    const appText = sanitizeExtractedText(await readAppText('DOC-00001'));
    const positions = extractBillOfQuantitiesPositions(appText);

    console.log(`  DOC-00001 App-Text → Positionen: ${positions.length}`);
    expect(positions).toHaveLength(0);
  });
});
