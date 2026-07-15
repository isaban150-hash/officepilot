import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { AppPersistedState } from '../../types/models';
import {
  SUPABASE_SYNC_ALLOWLIST,
  isSupabaseSyncAllowed,
} from '../sync/cloudSyncAllowlist';
import { createSyncAdapter, isSyncProviderAvailable } from '../sync/syncAdapterFactory';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { LocalSyncAdapter } from '../sync/localSyncAdapter';
import {
  migratePersistedStateV2ToV3,
  migratePersistedStateV3ToV4,
  migratePersistedStateV4ToV5,
  STORAGE_VERSION,
  STORAGE_VERSION_V2,
  STORAGE_VERSION_V4,
} from '../sync/syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncOutboxForTests, getSyncOutboxSnapshot, enqueueSyncOutbox } from '../sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from '../sync/syncChangeTrackerService';
import { generateUuid } from '../sync/syncMetaService';
import {
  buildCompanyProfileCloudPayload,
  buildCompanySetupCloudPayload,
  WorkspaceCloudError,
} from './workspaceCloudService';
import {
  hydrateWorkspaceStore,
  resetWorkspaceStore,
  stripLogoFromCompanyProfile,
} from './workspaceStore';
import {
  mergeRemoteWorkspacePullIntoState,
  provisionWorkspaceForAuthenticatedUser,
} from './workspaceProvisioningService';
import { extractCloudSyncEntity } from './workspaceSyncPayloadService';

function buildCloudTestState(): AppPersistedState {
  const client = createSyncClient();
  const workspaceId = 'ws-test-001';
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, workspaceId, serverWorkspaceId: workspaceId },
    syncOutbox: [],
    workspace: {
      id: workspaceId,
      name: 'Test Workspace',
      ownerUserId: 'user-1',
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 1,
      sync: {
        updatedAt: '2026-07-01T10:00:00.000Z',
        version: 1,
        deleted: false,
        deviceId: client.deviceId,
        workspaceId,
      },
    },
    workspaceMembers: [
      {
        workspaceId,
        userId: 'user-1',
        role: 'owner',
        status: 'active',
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
      },
    ],
    workspaceSettings: {
      workspaceId,
      settings: { theme: 'light' },
      version: 1,
      updatedAt: '2026-07-01T10:00:00.000Z',
    },
    setupSync: {
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 1,
      deleted: false,
      deviceId: client.deviceId,
      workspaceId,
    },
    companyProfileSync: {
      updatedAt: '2026-07-01T10:00:00.000Z',
      version: 1,
      deleted: false,
      deviceId: client.deviceId,
      workspaceId,
    },
    setup: { ...DEFAULT_SETUP, companyName: 'Cloud GmbH', setupComplete: true },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Cloud GmbH' },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    savedAt: '2026-07-01T10:00:00.000Z',
  };
}

describe('CLOUD-DATA-01 allowlist', () => {
  it('erlaubt nur Workspace-Setup-Entitäten', () => {
    expect(isSupabaseSyncAllowed('company_setup')).toBe(true);
    expect(isSupabaseSyncAllowed('company_profile')).toBe(true);
    expect(isSupabaseSyncAllowed('workspace_settings')).toBe(true);
    expect(isSupabaseSyncAllowed('vorgang')).toBe(true);
    expect(isSupabaseSyncAllowed('document')).toBe(false);
    expect(isSupabaseSyncAllowed('inbox_item')).toBe(false);
    expect(SUPABASE_SYNC_ALLOWLIST.size).toBe(6);
  });
});

describe('CLOUD-DATA-01 migration v2 → v3', () => {
  it('ergänzt Workspace-Sync-Metadaten', () => {
    const client = createSyncClient();
    const v2State = {
      version: STORAGE_VERSION_V2,
      syncClient: client,
      syncOutbox: [],
      setup: DEFAULT_SETUP,
      inboxItems: [],
      vorgaenge: [],
      tasks: [],
      savedAt: '2026-07-01T10:00:00.000Z',
    };

    const migrated = migratePersistedStateV4ToV5(
      migratePersistedStateV3ToV4(migratePersistedStateV2ToV3(v2State)),
    );
    expect(migrated.version).toBe(STORAGE_VERSION);
    expect(migrated.setupSync?.version).toBeGreaterThanOrEqual(1);
    expect(migrated.companyProfileSync?.version).toBeGreaterThanOrEqual(1);
  });
});

