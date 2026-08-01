import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { DocumentAssistantPanel } from './components/documents/DocumentAssistantPanel';
import {
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
} from './services/document/documentAiContextService';
import { buildDocumentAiPrompt } from './services/document/documentAiPromptBuilder';
import { askDocumentAi } from './services/document/documentAiService';
import { setAiGenerateTextForTests } from './services/ai/aiRequestRunner';
import { getAllDocuments, hydrateDocumentStore } from './services/documentService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import type { CompanyDocument, InboxItem } from './types/models';
import { getCommunicationEvents, hydrateCommunicationHistory } from './services/communicationHistoryService';
import { hydrateInboxStore, getInboxItems } from './services/inboxService';
import { getAllTasksFromStore, hydrateTaskStore } from './services/taskStore';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const archiveDoc: CompanyDocument = {
  id: 'doc-fq-1',
  title: 'Freistellung',
  category: 'steuer',
  issuer: 'Finanzamt',
  recognizedText: 'Freistellungsbescheinigung gültig bis 2026-12-31',
  issueDate: '2026-01-01',
  validUntil: '2026-12-31',
  digitalFolder: { id: 'd', name: 'Steuer', path: '/Steuer/' },
  paperFolder: { folderId: 'f', register: 'A', label: 'Steuer' },
  tags: [],
  linkedCompany: 'Test GmbH',
  linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Sanierung Bad' },
  archived: true,
  classifiedKind: 'freistellungsbescheinigung',
  createdAt: '2026-01-01T12:00:00.000Z',
};

const otherDoc: CompanyDocument = {
  ...archiveDoc,
  id: 'doc-fq-other',
  title: 'GEHEIMES ANDERES DOKUMENT',
  recognizedText: 'Geheimsumme 999999 EUR SECRET-OTHER-DOC',
  linkedVorgang: null,
};

function baseInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createMockInboxItemFromUpload({
      sourceFileName: 'frage.pdf',
      recognizedText: 'BG BAU Beitragsbescheid Frist 15.08.2026',
      kind: 'bg_bau',
    }),
    ...overrides,
  };
}

type Mount = { container: HTMLDivElement; root: Root };

