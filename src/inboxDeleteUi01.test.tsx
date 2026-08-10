/**
 * DOCUMENT-INBOX-DELETE-01 — "Dokument öffnen" entry points and the delete confirm dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { InboxCard } from './components/inbox/InboxCard';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { getInboxItemById, getInboxSummary, hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { t } from './i18n';
import type { InboxItem } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

type Mount = { container: HTMLDivElement; root: Root };

function unmount(mount: Mount): void {
  act(() => {
    mount.root.unmount();
  });
  mount.container.remove();
}

async function settle(): Promise<void> {
  // Drains the async confirm chain (delete → persist → FileRef release) plus rAF focus work.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Flushes until the predicate holds — the detail page passes through async analysis shells. */
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

async function mountInboxCard(
  item: InboxItem,
  onReview: (id: string) => void,
): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(InboxCard, { item, onReview, onUpdated: () => undefined }),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

async function mountDetail(itemId: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${itemId}`] },
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
              element: createElement('div', { 'data-testid': 'ablage-list-page' }, 'Eingang'),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  await waitFor(() => find(container, testId) !== null, testId);
  const element = find(container, testId) as HTMLButtonElement;
  await act(async () => {
    element.click();
  });
  await settle();
}

describe('DOCUMENT-INBOX-DELETE-01 – UI', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('Eingang: "Dokument öffnen" öffnet die Detailseite über onReview', async () => {
    const item = createAuftragInboxItem({ id: 'inbox-open-ui' });
    hydrateInboxStore([item]);
    const reviewed: string[] = [];
    const mount = await mountInboxCard(item, (id) => reviewed.push(id));

    const openButton = mount.container.querySelector(
      `[data-testid="inbox-open-document-${item.id}"]`,
    );
    expect(openButton?.textContent).toBe(t('inbox.openDocument', 'de'));

    await click(mount.container, `inbox-open-document-${item.id}`);
    expect(reviewed).toEqual([item.id]);

    unmount(mount);
  });

  it('Detailseite: SimpleConfirmDialog löscht das Dokument und kehrt zum Eingang zurück', async () => {
    const item = createAuftragInboxItem({ id: 'inbox-delete-ui-ok' });
    hydrateInboxStore([item]);
    const mount = await mountDetail(item.id);

    await waitFor(() => find(mount.container, 'inbox-delete-trigger') !== null, 'delete trigger');
    expect(find(mount.container, 'inbox-delete-dialog')).toBeNull();

    await click(mount.container, 'inbox-delete-trigger');
    const dialog = find(mount.container, 'inbox-delete-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(t('inbox.delete.confirmTitle', 'de'));
    expect(dialog?.textContent).toContain(t('inbox.delete.confirmMessage', 'de'));
    expect(dialog?.textContent).toContain(t('inbox.delete.confirmButton', 'de'));
    expect(dialog?.textContent).toContain(t('common.cancel', 'de'));

    await click(mount.container, 'inbox-delete-confirm');

    expect(getInboxItemById(item.id)).toBeUndefined();
    expect(getInboxSummary().total).toBe(0);
    await waitFor(
      () => find(mount.container, 'ablage-list-page') !== null,
      'navigation back to inbox',
    );

    unmount(mount);
  });

  it('Detailseite: blockiertes Dokument zeigt eine verständliche Fehlermeldung', async () => {
    const item = createAuftragInboxItem({
      id: 'inbox-delete-ui-blocked',
      vorgangId: 'v-ui-1',
      vorgangTitle: 'Auftrag 1',
    });
    hydrateInboxStore([item]);
    const mount = await mountDetail(item.id);

    await click(mount.container, 'inbox-delete-trigger');
    await click(mount.container, 'inbox-delete-confirm');

    await waitFor(
      () => find(mount.container, 'simple-confirm-error') !== null,
      'blocked delete message',
    );
    const error = find(mount.container, 'simple-confirm-error');
    expect(error?.textContent).toBe(t('inbox.delete.blocked.vorgang', 'de'));
    expect(find(mount.container, 'inbox-delete-dialog')).not.toBeNull();
    expect(getInboxItemById(item.id)).toBeDefined();

    unmount(mount);
  });
});
