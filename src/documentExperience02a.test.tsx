/**
 * DOCUMENT-EXPERIENCE-02A — Experience Card first; archive/guidance placement.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import {
  DOCUMENT_EXPERIENCE_MAX_FACTS,
  DOCUMENT_EXPERIENCE_MAX_SECONDARY,
  DocumentExperienceCard,
} from './components/inbox/review/DocumentExperienceCard';
import { DocumentGuidancePanel } from './components/documents/DocumentGuidancePanel';
import { t, type TranslationKey } from './i18n';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateDocumentStore } from './services/documentService';
import { buildDocumentGuidance } from './services/documentGuidanceService';
import { hydrateInboxStore } from './services/inboxService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { ContractIntelligenceResult, ContractOrderProposal } from './types/documentIntelligence';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function buildProposal(): ContractOrderProposal {
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
      auftraggeber: { value: 'Isobautec GmbH', status: 'confirmed', confidence: 'high' },
      bauvorhaben: { value: 'Dachsanierung Möhnetal', status: 'confirmed', confidence: 'high' },
      baustelle: { value: 'Möhnetal 55, 59602 Rüthen', status: 'confirmed', confidence: 'high' },
    },
    positions: Array.from({ length: 4 }, (_, i) => ({
      positionNumber: String(i + 1),
      description: `Pos ${i + 1}`,
      unit: 'qm',
      quantity: 10,
      unitPrice: 10,
      lineTotal: 100,
      confidence: 'high' as const,
      reviewStatus: 'confirmed' as const,
    })),
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
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Isobautec GmbH',
    contractor: 'Mustermann Sanitär GmbH',
    constructionSite: 'Möhnetal 55, 59602 Rüthen',
    positionCount: 4,
    contractTotalNet: '12.000,00 €',
    reviewHints: [],
    positions: intelligence.positions,
    intelligence,
  };
}

describe('DOCUMENT-EXPERIENCE-02A', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateDocumentStore([]);
  });

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
    resetTestStores();
  });

  it('Experience-Card begrenzt Fakten und Sekundäraktionen', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentExperienceCard, {
        summary: {
          id: 'summary:test',
          sourceInboxItemId: 'test',
          generatedAt: new Date(0).toISOString(),
          documentKind: 'werkvertrag',
          documentTypeLabelKey: 'documentIntelligence.label.werkvertragMitLv',
          family: 'contract',
          headline: 'Neuer Auftrag',
          facts: Array.from({ length: 10 }, (_, i) => ({
            id: `f${i}`,
            label: `L${i}`,
            value: `V${i}`,
          })),
          alerts: [
            { id: 'a1', severity: 'review' as const, label: 'A1' },
            { id: 'a2', severity: 'review' as const, label: 'A2' },
            { id: 'a3', severity: 'review' as const, label: 'A3' },
            { id: 'a4', severity: 'review' as const, label: 'A4' },
          ],
          primaryAction: {
            id: 'accept_contract_order' as const,
            labelKey: 'auftragskarte.action.accept',
            enabled: true,
          },
          secondaryActions: [
            {
              id: 'contract_inquiry' as const,
              labelKey: 'auftragskarte.action.inquiry',
              enabled: true,
            },
            {
              id: 'reject_contract_proposal' as const,
              labelKey: 'auftragskarte.action.reject',
              enabled: true,
            },
            {
              id: 'later' as const,
              labelKey: 'documentExperience.action.later',
              enabled: true,
            },
          ],
          details: [],
          workspaceType: 'contract_order',
          hasDeepWorkspace: true,
        },
        onAction: () => undefined,
        actionUi: {
          accept_contract_order: { testId: 'document-experience-primary' },
          contract_inquiry: { testId: 'document-experience-secondary-s1' },
          reject_contract_proposal: { testId: 'document-experience-secondary-s2' },
        },
        translate,
      }),
    );

    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).toContain('data-testid="document-experience-primary"');
    const factMatches = html.match(/data-row/g) ?? [];
    // DataRow renders without that class always — count fact values instead
    expect((html.match(/>V\d+</g) ?? []).length).toBe(DOCUMENT_EXPERIENCE_MAX_FACTS);
    expect(html).toContain('A1');
    expect(html).toContain('A3');
    expect(html).not.toContain('>A4<');
    expect(html).toContain('Rückfrage');
    expect(html).toContain('Ablehnen');
    expect(html).not.toContain('data-testid="document-experience-secondary-later"');
    expect(DOCUMENT_EXPERIENCE_MAX_SECONDARY).toBe(2);
  });

  it('Werkvertrag: Experience-Card zuerst mit max. 6 Fakten und einer Primäraktion', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-dexp-02a',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
    });
    const guidance = buildDocumentGuidance(item, null, 'de');
    const html = renderToStaticMarkup(
      createElement(ContractOrderProposalPanel, {
        proposal: buildProposal(),
        translate,
        item,
        onConfirmImport: vi.fn(),
        onDiscard: vi.fn(),
        onInquiry: vi.fn(),
        detailsExtra: createElement(DocumentGuidancePanel, {
          guidance,
          translate,
        }),
      }),
    );

    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).toContain('data-testid="document-experience-facts"');
    expect(html).toContain('data-testid="document-experience-details"');
    expect(html).toContain('data-testid="document-guidance-panel"');
    expect(html).toContain('Als Auftrag erfassen');
    expect(html).toContain('Rückfrage');
    expect(html).toContain('Ablehnen');
    // Guidance lives under Details, not as a competing hero ahead of facts
    const cardIdx = html.indexOf('data-testid="document-experience-card"');
    const guidanceIdx = html.indexOf('data-testid="document-guidance-panel"');
    const detailsIdx = html.indexOf('data-testid="document-experience-details"');
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(detailsIdx).toBeGreaterThan(cardIdx);
    expect(guidanceIdx).toBeGreaterThan(detailsIdx);
  });

  it('EingangDetail: Archiv erst unter Weitere Optionen; Experience vor Assistant', async () => {
    const item = createAuftragInboxItem({
      id: 'inbox-dexp-02a-page',
      title: 'Werkvertrag Isobautec',
      sender: 'Isobautec GmbH',
      classifiedKind: 'werkvertrag',
      markedAsCompanyDocument: true,
      recognizedData: {
        _vertragstext: 'Werkvertrag\nAuftraggeber: Isobautec GmbH\nBaustellenadresse: Testweg 1',
        Auftraggeber: 'Isobautec GmbH',
      },
    });
    hydrateInboxStore([item]);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: [`/ablage/${item.id}`] },
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/ablage/:id',
                element: createElement(EingangDetailPage),
              }),
            ),
          ),
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const page = container!;
    // Archive CTA not on first paint (more options collapsed)
    expect(page.querySelector('[data-testid="document-review-more-content"]')).toBeNull();
    expect(page.querySelector('[data-testid="inbox-import-to-archive-primary-button"]')).toBeNull();

    const moreToggle = page.querySelector(
      '[data-testid="document-review-more-toggle"]',
    ) as HTMLButtonElement;
    expect(moreToggle).toBeTruthy();
    await act(async () => {
      moreToggle.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const archiveToggle = page.querySelector(
      '[data-testid="review-section-toggle-archive"]',
    ) as HTMLButtonElement | null;
    if (
      archiveToggle &&
      !page.querySelector('[data-testid="review-section-content-archive"]')
    ) {
      await act(async () => {
        archiveToggle.click();
      });
    }

    expect(page.querySelector('[data-testid="inbox-import-to-archive-primary-button"]')).toBeTruthy();

    // When contract proposal is present, assistant hero is not mounted ahead
    const assistant = page.querySelector('[data-testid="document-assistant-panel"]');
    const experience = page.querySelector('[data-testid="document-experience-card"]');
    const overview = page.querySelector('[data-testid="operational-overview"]');
    // Either experience card (proposal path) or overview (fallback) — never assistant-first
    if (experience) {
      expect(assistant).toBeNull();
      expect(
        page.querySelector('[data-testid="document-experience-guidance"]'),
      ).toBeTruthy();
    } else {
      expect(overview || page.querySelector('[data-testid="document-review-experience"]')).toBeTruthy();
    }
  });
});
