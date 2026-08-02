import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore, processUpload } from './services/inboxService';
import { EingangDetailPage } from './pages/EingangDetailPage';
import {
  MAX_REVIEW_RECOMMENDATIONS,
  buildDocumentReviewChecks,
  buildDocumentReviewHero,
  buildDocumentReviewRecommendations,
  isDocumentReviewComplete,
} from './services/documentReviewViewService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { de, tr, t, type TranslationKey } from './i18n/index';

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

const CONTRACT_TEXT = `
Werkvertrag
Auftraggeber: Müller Bau GmbH
Baustellenadresse: Hauptstr. 12, 10115 Berlin
Vertragsdatum: 15.03.2026
`.trim();

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

function mountDetail(itemId: string): { container: HTMLDivElement; root: ReturnType<typeof createRoot> } {
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

function clickByTestId(container: HTMLElement, testId: string) {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  if (!element) {
    throw new Error(`Missing element: ${testId}`);
  }
  element.click();
}

function expandReviewSection(container: HTMLElement, sectionId: string) {
  const toggle = container.querySelector(
    `[data-testid="review-section-toggle-${sectionId}"]`,
  ) as HTMLButtonElement | null;
  expect(toggle, `toggle missing: ${sectionId}`).toBeTruthy();
  expect(toggle!.getAttribute('aria-expanded')).toBe('false');
  act(() => {
    flushSync(() => {
      toggle!.click();
    });
  });
  expect(toggle!.getAttribute('aria-expanded')).toBe('true');
  expect(getReviewSectionContent(container, sectionId)).toBeTruthy();
}

function getReviewSectionContent(container: HTMLElement, sectionId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="review-section-content-${sectionId}"]`);
}

function getOcrVisibleText(container: HTMLElement): string | null {
  return container.querySelector('.document-review-ocr-text')?.textContent ?? null;
}

function assertMoreOptionsAccordionClosed(container: HTMLElement) {
  expect(container.querySelector('[data-testid="document-review-more-content"]')).toBeFalsy();
  expect(container.querySelector('[data-testid="eingang-communication"]')).toBeFalsy();
  expect(getReviewSectionContent(container, 'ocr-text')).toBeFalsy();
  const ocrToggle = container.querySelector(
    '[data-testid="review-section-toggle-ocr-text"]',
  ) as HTMLButtonElement | null;
  if (ocrToggle) {
    expect(ocrToggle.getAttribute('aria-expanded')).toBe('false');
  }
}

function assertMoreOptionsAccordionOpen(container: HTMLElement) {
  act(() => {
    flushSync(() => {
      clickByTestId(container, 'document-review-more-toggle');
    });
  });
  expect(container.querySelector('[data-testid="document-review-more-content"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="eingang-communication"]')).toBeFalsy();
  expect(getReviewSectionContent(container, 'ocr-text')).toBeFalsy();

  expandReviewSection(container, 'communication');
  expect(container.querySelector('[data-testid="eingang-communication"]')).toBeTruthy();

  expect(container.querySelector('[data-testid="document-review-ocr-section"]')).toBeTruthy();
  expandReviewSection(container, 'ocr-text');
  expect(getReviewSectionContent(container, 'ocr-text')).toBeTruthy();
  expect(getOcrVisibleText(container)).toContain('Werkvertrag');
}

function reviewWorkflowDeKeys(): TranslationKey[] {
  return (Object.keys(de) as TranslationKey[]).filter((key) => key.startsWith('reviewWorkflow.'));
}

describe('UX-WORKFLOW-01 document review', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('Hero zeigt Dokumenttyp', () => {
    const item = processUpload({
      sourceFileName: 'vertrag.pdf',
      recognizedText: CONTRACT_TEXT,
    });
    const html = renderDetail(item.id);
    // UX-01: contract proposal → Auftragskarte first (overview hidden while proposal open).
    if (html.includes('contract-order-proposal')) {
      expect(html).toContain('data-testid="auftragskarte"');
      expect(html).toContain('Werkvertrag');
    } else {
      expect(html).toContain('data-testid="document-experience-card"');
      expect(html).toContain('Werkvertrag');
    }
  });

  it('Empfehlungen maximal 6 Einträge', () => {
    const item = processUpload({
      sourceFileName: 'vertrag.pdf',
      recognizedText: CONTRACT_TEXT,
    });
    const workflow = processUploadedDocument(item.id)!;
    const recommendations = buildDocumentReviewRecommendations(item, workflow);
    expect(recommendations.length).toBeLessThanOrEqual(MAX_REVIEW_RECOMMENDATIONS);
    expect(recommendations.length).toBeGreaterThan(0);
  });

  it('offene Prüfhinweise werden gezeigt', () => {
    const item = processUpload({
      sourceFileName: 'vertrag.pdf',
      recognizedText: 'Werkvertrag ohne Kunde',
    });
    const workflow = processUploadedDocument(item.id)!;
    const checks = buildDocumentReviewChecks(item, workflow);
    expect(checks.length).toBeGreaterThan(0);
    const html = renderDetail(item.id);
    // UX-01: with contract proposal, uncertainty lives in Details / card — not overview.
    if (html.includes('contract-order-proposal')) {
      expect(html).toContain('data-testid="auftragskarte"');
      expect(html).toContain('data-testid="auftragskarte-details"');
    } else {
      expect(html).toContain('data-testid="document-experience-card"');
    }
  });

  it('bei vollständigen Daten erscheint Alles vollständig', () => {
    const item = processUpload({
      sourceFileName: 'lieferschein.pdf',
      recognizedText: `${CONTRACT_TEXT}\nEmpfänger: Mustermann Sanitär GmbH`,
    });
    const workflow = processUploadedDocument(item.id)!;
    const checks = buildDocumentReviewChecks(item, workflow);
    expect(isDocumentReviewComplete(checks)).toBe(true);
    const html = renderDetail(item.id);
    if (html.includes('contract-order-proposal')) {
      expect(html).toContain('data-testid="auftragskarte"');
      expect(html).toContain('data-testid="contract-chef-primary-action"');
    } else {
      expect(html).toContain('data-testid="document-experience-card"');
      expect(html).toContain('data-testid="document-review-apply-button"');
    }
  });

  it('nur eine Primary-Hauptaktion sichtbar', () => {
    const item = processUpload({ kind: 'auftrag' });
    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="document-review-apply-button"');
    expect((html.match(/data-testid="document-review-apply-button"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-testid="scan-result-panel"');
  });

  it('weitere Optionen standardmäßig geschlossen', () => {
    const item = processUpload({ kind: 'auftrag' });
    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="document-review-more-toggle"');
    expect(html).not.toContain('data-testid="document-review-more-content"');
    expect(html).not.toContain('data-testid="inbox-ai-panel"');
    expect(html).not.toContain('data-testid="eingang-communication"');
  });

  it('Kommunikation und OCR erst nach Öffnen sichtbar', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const item = processUpload({
        sourceFileName: 'vertrag.pdf',
        recognizedText: CONTRACT_TEXT,
      });
      const { container, root } = mountDetail(item.id);

      assertMoreOptionsAccordionClosed(container);
      assertMoreOptionsAccordionOpen(container);

      act(() => root.unmount());
    }
  });

  it('reviewWorkflow: alle DE-Keys haben vollständige TR-Übersetzung', () => {
    const keys = reviewWorkflowDeKeys();
    expect(keys.length).toBeGreaterThan(0);

    const missing: string[] = [];
    const empty: string[] = [];
    const germanFallback: string[] = [];

    for (const key of keys) {
      const trValue = tr[key];
      if (!trValue) {
        missing.push(key);
        continue;
      }
      if (!trValue.trim()) {
        empty.push(key);
        continue;
      }
      if (trValue === de[key]) {
        germanFallback.push(key);
      }
      expect(t(key, 'tr'), `t() fallback for ${key}`).toBe(trValue);
    }

    expect(missing, `fehlende TR-Keys: ${missing.join(', ')}`).toEqual([]);
    expect(empty, `leere TR-Keys: ${empty.join(', ')}`).toEqual([]);
    expect(germanFallback, `deutscher Fallback: ${germanFallback.join(', ')}`).toEqual([]);
  });

  it('Mobile-Struktur rendert Experience-Card oder Auftragskarte und Hauptbutton zuerst', () => {
    const item = processUpload({ kind: 'auftrag' });
    const html = renderDetail(item.id);
    const experienceIndex = html.indexOf('data-testid="document-experience-card"');
    const cardIndex = html.indexOf('data-testid="auftragskarte"');
    const primaryIndex = html.includes('contract-chef-primary-action')
      ? html.indexOf('contract-chef-primary-action')
      : html.indexOf('document-review-apply-button');
    const moreIndex = html.indexOf('document-review-more-options');
    const leadIndex = cardIndex >= 0 ? cardIndex : experienceIndex;
    expect(leadIndex).toBeGreaterThan(-1);
    expect(primaryIndex).toBeGreaterThan(leadIndex);
    expect(moreIndex).toBeGreaterThan(primaryIndex);
  });

  it('bestehende Übernahmefunktion bleibt über Hauptbutton erreichbar', () => {
    const item = processUpload({
      sourceFileName: 'vertrag.pdf',
      recognizedText: `${CONTRACT_TEXT}\nEmpfänger: Mustermann Sanitär GmbH`,
    });
    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="document-review-experience"');
    // UX-01: contract proposals use „Auftrag annehmen“ as the single primary CTA.
    if (html.includes('contract-order-proposal')) {
      expect(html).toContain('data-testid="auftragskarte"');
      expect(html).toContain('data-testid="contract-chef-primary-action"');
      expect(html).toContain('Auftrag annehmen');
      expect(html).not.toContain('data-testid="document-review-primary-action"');
    } else {
      expect(html).toContain('Vorschlag übernehmen');
    }
  });

  it('View-Service liefert Hero-Kontext', () => {
    const item = processUpload({
      sourceFileName: 'vertrag.pdf',
      recognizedText: CONTRACT_TEXT,
    });
    const workflow = processUploadedDocument(item.id)!;
    const hero = buildDocumentReviewHero(item, workflow);
    // Friendly display keys (757bfae) — not internal classifiedKind.* enum keys.
    expect(hero.documentTypeKey).toBe('docAssistant.display.contract');
    expect(hero.documentTypeKey).not.toContain('classifiedKind.');
    expect(hero.introKey).toBe('reviewWorkflow.hero.intro');
  });
});