describe('CLOUD-DATA-01 factory', () => {
  it('nutzt local adapter ohne Supabase-Konfiguration', () => {
    expect(isSyncProviderAvailable('local')).toBe(true);
    expect(createSyncAdapter({ provider: 'local' })).toBeInstanceOf(LocalSyncAdapter);
    expect(createSyncAdapter()).toBeInstanceOf(LocalSyncAdapter);
  });
});

describe('CLOUD-DATA-01 payloads', () => {
  it('entfernt logoDataUrl aus Firmendaten-Cloud-Payload', () => {
    const profile = { ...DEFAULT_COMPANY_PROFILE, logoDataUrl: 'data:image/png;base64,abc' };
    const payload = buildCompanyProfileCloudPayload(profile);
    expect(payload.payload).toBeDefined();
    expect((payload.payload as Record<string, unknown>).logoDataUrl).toBeUndefined();
    expect(stripLogoFromCompanyProfile(profile).logoDataUrl).toBeUndefined();
  });

  it('serialisiert Setup als vollständige Entität', () => {
    const setup = { ...DEFAULT_SETUP, companyName: 'Setup GmbH', setupComplete: true };
    const payload = buildCompanySetupCloudPayload(setup);
    expect(payload.setup_version).toBe(setup.setupVersion);
    expect((payload.payload as typeof setup).companyName).toBe('Setup GmbH');
  });
});

describe('CLOUD-DATA-01 change tracker', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetWorkspaceStore();
  });

  it('trackt Setup- und Firmendaten-Änderungen', () => {
    const state = buildCloudTestState();
    hydrateWorkspaceStore({
      workspace: state.workspace ?? null,
      workspaceMembers: state.workspaceMembers ?? [],
      workspaceSettings: state.workspaceSettings ?? null,
      setupSync: state.setupSync ?? null,
      companyProfileSync: state.companyProfileSync ?? null,
    });
    resetSyncChangeTrackerFromState(state);

    trackPersistedChanges({
      ...state,
      setup: { ...state.setup, companyName: 'Geändert GmbH' },
    });

    const outbox = getSyncOutboxSnapshot();
    expect(outbox.some((entry) => entry.entityType === 'company_setup')).toBe(true);
  });

  it('dedupliziert Outbox-Einträge pro Entity', () => {
    enqueueSyncOutbox({
      entityType: 'company_setup',
      entityId: 'ws-1',
      operation: 'update',
      version: 1,
    });
    enqueueSyncOutbox({
      entityType: 'company_setup',
      entityId: 'ws-1',
      operation: 'update',
      version: 2,
    });
    const outbox = getSyncOutboxSnapshot();
    expect(outbox.filter((entry) => entry.entityType === 'company_setup')).toHaveLength(1);
    expect(outbox[0].version).toBe(2);
  });
});

describe('CLOUD-DATA-01 SupabaseSyncAdapter', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
  });

  it('bestätigt keine ausgeschlossenen Geschäftsdaten', async () => {
    const state = buildCloudTestState();
    const adapter = new SupabaseSyncAdapter(null);
    const outboxId = generateUuid();

    const result = await adapter.pushChanges({
      deviceId: state.syncClient!.deviceId,
      workspaceId: state.syncClient!.serverWorkspaceId!,
      state,
      outbox: [
        {
          id: outboxId,
          entityType: 'document',
          entityId: 'doc-1',
          operation: 'update',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        },
        {
          id: generateUuid(),
          entityType: 'company_setup',
          entityId: state.syncClient!.serverWorkspaceId!,
          operation: 'update',
          version: 1,
          queuedAt: new Date().toISOString(),
          retryCount: 0,
          status: 'pending',
        },
      ],
    });

    expect(result.completedOutboxIds).not.toContain(outboxId);
    expect(result.state.syncOutbox?.find((entry) => entry.id === outboxId)?.status).toBe('pending');
  });

  it('klassifiziert Auth-Fehler korrekt', () => {
    const error = new WorkspaceCloudError('Nicht angemeldet', 'auth', false);
    expect(error.code).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('klassifiziert Netzwerkfehler als retryable', () => {
    const error = new WorkspaceCloudError('Failed to fetch', 'network', true);
    expect(error.retryable).toBe(true);
  });

  it('klassifiziert Versionskonflikte', () => {
    const error = new WorkspaceCloudError('Versionskonflikt company_setup:2', 'version_conflict', false);
    expect(error.code).toBe('version_conflict');
  });
});

