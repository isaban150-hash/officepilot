import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { t, type TranslationKey } from './i18n';
import type { ContractIntelligenceResult, ContractOrderProposal } from './types/documentIntelligence';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function buildProposal(): ContractOrderProposal {
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
        value: 'Muster Bau GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      auftragnehmer: {
        value: 'Cirmak Haustechnik GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      bauvorhaben: {
        value: 'BV Rüthen',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    parties: [
      {
        role: 'auftraggeber',
        name: 'Muster Bau GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      {
        role: 'auftragnehmer',
        name: 'Cirmak Haustechnik GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
    ],
    contractTotalNet: {
      value: 36029.05,
      status: 'confirmed',
      confidence: 'high',
      sourceText: 'Gesamtsumme netto 36.029,05 €',
    },
    positions: [
      {
        positionNumber: '1',
        description: 'PVC-Folie',
        unit: 'm²',
        quantity: 120,
        unitPrice: 240,
        lineTotal: 28800,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
    ],
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Muster Bau GmbH',
    contractor: 'Cirmak Haustechnik GmbH',
    constructionSite: 'BV Rüthen',
    contractDate: '02.03.2026',
    positionCount: intelligence.positions.length,
    contractTotalNet: '36.029,05 €',
    paymentTermsSummary: '14 Tage netto',
    reviewHints: [],
    positions: intelligence.positions,
    intelligence,
  };
}

describe('WERKVERTRAG-GOLDEN-PATH-UI-01', () => {
  it('macht die ContractWorkspaceSummary zur primären sichtbaren Vertragsansicht', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal,
        translate,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary"');
    expect(html).toContain('data-testid="auftragskarte-contract"');
    expect(html.indexOf('data-testid="contract-workspace-summary"')).toBeLessThan(
      html.indexOf('data-testid="auftragskarte-contract"'),
    );
  });

  it('zeigt own-company als Auftragnehmer mit „Ihr Betrieb“', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, translate }),
    );

    expect(html).toContain('Cirmak Haustechnik GmbH');
    expect(html).toContain('Ihr Betrieb');
    expect(html).toContain('Auftragnehmer');
    expect(html).not.toContain('data-testid="contract-workspace-summary-party-kunde');
  });

  it('zeigt Bauvorhaben, Vertragssumme und LV-Status aus bestehenden Contract-Daten', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, translate }),
    );

    expect(html).toContain('BV Rüthen');
    expect(html).toContain('36.029,05 €');
    expect(html).toContain('data-testid="contract-workspace-summary-lv"');
  });
});
