import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from './context/AppContext';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { SmartIntakeSummary } from './components/inbox/SmartIntakeSummary';
import { DEFAULT_SETUP } from './data/mockData';
import { t, type TranslationKey } from './i18n';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { hydrateVorgangStore } from './services/vorgangService';
import type {
  ContractConfirmationSnapshot,
  ContractIntelligenceResult,
  ContractOrderProposal,
  EnhancedDetectedOrderPosition,
  WorkflowResult,
} from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

async function mountProposalPanel(props: {
  proposal: ContractOrderProposal;
  item: ReturnType<typeof createAuftragInboxItem>;
}): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ContractOrderProposalPanel, {
        proposal: props.proposal,
        translate,
        item: props.item,
        onConfirmImport: vi.fn(),
      }),
    );
  });
  return { container, root };
}

async function expandLvEditor(container: HTMLElement): Promise<void> {
  const scopeToggle = container.querySelector(
    '[data-testid="auftragskarte-toggle-scope"]',
  ) as HTMLButtonElement | null;
  if (scopeToggle && scopeToggle.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      scopeToggle.click();
    });
  }
  const toggle = container.querySelector(
    '[data-testid="contract-lv-editor-disclosure"] [data-testid="show-more-toggle"]',
  ) as HTMLButtonElement | null;
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
}

async function unmountProposalPanel(mounted: {
  container: HTMLDivElement;
  root: Root;
}): Promise<void> {
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

function confirmedSnapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snap-ui-1',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-test-1',
        description: 'Testleistung',
        plannedQuantity: 10,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
    negotiation: {
      notes: [],
      generalHints: [],
      priceProposals: [],
      positionProposals: [],
      drafts: [],
    },
    immutable: true,
  };
}

function buildPosition(): EnhancedDetectedOrderPosition {
  return {
    positionNumber: '1',
    description: 'PE-Folie verlegen',
    unit: 'qm',
    quantity: 10,
    unitPrice: 1,
    lineTotal: 10,
    confidence: 'high',
    reviewStatus: 'confirmed',
  };
}

function buildProposal(): ContractOrderProposal {
  const positions = [buildPosition()];
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: true,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [8],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {
      auftraggeber: { value: 'Isobautec GmbH', status: 'confirmed', confidence: 'high' },
      auftragnehmer: { value: 'Ivan Iliev', status: 'confirmed', confidence: 'high' },
    },
    positions,
    paymentTerms: [],
    progressBillingAllowed: true,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Ivan Iliev',
    constructionSite: '',
    contractDate: '',
    positionCount: positions.length,
    paymentTermsSummary: '',
    progressBillingHint: 'documentIntelligence.hint.progressBilling',
    technicalAttachmentsLabel: undefined,
    reviewHints: [],
    positions,
    intelligence,
  };
}

function minimalWorkflow(itemId: string, overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    inboxItemId: itemId,
    companyRelevant: true,
    companyRelevance: {
      isRelevant: true,
      reasons: [],
      matchedHints: ['Test'],
    },
    classifiedKind: 'werkvertrag',
    classificationConfidence: 'high',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: null,
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [
      {
        description: 'Importposition',
        quantity: 1,
        unit: 'm²',
        unitPrice: 10,
        lineTotal: 10,
      },
    ],
    suggestedTasks: [],
    suggestedArchiveFolder: { path: 'Test', label: 'Test' },
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions: [],
    ...overrides,
  } as WorkflowResult;
}

describe('ORDER-PLAN-INTEGRITY-01 import UI lock', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('bei contractConfirmation ist Contract-Importaktion nicht ausführbar', async () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-locked',
        status: 'beauftragt',
        contractConfirmation: confirmedSnapshot(),
        orderPositions: [createOrderPosition()],
      }),
    ]);
    const item = createAuftragInboxItem({
      vorgangId: 'v-locked',
      vorgangLinkStatus: 'linked',
    });

    const mounted = await mountProposalPanel({
      proposal: buildProposal(),
      item,
    });

    expect(mounted.container.querySelector('[data-testid="contract-import-plan-locked"]')).toBeTruthy();
    expect(
      (
        mounted.container.querySelector(
          '[data-testid="contract-chef-primary-action"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await expandLvEditor(mounted.container);
    const createButton = mounted.container.querySelector(
      '[data-testid="contract-create-order-button"]',
    ) as HTMLButtonElement | null;
    expect(createButton).toBeTruthy();
    expect(createButton!.disabled).toBe(true);
    await unmountProposalPanel(mounted);
  });

  it('ohne contractConfirmation bleibt Contract-Importaktion verfügbar', async () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-open',
        status: 'eingegangen',
        orderPositions: [createOrderPosition()],
      }),
    ]);
    const item = createAuftragInboxItem({
      vorgangId: 'v-open',
      vorgangLinkStatus: 'linked',
    });

    const mounted = await mountProposalPanel({
      proposal: buildProposal(),
      item,
    });

    expect(mounted.container.querySelector('[data-testid="contract-import-plan-locked"]')).toBeFalsy();
    await expandLvEditor(mounted.container);
    const createButton = mounted.container.querySelector(
      '[data-testid="contract-create-order-button"]',
    ) as HTMLButtonElement | null;
    expect(createButton).toBeTruthy();
    expect(createButton!.disabled).toBe(false);
    await unmountProposalPanel(mounted);
  });

  it('SmartIntakeSummary blendet Import bei Lock aus und zeigt ihn sonst', () => {
    const item = createAuftragInboxItem({
      vorgangId: 'v-summary',
      vorgangLinkStatus: 'linked',
    });
    const workflow = minimalWorkflow(item.id);
    const noop = () => undefined;

    const lockedHtml = renderToStaticMarkup(
      createElement(
        AppProvider,
        { initialSetup: DEFAULT_SETUP },
        createElement(SmartIntakeSummary, {
          workflow,
          item,
          onExecuteAll: noop,
          onArchive: noop,
          onCreateVorgang: noop,
          onImportPositions: noop,
          onAcceptTasks: noop,
          onCancel: noop,
          importPositionsLocked: true,
        }),
      ),
    );
    expect(lockedHtml).toContain('data-testid="smart-intake-import-locked"');
    expect(lockedHtml).not.toContain('data-testid="smart-intake-import-positions"');

    const openHtml = renderToStaticMarkup(
      createElement(
        AppProvider,
        { initialSetup: DEFAULT_SETUP },
        createElement(SmartIntakeSummary, {
          workflow,
          item,
          onExecuteAll: noop,
          onArchive: noop,
          onCreateVorgang: noop,
          onImportPositions: noop,
          onAcceptTasks: noop,
          onCancel: noop,
          importPositionsLocked: false,
        }),
      ),
    );
    expect(openHtml).toContain('data-testid="smart-intake-import-positions"');
    expect(openHtml).not.toContain('data-testid="smart-intake-import-locked"');
  });
});
