import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ContractOrderProposal, ContractIntelligenceResult } from './types/documentIntelligence';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { t, type TranslationKey } from './i18n';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function buildProposal(): ContractOrderProposal {
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
      baustelle: {
        value: 'Möhnetal 55, 59602 Rüthen',
        status: 'confirmed',
        confidence: 'high',
      },
      vertragsdatum: {
        value: '02.03.2026',
        status: 'confirmed',
        confidence: 'high',
      },
      zahlungsbedingungen: {
        value: '30 Tage netto',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    positions: [
      {
        positionNumber: '1',
        description: 'PE-Folie verlegen',
        unit: 'qm',
        quantity: 10,
        unitPrice: 1,
        lineTotal: 10,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
    ],
    contractTotalNet: {
      value: 100,
      status: 'confirmed',
      confidence: 'high',
      sourceText: 'Gesamtsumme netto 100,00 €',
    },
    paymentTerms: [{ type: 'net_days', label: '30 Tage netto', value: '30' }],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: ['documentIntelligence.review.positions'],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Ivan Iliev',
    constructionSite: 'Möhnetal 55, 59602 Rüthen',
    contractDate: '02.03.2026',
    positionCount: 1,
    contractTotalNet: '100,00 €',
    paymentTermsSummary: '30 Tage netto',
    reviewHints: intelligence.openReviewHints,
    positions: intelligence.positions,
    intelligence,
  };
}

describe('CONTRACT-WORKSPACE-LAYOUT-DEDUP-01', () => {
  it('zeigt Stammdaten und Review-Hints nur einmal über Workspace Summary', () => {
    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal: buildProposal(),
        translate,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary"');
    expect(html).not.toContain('contract-order-proposal__summary');
    expect(html).not.toContain('data-testid="contract-review-hints"');

    const hintOccurrences = html.split('Einige Positionen benötigen Prüfung').length - 1;
    expect(hintOccurrences).toBe(1);
    expect(html).toContain('data-testid="contract-workspace-summary-review-hints"');

    expect(html).toContain('data-testid="contract-order-positions"');
    expect(html).toContain('data-testid="contract-create-order-button"');
    expect(html).toContain('data-testid="contract-discard-button"');
    expect(html).toContain(
      'Bitte prüfen Sie Vertragsdaten und Positionen und bestätigen oder verwerfen Sie den Vorschlag.',
    );
  });
});
