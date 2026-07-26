import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ContractOrderProposal, ContractIntelligenceResult, EnhancedDetectedOrderPosition } from './types/documentIntelligence';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { isImportableLvPosition } from './services/contractPositionImportService';
import { t, type TranslationKey } from './i18n';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function pos(
  overrides: Partial<EnhancedDetectedOrderPosition> & Pick<EnhancedDetectedOrderPosition, 'description'>,
): EnhancedDetectedOrderPosition {
  return {
    positionNumber: overrides.positionNumber ?? '1',
    description: overrides.description,
    unit: overrides.unit ?? 'qm',
    quantity: overrides.quantity ?? 10,
    unitPrice: overrides.unitPrice ?? 1,
    lineTotal: overrides.lineTotal ?? 10,
    confidence: overrides.confidence ?? 'high',
    reviewStatus: overrides.reviewStatus ?? 'confirmed',
    ...overrides,
  };
}

/**
 * Fixture aligned to isImportableLvPosition:
 * 1) fully filled → importable
 * 2) unitPrice 0, quantity 0, lineTotal > 0 → importable; ohne Menge; ohne Einzelpreis
 * 3) empty unit → not importable; ohne Einheit
 * 4) Non-Billable description (AGB) → not importable
 */
function buildFourPositionProposal(): ContractOrderProposal {
  const positions: EnhancedDetectedOrderPosition[] = [
    pos({
      positionNumber: '1',
      description: 'PE-Folie verlegen',
      unit: 'qm',
      quantity: 100,
      unitPrice: 0.35,
      lineTotal: 35,
    }),
    pos({
      positionNumber: '2',
      description: 'Dämmung verlegen',
      unit: 'qm',
      quantity: 0,
      unitPrice: 0,
      lineTotal: 13437.2,
    }),
    pos({
      positionNumber: '3',
      description: 'Randabschluss',
      unit: '',
      quantity: 50,
      unitPrice: 2,
      lineTotal: 100,
    }),
    pos({
      positionNumber: '4',
      description: 'AGB Allgemeine Vertragsbedingungen',
      unit: 'Stück',
      quantity: 1,
      unitPrice: 1,
      lineTotal: 1,
    }),
  ];

  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [8],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {
      auftraggeber: {
        value: 'Isobautec GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    positions,
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: '',
    constructionSite: '',
    contractDate: '',
    positionCount: positions.length,
    paymentTermsSummary: '',
    reviewHints: [],
    positions,
    intelligence,
  };
}

describe('CONTRACT-POSITION-INSIGHTS-01', () => {
  it('Fixture-Regeln: isImportableLvPosition liefert 2 importierbar / 2 nicht', () => {
    const proposal = buildFourPositionProposal();
    const flags = proposal.positions.map((p) => isImportableLvPosition(p));
    expect(flags).toEqual([true, true, false, false]);
  });

  it('View und LV-Überblick zeigen faktenbasierte Positionszähler ohne Import-Historie', () => {
    const proposal = buildFourPositionProposal();
    const view = buildContractWorkspaceSummaryView(proposal);

    const positionRows = view.rows.filter((row) => row.id === 'positions');
    expect(positionRows).toHaveLength(1);
    expect(positionRows[0]?.value).toBe('4');

    const insightIds = view.positionInsightRows.map((row) => row.id);
    expect(insightIds).toEqual([
      'positionsImportable',
      'positionsNotImportable',
      'positionsWithoutQuantity',
      'positionsWithoutUnitPrice',
      'positionsWithoutUnit',
    ]);

    expect(view.positionInsightRows.find((r) => r.id === 'positionsImportable')?.valueParams).toEqual({
      count: 2,
    });
    expect(view.positionInsightRows.find((r) => r.id === 'positionsNotImportable')?.valueParams).toEqual({
      count: 2,
    });
    expect(view.positionInsightRows.find((r) => r.id === 'positionsWithoutQuantity')?.valueParams).toEqual({
      count: 1,
    });
    expect(view.positionInsightRows.find((r) => r.id === 'positionsWithoutUnitPrice')?.valueParams).toEqual({
      count: 1,
    });
    expect(view.positionInsightRows.find((r) => r.id === 'positionsWithoutUnit')?.valueParams).toEqual({
      count: 1,
    });
    expect(view.lvOverview).toEqual({
      positionCount: 4,
      totalLabel: undefined,
      importableCount: 2,
      needsReviewCount: 0,
    });

    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal,
        translate,
        onConfirmImport: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="contract-order-lv-overview"');
    expect(html).toContain('data-testid="contract-order-lv-meta"');
    expect(html).toContain('Importierbar');
    expect(html).toMatch(/2\s+Importierbar|4\s+Positionen/);
    expect(html.toLowerCase()).not.toContain('übernommen');
    expect(html).not.toContain('Importhistorie');
    expect(html).not.toContain('data-testid="contract-workspace-summary-position-insights"');
  });

  it('fehlende-Feld-Zähler mit 0 werden weggelassen; Importierbarkeit zeigt auch 0', () => {
    const positions: EnhancedDetectedOrderPosition[] = [
      pos({
        positionNumber: '1',
        description: 'Vollständig',
        unit: 'qm',
        quantity: 5,
        unitPrice: 2,
        lineTotal: 10,
      }),
    ];
    const intelligence: ContractIntelligenceResult = {
      documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
      classifiedKind: 'werkvertrag',
      reviewRequired: false,
      segmentation: {
        pages: [],
        contractCorePages: [1],
        billOfQuantitiesPages: [],
        technicalAttachmentPages: [],
        commercialAttachmentPages: [],
        unknownPages: [],
      },
      contractFields: {},
      positions,
      paymentTerms: [],
      progressBillingAllowed: false,
      finalInvoiceMentioned: false,
      technicalAttachmentCount: 0,
      openReviewHints: [],
    };
    const proposal: ContractOrderProposal = {
      customer: '',
      contractor: '',
      constructionSite: '',
      positionCount: 1,
      paymentTermsSummary: '',
      reviewHints: [],
      positions,
      intelligence,
    };

    const view = buildContractWorkspaceSummaryView(proposal);
    expect(view.positionInsightRows.map((r) => r.id)).toEqual([
      'positionsImportable',
      'positionsNotImportable',
    ]);
    expect(view.positionInsightRows.find((r) => r.id === 'positionsNotImportable')?.valueParams).toEqual({
      count: 0,
    });

    expect(view.lvOverview?.importableCount).toBe(1);
    expect(view.lvOverview?.positionCount).toBe(1);

    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal,
        translate,
        onConfirmImport: vi.fn(),
      }),
    );
    expect(html).toContain('data-testid="contract-order-lv-overview"');
    expect(html).toContain('Importierbar');
    expect(html).not.toContain('ohne erkannte Menge');
    expect(html).not.toContain('ohne erkannten Einzelpreis');
    expect(html).not.toContain('ohne erkannte Einheit');
  });
});
