/**
 * INGRESS-OPERATIONAL-OVERVIEW-01 — compact BI overview before save.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { getDocumentCase } from './test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from './test/document-cases/_lib/runStablePipeline';
import { buildOperationalOverviewView } from './services/operationalOverviewView';
import { t, type TranslationKey } from './i18n';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';

function seedCase(caseId: string) {
  const docCase = getDocumentCase(caseId);
  const observation = runStablePipeline(docCase);
  // SSR/detail paint: avoid multi-page `_pageTexts` so analysis is sync (no deferred shell).
  const item = createMockInboxItemFromUpload({
    sourceFileName: `${caseId}.pdf`,
    recognizedText: docCase.ocrText,
    titleHint: docCase.scenario.titleHint,
    senderHint: docCase.scenario.senderHint,
    importSource: docCase.scenario.importSource ?? 'upload',
  });
  const hydrated = {
    ...item,
    id: `inbox-overview-${caseId}`,
    fileRefId: item.fileRefId ?? `file-ref-overview-${caseId}`,
    markedAsCompanyDocument: true,
    recognizedData: {
      ...item.recognizedData,
      _extractedText: docCase.ocrText,
      _vertragstext: docCase.ocrText,
    },
  };
  hydrateInboxStore([hydrated]);
  return { docCase, observation, item: hydrated };
}

function renderDetail(itemId: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/ablage/${itemId}`]}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <Routes>
          <Route path="/ablage/:id" element={<EingangDetailPage />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

function mountDetail(itemId: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/ablage/${itemId}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function assertOrder(html: string, earlier: string, later: string) {
  const a = html.indexOf(earlier);
  const b = html.indexOf(later);
  expect(a, earlier).toBeGreaterThanOrEqual(0);
  expect(b, later).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(b);
}

describe('INGRESS-OPERATIONAL-OVERVIEW-01', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    resetDeferredWorkflowAnalysisCacheForTests();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('WV-LV: Primary Case, Meanings, Geld, Next Step, Confirm, eine Primary, Details zu', () => {
    const { item, observation } = seedCase('WV-LV-01');
    expect(observation.bi).not.toBeNull();
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/possible_new_order|contract_proposed/);
    expect(view.meaningLabelKeys.length).toBeGreaterThan(0);
    expect(view.nextStep).toBeTruthy();
    expect(view.confirmRequirement).toBeTruthy();

    const html = renderDetail(item.id);
    // UX-01: contract proposal → Auftragskarte first (overview view still built, not shown).
    expect(view.present).toBe(true);
    expect(html).toContain('data-testid="auftragskarte"');
    expect(html).not.toContain('data-testid="operational-overview"');
    expect((html.match(/data-testid="contract-chef-primary-action"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-testid="document-review-apply-button"');
    expect(html).toContain('data-testid="auftragskarte-contract"');
    expect(html).toContain('data-testid="auftragskarte-details"');
    expect(html).not.toMatch(/data-testid="auftragskarte-contract"[^>]*\sopen[\s>]/);
    expect(html).not.toMatch(/data-testid="auftragskarte-details"[^>]*\sopen[\s>]/);
    expect(html).toContain('data-testid="contract-workspace-summary"');
    assertOrder(
      html,
      'data-testid="auftragskarte"',
      'data-testid="contract-chef-primary-action"',
    );
    assertOrder(
      html,
      'data-testid="contract-chef-primary-action"',
      'data-testid="auftragskarte-contract"',
    );
    // No raw signature enums in the rendered tree.
    expect(html).not.toMatch(/>\s*(unclear|detected|partial|not_detected)\s*</i);
    assertOrder(
      html,
      'data-testid="auftragskarte"',
      'data-testid="ablage-original-file"',
    );
  });

  // FA-FRIST Happy-Path Overview → REFERENCE FA-FRIST-01

  it('HOTEL: expense Primary Case in BI; Experience-Card zeigt Geld ohne BI-Jargon', () => {
    const { item, observation } = seedCase('HOTEL-01');
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/expense_/);
    expect(view.moneyLabel).toBeTruthy();

    const html = renderDetail(item.id);
    // DOCUMENT-EXPERIENCE-02B: first screen is Experience Card, not BI overview.
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).not.toContain('data-testid="operational-overview-primary-case"');
    expect(html).not.toContain('data-testid="operational-overview-meanings"');
    expect((html.match(/data-testid="document-review-apply-button"/g) ?? []).length).toBe(1);
    assertOrder(
      html,
      'data-testid="document-experience-card"',
      'data-testid="ablage-original-file"',
    );
  });

  it('MAIL: Kommunikationsfall in BI; Experience-Card vor Original; Details zu', () => {
    const { item, observation } = seedCase('MAIL-TERMIN-01');
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/communication_/);

    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).not.toContain('data-testid="operational-overview-primary-case"');
    expect(html).not.toContain('data-testid="operational-overview-meanings"');
    assertOrder(
      html,
      'data-testid="document-experience-card"',
      'data-testid="ablage-original-file"',
    );

    const { container, root } = mountDetail(item.id);
    const details = container.querySelector(
      '[data-testid="document-experience-details"]',
    ) as HTMLDetailsElement | null;
    if (details) {
      expect(details.open).toBe(false);
    }
    act(() => {
      root.unmount();
    });
  });

  it('UNSURE-01: Experience-Card mit einer Primary; kein BI-Jargon auf Start', () => {
    const { item, observation } = seedCase('UNSURE-01');
    expect(observation.bi).not.toBeNull();
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/review_required|information_only|communication_/);

    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).not.toContain('data-testid="operational-overview-primary-case"');
    expect(html).not.toContain(t(view.primaryCaseLabelKey, 'de'));
    expect((html.match(/data-testid="document-review-apply-button"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-testid="contract-chef-primary-action"');
    expect(html).not.toMatch(/data-testid="document-experience-details"[^>]*\sopen[\s>]/);
    assertOrder(
      html,
      'data-testid="document-experience-card"',
      'data-testid="ablage-original-file"',
    );
  });
});
