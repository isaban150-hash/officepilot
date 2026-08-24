/**
 * OFFICEPILOT-DOCUMENT-UNLINK-DELETE-01G — der Ausweg dort, wo er gebraucht wird.
 *
 * Ein archiviertes Dokument verschwindet mit `status: 'abgelegt'` aus dem
 * Eingang; die Unlink-Aktion aus 01E war dort für den Regelfall unerreichbar.
 * Der Nutzer steht stattdessen auf der Dokumentseite — genau dort, wo der
 * Löschschutz greift. Also gehört der Ausweg daneben.
 *
 * Gelöst wird nur die Zuordnung. Beim bestätigten Auftrag bleibt das Original
 * anschließend geschützt: die Herkunft ist der Beweis, nicht die Zuordnung.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import {
  getDocumentById,
  getDocumentDeleteBlockReason,
  hydrateDocumentStore,
} from './services/documentService';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument, InboxItem, Vorgang } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const DOC_ID = 'doc-unlink-page';
const INBOX_ID = 'inbox-unlink-page';
const VORGANG_ID = 'v-unlink-page';

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

function buildDocument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: DOC_ID,
    title: 'Westfalen Werkvertrag',
    category: 'vertrag',
    issuer: 'Westfalen Projektbau GmbH',
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
    ...overrides,
  } as CompanyDocument;
}

function buildInbox(): InboxItem {
  return {
    ...createAuftragInboxItem({ id: INBOX_ID }),
    status: 'abgelegt',
    importedToArchive: true,
    archiveDocumentId: DOC_ID,
    vorgangId: VORGANG_ID,
    vorgangTitle: 'Auftrag',
    vorgangLinkStatus: 'linked',
  };
}

function buildVorgang(confirmed: boolean): Vorgang {
  const base: Vorgang = {
    ...createTestVorgang({
      id: VORGANG_ID,
      status: 'eingegangen',
      customer: 'Westfalen Projektbau GmbH',
      customerId: 'cust-1',
      createdFromInboxId: INBOX_ID,
      orderPositions: [
        createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 5 }),
      ],
    }),
    documents: [
      {
        id: 'vd-1',
        name: 'Westfalen Werkvertrag',
        type: 'kundenauftrag',
        date: '2026-03-01',
        companyDocumentId: DOC_ID,
      },
    ],
  };
  if (!confirmed) return base;
  return {
    ...base,
    status: 'beauftragt',
    contractConfirmation: {
      id: 'cc-1',
      confirmedAt: '2026-03-02T10:00:00.000Z',
      customer: 'Westfalen Projektbau GmbH',
      auftraggeber: 'Westfalen Projektbau GmbH',
      baustelle: 'Baustelle 1',
      title: 'Auftrag',
      positions: [
        { id: 'op-1', description: 'Position 1', plannedQuantity: 10, unit: 'm²', unitPrice: 5 },
      ],
      negotiation: {
        conducted: false,
        notes: [],
        generalHints: [],
        priceProposals: [],
        positionProposals: [],
        drafts: [],
      },
      immutable: true,
    },
  };
}

function seed(options: { confirmed?: boolean; withOrigin?: boolean } = {}): void {
  hydrateDocumentStore([
    buildDocument(options.withOrigin === false ? { sourceInboxItemId: undefined } : {}),
  ]);
  hydrateInboxStore([buildInbox()]);
  hydrateVorgangStore([buildVorgang(options.confirmed === true)]);
}

/**
 * Der Aktionsbereich liegt hinter „Mehr anzeigen“ — dort, wo auch das Löschen
 * sitzt. Der reale Nutzer klappt ihn auf, um zu löschen; genau dort begegnet
 * ihm der Löschschutz und daneben der Ausweg.
 */
async function openActions(mount: Mount): Promise<void> {
  await click(mount.container, 'show-more-toggle');
}

