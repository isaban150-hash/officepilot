import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t, type TranslationKey } from './i18n';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { hydrateVorgangStore } from './services/vorgangService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { InboxItem } from './types/models';
import * as persistenceService from './services/persistenceService';
import * as documentAiService from './services/document/documentAiService';
import { setAiGenerateTextForTests } from './services/ai/aiRequestRunner';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function createBgBauItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createMockInboxItemFromUpload({
      sourceFileName: 'bg.pdf',
      recognizedText: [
        'BG BAU Beitragsbescheid',
        'Absender: BG BAU',
        'Frist: 15.08.2026',
        'Betrag: 250,00 EUR',
      ].join('\n'),
      kind: 'bg_bau',
    }),
    id: 'inbox-assist-consolidate-bg',
    title: 'Beitragsbescheid 2026',
    sender: 'BG BAU',
    classifiedKind: 'bg_bau',
    documentType: 'behoerde',
    markedAsCompanyDocument: true,
    fileRefId: 'file-ref-assist-consolidate',
    ...overrides,
  };
}

function createAuftragItem(): InboxItem {
  return {
    ...createAuftragInboxItem({
      id: 'inbox-assist-consolidate-auftrag',
      classifiedKind: 'auftrag',
      documentType: 'kundenauftrag',
      fileRefId: 'file-ref-assist-auftrag',
    }),
  };
}

function renderHtml(itemId: string): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [`/ablage/${itemId}`] },
      createElement(
        AppProvider,
        { initialSetup: setupComplete },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/ablage/:id',
            element: createElement(EingangDetailPage),
          }),
        ),
      ),
    ),
  );
}

function assertOrder(html: string, earlier: string, later: string): void {
  const earlyIdx = html.indexOf(earlier);
  const lateIdx = html.indexOf(later);
  expect(earlyIdx, `missing ${earlier}`).toBeGreaterThan(-1);
  expect(lateIdx, `missing ${later}`).toBeGreaterThan(-1);
  expect(earlyIdx).toBeLessThan(lateIdx);
}

type Mount = { container: HTMLDivElement; root: Root };

