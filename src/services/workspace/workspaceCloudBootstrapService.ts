import { isSupabaseConfigured } from '../../lib/supabase';
import {
  applyPersistedStateFromSync,
  buildPersistedStateSnapshot,
} from '../persistenceService';
import { switchToWorkspaceScope } from '../storage/storageBootstrapService';
import { stripDefinitelyMockDataFromState } from '../storage/mockDataDetectionService';
import { getSyncCoordinator } from '../sync/syncCoordinator';
import { getSyncClient } from '../sync/syncClientService';
import { createSyncAdapter } from '../sync/syncAdapterFactory';
import { applySyncPullCandidateSafely } from '../sync/syncPullPersistService';
import { runQueuedSyncOperation } from '../sync/syncOperationQueue';
import {
  applyWorkspaceStateToStores,
  mergeRemoteWorkspacePullIntoState,
  provisionWorkspaceForAuthenticatedUser,
} from './workspaceProvisioningService';
import { rpcPullWorkspaceSyncState, WorkspaceCloudError } from './workspaceCloudService';
import {
  buildCloudCompanySnapshot,
  detectCompanyConflict,
  isRealLocalCompany,
  readLocalCompanyCandidate,
  type CompanyConflictInfo,
} from './workspaceCompanyConflictService';

let bootstrapPromise: Promise<WorkspaceCloudBootstrapResult> | null = null;
let bootstrapCompleted = false;

/**
 * BUSINESS-CONTEXT-FLASH-01C — an welchen Workspace welcher Nutzer zuletzt
 * **erfolgreich** freigegeben wurde.
 *
 * Der Zustand liegt hier und nicht im Gate, weil seine Lebensdauer exakt die des
 * Once-Guards oben ist: Beide gelten, solange dieselbe Seite läuft, und beide
 * enden mit demselben Wiederholversuch. Ein `useRef` im Gate wäre nach einem
 * Remount leer — genau dann trat der Fehler auf.
 *
 * Der zweite Grund ist die Importrichtung: `src/test/resetStores.ts` räumt
 * ausschliesslich Dienste auf und darf keine React-Komponente importieren.
 * Hier greift die vorhandene Reset-Kette ohne jede neue Verdrahtung.
 */
let lastSuccessfulBootstrap: { userId: string; workspaceId: string } | null = null;

export function getLastSuccessfulWorkspaceBootstrap(): {
  userId: string;
  workspaceId: string;
} | null {
  return lastSuccessfulBootstrap ? { ...lastSuccessfulBootstrap } : null;
}

