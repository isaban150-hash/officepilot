import JSZip from 'jszip';
import {
  isValidPersistedStateV1,
  isValidPersistedStateV2,
  isValidPersistedStateV3,
  isValidPersistedStateV4,
  isValidPersistedStateV5,
  migratePersistedStateV1ToV2,
  migratePersistedStateV2ToV3,
  migratePersistedStateV3ToV4,
  migratePersistedStateV4ToV5,
  STORAGE_VERSION,
} from './sync/syncMigrationService';
import { BACKUP_SCHEMA_VERSION } from '../types/backupExport';
import type { BackupFileManifestEntry, BackupManifest, BackupRecordCounts } from '../types/backupExport';
import {
  BACKUP_VALIDATE_LIMITS,
  type BackupValidateErrorKey,
  type BackupValidateFailureReason,
  type BackupValidationPreview,
  type BackupValidationResult,
} from '../types/backupValidate';
import type { AppPersistedState } from '../types/models';
import type { DocumentFileRef } from '../types/documentFileRef';
import type { DocumentFileRepresentationBinding } from '../types/documentFileRepresentationBinding';

export { BACKUP_VALIDATE_LIMITS, BACKUP_SCHEMA_VERSION };

const MANIFEST_PATH = 'manifest.json';
const APP_STATE_PATH = 'app-state.json';
const FILES_PREFIX = 'files/';

const MIME_PATTERN = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
/** FileRef ids from generateEntityId — no path separators. */
const FILE_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const RECORD_COUNT_KEYS: (keyof BackupRecordCounts)[] = [
  'inboxItems',
  'vorgaenge',
  'tasks',
  'documents',
  'expenses',
  'uploadedDocuments',
  'documentFileRefs',
  'documentFileRepresentationBindings',
  'communicationHistory',
  'knowledgeFacts',
  'vorgangNotes',
  'dunningDocumentations',
  'mailImports',
];

function fail(
  reason: BackupValidateFailureReason,
  errorKey: BackupValidateErrorKey,
): BackupValidationResult {
  return { ok: false, reason, errorKey };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject path traversal, absolute paths, backslashes, empty segments. */
export function isSafeBackupZipPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  if (path.includes('..')) return false;
  if (path !== path.trim()) return false;
  return true;
}

function isAllowedBackupEntryPath(path: string): boolean {
  if (!isSafeBackupZipPath(path)) return false;
  if (path === MANIFEST_PATH || path === APP_STATE_PATH) return true;
  if (!path.startsWith(FILES_PREFIX)) return false;
  const id = path.slice(FILES_PREFIX.length);
  if (!id || id.includes('/')) return false;
  return FILE_REF_ID_PATTERN.test(id);
}

function isValidMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && MIME_PATTERN.test(value);
}

function parseJsonUnknown(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Detect fields that must never be treated as importable restore payload.
 * Does not log values.
 */
export function detectNonImportableBackupAppStateFields(state: unknown): string[] {
  const found: string[] = [];
  if (!isPlainObject(state)) return ['invalid_root'];

  if ('syncOutbox' in state && state.syncOutbox !== undefined) {
    found.push('syncOutbox');
  }
  if ('documentFileBlobs' in state && state.documentFileBlobs !== undefined) {
    found.push('documentFileBlobs');
  }

  const raw = JSON.stringify(state);
  const secretNeedles = [
    'accessToken',
    'refreshToken',
    'Authorization',
    'supabase.auth',
    '"password"',
    'sb-',
  ] as const;
  for (const needle of secretNeedles) {
    if (raw.includes(needle)) {
      found.push('secrets');
      break;
    }
  }

  return found;
}

/**
 * Pure in-memory version gate using existing migrate helpers.
 * Never writes localStorage / IndexedDB / domain stores.
 * Missing syncOutbox (as in export) is tolerated for the version check only.
 */
export function normalizeBackupAppStateVersionReadOnly(
  parsed: unknown,
): AppPersistedState | null {
  if (!isPlainObject(parsed)) return null;
  if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version)) return null;
  if (parsed.version < 1 || parsed.version > STORAGE_VERSION) return null;

  // Export strips syncOutbox; validators for v2+ require an array — view-only pad.
  const forCheck: Record<string, unknown> = {
    ...parsed,
    syncOutbox: Array.isArray(parsed.syncOutbox) ? parsed.syncOutbox : [],
  };
  // Never feed inline blobs into migration.
  delete forCheck.documentFileBlobs;

  try {
    if (isValidPersistedStateV5(forCheck)) {
      return cloneJson(forCheck as unknown as AppPersistedState);
    }
    if (isValidPersistedStateV4(forCheck)) {
      return cloneJson(migratePersistedStateV4ToV5(forCheck as unknown as AppPersistedState));
    }
    if (isValidPersistedStateV3(forCheck)) {
      return cloneJson(
        migratePersistedStateV4ToV5(
          migratePersistedStateV3ToV4(forCheck as unknown as AppPersistedState),
        ),
      );
    }
    if (isValidPersistedStateV2(forCheck)) {
      return cloneJson(
        migratePersistedStateV4ToV5(
          migratePersistedStateV3ToV4(
            migratePersistedStateV2ToV3(forCheck as never),
          ),
        ),
      );
    }
    if (isValidPersistedStateV1(forCheck)) {
      return cloneJson(migratePersistedStateV4ToV5(migratePersistedStateV1ToV2(forCheck as never)));
    }
  } catch {
    return null;
  }
  return null;
}