function mountAt(path: string, element: ReactElement): Mount {
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
            <Route path="/ablage/:id" element={element} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('DOCUMENT-FREE-QUESTION-01', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {    hydrateCommunicationHistory([]);
    hydrateTaskStore([]);
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Im Dokument steht eine Gültigkeit bis 2026-12-31.',
      }),
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
    vi.restoreAllMocks();
  });

  it('Eingang-Detail zeigt ein freies Fragenpanel', () => {
    const item = baseInbox();
    hydrateInboxStore([item]);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${item.id}`]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="document-free-question-panel"');
    expect(html).toContain('data-testid="document-free-question-input"');
    expect(html).not.toContain('data-testid="inbox-ai-panel"');
    expect(html).not.toContain('data-testid="doc-assistant-question-input"');
  });

  it('Archiv-Detail zeigt dasselbe Fragenpanel', () => {
    hydrateDocumentStore([archiveDoc]);
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/dokumente/${archiveDoc.id}`]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="document-free-question-panel"');
    expect(html).not.toContain('data-testid="document-ai-panel"');
  });

  it('auf keiner Seite doppelte Fragenpanels und keine Frage-Chips', () => {
    const item = baseInbox();
    hydrateInboxStore([item]);
    hydrateDocumentStore([archiveDoc]);

    const inboxHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${item.id}`]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    const archiveHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/dokumente/${archiveDoc.id}`]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect((inboxHtml.match(/data-testid="document-free-question-panel"/g) ?? []).length).toBe(1);
    expect((archiveHtml.match(/data-testid="document-free-question-panel"/g) ?? []).length).toBe(1);
    expect(inboxHtml).not.toContain('document-assistant-panel__chip');
    expect(archiveHtml).not.toContain('document-assistant-panel__chip');
  });

  it('DocumentAssistantPanel enthält keine Freitext-Fragen mehr', () => {
    const item = baseInbox();
    const html = renderToStaticMarkup(
      <DocumentAssistantPanel
        item={item}
        workflow={null}
        translate={(key) => t(key, 'de')}
        language="de"
      />,
    );
    expect(html).not.toContain('data-testid="doc-assistant-question-input"');
    expect(html).toContain('data-testid="document-assistant-panel"');
  });

  it('leere Frage wird nicht abgesendet', async () => {
    const generate = vi.fn().mockResolvedValue({ success: true, text: 'x' });
    setAiGenerateTextForTests(generate);
    hydrateDocumentStore([archiveDoc]);
    mounted = mountAt(`/dokumente/${archiveDoc.id}`, <DokumentDetailPage />);
    const ask = mounted.container.querySelector(
      '[data-testid="document-free-question-ask"]',
    ) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    ask.click();
    await act(async () => {
      await Promise.resolve();
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('Frage erhält nur Kontext des aktuellen Dokuments', () => {
    hydrateDocumentStore([archiveDoc, otherDoc]);
    const context = buildDocumentAiContextFromDocument(archiveDoc);
    const prompt = buildDocumentAiPrompt('Welche Frist gibt es?', context, 'de');
    expect(prompt).toContain('Freistellung');
    expect(prompt).toContain('Sanierung Bad');
    expect(prompt).not.toContain('SECRET-OTHER-DOC');
    expect(prompt).not.toContain('GEHEIMES ANDERES DOKUMENT');
    expect(prompt).not.toContain('999999');
  });

  it('Firmenstammdaten nur bei passender Frage', () => {
    const context = buildDocumentAiContextFromDocument(archiveDoc);
    const without = buildDocumentAiPrompt('Welche Frist gibt es?', context, 'de');
    const withCompany = buildDocumentAiPrompt('Wie heißt unsere Firma?', context, 'de');
    expect(without).not.toMatch(/FIRMA \(nur weil für die Frage nötig/);
    expect(withCompany).toMatch(/FIRMA \(nur weil für die Frage nötig/);
  });

  it('unsichere Felder erzeugen sichtbaren Hinweis', async () => {
    const shaky: CompanyDocument = {
      ...archiveDoc,
      id: 'doc-shaky',
      recognizedText: '',
      classifiedKind: 'sonstiges',
      linkedVorgang: null,
      issuer: '',
      validUntil: null,
      issueDate: null,
    };
    hydrateDocumentStore([shaky]);
    const answer = await askDocumentAi({
      source: { type: 'document', document: shaky },
      question: 'Was ist die Frist?',
    });
    expect(answer.uncertain).toBe(true);
    expect(answer.uncertaintyNotes?.length).toBeGreaterThan(0);
    expect(answer.uncertaintyNotes?.some((n) => /Frist|Text|beantworten|yanıtlan|документа/i.test(n))).toBe(
      true,
    );
    expect(answer.uncertaintyNotes?.some((n) => /Kunde|Auftrag|zuordnet/i.test(n))).toBe(false);
  });

  it('fehlende Information wird als fehlend bezeichnet', () => {
    const item = baseInbox({
      deadline: null,
      recognizedData: { Betreff: 'Schreiben' },
      sender: '',
    });
    const context = buildDocumentAiContextFromInbox(item);
    expect(context.missingFieldNotes.some((n) => /Frist|Absender|Text/i.test(n))).toBe(true);
    const prompt = buildDocumentAiPrompt('Gibt es eine Frist?', context, 'de');
    expect(prompt).toContain('Fehlende Informationen');
  });

  it('Antwort wird nicht in Dokument- oder Kommunikationsstores gespeichert', async () => {
    hydrateDocumentStore([archiveDoc]);
    hydrateInboxStore([baseInbox()]);
    const docsBefore = JSON.stringify(getAllDocuments());
    const inboxBefore = JSON.stringify(getInboxItems());
    const historyBefore = JSON.stringify(getCommunicationEvents());
    const tasksBefore = JSON.stringify(getAllTasksFromStore());

    await askDocumentAi({
      source: { type: 'document', document: archiveDoc },
      question: 'Was steht im Dokument?',
    });

    expect(JSON.stringify(getAllDocuments())).toBe(docsBefore);
    expect(JSON.stringify(getInboxItems())).toBe(inboxBefore);
    expect(JSON.stringify(getCommunicationEvents())).toBe(historyBefore);
    expect(JSON.stringify(getAllTasksFromStore())).toBe(tasksBefore);
  });

  it('externe KI wird nur nach Nutzerklick aufgerufen', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      text: 'Im Dokument steht eine Gültigkeit bis 2026-12-31.',
    });
    setAiGenerateTextForTests(generate);
    hydrateDocumentStore([archiveDoc]);
    mounted = mountAt(`/dokumente/${archiveDoc.id}`, <DokumentDetailPage />);
    expect(generate).not.toHaveBeenCalled();

    const input = mounted.container.querySelector(
      '[data-testid="document-free-question-input"]',
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Welche Frist gibt es?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (
        mounted!.container.querySelector(
          '[data-testid="document-free-question-ask"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('DE/TR/BG vollständig', () => {
    for (const lang of ['de', 'tr', 'bg'] as const) {
      expect(t('document.freeQuestion.title', lang).length).toBeGreaterThan(0);
      expect(t('document.freeQuestion.uncertainBadge', lang).length).toBeGreaterThan(0);
      expect(t('document.freeQuestion.note.noDeadline', lang).length).toBeGreaterThan(0);
      expect(t('document.freeQuestion.direct.unclear', lang).length).toBeGreaterThan(0);
      expect(t('document.freeQuestion.direct.noDeadline', lang).length).toBeGreaterThan(0);
      expect(t('document.freeQuestion.note.testOrSample', lang).length).toBeGreaterThan(0);
    }
  });
});
