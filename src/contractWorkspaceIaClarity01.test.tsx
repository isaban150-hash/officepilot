import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ContractOrderProposal, ContractIntelligenceResult, EnhancedDetectedOrderPosition } from './types/documentIntelligence';
import type { InboxItem, Vorgang } from './types/models';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { t, type TranslationKey } from './i18n';
import { createAuftragInboxItem } from './test/fixtures';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function assertOrder(html: string, earlier: string, later: string): void {
  const earlierIndex = html.indexOf(earlier);
  const laterIndex = html.indexOf(later);
  expect(earlierIndex).toBeGreaterThanOrEqual(0);
  expect(laterIndex).toBeGreaterThan(earlierIndex);
}

function buildPosition(
  overrides: Partial<EnhancedDetectedOrderPosition> & Pick<EnhancedDetectedOrderPosition, 'description'>,
): EnhancedDetectedOrderPosition {
  return {
    positionNumber: '1',
    unit: 'qm',
    quantity: 10,
    unitPrice: 1,
    lineTotal: 10,
    confidence: 'high',
    reviewStatus: 'confirmed',
    ...overrides,
  };
}

function buildProposal(overrides?: {
  positions?: EnhancedDetectedOrderPosition[];
  openReviewHints?: string[];
}): ContractOrderProposal {
  const positions = overrides?.positions ?? [
    buildPosition({ description: 'PE-Folie verlegen', positionNumber: '1' }),
    buildPosition({
      description: 'Dämmung',
      positionNumber: '2',
      quantity: 0,
      unitPrice: 0,
      lineTotal: 50,
    }),
  ];

  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: true,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [8],
      technicalAttachmentPages: [9],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {
      auftraggeber: {
        value: 'Isobautec GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      auftragnehmer: {
        value: 'Ivan Iliev',
        status: 'confirmed',
        confidence: 'high',
      },
      zahlungsbedingungen: {
        value: '30 Tage netto',
        status: 'confirmed',
        confidence: 'high',
      },
      baustelle: {
        value: 'Möhnetal 55, 59602 Rüthen',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    positions,
    paymentTerms: [],
    progressBillingAllowed: true,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 1,
    openReviewHints: overrides?.openReviewHints ?? ['documentIntelligence.review.positions'],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Ivan Iliev',
    constructionSite: '',
    contractDate: '',
    positionCount: positions.length,
    paymentTermsSummary: '',
    progressBillingHint: 'documentIntelligence.hint.progressBilling',
    technicalAttachmentsLabel: 'documentIntelligence.hint.technicalAttachments',
    reviewHints: intelligence.openReviewHints,
    positions,
    intelligence,
  };
}

function buildVorgang(): Vorgang {
  return {
    id: 'vorgang-ia-1',
    title: 'IA-Test',
    customer: 'Isobautec GmbH',
    baustelle: 'Rüthen',
    status: 'aktiv',
    materialSource: 'unclear',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
  };
}

function linkedItem(): InboxItem {
  return createAuftragInboxItem({
    vorgangId: 'vorgang-ia-1',
    vorgangLinkStatus: 'linked',
  });
}

describe('CONTRACT-WORKSPACE-IA-CLARITY-01', () => {
  it('Fall A: Übersicht → Parteien → Allgemein → Typabhängig → Positionen → Status', () => {
    const proposal = buildProposal();
    const item = linkedItem();
    const vorgang = buildVorgang();

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary-section-overview"');
    expect(html).toContain('data-testid="contract-workspace-summary-section-parties"');
    expect(html).toContain('data-testid="contract-workspace-summary-section-general"');
    expect(html).toContain('data-testid="contract-workspace-summary-section-type-specific"');
    expect(html).toContain('data-testid="contract-workspace-summary-section-positions"');
    expect(html).toContain('data-testid="contract-workspace-summary-section-status"');
    expect(html).toContain('Vertragsübersicht');
    expect(html).toContain('Vertragsparteien');
    expect(html).toContain('Allgemeine Vertragsdaten');
    expect(html).toContain('Typabhängige Vertragsdaten');
    expect(html).toContain('Positionen');
    expect(html).toContain('Status');

    assertOrder(
      html,
      'data-testid="contract-workspace-summary-section-overview"',
      'data-testid="contract-workspace-summary-section-parties"',
    );
    assertOrder(
      html,
      'data-testid="contract-workspace-summary-section-parties"',
      'data-testid="contract-workspace-summary-section-general"',
    );
    assertOrder(
      html,
      'data-testid="contract-workspace-summary-section-general"',
      'data-testid="contract-workspace-summary-section-type-specific"',
    );
    assertOrder(
      html,
      'data-testid="contract-workspace-summary-section-type-specific"',
      'data-testid="contract-workspace-summary-section-positions"',
    );
    assertOrder(
      html,
      'data-testid="contract-workspace-summary-section-positions"',
      'data-testid="contract-workspace-summary-position-insights"',
    );
    assertOrder(
      html,
      'data-testid="contract-workspace-summary-position-insights"',
      'data-testid="contract-workspace-summary-section-status"',
    );
    assertOrder(
      html,
      'data-testid="contract-workspace-summary-section-status"',
      'data-testid="contract-workspace-summary-status"',
    );
  });

  it('Fall B: ohne positionInsightRows keine Überschrift Positionen', () => {
    const proposal = buildProposal({ positions: [] });
    proposal.positionCount = 0;
    const item = linkedItem();
    const vorgang = buildVorgang();

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary-section-overview"');
    expect(html).toContain('data-testid="contract-workspace-summary-section-status"');
    expect(html).not.toContain('data-testid="contract-workspace-summary-section-positions"');
    expect(html).toContain('Vertragsübersicht');
    expect(html).toContain('Status');
  });

  it('Fall C: Proposal-Intro hat genau einen allgemeinen Instruktionsabsatz ohne doppelte Übersicht', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal,
        translate,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    const introMatch = html.match(
      /data-testid="contract-order-proposal-intro"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(introMatch).toBeTruthy();
    const introHtml = introMatch![1]!;
    const paragraphCount = (introHtml.match(/<p[\s>]/g) ?? []).length;
    expect(paragraphCount).toBe(1);

    expect(introHtml).toContain(translate('documentIntelligence.proposal.instruction'));
    expect(introHtml).not.toContain(translate('documentIntelligence.workspace.section.overview'));
    expect(introHtml).not.toContain(translate('documentIntelligence.proposal.reviewHint'));
    expect(introHtml).not.toContain(translate('documentIntelligence.proposal.onlySelectedHint'));
    expect(introHtml).not.toContain(translate('documentIntelligence.proposal.unsureNotSelectedHint'));

    // Eigenständige Hinweise bleiben außerhalb des Intro-Blocks.
    expect(html).toContain('data-testid="contract-progress-billing-hint"');
    expect(html).toContain('data-testid="contract-technical-attachments-hint"');

    // Overview appears once in the summary, not duplicated in the intro.
    const overviewMatches = html.match(/Vertragsübersicht/g) ?? [];
    expect(overviewMatches.length).toBe(1);
  });

  it('Fall D: Titel, DataRows, Review-Hints und Tabelle bleiben', () => {
    const proposal = buildProposal();
    const item = linkedItem();
    const vorgang = buildVorgang();

    const summaryHtml = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );
    expect(summaryHtml).toContain('Vertrag kurz erklärt');
    expect(summaryHtml).toContain('Isobautec GmbH');
    expect(summaryHtml).toContain('data-testid="contract-workspace-summary-review-hints"');
    expect(summaryHtml).toContain('Einige Positionen benötigen Prüfung');

    const panelHtml = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal,
        translate,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );
    expect(panelHtml).toContain('data-testid="contract-order-positions"');
    expect(panelHtml).toContain('PE-Folie verlegen');
  });
});
