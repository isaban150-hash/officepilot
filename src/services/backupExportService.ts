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
  BackupMissingFileEntry,
  BackupRecordCounts,
} from '../types/backupExport';
import { BACKUP_SCHEMA_VERSION } from '../types/backupExport';
import { findBackupCredentialPaths } from './backupCredentialScan';
import { buildBackupAreaCounts } from './backupAreaCounts';
import { collectRequiredBackupFileRefIds } from './backupAreaPreview';
import { buildBackupFileName, resolveBetriebName } from './exportFileNames';
import { OBJECT_URL_RELEASE_DELAY_MS } from './storage/localRecoveryDownloadService';

export { BACKUP_SCHEMA_VERSION };

/**
 * Deterministic backup filename for a given local timestamp.
 *
 * EINRICHTUNG-01 (AP7; 1.23, F13) — `OfficeTakt_Sicherung_<Betrieb>_<JJJJ-MM-TT>_<HH-MM>.zip`.
 */
export function buildBackupFilename(when: Date = new Date(), betrieb?: string | null): string {
  return buildBackupFileName(betrieb, when);
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

/**
 * EINRICHTUNG-01 (S-13) — alle benötigten Dateireferenzen, getrennt nach
 * vorhanden und fehlend (Bindung ohne Referenz). Kein früher Abbruch mehr: Der
 * Aufrufer entscheidet, ob eine Lücke eine Sicherung verhindert.
 */
function resolveRequiredFileRefs(): { refs: DocumentFileRef[]; missing: BackupMissingFileEntry[] } {
  const refs: DocumentFileRef[] = [];
  const missing: BackupMissingFileEntry[] = [];
  for (const id of collectRequiredBackupFileRefIds()) {
    const ref = getDocumentFileRefById(id);
    if (!ref) {
      missing.push({ fileRefId: id });
      continue;
    }
    refs.push(ref);
  }
  return { refs, missing };
}

function buildRecordCounts(state: AppPersistedState): BackupRecordCounts {
  return {
    inboxItems: state.inboxItems?.length ?? 0,
    vorgaenge: state.vorgaenge?.length ?? 0,
    // FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Rechnungen liegen nicht mehr in den Vorgängen.
    invoiceEntries: state.invoiceEntries?.length ?? 0,
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

export type BackupBuildOptions = {
  /**
   * EINRICHTUNG-01 (S-13.2) — nur nach ausdrücklicher Zustimmung: fehlende
   * Dateien weglassen und die Lücke im Manifest vermerken (Teilsicherung).
   */
  allowMissingFiles?: boolean;
};

/**
 * Builds a complete backup ZIP in memory. Does not mutate stores.
 * Fehlt eine referenzierte Datei, entsteht ohne Zustimmung keine Sicherung; die
 * Antwort nennt die fehlenden Dateien (S-13.1). Mit `allowMissingFiles` entsteht
 * eine ausdrücklich gekennzeichnete Teilsicherung (S-13.2).
 */
export async function buildLocalBackupBundle(
  when: Date = new Date(),
  options: BackupBuildOptions = {},
): Promise<
  | { ok: true; artifacts: BackupBundleArtifacts }
  | {
      ok: false;
      reason: 'missing_blob' | 'build_failed' | 'contains_credentials';
      errorKey: string;
      missingFiles?: BackupMissingFileEntry[];
      credentialPaths?: string[];
    }
> {
  try {
    const refsBefore = getDocumentFileRefStoreSnapshot();
    const appState = buildSanitizedBackupAppState();

    // EIN-04 — dieselbe strukturelle Prüfung wie beim Einspielen: keine Sicherung, die später abgewiesen würde.
    const credentialPaths = findBackupCredentialPaths(appState);
    if (credentialPaths.length > 0) {
      return { ok: false, reason: 'contains_credentials', errorKey: 'backup.error.credentials', credentialPaths };
    }

    const resolved = resolveRequiredFileRefs();
    const missing: BackupMissingFileEntry[] = [...resolved.missing];

    const fileEntries: BackupFileManifestEntry[] = [];
    const zip = new JSZip();
    let totalFileBytes = 0;

    for (const ref of resolved.refs) {
      const blob = await getDocumentFileBlob(ref);
      if (!blob) {
        missing.push({
          fileRefId: ref.id,
          ...(ref.originalFileName ? { originalFileName: ref.originalFileName } : {}),
        });
        continue;
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

    // S-13.1 — ohne Zustimmung keine Sicherung mit Lücke; die Antwort nennt die Dateien.
    if (missing.length > 0 && !options.allowMissingFiles) {
      return { ok: false, reason: 'missing_blob', errorKey: 'backup.error.missingFile', missingFiles: missing };
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
      areaCounts: buildBackupAreaCounts(appState, fileEntries.length),
      fileCount: fileEntries.length,
      totalFileBytes,
      files: fileEntries,
      // S-13.2 — Teilsicherung ausdrücklich kennzeichnen; nie als vollständig ausgeben.
      ...(missing.length > 0 ? { incomplete: true as const, missingFiles: missing } : {}),
    };

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    zip.file('app-state.json', JSON.stringify(appState));

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const filename = buildBackupFilename(when, resolveBetriebName(appState));

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
 * Triggers a browser download for a prepared ZIP. Does not mutate stores.
 *
 * EINRICHTUNG-01 (EIN-05, S-12) — derselbe Weg wie bei den Notfallseiten: Der
 * Link hängt vor dem Klick im Dokument und wird danach entfernt; die
 * Object-URL wird erst nach {@link OBJECT_URL_RELEASE_DELAY_MS} freigegeben.
 * Bisher wurde sie schon im nächsten Tick widerrufen — Safari/iOS brach den
 * Download dabei ab. Ein Erfolg bedeutet „Download gestartet", nicht „gespeichert".
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
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(revoke, OBJECT_URL_RELEASE_DELAY_MS);
  }

  return { objectUrl, revoke };
}

/**
 * Full user-triggered export: build bundle then download.
 * Call only after an explicit user click.
 */
export async function exportLocalBackupBundle(
  when: Date = new Date(),
  options: BackupBuildOptions = {},
): Promise<BackupExportResult> {
  const built = await buildLocalBackupBundle(when, options);
  if (!built.ok) {
    return {
      ok: false,
      reason: built.reason,
      errorKey: built.errorKey,
      ...(built.missingFiles ? { missingFiles: built.missingFiles } : {}),
      ...(built.credentialPaths ? { credentialPaths: built.credentialPaths } : {}),
    };
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
      incomplete: built.artifacts.manifest.incomplete === true,
      objectUrl,
      revokeObjectUrl: revoke,
    };
  } catch {
    return { ok: false, reason: 'download_failed', errorKey: 'backup.error.failed' };
  }
}

/**
 * Test helper: assert sanitized state has no auth structures.
 * EINRICHTUNG-01 (EIN-04) — dieselbe strukturelle Prüfung wie Export und Einspielen.
 */
export function assertBackupAppStateHasNoSecrets(state: AppPersistedState): void {
  const paths = findBackupCredentialPaths(state);
  if (paths.length > 0) {
    throw new Error(`backup_contains_forbidden:${paths[0]}`);
  }
  if ('syncOutbox' in state && state.syncOutbox !== undefined) {
    throw new Error('backup_contains_syncOutbox');
  }
  if ('documentFileBlobs' in state && state.documentFileBlobs !== undefined) {
    throw new Error('backup_contains_inline_blobs');
  }
}
