import type { AppPersistedState, CompanySetup } from '../../types/models';
import { isBetaTestMode, BETA_TEST_SETUP } from '../../config/betaTestMode';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  clearInMemoryBusinessState,
  createSeedState,
  getCachedSetup,
  loadPersistedStateResultFromKey,
  persistAll,
  recordPersistedStateLoadOutcome,
  rememberLoadedContentBaseline,
  savePersistedStateToKey,
  seedSyncChangeTrackerFromCurrentStores,
  setActiveStorageScope,
} from '../persistenceService';
import { runAutomaticSyncWrite } from '../sync/syncOutboxService';
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
  type StorageAccess,
  type StorageScope,
} from './storageScopeService';
import { prepareWorkspaceAccountStore } from './workspaceAccountStorageService';
import {
  appendOutboxOriginLog,
  prepareAccountOutboxOnLoad,
  toOutboxOriginLogEntity,
} from '../sync/syncOutboxOriginService';
import {
  backfillMissingFileRefHashes,
  buildBlobFallbackScopes,
  ensureDocumentBlobsForActiveScope,
  getDocumentFileRefStoreSnapshot,
} from '../documentFileStoreService';
import {
  cancelIntakeAnalysisRecovery,
  scheduleIntakeAnalysisRecovery,
} from '../intakeAnalysisCommitService';

export interface BusinessBootstrapInput {
  userId?: string;
  workspaceId?: string;
  /**
   * DOKUMENTE-01 N1 — Sicht des angemeldeten Kontos im Betrieb (vom Server). Mit
   * `userId` und `workspaceId` entsteht der Kontobestand; ohne sie der bisherige
   * Betriebsschlüssel (Altbestand, Tests).
   */
  access?: StorageAccess;
  /**
   * DOKUMENTE-01 N1 — Inhaber des Betriebs laut Server. Nur sein Nutzerbereich
   * darf Geschäftsdaten in den Kontobestand mitbringen.
   */
  ownerUserId?: string;
}

export interface BusinessBootstrapResult {
  setup: CompanySetup;
  scope: StorageScope;
  legacyMigration: 'none' | 'migrated' | 'quarantined';
  strippedMockData: boolean;
  /**
   * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — für den Bereich lagen Daten vor,
   * die nicht gelesen werden konnten.
   *
   * Additiv und optional: Bestehende Aufrufer bleiben unverändert. Wer den Fall
   * behandeln will, prüft dieses Feld — der Grund steht in
   * `getPersistedStateLoadFailure()`. Es wurde nichts angewendet und nichts
   * gespeichert; der Rohwert ist unversehrt.
   */
  loadFailed?: boolean;
}

