import JSZip from 'jszip';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  savePersistedStateToKey,
} from './persistenceService';
import { buildLocalBackupBundle } from './backupExportService';
import { validateLocalBackupZip } from './backupValidateService';
import {
  deleteDocumentBlob,
  readDocumentBlob,
  saveDocumentBlob,
} from './storage/documentBlobIndexedDbService';
import { getActiveStorageScope } from './storage/storageScopeService';
import { getSyncClientSnapshot } from './sync/syncClientService';
import { getDocumentFileRefStoreSnapshot } from './documentFileStoreService';
import type { AppPersistedState } from '../types/models';
import type { BackupFileManifestEntry } from '../types/backupExport';
import type { ValidatedBackupBundle } from '../types/backupValidate';
import type {
  BackupRestoreDeps,
  BackupRestoreErrorKey,
  BackupRestoreFailureReason,
  BackupRestoreInput,
  BackupRestorePhase,
  BackupRestoreResult,
  SafetyBackupArtifacts,
} from '../types/backupRestore';

/** Isolated staging ids within the active blob scope (never collide with real file-ref ids). */
export const BACKUP_RESTORE_STAGING_PREFIX = '__op_rstg__';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(
  reason: BackupRestoreFailureReason,
  errorKey: BackupRestoreErrorKey,
  extra?: Partial<Extract<BackupRestoreResult, { ok: false }>>,
): BackupRestoreResult {
  return { ok: false, reason, errorKey, ...extra };
}

function isValidatedBundle(value: BackupRestoreInput['validated']): value is ValidatedBackupBundle {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as ValidatedBackupBundle).ok === true &&
    (value as ValidatedBackupBundle).zipBytes instanceof Uint8Array &&
    (value as ValidatedBackupBundle).manifest != null &&
    (value as ValidatedBackupBundle).appState != null &&
    (value as ValidatedBackupBundle).preview != null
  );
}

function stagingIdFor(fileRefId: string): string {
  return `${BACKUP_RESTORE_STAGING_PREFIX}${fileRefId}`;
}

function isStagingId(fileRefId: string): boolean {
  return fileRefId.startsWith(BACKUP_RESTORE_STAGING_PREFIX);
}

async function maybeFailAfter(
  deps: BackupRestoreDeps,
  phase: BackupRestorePhase,
): Promise<void> {
  deps.onPhase?.(phase);
  if (deps.failAfterPhase === phase) {
    throw new Error('restore_injected_failure');
  }
}

async function clearStagingBlobs(
  fileRefIds: string[],
  scope = getActiveStorageScope(),
): Promise<void> {
  for (const id of fileRefIds) {
    try {
      await deleteDocumentBlob(stagingIdFor(id), scope);
    } catch {
      // best-effort staging cleanup
    }
  }
}

/**
 * Build restore app-state: keep live sync client & empty outbox; drop inline blobs.
 * Does not change active storage scope.
 */
export function buildSanitizedRestoreAppState(
  validatedAppState: AppPersistedState,
  liveSyncClient = getSyncClientSnapshot(),
): AppPersistedState {
  const state = cloneJson(validatedAppState);
  state.syncClient = cloneJson(liveSyncClient);
  state.syncOutbox = [];
  delete state.documentFileBlobs;
  return state;
}

async function loadZipFileBytes(
  zipBytes: Uint8Array,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const zip = await JSZip.loadAsync(zipBytes);
    const entry = zip.file(path);
    if (!entry) return null;
    return entry.async('uint8array');
  } catch {
    return null;
  }
}

async function stageImportBlobs(
  validated: ValidatedBackupBundle,
  scope: ReturnType<typeof getActiveStorageScope>,
): Promise<{ stagedIds: string[] }> {
  const stagedIds: string[] = [];
  const createdAt = new Date().toISOString();

  for (const entry of validated.manifest.files) {
    const bytes = await loadZipFileBytes(validated.zipBytes, entry.path);
    if (!bytes || bytes.byteLength !== entry.fileSize) {
      throw new Error('stage_blob_missing');
    }
    const blob = new Blob([bytes], { type: entry.mimeType });
    const stageId = stagingIdFor(entry.fileRefId);
    await saveDocumentBlob({
      fileRefId: stageId,
      blob,
      mimeType: entry.mimeType,
      fileSize: entry.fileSize,
      contentHash: entry.contentHash ?? '',
      createdAt,
      scope,
    });
    stagedIds.push(entry.fileRefId);
  }
  return { stagedIds };
}

async function verifyStagedBlobs(
  files: BackupFileManifestEntry[],
  scope: ReturnType<typeof getActiveStorageScope>,
): Promise<void> {
  for (const entry of files) {
    const record = await readDocumentBlob(stagingIdFor(entry.fileRefId), scope);
    if (!record) throw new Error('staged_missing');
    if (record.fileSize !== entry.fileSize) throw new Error('staged_size');
    if (record.mimeType !== entry.mimeType) throw new Error('staged_mime');
    if (record.blob.size !== entry.fileSize) throw new Error('staged_blob_size');
  }
}

