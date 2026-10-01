/**
 * P1 INTAKE-VERSIONSKONFLIKT — `sync.version` eines Eingangs ist die zuletzt
 * vom Server bestätigte `row_version`, nie ein lokaler Zähler.
 *
 * Realbefund: Nach dem ersten Sync (Server v1) zählte jede lokale Änderung die
 * Version selbst auf 2 hoch; `upsert_workspace_intake_entity` prüft exakt und
 * meldete „Versionskonflikt inbox_item:1" — der Eintrag blieb blockiert, die
 * Verknüpfung erreichte die Cloud nie. Dieselbe Korrektur wie 07B-FIX2 für
 * Archivdokumente.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../data/mockData';
import type { AppPersistedState, InboxItem } from '../types/models';
import type { SyncMeta } from '../types/sync';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { pushIntakeEntity } from './document/intakeCloudPushService';
import {
  deleteInboxItem,
  getInboxItemById,
  getInboxStoreSnapshot,
  hydrateInboxStore,
  patchInboxItem,
  stageInboxItemPatch,
  stageInboxItemTombstone,
} from './inboxService';
import { hydrateVorgangStore, linkInboxToExistingVorgang } from './vorgangService';
import { createSyncClient, resetSyncClientForTests } from './sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './sync/syncChangeTrackerService';
import { STORAGE_VERSION } from './sync/syncMigrationService';
import { extractCloudSyncEntity } from './workspace/workspaceSyncPayloadService';

const WS = 'ws-inbox-version';

function confirmed(version: number): SyncMeta {
  return { updatedAt: '2026-10-01T08:00:00.000Z', version, deleted: false, deviceId: 'dev-a', workspaceId: WS };
}

/** Ein bereits synchronisierter Eingang: Server hat v`version` bestätigt. */
function syncedItem(id: string, version = 1): InboxItem {
  return { ...createAuftragInboxItem({ id }), sync: confirmed(version) } as InboxItem;
}

function stateWith(items: InboxItem[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WS, workspaceId: WS },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    inboxItems: items,
    vorgaenge: [],
    customers: [],
    tasks: [],
    documents: [],
    savedAt: '2026-10-01T08:00:00.000Z',
  } as AppPersistedState;
}

/** Push über den echten Intake-Push-Pfad; der Client protokolliert die gesendete Erwartung. */
async function pushedExpectation(item: InboxItem, operation: 'create' | 'update' | 'delete') {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: { row_version: Number(args.p_row_version) + 1, deleted: false, payload: {} }, error: null };
    },
  } as unknown as SupabaseClient;
  const extracted = extractCloudSyncEntity(stateWith([item]), 'inbox_item', item.id);
  expect(extracted).not.toBeNull();
  await pushIntakeEntity(extracted!, operation, WS, client);
  expect(calls).toHaveLength(1);
  const payload = calls[0].p_payload as { deleted?: boolean };
  return { rowVersion: Number(calls[0].p_row_version), deleted: Boolean(payload.deleted) };
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests(createSyncClient());
});

describe('P1 Intake-Versionskonflikt — Server-Version bleibt Server-Version', () => {
  it('U1: synchronisierter Eingang (v1) → fachlicher Patch → Version bleibt 1, Push erwartet 1', async () => {
    hydrateInboxStore([syncedItem('inbox-u1')]);
    const staged = stageInboxItemPatch('inbox-u1', { status: 'geprueft' });
    expect(staged?.sync?.version).toBe(1);
    const patched = patchInboxItem('inbox-u1', { title: 'Geänderter Titel' })!;
    expect(patched.sync).toEqual(confirmed(1));
    expect(getInboxItemById('inbox-u1')!.title).toBe('Geänderter Titel');
    expect(await pushedExpectation(getInboxItemById('inbox-u1')!, 'update')).toEqual({ rowVersion: 1, deleted: false });
  });

  it('U1b: realer Writer „mit Vorgang verknüpfen" — Version bleibt 1, Push erwartet 1', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-link' })]);
    hydrateInboxStore([syncedItem('inbox-link')]);
    const linked = linkInboxToExistingVorgang(getInboxItemById('inbox-link')!, 'v-link');
    expect(linked).not.toBeNull();
    const stored = getInboxItemById('inbox-link')!;
    expect(stored.vorgangId).toBe('v-link');
    expect(stored.sync?.version).toBe(1);
    expect(await pushedExpectation(stored, 'update')).toEqual({ rowVersion: 1, deleted: false });
  });

  it('U2: synchronisierter Eingang (v1) → Löschen (beide Pfade) → Erwartung 1, deleted', async () => {
    hydrateInboxStore([syncedItem('inbox-u2a'), syncedItem('inbox-u2b')]);
    expect(stageInboxItemTombstone('inbox-u2a')).not.toBeNull();
    const result = await deleteInboxItem('inbox-u2b');
    expect(result?.success).not.toBe(false);
    for (const id of ['inbox-u2a', 'inbox-u2b']) {
      const tombstone = getInboxStoreSnapshot().find((item) => item.id === id)!;
      expect(tombstone.sync?.deleted, id).toBe(true);
      expect(tombstone.sync?.version, id).toBe(1);
      expect(await pushedExpectation(tombstone, 'delete'), id).toEqual({ rowVersion: 1, deleted: true });
    }
  });

  it('U3: nie synchronisierter Eingang → Patch und Löschen erfinden keine Serverversion, Create erwartet 0', async () => {
    const fresh = createAuftragInboxItem({ id: 'inbox-u3' }) as InboxItem;
    expect(fresh.sync).toBeUndefined();
    hydrateInboxStore([fresh, createAuftragInboxItem({ id: 'inbox-u3-del' }) as InboxItem]);
    const patched = patchInboxItem('inbox-u3', { status: 'geprueft' })!;
    expect(patched.sync?.version ?? 0).toBe(0);
    expect(await pushedExpectation(patched, 'create')).toEqual({ rowVersion: 0, deleted: false });
    // Schneller zweiter Edit vor dem ersten Ack: weiterhin keine erfundene Version.
    const again = patchInboxItem('inbox-u3', { title: 'Zweiter Edit' })!;
    expect(again.sync?.version ?? 0).toBe(0);

    expect(stageInboxItemTombstone('inbox-u3-del')).not.toBeNull();
    const tombstone = getInboxStoreSnapshot().find((item) => item.id === 'inbox-u3-del')!;
    expect(tombstone.sync?.version ?? 0).toBe(0);
    expect(await pushedExpectation(tombstone, 'delete')).toEqual({ rowVersion: 0, deleted: true });
  });

  it('U4: Änderung ohne Versionsbump wird vom Change-Tracker genau einmal als Update vorgemerkt', () => {
    const item = syncedItem('inbox-u4');
    resetSyncChangeTrackerFromState(stateWith([item]));
    hydrateInboxStore([item]);
    const patched = stageInboxItemPatch('inbox-u4', { vorgangId: 'v-x', vorgangLinkStatus: 'linked' })!;
    expect(patched.sync?.version).toBe(1);
    trackPersistedChanges(stateWith([patched]));
    const entries = getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'inbox_item' && entry.entityId === 'inbox-u4');
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('update');
    // Unveränderter Inhalt erzeugt nichts Neues.
    trackPersistedChanges(stateWith([patched]));
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityId === 'inbox-u4')).toHaveLength(1);
  });
});
