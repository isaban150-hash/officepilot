import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider } from '../context/AppContext';
import { EingangDetailPage } from './EingangDetailPage';
import { DokumentDetailPage } from './DokumentDetailPage';
import { VorgangDetailPage } from './VorgangDetailPage';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { AusgabeDetailPage } from './AusgabeDetailPage';
import { KommunikationPage } from './KommunikationPage';
import {
  buildKommunikationPath,
  parseContextRefFromSearchParams,
} from '../components/communication/communicationNavigation';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateExpenseStore } from '../services/expenseStore';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateInboxStore } from '../services/inboxService';
import { createAbschlagInvoice, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { hydrateVorgangStore } from '../services/vorgangService';
import type { CompanyDocument, InboxItem, VorgangInvoice } from '../types/models';
import type { Expense } from '../types/expense';
import type { CommunicationContextRef } from '../types/communication';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster GmbH',
};

function createBriefInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-integration-1',
    title: 'Finanzamt Schreiben',
    sender: 'Finanzamt München',
    documentType: 'behoerde',
    priority: 'hoch',
    deadline: '2026-07-15',
    digitalFolder: { id: 'dig-1', name: 'Behörden', path: '/Behörden/' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'Behörden' },
    status: 'neu',
    receivedAt: '2026-06-01',
    officePilotSuggestion: 'Steuerbescheid',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Original aufbewahren',
    recommendedAction: 'archivieren',
    recognizedData: { Frist: '2026-07-15', Betreff: 'Steuerbescheid' },
    markedAsCompanyDocument: true,
    ...overrides,
  };
}

function createTestDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-integration-1',
    title: 'Testversicherung',
    category: 'versicherung',
    issuer: 'Test AG',
    recognizedText: 'Police 12345',
    issueDate: '2026-01-01',
    validUntil: '2027-01-01',
    digitalFolder: { id: 'dig-1', name: 'Versicherungen', path: '/Firma/Versicherungen/' },
    paperFolder: { folderId: 'folder-5', register: 'A', label: 'Behörden & Versicherungen' },
    tags: ['Test'],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

function createTestExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-integration-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'RE-INT-1',
    title: 'Integration Test Ausgabe',
    description: '',
    issueDate: '2026-06-01',
    paymentDueDate: '2099-06-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'integration-test',
    tags: [],
    digitalFolder: { id: 'dig-exp', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-exp', register: 'B', label: 'Ausgaben' },
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function createFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 5, {
    id: 'inv-integration-1',
    number: '2026-0500',
    issueDate: '2026-06-01',
    paymentDueDate: '2026-01-01',
    customerSnapshot: {
      name: 'Test Kunde',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot,
    ...overrides,
  });
}

type PageMount = { container: HTMLDivElement; root: Root };

function renderPageAt(path: string, element: ReactElement): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/ablage/:id" element={element} />
            <Route path="/eingang/:id" element={element} />
            <Route path="/dokumente/:id" element={element} />
            <Route path="/vorgaenge/:id" element={element} />
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={element} />
            <Route path="/ausgaben/:id" element={element} />
            <Route path="/kommunikation" element={element} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function expandDetailShowMore(container: ParentNode): void {
  const reviewMore = container.querySelector(
    '[data-testid="document-review-more-toggle"]',
  ) as HTMLElement | null;
  if (reviewMore) {
    act(() => {
      reviewMore.click();
    });
    // Consolidated assist flow: communication lives under "Weitere Hinweise".
    const furtherHintsToggle = container.querySelector(
      '[data-testid="review-section-toggle-further-hints"]',
    ) as HTMLElement | null;
    if (furtherHintsToggle) {
      act(() => {
        furtherHintsToggle.click();
      });
      return;
    }
    const communicationToggle = container.querySelector(
      '[data-testid="review-section-toggle-communication"]',
    ) as HTMLElement | null;
    if (communicationToggle) {
      act(() => {
        communicationToggle.click();
      });
    }
    return;
  }

  const toggle = container.querySelector('[data-testid="show-more-toggle"]') as HTMLElement | null;
  if (!toggle) {
    throw new Error('Missing show-more toggle');
  }
  act(() => {
    toggle.click();
  });
}

function getCommunicationLinks(container: ParentNode, testIdPrefix: string): HTMLAnchorElement[] {
  const panel = container.querySelector(`[data-testid="${testIdPrefix}-communication"]`);
  if (!panel) {
    throw new Error(`Missing communication panel: ${testIdPrefix}-communication`);
  }
  return Array.from(panel.querySelectorAll('a.communication-integration-link'));
}