async function mountDetail(itemId: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${itemId}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement(EingangDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

describe('DOCUMENT-ASSIST-EINGANG-SURFACE-CONSOLIDATE-01', () => {
  beforeEach(() => {
    resetTestStores();
    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    vi.stubEnv('VITE_GEMINI_API_KEY', 'test-gemini-key');
    setAiGenerateTextForTests(
      vi.fn().mockResolvedValue({
        success: true,
        text: 'Lokale Testantwort.',
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setAiGenerateTextForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
    document.body.innerHTML = '';
  });

  it('unterstützte Dokumentarten zeigen die neue feste Reihenfolge (inkl. Mobil-Spur)', () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const html = renderHtml(item.id);

    expect(html).toContain('data-testid="eingang-assist-flow"');
    expect(html).toContain('data-assist-flow="consolidated"');
    expect(html).toContain('eingang-assist-flow');

    assertOrder(html, 'data-testid="document-assistant-panel"', 'data-testid="document-review-experience"');
    assertOrder(
      html,
      'data-testid="document-review-experience"',
      'data-testid="document-field-fill-confirm-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-field-fill-confirm-panel"',
      'data-testid="document-free-question-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-free-question-panel"',
      'data-testid="document-contextual-next-steps-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-contextual-next-steps-panel"',
      'data-testid="document-confirmed-reply-draft-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-confirmed-reply-draft-panel"',
      'data-testid="ablage-original-file"',
    );

    // Non-compact understand: guidance visible; trust/details stay collapsed
    expect(html).not.toContain('data-compact="true"');
    expect(html).toContain('data-testid="document-guidance-panel"');
    expect(html).toContain(translate('docGuidance.title'));
    expect(html).toContain('data-testid="doc-assistant-details"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="review-section-content-assistant-details"');
    expect(html).not.toContain(`>${translate('docAssistant.section.steuerberater')}<`);
    expect(html).not.toContain(`>${translate('docAssistant.section.trust')}<`);
    // Primary lane has no generic communication integration
    expect(html).not.toContain('data-testid="eingang-communication"');
  });

  it('freie Frage bleibt sichtbar und funktionsfähig', async () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const askSpy = vi.spyOn(documentAiService, 'askDocumentAi');
    const { container, root } = await mountDetail(item.id);

    expect(container.querySelector('[data-testid="document-free-question-panel"]')).not.toBeNull();
    const input = container.querySelector(
      '[data-testid="document-free-question-input"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Was will dieses Schreiben?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="document-free-question-ask"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(askSpy).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('Fill-Confirm, Reply-Draft und Handoff bleiben funktionsfähig', async () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const { container, root } = await mountDetail(item.id);

    expect(container.querySelector('[data-testid="document-field-fill-confirm-panel"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-panel"]'),
    ).not.toBeNull();

    const confirm = container.querySelector(
      '[data-testid="document-field-fill-confirm-confirm-Absender"]',
    ) as HTMLButtonElement | null;
    if (confirm) {
      await act(async () => {
        confirm.click();
      });
    }

    const core = container.querySelector(
      '[data-testid="document-confirmed-reply-draft-core"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(core, 'Unterlagen folgen.');
      core.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="document-confirmed-reply-draft-prepare"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-result"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="document-confirmed-reply-draft-handoff"]'),
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('doppelte Hinweisflächen sind standardmäßig eingeklappt; Aufklappen zeigt Inhalte', async () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const { container, root } = await mountDetail(item.id);

    expect(container.querySelector('[data-testid="review-section-further-hints"]')).toBeNull();
    expect(container.querySelector('[data-testid="eingang-communication"]')).toBeNull();

    await act(async () => {
      (
        container.querySelector('[data-testid="document-review-more-toggle"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const furtherToggle = container.querySelector(
      '[data-testid="review-section-toggle-further-hints"]',
    ) as HTMLButtonElement;
    expect(furtherToggle).not.toBeNull();
    expect(furtherToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="review-section-content-further-hints"]')).toBeNull();

    await act(async () => {
      furtherToggle.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="review-section-content-further-hints"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="eingang-communication"]')).not.toBeNull();
    expect(container.textContent).toMatch(/Weitere Hinweise/);

    await act(async () => {
      root.unmount();
    });
  });

  it('primärer Bereich zeigt keine doppelte Kommunikationsaktion', () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const html = renderHtml(item.id);
    expect(html).toContain('data-testid="eingang-assist-flow"');
    expect(html).not.toContain('data-testid="eingang-communication"');
    expect(html).not.toContain('data-testid="eingang-communication-link');
  });

  it('Original-, Ablage- und Review-Funktionen bleiben erreichbar', async () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const { container, root } = await mountDetail(item.id);

    expect(container.querySelector('[data-testid="ablage-original-file"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-review-experience"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-review-more-toggle"]')).not.toBeNull();

    await act(async () => {
      (
        container.querySelector('[data-testid="document-review-more-toggle"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="review-section-archive"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="review-section-technical"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('andere Dokumentarten bleiben unverändert', () => {
    const item = createAuftragItem();
    hydrateInboxStore([item]);
    const html = renderHtml(item.id);

    expect(html).not.toContain('data-testid="eingang-assist-flow"');
    assertOrder(
      html,
      'data-testid="document-review-experience"',
      'data-testid="document-free-question-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-free-question-panel"',
      'data-testid="document-field-fill-confirm-panel"',
    );
    assertOrder(
      html,
      'data-testid="document-field-fill-confirm-panel"',
      'data-testid="ablage-original-file"',
    );
  });

  it('keine Persistenz durch die UI-Konsolidierung (Analyse-Flush ausgenommen)', async () => {
    const item = createBgBauItem();
    hydrateInboxStore([item]);
    const { container, root } = await mountDetail(item.id);
    // Analysis may flush DWR on mount (DOCUMENT-WORK-RESULT-PERSISTENCE-01).
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    persistSpy.mockClear();
    await act(async () => {
      (
        container.querySelector('[data-testid="document-review-more-toggle"]') as HTMLButtonElement
      ).click();
    });
    expect(persistSpy).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