function buildRecordCountsFromState(state: AppPersistedState): BackupRecordCounts {
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

function parseManifest(raw: unknown): BackupManifest | null {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== BACKUP_SCHEMA_VERSION) return null;
  if (typeof raw.exportedAt !== 'string' || raw.exportedAt.length === 0) return null;
  if (Number.isNaN(Date.parse(raw.exportedAt))) return null;
  if (typeof raw.fileCount !== 'number' || !Number.isInteger(raw.fileCount) || raw.fileCount < 0) {
    return null;
  }
  if (
    typeof raw.totalFileBytes !== 'number' ||
    !Number.isInteger(raw.totalFileBytes) ||
    raw.totalFileBytes < 0
  ) {
    return null;
  }
  if (!isPlainObject(raw.recordCounts)) return null;
  const recordCounts = {} as BackupRecordCounts;
  for (const key of RECORD_COUNT_KEYS) {
    const value = raw.recordCounts[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    recordCounts[key] = value;
  }
  if (!Array.isArray(raw.files)) return null;
  if (raw.files.length !== raw.fileCount) return null;

  const files: BackupFileManifestEntry[] = [];
  const seenIds = new Set<string>();
  let sizeSum = 0;

  for (const entry of raw.files) {
    if (!isPlainObject(entry)) return null;
    if (typeof entry.fileRefId !== 'string' || !FILE_REF_ID_PATTERN.test(entry.fileRefId)) {
      return null;
    }
    if (seenIds.has(entry.fileRefId)) return null;
    seenIds.add(entry.fileRefId);
    if (typeof entry.path !== 'string' || entry.path !== `${FILES_PREFIX}${entry.fileRefId}`) {
      return null;
    }
    if (!isAllowedBackupEntryPath(entry.path)) return null;
    if (!isValidMimeType(entry.mimeType)) return null;
    if (typeof entry.fileSize !== 'number' || !Number.isInteger(entry.fileSize) || entry.fileSize < 0) {
      return null;
    }
    sizeSum += entry.fileSize;
    files.push({
      fileRefId: entry.fileRefId,
      path: entry.path,
      mimeType: entry.mimeType,
      fileSize: entry.fileSize,
      ...(typeof entry.originalFileName === 'string'
        ? { originalFileName: entry.originalFileName }
        : {}),
      ...(typeof entry.contentHash === 'string' ? { contentHash: entry.contentHash } : {}),
    });
  }

  if (sizeSum !== raw.totalFileBytes) return null;

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: raw.exportedAt,
    recordCounts,
    fileCount: raw.fileCount,
    totalFileBytes: raw.totalFileBytes,
    files,
  };
}

function assertFileRefShape(ref: unknown): ref is DocumentFileRef {
  if (!isPlainObject(ref)) return false;
  if (typeof ref.id !== 'string' || !FILE_REF_ID_PATTERN.test(ref.id)) return false;
  if (!isValidMimeType(ref.mimeType)) return false;
  if (typeof ref.fileSize !== 'number' || !Number.isInteger(ref.fileSize) || ref.fileSize < 0) {
    return false;
  }
  return true;
}

function assertBindingShape(binding: unknown): binding is DocumentFileRepresentationBinding {
  if (!isPlainObject(binding)) return false;
  if (typeof binding.documentId !== 'string' || binding.documentId.length === 0) return false;
  if (typeof binding.kind !== 'string' || binding.kind.length === 0) return false;
  if (typeof binding.fileRefId !== 'string' || !FILE_REF_ID_PATTERN.test(binding.fileRefId)) {
    return false;
  }
  return true;
}

/**
 * Validate an OfficePilot backup ZIP in memory. Read-only: no store / storage writes.
 */
