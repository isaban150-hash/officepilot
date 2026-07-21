/** Local backup restore validation (PILOT-BACKUP-RESTORE-VALIDATE-01). */

import type { BackupManifest, BackupRecordCounts } from './backupExport';
import { BACKUP_SCHEMA_VERSION } from './backupExport';

export { BACKUP_SCHEMA_VERSION };

/** Hard limits to reject zip-bomb-like or oversized bundles. */
export const BACKUP_VALIDATE_LIMITS = {
  /** Max compressed ZIP size accepted for validation. */
  maxZipBytes: 200 * 1024 * 1024,
  /** Max sum of uncompressed entry sizes. */
  maxUncompressedBytes: 500 * 1024 * 1024,
  /** Max number of file blob entries under files/. */
  maxFileCount: 5_000,
  /** Max uncompressed/compressed ratio (zip bomb heuristic). */
  maxCompressionRatio: 100,
} as const;

export type BackupValidateFailureReason =
  | 'too_large'
  | 'invalid_zip'
  | 'invalid_structure'
  | 'invalid_manifest'
  | 'unsupported_schema'
  | 'invalid_app_state'
  | 'non_importable_fields'
  | 'blob_mismatch'
  | 'ref_mismatch'
  | 'limit_exceeded';

/** Safe i18n keys only — never embed paths, ids, or raw errors. */
export type BackupValidateErrorKey =
  | 'backup.validate.error.invalid'
  | 'backup.validate.error.tooLarge'
  | 'backup.validate.error.structure'
  | 'backup.validate.error.manifest'
  | 'backup.validate.error.schema'
  | 'backup.validate.error.appState'
  | 'backup.validate.error.nonImportable'
  | 'backup.validate.error.blobs'
  | 'backup.validate.error.refs'
  | 'backup.validate.error.limits';

export interface BackupValidationPreview {
  exportedAt: string;
  schemaVersion: number;
  recordCounts: BackupRecordCounts;
  fileCount: number;
  totalFileBytes: number;
  /** Human-oriented total size label is left to UI; raw bytes provided. */
}

export type BackupValidationResult =
  | {
      ok: true;
      preview: BackupValidationPreview;
      /** Validated, defensively cloned manifest. */
      manifest: BackupManifest;
      /**
       * Sealed restore payload produced only by backupValidateService.
       * Restore must accept this object — never re-parse with weaker rules.
       */
      zipBytes: Uint8Array;
      /** Normalized, defensively cloned app state from the validated ZIP. */
      appState: import('./models').AppPersistedState;
    }
  | {
      ok: false;
      reason: BackupValidateFailureReason;
      errorKey: BackupValidateErrorKey;
    };

export type ValidatedBackupBundle = Extract<BackupValidationResult, { ok: true }>;

