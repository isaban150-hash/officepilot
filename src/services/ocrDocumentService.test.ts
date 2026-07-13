import { afterEach, describe, expect, it } from 'vitest';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { detectClassifiedKind } from './documentClassificationService';
import { hydrateDocumentStore, importInboxDocument } from './documentService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { processUpload } from './inboxService';
import { resetMemory, getProofMemories } from './officePilotMemoryService';
import { analyzeContractFromInbox } from './contractAnalysisService';
import {
  buildOcrPreviewSummary,
  extractDocumentText,
  OCR_TEXT_HINT_KEYS,
  setImageOcrExtractorForTests,
} from './ocrDocumentService';
import {
  extractTextFromPdfBytes,
  setPdfTextExtractorForTests,
} from './uploadTextExtractionService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';

const CONTRACT_PDF_TEXT = `
Bau-Subunternehmervertrag
Werkvertrag
Auftraggeber: Müller Bau GmbH
Freistellungsbescheinigung, BG BAU Unbedenklichkeitsbescheinigung
`.trim();

const FREISTELLUNG_OCR_TEXT = `
Freistellungsbescheinigung nach §48b EStG
Finanzamt München
Gültig bis 31.12.2026
`.trim();

function createFile(name: string, type: string, content = 'binary'): File {
  return new File([content], name, { type });
}

describe('ocrDocumentService', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    setPdfTextExtractorForTests(null);
  });

  it('PDF-Text läuft weiter über extractDocumentText', async () => {
    setPdfTextExtractorForTests(() => CONTRACT_PDF_TEXT);
    const file = createFile('scan.pdf', 'application/pdf');
    const result = await extractDocumentText(file);
    expect(result.sourceType).toBe('pdf');
    expect(result.recognizedText).toContain('Werkvertrag');
    expect(result.confidence).not.toBe('none');
  });

  it('JPG/PNG OCR liefert recognizedText', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: FREISTELLUNG_OCR_TEXT,
      confidence: 82,
    }));
    const file = createFile('scan.jpg', 'image/jpeg');
    const result = await extractDocumentText(file);
    expect(result.sourceType).toBe('image');
    expect(result.recognizedText).toContain('Freistellungsbescheinigung');
    expect(result.confidence).toBe('high');
  });

  it('OCR-Text führt zu korrekter Klassifizierung', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: CONTRACT_PDF_TEXT,
      confidence: 80,
    }));
    const file = createFile('photo.jpg', 'image/jpeg');
    const extraction = await extractDocumentText(file);
    const kind = detectClassifiedKind({
      sourceFileName: file.name,
      recognizedText: extraction.recognizedText,
    });
    expect(['werkvertrag', 'subunternehmervertrag']).toContain(kind);
  });

  it('Werkvertrag als Foto/Text → ContractAnalysis', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: SAMPLE_WERKVERTRAG_TEXT,
      confidence: 78,
    }));
    const extraction = await extractDocumentText(createFile('vertrag.png', 'image/png'));
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'vertrag.png',
      recognizedText: extraction.recognizedText,
    });
    expect(analyzeContractFromInbox(item).isContract).toBe(true);
  });

  it('Freistellung als Foto/Text → ProofMemory über bestehende Pipeline', () => {
    resetMemory();
    hydrateDocumentStore([]);
    const inboxItem = createMockInboxItemFromUpload({
      sourceFileName: 'freistellung.jpg',
      recognizedText: FREISTELLUNG_OCR_TEXT,
    });
    const item = {
      ...inboxItem,
      classifiedKind: 'freistellungsbescheinigung' as const,
      documentType: 'behoerde' as const,
      sender: 'Finanzamt München',
      deadline: '2026-12-31',
      recognizedData: withInboxExtractedDocumentText(
        { Dokument: 'Freistellungsbescheinigung nach §48b EStG' },
        FREISTELLUNG_OCR_TEXT,
      ),
    };

    const result = importInboxDocument(item, 'Test GmbH');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      getProofMemories().some(
        (proof) => proof.proofType === 'freistellungsbescheinigung' && proof.status === 'valid',
      ),
    ).toBe(true);
  });

  it('schlechter Scan → Hinweis/low confidence', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: 'abc',
      confidence: 20,
    }));
    const result = await extractDocumentText(createFile('bad.jpg', 'image/jpeg'));
    expect(result.confidence).toBe('low');
    expect(result.qualityHintKey).toBe(OCR_TEXT_HINT_KEYS.partial);
  });

  it('leeres Bild → ehrliche Fehlermeldung', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: '   ',
      confidence: 0,
    }));
    const result = await extractDocumentText(createFile('empty.png', 'image/png'));
    expect(result.errorCode).toBe('no_text');
    expect(result.messageKey).toBe(OCR_TEXT_HINT_KEYS.noText);
    expect(result.recognizedText).toBe('');
  });

  it('nicht unterstütztes Format → Fehlermeldung', async () => {
    const result = await extractDocumentText(createFile('doc.docx', 'application/msword'));
    expect(result.errorCode).toBe('unsupported_format');
    expect(result.recognizedText).toBe('');
  });

  it('HEIC/HEIF → früher Abbruch ohne OCR', async () => {
    const result = await extractDocumentText(createFile('iphone.heic', 'image/heic'));
    expect(result.errorCode).toBe('heic_unsupported');
    expect(result.recognizedText).toBe('');
  });

  it('buildOcrPreviewSummary nutzt dieselbe Upload-Klassifizierung', () => {
    const preview = buildOcrPreviewSummary('scan.jpg', CONTRACT_PDF_TEXT);
    expect(preview.previewLines.length).toBeGreaterThan(0);
    expect(preview.documentTypeLabelKey).toBeTruthy();
  });

  it('keine zweite Pipeline – processUpload bleibt Einstieg', async () => {
    setImageOcrExtractorForTests(async () => ({
      text: CONTRACT_PDF_TEXT,
      confidence: 85,
    }));
    const extraction = await extractDocumentText(createFile('scan.jpg', 'image/jpeg'));
    const item = processUpload({
      sourceFileName: 'scan.jpg',
      recognizedText: extraction.recognizedText,
    });
    expect(item.recognizedData._extractedText).toContain('Werkvertrag');
    expect(item.classifiedKind).toBeTruthy();
  });
});

describe('uploadTextExtractionService integration', () => {
  afterEach(() => {
    setPdfTextExtractorForTests(null);
    setImageOcrExtractorForTests(null);
  });

  it('bestehende PDF-Erkennung bleibt grün', () => {
    const pdfLike = 'BT (Bau-Subunternehmervertrag) Tj (Werkvertrag) Tj ET';
    const text = extractTextFromPdfBytes(new TextEncoder().encode(pdfLike));
    expect(text).toContain('Werkvertrag');
  });
});
