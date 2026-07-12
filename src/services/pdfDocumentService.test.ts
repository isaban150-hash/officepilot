import { afterEach, describe, expect, it } from 'vitest';
import {
  PDF_OCR_MAX_PAGES,
  releaseCanvas,
  resolveOcrPageLimit,
  setPdfDocumentLoaderForTests,
} from './pdfDocumentService';

describe('pdfDocumentService', () => {
  afterEach(() => {
    setPdfDocumentLoaderForTests(null);
  });

  it('begrenzt OCR-Seiten für große PDFs', () => {
    expect(resolveOcrPageLimit(30)).toBe(PDF_OCR_MAX_PAGES);
    expect(resolveOcrPageLimit(3)).toBe(3);
    expect(resolveOcrPageLimit(0)).toBe(1);
  });

  it('lädt PDF und gibt echte Seitenanzahl zurück', async () => {
    setPdfDocumentLoaderForTests(async () => ({
      pdf: {
        numPages: 4,
        destroy: async () => undefined,
      },
      pageCount: 4,
    }));

    const { getPdfPageCount } = await import('./pdfDocumentService');
    const count = await getPdfPageCount(new Uint8Array([1, 2, 3]));
    expect(count).toBe(4);
  });

  it('gibt Canvas-Speicher nach Nutzung frei', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    document.body.appendChild(canvas);
    releaseCanvas(canvas);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(document.body.contains(canvas)).toBe(false);
  });
});
