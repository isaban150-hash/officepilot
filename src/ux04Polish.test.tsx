import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { AppShell } from './components/layout/AppShell';
import { EingangPage } from './pages/EingangPage';
import { AssistentPage } from './pages/AssistentPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { hydrateInboxStore, getInboxItemById, processUpload } from './services/inboxService';

const FORBIDDEN_UI_TERMS = [
  'Smart Inbox',
  'Smart Intake',
  'Demo zurücksetzen',
  'Mock-Upload',
  'Gemini',
  'KI fragen',
  'Workflow',
  'Engine',
  'OCR',
  'recognizedData',
  'Snapshot',
  'Legacy / Demo',
];

describe('UX-04 Beta Polish', () => {
  beforeEach(() => {
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blendet Demo-Reset aus der Shell aus', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <AppShell />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).not.toContain('Demo zurücksetzen');
    expect(html).not.toContain('persist.resetDemo');
  });

  it('zeigt Ablage ohne Entwicklerbegriffe', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <EingangPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="ablage-page"');
    expect(html).toContain('Ablage');
    for (const term of FORBIDDEN_UI_TERMS) {
      expect(html).not.toContain(term);
    }
  });

  it('priorisiert ScanResultPanel und klappt technische Panels ein', () => {
    const uploaded = processUpload({ kind: 'auftrag' });
    const item = getInboxItemById(uploaded.id);
    expect(item?.isNewUpload).toBe(true);

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${uploaded.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="scan-result-panel"');
    expect(html).toContain('Mehr anzeigen');
    expect(html).not.toContain('data-testid="show-more-content"');
    expect(html).not.toContain('data-testid="inbox-ai-panel"');
  });

  it('Assistent zeigt einheitliche Oberfläche', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <AssistentPage />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="assistant-page"');
    expect(html).toContain('data-testid="assistant-ask-quick"');
    expect(html).toContain('data-testid="assistant-ask-deep"');
    expect(html).toContain('Antwort aus Ihren Daten');
    expect(html).toContain('Ausführliche Antwort');
    expect(html).not.toContain('KI fragen');
    expect(html).not.toContain('Gemini');
  });
});
