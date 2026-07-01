import { act } from 'react';
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider } from '../context/AppContext';
import { DokumentDetailPage } from './DokumentDetailPage';
import { VorgangDetailPage } from './VorgangDetailPage';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { createTestVorgang } from '../test/fixtures';
import { hydrateVorgangStore } from '../services/vorgangService';
import { setAiGenerateTextForTests } from '../services/ai/aiRequestRunner';
import type { CompanyDocument } from '../types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const sampleDocument: CompanyDocument = {
  id: 'doc-detail-ai',
  title: 'Versicherungsnachweis',
  category: 'versicherung',
  issuer: 'Allianz',
  recognizedText: 'Versicherung gültig bis 2026-12-31',
  issueDate: '2026-01-01',
  validUntil: '2026-12-31',
  digitalFolder: { id: 'd', name: 'Versicherung', path: '/Vers/' },
  paperFolder: { folderId: 'f', register: 'A', label: 'Vers' },
  tags: [],
  linkedCompany: 'Test GmbH',
  linkedVorgang: null,
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function setInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickByTestId(container: ParentNode, testId: string): void {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!element) throw new Error(`Missing element: ${testId}`);
  element.click();
}

type PageMount = { container: HTMLDivElement; root: Root };

function renderPage(path: string, element: ReactElement): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/dokumente/:id" element={element} />
            <Route path="/vorgaenge/:id" element={element} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('Detail pages AreaAiPanel', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({ success: true, text: 'Mock-Antwort aus dem Dokumentkontext.' }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
    document.body.innerHTML = '';
  });

  it('DokumentDetailPage zeigt AreaAiPanel nach Mehr anzeigen', () => {
    hydrateDocumentStore([sampleDocument]);
    mounted = renderPage('/dokumente/doc-detail-ai', <DokumentDetailPage />);
    expect(mounted.container.querySelector('[data-testid="document-detail-experience"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-ai-panel"]')).toBeNull();

    flushSync(() => clickByTestId(mounted!.container, 'show-more-toggle'));
    expect(mounted.container.querySelector('[data-testid="document-ai-panel"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Frage zu diesem Dokument');
  });

  it('VorgangDetailPage zeigt AreaAiPanel und Antwort', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-detail-ai', title: 'Test Vorgang' })]);
    mounted = renderPage('/vorgaenge/v-detail-ai', <VorgangDetailPage />);
    expect(mounted.container.querySelector('[data-testid="vorgang-detail-experience"]')).not.toBeNull();

    flushSync(() => clickByTestId(mounted!.container, 'show-more-toggle'));
    expect(mounted.container.querySelector('[data-testid="vorgang-ai-panel"]')).not.toBeNull();

    const input = mounted.container.querySelector('[data-testid="vorgang-ai-input"]') as HTMLInputElement;
    flushSync(() => setInputValue(input, 'Was ist offen?'));
    flushSync(() => clickByTestId(mounted!.container, 'vorgang-ai-ask'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[data-testid="vorgang-ai-answer-text"]')?.textContent).toContain(
      'Mock-Antwort',
    );
  });
});