async function promoteStagedBlobs(
  files: BackupFileManifestEntry[],
  scope: ReturnType<typeof getActiveStorageScope>,
): Promise<void> {
  const createdAt = new Date().toISOString();
  for (const entry of files) {
    const staged = await readDocumentBlob(stagingIdFor(entry.fileRefId), scope);
    if (!staged) throw new Error('promote_missing');
    await saveDocumentBlob({
      fileRefId: entry.fileRefId,
      blob: staged.blob,
      mimeType: entry.mimeType,
      fileSize: entry.fileSize,
      contentHash: entry.contentHash ?? staged.contentHash ?? '',
      createdAt,
      scope,
    });
  }
}

async function verifyRestoredBlobs(
  files: BackupFileManifestEntry[],
  scope: ReturnType<typeof getActiveStorageScope>,
): Promise<void> {
  for (const entry of files) {
    const record = await readDocumentBlob(entry.fileRefId, scope);
    if (!record) throw new Error('restored_missing');
    if (record.fileSize !== entry.fileSize) throw new Error('restored_size');
    if (record.mimeType !== entry.mimeType) throw new Error('restored_mime');
  }
}

async function commitRestoredState(
  state: AppPersistedState,
  scope: ReturnType<typeof getActiveStorageScope>,
): Promise<void> {
  applyStateToStores(state);
  const saved = savePersistedStateToKey(scope, {
    ...buildPersistedStateSnapshot(),
    syncOutbox: [],
    syncClient: state.syncClient,
  });
  if (!saved.success) {
    throw new Error('persist_failed');
  }
}

async function createAndValidateSafetyBackup(): Promise<SafetyBackupArtifacts> {
  const built = await buildLocalBackupBundle();
  if (!built.ok) {
    throw new Error('safety_build_failed');
  }
  const bytes = new Uint8Array(await built.artifacts.zipBlob.arrayBuffer());
  const validated = await validateLocalBackupZip(bytes);
  if (!validated.ok) {
    throw new Error('safety_validate_failed');
  }
  return {
    zipBytes: validated.zipBytes,
    manifest: validated.manifest,
    appState: validated.appState,
    validated,
  };
}

/**
 * Restore live state + blobs from a previously validated safety backup.
 * Does not create another safety backup (used for rollback).
 */
export async function applyValidatedBackupReplace(
  validated: ValidatedBackupBundle,
  deps: BackupRestoreDeps = {},
  options: { cleanupOldBlobs: boolean; previousFileRefIds?: string[] } = {
    cleanupOldBlobs: true,
  },
): Promise<void> {
  const scope = getActiveStorageScope();
  const liveClient = getSyncClientSnapshot();
  const previousIds =
    options.previousFileRefIds ??
    getDocumentFileRefStoreSnapshot().map((r) => r.id);
  let stagedIds: string[] = [];

  try {
    await maybeFailAfter(deps, 'stage_blobs');
    const staged = await stageImportBlobs(validated, scope);
    stagedIds = staged.stagedIds;

    await maybeFailAfter(deps, 'verify_staged');
    await verifyStagedBlobs(validated.manifest.files, scope);

    await maybeFailAfter(deps, 'prepare_state');
    const restoreState = buildSanitizedRestoreAppState(validated.appState, liveClient);

    await maybeFailAfter(deps, 'promote_blobs');
    await promoteStagedBlobs(validated.manifest.files, scope);

    await maybeFailAfter(deps, 'commit_state');
    await commitRestoredState(restoreState, scope);

    await maybeFailAfter(deps, 'verify_restored');
    await verifyRestoredBlobs(validated.manifest.files, scope);
    const snapshot = buildPersistedStateSnapshot();
    if ((snapshot.syncOutbox?.length ?? 0) > 0) {
      throw new Error('outbox_not_empty');
    }
    if (snapshot.syncClient?.deviceId !== liveClient.deviceId) {
      throw new Error('sync_client_changed');
    }

    if (options.cleanupOldBlobs) {
      await maybeFailAfter(deps, 'cleanup_old');
      const newIds = new Set((snapshot.documentFileRefs ?? []).map((r) => r.id));
      for (const id of previousIds) {
        if (!newIds.has(id) && !isStagingId(id)) {
          try {
            await deleteDocumentBlob(id, scope);
          } catch {
            // orphan cleanup best-effort after verified success
          }
        }
      }
    }
  } finally {
    await maybeFailAfter(deps, 'cleanup_staging');
    await clearStagingBlobs(
      stagedIds.length > 0
        ? stagedIds
        : validated.manifest.files.map((f) => f.fileRefId),
      scope,
    );
  }
}

