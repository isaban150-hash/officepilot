import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { describe, expect, it, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ScanPage } from './pages/ScanPage';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { t, type TranslationKey } from './i18n';
import { intakeDocumentFile } from './services/documentIntakeService';
import {
  answerInboxDocumentQuestionById,
  DOCUMENT_QUESTION_SUGGESTIONS,
} from './services/documentAssistantQuestionService';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import {
  containsInternalLabel,
  getDocumentDisplayLabelKey,
} from './services/documentDisplayLabelService';
import {
  isBlockingExtractionError,
  resolveUploadErrorView,
} from './services/documentUploadErrorService';
import {
  buildOcrPreviewSummary,
  extractDocumentText,
  setImageOcrExtractorForTests,
} from './services/ocrDocumentService';
import { addInboxItem } from './services/inboxService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';

useDocumentBlobDatabaseReset();

describe('AI-DOCUMENT-ASSISTANT-01', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
  });

  it('JPG-Upload funktioniert', async () => {
    setImageOcrExtractorForTests(async () => ({ text: 'AOK Beitragsbescheid 250,00 EUR', confidence: 85 }));
    const file = new File(['jpg'], 'scan.jpg', { type: 'image/jpeg' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(true);
  });

  it('PNG-Upload funktioniert', async () => {
    setImageOcrExtractorForTests(async () => ({ text: 'Finanzamt Schreiben', confidence: 80 }));
    const file = new File(['png'], 'scan.png', { type: 'image/png' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(true);
  });

  it('PDF-Upload funktioniert', async () => {
    const file = new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(true);
  });

  it('unscharfes Bild führt zu verständlichem Fehler', () => {
    const view = resolveUploadErrorView('ocr_failed');
    expect(t(view.titleKey, 'de')).toContain('unscharf');
    expect(view.allowRetry).toBe(true);
    expect(view.allowNewPhoto).toBe(true);
    expect(view.allowSelectFile).toBe(true);
  });

  it('beschädigte PDF führt zu verständlichem Fehler', () => {
    const view = resolveUploadErrorView('pdf_corrupt');
    expect(t(view.descriptionKey, 'de')).toContain('PDF');
    expect(isBlockingExtractionError('pdf_corrupt')).toBe(true);
  });

  it('kein lesbarer Text ist blockierender Fehler mit Folgeaktionen', () => {
    expect(isBlockingExtractionError('no_text')).toBe(true);
    const view = resolveUploadErrorView('no_text');
    expect(view.allowRetry).toBe(true);
  });

  it('Scan-Seite zeigt Auto-Erkennung statt Dokumentart-Chips', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <ScanPage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('OfficePilot erkennt die Dokumentart automatisch');
    expect(html).not.toContain('Materialrechnung');
    expect(html).not.toContain('Kontoauszug');
  });

  it('Upload-Seite enthält Fehleraktionen im Fehlerpanel', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <DocumentUploadPage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="document-upload-page"');
  });

  it('keine internen Enum-Werte in Anzeige-Labels', () => {
    const key = getDocumentDisplayLabelKey('aok', 'behoerde');
    const label = t(key, 'de');
    expect(label).toBe('AOK-Schreiben');
    expect(containsInternalLabel('behoerde (aok)')).toBe(true);
    expect(containsInternalLabel(label)).toBe(false);
  });

  it('OCR-Vorschau nutzt Display-Label statt documentType', () => {
    const preview = buildOcrPreviewSummary(
      'aok.jpg',
      'AOK Nordwest Beitragsbescheid 250,00 EUR Frist 30.04.2026',
    );
    expect(preview.documentTypeLabelKey).toBe('docAssistant.display.aokLetter');
    expect(t(preview.documentTypeLabelKey, 'de')).not.toContain('behoerde');
  });

  it('AOK-Schreiben wird verständlich erklärt', () => {
    const item = addInboxItem(
      createMockInboxItemFromUpload({
        sourceFileName: 'aok.pdf',
        recognizedText: 'AOK Beitragsbescheid 250,00 EUR bis 30.04.2026',
        kind: undefined,
      }),
    );
    const assistant = buildInboxDocumentAssistant(item);
    expect(assistant.briefLines.length).toBeGreaterThanOrEqual(3);
    expect(assistant.briefLines.length).toBeLessThanOrEqual(6);
    expect(t(assistant.documentTypeLabelKey, 'de')).toContain('AOK');
  });

  it('Frage Muss ich das bezahlen nutzt Briefkontext', () => {
    const item = addInboxItem(
      createMockInboxItemFromUpload({
        sourceFileName: 'mahnung.pdf',
        recognizedText: 'Mahnung Rechnung 500,00 EUR Zahlung bis 15.05.2026',
      }),
    );
    const assistant = buildInboxDocumentAssistant(item);
    const answer = answerInboxDocumentQuestionById(item, assistant, 'pay');
    expect(answer.answerKey).toMatch(/docAssistant\.answer\./);
  });

  it('Frage Wo abheften nennt digitalen und Papierordner', () => {
    const item = addInboxItem(
      createMockInboxItemFromUpload({
        sourceFileName: 'aok.pdf',
        recognizedText: 'AOK Beitragsbescheid',
      }),
    );
    const assistant = buildInboxDocumentAssistant(item);
    const answer = answerInboxDocumentQuestionById(item, assistant, 'file');
    const text = t(answer.answerKey, 'de')
      .replace('{digital}', assistant.digitalPath)
      .replace('{paper}', assistant.paperFolderLabel);
    expect(text).toContain(assistant.digitalPath);
    expect(assistant.paperFolderLabel).not.toBe('—');
    expect(text).toContain(assistant.paperFolderLabel);
  });

  it('Frage Darf ich das wegwerfen liefert sichere Empfehlung', () => {
    const item = addInboxItem(
      createMockInboxItemFromUpload({
        sourceFileName: 'aok.pdf',
        recognizedText: 'AOK Beitrag',
      }),
    );
    const assistant = buildInboxDocumentAssistant(item);
    const answer = answerInboxDocumentQuestionById(item, assistant, 'dispose');
    expect(['docAssistant.answer.disposeKeepTax', 'docAssistant.answer.disposeKeep', 'docAssistant.answer.disposeUncertain']).toContain(
      answer.answerKey,
    );
  });

  it('Steuerberater-Relevanz für AOK markieren', () => {
    const item = addInboxItem(
      createMockInboxItemFromUpload({
        sourceFileName: 'aok.pdf',
        recognizedText: 'AOK Beitragsbescheid',
      }),
    );
    const assistant = buildInboxDocumentAssistant(item);
    expect(['mark', 'check']).toContain(assistant.steuerberaterStatus);
  });

  it('DE/TR Parität für docAssistant Keys', () => {
    const keys = [
      'docAssistant.autoDetect',
      'docAssistant.section.brief',
      'docAssistant.question.pay',
      'docAssistant.error.retry',
      ...DOCUMENT_QUESTION_SUGGESTIONS.map((entry) => entry.labelKey),
    ];
    for (const key of keys as TranslationKey[]) {
      expect(t(key, 'de')).not.toBe(key);
      expect(t(key, 'tr')).not.toBe(key);
    }
  });

  it('extractDocumentText meldet no_text bei leerem OCR', async () => {
    setImageOcrExtractorForTests(async () => ({ text: '', confidence: 0 }));
    const result = await extractDocumentText(new File(['x'], 'blank.jpg', { type: 'image/jpeg' }));
    expect(result.errorCode).toBe('no_text');
  });
});
