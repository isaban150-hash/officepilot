import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ContractOrderProposal, ContractIntelligenceResult } from './types/documentIntelligence';
import type { InboxItem, Vorgang, VorgangInvoice } from './types/models';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { hasAbschlagsrechnung } from './services/orderBillingRules';
import { t, type TranslationKey } from './i18n';
import { createAuftragInboxItem } from './test/fixtures';

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
      billOfQuantitiesPages: [],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {},
    positions: [],
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
    positionCount: 0,
    paymentTermsSummary: '',
    reviewHints: [],
    positions: [],
    intelligence,
  };
}

function buildInvoice(overrides: Partial<VorgangInvoice>): VorgangInvoice {
  return {
    id: overrides.id ?? 'inv-1',
    number: overrides.number ?? 'R-1',
    type: overrides.type ?? 'abschlag',
    positions: overrides.positions ?? [],
    subtotal: overrides.subtotal ?? 100,
    taxStatus: overrides.taxStatus ?? 'standard_19',
    amount: overrides.amount ?? 119,
    status: overrides.status ?? 'vorbereitet',
    date: overrides.date ?? '2026-03-01',
    createdAt: overrides.createdAt ?? '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

function buildVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'vorgang-billing-1',
    title: 'Billing-Test',
    customer: 'Isobautec GmbH',
    baustelle: 'Rüthen',
    status: 'aktiv',
    materialSource: 'unclear',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    ...overrides,
  };
}

function linkedItem(): InboxItem {
  return createAuftragInboxItem({
    vorgangId: 'vorgang-billing-1',
    vorgangLinkStatus: 'linked',
  });
}

describe('CONTRACT-BILLING-INSIGHTS-01', () => {
  describe('hasAbschlagsrechnung', () => {
    it('true bei gezählter Abschlagsrechnung', () => {
      const vorgang = buildVorgang({
        invoices: [buildInvoice({ type: 'abschlag', status: 'vorbereitet' })],
      });
      expect(hasAbschlagsrechnung(vorgang)).toBe(true);
    });

    it('false bei anderem Rechnungstyp', () => {
      const vorgang = buildVorgang({
        invoices: [buildInvoice({ type: 'schluss', status: 'vorbereitet' })],
      });
      expect(hasAbschlagsrechnung(vorgang)).toBe(false);
    });

    it('false bei Abschlag mit Status entwurf (nicht gezählt)', () => {
      const vorgang = buildVorgang({
        invoices: [buildInvoice({ type: 'abschlag', status: 'entwurf' })],
      });
      expect(hasAbschlagsrechnung(vorgang)).toBe(false);
    });
  });

  it('Fall A: gezählter Abschlag → Hinweis sichtbar', () => {
    const proposal = buildProposal();
    const item = linkedItem();
    const vorgang = buildVorgang({
      invoices: [buildInvoice({ type: 'abschlag', status: 'vorbereitet' })],
    });

    const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
    expect(view.statusRows.some((row) => row.id === 'abschlagsrechnung')).toBe(true);

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );
    expect(html).toContain('Abschlagsrechnung vorhanden');
  });

  it('Fall B: Abschlag mit Status entwurf → Hinweis nicht sichtbar', () => {
    const proposal = buildProposal();
    const item = linkedItem();
    const vorgang = buildVorgang({
      invoices: [buildInvoice({ type: 'abschlag', status: 'entwurf' })],
    });

    const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
    expect(view.statusRows.some((row) => row.id === 'abschlagsrechnung')).toBe(false);

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );
    expect(html).not.toContain('Abschlagsrechnung vorhanden');
  });

  it('Fall C: nur schluss/rechnung → kein Abschlag-Hinweis; Schluss bleibt', () => {
    const proposal = buildProposal();
    const item = linkedItem();
    const vorgang = buildVorgang({
      invoices: [
        buildInvoice({ id: 'inv-r', type: 'rechnung', status: 'vorbereitet' }),
        buildInvoice({ id: 'inv-s', type: 'schluss', status: 'vorbereitet' }),
      ],
    });

    const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
    expect(view.statusRows.some((row) => row.id === 'abschlagsrechnung')).toBe(false);
    expect(view.statusRows.some((row) => row.id === 'schlussrechnung')).toBe(true);

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );
    expect(html).not.toContain('Abschlagsrechnung vorhanden');
    expect(html).toContain('Schlussrechnung vorhanden');
  });

  it('Fall D: kein Vorgang / keine Rechnungen → keine Abschlagszeile', () => {
    const proposal = buildProposal();

    const withoutVorgang = buildContractWorkspaceSummaryView(proposal, {
      item: createAuftragInboxItem({ vorgangId: undefined, vorgangLinkStatus: undefined }),
    });
    expect(withoutVorgang.statusRows.some((row) => row.id === 'abschlagsrechnung')).toBe(false);

    const emptyInvoices = buildContractWorkspaceSummaryView(proposal, {
      item: linkedItem(),
      vorgang: buildVorgang({ invoices: [] }),
    });
    expect(emptyInvoices.statusRows.some((row) => row.id === 'abschlagsrechnung')).toBe(false);

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, {
        proposal,
        item: linkedItem(),
        vorgang: buildVorgang({ invoices: [] }),
        translate,
      }),
    );
    expect(html).not.toContain('Abschlagsrechnung vorhanden');
  });
});