async function rollbackFromSafety(
  safety: SafetyBackupArtifacts,
  deps: BackupRestoreDeps,
): Promise<{ ok: true } | { ok: false }> {
  try {
    deps.onPhase?.('rollback');
    await applyValidatedBackupReplace(safety.validated, {
      ...deps,
      failAfterPhase: undefined,
      onPhase: undefined,
    }, { cleanupOldBlobs: false });
    await verifyRestoredBlobs(safety.manifest.files, getActiveStorageScope());
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Manual full-replace restore for the active storage scope only.
 * Requires a sealed ValidatedBackupBundle from backupValidateService and explicit confirmation.
 */
export async function restoreLocalBackupBundle(
  input: BackupRestoreInput,
  deps: BackupRestoreDeps = {},
): Promise<BackupRestoreResult> {
  if (!input.confirmed) {
    return fail('not_confirmed', 'backup.restore.error.notConfirmed');
  }
  if (!isValidatedBundle(input.validated)) {
    return fail('not_validated', 'backup.restore.error.notValidated');
  }

  const validated = input.validated;
  const shouldReload = input.reload !== false;
  const previousFileRefIds = getDocumentFileRefStoreSnapshot().map((r) => r.id);
  const liveClientBefore = getSyncClientSnapshot();
  const scopeBefore = getActiveStorageScope();

  let safety: SafetyBackupArtifacts | null = null;
  let commitStarted = false;
  let stagedIds: string[] = [];

  try {
    await maybeFailAfter(deps, 'safety_backup');
    safety = await createAndValidateSafetyBackup();
  } catch {
    return fail('safety_failed', 'backup.restore.error.safety');
  }

  const scope = getActiveStorageScope();

  try {
    await maybeFailAfter(deps, 'stage_blobs');
    const staged = await stageImportBlobs(validated, scope);
    stagedIds = staged.stagedIds;

    await maybeFailAfter(deps, 'verify_staged');
    await verifyStagedBlobs(validated.manifest.files, scope);

    await maybeFailAfter(deps, 'prepare_state');
    const restoreState = buildSanitizedRestoreAppState(
      validated.appState,
      liveClientBefore,
    );

    // Promoting writes final blob keys — from here on, rollback via safety is required.
    commitStarted = true;
    await maybeFailAfter(deps, 'promote_blobs');
    await promoteStagedBlobs(validated.manifest.files, scope);

    await maybeFailAfter(deps, 'commit_state');
    await commitRestoredState(restoreState, scope);

    await maybeFailAfter(deps, 'verify_restored');
    await verifyRestoredBlobs(validated.manifest.files, scope);
    const after = buildPersistedStateSnapshot();
    if ((after.syncOutbox?.length ?? 0) > 0) {
      throw new Error('verify_outbox');
    }
    if (after.syncClient?.deviceId !== liveClientBefore.deviceId) {
      throw new Error('verify_client');
    }
    // Scope must remain unchanged
    const scopeAfter = getActiveStorageScope();
    if (JSON.stringify(scopeAfter) !== JSON.stringify(scopeBefore)) {
      throw new Error('verify_scope');
    }

    // Cleanup old blobs only after verified success
    try {
      await maybeFailAfter(deps, 'cleanup_old');
      const newIds = new Set((after.documentFileRefs ?? []).map((r) => r.id));
      for (const id of previousFileRefIds) {
        if (!newIds.has(id) && !isStagingId(id)) {
          try {
            await deleteDocumentBlob(id, scope);
          } catch {
            // leave orphans; do not roll back verified restore
          }
        }
      }
    } catch {
      // cleanup_old injected failure or errors: keep restored data
    }

    await clearStagingBlobs(stagedIds, scope);

    if (shouldReload) {
      deps.onPhase?.('reload');
      const reloadFn = deps.reload ?? (() => {
        if (typeof window !== 'undefined') {
          window.location.reload();
        }
      });
      reloadFn();
    }

    return { ok: true, reloaded: shouldReload };
  } catch {
    // Always clear staging
    await clearStagingBlobs(
      stagedIds.length > 0
        ? stagedIds
        : validated.manifest.files.map((f) => f.fileRefId),
      scope,
    );

    if (!commitStarted) {
      // Live untouched (except staging which was cleared)
      return fail('stage_failed', 'backup.restore.error.stage');
    }

    if (!safety) {
      return fail('rollback_failed', 'backup.restore.error.rollback', {
        rolledBack: false,
        rollbackFailed: true,
      });
    }

    const rolled = await rollbackFromSafety(safety, deps);
    if (!rolled.ok) {
      return fail('rollback_failed', 'backup.restore.error.rollback', {
        rolledBack: false,
        rollbackFailed: true,
      });
    }

    return fail('verify_failed', 'backup.restore.error.verify', {
      rolledBack: true,
      rollbackFailed: false,
    });
  }
}

/** Map restore phase to a safe UI translation key. */
export function backupRestorePhaseMessageKey(
  phase: BackupRestorePhase,
): import('../types/backupRestore').BackupRestorePhaseKey | null {
  switch (phase) {
    case 'safety_backup':
      return 'backup.restore.phase.safety';
    case 'stage_blobs':
    case 'verify_staged':
    case 'prepare_state':
    case 'promote_blobs':
      return 'backup.restore.phase.stage';
    case 'commit_state':
      return 'backup.restore.phase.commit';
    case 'verify_restored':
    case 'cleanup_old':
      return 'backup.restore.phase.verify';
    case 'rollback':
      return 'backup.restore.phase.rollback';
    default:
      return null;
  }
}
