/**
 * P1 A-04/A-02 — Abschluss-Rundgang R-09: Startet die Texterkennung nicht (Engine/Sprachdaten nicht ladbar, z. B.
 * offline oder gesperrtes CDN), meldet die App „Texterkennung nicht verfügbar“ statt „PDF beschädigt“ (PDF) bzw.
 * „Foto unscharf“ (Bild). Nachgestellt mit einem `tesseract.js`, dessen `createWorker` scheitert — so wie im Browser
 * der Worker-Import vom CDN.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(() => Promise.reject(new Error("NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope'"))),
}));

import { extractPdfTextViaOcr } from './pdfOcrFallbackService';
import { setPdfDocumentLoaderForTests, setPdfPageRendererForTests } from './pdfDocumentService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import { isOcrEngineUnavailableError, recognizeImageOrCanvas, setOcrRecognizerForTests } from './tesseractOcrService';
import { extractDocumentText } from './ocrDocumentService';
import { isBlockingExtractionError, resolveUploadErrorView } from './documentUploadErrorService';
import { t } from '../i18n';

function pdf(name = 'scan.pdf'): File {
  return new File(['%PDF-1.4 ohne Textebene'], name, { type: 'application/pdf' });
}

function bild(name = 'foto.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: 'image/jpeg' });
}

/** Geladene, lesbare PDF mit einer Seite (die Datei ist in Ordnung). */
function lesbarePdf(): void {
  setPdfDocumentLoaderForTests(async () => ({
    pdf: { numPages: 1, destroy: async () => undefined } as never,
    pageCount: 1,
  }));
  setPdfPageRendererForTests(async () => ({ canvas: document.createElement('canvas'), width: 10, height: 10 }) as never);
}

afterEach(() => {
  setPdfDocumentLoaderForTests(null);
  setPdfPageRendererForTests(null);
  setPdfTextExtractorForTests(null);
  setOcrRecognizerForTests(null);
});

describe('R-09 — OCR-Engine nicht verfügbar', () => {
  it('der Engine-Start scheitert als OcrEngineUnavailableError', async () => {
    const fehler = await recognizeImageOrCanvas(bild()).catch((error: unknown) => error);
    expect(isOcrEngineUnavailableError(fehler)).toBe(true);
  });

  it('PDF-OCR: errorCode ocr_unavailable statt render_failed', async () => {
    lesbarePdf();
    const result = await extractPdfTextViaOcr(pdf(), { pageCount: 1 });
    expect(result.errorCode).toBe('ocr_unavailable');
    expect(result.text).toBe('');
  });

  it('Dokument (PDF ohne Textebene): ocr_unavailable — kein pdf_corrupt', async () => {
    lesbarePdf();
    setPdfTextExtractorForTests(() => '');
    const result = await extractDocumentText(pdf());
    expect(result.errorCode).toBe('ocr_unavailable');
  });

  it('Dokument (Foto): ocr_unavailable — kein ocr_failed („Foto unscharf“)', async () => {
    const result = await extractDocumentText(bild());
    expect(result.errorCode).toBe('ocr_unavailable');
  });

  it('Anzeige: eigener Titel und Text, blockierend mit Wiederholung', () => {
    const view = resolveUploadErrorView('ocr_unavailable');
    expect(t(view.titleKey, 'de')).toBe('Texterkennung nicht verfügbar');
    expect(t(view.descriptionKey, 'de')).toContain('Die Datei ist in Ordnung');
    expect(view.allowRetry).toBe(true);
    expect(isBlockingExtractionError('ocr_unavailable')).toBe(true);
    expect(t(view.titleKey, 'tr')).not.toBe('Texterkennung nicht verfügbar');
    expect(t(view.titleKey, 'bg')).not.toBe('Texterkennung nicht verfügbar');
  });
});
