/**
 * SCAN-OCR-EVIDENCE-01B — Bild-OCR fordert Layout an und übersetzt es sofort in
 * ein eigenes, serialisierbares Modell. Rohe Tesseract-Objekte verlassen den
 * Adapter nie.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLayoutPageFromBlocks,
  recognizeImageOrCanvas,
  setOcrImageRecognizerForTests,
  setOcrRecognizerForTests,
} from './services/tesseractOcrService';
import {
  DOCUMENT_LAYOUT_MAX_SERIALIZED_BYTES,
  DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE,
  DOCUMENT_LAYOUT_VERSION,
} from './types/documentLayout';

/** Tesseract-ähnliche Blockstruktur inklusive zyklischem page-Rückverweis. */
function rawBlocks(
  rows: Array<Array<{ text: string; x0: number; y0: number; x1: number; y1: number; conf?: number }>>,
): unknown {
  const page: Record<string, unknown> = {};
  const blocks = rows.map((row) => {
    const block: Record<string, unknown> = {
      bbox: { x0: 0, y0: 0, x1: 1000, y1: 100 },
      paragraphs: [
        {
          lines: [
            {
              words: row.map((word) => ({
                text: word.text,
                confidence: word.conf ?? 90,
                bbox: { x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1 },
              })),
            },
          ],
        },
      ],
    };
    // Zyklus wie in der echten API: Block.page → Page.blocks → Block.
    block.page = page;
    return block;
  });
  page.blocks = blocks;
  return blocks;
}

describe('SCAN-OCR-EVIDENCE-01B Layouterfassung', () => {
  afterEach(() => {
    setOcrRecognizerForTests(null);
    setOcrImageRecognizerForTests(null);
    vi.restoreAllMocks();
  });

  it('rote Vorbedingung: rohe Blocks sind zyklisch und nicht serialisierbar', () => {
    const blocks = rawBlocks([[{ text: 'Test', x0: 0, y0: 0, x1: 100, y1: 30 }]]);
    expect(() => JSON.stringify(blocks)).toThrow();
  });

  it('übersetzt Blocks in das eigene Modell mit normalisierten Koordinaten', () => {
    const blocks = rawBlocks([
      [
        { text: 'Auftraggeber', x0: 100, y0: 200, x1: 400, y1: 240 },
        { text: 'Beispiel', x0: 600, y0: 200, x1: 800, y1: 240 },
      ],
    ]);

    const page = buildLayoutPageFromBlocks(blocks, { width: 1000, height: 2000 });
    expect(page).toBeDefined();
    if (!page) return;

    expect(page.version).toBe(DOCUMENT_LAYOUT_VERSION);
    expect(page.width).toBe(1000);
    expect(page.height).toBe(2000);
    expect(page.tokens).toHaveLength(2);
    expect(page.tokens[0]!.x0).toBeCloseTo(0.1);
    expect(page.tokens[0]!.y0).toBeCloseTo(0.1);
    expect(page.tokens[0]!.text).toBe('Auftraggeber');
    expect(page.tokens[0]!.id).toBe('p1-t0');
    expect(page.tokens[0]!.blockId).toBe('b0');

    // Das Ergebnis ist serialisierbar — kein Rückverweis, keine Symbole.
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('symbols');
    expect(serialized).not.toContain('choices');
    expect(serialized.length).toBeGreaterThan(0);
  });

  it('Seitengröße stammt vom Bild, nicht vom größten Token', () => {
    const blocks = rawBlocks([[{ text: 'Rand', x0: 0, y0: 0, x1: 500, y1: 50 }]]);
    const page = buildLayoutPageFromBlocks(blocks, { width: 2000, height: 4000 });
    expect(page?.tokens[0]!.x1).toBeCloseTo(0.25);
  });

  it('kappt bei Überschreitung und markiert truncated', () => {
    const many = Array.from({ length: DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE + 50 }, (_, index) => ({
      text: `w${index}`,
      x0: index,
      y0: 0,
      x1: index + 5,
      y1: 20,
    }));
    const page = buildLayoutPageFromBlocks(rawBlocks([many]), { width: 5000, height: 100 });
    expect(page?.truncated).toBe(true);
    expect(page?.tokens.length).toBe(DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE);
  });

  it('das 1-MB-Limit wird auch unterhalb der Tokengrenze durchgesetzt', () => {
    // Wenige Tokens, aber sehr lange Werte: die Bytegrenze greift zuerst.
    const longText = 'X'.repeat(2000);
    const heavy = Array.from({ length: 900 }, (_, index) => ({
      text: `${longText}${index}`,
      x0: index,
      y0: 0,
      x1: index + 5,
      y1: 20,
    }));
    expect(heavy.length).toBeLessThan(DOCUMENT_LAYOUT_MAX_TOKENS_PER_PAGE);

    const page = buildLayoutPageFromBlocks(rawBlocks([heavy]), { width: 5000, height: 100 });
    expect(page).toBeDefined();
    if (!page) return;

    const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
    expect(bytes).toBeLessThanOrEqual(DOCUMENT_LAYOUT_MAX_SERIALIZED_BYTES);
    expect(page.truncated).toBe(true);
    expect(page.tokens.length).toBeLessThan(heavy.length);
    // Dokumentreihenfolge bleibt erhalten — nicht nach Konfidenz sortiert.
    expect(page.tokens[0]!.text.endsWith('0')).toBe(true);
  });

  it('ohne Seitengröße entsteht kein Layout statt falscher Koordinaten', () => {
    const page = buildLayoutPageFromBlocks(rawBlocks([[{ text: 'X', x0: 0, y0: 0, x1: 1, y1: 1 }]]), {
      width: 0,
      height: 0,
    });
    expect(page).toBeUndefined();
  });

  it('Bildpfad reicht das Layout des Recognizers durch', async () => {
    setOcrImageRecognizerForTests(async () => ({
      text: 'Auftraggeber Beispiel',
      confidence: 88,
      layout: buildLayoutPageFromBlocks(
        rawBlocks([[{ text: 'Beispiel', x0: 10, y0: 10, x1: 100, y1: 40 }]]),
        { width: 1000, height: 1000 },
      ),
    }));

    const file = new File([new Uint8Array([1, 2, 3])], 'foto.jpg', { type: 'image/jpeg' });
    const result = await recognizeImageOrCanvas(file);
    expect(result.text).toContain('Auftraggeber');
    expect(result.layout?.tokens[0]!.text).toBe('Beispiel');
  });
});
