import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ContractOrderProposal, ContractIntelligenceResult } from './types/documentIntelligence';
import type { InboxItem, Vorgang, VorgangInvoice } from './types/models';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
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
    taxStatus: overrides.taxStatus ?? 'regelbesteuert',
    amount: overrides.amount ?? 119,
    status: overrides.status ?? 'vorbereitet',
    date: overrides.date ?? '2026-03-01',
    createdAt: overrides.createdAt ?? '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

function buildVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'vorgang-status-1',
    title: 'Status-Test',
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

describe('CONTRACT-STATUS-INSIGHTS-01', () => {
  it('Fall A: Vorgang, Archiv, 2 Rechnungen, Schlussrechnung', () => {
    const proposal = buildProposal();
    const item: InboxItem = createAuftragInboxItem({
      vorgangId: 'vorgang-status-1',
      vorgangLinkStatus: 'linked',
      importedToArchive: true,
      archiveDocumentId: 'arch-1',
    });
    const vorgang = buildVorgang({
      invoices: [
        buildInvoice({ id: 'inv-abschlag', type: 'abschlag', status: 'versendet' }),
        buildInvoice({ id: 'inv-schluss', type: 'schluss', status: 'vorbereitet' }),
      ],
    });

    const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
    const statusIds = view.statusRows.map((row) => row.id);
    expect(statusIds).toEqual(['vorgang', 'archive', 'invoices', 'schlussrechnung']);

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );

    expect(html).toContain('data-testid="contract-workspace-summary-status"');
    expect(html).toContain('Mit Vorgang verknüpft');
    expect(html).toContain('Archiviert');
    expect(html).toContain('2 Rechnungen vorhanden');
    expect(html).toContain('Schlussrechnung vorhanden');
  });

  it('Fall B: kein Vorgang — keine Rechnungszeilen', () => {
    const proposal = buildProposal();
    const item: InboxItem = createAuftragInboxItem({
      vorgangId: undefined,
      vorgangLinkStatus: undefined,
      importedToArchive: false,
      archiveDocumentId: undefined,
    });

    const view = buildContractWorkspaceSummaryView(proposal, { item });
    expect(view.statusRows.map((row) => row.id)).toEqual(['vorgang', 'archive']);
    expect(view.statusRows.find((row) => row.id === 'invoices')).toBeUndefined();
    expect(view.statusRows.find((row) => row.id === 'schlussrechnung')).toBeUndefined();

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, translate }),
    );

    expect(html).toContain('Noch keinem Vorgang zugeordnet');
    expect(html).not.toContain('Rechnung vorhanden');
    expect(html).not.toContain('Schlussrechnung vorhanden');
  });

  it('Fall C: Vorgang ohne Rechnungen', () => {
    const proposal = buildProposal();
    const item: InboxItem = createAuftragInboxItem({
      vorgangId: 'vorgang-status-empty',
      vorgangLinkStatus: 'created',
    });
    const vorgang = buildVorgang({ id: 'vorgang-status-empty', invoices: [] });

    const view = buildContractWorkspaceSummaryView(proposal, { item, vorgang });
    const invoicesRow = view.statusRows.find((row) => row.id === 'invoices');
    expect(invoicesRow?.valueKey).toBe('documentIntelligence.workspace.status.invoicesNone');
    expect(view.statusRows.find((row) => row.id === 'schlussrechnung')).toBeUndefined();

    const html = renderToStaticMarkup(
      createElement(ContractWorkspaceSummary, { proposal, item, vorgang, translate }),
    );

    expect(html).toContain('Keine Rechnung vorhanden');
    expect(html).not.toContain('Schlussrechnung vorhanden');
  });
});
