/**
 * OFFICEPILOT-COMPANY-IDENTITY-CONSOLIDATION-02A — Fall C, die Ablage.
 *
 * `EingangDetailPage` reichte die eigene Firmenidentität an mehreren Stellen
 * aus `setup.companyName` weiter — unter anderem an die Duplikatprüfung und die
 * Archiv-Übergabe. Weicht das Setup vom Profil ab, wurde ein Dokument damit
 * unter dem falschen Firmennamen abgelegt.
 *
 * Geprüft wird das tatsächlich übergebene Argument, nicht die Optik. Der Fall
 * liegt in einer eigenen Datei, weil er die schwere Detailseiten-Harness
 * braucht.
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { ABLAGE_REVEAL_ARCHIVE_IMPORT_STATE } from './pages/eingangDetailNavigation';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import * as documentService from './services/documentService';
import { hydrateDocumentStore } from './services/documentService';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { createAuftragInboxItem } from './test/fixtures';
import { confirmFilingDecisionForTests } from './test/confirmFilingDecisionForTests';
import { resetTestStores } from './test/resetStores';
import type { InboxItem } from './types/models';

const OLD_NAME = 'Alter Firmenname GmbH';
const NEW_NAME = 'Neuer Firmenname GmbH';

const divergentSetup = { ...DEFAULT_SETUP, setupComplete: true, companyName: OLD_NAME };

describe('COMPANY-IDENTITY-CONSOLIDATION-02A — EingangDetailPage', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetTestStores();
    resetDeferredWorkflowAnalysisCacheForTests();
    hydrateDocumentStore([]);
    hydrateCompanyProfileStore({
      ...DEFAULT_COMPANY_PROFILE,
      companyName: NEW_NAME,
      street: 'Musterallee 5',
      zip: '30000',
      city: 'Musterstadt',
      email: 'kontakt@beispielbetrieb.de',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    resetTestStores();
  });

  function seedItem(): InboxItem {
    const item = createAuftragInboxItem({
      id: 'inbox-identity-02a',
      title: 'Beispielvertrag',
      sender: 'Partner GmbH',
      classifiedKind: 'subunternehmervertrag',
      markedAsCompanyDocument: true,
    });
    hydrateInboxStore([item]);
    const stored = getInboxItemById(item.id)!;
    confirmFilingDecisionForTests(stored.id);
    return getInboxItemById(item.id)!;
  }

  async function mountDetail(itemId: string): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              { pathname: `/ablage/${itemId}`, state: ABLAGE_REVEAL_ARCHIVE_IMPORT_STATE },
            ],
          },
          createElement(
            AppProvider,
            { initialSetup: divergentSetup },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/ablage/:id',
                element: createElement(EingangDetailPage),
              }),
              createElement(Route, {
                path: '/dokumente/:id',
                element: createElement('div', null, 'Archiv'),
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
  }

  async function openArchiveSection(): Promise<void> {
    const more = container.querySelector(
      '[data-testid="document-review-more-toggle"]',
    ) as HTMLButtonElement | null;
    if (more && !container.querySelector('[data-testid="document-review-more-content"]')) {
      await act(async () => {
        more.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
    const archive = container.querySelector(
      '[data-testid="review-section-toggle-archive"]',
    ) as HTMLButtonElement | null;
    if (archive && !container.querySelector('[data-testid="review-section-content-archive"]')) {
      await act(async () => {
        archive.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it('C: die Archiv-Übergabe verwendet den Profilnamen als eigene Firma', async () => {
    const duplicateSpy = vi
      .spyOn(documentService, 'isDuplicateDocument')
      .mockReturnValue(null);
    const handoffSpy = vi
      .spyOn(documentService, 'handoffInboxItemToArchive')
      .mockReturnValue({ success: false, errorKey: 'document.saveFailed' } as never);

    const item = seedItem();
    await mountDetail(item.id);
    await openArchiveSection();

    let cta: HTMLButtonElement | null = null;
    for (let i = 0; i < 40 && !cta; i += 1) {
      cta = container.querySelector(
        '[data-testid="inbox-import-to-archive-primary-button"]',
      ) as HTMLButtonElement | null;
      if (!cta) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    }
    if (!cta) throw new Error('archive CTA missing');

    await act(async () => {
      cta!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const usedNames = [
      ...duplicateSpy.mock.calls.map((call) => call[1]),
      ...handoffSpy.mock.calls.map((call) => call[1]),
    ];
    expect(usedNames.length).toBeGreaterThan(0);
    expect(usedNames).not.toContain(OLD_NAME);
    for (const name of usedNames) {
      expect(name).toBe(NEW_NAME);
    }
  });
});
