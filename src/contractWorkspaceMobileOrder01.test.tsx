import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createAuftragInboxItem } from './test/fixtures';
import type { InboxItem } from './types/models';
import { SAMPLE_WERKVERTRAG_TEXT } from './services/contractAnalysisService';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';

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

function createContractWithProposalItem(): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-mobile-order-contract',
    title: 'Werkvertrag Mobil',
    classifiedKind: 'werkvertrag',
    documentType: 'werkvertrag',
    fileRefId: 'file-ref-mobile-order-contract',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      Betreff: 'Mustermann Sanitär GmbH',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      _extractedText: SAMPLE_WERKVERTRAG_TEXT,
    },
  });
}

function createNonContractItem(): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-mobile-order-auftrag',
    title: 'Kleiner Auftrag',
    classifiedKind: 'auftrag',
    fileRefId: 'file-ref-mobile-order-auftrag',
    recognizedData: {
      Leistung: 'Reparatur',
      Angebotssumme: '120 €',
      Betreff: 'Mustermann Sanitär GmbH',
    },
  });
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

function assertOrder(html: string, earlier: string, later: string) {
  const earlyIdx = html.indexOf(earlier);
  const lateIdx = html.indexOf(later);
  expect(earlyIdx, `missing ${earlier}`).toBeGreaterThan(-1);
  expect(lateIdx, `missing ${later}`).toBeGreaterThan(-1);
  expect(earlyIdx).toBeLessThan(lateIdx);
}

describe('CONTRACT-WORKSPACE-MOBILE-ORDER-01', () => {
  beforeEach(() => {    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    resetTestStores();
  });

  it('Contract mit Proposal: Review/Workspace vor Free Question und Original', () => {
    const item = createContractWithProposalItem();
    hydrateInboxStore([item]);
    const html = renderDetail(item.id);

    expect(html).toContain('contract-order-proposal');
    expect(html).toContain('data-testid="auftragskarte"');
    expect(html).toContain('data-testid="contract-workspace-summary"');
    // UX-02: no document-assistant hero above the Auftragskarte.
    expect(html).not.toContain('data-testid="document-assistant-panel"');
    assertOrder(html, 'data-testid="auftragskarte"', 'data-testid="ablage-original-file"');
    assertOrder(html, 'data-testid="ablage-original-file"', 'data-testid="document-free-question-panel"');
  });

  it('Ohne Proposal: Experience-Card vor Free Question und Original', () => {
    const item = createNonContractItem();
    hydrateInboxStore([item]);
    const html = renderDetail(item.id);

    expect(html).not.toContain('contract-order-proposal');
    // DOCUMENT-EXPERIENCE-02B: shared Experience Card; no Assistant hero.
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).not.toContain('data-testid="document-assistant-panel"');
    expect(html).not.toContain('data-testid="operational-overview"');
    assertOrder(html, 'data-testid="document-experience-card"', 'data-testid="document-free-question-panel"');
    assertOrder(html, 'data-testid="document-free-question-panel"', 'data-testid="ablage-original-file"');
  });
});
