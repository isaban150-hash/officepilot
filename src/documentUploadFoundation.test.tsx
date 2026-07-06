import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { DokumentePage } from './pages/DokumentePage';
import { ImpressumPage } from './pages/legal/ImpressumPage';
import { TestProviders } from './test/testProviders';
import { DEFAULT_SETUP } from './data/mockData';
import { uploadDocumentFromFile } from './services/uploadedDocumentService';
import { getAllUploadedDocuments } from './services/uploadedDocumentStore';

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
            <Route path="/dokumente" element={<DokumentePage />} />
          </Routes>
        </TestProviders>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('DOCUMENT-01', () => {
  it('Upload-Seite rendert', () => {
    const { container, root } = renderUploadPage();
    expect(container.querySelector('[data-testid="document-upload-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-upload-dropzone"]')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('gültige Bilddatei wird akzeptiert und gespeichert', async () => {
    const file = new File(['image-bytes'], 'foto.jpg', { type: 'image/jpeg' });
    const result = await uploadDocumentFromFile(file);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.status).toBe('uploaded');
      expect(result.document.fileName).toBe('foto.jpg');
      expect(result.document.uploadedAt).toBeTruthy();
    }
  });

  it('gültige PDF wird akzeptiert', async () => {
    const file = new File(['%PDF-1.4'], 'angebot.pdf', { type: 'application/pdf' });
    const result = await uploadDocumentFromFile(file);
    expect(result.success).toBe(true);
  });

  it('falscher Dateityp wird abgelehnt', async () => {
    const file = new File(['hello'], 'readme.txt', { type: 'text/plain' });
    const result = await uploadDocumentFromFile(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('invalid_type');
    }
  });

  it('zu große Datei wird abgelehnt', async () => {
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'riesig.pdf', {
      type: 'application/pdf',
    });
    const result = await uploadDocumentFromFile(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('file_too_large');
    }
  });

  it('Dokument-Eintrag wird nach Upload in der Liste angezeigt', async () => {
    await uploadDocumentFromFile(new File(['img'], 'liste.png', { type: 'image/png' }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/dokumente']}>
          <TestProviders initialSetup={completeSetup}>
            <DokumentePage />
          </TestProviders>
        </MemoryRouter>,
      );
    });
    expect(getAllUploadedDocuments().some((d) => d.fileName === 'liste.png')).toBe(true);
    expect(container.querySelector('[data-testid="uploaded-documents-table"]')).not.toBeNull();
    expect(container.textContent).toContain('liste.png');
    act(() => root.unmount());
    container.remove();
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
