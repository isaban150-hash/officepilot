import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { EingangDetailPage } from '../pages/EingangDetailPage';
import { createAuftragInboxItem } from '../test/fixtures';
import type { InboxItem } from '../types/models';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { recordInboxContext, resetCompanySessionForTests } from './brain/companySessionService';
import { hydrateInboxStore } from './inboxService';
import {
  buildInboxWorkflowAnalysisKey,
  itemNeedsDeferredWorkflowAnalysis,
  resetDeferredWorkflowAnalysisCacheForTests,
} from './inboxWorkflowAnalysisKey';
import * as intakeWorkflowService from './intakeWorkflowService';
import { hydrateVorgangStore } from './vorgangService';

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

function cloneInbox(item: InboxItem, overrides: Partial<InboxItem> = {}): InboxItem {
  const { recognizedData: recognizedOverride, ...rest } = overrides;
  return {
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    ...rest,
    recognizedData: {
      ...item.recognizedData,
      ...(recognizedOverride ?? {}),
    },
  };
}

/** Multipage / large-OCR signal without multi-megabyte payload (keeps tests fast). */
function createLargeContractItem(): InboxItem {
  const pageTexts = [
    { pageNumber: 1, text: 'Seite 1' },
    { pageNumber: 2, text: 'Seite 2' },
    { pageNumber: 3, text: 'Seite 3' },
    { pageNumber: 4, text: 'Seite 4' },
  ];
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-detail-open-large',
    title: 'Subunternehmervertrag groß',
    classifiedKind: 'subunternehmervertrag',
    status: 'neu',
    fileRefId: 'file-ref-detail-open-01',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
      _extractedText: 'x'.repeat(50_000),
      _pageTexts: JSON.stringify(pageTexts),
    },
  });
}

function createSmallItem(): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-detail-open-small',
    title: 'Kleiner Auftrag',
    classifiedKind: 'auftrag',
    recognizedData: {
      Leistung: 'Reparatur',
      Angebotssumme: '120 €',
      Betreff: 'Mustermann Sanitär GmbH',
    },
  });
}

function renderShell(itemId: string): string {
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

function installPaintSchedulerStubs() {
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number,
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.stubGlobal(
    'requestIdleCallback',
    (cb: IdleRequestCallback) =>
      setTimeout(
        () =>
          cb({
            didTimeout: false,
            timeRemaining: () => 50,
          } as IdleDeadline),
        0,
      ) as unknown as number,
  );
  vi.stubGlobal('cancelIdleCallback', (id: number) => clearTimeout(id));
}

describe('CONTRACT-DETAIL-OPEN-01', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCompanySessionForTests();
    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
    installPaintSchedulerStubs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('recordInboxContext startet keine schwere Contract-Intelligence', () => {
    const item = createLargeContractItem();
    hydrateInboxStore([item]);

    const previewSpy = vi.spyOn(intakeWorkflowService, 'getContractPreviewForInbox');
    const processSpy = vi.spyOn(intakeWorkflowService, 'processUploadedDocument');

    recordInboxContext(item.id);

    expect(previewSpy).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('stabile Shell sofort sichtbar ohne null für großes Multipage-Dokument', () => {
    const item = createLargeContractItem();
    hydrateInboxStore([item]);
    expect(itemNeedsDeferredWorkflowAnalysis(item)).toBe(true);

    const html = renderShell(item.id);
    expect(html).toContain('data-testid="eingang-detail-analysis-pending"');
    expect(html).toContain('Subunternehmervertrag groß');
    expect(html).toContain('Dokument wird weiter analysiert.');
    expect(html).toContain('data-testid="ablage-original-file"');
    expect(html).toContain('←');
    expect(html).not.toContain('data-testid="eingang-detail-missing"');
  });

  it('itemNeedsDeferredWorkflowAnalysis nutzt kein JSON.parse', () => {
    const item = createLargeContractItem();
    const parseSpy = vi.spyOn(JSON, 'parse');
    resetDeferredWorkflowAnalysisCacheForTests();
    expect(itemNeedsDeferredWorkflowAnalysis(item)).toBe(true);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('deferred Analysis höchstens einmal pro Analyse-Key', async () => {
    const item = createLargeContractItem();
    hydrateInboxStore([item]);
    const processSpy = vi
      .spyOn(intakeWorkflowService, 'processUploadedDocument')
      .mockReturnValue(null);

    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/ablage/${item.id}`]}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/ablage/:id" element={<EingangDetailPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });

    expect(container.innerHTML).toContain('eingang-detail-analysis-pending');
    // Mount effects: light recordInboxContext only — no process yet
    expect(processSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.runAllTimers();
    });

    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith(item.id);

    // Analysis key ignores vorgangId/status — no second analysis trigger from link metadata alone.
    const linked = { ...item, vorgangId: 'v-linked', status: 'geprueft' as const };
    expect(buildInboxWorkflowAnalysisKey(linked)).toBe(buildInboxWorkflowAnalysisKey(item));

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('Analysefehler zeigt lokale Error-UI und behält Shell/Original', async () => {
    const item = createLargeContractItem();
    hydrateInboxStore([item]);
    vi.spyOn(intakeWorkflowService, 'processUploadedDocument').mockImplementation(() => {
      throw new Error('boom');
    });

    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter initialEntries={[`/ablage/${item.id}`]}>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <Routes>
              <Route path="/ablage/:id" element={<EingangDetailPage />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });

    await act(async () => {
      vi.runAllTimers();
    });

    expect(container.innerHTML).toContain('eingang-detail-analysis-error');
    expect(container.innerHTML).toContain('eingang-detail-analysis-retry');
    expect(container.innerHTML).toContain('ablage-original-file');
    expect(container.innerHTML).toContain('Subunternehmervertrag groß');
    expect(container.innerHTML).not.toMatch(/^$/);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('kleine Dokumente behalten Sync-Pfad ohne Deferred-Shell', () => {
    const item = createSmallItem();
    hydrateInboxStore([item]);
    expect(itemNeedsDeferredWorkflowAnalysis(item)).toBe(false);

    const html = renderShell(item.id);
    expect(html).toContain('data-testid="document-review-experience"');
    expect(html).not.toContain('data-testid="eingang-detail-analysis-pending"');
  });
});
