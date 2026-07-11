import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { hydrateDocumentStore } from './services/documentService';
import { hydrateInboxStore, processUpload } from './services/inboxService';
import { createTestVorgang } from './test/fixtures';
import { hydrateVorgangStore } from './services/vorgangService';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import type { CompanyDocument, VorgangInvoice } from './types/models';

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ux05',
    number: '2026-0099',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-ux05',
        orderPositionId: 'op-test-1',
        description: 'Sanitärarbeiten',
        quantity: 10,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 650,
      },
    ],
    subtotal: 650,
    taxStatus: 'standard_19',
    amount: 773.5,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    customerSnapshot: {
      name: 'Familie Müller',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Test GmbH',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  };
}

const FORBIDDEN = [
  'Smart',
  'Workflow',
  'OCR',
  'Inbox',
  'Engine',
  'Context',
  'Snapshot',
  'Prompt',
  'Entity',
  'Area AI',
  'Gemini',
  'KI-Vorschlag',
];

const sampleDocument: CompanyDocument = {
  id: 'doc-ux05',
  title: 'Freistellungsbescheinigung',
  category: 'steuer',
  issuer: 'Finanzamt',
  recognizedText: 'Gültig bis 2026',
  issueDate: '2026-01-01',
  validUntil: '2026-12-31',
  digitalFolder: { id: 'd', name: 'Steuer', path: '/Steuer' },
  paperFolder: { folderId: 'folder-4', register: '2026', label: 'Steuer' },
  tags: [],
  linkedCompany: 'Test GmbH',
  linkedVorgang: null,
  archived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('UX-05 Detail experience', () => {
  beforeEach(() => {
    hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
    hydrateDocumentStore([sampleDocument]);
    const vorgang = createTestVorgang({ id: 'v-ux05', title: 'Bad Sanierung Müller' });
    hydrateVorgangStore([vorgang]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DokumentDetailPage zeigt Ergebnis zuerst und klappt Technik ein', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/dokumente/doc-ux05']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="document-detail-experience"');
    expect(html).toContain('Mehr anzeigen');
    expect(html).not.toContain('data-testid="show-more-content"');
    expect(html).not.toContain('data-testid="document-ai-panel"');
    for (const term of FORBIDDEN) {
      expect(html).not.toContain(term);
    }
  });

  it('VorgangDetailPage zeigt Kopfkarte und klappt Details ein', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/vorgaenge/v-ux05']}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="vorgang-detail-experience"');
    expect(html).toContain('Rechnung schreiben');
    expect(html).not.toContain('data-testid="vorgang-ai-panel"');
    for (const term of FORBIDDEN) {
      expect(html).not.toContain(term);
    }
  });

  it('EingangDetailPage zeigt DocumentReviewExperience vor eingeklappten Panels', () => {
    const uploaded = processUpload({ kind: 'auftrag' });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ablage/${uploaded.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="document-review-experience"');
    expect(html).toContain('Weitere Optionen');
    expect(html).not.toContain('data-testid="document-review-more-content"');
  });

  it('InvoiceDetailPage zeigt Ergebnis-Kopfkarte wenn Rechnung finalisiert', () => {
    const invoice = createFinalizedInvoice();
    const vorgang = createTestVorgang({
      id: 'v-inv-ux05',
      title: 'Bad Müller',
      customer: 'Familie Müller',
      invoices: [invoice],
    });
    hydrateVorgangStore([vorgang]);

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/vorgaenge/v-inv-ux05/rechnungen/${invoice.id}`]}>
        <AppProvider initialSetup={DEFAULT_SETUP}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="invoice-detail-experience"');
    expect(html).toContain('Mehr anzeigen');
    expect(html).not.toContain('data-testid="show-more-content"');
  });
});