async function mountDetail(): Promise<Mount> {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/dokumente/${DOC_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/dokumente/:id',
              element: createElement(DokumentDetailPage),
            }),
            createElement(Route, {
              path: '/dokumente',
              element: createElement('div', { 'data-testid': 'dokumente-list-page' }),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

describe('OFFICEPILOT-DOKUMENT-UNLINK-VORGANG-UI-01G', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A: mit Vorgangsbezug und Herkunft ist die Aktion sichtbar', async () => {
    seed();
    const mount = await mountDetail();
    await openActions(mount);

    await waitFor(
      () => find(mount.container, 'document-unlink-vorgang-trigger') !== null,
      'Unlink-Aktion',
    );

    unmount(mount);
  });

  it('B: ohne Herkunft gibt es keine Aktion', async () => {
    seed({ withOrigin: false });
    const mount = await mountDetail();
    await openActions(mount);
    await settle();

    // Ohne sourceInboxItemId gäbe es nichts aufzurufen — dann lieber kein Knopf.
    expect(find(mount.container, 'document-unlink-vorgang-trigger')).toBeNull();

    unmount(mount);
  });

  it('C: vor der Bestätigung passiert nichts', async () => {
    seed();
    const mount = await mountDetail();
    await openActions(mount);

    await click(mount.container, 'document-unlink-vorgang-trigger');
    await waitFor(() => find(mount.container, 'document-unlink-dialog') !== null, 'Dialog');

    expect(getDocumentById(DOC_ID)?.linkedVorgang).toBeDefined();
    expect(getInboxItemById(INBOX_ID)?.vorgangId).toBe(VORGANG_ID);
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(1);

    unmount(mount);
  });

  it('D: Abbrechen verändert nichts', async () => {
    seed();
    const mount = await mountDetail();
    await openActions(mount);

    await click(mount.container, 'document-unlink-vorgang-trigger');
    await click(mount.container, 'document-unlink-cancel');

    expect(getDocumentById(DOC_ID)?.linkedVorgang).toBeDefined();
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(1);

    unmount(mount);
  });

  it('E/F: Bestätigen löst genau einmal, die Seite bleibt stehen', async () => {
    seed();
    const mount = await mountDetail();
    await openActions(mount);

    await click(mount.container, 'document-unlink-vorgang-trigger');
    await click(mount.container, 'document-unlink-confirm');

    expect(getDocumentById(DOC_ID)?.linkedVorgang ?? null).toBeNull();
    expect(getInboxItemById(INBOX_ID)?.vorgangId).toBeUndefined();
    expect(getVorgangById(VORGANG_ID)?.documents).toHaveLength(0);

    // Kein Sprung in die Liste, das Dokument bleibt geöffnet.
    expect(find(mount.container, 'dokumente-list-page')).toBeNull();
    expect(find(mount.container, 'document-detail-page')).not.toBeNull();

    // Und die Aktion verschwindet, weil es nichts mehr zu lösen gibt.
    await waitFor(
      () => find(mount.container, 'document-unlink-vorgang-trigger') === null,
      'Aktion verschwunden',
    );

    unmount(mount);
  });

  it('G: beim bestätigten Auftrag geht das Löschen ohne vorheriges Lösen durch', async () => {
    seed({ confirmed: true });
    const mount = await mountDetail();
    await openActions(mount);

    // Kein Unlink vorweg — der reale Weg des Nutzers.
    await click(mount.container, 'document-detail-delete-trigger');
    await click(mount.container, 'document-detail-delete-confirm');

    // Keine nachträgliche Blockmeldung, Rückkehr ins Archiv.
    expect(find(mount.container, 'document-delete-blocked')).toBeNull();
    await waitFor(
      () => find(mount.container, 'dokumente-list-page') !== null,
      'Rückkehr in die Dokumentliste',
    );
    expect(getDocumentById(DOC_ID)).toBeUndefined();

    // Der Auftrag ist unverändert, nur ohne Dokumenteintrag.
    const vorgang = getVorgangById(VORGANG_ID)!;
    expect(vorgang.status).toBe('beauftragt');
    expect(vorgang.contractConfirmation).toBeDefined();
    expect(vorgang.orderPositions).toHaveLength(1);
    expect(vorgang.customerId).toBe('cust-1');
    expect(vorgang.createdFromInboxId).toBe(INBOX_ID);
    expect(vorgang.documents).toHaveLength(0);

    unmount(mount);
  });

  it('H: nach dem separaten Lösen bleibt das Löschen ebenso möglich', async () => {
    seed();
    const mount = await mountDetail();
    await openActions(mount);

    await click(mount.container, 'document-unlink-vorgang-trigger');
    await click(mount.container, 'document-unlink-confirm');

    expect(getDocumentDeleteBlockReason(getDocumentById(DOC_ID)!)).toBeNull();

    await click(mount.container, 'document-detail-delete-trigger');
    await click(mount.container, 'document-detail-delete-confirm');

    expect(getDocumentById(DOC_ID)).toBeUndefined();

    unmount(mount);
  });
});
