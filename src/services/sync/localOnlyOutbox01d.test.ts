/**
 * REAL-PRODUCT-TEST-01D — nur-lokale Entitäten bleiben keine dauerhafte Cloud-Sendeaufgabe.
 *
 *  1  eine nur-lokale Entität (Papierregister) wird lokal gespeichert und getrackt
 *  2  ihr Outbox-Eintrag wird beim Cloud-Push abgeschlossen (nie gesendet, nie dauerhaft „ausstehend")
 *  3  eine cloud-fähige Entität wird weiterhin normal eingereiht und gesendet
 *  4  blockierte/fehlgeschlagene cloud-fähige Einträge bleiben unverändert
 *  5  SyncPage-Status zählt danach keine wartende Änderung mehr, echte wartende weiterhin
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import { STORAGE_VERSION } from './syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests, resetSyncChangeTrackerFromState, trackPersistedChanges } from './syncChangeTrackerService';
import { SupabaseSyncAdapter } from './supabaseSyncAdapter';
import { summarizeSyncStatus } from './syncUiService';
import { generateUuid } from './syncMetaService';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import * as supabaseLib from '../../lib/supabase';

function buildState(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    invoiceEntries: [],
    syncClient: { ...client, serverWorkspaceId: 'ws-1', workspaceId: 'ws-1' },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  } as AppPersistedState;
}

function entry(overrides: Partial<SyncOutboxEntry>): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType: 'customer',
    entityId: 'c-1',
    operation: 'update',
    version: 2,
    queuedAt: '2026-09-16T09:00:00.000Z',
    retryCount: 0,
    status: 'pending',
    ...overrides,
  } as SyncOutboxEntry;
}

const registerEntry = {
  id: 'reg-1',
  documentId: 'doc-1',
  documentTitle: 'Beleg',
  folderId: 'f-1',
  register: 'A',
  label: 'Ordner A',
  filedAt: '2026-09-16T09:00:00.000Z',
  sync: { version: 1, updatedAt: '2026-09-16T09:00:00.000Z', deviceId: 'dev', deleted: false },
};

describe('REAL-PRODUCT-TEST-01D — nur-lokale Outbox-Einträge', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    vi.restoreAllMocks();
  });

  it('1+2: nur-lokale Entität wird lokal getrackt und ihr Sendeauftrag beim Push abgeschlossen', async () => {
    const base = buildState();
    resetSyncChangeTrackerFromState(base);
    const withRegister = buildState({ officePilotMemory: { documentMemories: [], proofMemories: [], relations: [], paperRegisterEntries: [registerEntry] } } as Partial<AppPersistedState>);
    trackPersistedChanges(withRegister);
    const queued = getSyncOutboxSnapshot().filter((e) => e.entityType === 'paper_register_entry');
    // Die lokale Speicherung/Verfolgung ist unverändert — der Eintrag entsteht.
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('pending');

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsertSpy = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity').mockResolvedValue({ rowVersion: 1, payload: {} });
    const adapter = new SupabaseSyncAdapter(null);
    const result = await adapter.pushChanges({ deviceId: 'dev', workspaceId: 'ws-1', state: withRegister, outbox: queued });

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(result.completedOutboxIds).toEqual([queued[0]!.id]);
    expect(result.failedOutbox).toEqual([]);
    // lokale Daten unberührt
    expect(withRegister.officePilotMemory?.paperRegisterEntries).toHaveLength(1);
  });

  it('3+4: cloud-fähige Einträge werden gesendet; blockierte/fehlgeschlagene bleiben, wie sie sind', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsertSpy = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity').mockResolvedValue({ rowVersion: 3, payload: {} });
    const adapter = new SupabaseSyncAdapter(null);
    vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});

    const customerPending = entry({ entityType: 'customer', entityId: 'c-1' });
    const blocked = entry({ id: 'ob-blocked', entityType: 'company_profile', entityId: 'cp-1', status: 'blocked' });
    const localOnly = entry({ id: 'ob-local', entityType: 'document_memory', entityId: 'mem-1' });
    const state = buildState({
      customers: [{ id: 'c-1', name: 'Kunde', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', sync: { version: 2, updatedAt: '2026-09-01T00:00:00.000Z', deviceId: 'dev', deleted: false } }],
    } as Partial<AppPersistedState>);

    const result = await adapter.pushChanges({ deviceId: 'dev', workspaceId: 'ws-1', state, outbox: [customerPending, blocked, localOnly] });

    const upsertedTypes = upsertSpy.mock.calls.map((call) => call[1]);
    expect(upsertedTypes).toContain('customer');
    expect(upsertedTypes).not.toContain('document_memory');
    expect(result.failedOutbox.map((f) => f.outboxId)).not.toContain('ob-blocked');
    expect(result.completedOutboxIds).toContain('ob-local');
    expect(result.completedOutboxIds).not.toContain('ob-blocked');
  });

  it('5: Status zählt nur cloud-fähige wartende Änderungen', () => {
    const snapshot = {
      status: { syncState: 'synced' as const, pendingChanges: 0, lastSyncedAt: '2026-09-16T10:00:00.000Z' },
      lastReport: null,
      isOffline: false,
      outbox: [entry({ entityType: 'paper_register_entry', entityId: 'reg-1' })],
    };
    expect(summarizeSyncStatus(snapshot)).toMatchObject({ kind: 'synced', waitingCount: 0 });
    snapshot.outbox.push(entry({ entityType: 'expense', entityId: 'exp-1' }));
    expect(summarizeSyncStatus(snapshot)).toMatchObject({ kind: 'waiting', waitingCount: 1 });
  });
});