function expectLinksMatchContext(
  container: ParentNode,
  testIdPrefix: string,
  expectedRef: CommunicationContextRef,
): void {
  const expectedPath = buildKommunikationPath(expectedRef);
  const links = getCommunicationLinks(container, testIdPrefix);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.getAttribute('href')).toBe(expectedPath);
    const params = new URLSearchParams(link.getAttribute('href')!.split('?')[1] ?? '');
    expect(parseContextRefFromSearchParams(params)).toEqual(expectedRef);
  }
}

describe('communicationNavigation', () => {
  it('builds inbox URL', () => {
    expect(buildKommunikationPath({ type: 'inbox', id: 'inbox-1' })).toBe(
      '/kommunikation?context=inbox&id=inbox-1',
    );
  });

  it('builds document URL', () => {
    expect(buildKommunikationPath({ type: 'document', id: 'doc-1' })).toBe(
      '/kommunikation?context=document&id=doc-1',
    );
  });

  it('builds vorgang URL', () => {
    expect(buildKommunikationPath({ type: 'vorgang', id: 'v-1' })).toBe(
      '/kommunikation?context=vorgang&id=v-1',
    );
  });

  it('builds invoice URL with vorgangId', () => {
    expect(
      buildKommunikationPath({ type: 'invoice', id: 'inv-1', vorgangId: 'v-1' }),
    ).toBe('/kommunikation?context=invoice&id=inv-1&vorgangId=v-1');
  });

  it('builds expense URL', () => {
    expect(buildKommunikationPath({ type: 'expense', id: 'exp-1' })).toBe(
      '/kommunikation?context=expense&id=exp-1',
    );
  });

  it('parses URL params back to ContextRef', () => {
    const params = new URLSearchParams('context=invoice&id=inv-1&vorgangId=v-1');
    expect(parseContextRefFromSearchParams(params)).toEqual({
      type: 'invoice',
      id: 'inv-1',
      vorgangId: 'v-1',
    });
  });
});

describe('communication detail page integration', () => {
  let mounted: PageMount | undefined;

  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(companySnapshot);
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('EingangDetailPage links to inbox communication context', () => {
    hydrateInboxStore([createBriefInboxItem()]);
    mounted = renderPageAt('/ablage/inbox-integration-1', <EingangDetailPage />);
    expandDetailShowMore(mounted.container);
    expectLinksMatchContext(mounted.container, 'eingang', {
      type: 'inbox',
      id: 'inbox-integration-1',
    });
  });

  it('DokumentDetailPage links to document communication context', () => {
    hydrateDocumentStore([createTestDocument()]);
    mounted = renderPageAt('/dokumente/doc-integration-1', <DokumentDetailPage />);
    expandDetailShowMore(mounted.container);
    expectLinksMatchContext(mounted.container, 'dokument', {
      type: 'document',
      id: 'doc-integration-1',
    });
  });

  it('VorgangDetailPage links to vorgang communication context', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-integration-1' })]);
    mounted = renderPageAt('/vorgaenge/v-integration-1', <VorgangDetailPage />);
    expandDetailShowMore(mounted.container);
    expectLinksMatchContext(mounted.container, 'vorgang', {
      type: 'vorgang',
      id: 'v-integration-1',
    });
  });

  it('InvoiceDetailPage links to invoice communication context', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-integration-1',
        invoices: [createFinalizedInvoice()],
      }),
    ]);
    mounted = renderPageAt(
      '/vorgaenge/v-integration-1/rechnungen/inv-integration-1',
      <InvoiceDetailPage />,
    );
    expandDetailShowMore(mounted.container);
    expectLinksMatchContext(mounted.container, 'invoice', {
      type: 'invoice',
      id: 'inv-integration-1',
      vorgangId: 'v-integration-1',
    });
  });

  it('AusgabeDetailPage links to expense communication context', () => {
    hydrateExpenseStore([createTestExpense()]);
    mounted = renderPageAt('/ausgaben/exp-integration-1', <AusgabeDetailPage />);
    expectLinksMatchContext(mounted.container, 'ausgabe', {
      type: 'expense',
      id: 'exp-integration-1',
    });
  });

  it('KommunikationPage loads context from URL and shows summary', () => {
    hydrateInboxStore([createBriefInboxItem()]);
    mounted = renderPageAt(
      '/kommunikation?context=inbox&id=inbox-integration-1',
      <KommunikationPage />,
    );
    expect(
      mounted.container.querySelector('[data-testid="communication-context-hint"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="communication-context-summary"]'),
    ).not.toBeNull();
  });
});
