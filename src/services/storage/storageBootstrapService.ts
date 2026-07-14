import type { AppPersistedState, CompanySetup } from '../../types/models';
import { isBetaTestMode, BETA_TEST_SETUP } from '../../config/betaTestMode';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  clearInMemoryBusinessState,
  createSeedState,
  getCachedSetup,
  loadPersistedStateFromKey,
  persistAll,
  savePersistedStateToKey,
  setActiveStorageScope,
} from '../persistenceService';
import {
  inventoryDefinitelyMockData,
  stripDefinitelyMockDataFromState,
} from './mockDataDetectionService';
import {
  migrateUserScopeToWorkspaceScope,
  tryMigrateLegacyGlobalState,
} from './legacyMigrationService';
import {
  buildStorageKey,
  getActiveStorageScope,
  type StorageScope,
} from './storageScopeService';
import {
  backfillMissingFileRefHashes,
  buildBlobFallbackScopes,
  ensureDocumentBlobsForActiveScope,
  getDocumentFileRefStoreSnapshot,
} from '../documentFileStoreService';

export interface BusinessBootstrapInput {
  userId?: string;
  workspaceId?: string;
}

export interface BusinessBootstrapResult {
  setup: CompanySetup;
  scope: StorageScope;
  legacyMigration: 'none' | 'migrated' | 'quarantined';
  strippedMockData: boolean;
}

function resolveScope(input: BusinessBootstrapInput): StorageScope {
  if (input.workspaceId) {
    return { type: 'workspace', workspaceId: input.workspaceId };
  }
  if (input.userId) {
    return { type: 'user', userId: input.userId };
  }
  return { type: 'guest' };
}

function bootstrapBetaTestState(): CompanySetup {
  const seed = createSeedState({ ...BETA_TEST_SETUP });
  const betaSeed: AppPersistedState = {
    ...seed,
    setup: { ...BETA_TEST_SETUP },
    companyProfile: seed.companyProfile!,
    invoiceNumberSequence: seed.invoiceNumberSequence ?? {
      year: new Date().getFullYear(),
      lastIssuedNumber: 0,
    },
  };
  applyStateToStores(betaSeed);
  savePersistedStateToKey(getActiveStorageScope(), betaSeed);
  return getCachedSetup();
}

function scheduleDocumentFileMaintenance(scope: StorageScope, userId?: string): void {
  const fileRefIds = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
  const sourceScopes = buildBlobFallbackScopes(scope, userId);
  void ensureDocumentBlobsForActiveScope(fileRefIds, sourceScopes)
    .then(() => backfillMissingFileRefHashes())
    .then(() => persistAll());
}

function loadOrSeedScopedState(scope: StorageScope, userId?: string): BusinessBootstrapResult {
  setActiveStorageScope(scope);

  const legacyResult = tryMigrateLegacyGlobalState(scope, userId);
  let legacyMigration: BusinessBootstrapResult['legacyMigration'] = 'none';
  if (legacyResult.action === 'migrated') legacyMigration = 'migrated';
  if (legacyResult.action === 'quarantined') legacyMigration = 'quarantined';

  const stored = loadPersistedStateFromKey(buildStorageKey(scope));
  if (stored) {
    const stripped = stripDefinitelyMockDataFromState(stored);
    const strippedMockData = JSON.stringify(stripped) !== JSON.stringify(stored);
    applyStateToStores(stripped);
    if (strippedMockData) {
      savePersistedStateToKey(scope, stripped);
    }
    scheduleDocumentFileMaintenance(scope, userId);
    return {
      setup: getCachedSetup(),
      scope,
      legacyMigration,
      strippedMockData,
    };
  }

  const seed = createSeedState();
  applyStateToStores(seed);
  savePersistedStateToKey(scope, seed);
  return {
    setup: getCachedSetup(),
    scope,
    legacyMigration,
    strippedMockData: false,
  };
}

export function bootstrapBusinessState(input: BusinessBootstrapInput = {}): BusinessBootstrapResult {
  clearInMemoryBusinessState();

  if (input.userId && input.workspaceId) {
    migrateUserScopeToWorkspaceScope(input.userId, input.workspaceId);
  }

  const scope = resolveScope(input);

  if (isBetaTestMode() && !input.userId) {
    setActiveStorageScope(scope);
    const stored = loadPersistedStateFromKey(buildStorageKey(scope));
    if (stored && stored.setup.setupComplete) {
      const stripped = stripDefinitelyMockDataFromState(stored);
      applyStateToStores(stripped);
      return {
        setup: getCachedSetup(),
        scope,
        legacyMigration: 'none',
        strippedMockData: JSON.stringify(stripped) !== JSON.stringify(stored),
      };
    }
    return {
      setup: bootstrapBetaTestState(),
      scope,
      legacyMigration: 'none',
      strippedMockData: false,
    };
  }

  return loadOrSeedScopedState(scope, input.userId);
}

export function switchToWorkspaceScope(
  userId: string,
  workspaceId: string,
): BusinessBootstrapResult {
  migrateUserScopeToWorkspaceScope(userId, workspaceId);
  return bootstrapBusinessState({ userId, workspaceId });
}

export function isolateBusinessStateOnLogout(): void {
  clearInMemoryBusinessState();
  setActiveStorageScope({ type: 'guest' });
  const seed = createSeedState();
  applyStateToStores(seed);
}

export function previewDefinitelyMockCleanup(): ReturnType<typeof inventoryDefinitelyMockData> {
  return inventoryDefinitelyMockData(buildPersistedStateSnapshot());
}

export function removeDefinitelyMockDataFromActiveScope(): {
  removed: ReturnType<typeof inventoryDefinitelyMockData>;
  success: boolean;
} {
  const current = buildPersistedStateSnapshot();
  const removed = inventoryDefinitelyMockData(current);
  if (
    removed.vorgaenge.length === 0 &&
    removed.inboxItems.length === 0 &&
    removed.taskIds.length === 0
  ) {
    return { removed, success: true };
  }

  const cleaned = stripDefinitelyMockDataFromState(current);
  applyStateToStores(cleaned);
  const success = persistAll().success;
  return { removed, success };
}