export function setLastSuccessfulWorkspaceBootstrap(
  value: { userId: string; workspaceId: string } | null,
): void {
  lastSuccessfulBootstrap = value ? { ...value } : null;
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — produktiver Name für den Wiederholversuch
 * aus der Wiederherstellungsansicht: der nächste Aufruf arbeitet wirklich neu.
 *
 * BUSINESS-CONTEXT-FLASH-01C — dazu gehört die Nutzer-Workspace-Bindung: Wer den
 * Bootstrap neu laufen lässt, hat auch keine gültige Freigabe mehr.
 */
export function prepareWorkspaceCloudBootstrapRetry(): void {
  bootstrapPromise = null;
  bootstrapCompleted = false;
  lastSuccessfulBootstrap = null;
}

/** Test-Alias auf denselben Zustand. */
export function resetWorkspaceCloudBootstrapForTests(): void {
  prepareWorkspaceCloudBootstrapRetry();
}

export function isWorkspaceCloudBootstrapCompleted(): boolean {
  return bootstrapCompleted;
}

/**
 * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2 — the gate must be able to tell a real
 * failure from a fresh workspace. A silent `void` let a network error look like
 * "new customer" and pushed the user into an empty setup wizard.
 */
export type WorkspaceCloudBootstrapStatus =
  | 'ready'
  /**
   * BUSINESS-CONTEXT-FLASH-01B — der Once-Guard hat abgekürzt: In **diesem**
   * Lauf wurde nichts hergestellt, weil es früher bereits geschah.
   *
   * `ready` war dafür mehrdeutig und wurde vom Gate als „dieser Lauf hat den
   * Workspace hergestellt" gelesen. Fachlich sind das zwei verschiedene Dinge;
   * genau daran entstand die Sperrfläche mitten im Betrieb.
   */
  | 'already_bootstrapped'
  | 'new_workspace'
  | 'failed'
  | 'company_conflict';

export type WorkspaceCloudBootstrapReason =
  | 'network'
  | 'auth'
  | 'rls'
  | 'provision'
  | 'pull'
  | 'persist'
  | 'unknown';

export interface WorkspaceCloudBootstrapResult {
  status: WorkspaceCloudBootstrapStatus;
  reason?: WorkspaceCloudBootstrapReason;
  /** True only when the server confirmed it created the workspace just now. */
  createdWorkspace?: boolean;
  /** Nur bei status 'company_conflict': Anzeigedaten für die Entscheidung. */
  conflict?: CompanyConflictInfo;
  /**
   * True, wenn lokal ein echter Workspace-Firmenbestand existiert. Bei einem
   * Fehler darf dann nicht ersatzweise ein anderer Scope freigegeben werden.
   */
  localWorkspaceCandidate?: boolean;
}

export async function bootstrapWorkspaceCloudSyncIfNeeded(): Promise<WorkspaceCloudBootstrapResult> {
  if (!isSupabaseConfigured()) return { status: 'ready' };
  if (bootstrapCompleted) return { status: 'already_bootstrapped' };
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async (): Promise<WorkspaceCloudBootstrapResult> => {
    const client = getSyncClient();
    if (client.syncPolicy === 'disabled') return { status: 'ready' };

    let createdWorkspace = false;
    let state = buildPersistedStateSnapshot();

    /**
     * OFFICEPILOT-…-02B-K3 — der lokale Workspace-Kandidat wird bereits vor dem
     * Provisioning bestimmt. So kann auch ein früher Fehler melden, dass ein
     * echter lokaler Bestand existiert und die App gesperrt bleiben muss.
     */
    const knownWorkspaceId = state.syncClient?.serverWorkspaceId ?? state.workspace?.id;
    let hasLocalWorkspaceCompany = knownWorkspaceId
      ? isRealLocalCompany(readLocalCompanyCandidate(knownWorkspaceId))
      : false;

    if (!client.cloudProvisionedAt || !state.workspace) {
      const provision = await provisionWorkspaceForAuthenticatedUser(state);
      if (!provision.success || !provision.state) {
        // Provisioning failed — never fall through to a local default.
        const reason: WorkspaceCloudBootstrapReason =
          provision.errorCode === 'network'
            ? 'network'
            : provision.errorCode === 'auth'
              ? 'auth'
              : provision.errorCode === 'rls'
                ? 'rls'
                : 'provision';
        return { status: 'failed', reason, localWorkspaceCandidate: hasLocalWorkspaceCompany };
      }
      createdWorkspace = provision.created === true;
      state = provision.state;
      applyPersistedStateFromSync(state);
      applyWorkspaceStateToStores(state);
    }

    /**
     * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02B — Reihenfolge ist entscheidend:
     * 1. Workspace bestimmen, 2. Cloud-Stand NUR LESEN, 3. lokalen Kandidaten
     * rein lesend bestimmen, 4. bei echter Firmenabweichung sofort anhalten —
     * ohne Hydrieren, ohne Persistieren, ohne Scope-Wechsel, ohne Push.
     * Erst ohne Konflikt: Scope wechseln, dann anwenden, dann synchronisieren.
     */
    const workspaceId = state.syncClient?.serverWorkspaceId ?? state.workspace?.id;
    const ownerUserId = state.workspace?.ownerUserId;
    if (!workspaceId) {
      return { status: 'failed', reason: 'provision' };
    }

    const localCandidate = readLocalCompanyCandidate(workspaceId);
    hasLocalWorkspaceCompany = hasLocalWorkspaceCompany || isRealLocalCompany(localCandidate);

    let pull;
    try {
      pull = await rpcPullWorkspaceSyncState(workspaceId);
    } catch (error) {
      /**
       * OFFICEPILOT-…-02B-K2 — existiert lokal ein echter Workspace-Bestand,
       * darf ein Pull-Fehler nicht dazu führen, dass ein anderer Scope als
       * normale Firma freigegeben wird. Dann bleibt die App gesperrt.
       */
      const reason: WorkspaceCloudBootstrapReason =
        error instanceof WorkspaceCloudError && error.code === 'network' ? 'network' : 'pull';
      return {
        status: 'failed',
        reason,
        localWorkspaceCandidate: hasLocalWorkspaceCompany,
      };
    }

    const conflict = detectCompanyConflict(
      localCandidate,
      buildCloudCompanySnapshot(pull),
      workspaceId,
    );
    if (conflict) {
      // Nichts anwenden, nichts speichern, nichts senden.
      return { status: 'company_conflict', conflict };
    }

    /**
     * OFFICEPILOT-…-02B-K1 — fail-closed: ohne eindeutigen Eigentümer wird der
     * Scope nicht gewechselt, also läuft auch kein Push. Lieber blockieren als
     * mit der falschen Outbox synchronisieren.
     */
    if (!ownerUserId) {
      return {
        status: 'failed',
        reason: 'provision',
        localWorkspaceCandidate: hasLocalWorkspaceCompany,
      };
    }
    // Ab hier ohne Konflikt: zuerst der richtige Scope, dann der Cloud-Kandidat.
    switchToWorkspaceScope(ownerUserId, workspaceId);
    state = buildPersistedStateSnapshot();
    applyPersistedStateFromSync(state);
    applyWorkspaceStateToStores(state);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pull);
    applyPersistedStateFromSync(merged.state);
    applyWorkspaceStateToStores(merged.state);

    // Erst jetzt synchronisieren — mit der Outbox des aktiven Workspace-Scopes.
    // 01P4C: Sync und anschließende Persistenz sind ein Queue-Lauf. Der
    // Callback ruft niemals runSyncFromUi; alle bestehenden Entscheidungen
    // bleiben unverändert und werden nur durchgereicht.
    const queuedSync = await runQueuedSyncOperation(
      async (): Promise<WorkspaceCloudBootstrapResult | null> => {
        const syncResult = await (async () => {
          const coordinator = getSyncCoordinator();
          coordinator.setAdapter(createSyncAdapter({ provider: 'supabase' }));
          return coordinator.runSync(buildPersistedStateSnapshot());
        })();

        if (syncResult.skipPersist) {
          return { status: 'failed', reason: 'pull' };
        }

        const finalState = stripDefinitelyMockDataFromState(syncResult.state);
        const applied = applySyncPullCandidateSafely({
          state: finalState,
          report: syncResult.report,
          pendingInvoiceIntentClears: syncResult.pendingInvoiceIntentClears,
          pendingAmendmentIntentClears: syncResult.pendingAmendmentIntentClears,
        });
        if (!applied.persisted) {
          return { status: 'failed', reason: 'persist' };
        }
        applyWorkspaceStateToStores(finalState);
        return null;
      },
    );
    if (queuedSync) {
      return queuedSync;
    }

    bootstrapCompleted = true;
    return { status: createdWorkspace ? 'new_workspace' : 'ready', createdWorkspace };
  })();

  try {
    return await bootstrapPromise;
  } catch {
    return { status: 'failed', reason: 'unknown' };
  } finally {
    // Immer freigeben, damit ein Retry wirklich neu arbeitet.
    bootstrapPromise = null;
  }
}
