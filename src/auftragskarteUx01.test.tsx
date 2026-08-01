import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { t, type TranslationKey } from './i18n';
import { buildAuftragskarteView, buildServiceSummaryText } from './services/auftragskarteView';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import type { ContractIntelligenceResult, ContractOrderProposal } from './types/documentIntelligence';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function buildProposal(overrides: Partial<ContractOrderProposal> = {}): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [2],
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
        value: 'Mustermann Sanitär GmbH',
        status: 'confirmed',
        confidence: 'high',
      },
      bauvorhaben: {
        value: 'Dachsanierung Möhnetal',
        status: 'confirmed',
        confidence: 'high',
      },
      baustelle: {
        value: 'Möhnetal 55, 59602 Rüthen',
        status: 'confirmed',
        confidence: 'high',
      },
      zahlungsbedingungen: {
        value: '30 Tage netto',
        status: 'confirmed',
        confidence: 'high',
      },
      beginn: {
        value: '01.04.2026',
        status: 'confirmed',
        confidence: 'high',
      },
      vertragsstrafe: {
        value: '0,1 % je Werktag',
        status: 'confirmed',
        confidence: 'medium',
      },
      sicherheitseinbehalt: {
        value: '5 %',
        status: 'confirmed',
        confidence: 'medium',
      },
    },
    positions: [
      {
        positionNumber: '1',
        description: 'Dachabdichtung',
        unit: 'qm',
        quantity: 120,
        unitPrice: 45,
        lineTotal: 5400,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
      {
        positionNumber: '2',
        description: 'Dämmung',
        unit: 'qm',
        quantity: 120,
        unitPrice: 28,
        lineTotal: 3360,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
      {
        positionNumber: '3',
        description: 'PVC-Folie',
        unit: 'qm',
        quantity: 120,
        unitPrice: 12,
        lineTotal: 1440,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
      {
        positionNumber: '4',
        description: 'Anschluss- und Abdichtungsarbeiten',
        unit: 'pausch',
        quantity: 1,
        unitPrice: 1800,
        lineTotal: 1800,
        confidence: 'high',
        reviewStatus: 'confirmed',
      },
    ],
    parties: [
      { role: 'auftraggeber', name: 'Isobautec GmbH' },
      { role: 'auftragnehmer', name: 'Mustermann Sanitär GmbH' },
    ],
    contractTotalNet: {
      value: 12000,
      status: 'confirmed',
      confidence: 'high',
      sourceText: 'Gesamtsumme netto 12.000,00 €',
    },
    paymentTerms: [{ type: 'net_days', label: '30 Tage netto', value: '30' }],
    progressBillingAllowed: true,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Mustermann Sanitär GmbH',
    constructionSite: 'Möhnetal 55, 59602 Rüthen',
    contractDate: '02.03.2026',
    positionCount: intelligence.positions.length,
    contractTotalNet: '12.000,00 €',
    paymentTermsSummary: '30 Tage netto',
    reviewHints: [],
    positions: intelligence.positions,
    intelligence,
    ...overrides,
  };
}

describe('UX-01 Auftragskarte', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root && container) {
      act(() => {
        root!.unmount();
      });
      container.remove();
    }
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it('baut Leistungszusammenfassung aus Positionen', () => {
    const proposal = buildProposal();
    const summary = buildContractWorkspaceSummaryView(proposal);
    const text = buildServiceSummaryText(proposal, summary);
    expect(text).toContain('Sie übernehmen');
    expect(text).toContain('Dachabdichtung');
    expect(text).toMatch(/einschließlich|sowie/);
  });

  it('liefert Auftraggeber, Bauvorhaben, Baustelle, Positionen und max. 3 Risiken', () => {
    const view = buildAuftragskarteView(buildProposal(), { translate });
    expect(view.customer).toBe('Isobautec GmbH');
    expect(view.project).toContain('Dachsanierung');
    expect(view.constructionSite).toContain('Möhnetal 55');
    expect(view.positionCount).toBe(4);
    expect(view.ownRoleLabelKey).toBe('documentIntelligence.party.auftragnehmer');
    expect(view.orderValue).toBeTruthy();
    expect(view.paymentTerms).toContain('30 Tage');
    expect(view.deadline).toBeTruthy();
    expect(view.risks.length).toBeGreaterThan(0);
    expect(view.risks.length).toBeLessThanOrEqual(3);
  });

  it('Erstansicht: Experience-Card statt LV-Tabelle; Details eingeklappt', () => {
    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal: buildProposal(),
        translate,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
        onInquiry: vi.fn(),
        onApplySuggestion: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="auftragskarte"');
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).toContain('Werkvertrag');
    expect(html).not.toContain('Neuer Auftrag');
    expect(html).toContain('Möhnetal 55');
    expect(html).toContain('4 Positionen erkannt');
    expect(html).toContain('Auftrag annehmen');
    expect(html).toContain('Rückfrage');
    expect(html).toContain('Ablehnen');
    expect(html).toContain('data-testid="document-experience-details"');
    expect(html).toContain('Kurz zusammengefasst');
    expect(html).toContain('Leistungsumfang anzeigen');
    expect(html).toContain('Vertrag anzeigen');
    expect(html).toContain('Technische Details');
    expect(html).toContain('data-testid="auftragskarte-contract"');
    expect(html).toContain('data-testid="auftragskarte-details"');
    expect(html).not.toContain('data-testid="contract-order-lv-overview"');
    expect(html).not.toContain('data-testid="contract-order-positions"');
    expect(html).toContain('data-testid="contract-workspace-summary"');
  });

  it('Primär-CTA nimmt Auftrag mit sicheren Positionen an', async () => {
    const onConfirmImport = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        createElement(ContractOrderProposalPanel, {
          proposal: buildProposal(),
          translate,
          onConfirmImport,
          onDiscard: vi.fn(),
          onInquiry: vi.fn(),
        }),
      );
    });

    const accept = container.querySelector(
      '[data-testid="contract-chef-primary-action"]',
    ) as HTMLButtonElement;
    expect(accept).toBeTruthy();
    expect(accept.textContent).toContain('Auftrag annehmen');

    await act(async () => {
      accept.click();
    });

    expect(onConfirmImport).toHaveBeenCalledTimes(1);
    expect(onConfirmImport.mock.calls[0]![0]).toHaveLength(4);
  });

  it('Leistungsumfang aufklappen zeigt LV ohne Primärflächen-Tabelle vorher', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        createElement(ContractOrderProposalPanel, {
          proposal: buildProposal(),
          translate,
          onConfirmImport: vi.fn(),
          onDiscard: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('[data-testid="contract-order-lv-overview"]')).toBeNull();

    const toggle = container.querySelector(
      '[data-testid="auftragskarte-toggle-scope"]',
    ) as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });

    expect(container.querySelector('[data-testid="contract-order-lv-overview"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="contract-lv-editor-disclosure"]')).toBeTruthy();
  });
});
