/**
 * ARCHIVE-TRUTH-UX-01 — reveal existing archive-import path after gate blocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ABLAGE_REVEAL_ARCHIVE_IMPORT_STATE } from './pages/eingangDetailNavigation';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import {
  getDocumentById,
  hydrateDocumentStore,
} from './services/documentService';
import * as documentService from './services/documentService';
import {
  getInboxItemById,
  hydrateInboxStore,
} from './services/inboxService';
import { confirmFiling } from './services/inboxTaskService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { createAuftragInboxItem } from './test/fixtures';
import { confirmFilingDecisionForTests } from './test/confirmFilingDecisionForTests';
import { resetTestStores } from './test/resetStores';
import type { InboxItem } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

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

function seedItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-archive-truth-ux-01',
    title: 'Subunternehmervertrag Mustermann Sanitär GmbH',
    sender: 'Partner GmbH',
    classifiedKind: 'subunternehmervertrag',
    markedAsCompanyDocument: true,
    recognizedData: {
      Leistung: 'Sanierung',
      Auftraggeber: 'Mustermann Sanitär GmbH',
    },
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

type Mount = { container: HTMLDivElement; root: Root };

async function mountDetail(
  itemId: string,
  options?: { revealArchiveImport?: boolean },
): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const entry = options?.revealArchiveImport
    ? { pathname: `/ablage/${itemId}`, state: ABLAGE_REVEAL_ARCHIVE_IMPORT_STATE }
    : `/ablage/${itemId}`;

  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement(EingangDetailPage),
            }),
            createElement(Route, {
              path: '/dokumente/:id',
              element: createElement('div', { 'data-testid': 'archive-doc-page' }, 'Archiv'),
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
  return { container, root };
}

function unmount(mount: Mount) {
  act(() => {
    mount.root.unmount();
  });
  mount.container.remove();
}

async function openMoreOptions(container: HTMLElement): Promise<void> {
  if (container.querySelector('[data-testid="document-review-more-content"]')) return;
  const toggle = container.querySelector(
    '[data-testid="document-review-more-toggle"]',
  ) as HTMLButtonElement | null;
  if (!toggle) throw new Error('more-options toggle missing');
  await act(async () => {
    toggle.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  const archiveToggle = container.querySelector(
    '[data-testid="review-section-toggle-archive"]',
  ) as HTMLButtonElement | null;
  if (
    archiveToggle &&
    !container.querySelector('[data-testid="review-section-content-archive"]')
  ) {
    await act(async () => {
      archiveToggle.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function waitForPrimaryCta(container: HTMLElement): Promise<HTMLButtonElement> {
  await openMoreOptions(container);
  for (let i = 0; i < 40; i += 1) {
    const button = container.querySelector(
      '[data-testid="inbox-import-to-archive-primary-button"]',
    ) as HTMLButtonElement | null;
    if (button) return button;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error('primary archive CTA missing');
}

describe('ARCHIVE-TRUTH-UX-01', () => {
  beforeEach(() => {    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateCompanyProfileStore(testProfile);
    hydrateDocumentStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('filingRequiresArchive-Handoff öffnet moreOptionsExpanded und Archiv-Sektion', async () => {
    const item = seedItem();
    const blocked = confirmFiling(item.id);
    expect(blocked?.success).toBe(false);
    expect(blocked?.messageKey).toBe('inbox.toast.filingRequiresArchive');

    const mount = await mountDetail(item.id, { revealArchiveImport: true });
    expect(mount.container.querySelector('[data-testid="document-review-more-content"]')).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="review-section-content-archive"]'),
    ).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="inbox-import-to-archive-primary"]'),
    ).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="inbox-import-to-archive-primary-button"]'),
    ).toBeTruthy();
    unmount(mount);
  });

  it('filingDecision.confirmRequired öffnet denselben Archivpfad über Primary-CTA', async () => {
    const item = seedItem();
    const mount = await mountDetail(item.id);
    const primary = await waitForPrimaryCta(mount.container);

    await act(async () => {
      primary.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mount.container.querySelector('[data-testid="document-review-more-content"]')).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="review-section-content-archive"]'),
    ).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="document-filing-decision"]'),
    ).toBeTruthy();
    expect(getInboxItemById(item.id)?.status).toBe('neu');
    expect(getInboxItemById(item.id)?.importedToArchive).not.toBe(true);
    unmount(mount);
  });

  it('bestehender Import-Handler: Primary-CTA archiviert nach K1', async () => {
    const item = seedItem();
    confirmFilingDecisionForTests(item.id);
    const mount = await mountDetail(item.id);
    const primary = await waitForPrimaryCta(mount.container);

    await act(async () => {
      primary.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const updated = getInboxItemById(item.id)!;
    expect(updated.importedToArchive).toBe(true);
    expect(updated.archiveDocumentId).toBeTruthy();
    expect(getDocumentById(updated.archiveDocumentId!)).toBeDefined();
    expect(
      mount.container.querySelector('[data-testid="inbox-import-to-archive-primary"]'),
    ).toBeNull();
    expect(mount.container.querySelector('[data-testid="archive-doc-page"]')).toBeTruthy();
    unmount(mount);
  });

  it('Import-Fail lässt Inbox offen und Archivbereich sichtbar', async () => {
    const item = seedItem();
    confirmFilingDecisionForTests(item.id);
    // Die Seite ruft seit R02 den gemeinsamen Handoff — das ist die produktive Grenze,
    // an der ein Importfehler entsteht.
    vi.spyOn(documentService, 'handoffInboxItemToArchive').mockReturnValue({
      success: false,
      errorKey: 'document.titleRequired',
    });
    const docsBefore = documentService
      .getDocumentStoreSnapshot()
      .filter((doc) => doc.sourceInboxItemId === item.id).length;

    const mount = await mountDetail(item.id, { revealArchiveImport: true });
    const primary = await waitForPrimaryCta(mount.container);

    await act(async () => {
      primary.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getInboxItemById(item.id)?.status).toBe('neu');
    expect(getInboxItemById(item.id)?.importedToArchive).not.toBe(true);
    expect(getInboxItemById(item.id)?.archiveDocumentId).toBeUndefined();
    // Kein Archivdokument als Nebenwirkung eines gescheiterten Handoffs.
    expect(
      documentService.getDocumentStoreSnapshot().filter(
        (doc) => doc.sourceInboxItemId === item.id,
      ).length,
    ).toBe(docsBefore);
    expect(mount.container.querySelector('[data-testid="document-review-more-content"]')).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="review-section-content-archive"]'),
    ).toBeTruthy();
    expect(
      mount.container.querySelector('[data-testid="inbox-import-to-archive-primary"]'),
    ).toBeTruthy();
    unmount(mount);
  });
});
