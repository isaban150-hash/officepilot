/**
 * OFFICEPILOT-DOCUMENT-UNLINK-DELETE-01E — der Nutzerweg aus der Sackgasse.
 *
 * Bisher verwies die Löschsperre auf eine Aktion, die es nirgends gab. Jetzt
 * liegt sie dort, wo der Nutzer scheitert: auf der Eingangsseite selbst — und
 * daneben der Weg zum Archivoriginal, das die zweite Sperre erklärt.
 *
 * Confirm-first: vor der Bestätigung passiert nichts, und gelöst wird nur die
 * Zuordnung, nie der Vorgang.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { hydrateDocumentStore } from './services/documentService';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument, InboxItem } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const INBOX_ID = 'inbox-unlink-ui';
const DOC_ID = 'doc-unlink-ui';
const VORGANG_ID = 'v-unlink-ui';

type Mount = { container: HTMLDivElement; root: Root };

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function find(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  await waitFor(() => find(container, testId) !== null, testId);
  const element = find(container, testId) as HTMLButtonElement;
  await act(async () => element.click());
  await settle();
}

function seed(): void {
  const document: CompanyDocument = {
    id: DOC_ID,
    title: 'Werkvertrag Original',
    category: 'vertrag',
    issuer: 'Beispiel Bau GmbH',
    recognizedText: 'Werkvertrag',
    issueDate: '2026-03-01',
    digitalFolder: { id: 'dig-1', name: 'Verträge', path: '/Firma/Vertraege/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Verträge' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: { vorgangId: VORGANG_ID, vorgangTitle: 'Auftrag' },
    sourceInboxItemId: INBOX_ID,
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
  } as CompanyDocument;

  const item: InboxItem = {
    ...createAuftragInboxItem({ id: INBOX_ID }),
    archiveDocumentId: DOC_ID,
    importedToArchive: true,
    vorgangId: VORGANG_ID,
    vorgangTitle: 'Auftrag',
    vorgangLinkStatus: 'linked',
  };

  hydrateDocumentStore([document]);
  hydrateInboxStore([item]);
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'eingegangen',
        customer: 'Beispiel Bau GmbH',
        createdFromInboxId: INBOX_ID,
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 5 }),
        ],
      }),
      documents: [
        {
          id: 'vd-1',
          name: 'Werkvertrag Original',
          type: 'kundenauftrag',
          date: '2026-03-01',
          companyDocumentId: DOC_ID,
        },
      ],
    },
  ]);
}

async function mountDetail(): Promise<Mount> {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${INBOX_ID}`] },
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
              path: '/ablage',
              element: createElement('div', { 'data-testid': 'ablage-list-page' }),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

describe('OFFICEPILOT-INBOX-UNLINK-VORGANG-UI-01E', () => {
  beforeEach(() => {
    resetTestStores();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('O1: die Aktion ist vorhanden und ändert vor der Bestätigung nichts', async () => {
    const mount = await mountDetail();

    await click(mount.container, 'inbox-unlink-vorgang-trigger');
    await waitFor(() => find(mount.container, 'inbox-unlink-dialog') !== null, 'Dialog');

    // Noch nichts gelöst.
    expect(getInboxItemById(INBOX_ID)?.vorgangId).toBe(VORGANG_ID);
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(1);

    unmount(mount);
  });

  it('O2: Abbrechen verändert nichts', async () => {
    const mount = await mountDetail();

    await click(mount.container, 'inbox-unlink-vorgang-trigger');
    await click(mount.container, 'inbox-unlink-cancel');

    expect(getInboxItemById(INBOX_ID)?.vorgangId).toBe(VORGANG_ID);
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(1);

    unmount(mount);
  });

  it('O3: Bestätigen löst genau die Zuordnung und löscht nichts', async () => {
    const mount = await mountDetail();

    await click(mount.container, 'inbox-unlink-vorgang-trigger');
    await click(mount.container, 'inbox-unlink-confirm');

    expect(getInboxItemById(INBOX_ID)?.vorgangId).toBeUndefined();
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(0);

    // Nichts wurde gelöscht — Vorgang und Eingangsobjekt bestehen weiter.
    expect(getVorgangById(VORGANG_ID)).toBeDefined();
    expect(getVorgangById(VORGANG_ID)?.orderPositions).toHaveLength(1);
    expect(getInboxItemById(INBOX_ID)).toBeDefined();

    // Die Aktion verschwindet, weil es nichts mehr zu lösen gibt.
    await waitFor(
      () => find(mount.container, 'inbox-unlink-vorgang-trigger') === null,
      'Aktion verschwunden',
    );

    unmount(mount);
  });

  it('O4: der Weg zum Archivoriginal ist vorhanden', async () => {
    const mount = await mountDetail();

    await waitFor(
      () => find(mount.container, 'inbox-open-archive-document') !== null,
      'Archivlink',
    );
    const link = find(mount.container, 'inbox-open-archive-document') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/dokumente/${DOC_ID}`);

    unmount(mount);
  });
});
