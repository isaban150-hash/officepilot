import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_VORGAENGE } from './data/mockData';
import { createCompanyProfileFromSetup } from './data/companyProfileDefaults';
import { DEFAULT_SETUP } from './data/mockData';
import {
  clearInMemoryBusinessState,
  createSeedState,
  loadPersistedStateFromKey,
  savePersistedStateToKey,
} from './services/persistenceService';
import {
  getVorgangStoreSnapshot,
  hydrateVorgangStore,
} from './services/vorgangService';
import {
  bootstrapBusinessState,
  isolateBusinessStateOnLogout,
  previewDefinitelyMockCleanup,
  removeDefinitelyMockDataFromActiveScope,
} from './services/storage/storageBootstrapService';
import {
  canAssignLegacyStateToScope,
  legacyGlobalStateExists,
  quarantineLegacyGlobalState,
  tryMigrateLegacyGlobalState,
} from './services/storage/legacyMigrationService';
import {
  isDefinitelyMockVorgang,
  stripDefinitelyMockDataFromState,
} from './services/storage/mockDataDetectionService';
import {
  buildStorageKey,
  getActiveStorageKey,
  LEGACY_GLOBAL_STORAGE_KEY,
  resetStorageScopeForTests,
  setActiveStorageScope,
} from './services/storage/storageScopeService';
import { createMockInboxItemFromUpload, createMockInboxItemFromUploadForTests } from './services/inboxUploadFactory';
import { createSyncClient } from './services/sync/syncClientService';
import type { AppPersistedState } from './types/models';
import { STORAGE_VERSION } from './services/persistenceService';
import { mergeRemoteWorkspacePullIntoState } from './services/workspace/workspaceProvisioningService';
import { createTestVorgang } from './test/fixtures';

function minimalState(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: client,
    syncOutbox: [],
    setup: { ...DEFAULT_SETUP, companyName: 'Test GmbH' },
    companyProfile: createCompanyProfileFromSetup({ ...DEFAULT_SETUP, companyName: 'Test GmbH' }),
    invoiceNumberSequence: { year: 2026, lastIssuedNumber: 0 },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    savedAt: '2026-03-27T12:00:00.000Z',
    ...overrides,
  };
}

