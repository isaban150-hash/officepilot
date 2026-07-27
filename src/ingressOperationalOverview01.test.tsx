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
    expect(html).toContain('data-testid="operational-overview"');
    expect(html).toContain('data-testid="operational-overview-primary-case"');
    expect(html).toContain('data-testid="operational-overview-meanings"');
    expect(html).toContain('data-testid="operational-overview-next-step"');
    expect(html).toContain('data-testid="operational-overview-confirm-requirement"');
    if (view.moneyLabel) {
      expect(html).toContain('data-testid="operational-overview-money"');
    }
    // Contract proposal path: apply button suppressed in favor of proposal CTAs
    const applyCount = (html.match(/data-testid="document-review-apply-button"/g) ?? []).length;
    expect(applyCount).toBeLessThanOrEqual(1);
    expect(html).toMatch(/data-testid="operational-overview-details"/);
    expect(html).not.toMatch(/data-testid="operational-overview-details"[^>]*\sopen[\s>]/);
    assertOrder(
      html,
      'data-testid="operational-overview"',
      'data-testid="ablage-original-file"',
    );
  });

  it('FA-FRIST: Primary Case, Frist, Next Step, Confirm Requirement', () => {
    const { item, observation } = seedCase('FA-FRIST-01');
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/authority_/);
    expect(view.deadlineTypeLabelKey || view.deadlineDate).toBeTruthy();
    expect(view.nextStep).toBeTruthy();
    expect(view.confirmRequirement).toBeTruthy();

    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="operational-overview-primary-case"');
    expect(html).toContain(t('operationalOverview.label.primaryCase' as TranslationKey, 'de'));
    expect(html).toContain('data-testid="operational-overview-deadline"');
    expect(html).toContain('data-testid="operational-overview-next-step"');
    expect(html).toContain('data-testid="operational-overview-confirm-requirement"');
    expect(html).toContain('data-testid="operational-overview-meanings"');
    expect((html.match(/data-testid="document-review-apply-button"/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/data-testid="operational-overview-details"[^>]*\sopen[\s>]/);
  });

  it('HOTEL: expense Primary Case und Geld; Details initial geschlossen', () => {
    const { item, observation } = seedCase('HOTEL-01');
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/expense_/);
    expect(view.moneyLabel).toBeTruthy();

    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="operational-overview-primary-case"');
    expect(html).toContain('data-testid="operational-overview-money"');
    expect(html).toContain('data-testid="operational-overview-meanings"');
    expect(html).toContain('data-testid="operational-overview-next-step"');
    expect((html.match(/data-testid="document-review-apply-button"/g) ?? []).length).toBe(1);
    assertOrder(
      html,
      'data-testid="operational-overview"',
      'data-testid="ablage-original-file"',
    );
  });

  it('MAIL: Kommunikationsfall; Overview vor Original; Details zu', () => {
    const { item, observation } = seedCase('MAIL-TERMIN-01');
    const view = buildOperationalOverviewView(observation.workflow);
    expect(view.present).toBe(true);
    expect(view.primaryCaseId).toMatch(/communication_/);

    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="operational-overview"');
    expect(html).toContain('data-testid="operational-overview-primary-case"');
    expect(html).toContain('data-testid="operational-overview-meanings"');
    expect(html).toContain('data-testid="operational-overview-next-step"');
    expect(html).toContain('data-testid="operational-overview-confirm-requirement"');
    assertOrder(
      html,
      'data-testid="operational-overview"',
      'data-testid="ablage-original-file"',
    );

    const { container, root } = mountDetail(item.id);
    const details = container.querySelector(
      '[data-testid="operational-overview-details"]',
    ) as HTMLDetailsElement | null;
    if (details) {
      expect(details.open).toBe(false);
    }
    act(() => {
      root.unmount();
    });
  });
});