function resolveScope(input: BusinessBootstrapInput): StorageScope {
  if (input.workspaceId) {
    return input.userId && input.access
      ? {
          type: 'workspace',
          workspaceId: input.workspaceId,
          account: { userId: input.userId, access: input.access },
        }
      : { type: 'workspace', workspaceId: input.workspaceId, account: null };
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
    /*
     * DOKUMENTE-01 R2 — Wartung nach dem Laden, keine Nutzeraktion: Was sie ändert, reiht der Verfolger über den
     * gesperrten Weg ein. Eine endgültige Abweisung (etwa aus einem übernommenen Altbestand) löst sie nie ab.
     */
    .then(() => runAutomaticSyncWrite(() => persistAll()));
}

function loadOrSeedScopedState(scope: StorageScope, userId?: string): BusinessBootstrapResult {
  setActiveStorageScope(scope);

  const legacyResult = tryMigrateLegacyGlobalState(scope, userId);
  let legacyMigration: BusinessBootstrapResult['legacyMigration'] = 'none';
  if (legacyResult.action === 'migrated') legacyMigration = 'migrated';
  if (legacyResult.action === 'quarantined') legacyMigration = 'quarantined';

  const storageKey = buildStorageKey(scope);
  const result = loadPersistedStateResultFromKey(storageKey);
  recordPersistedStateLoadOutcome(result);
  if (result.status === 'loaded') {
    const stored = result.state;
    const stripped = stripDefinitelyMockDataFromState(stored);
    const strippedMockData = JSON.stringify(stripped) !== JSON.stringify(stored);
    /*
     * DOKUMENTE-01 R1/R2 — ein Kontobestand: Bestätigungen abgebrochener Läufe dieses Kontos anwenden (nie doppelt
     * senden) und offene Aufträge ohne nachweisbares Ursprungskonto zurückhalten (nie automatisch senden).
     */
    const now = new Date().toISOString();
    const konto =
      scope.type === 'workspace' && scope.account
        ? prepareAccountOutboxOnLoad(storageKey, stripped, now)
        : { state: stripped, changed: false, held: [], completedIds: [] };
    applyStateToStores(konto.state);
    // 01A-FIX1 — Öffnen ist keine Änderung: Grundlinie ist der eingelesene Zustand.
    rememberLoadedContentBaseline();
    if (scope.type === 'workspace' && scope.account) {
      /*
       * DOKUMENTE-01 R2 — auch für den Änderungsverfolger: Seine Grundlinie ist der aufbereitete Speicherstand, nicht
       * der rohe gespeicherte. Sonst meldete das erste Speichern nach dem Laden bloße Formunterschiede (etwa eines
       * übernommenen Altbestands) als neue Aufträge dieses Kontos — über den bewussten Weg, der eine endgültige
       * Abweisung ablöst und die Sperre unbekannter Herkunft umginge.
       */
      seedSyncChangeTrackerFromCurrentStores();
    }
    if (strippedMockData || konto.changed) {
      // Erst das gespeicherte Ergebnis räumt das Journal auf (beim Speichern) und kommt in die Prüfspur.
      const saved = savePersistedStateToKey(scope, konto.state);
      if (saved.success && konto.changed) {
        appendOutboxOriginLog(storageKey, {
          at: now,
          action: 'held',
          source: 'load',
          entries: konto.held.map(toOutboxOriginLogEntity),
        });
        appendOutboxOriginLog(storageKey, {
          at: now,
          action: 'confirmed_on_load',
          entries: (konto.state.syncOutbox ?? [])
            .filter((entry) => konto.completedIds.includes(entry.id))
            .map(toOutboxOriginLogEntity),
        });
      }
    }
    scheduleDocumentFileMaintenance(scope, userId);
    // EINGANG-01D-1 — verlorene Intake-Analysen aus dem lokalen Volltext nachholen.
    scheduleIntakeAnalysisRecovery();
    return {
      setup: getCachedSetup(),
      scope,
      legacyMigration,
      strippedMockData,
    };
  }

  /*
   * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — für diesen Bereich liegen Daten
   * vor, die nicht gelesen werden konnten.
   *
   * Bis hierher war das vom leeren Speicher nicht unterscheidbar: Der Ladepfad
   * lieferte beides Mal `null`, und der Seed unten wurde nicht nur angewendet,
   * sondern **über den vorhandenen Schlüssel geschrieben**. Ein Parse- oder
   * Migrationsfehler löschte damit den Bestand des Nutzers.
   *
   * Jetzt wird weder angewendet noch gespeichert. Der Rohwert bleibt
   * zeichengenau erhalten, andere Bereiche bleiben unberührt, und der Grund ist
   * über `getPersistedStateLoadFailure()` abrufbar. Es wird nichts repariert
   * und nichts bereinigt — die Entscheidung darüber gehört nicht hierher.
   */
  if (result.status === 'failed') {
    return {
      setup: getCachedSetup(),
      scope,
      legacyMigration,
      strippedMockData: false,
      loadFailed: true,
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
  // Eine laufende Recovery gehört zum vorherigen Bestand.
  cancelIntakeAnalysisRecovery();
  clearInMemoryBusinessState();

  const scope = resolveScope(input);
  const account = scope.type === 'workspace' && scope.account ? scope.account : undefined;

  if (input.userId && input.workspaceId) {
    /*
     * DOKUMENTE-01 N1 — zuerst den Kontobestand vorbereiten (Altbestand oder
     * Mitgliedsbestand bei Aufstieg übernehmen), danach den Nutzerbereich
     * dieses Kontos hineinführen. Umgekehrt fände die Übernahme einen
     * Zielbestand vor und ließe den Altbestand liegen.
     */
    if (account) prepareWorkspaceAccountStore(input.workspaceId, account);
    migrateUserScopeToWorkspaceScope(input.userId, input.workspaceId, account, input.ownerUserId);
  }

  if (isBetaTestMode() && !input.userId) {
    setActiveStorageScope(scope);
    const betaResult = loadPersistedStateResultFromKey(buildStorageKey(scope));
    recordPersistedStateLoadOutcome(betaResult);
    if (betaResult.status === 'loaded' && betaResult.state.setup.setupComplete) {
      const stored = betaResult.state;
      const stripped = stripDefinitelyMockDataFromState(stored);
      applyStateToStores(stripped);
      rememberLoadedContentBaseline();
      scheduleIntakeAnalysisRecovery();
      return {
        setup: getCachedSetup(),
        scope,
        legacyMigration: 'none',
        strippedMockData: JSON.stringify(stripped) !== JSON.stringify(stored),
      };
    }
    /*
     * Auch im Testmodus gilt: Ein Ladefehler ist kein Erststart.
     * `bootstrapBetaTestState` legt einen frischen Bestand an und speichert ihn.
     */
    if (betaResult.status === 'failed') {
      return {
        setup: getCachedSetup(),
        scope,
        legacyMigration: 'none',
        strippedMockData: false,
        loadFailed: true,
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

/**
 * DOKUMENTE-01 N1 — `userId` ist das angemeldete Konto (nicht der Betriebsinhaber),
 * `access` seine Sicht laut Server. Die Übernahme des Nutzerbereichs geschieht in
 * `bootstrapBusinessState`, in der richtigen Reihenfolge.
 */
export function switchToWorkspaceScope(
  userId: string,
  workspaceId: string,
  access?: StorageAccess,
  ownerUserId?: string,
): BusinessBootstrapResult {
  return bootstrapBusinessState({ userId, workspaceId, access, ownerUserId });
}

export function isolateBusinessStateOnLogout(): void {
  cancelIntakeAnalysisRecovery();
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
