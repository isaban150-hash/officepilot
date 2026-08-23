import type { AppPersistedState } from '../../types/models';
import type { SyncClientConfig } from '../../types/sync';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { persistAll } from '../persistenceService';
import { ensureSyncClientFromState, hydrateSyncClient } from '../sync/syncClientService';
import {
  completeIdenticalCompanyCloudOutboxEntry,
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
} from '../sync/syncOutboxService';
import { filterSyncActive } from '../sync/syncMetaService';
import {
  buildCompanyProfileCloudPayload,
  buildCompanySetupCloudPayload,
  parseCompanyProfileFromCloud,
  parseCompanySetupFromCloud,
  rpcEnsurePersonalWorkspace,
  rpcPullWorkspaceSyncState,
  WorkspaceCloudError,
} from './workspaceCloudService';
import { mergeVorgaengeFromPull } from '../vorgang/vorgangCloudService';
import { isDefinitelyMockVorgang } from '../storage/mockDataDetectionService';
import {
  applyRemoteCompanyProfileSyncMeta,
  applyRemoteSetupSyncMeta,
  bumpCompanyProfileSyncMeta,
  bumpSetupSyncMeta,
  createDefaultWorkspaceSettings,
  createWorkspaceFromProvisioned,
  hydrateWorkspaceStore,
  isDefaultCompanyProfile,
  isDefaultSetup,
  setWorkspaceMembers,
} from './workspaceStore';

export interface WorkspaceProvisioningResult {
  success: boolean;
  state?: AppPersistedState;
  workspaceId?: string;
  created?: boolean;
  error?: string;
  errorCode?: 'auth' | 'rls' | 'network' | 'unknown';
}

export interface WorkspaceInitialMigrationResult {
  state: AppPersistedState;
  /** True when the remote pull failed — the caller must not push local data. */
  pullFailed?: boolean;
  conflicts: string[];
  uploaded: string[];
  downloaded: string[];
}

export async function provisionWorkspaceForAuthenticatedUser(
  state: AppPersistedState,
  workspaceName?: string,
): Promise<WorkspaceProvisioningResult> {
  const result = await rpcEnsurePersonalWorkspace(workspaceName ?? state.setup.companyName);
  if (!result.success || !result.workspace || !result.member) {
    return {
      success: false,
      error: result.error,
      errorCode: result.errorCode,
    };
  }

  const workspace = createWorkspaceFromProvisioned({
    id: result.workspace.id,
    name: result.workspace.name,
    ownerUserId: result.workspace.ownerUserId,
    createdAt: result.workspace.createdAt,
    updatedAt: result.workspace.updatedAt,
    version: result.workspace.version,
  });
  setWorkspaceMembers([result.member]);
  if (!state.workspaceSettings) {
    createDefaultWorkspaceSettings(workspace.id);
  }

  const client = ensureSyncClientFromState(state.syncClient);
  const nextClient: SyncClientConfig = {
    ...client,
    serverWorkspaceId: workspace.id,
    cloudProvisionedAt: new Date().toISOString(),
  };

  if (!state.setup.setupComplete) {
    nextClient.workspaceId = workspace.id;
  }

  hydrateSyncClient(nextClient);

  const nextState: AppPersistedState = {
    ...state,
    syncClient: nextClient,
    workspace,
    workspaceMembers: [result.member],
    workspaceSettings: state.workspaceSettings ?? createDefaultWorkspaceSettings(workspace.id),
    setupSync: state.setupSync ?? bumpSetupSyncMeta(),
    companyProfileSync: state.companyProfileSync ?? bumpCompanyProfileSyncMeta(),
    savedAt: new Date().toISOString(),
  };

  return {
    success: true,
    state: nextState,
    workspaceId: workspace.id,
    // Nur der Server weiß, ob der Workspace jetzt entstand oder schon existierte.
    created: result.created === true,
  };
}

export async function runInitialWorkspaceCloudMigration(
  state: AppPersistedState,
): Promise<WorkspaceInitialMigrationResult> {
  const workspaceId = state.syncClient?.serverWorkspaceId ?? state.workspace?.id;
  const conflicts: string[] = [];
  const uploaded: string[] = [];
  const downloaded: string[] = [];

  if (!workspaceId) {
    return { state, conflicts, uploaded, downloaded };
  }

  let remote;
  try {
    remote = await rpcPullWorkspaceSyncState(workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceCloudError && error.code === 'network') {
      // Ungeprüft weiterlaufen hieße: lokalen Default über Cloud-Daten pushen.
      return { state, conflicts, uploaded, downloaded, pullFailed: true };
    }
    throw error;
  }

  const merged = mergeRemoteWorkspacePullIntoState(state, remote);
  return {
    state: merged.state,
    conflicts: [...conflicts, ...merged.conflicts],
    uploaded,
    downloaded,
  };
}

