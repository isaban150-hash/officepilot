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
import type { ContractIntelligenceResult } from '../types/documentIntelligence';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import * as contractIntelligenceService from './contractIntelligenceService';
import { hydrateInboxStore } from './inboxService';
import {
  itemNeedsDeferredWorkflowAnalysis,
  resetDeferredWorkflowAnalysisCacheForTests,
} from './inboxWorkflowAnalysisKey';
import * as intakeWorkflowService from './intakeWorkflowService';
import { scheduleAfterPaint } from './scheduleAfterPaint';
import { hydrateVorgangStore } from './vorgangService';
import { CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS } from '../components/inbox/review/ContractOrderProposalPanel';

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

/** Multipage signal without multi-megabyte OCR — keeps tests fast. */
function createDeferredContractItem(): InboxItem {
  const pageTexts = [
    { pageNumber: 1, text: 'Seite 1' },
    { pageNumber: 2, text: 'Seite 2' },
    { pageNumber: 3, text: 'Seite 3' },
    { pageNumber: 4, text: 'Seite 4' },
  ];
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-mainthread-yield-large',
    title: 'Werkvertrag MainThread Yield',
    classifiedKind: 'werkvertrag',
    status: 'neu',
    fileRefId: 'file-ref-yield-01',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
      _extractedText: 'x'.repeat(50_000),
      _pageTexts: JSON.stringify(pageTexts),
    },
  };
}

function createSmallWerkvertragItem(): InboxItem {
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-intel-once',
    title: 'Werkvertrag klein',
    classifiedKind: 'werkvertrag',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
    },
  };
}

const lightIntelligence = {
  positions: [
    {
      positionNumber: '1',
      description: 'Testposition',
      unit: 'Stk',
      quantity: 1,
      unitPrice: 10,
      lineTotal: 10,
      reviewStatus: 'confirmed',
      confidence: 'high',
    },
  ],
  contractFields: {},
  paymentTerms: [],
  openReviewHints: [],
  technicalAttachmentCount: 0,
  progressBillingAllowed: false,
  segmentation: {
    pages: [],
    contractCorePages: [1],
    billOfQuantitiesPages: [2],
    technicalAttachmentPages: [],
    commercialAttachmentPages: [],
    unknownPages: [],
  },
  documentLabelKey: 'documentIntelligence.label.werkvertrag',
  classifiedKind: 'werkvertrag',
  reviewRequired: false,
} as unknown as ContractIntelligenceResult;

describe('CONTRACT-DETAIL-MAINTHREAD-YIELD-01', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('scheduleAfterPaint läuft nicht synchron beim Aufruf', () => {
    const spy = vi.fn();
    vi.useFakeTimers();
    const cancel = scheduleAfterPaint(spy);
    expect(spy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(spy).toHaveBeenCalledTimes(1);
    cancel();
  });

  it('Detailseite zeigt Shell sofort, bevor processUploadedDocument läuft', async () => {
    const item = createDeferredContractItem();
    hydrateInboxStore([item]);
    expect(itemNeedsDeferredWorkflowAnalysis(item)).toBe(true);

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${item.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('eingang-detail-analysis-pending');
    expect(html).toContain('Dokument wird weiter analysiert.');

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
    expect(processSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.runAllTimers();
    });

    expect(processSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /**
   * CORE-REALTEST-BLOCKER-01D — der Übergang von der Deferred-Shell zur fertigen
   * Seite darf die Hook-Reihenfolge nicht verändern.
   */
  it('Übergang von Analyse-Shell zur fertigen Seite ohne Hook-Order-Fehler', async () => {
    const item = createDeferredContractItem();
    hydrateInboxStore([item]);
    // Positive Vorbedingung: dieses Dokument nimmt den Deferred-Pfad.
    expect(itemNeedsDeferredWorkflowAnalysis(item)).toBe(true);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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

    // Erster Render: Analyse-Shell, fertige Seite noch nicht vorhanden.
    expect(container.querySelector('[data-testid="eingang-detail-analysis-pending"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ablage-detail-page"]')).toBeNull();

    // Analyse vollständig durchlaufen lassen — vorhandener scheduleAfterPaint-Mechanismus.
    await act(async () => {
      vi.runAllTimers();
    });

    // Zweiter Render: fertige Detailseite, keine Shell, keine Fehlerseite.
    expect(container.querySelector('[data-testid="ablage-detail-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="eingang-detail-analysis-pending"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-error-page"]')).toBeNull();

    const loggedText = consoleErrorSpy.mock.calls
      .map((call) => call.map((entry) => String(entry)).join(' '))
      .join('\n');
    expect(loggedText).not.toContain('Rendered more hooks than during the previous render');

    act(() => {
      root.unmount();
    });
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it('processUploadedDocument ruft analyzeContractIntelligenceFromInbox höchstens einmal', () => {
    const item = createSmallWerkvertragItem();
    hydrateInboxStore([item]);
    const analyzeSpy = vi
      .spyOn(contractIntelligenceService, 'analyzeContractIntelligenceFromInbox')
      .mockReturnValue(lightIntelligence);

    intakeWorkflowService.processUploadedDocument(item.id);

    expect(analyzeSpy).toHaveBeenCalledTimes(1);
  });

  it('buildContractOrderProposal mit Precompute analysiert nicht erneut', () => {
    const item = createSmallWerkvertragItem();
    hydrateInboxStore([item]);
    const analyzeSpy = vi.spyOn(
      contractIntelligenceService,
      'analyzeContractIntelligenceFromInbox',
    );
    analyzeSpy.mockClear();

    const proposal = contractIntelligenceService.buildContractOrderProposal(
      item,
      lightIntelligence,
    );
    expect(proposal).not.toBeNull();
    expect(analyzeSpy).not.toHaveBeenCalled();
  });

  it('Proposal-Erstansicht begrenzt sichtbare Zeilen', () => {
    expect(CONTRACT_PROPOSAL_INITIAL_VISIBLE_ROWS).toBe(30);
  });
});
