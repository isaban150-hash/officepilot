import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ContractOrderProposal, ContractIntelligenceResult } from './types/documentIntelligence';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { t, type TranslationKey } from './i18n';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function buildProposal(overrides?: {
  intelligence?: Partial<ContractIntelligenceResult>;
  proposal?: Partial<ContractOrderProposal>;
}): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
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
        value: '14 Tage mit 2 % Skonto oder 30 Tage netto',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    positions: [
      {
        positionNumber: '1',
        description: 'PE-Folie verlegen',
        unit: 'qm',
        quantity: 4799,
        unitPrice: 0.35,
        lineTotal: 1679.65,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
      {
        positionNumber: '2',
        description: 'Dämmung verlegen',
        unit: 'qm',
        quantity: 4799,
        unitPrice: 2.8,
        lineTotal: 13437.2,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
    ],
    contractTotalNet: {
      value: 36029.05,
      status: 'confirmed',
      confidence: 'high',
      sourceText: 'Gesamtsumme netto 36.029,05 €',
    },
    paymentTerms: [
      { type: 'skonto', label: '2 % Skonto bei 14 Tagen', value: '2/14' },
      { type: 'net_days', label: '30 Tage netto', value: '30' },
    ],
    progressBillingAllowed: true,
    finalInvoiceMentioned: true,
    technicalAttachmentCount: 1,
    openReviewHints: ['documentIntelligence.review.positions'],
    ...overrides?.intelligence,
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Ivan Iliev',
    constructionSite: 'Möhnetal 55, 59602 Rüthen',
    contractDate: '02.03.2026',
    positionCount: intelligence.positions.length,
    contractTotalNet: '36.029,05 €',
    paymentTermsSummary: '2 % Skonto bei 14 Tagen · 30 Tage netto',
    reviewHints: intelligence.openReviewHints,
    positions: intelligence.positions,
    intelligence,
    ...overrides?.proposal,
  };
}

describe('CONTRACT-WORKSPACE-SUMMARY-01', () => {
  it('rendert Vertragskopf, Chef-Kennzahl und Parteien aus Proposal-/Intelligence-Daten', () => {
    const proposal = buildProposal();
    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, translate }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary"');
    expect(html).toContain('Vertrag kurz erklärt');
    expect(html).toContain('data-testid="contract-workspace-summary-header"');
    expect(html).toContain('data-testid="contract-workspace-summary-kind"');
    expect(html).toContain('Werkvertrag mit Leistungsverzeichnis');
    expect(html).toContain('Sicher erkannt');
    expect(html).toContain('Isobautec GmbH');
    expect(html).toContain('Ivan Iliev');
    expect(html).toContain('Möhnetal 55, 59602 Rüthen');
    expect(html).toContain('02.03.2026');
    expect(html).toContain('data-testid="contract-workspace-summary-metric-value"');
    expect(html).toContain('36.029,05 €');
    expect(html).toContain('14 Tage mit 2 % Skonto oder 30 Tage netto');
    expect(html).toContain('Einige Positionen benötigen Prüfung');
    expect(html).not.toContain('13b');
    expect(html).not.toContain('§ 13b');
    expect(html).not.toContain('Typabhängige Vertragsdaten');
  });

  it('zeigt keine aus Positionssumme abgeleitete Vertragssumme', () => {
    const proposal = buildProposal({
      intelligence: {
        contractTotalNet: {
          value: 9999,
          status: 'confirmed',
          confidence: 'medium',
          sourceText: 'Summe der erkannten Positionen',
        },
      },
      proposal: {
        contractTotalNet: '9.999,00 €',
      },
    });

    const view = buildContractWorkspaceSummaryView(proposal);
    expect(view.moneyMetric).toBeNull();
    expect(view.rows.find((row) => row.id === 'contractTotal')).toBeUndefined();

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, translate }),
    );
    expect(html).not.toContain('9.999,00 €');
  });

  it('übernimmt keine Baustelle ohne belastbares Vertragsfeld', () => {
    const proposal = buildProposal({
      intelligence: {
        contractFields: {
          auftraggeber: {
            value: 'Isobautec GmbH',
            status: 'confirmed',
            confidence: 'high',
          },
          baustelle: { status: 'not_found', confidence: 'low' },
        },
      },
      proposal: {
        constructionSite: 'Technische Zeichnung Dachaufsicht',
      },
    });

    const view = buildContractWorkspaceSummaryView(proposal);
    expect(view.objectFact?.id).not.toBe('baustelle');
    expect(view.rows.find((row) => row.id === 'constructionSite')).toBeUndefined();
  });
});
