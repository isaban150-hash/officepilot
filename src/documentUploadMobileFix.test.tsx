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
import {
  extractDocumentText,
  setImageOcrExtractorForTests,
} from './services/ocrDocumentService';
import { resetTestStores } from './test/resetStores';

describe('DESIGN-SYSTEM-01A mobile upload fix', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    resetTestStores();
  });

  it('erkennt HEIC/HEIF vor der Verarbeitung', () => {
    expect(isHeicUploadFile(new File(['x'], 'photo.heic', { type: 'image/heic' }))).toBe(true);
    expect(isHeicUploadFile(new File(['x'], 'photo.heif', { type: 'image/heif' }))).toBe(true);
    expect(isHeicUploadFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))).toBe(false);
  });

  it('lehnt HEIC beim Intake mit unsupported_photo_format ab', async () => {
    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    const validation = validateUploadFile(file);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.error).toBe('unsupported_photo_format');
    }

    const result = await intakeDocumentFile(file, { importSource: 'scan' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('unsupported_photo_format');
    }
  });

  it('extractDocumentText meldet heic_unsupported ohne OCR-Lauf', async () => {
    const file = new File(['heic-bytes'], 'iphone.heic', { type: 'image/heic' });
    const result = await extractDocumentText(file);
    expect(result.errorCode).toBe('heic_unsupported');
    expect(result.recognizedText).toBe('');
  });

  it('liefert verständliche DE-/TR-Fehlermeldung für HEIC', () => {
    expect(t('document.upload.error.unsupportedPhotoFormat', 'de')).toBe(
      'Dieses Fotoformat wird noch nicht unterstützt. Bitte als JPG, PNG oder PDF hochladen.',
    );
    expect(t('document.upload.error.unsupportedPhotoFormat', 'tr')).toBe(
      'Bu fotoğraf formatı henüz desteklenmiyor. Lütfen JPG, PNG veya PDF olarak yükleyin.',
    );
    expect(resolveIntakeErrorKey('unsupported_photo_format')).toBe(
      'document.upload.error.unsupportedPhotoFormat',
    );
    expect(resolveExtractionErrorKey('heic_unsupported')).toBe(
      'document.upload.error.unsupportedPhotoFormat',
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
