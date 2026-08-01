import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { describe, expect, it, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BottomNav } from './components/layout/BottomNav';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { intakeDocumentFile } from './services/documentIntakeService';
import {
  isHeicUploadFile,
  validateUploadFile,
} from './services/documentUploadValidation';
import {
  resolveExtractionErrorKey,
  resolveIntakeErrorKey,
} from './services/documentUploadErrorService';
import { setHeicToConverterForTests } from './services/heicUploadNormalizeService';
import {
  extractDocumentText,
  setImageOcrExtractorForTests,
} from './services/ocrDocumentService';
import { loadCachedDocumentFileFromUpload } from './services/cachedDocumentFileService';
import { processDocumentFileForPreview } from './services/pendingDocumentIntakeService';

useDocumentBlobDatabaseReset();

describe('DESIGN-SYSTEM-01A mobile upload fix', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    setHeicToConverterForTests(null);
  });

  it('erkennt HEIC/HEIF vor der Verarbeitung', () => {
    expect(isHeicUploadFile(new File(['x'], 'photo.heic', { type: 'image/heic' }))).toBe(true);
    expect(isHeicUploadFile(new File(['x'], 'photo.heif', { type: 'image/heif' }))).toBe(true);
    expect(isHeicUploadFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))).toBe(false);
  });

  it('akzeptiert HEIC und normalisiert zu JPEG vor dem Intake', async () => {
    setHeicToConverterForTests(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    setImageOcrExtractorForTests(async () => ({ text: 'Erkannter Text', confidence: 80 }));

    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    expect(validateUploadFile(file).valid).toBe(true);

    const cached = await loadCachedDocumentFileFromUpload(file);
    expect(cached.success).toBe(true);
    if (cached.success) {
      expect(cached.payload.mimeType).toBe('image/jpeg');
      expect(cached.payload.fileName).toBe('iphone.jpg');
    }

    const result = await intakeDocumentFile(file, { importSource: 'scan' });
    expect(result.success).toBe(true);
  });

  it('defektes HEIC liefert heic_conversion_failed ohne Speichern', async () => {
    setHeicToConverterForTests(async () => {
      throw new Error('corrupt heic');
    });

    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    const result = await intakeDocumentFile(file, { importSource: 'scan' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('heic_conversion_failed');
    }
  });

  it('extractDocumentText läuft nach HEIC→JPEG über OCR', async () => {
    setHeicToConverterForTests(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    setImageOcrExtractorForTests(async () => ({ text: 'Rechnung 123', confidence: 88 }));

    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    const result = await extractDocumentText(file);
    expect(result.errorCode).toBeUndefined();
    expect(result.recognizedText).toContain('Rechnung');
  });

  it('Preview nach HEIC→JPEG nutzt bestehende Pipeline', async () => {
    setHeicToConverterForTests(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    setImageOcrExtractorForTests(async () => ({ text: 'Lieferschein Position 1', confidence: 85 }));

    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    const preview = await processDocumentFileForPreview(file);
    expect(preview.success).toBe(true);
    if (preview.success) {
      expect(preview.pending.cachedFile.mimeType).toBe('image/jpeg');
      expect(preview.pending.cachedFile.fileName).toBe('iphone.jpg');
      expect(preview.pending.extraction.recognizedText).toContain('Lieferschein');
      expect(preview.pending.preview.documentTypeLabelKey).toBeTruthy();
    }
  });

  it('liefert verständliche DE-/TR-Fehlermeldung für HEIC-Konvertierungsfehler', () => {
    expect(t('document.upload.error.heicConversionFailed', 'de')).toBe(
      'Dieses iPhone-Foto (HEIC) konnte nicht verarbeitet werden. Bitte erneut versuchen oder als JPG speichern.',
    );
    expect(t('document.upload.error.heicConversionFailed', 'tr')).toBe(
      'Bu iPhone fotoğrafı (HEIC) işlenemedi. Lütfen tekrar deneyin veya JPG olarak kaydedin.',
    );
    expect(resolveIntakeErrorKey('heic_conversion_failed')).toBe(
      'document.upload.error.heicConversionFailed',
    );
    expect(resolveExtractionErrorKey('heic_conversion_failed')).toBe(
      'document.upload.error.heicConversionFailed',
    );
  });

  it('regression: JPG, PNG, WebP und PDF bleiben gültig', async () => {
    setImageOcrExtractorForTests(async () => ({ text: 'Erkannter Text', confidence: 80 }));

    const cases = [
      new File(['jpg'], 'scan.jpg', { type: 'image/jpeg' }),
      new File(['png'], 'scan.png', { type: 'image/png' }),
      new File(['webp'], 'scan.webp', { type: 'image/webp' }),
      new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' }),
    ];

    for (const file of cases) {
      expect(validateUploadFile(file).valid).toBe(true);
      const result = await intakeDocumentFile(file, { importSource: 'upload' });
      expect(result.success).toBe(true);
    }
  });

  it('Bottom Navigation zeigt Hauptlabels vollständig', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <BottomNav />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('bottom-nav__label');
    expect(html).toContain('>Eingang</span>');
    expect(html).toContain('>OfficePilot</span>');
    expect(html).not.toMatch(/>\s*Sca\s*</);
  });
});
