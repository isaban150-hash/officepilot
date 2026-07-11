import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { ImpressumPage } from './pages/legal/ImpressumPage';
import { TestProviders } from './test/testProviders';
import { DEFAULT_SETUP } from './data/mockData';
import { intakeDocumentFile } from './services/documentIntakeService';
import { getInboxStoreSnapshot } from './services/inboxService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { resetTestStores } from './test/resetStores';

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

function renderUploadPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/dokumente/upload']}>
        <TestProviders initialSetup={completeSetup}>
          <Routes>
            <Route path="/dokumente/upload" element={<DocumentUploadPage />} />
          </Routes>
        </TestProviders>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('DOCUMENT-01', () => {
  beforeEach(() => {
    resetTestStores();
    setImageOcrExtractorForTests(async () => ({ text: '', confidence: 0 }));
  });

  it('Upload-Seite rendert', () => {
    const { container, root } = renderUploadPage();
    expect(container.querySelector('[data-testid="document-upload-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-upload-dropzone"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('gültige Bilddatei wird in Eingang übernommen', async () => {
    const file = new File(['image-bytes'], 'foto.jpg', { type: 'image/jpeg' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(true);
    if (result.success && !result.duplicate) {
      expect(result.inboxItem.fileRefId).toBeTruthy();
      expect(result.inboxItem.sourceFileName).toBe('foto.jpg');
    }
  });

  it('gültige PDF wird akzeptiert', async () => {
    const file = new File(['%PDF-1.4'], 'angebot.pdf', { type: 'application/pdf' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(true);
  });

  it('falscher Dateityp wird abgelehnt', async () => {
    const file = new File(['hello'], 'readme.txt', { type: 'text/plain' });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('invalid_type');
    }
  });

  it('zu große Datei wird abgelehnt', async () => {
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'riesig.pdf', {
      type: 'application/pdf',
    });
    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('file_too_large');
    }
  });

  it('Dokument erscheint im Eingang nach Upload', async () => {
    await intakeDocumentFile(new File(['img'], 'liste.png', { type: 'image/png' }), {
      importSource: 'upload',
    });
    expect(getInboxStoreSnapshot().some((item) => item.sourceFileName === 'liste.png')).toBe(true);
  });

  it('Legal-Route Impressum bleibt erreichbar', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ImpressumPage />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="impressum-page"');
  });
});