export function applyWorkspaceStateToStores(state: AppPersistedState): void {
  hydrateWorkspaceStore({
    workspace: state.workspace ?? null,
    workspaceMembers: state.workspaceMembers ?? [],
    workspaceSettings: state.workspaceSettings ?? null,
    setupSync: state.setupSync ?? null,
    companyProfileSync: state.companyProfileSync ?? null,
  });
  if (state.companyProfile) {
    hydrateCompanyProfileStore(state.companyProfile);
  }
  if (state.setup) {
    persistAll(state.setup);
  }
}

/**
 * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01 — stabiler, feldweiser
 * Vergleich über genau die Builder, mit denen auch gepusht wird. Damit gelten
 * dieselben Regeln wie im Cloud-Vertrag — insbesondere entfernt
 * `buildCompanyProfileCloudPayload` das Logo auf beiden Seiten, sodass ein rein
 * lokales Logo weder eine Scheinabweichung noch eine Scheingleichheit erzeugt.
 * Die Schlüssel werden sortiert, weil lokal aufgebaute und aus der Cloud
 * geparste Objekte dieselben Felder in anderer Reihenfolge tragen können.
 */
function canonicalCloudPayloadKey(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = record[key];
        return sorted;
      }, {});
  });
}

export function mergeRemoteWorkspacePullIntoState(
  state: AppPersistedState,
  pull: Awaited<ReturnType<typeof rpcPullWorkspaceSyncState>>,
): { state: AppPersistedState; conflicts: string[] } {
  const conflicts: string[] = [];
  /** 01C — Firmenentitäten, deren Versionsdrift ohne Datenkonflikt geschlossen wird. */
  const identicalStateResolved: Array<'company_setup' | 'company_profile'> = [];
  const workspaceId = state.syncClient?.serverWorkspaceId ?? state.workspace?.id ?? '';
  let next: AppPersistedState = { ...state };

  if (pull.workspace) {
    const localVersion = state.workspace?.sync?.version ?? state.workspace?.version ?? 0;
    const remoteVersion = pull.workspace.version;
    if (localVersion > 0 && remoteVersion > 0 && localVersion !== remoteVersion) {
      conflicts.push('workspace');
    } else {
      next.workspace = pull.workspace;
    }
  }

  if (pull.settings) {
    const localVersion = state.workspaceSettings?.version ?? 0;
    if (localVersion > 0 && pull.settings.version > 0 && localVersion !== pull.settings.version) {
      conflicts.push('workspace_settings');
    } else if (pull.settings.version >= localVersion) {
      next.workspaceSettings = pull.settings;
    }
  }

  /**
   * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02D — eine Remote-Zeile ohne echte
   * Firmenidentität (leerer Name) darf einen echten lokalen Betrieb niemals
   * ersetzen. Sie wird dann wie eine fehlende Zeile behandelt: nichts
   * übernehmen, keine Feldmischung, lokalen Stand über den normalen Outbox-Weg
   * nachmelden. Die bekannte Serverversion wird in die Sync-Meta übernommen,
   * damit der reguläre Push die erwartete Version sendet (nie 0).
   */
  const remoteSetupRaw = parseCompanySetupFromCloud(pull.setupPayload);
  const remoteSetupHasIdentity = Boolean(remoteSetupRaw?.companyName?.trim());
  const localSetupIsReal = !isDefaultSetup(state.setup);
  const emptyRemoteSetupAgainstRealLocal =
    Boolean(remoteSetupRaw) && !remoteSetupHasIdentity && localSetupIsReal;
  const remoteSetup = emptyRemoteSetupAgainstRealLocal ? null : remoteSetupRaw;

  if (emptyRemoteSetupAgainstRealLocal) {
    next.setupSync = {
      version: pull.setupRowVersion,
      updatedAt: pull.setupUpdatedAt ?? state.setupSync?.updatedAt ?? new Date().toISOString(),
      deleted: false,
      deviceId: state.syncClient!.deviceId,
      workspaceId,
    };
    applyRemoteSetupSyncMeta(
      pull.setupRowVersion,
      pull.setupUpdatedAt ?? new Date().toISOString(),
    );
  }

  if (remoteSetup) {
    const localVersion = state.setupSync?.version ?? 0;
    /**
     * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B2 — auf einer neuen Adresse legt das
     * Provisioning lokale Sync-Meta an, obwohl noch keine Firmendaten existieren.
     * Ein Default-Setup darf deshalb nie als Konflikt gegen die Cloud gelten,
     * sonst bleibt der Bestandskunde ohne seine Firmendaten.
     */
    const localSetupIsDefault = isDefaultSetup(state.setup);
    if (
      !localSetupIsDefault &&
      localVersion > 0 &&
      pull.setupRowVersion > 0 &&
      localVersion !== pull.setupRowVersion
    ) {
      /**
       * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01 — sind beide Seiten
       * fachlich identisch, gibt es keinen Datenkonflikt, sondern nur eine
       * Versionshistorie. Dann wird ausschließlich die Serverversion
       * übernommen und der gegenstandslose Auftrag abgeschlossen: kein Push,
       * kein Überschreiben lokaler oder entfernter Firmendaten. Der Abschluss
       * selbst trägt den Race-Guard (nur `blocked`).
       */
      const identical =
        canonicalCloudPayloadKey(buildCompanySetupCloudPayload(state.setup)) ===
        canonicalCloudPayloadKey(buildCompanySetupCloudPayload(remoteSetup));
      if (
        identical &&
        completeIdenticalCompanyCloudOutboxEntry(
          getSyncOutboxSnapshot(),
          'company_setup',
          workspaceId,
        ).completed
      ) {
        identicalStateResolved.push('company_setup');
        next.setupSync = {
          version: pull.setupRowVersion,
          updatedAt: pull.setupUpdatedAt ?? new Date().toISOString(),
          deleted: false,
          deviceId: state.syncClient!.deviceId,
          workspaceId,
        };
      } else {
        conflicts.push('company_setup');
      }
    } else if (localSetupIsDefault || pull.setupRowVersion >= localVersion) {
      next.setup = remoteSetup;
      applyRemoteSetupSyncMeta(pull.setupRowVersion, pull.setupUpdatedAt ?? new Date().toISOString());
      next.setupSync = {
        version: pull.setupRowVersion,
        updatedAt: pull.setupUpdatedAt ?? new Date().toISOString(),
        deleted: false,
        deviceId: state.syncClient!.deviceId,
        workspaceId,
      };
    }
  } else if (!isDefaultSetup(state.setup)) {
    /**
     * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — die Cloud kennt kein Setup, lokal
     * liegt ein echter Betrieb: nachmelden statt nur kommentieren. Defaultwerte
     * werden nie angemeldet (isDefaultSetup).
     */
    enqueueSyncOutbox({
      entityType: 'company_setup',
      entityId: workspaceId,
      operation: 'create',
      version: Math.max(1, state.setupSync?.version ?? 1),
    });
  }

  // Gleiche Schutzregel wie beim Setup — unabhängig geprüft.
  const remoteProfileRaw = parseCompanyProfileFromCloud(
    pull.companyProfilePayload,
    state.companyProfile?.logoDataUrl,
  );
  const remoteProfileHasIdentity = Boolean(remoteProfileRaw?.companyName?.trim());
  const localProfileIsReal = !isDefaultCompanyProfile(state.companyProfile);
  const emptyRemoteProfileAgainstRealLocal =
    Boolean(remoteProfileRaw) && !remoteProfileHasIdentity && localProfileIsReal;
  const remoteProfile = emptyRemoteProfileAgainstRealLocal ? null : remoteProfileRaw;

  if (emptyRemoteProfileAgainstRealLocal) {
    next.companyProfileSync = {
      version: pull.companyProfileRowVersion,
      updatedAt:
        pull.companyProfileUpdatedAt ??
        state.companyProfileSync?.updatedAt ??
        new Date().toISOString(),
      deleted: false,
      deviceId: state.syncClient!.deviceId,
      workspaceId,
    };
    applyRemoteCompanyProfileSyncMeta(
      pull.companyProfileRowVersion,
      pull.companyProfileUpdatedAt ?? new Date().toISOString(),
    );
  }

  if (remoteProfile) {
    const localVersion = state.companyProfileSync?.version ?? 0;
    // Gleiche Regel wie beim Setup: ein Default-Profil ist kein Konflikt.
    const localProfileIsDefault = isDefaultCompanyProfile(state.companyProfile);
    if (
      !localProfileIsDefault &&
      localVersion > 0 &&
      pull.companyProfileRowVersion > 0 &&
      localVersion !== pull.companyProfileRowVersion
    ) {
      // Gleiche Identical-State-Regel wie beim Setup, unabhängig geprüft.
      const identical =
        state.companyProfile !== undefined &&
        canonicalCloudPayloadKey(buildCompanyProfileCloudPayload(state.companyProfile)) ===
          canonicalCloudPayloadKey(buildCompanyProfileCloudPayload(remoteProfile));
      if (
        identical &&
        completeIdenticalCompanyCloudOutboxEntry(
          getSyncOutboxSnapshot(),
          'company_profile',
          workspaceId,
        ).completed
      ) {
        identicalStateResolved.push('company_profile');
        next.companyProfileSync = {
          version: pull.companyProfileRowVersion,
          updatedAt: pull.companyProfileUpdatedAt ?? new Date().toISOString(),
          deleted: false,
          deviceId: state.syncClient!.deviceId,
          workspaceId,
        };
      } else {
        conflicts.push('company_profile');
      }
    } else if (localProfileIsDefault || pull.companyProfileRowVersion >= localVersion) {
      next.companyProfile = remoteProfile;
      applyRemoteCompanyProfileSyncMeta(
        pull.companyProfileRowVersion,
        pull.companyProfileUpdatedAt ?? new Date().toISOString(),
      );
      next.companyProfileSync = {
        version: pull.companyProfileRowVersion,
        updatedAt: pull.companyProfileUpdatedAt ?? new Date().toISOString(),
        deleted: false,
        deviceId: state.syncClient!.deviceId,
        workspaceId,
      };
    }
  } else if (!isDefaultCompanyProfile(state.companyProfile)) {
    // Gleiche Regel wie beim Setup: ein echtes lokales Profil wird nachgemeldet.
    enqueueSyncOutbox({
      entityType: 'company_profile',
      entityId: workspaceId,
      operation: 'create',
      version: Math.max(1, state.companyProfileSync?.version ?? 1),
    });
  }

  if (pull.members.length > 0) {
    next.workspaceMembers = pull.members;
  }

  const activeLocalVorgaenge = filterSyncActive(state.vorgaenge);
  const realLocalVorgaenge = activeLocalVorgaenge.filter((vorgang) => !isDefinitelyMockVorgang(vorgang));
  if ((pull.vorgaenge ?? []).length === 0 && realLocalVorgaenge.length > 0) {
    for (const vorgang of realLocalVorgaenge) {
      enqueueSyncOutbox({
        entityType: 'vorgang',
        entityId: vorgang.id,
        operation: 'create',
        version: Math.max(1, vorgang.sync?.version ?? 1),
      });
    }
  } else if ((pull.vorgaenge ?? []).length === 0 && activeLocalVorgaenge.length > 0) {
    next.vorgaenge = [];
  } else if ((pull.vorgaenge ?? []).length > 0) {
    const deviceId = state.syncClient!.deviceId;
    const vorgangMerge = mergeVorgaengeFromPull(
      state.vorgaenge,
      pull.vorgaenge ?? [],
      deviceId,
      workspaceId,
    );
    if (vorgangMerge.conflicts.length > 0) {
      conflicts.push(...vorgangMerge.conflicts);
    } else {
      next.vorgaenge = vorgangMerge.vorgaenge;
    }
  }

  /**
   * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — der Aufrufer persistiert diesen
   * Zustand. Ohne den aktuellen Outbox-Snapshot würden die gerade erzeugten
   * Einträge durch einen alten state.syncOutbox wieder verschwinden.
   */
  next.syncOutbox = getSyncOutboxSnapshot();

  /**
   * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01C — der Abschluss der
   * gegenstandslosen Firmenaufträge wird erst hier, nach dem Snapshot, in den
   * Kandidaten geschrieben. Damit reisen neue Sync-Metaversion und Abschluss im
   * selben `AppPersistedState` und werden von derselben Persistenzgrenze
   * übernommen. Der globale Outbox-Zustand bleibt bis dahin unverändert.
   */
  for (const entityType of identicalStateResolved) {
    next.syncOutbox = completeIdenticalCompanyCloudOutboxEntry(
      next.syncOutbox,
      entityType,
      workspaceId,
    ).outbox;
  }

  next.savedAt = new Date().toISOString();
  return { state: next, conflicts };
}

export function bumpCloudEntitiesAfterLocalChange(
  kind: 'setup' | 'company_profile' | 'workspace_settings',
): void {
  if (kind === 'setup') bumpSetupSyncMeta();
  if (kind === 'company_profile') bumpCompanyProfileSyncMeta();
}