export async function validateLocalBackupZip(
  zipInput: Blob | ArrayBuffer | Uint8Array,
): Promise<BackupValidationResult> {
  try {
    const zipBytes =
      zipInput instanceof Blob
        ? new Uint8Array(await zipInput.arrayBuffer())
        : zipInput instanceof ArrayBuffer
          ? new Uint8Array(zipInput)
          : zipInput;

    if (zipBytes.byteLength <= 0) {
      return fail('invalid_zip', 'backup.validate.error.invalid');
    }
    if (zipBytes.byteLength > BACKUP_VALIDATE_LIMITS.maxZipBytes) {
      return fail('too_large', 'backup.validate.error.tooLarge');
    }

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch {
      return fail('invalid_zip', 'backup.validate.error.invalid');
    }

    const pathCounts = new Map<string, number>();
    const filePaths: string[] = [];
    let uncompressedTotal = 0;

    const entries = Object.keys(zip.files);
    for (const name of entries) {
      const entry = zip.files[name];
      if (!entry || entry.dir) {
        // Only allow an empty files/ directory marker if present; nothing else.
        if (entry?.dir && (name === 'files/' || name === 'files')) {
          continue;
        }
        if (entry?.dir) {
          return fail('invalid_structure', 'backup.validate.error.structure');
        }
        continue;
      }

      if (!isSafeBackupZipPath(name) || !isAllowedBackupEntryPath(name)) {
        return fail('invalid_structure', 'backup.validate.error.structure');
      }

      pathCounts.set(name, (pathCounts.get(name) ?? 0) + 1);
      if ((pathCounts.get(name) ?? 0) > 1) {
        return fail('invalid_structure', 'backup.validate.error.structure');
      }

      // JSZip may not expose uncompressed size until async read; accumulate after read.
      filePaths.push(name);
    }

    if (!pathCounts.has(MANIFEST_PATH) || !pathCounts.has(APP_STATE_PATH)) {
      return fail('invalid_structure', 'backup.validate.error.structure');
    }

    // Reject duplicate logical paths already handled; ensure no unexpected extras beyond files/*
    for (const name of filePaths) {
      if (name === MANIFEST_PATH || name === APP_STATE_PATH || name.startsWith(FILES_PREFIX)) {
        continue;
      }
      return fail('invalid_structure', 'backup.validate.error.structure');
    }

    const manifestText = await zip.file(MANIFEST_PATH)!.async('string');
    const appStateText = await zip.file(APP_STATE_PATH)!.async('string');
    uncompressedTotal += new TextEncoder().encode(manifestText).byteLength;
    uncompressedTotal += new TextEncoder().encode(appStateText).byteLength;

    if (uncompressedTotal > BACKUP_VALIDATE_LIMITS.maxUncompressedBytes) {
      return fail('limit_exceeded', 'backup.validate.error.limits');
    }

    const manifestRaw = parseJsonUnknown(manifestText);
    if (manifestRaw === undefined) {
      return fail('invalid_manifest', 'backup.validate.error.manifest');
    }

    if (isPlainObject(manifestRaw) && typeof manifestRaw.schemaVersion === 'number') {
      if (
        !Number.isInteger(manifestRaw.schemaVersion) ||
        manifestRaw.schemaVersion < 1 ||
        manifestRaw.schemaVersion > BACKUP_SCHEMA_VERSION
      ) {
        return fail('unsupported_schema', 'backup.validate.error.schema');
      }
    }

    const manifest = parseManifest(manifestRaw);
    if (!manifest) {
      // Distinguish unknown schema already handled; otherwise generic manifest error
      if (
        isPlainObject(manifestRaw) &&
        typeof manifestRaw.schemaVersion === 'number' &&
        manifestRaw.schemaVersion !== BACKUP_SCHEMA_VERSION
      ) {
        return fail('unsupported_schema', 'backup.validate.error.schema');
      }
      return fail('invalid_manifest', 'backup.validate.error.manifest');
    }

    if (manifest.fileCount > BACKUP_VALIDATE_LIMITS.maxFileCount) {
      return fail('limit_exceeded', 'backup.validate.error.limits');
    }
    if (manifest.totalFileBytes > BACKUP_VALIDATE_LIMITS.maxUncompressedBytes) {
      return fail('limit_exceeded', 'backup.validate.error.limits');
    }

    const appStateRaw = parseJsonUnknown(appStateText);
    if (appStateRaw === undefined) {
      return fail('invalid_app_state', 'backup.validate.error.appState');
    }

    const nonImportable = detectNonImportableBackupAppStateFields(appStateRaw);
    if (nonImportable.includes('secrets') || nonImportable.includes('invalid_root')) {
      return fail('non_importable_fields', 'backup.validate.error.nonImportable');
    }
    if (nonImportable.includes('syncOutbox') || nonImportable.includes('documentFileBlobs')) {
      return fail('non_importable_fields', 'backup.validate.error.nonImportable');
    }

    const appStateCloned = cloneJson(appStateRaw);
    const normalized = normalizeBackupAppStateVersionReadOnly(appStateCloned);
    if (!normalized) {
      return fail('invalid_app_state', 'backup.validate.error.appState');
    }

    const expectedCounts = buildRecordCountsFromState(normalized);
    for (const key of RECORD_COUNT_KEYS) {
      if (manifest.recordCounts[key] !== expectedCounts[key]) {
        return fail('invalid_manifest', 'backup.validate.error.manifest');
      }
    }

    const refs = normalized.documentFileRefs ?? [];
    const bindings = normalized.documentFileRepresentationBindings ?? [];
    for (const ref of refs) {
      if (!assertFileRefShape(ref)) {
        return fail('ref_mismatch', 'backup.validate.error.refs');
      }
    }
    for (const binding of bindings) {
      if (!assertBindingShape(binding)) {
        return fail('ref_mismatch', 'backup.validate.error.refs');
      }
    }

    const refsById = new Map(refs.map((r) => [r.id, r]));
    if (refsById.size !== refs.length) {
      return fail('ref_mismatch', 'backup.validate.error.refs');
    }

    for (const binding of bindings) {
      if (!refsById.has(binding.fileRefId)) {
        return fail('ref_mismatch', 'backup.validate.error.refs');
      }
    }

    // Every documentFileRef must have a blob entry in the ZIP / manifest.
    const manifestById = new Map(manifest.files.map((f) => [f.fileRefId, f]));
    if (manifestById.size !== manifest.files.length) {
      return fail('invalid_manifest', 'backup.validate.error.manifest');
    }

    for (const ref of refs) {
      if (!manifestById.has(ref.id)) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
    }

    // Manifest files must match ZIP blobs and FileRef metadata; no extras.
    const zipFileIds = new Set<string>();
    for (const name of filePaths) {
      if (!name.startsWith(FILES_PREFIX)) continue;
      const id = name.slice(FILES_PREFIX.length);
      zipFileIds.add(id);
    }

    if (zipFileIds.size !== manifest.fileCount) {
      return fail('blob_mismatch', 'backup.validate.error.blobs');
    }

    let blobBytesSum = 0;
    for (const entry of manifest.files) {
      if (!zipFileIds.has(entry.fileRefId)) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
      const zipEntry = zip.file(entry.path);
      if (!zipEntry) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
      const bytes = await zipEntry.async('uint8array');
      blobBytesSum += bytes.byteLength;
      uncompressedTotal += bytes.byteLength;

      if (uncompressedTotal > BACKUP_VALIDATE_LIMITS.maxUncompressedBytes) {
        return fail('limit_exceeded', 'backup.validate.error.limits');
      }

      if (bytes.byteLength !== entry.fileSize) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }

      const ref = refsById.get(entry.fileRefId);
      if (!ref) {
        // Extra manifest blob not in refs — only allowed if we require 1:1 with refs
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
      if (ref.mimeType !== entry.mimeType) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
      if (ref.fileSize !== entry.fileSize) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
    }

    // No extra ZIP blobs beyond manifest
    for (const id of zipFileIds) {
      if (!manifestById.has(id)) {
        return fail('blob_mismatch', 'backup.validate.error.blobs');
      }
    }

    if (blobBytesSum !== manifest.totalFileBytes) {
      return fail('blob_mismatch', 'backup.validate.error.blobs');
    }

    const ratio =
      zipBytes.byteLength > 0 ? uncompressedTotal / zipBytes.byteLength : Number.POSITIVE_INFINITY;
    if (ratio > BACKUP_VALIDATE_LIMITS.maxCompressionRatio && uncompressedTotal > 10 * 1024 * 1024) {
      return fail('limit_exceeded', 'backup.validate.error.limits');
    }

    const preview: BackupValidationPreview = {
      exportedAt: manifest.exportedAt,
      schemaVersion: manifest.schemaVersion,
      recordCounts: cloneJson(manifest.recordCounts),
      fileCount: manifest.fileCount,
      totalFileBytes: manifest.totalFileBytes,
    };

    return {
      ok: true,
      preview,
      manifest: cloneJson(manifest),
      zipBytes: new Uint8Array(zipBytes),
      appState: cloneJson(normalized),
    };
  } catch {
    return fail('invalid_zip', 'backup.validate.error.invalid');
  }
}

/** Convenience: validate a user-selected File (must be invoked after explicit pick). */
export async function validateLocalBackupFile(file: File): Promise<BackupValidationResult> {
  if (!(file instanceof Blob) || file.size <= 0) {
    return fail('invalid_zip', 'backup.validate.error.invalid');
  }
  if (file.size > BACKUP_VALIDATE_LIMITS.maxZipBytes) {
    return fail('too_large', 'backup.validate.error.tooLarge');
  }
  return validateLocalBackupZip(file);
}
