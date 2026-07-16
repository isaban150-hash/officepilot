import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DocumentAssistantPanel } from './components/documents/DocumentAssistantPanel';
import { DEFAULT_SETUP } from './data/mockData';
import { t } from './i18n';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { hydrateInboxStore } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { resetTestStores } from './test/resetStores';

function mockViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  window.matchMedia = ((query: string) => {
    const maxWidthMatch = /max-width:\s*(\d+)px/.exec(query);
    const matches = maxWidthMatch ? width <= Number(maxWidthMatch[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

function renderAblageDetail(itemId: string): string {
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

describe('DOCUMENT-DETAIL-MOBILE-01', () => {
  beforeEach(() => {
    mockViewport(390);
  });

  afterEach(() => {
    mockViewport(1024);
    resetTestStores();
  });

  it('kompaktes Layout: Kurz erklärt und Aktionen sichtbar, Experten hinter Mehr anzeigen', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'mobil.pdf',
      recognizedText: 'Eingangsrechnung RE-77 Lieferant Bau AG 120,00 EUR',
      kind: 'materialrechnung',
    });
    hydrateInboxStore([item]);
    processUploadedDocument(item.id);

    const html = renderAblageDetail(item.id);
    expect(html).toContain('data-testid="ablage-detail-page"');
    expect(html).toContain('eingang-detail-page--compact');
    expect(html).toContain(t('docAssistant.section.brief', 'de'));
    expect(html).toContain(t('docAssistant.section.actions', 'de'));
    expect(html).toContain('data-testid="document-assistant-expert-more"');
    expect(html).toContain('Mehr anzeigen');
    expect(html).not.toContain('data-testid="show-more-content"');
    expect(html).not.toContain('data-testid="document-assistant-recognition"');
  });

  it('Originaldatei und OCR sind standardmäßig eingeklappt', () => {
    const item = {
      ...createMockInboxItemFromUpload({
        sourceFileName: 'ocr-mobil.pdf',
        recognizedText: 'Werkvertrag Positionen A B C D E F G',
        kind: 'materialrechnung',
      }),
      fileRefId: 'file-ref-mobile-1',
    };
    hydrateInboxStore([item]);
    processUploadedDocument(item.id);

    const html = renderAblageDetail(item.id);
    expect(html).toContain('data-testid="document-review-original-section"');
    expect(html).toContain('data-testid="review-section-toggle-original-file"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="review-section-content-original-file"');
    expect(html).toContain('data-testid="document-review-ocr-section"');
    expect(html).not.toContain('data-testid="document-review-ocr-content"');
  });

  it('Desktop: Expertenkarten und Original bleiben ausgeklappt sichtbar', () => {
    mockViewport(1200);
    const item = {
      ...createMockInboxItemFromUpload({
        sourceFileName: 'desktop.pdf',
        recognizedText: 'Eingangsrechnung RE-88 Lieferant Holz AG 200,00 EUR',
        kind: 'materialrechnung',
      }),
      fileRefId: 'file-ref-desktop-1',
    };
    hydrateInboxStore([item]);
    processUploadedDocument(item.id);

    const html = renderAblageDetail(item.id);
    expect(html).not.toContain('eingang-detail-page--compact');
    expect(html).not.toContain('data-testid="document-assistant-expert-more"');
    expect(html).toContain('data-testid="document-assistant-recognition"');
    expect(html).not.toContain('data-testid="document-review-original-section"');
    expect(html).toContain('data-testid="ablage-original-file"');
    expect(html).toContain('document-original-file-panel');
  });

  it('DocumentAssistantPanel compactLayout blendet Erkennung hinter Mehr anzeigen aus', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'panel.pdf',
      recognizedText: 'BG BAU Beitragsbescheid',
      kind: 'bg_bau',
    });
    const compact = renderToStaticMarkup(
      <DocumentAssistantPanel
        item={item}
        workflow={null}
        translate={(key) => t(key, 'de')}
        language="de"
        compactLayout
      />,
    );
    expect(compact).toContain(t('docAssistant.section.brief', 'de'));
    expect(compact).toContain(t('docAssistant.section.actions', 'de'));
    expect(compact).toContain('data-testid="document-assistant-expert-more"');
    expect(compact).not.toContain('data-testid="document-assistant-recognition"');

    const full = renderToStaticMarkup(
      <DocumentAssistantPanel
        item={item}
        workflow={null}
        translate={(key) => t(key, 'de')}
        language="de"
      />,
    );
    expect(full).toContain('data-testid="document-assistant-recognition"');
    expect(full).not.toContain('data-testid="document-assistant-expert-more"');
  });
});
