import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DocumentAssistantPanel } from './components/documents/DocumentAssistantPanel';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createAuftragInboxItem } from './test/fixtures';
import type { InboxItem, WorkflowResult } from './types/models';
import { SAMPLE_WERKVERTRAG_TEXT } from './services/contractAnalysisService';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import { t, type TranslationKey } from './i18n';

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

function cloneInbox(item: InboxItem, overrides: Partial<InboxItem> = {}): InboxItem {
  const { recognizedData: recognizedOverride, ...rest } = overrides;
  return {
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    ...rest,
    recognizedData: {
      ...item.recognizedData,
      ...(recognizedOverride ?? {}),
    },
  };
}

function createContractItem(): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-assistant-compact-contract',
    title: 'Werkvertrag Compact',
    classifiedKind: 'werkvertrag',
    documentType: 'werkvertrag',
    sender: 'Isobautec GmbH',
    fileRefId: 'file-ref-assistant-compact',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      Betreff: 'Mustermann Sanitär GmbH',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      _extractedText: SAMPLE_WERKVERTRAG_TEXT,
    },
  });
}

function createNonContractItem(): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-assistant-compact-auftrag',
    title: 'Kleiner Auftrag',
    classifiedKind: 'auftrag',
    sender: 'Test Kunde',
    fileRefId: 'file-ref-assistant-compact-auftrag',
    recognizedData: {
      Leistung: 'Reparatur',
      Angebotssumme: '120 €',
      Betreff: 'Mustermann Sanitär GmbH',
    },
  });
}

function minimalWorkflow(item: InboxItem): WorkflowResult {
  return {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: { status: 'relevant', reasons: [] },
    classifiedKind: item.classifiedKind ?? 'auftrag',
    classificationConfidence: 'high',
    classification: {
      documentType: item.documentType,
      classifiedKind: item.classifiedKind ?? 'auftrag',
      digitalFolder: item.digitalFolder,
      paperFiling: item.paperFiling,
      recommendedAction: item.recommendedAction,
      suggestedVorgang: null,
    },
    documentExplanation: null,
    documentUnderstanding: null,
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: item.digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions: [],
  } as WorkflowResult;
}

function assertOrder(html: string, earlier: string, later: string) {
  const earlyIdx = html.indexOf(earlier);
  const lateIdx = html.indexOf(later);
  expect(earlyIdx, `missing ${earlier}`).toBeGreaterThan(-1);
  expect(lateIdx, `missing ${later}`).toBeGreaterThan(-1);
  expect(earlyIdx).toBeLessThan(lateIdx);
}

describe('CONTRACT-WORKSPACE-ASSISTANT-COMPACT-01', () => {
  beforeEach(() => {    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    resetTestStores();
  });

  it('Fall A: Contract-Proposal → Assistant ausgeblendet (UX-02)', () => {
    const item = createContractItem();
    const html = renderToStaticMarkup(
      createElement(DocumentAssistantPanel, {
        item,
        workflow: minimalWorkflow(item),
        translate,
        language: 'de' as const,
        compactForContractWorkspace: true,
      }),
    );

    expect(html).toBe('');
    expect(html).not.toContain('data-testid="document-assistant-panel"');
    expect(html).not.toContain(translate('docAssistant.recognized'));
    expect(html).not.toContain('data-testid="document-guidance-panel"');
  });

  it('Fall B: Contract-Compact rendert keinen aufklappbaren Assistant mehr', async () => {
    const item = createContractItem();
    const host = document.createElement('div');
    document.body.appendChild(host);
    let root: Root | null = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(DocumentAssistantPanel, {
          item,
          workflow: minimalWorkflow(item),
          translate,
          language: 'de' as const,
          compactForContractWorkspace: true,
          showChangeType: true,
          onChangeType: vi.fn(),
        }),
      );
    });

    expect(host.querySelector('[data-testid="document-assistant-panel"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="review-section-toggle-assistant-details"]'),
    ).toBeNull();

    await act(async () => {
      root?.unmount();
    });
    root = null;
    host.remove();
  });

  it('Fall C: ohne Contract-Proposal → bisheriges Verhalten', () => {
    const item = createNonContractItem();
    const html = renderToStaticMarkup(
      createElement(DocumentAssistantPanel, {
        item,
        workflow: minimalWorkflow(item),
        translate,
        language: 'de' as const,
        compactForContractWorkspace: false,
      }),
    );

    expect(html).not.toContain('data-compact="true"');
    expect(html).toContain('data-testid="document-guidance-panel"');
    expect(html).toContain(translate('docGuidance.title'));
    expect(html).toContain(translate('docGuidance.q.what'));
    expect(html).toContain('data-testid="doc-assistant-details"');
  });

  it('Fall D: Workspace-Reihenfolge unverändert, Assistant kompakt auf Page', () => {
    const item = createContractItem();
    hydrateInboxStore([item]);

    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${item.id}`] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
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

    expect(html).toContain('contract-order-proposal');
    expect(html).toContain('data-testid="auftragskarte"');
    // UX-02: document assistant is hidden on contract first paint.
    expect(html).not.toContain('data-testid="document-assistant-panel"');
    expect(html).not.toContain('data-testid="operational-overview"');
    expect(html).toContain('Werkvertrag');
    expect(html).toContain('Kurz zusammengefasst');
    expect(html).toContain('Vertrag anzeigen');
    expect(html).toContain('Technische Details');
    assertOrder(html, 'data-testid="contract-chef-primary-action"', 'data-testid="auftragskarte-contract"');
    assertOrder(html, 'data-testid="auftragskarte-contract"', 'data-testid="auftragskarte-details"');
    expect(html).not.toMatch(/data-testid="auftragskarte-contract"[^>]*\sopen[\s>]/);
    expect(html).not.toMatch(/data-testid="auftragskarte-details"[^>]*\sopen[\s>]/);
    assertOrder(html, 'data-testid="auftragskarte-contract"', 'data-testid="contract-workspace-summary"');
    expect(html).not.toContain('data-testid="contract-order-lv-overview"');
    assertOrder(html, 'data-testid="auftragskarte"', 'data-testid="ablage-original-file"');
  });
});