describe('CLOUD-DATA-01 merge / conflicts', () => {
  it('überschreibt bei Versionskonflikt nicht still', () => {
    const state = buildCloudTestState();
    const { state: merged, conflicts } = mergeRemoteWorkspacePullIntoState(state, {
      workspace: state.workspace,
      members: state.workspaceMembers ?? [],
      settings: state.workspaceSettings,
      setupPayload: { payload: { ...DEFAULT_SETUP, companyName: 'Remote GmbH' } },
      setupRowVersion: 99,
      setupUpdatedAt: '2026-07-02T10:00:00.000Z',
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
    });

    expect(conflicts).toContain('company_setup');
    expect(merged.setup.companyName).toBe('Cloud GmbH');
  });

  it('übernimmt Remote-Setup wenn lokal leer', () => {
    const client = createSyncClient();
    const workspaceId = 'ws-empty';
    const state: AppPersistedState = {
      ...buildCloudTestState(),
      setup: { ...DEFAULT_SETUP },
      setupSync: {
        updatedAt: '2026-07-01T10:00:00.000Z',
        version: 0,
        deleted: false,
        deviceId: client.deviceId,
        workspaceId,
      },
    };

    const { state: merged, conflicts } = mergeRemoteWorkspacePullIntoState(state, {
      workspace: state.workspace,
      members: state.workspaceMembers ?? [],
      settings: state.workspaceSettings,
      setupPayload: { payload: { ...DEFAULT_SETUP, companyName: 'Remote GmbH', setupComplete: true } },
      setupRowVersion: 1,
      setupUpdatedAt: '2026-07-02T10:00:00.000Z',
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
    });

    expect(conflicts).toHaveLength(0);
    expect(merged.setup.companyName).toBe('Remote GmbH');
  });
});

describe('CLOUD-DATA-01 provisioning', () => {
  it('provisioniert Workspace über RPC-Mock', async () => {
    const { rpcEnsurePersonalWorkspace } = await import('./workspaceCloudService');
    const rpcMock = vi.spyOn(await import('./workspaceCloudService'), 'rpcEnsurePersonalWorkspace').mockResolvedValue({
      success: true,
      workspaceId: 'ws-provisioned',
      workspace: {
        id: 'ws-provisioned',
        name: 'Mein Workspace',
        ownerUserId: 'user-abc',
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
        version: 1,
      },
      member: {
        workspaceId: 'ws-provisioned',
        userId: 'user-abc',
        role: 'owner',
        status: 'active',
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T10:00:00.000Z',
      },
    });

    const result = await provisionWorkspaceForAuthenticatedUser(buildCloudTestState());
    expect(result.success).toBe(true);
    expect(result.workspaceId).toBe('ws-provisioned');
    expect(result.state?.syncClient?.serverWorkspaceId).toBe('ws-provisioned');

    rpcMock.mockRestore();
  });
});

describe('CLOUD-DATA-01 entity extraction', () => {
  it('extrahiert erlaubte Entitäten aus dem State', () => {
    const state = buildCloudTestState();
    const extracted = extractCloudSyncEntity(
      state,
      'company_profile',
      state.syncClient!.serverWorkspaceId!,
    );
    expect(extracted?.entityType).toBe('company_profile');
    expect(extracted?.entity.companyName).toBe('Cloud GmbH');
  });

  it('findet Geschäftsdaten nicht als Cloud-Entität', () => {
    const state = buildCloudTestState();
    expect(
      extractCloudSyncEntity(state, 'vorgang' as never, 'v-1'),
    ).toBeNull();
  });
});
