import { afterEach, describe, expect, it } from 'vitest';
import { assessTextQuality } from './textQualityService';
import {
  extractPdfTextViaOcr,
  setPdfOcrExtractorForTests,
  shouldRunPdfOcr,
} from './pdfOcrFallbackService';
import { setPdfDocumentLoaderForTests } from './pdfDocumentService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import { extractDocumentText } from './ocrDocumentService';

const CLEAN_DIRECT = `
Werkvertrag
Auftraggeber: Müller Bau GmbH
Vertragsdatum: 15.03.2026
`.trim();

const SCANNED_OCR = `
Mahnung
Rechnungsnummer: RE-2026-8842
Betrag: 1.247,80 EUR
`.trim();

function createFile(name: string, type: string, content = 'binary'): File {
  return new File([content], name, { type });
}

describe('pdfOcrFallbackService strategy', () => {
  afterEach(() => {
    setPdfOcrExtractorForTests(null);
    setPdfDocumentLoaderForTests(null);
    setPdfTextExtractorForTests(null);
  });

  it('shouldRunPdfOcr erkennt schlechten Direkttext', () => {
    expect(shouldRunPdfOcr(assessTextQuality('/Type endobj stream'))).toBe(true);
    expect(shouldRunPdfOcr(assessTextQuality(CLEAN_DIRECT))).toBe(false);
  });

  it('überspringt OCR bei gutem Direkttext', async () => {
    let ocrCalled = false;
    setPdfTextExtractorForTests(() => CLEAN_DIRECT);
    setPdfOcrExtractorForTests(async () => {
      ocrCalled = true;
      return { text: SCANNED_OCR, confidence: 90, pagesProcessed: 1 };
    });

    const result = await extractDocumentText(createFile('digital.pdf', 'application/pdf'));
    expect(ocrCalled).toBe(false);
    expect(result.extractionMethod).toBe('pdf_direct');
    expect(result.ocrAttempted).toBe(false);
    expect(result.recognizedText).toContain('Werkvertrag');
  });

  it('startet OCR bei schlechtem Direkttext und wählt bessere Quelle', async () => {
    setPdfTextExtractorForTests(() => '/Type /Page endobj stream garbage');
    setPdfOcrExtractorForTests(async () => ({
      text: SCANNED_OCR,
      confidence: 84,
      pagesProcessed: 2,
      pageCount: 2,
    }));

    const result = await extractDocumentText(createFile('scan.pdf', 'application/pdf'));
    expect(result.ocrAttempted).toBe(true);
    expect(result.extractionMethod).toBe('pdf_ocr');
    expect(result.pagesProcessed).toBe(2);
    expect(result.recognizedText).toContain('RE-2026-8842');
  });

  it('meldet passwortgeschützte PDFs verständlich', async () => {
    setPdfTextExtractorForTests(() => '');
    setPdfOcrExtractorForTests(async () => ({
      text: '',
      confidence: 0,
      pagesProcessed: 0,
      errorCode: 'password_required',
      message: 'Passwort',
    }));

    const result = await extractDocumentText(createFile('locked.pdf', 'application/pdf'));
    expect(result.errorCode).toBe('password_required');
    expect(result.recognizedText).toBe('');
  });

  it('Test-Override bleibt für mehrseitige PDFs nutzbar', async () => {
    setPdfOcrExtractorForTests(async (_file, options) => ({
      text: 'Seite 1\nSeite 2',
      confidence: options?.pageCount && options.pageCount > 1 ? 88 : 70,
      pagesProcessed: options?.pageCount ?? 1,
    }));

    const result = await extractPdfTextViaOcr(createFile('multi.pdf', 'application/pdf'), 2);
    expect(result.text).toContain('Seite 1');
    expect(result.confidence).toBe(88);
    expect(result.pagesProcessed).toBe(2);
  });
});
