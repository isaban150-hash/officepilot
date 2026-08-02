import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_VORGAENGE, DEFAULT_SETUP } from './data/mockData';
import type { AppPersistedState, Vorgang } from './types/models';
import { createTestVorgang } from './test/fixtures';
import {
  isCloudSyncBlockedMockVorgangId,
  listCloudCleanupMockVorgangIds,
} from './services/storage/mockDataDetectionService';
import { planMockVorgangCloudCleanup } from './services/storage/mockVorgangCloudCleanupService';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from './services/sync/syncClientService';
import {
  getSyncOutboxSnapshot,
  resetSyncOutboxForTests,
} from './services/sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './services/sync/syncChangeTrackerService';
import { SupabaseSyncAdapter } from './services/sync/supabaseSyncAdapter';
import { generateUuid } from './services/sync/syncMetaService';
import { hydrateVorgangStore } from './services/vorgangService';
import * as workspaceCloudService from './services/workspace/workspaceCloudService';
import * as supabaseLib from './lib/supabase';

function withSync(vorgang: Vorgang, workspaceId = 'ws-1'): Vorgang {
  return {
    ...vorgang,
    sync: {
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 1,
      deleted: false,
      deviceId: 'dev-1',
      workspaceId,
      ...(vorgang.sync ?? {}),
    },
  };
}

function buildState(vorgaenge: Vorgang[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: 'ws-1', workspaceId: 'ws-1' },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge,
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: '2026-07-01T10:00:00.000Z',
  };
}

describe('DATA-CLEAN mock cloud sync guards', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    hydrateVorgangStore([]);
    vi.restoreAllMocks();
  });

  it('blocks only known demo IDs (no title heuristic for cloud sync)', () => {
    expect(isCloudSyncBlockedMockVorgangId('v-001')).toBe(true);
    expect(isCloudSyncBlockedMockVorgangId('v-002')).toBe(true);
    expect(isCloudSyncBlockedMockVorgangId('v-003')).toBe(true);
    expect(isCloudSyncBlockedMockVorgangId('v-real-99')).toBe(false);
    expect(listCloudCleanupMockVorgangIds()).toEqual(['v-001', 'v-002', 'v-003']);
  });

  it('demo vorgaenge erzeugen keine Outbox-Einträge', () => {
    const mocks = MOCK_VORGAENGE.map((v) => withSync({ ...v }));
    const state = buildState(mocks);
    hydrateVorgangStore(state.vorgaenge);
    resetSyncChangeTrackerFromState(state);

    trackPersistedChanges({
      ...state,
      vorgaenge: mocks.map((v) => ({
        ...v,
        title: `${v.title} changed`,
        sync: { ...v.sync!, version: 2, updatedAt: '2026-07-02T10:00:00.000Z' },
      })),
    });

    expect(getSyncOutboxSnapshot().filter((e) => e.entityType === 'vorgang')).toEqual([]);
  });

  it('echte Vorgänge werden weiterhin synchronisiert (Outbox)', () => {
    const real = withSync(createTestVorgang({ id: 'v-real-99', title: 'Echter Auftrag' }));
    const state = buildState([real]);
    hydrateVorgangStore(state.vorgaenge);
    resetSyncChangeTrackerFromState(state);

    trackPersistedChanges({
      ...state,
      vorgaenge: [
        {
          ...real,
          baustelle: 'Neue Baustelle',
          sync: { ...real.sync!, version: 2, updatedAt: '2026-07-02T10:00:00.000Z' },
        },
      ],
    });

    const outbox = getSyncOutboxSnapshot().filter((e) => e.entityType === 'vorgang');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.entityId).toBe('v-real-99');
  });

  it('demo vorgaenge werden niemals gepusht', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsertSpy = vi
      .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
      .mockResolvedValue({ rowVersion: 1, payload: {} });

    const adapter = new SupabaseSyncAdapter(null);

    const state = buildState([withSync({ ...MOCK_VORGAENGE[0]! })]);
    const result = await adapter.pushChanges({
      deviceId: 'dev',
      workspaceId: 'ws-1',
      state,
      outbox: [
        {
          id: generateUuid(),
          entityType: 'vorgang',
          entityId: 'v-001',
          operation: 'create',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        },
      ],
    });

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(result.completedOutboxIds).toHaveLength(1);
    expect(result.report.syncedEntities).toEqual([
      { entityType: 'vorgang', entityId: 'v-001', resolution: 'noop' },
    ]);
    expect(result.failedOutbox).toEqual([]);
  });

  it('echte Vorgänge werden weiterhin gepusht', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsertSpy = vi
      .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
      .mockResolvedValue({ rowVersion: 2, payload: {} });

    const adapter = new SupabaseSyncAdapter(null);
    vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue(
      {},
    );

    const real = withSync(createTestVorgang({ id: 'v-real-99', title: 'Echter Auftrag' }));
    const state = buildState([real]);
    const result = await adapter.pushChanges({
      deviceId: 'dev',
      workspaceId: 'ws-1',
      state,
      outbox: [
        {
          id: generateUuid(),
          entityType: 'vorgang',
          entityId: 'v-real-99',
          operation: 'update',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        },
      ],
    });

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0]?.[1]).toBe('vorgang');
    expect(result.completedOutboxIds).toHaveLength(1);
    expect(result.report.syncedEntities[0]?.resolution).toBe('local_wins');
  });

  it('cleanup planner lists active demo IDs without running on login', () => {
    const plan = planMockVorgangCloudCleanup('ws-1', [
      {
        workspace_id: 'ws-1',
        vorgang_id: 'v-001',
        payload: { id: 'v-001', title: 'x' },
        row_version: 2,
        deleted: false,
        deleted_at: null,
        updated_at: '2026-07-01T00:00:00.000Z',
        updated_by: null,
      },
      {
        workspace_id: 'ws-1',
        vorgang_id: 'v-002',
        payload: { id: 'v-002', title: 'y' },
        row_version: 1,
        deleted: true,
        deleted_at: '2026-07-02T00:00:00.000Z',
        updated_at: '2026-07-02T00:00:00.000Z',
        updated_by: null,
      },
      {
        workspace_id: 'ws-1',
        vorgang_id: 'v-real-99',
        payload: { id: 'v-real-99', title: 'real' },
        row_version: 1,
        deleted: false,
        deleted_at: null,
        updated_at: '2026-07-01T00:00:00.000Z',
        updated_by: null,
      },
    ]);

    expect(plan.activeInCloud).toEqual(['v-001']);
    expect(plan.alreadyDeleted).toEqual(['v-002']);
    expect(plan.candidateIds).toEqual(['v-001', 'v-002', 'v-003']);
  });
});