describe('DATA-CLEAN-01 storage scope', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStorageScopeForTests();
    clearInMemoryBusinessState();
  });

  it('new account starts empty', () => {
    const result = bootstrapBusinessState({ userId: 'user-new' });
    expect(result.setup).toBeDefined();
    expect(getVorgangStoreSnapshot()).toEqual([]);
    expect(loadPersistedStateFromKey(buildStorageKey(result.scope))?.vorgaenge).toEqual([]);
  });

  it('user A does not see user B data', () => {
    bootstrapBusinessState({ userId: 'user-a' });
    hydrateVorgangStore([createTestVorgang({ id: 'v-user-a', title: 'Auftrag A' })]);
    savePersistedStateToKey({ type: 'user', userId: 'user-a' }, minimalState({
      vorgaenge: [createTestVorgang({ id: 'v-user-a', title: 'Auftrag A' })],
    }));

    bootstrapBusinessState({ userId: 'user-b' });
    expect(getVorgangStoreSnapshot()).toEqual([]);
  });

  it('logout clears in-memory state without deleting persisted user data', () => {
    bootstrapBusinessState({ userId: 'user-a' });
    hydrateVorgangStore([createTestVorgang({ id: 'v-user-a', title: 'Auftrag A' })]);
    savePersistedStateToKey(
      { type: 'user', userId: 'user-a' },
      minimalState({ vorgaenge: [createTestVorgang({ id: 'v-user-a', title: 'Auftrag A' })] }),
    );

    isolateBusinessStateOnLogout();
    expect(getVorgangStoreSnapshot()).toEqual([]);
    expect(getActiveStorageKey()).toBe(buildStorageKey({ type: 'guest' }));

    bootstrapBusinessState({ userId: 'user-a' });
    expect(getVorgangStoreSnapshot().map((v) => v.id)).toEqual(['v-user-a']);
  });

  it('login loads only matching scope', () => {
    savePersistedStateToKey(
      { type: 'user', userId: 'user-a' },
      minimalState({ vorgaenge: [createTestVorgang({ id: 'v-a', title: 'Nur A' })] }),
    );
    savePersistedStateToKey(
      { type: 'user', userId: 'user-b' },
      minimalState({ vorgaenge: [createTestVorgang({ id: 'v-b', title: 'Nur B' })] }),
    );

    bootstrapBusinessState({ userId: 'user-b' });
    expect(getVorgangStoreSnapshot().map((v) => v.id)).toEqual(['v-b']);
  });

  it('does not blindly adopt legacy global state for unrelated user', () => {
    const legacy = minimalState({
      vorgaenge: MOCK_VORGAENGE.map((v) => ({ ...v })),
      workspace: {
        id: 'ws-other',
        name: 'Fremd',
        ownerUserId: 'other-user',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
    });
    localStorage.setItem(LEGACY_GLOBAL_STORAGE_KEY, JSON.stringify(legacy));

    const outcome = tryMigrateLegacyGlobalState({ type: 'user', userId: 'user-new' }, 'user-new');
    expect(outcome.action).toBe('quarantined');
    expect(legacyGlobalStateExists()).toBe(false);
    expect(localStorage.getItem(buildStorageKey({ type: 'user', userId: 'user-new' }))).toBeNull();
  });

  it('migrates legacy state when workspace owner matches', () => {
    const legacy = minimalState({
      vorgaenge: [createTestVorgang({ id: 'v-real', title: 'Echter Auftrag' })],
      workspace: {
        id: 'ws-a',
        name: 'Mein Betrieb',
        ownerUserId: 'user-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      syncClient: {
        ...createSyncClient(),
        serverWorkspaceId: 'ws-a',
      },
    });
    localStorage.setItem(LEGACY_GLOBAL_STORAGE_KEY, JSON.stringify(legacy));

    const outcome = tryMigrateLegacyGlobalState(
      { type: 'workspace', workspaceId: 'ws-a' },
      'user-a',
    );
    expect(outcome.action).toBe('migrated');
    const migrated = loadPersistedStateFromKey(buildStorageKey({ type: 'workspace', workspaceId: 'ws-a' }));
    expect(migrated?.vorgaenge.map((v) => v.id)).toEqual(['v-real']);
  });

  it('quarantines unassignable legacy state', () => {
    localStorage.setItem(LEGACY_GLOBAL_STORAGE_KEY, JSON.stringify(minimalState({
      vorgaenge: MOCK_VORGAENGE.map((v) => ({ ...v })),
    })));

    const key = quarantineLegacyGlobalState();
    expect(key).toContain('officepilot-legacy-state:');
    expect(legacyGlobalStateExists()).toBe(false);
    expect(localStorage.getItem(key!)).not.toBeNull();
  });

  it('detects demo IDs and titles', () => {
    expect(isDefinitelyMockVorgang(MOCK_VORGAENGE[0]!)).toBe(true);
    expect(isDefinitelyMockVorgang(createTestVorgang({ id: 'v-real-99', title: 'Sanierung Müller' }))).toBe(false);
  });

  it('does not delete real data with similar customer names', () => {
    const state = minimalState({
      vorgaenge: [
        createTestVorgang({ id: 'v-real-mueller', title: 'Badumbau Müller', customer: 'Familie Müller' }),
        MOCK_VORGAENGE[0]!,
      ],
    });
    const cleaned = stripDefinitelyMockDataFromState(state);
    expect(cleaned.vorgaenge.map((v) => v.id)).toEqual(['v-real-mueller']);
  });

  it('removes only definite mock data via cleanup service', () => {
    bootstrapBusinessState({ userId: 'user-clean' });
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-real', title: 'Echter Auftrag' }),
      MOCK_VORGAENGE[0]!,
    ]);

    const preview = previewDefinitelyMockCleanup();
    expect(preview.vorgaenge.map((v) => v.id)).toEqual(['v-001']);
    const result = removeDefinitelyMockDataFromActiveScope();
    expect(result.removed.vorgaenge).toHaveLength(1);
    expect(getVorgangStoreSnapshot().map((v) => v.id)).toEqual(['v-real']);
  });

  it('createSeedState stays empty in production mode', () => {
    const seed = createSeedState();
    expect(seed.vorgaenge).toEqual([]);
    expect(seed.inboxItems).toEqual([]);
    expect(seed.documents).toEqual([]);
  });

  it('enrichFromTemplate does not run in production upload path', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'auftrag',
      sourceFileName: 'scan.jpg',
    });
    expect(item.vorgangTitle).toBeUndefined();
    expect(item.recognizedData.Kunde).not.toBe('Familie Müller');
    expect(item.recognizedData.Leistung).not.toBe('Badezimmer-Komplettsanierung');
  });

  it('enrichFromTemplate still works in explicit test helper', () => {
    const item = createMockInboxItemFromUploadForTests({ kind: 'auftrag' });
    expect(item.recognizedData.Kunde).toBe('Familie Müller');
  });

  it('does not push mock vorgaenge into empty remote workspace', () => {
    const state = minimalState({
      vorgaenge: MOCK_VORGAENGE.map((v) => ({ ...v })),
      workspace: {
        id: 'ws-empty',
        name: 'Leer',
        ownerUserId: 'user-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      syncClient: {
        ...createSyncClient(),
        serverWorkspaceId: 'ws-empty',
      },
    });

    const merged = mergeRemoteWorkspacePullIntoState(state, {
      workspace: state.workspace,
      settings: null,
      members: [],
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [],
    });

    expect(merged.state.vorgaenge).toEqual([]);
  });

  it('auto-strips mock data when loading scoped storage', () => {
    setActiveStorageScope({ type: 'user', userId: 'user-strip' });
    savePersistedStateToKey(
      { type: 'user', userId: 'user-strip' },
      minimalState({
        vorgaenge: [
          createTestVorgang({ id: 'v-real', title: 'Echter Auftrag' }),
          MOCK_VORGAENGE[0]!,
        ],
      }),
    );
    bootstrapBusinessState({ userId: 'user-strip' });
    expect(getVorgangStoreSnapshot().map((v) => v.id)).toEqual(['v-real']);
  });

  it('rejects legacy mock-only state for user scope assignment', () => {
    const legacy = minimalState({ vorgaenge: MOCK_VORGAENGE.map((v) => ({ ...v })) });
    expect(canAssignLegacyStateToScope(legacy, { type: 'user', userId: 'user-a' }, 'user-a')).toBe(false);
  });
});
