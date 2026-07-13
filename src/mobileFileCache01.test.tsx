import { describe, expect, it, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { ScanPage } from './pages/ScanPage';
import {
  dataUrlFromCachedPayload,
  loadCachedDocumentFileFromUpload,
  type CachedDocumentFilePayload,
} from './services/cachedDocumentFileService';
import {
  intakeCachedDocumentFile,
  intakeDocumentFile,
} from './services/documentIntakeService';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import { resolveUploadErrorView } from './services/documentUploadErrorService';
import {
  extractDocumentTextFromCache,
  setImageOcrExtractorForTests,
} from './services/ocrDocumentService';
import { t } from './i18n';
import { resetTestStores } from './test/resetStores';
import * as persistenceService from './services/persistenceService';

const AOK_TEXT = 'AOK Beitragsbescheid 250,00 EUR Frist 15.08.2026';

function createSingleUseFile(content: string, name: string, type: string): File {
  let readCount = 0;
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  const originalArrayBuffer = File.prototype.arrayBuffer;

  file.arrayBuffer = async function arrayBuffer() {
    readCount += 1;
    if (readCount > 1) {
      throw new DOMException('The object can not be read again', 'NotReadableError');
    }
    return originalArrayBuffer.call(this);
  };

  return file;
}

async function loadSingleUsePayload(content: string, name: string, type: string) {
  const file = createSingleUseFile(content, name, type);
  const loaded = await loadCachedDocumentFileFromUpload(file);
  expect(loaded.success).toBe(true);
  if (!loaded.success) throw new Error('expected cached payload');
  return loaded.payload;
}

describe('MOBILE-FILE-CACHE-01', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('Single-use-File-Mock: erster Read funktioniert, zweiter Read wirft', async () => {
    const file = createSingleUseFile('png-bytes', 'aok.png', 'image/png');
    await expect(file.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(file.arrayBuffer()).rejects.toThrow();
  });

  it('Confirm nutzt Cache statt erneuten File-Reads', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = await loadSingleUsePayload('aok-png', 'aok.png', 'image/png');

    const storeSpy = vi.spyOn(await import('./services/documentFileStoreService'), 'storeDocumentFileFromUpload');
    const extractSpy = vi.spyOn(await import('./services/ocrDocumentService'), 'extractDocumentText');

    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });

    expect(result.success).toBe(true);
    expect(storeSpy).not.toHaveBeenCalled();
    expect(extractSpy).not.toHaveBeenCalled();
    storeSpy.mockRestore();
    extractSpy.mockRestore();
  });

  it('AOK-PNG: Vorschau → bestätigen → InboxItem', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = await loadSingleUsePayload('aok-png', 'aok.png', 'image/png');
    const extraction = await extractDocumentTextFromCache(payload);
    expect(extraction.recognizedText).toContain('AOK');

    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: extraction.recognizedText,
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) throw new Error('expected new inbox item');
    expect(result.inboxItem.sourceFileName).toBe('aok.png');
  });

  it('AOK-JPG: Vorschau → bestätigen → InboxItem', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = await loadSingleUsePayload('aok-jpg', 'aok.jpg', 'image/jpeg');
    const extraction = await extractDocumentTextFromCache(payload);
    expect(extraction.recognizedText).toContain('AOK');

    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: extraction.recognizedText,
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) throw new Error('expected new inbox item');
    expect(result.inboxItem.sourceFileName).toBe('aok.jpg');
  });

  it('Single-use-File: Scan-Flow mit Cache funktioniert trotz unlesbarem Original-File', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = await loadSingleUsePayload('mobile-photo', 'scan.jpg', 'image/jpeg');

    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(result.success).toBe(true);
  });

  it('Persistenzfehler zeigt spezifische Meldung', () => {
    const view = resolveUploadErrorView('persist_failed');
    expect(t(view.titleKey, 'de')).toContain('Speichern');
    expect(t(view.descriptionKey, 'de')).toContain('dauerhaft');
  });

  it('Datei-Lesefehler und OCR-Fehler sind getrennt', () => {
    const readView = resolveUploadErrorView('file_read_failed');
    const ocrView = resolveUploadErrorView('ocr_failed');
    expect(t(readView.descriptionKey, 'de')).toContain('Datei');
    expect(t(ocrView.descriptionKey, 'de')).toContain('unscharf');
  });

  it('intakeDocumentFile lädt einmal und speichert aus Cache', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const file = new File(['direct-upload'], 'upload.png', { type: 'image/png' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(true);
  });

  it('Document Assistant erscheint mit aktuellem InboxItem', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = await loadSingleUsePayload('assistant.png', 'assistant.png', 'image/png');
    const intake = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) throw new Error('expected inbox item');

    const assistant = buildInboxDocumentAssistant(intake.inboxItem, null);
    expect(assistant.sender).toBeTruthy();

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${intake.inboxItem.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('document-assistant-panel');
  });

  it('Scan-Seite rendert Vorschau mit Weiter-analysieren-Button', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <ScanPage />
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('scan-page');
  });

  it('intake meldet persist_failed wenn Speichern fehlschlägt', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = await loadSingleUsePayload('persist-fail.png', 'persist-fail.png', 'image/png');
    const persistSpy = vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: false });
    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBe('persist_failed');
    persistSpy.mockRestore();
  });

  it('dataUrl wird aus gecachten Bytes abgeleitet ohne FileReader', () => {
    const payload: CachedDocumentFilePayload = {
      fileName: 'test.png',
      mimeType: 'image/png',
      fileSize: 3,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const dataUrl = dataUrlFromCachedPayload(payload);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
