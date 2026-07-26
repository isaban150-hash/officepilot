import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { hydrateDocumentStore } from './services/documentService';
import { recordArchivedDocumentMemory, resetMemory } from './services/officePilotMemoryService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument } from './types/models';

const sampleDocument: CompanyDocument = {
  id: 'doc-detail-01b',
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

function seedDocumentDetail() {
  resetTestStores();
  resetMemory();
  hydrateDocumentStore([sampleDocument]);
  recordArchivedDocumentMemory(sampleDocument, {
    inboxItem: createAuftragInboxItem({
      classifiedKind: 'versicherung',
      sender: 'Allianz',
    }),
    todayIso: '2026-06-01',
  });
}

function renderDetailHtml(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/dokumente/${sampleDocument.id}`]}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <Routes>
          <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

function assertOrder(html: string, earlier: string, later: string) {
  const a = html.indexOf(earlier);
  const b = html.indexOf(later);
  expect(a, `missing ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing ${later}`).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(b);
}

type Mount = { container: HTMLDivElement; root: Root };

function mountDetail(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[`/dokumente/${sampleDocument.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

describe('APP-DESIGN-DETAIL-01B document detail work order', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    seedDocumentDetail();
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
    resetMemory();
    resetTestStores();
  });

  it('sichtbare Reihenfolge: Experience → Understanding → Filing → FreeQuestion → ShowMore', () => {
    const html = renderDetailHtml();

    assertOrder(
      html,
      'data-testid="document-detail-experience"',
      'data-testid="document-understanding-card"',
    );
    assertOrder(
      html,
      'data-testid="document-understanding-card"',
      'data-testid="document-filing-card"',
    );
    assertOrder(
      html,
      'data-testid="document-filing-card"',
      'data-testid="document-free-question-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-free-question-panel"',
      'data-testid="document-detail-show-more"',
    );

    expect(html).toContain('class="back-link"');
    expect(html.indexOf('class="back-link"')).toBeLessThan(
      html.indexOf('data-testid="document-detail-experience"'),
    );
  });

  it('Filing steht vor FreeQuestion; Lifecycle ist nicht im collapsed Stack', () => {
    const html = renderDetailHtml();

    assertOrder(
      html,
      'data-testid="document-filing-card"',
      'data-testid="document-free-question-panel"',
    );
    expect(html).not.toContain('data-testid="show-more-content"');
    expect(html).not.toContain('data-testid="document-lifecycle-card"');
    expect(html).toContain('data-testid="document-detail-show-more"');
  });

  it('Lifecycle liegt innerhalb ShowMore nach Aufklappen; keine doppelten Panels', () => {
    mounted = mountDetail();

    expect(mounted.container.querySelector('[data-testid="show-more-content"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="document-lifecycle-card"]')).toBeNull();

    const toggle = mounted.container.querySelector(
      '[data-testid="show-more-toggle"]',
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    act(() => {
      toggle!.click();
    });

    const content = mounted.container.querySelector('[data-testid="show-more-content"]');
    expect(content).not.toBeNull();
    const lifecycle = content!.querySelector('[data-testid="document-lifecycle-card"]');
    expect(lifecycle).not.toBeNull();
    expect(
      mounted.container.querySelectorAll('[data-testid="document-lifecycle-card"]'),
    ).toHaveLength(1);

    const communication = content!.querySelector('[data-testid="dokument-communication"]');
    expect(communication).not.toBeNull();
    expect(
      content!.innerHTML.indexOf('data-testid="document-lifecycle-card"'),
    ).toBeLessThan(content!.innerHTML.indexOf('data-testid="dokument-communication"'));

    expect(
      mounted.container.querySelectorAll('[data-testid="document-detail-experience"]'),
    ).toHaveLength(1);
    expect(
      mounted.container.querySelectorAll('[data-testid="document-filing-card"]'),
    ).toHaveLength(1);
    expect(
      mounted.container.querySelectorAll('[data-testid="document-free-question-panel"]'),
    ).toHaveLength(1);
    expect(
      mounted.container.querySelectorAll('[data-testid="document-understanding-card"]'),
    ).toHaveLength(1);
  });
});
