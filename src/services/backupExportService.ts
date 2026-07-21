import JSZip from 'jszip';
import { buildPersistedStateSnapshot } from './persistenceService';
import {
  getDocumentFileBlob,
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
} from './documentFileStoreService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from './documentFileRepresentationBindingStoreService';
import type { AppPersistedState } from '../types/models';
import type { DocumentFileRef } from '../types/documentFileRef';
import type {
  BackupExportResult,
  BackupFileManifestEntry,
  BackupManifest,
  BackupRecordCounts,
} from '../types/backupExport';
import { BACKUP_SCHEMA_VERSION } from '../types/backupExport';

export { BACKUP_SCHEMA_VERSION };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Deterministic backup filename for a given local timestamp. */
export function buildBackupFilename(when: Date = new Date()): string {
  const y = when.getFullYear();
  const m = pad2(when.getMonth() + 1);
  const d = pad2(when.getDate());
  const hh = pad2(when.getHours());
  const mm = pad2(when.getMinutes());
  return `OfficePilot_Backup_${y}-${m}-${d}_${hh}-${mm}.zip`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * App state for backup: deep clone of persisted snapshot without outbox,
 * without inline legacy blob map (bytes live under files/), and without
 * auth/session fields (those are never in AppPersistedState).
 */
export function buildSanitizedBackupAppState(
  snapshot: AppPersistedState = buildPersistedStateSnapshot(),
): AppPersistedState {
  const cloned = cloneJson(snapshot);
  delete cloned.syncOutbox;
  delete cloned.documentFileBlobs;
  return cloned;
}

/** All FileRefs in the store plus any binding targets (original + derived). */
function collectRequiredFileRefIds(): string[] {
  const ids = new Set<string>();
  for (const ref of getDocumentFileRefStoreSnapshot()) {
    ids.add(ref.id);
  }
  for (const binding of getDocumentFileRepresentationBindingStoreSnapshot()) {
    ids.add(binding.fileRefId);
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

function resolveRequiredFileRefs():
  | { ok: true; refs: DocumentFileRef[] }
  | { ok: false } {
  const refs: DocumentFileRef[] = [];
  for (const id of collectRequiredFileRefIds()) {
    const ref = getDocumentFileRefById(id);
    if (!ref) return { ok: false };
    refs.push(ref);
  }
  return { ok: true, refs };
}

function buildRecordCounts(state: AppPersistedState): BackupRecordCounts {
  return {
    inboxItems: state.inboxItems?.length ?? 0,
    vorgaenge: state.vorgaenge?.length ?? 0,
    tasks: state.tasks?.length ?? 0,
    documents: state.documents?.length ?? 0,
    expenses: state.expenses?.length ?? 0,
    uploadedDocuments: state.uploadedDocuments?.length ?? 0,
    documentFileRefs: state.documentFileRefs?.length ?? 0,
    documentFileRepresentationBindings: state.documentFileRepresentationBindings?.length ?? 0,
    communicationHistory: state.communicationHistory?.length ?? 0,
    knowledgeFacts: state.knowledgeFacts?.length ?? 0,
    vorgangNotes: state.vorgangNotes?.length ?? 0,
    dunningDocumentations: state.dunningDocumentations?.length ?? 0,
    mailImports: state.mailImports?.length ?? 0,
  };
}

export type BackupBundleArtifacts = {
  filename: string;
  zipBlob: Blob;
  manifest: BackupManifest;
  appState: AppPersistedState;
};

/**
 * Builds a complete backup ZIP in memory. Does not mutate stores.
 * Fails if any referenced file blob is missing.
 */
export async function buildLocalBackupBundle(
  when: Date = new Date(),
): Promise<
  | { ok: true; artifacts: BackupBundleArtifacts }
  | { ok: false; reason: 'missing_blob' | 'build_failed'; errorKey: string }
> {
  try {
    const refsBefore = getDocumentFileRefStoreSnapshot();
    const appState = buildSanitizedBackupAppState();
    const resolved = resolveRequiredFileRefs();
    if (!resolved.ok) {
      return { ok: false, reason: 'missing_blob', errorKey: 'backup.error.missingFile' };
    }

    const fileEntries: BackupFileManifestEntry[] = [];
    const zip = new JSZip();
    let totalFileBytes = 0;

    for (const ref of resolved.refs) {
      const blob = await getDocumentFileBlob(ref);
      if (!blob) {
        return { ok: false, reason: 'missing_blob', errorKey: 'backup.error.missingFile' };
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const path = `files/${ref.id}`;
      zip.file(path, bytes);
      totalFileBytes += bytes.byteLength;

      fileEntries.push({
        fileRefId: ref.id,
        path,
        mimeType: ref.mimeType || blob.type || 'application/octet-stream',
        fileSize: bytes.byteLength,
        originalFileName: ref.originalFileName,
        contentHash: ref.contentHash,
      });
    }

    // Ensure snapshot refs match store; re-attach refs list from live store (cloned in sanitize).
    appState.documentFileRefs = cloneJson(getDocumentFileRefStoreSnapshot());
    appState.documentFileRepresentationBindings = cloneJson(
      getDocumentFileRepresentationBindingStoreSnapshot(),
    );

    const manifest: BackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: when.toISOString(),
      recordCounts: buildRecordCounts(appState),
      fileCount: fileEntries.length,
      totalFileBytes,
      files: fileEntries,
    };

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('app-state.json', JSON.stringify(appState));

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const filename = buildBackupFilename(when);

    // Guarantees: store identity unchanged (read-only path).
    const refsAfter = getDocumentFileRefStoreSnapshot();
    if (refsBefore.length !== refsAfter.length) {
      return { ok: false, reason: 'build_failed', errorKey: 'backup.error.failed' };
    }

    return {
      ok: true,
      artifacts: { filename, zipBlob, manifest, appState },
    };
  } catch {
    return { ok: false, reason: 'build_failed', errorKey: 'backup.error.failed' };
  }
}

/**
 * Triggers a browser download for a prepared ZIP. Revokes the Object URL after click.
 * Does not mutate stores.
 */
export function downloadBackupBlob(blob: Blob, filename: string): { objectUrl: string; revoke: () => void } {
  const objectUrl = URL.createObjectURL(blob);
  const revoke = () => {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // ignore
    }
  };

  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
    // Revoke on next tick so the browser can start the download.
    setTimeout(revoke, 0);
  }

  return { objectUrl, revoke };
}

/**
 * Full user-triggered export: build bundle then download.
 * Call only after an explicit user click.
 */
export async function exportLocalBackupBundle(
  when: Date = new Date(),
): Promise<BackupExportResult> {
  const built = await buildLocalBackupBundle(when);
  if (!built.ok) {
    return { ok: false, reason: built.reason, errorKey: built.errorKey };
  }

  try {
    const { objectUrl, revoke } = downloadBackupBlob(
      built.artifacts.zipBlob,
      built.artifacts.filename,
    );
    return {
      ok: true,
      filename: built.artifacts.filename,
      blob: built.artifacts.zipBlob,
      manifest: built.artifacts.manifest,
      objectUrl,
      revokeObjectUrl: revoke,
    };
  } catch {
    return { ok: false, reason: 'download_failed', errorKey: 'backup.error.failed' };
  }
}

/** Test helper: assert sanitized state has no auth-like keys. */
export function assertBackupAppStateHasNoSecrets(state: AppPersistedState): void {
  const raw = JSON.stringify(state);
  const forbidden = [
    'accessToken',
    'refreshToken',
    'password',
    'Authorization',
    'sb-',
    'supabase.auth',
  ];
  for (const needle of forbidden) {
    if (raw.includes(needle)) {
      throw new Error(`backup_contains_forbidden:${needle}`);
    }
  }
  if ('syncOutbox' in state && state.syncOutbox !== undefined) {
    throw new Error('backup_contains_syncOutbox');
  }
  if ('documentFileBlobs' in state && state.documentFileBlobs !== undefined) {
    throw new Error('backup_contains_inline_blobs');
  }
}
