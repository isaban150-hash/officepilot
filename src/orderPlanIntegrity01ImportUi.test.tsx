import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
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

  it('bei contractConfirmation ist Contract-Importaktion nicht ausführbar', () => {
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

    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal: buildProposal(),
        translate,
        item,
        onConfirmImport: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="contract-import-plan-locked"');
    expect(html).toContain('data-testid="contract-create-order-button"');
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*data-testid="contract-create-order-button"|<button[^>]*data-testid="contract-create-order-button"[^>]*disabled/,
    );
  });

  it('ohne contractConfirmation bleibt Contract-Importaktion verfügbar', () => {
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

    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal: buildProposal(),
        translate,
        item,
        onConfirmImport: vi.fn(),
      }),
    );

    expect(html).not.toContain('data-testid="contract-import-plan-locked"');
    expect(html).toContain('data-testid="contract-create-order-button"');
    const buttonMatch = html.match(
      /<button[^>]*data-testid="contract-create-order-button"[^>]*>/,
    );
    expect(buttonMatch?.[0] ?? '').not.toContain('disabled');
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
