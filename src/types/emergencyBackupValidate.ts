/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02O — Typen des Notfall-ZIP-Formats.
 *
 * Bewusst vollständig getrennt vom regulären Backupformat
 * (`manifest.json` + `app-state.json` + `files/<fileRefId>`). Beide Formate
 * dürfen sich nie stillschweigend vermischen: das Notfallformat enthält den
 * unveränderten Rohzustand samt Outbox, das reguläre Format nicht.
 */
import type { AppPersistedState } from './models';
import type { DocumentFileLifecycleStatus } from './documentFileRef';

export const EMERGENCY_BACKUP_KIND = 'officepilot-local-recovery-emergency' as const;
export const EMERGENCY_BACKUP_SUPPORTED_FORMAT_VERSION = 1 as const;

export const EMERGENCY_ZIP_RAW_STATE_PATH = 'raw-state.json' as const;
export const EMERGENCY_ZIP_MANIFEST_PATH = 'files-manifest.json' as const;
export const EMERGENCY_ZIP_README_PATH = 'README.txt' as const;
export const EMERGENCY_ZIP_FILES_PREFIX = 'files/' as const;

/** Statuswerte, wie sie der Export schreibt. Nur `found` ist importfähig. */
export type EmergencyBackupEntryStatus =
  | 'found'
  | 'missing'
  | 'read_error'
  | 'invalid_ref'
  | 'embedded_in_raw_state'
  | 'duplicate_ref';

export interface EmergencyBackupManifestEntryV1 {
  fileRefId?: string;
  storageType?: string;
  mimeType?: string;
  expectedFileSize?: number;
  expectedContentHash?: string;
  recordFileSize?: number;
  recordContentHash?: string;
  recordCreatedAt?: string;
  path?: string;
  status: EmergencyBackupEntryStatus;
  mismatches?: string[];
  duplicateOf?: string;
  errorMessage?: string;
}

export interface EmergencyBackupManifestV1 {
  formatVersion: number;
  kind: typeof EMERGENCY_BACKUP_KIND;
  exportedAt: string;
  origin: string;
  storageKey: string;
  scopeKey: string;
  entries: EmergencyBackupManifestEntryV1[];
  summary: {
    refs: number;
    found: number;
    missing: number;
    readError: number;
    invalid: number;
  };
}

export type EmergencyBackupValidationErrorCode =
  // Struktur
  | 'invalid_zip'
  | 'too_large'
  | 'limit_exceeded'
  | 'unsafe_path'
  | 'duplicate_zip_path'
  | 'missing_raw_state'
  | 'missing_manifest'
  | 'unknown_top_level_file'
  | 'unknown_binary_file'
  | 'missing_binary_file'
  // Manifest
  | 'invalid_manifest'
  | 'wrong_kind'
  | 'unsupported_format_version'
  | 'duplicate_manifest_path'
  | 'duplicate_manifest_file_ref_id'
  | 'manifest_entry_not_found'
  | 'manifest_entry_without_file_ref'
  | 'invalid_content_hash_format'
  // Rohzustand
  | 'invalid_raw_state'
  | 'invalid_raw_state_encoding'
  | 'unsupported_state_version'
  | 'missing_setup'
  | 'invalid_setup'
  | 'missing_company_profile'
  | 'invalid_company_profile'
  | 'invalid_inbox_item'
  | 'invalid_document_work_result'
  | 'invalid_document_file_ref'
  | 'duplicate_file_ref_id'
  | 'duplicate_local_data_key'
  | 'file_ref_without_manifest_entry'
  // Identität und Inhalt
  | 'unsupported_scope'
  | 'workspace_id_mismatch'
  | 'missing_workspace_identity'
  | 'file_size_mismatch'
  | 'content_hash_mismatch'
  | 'mime_type_mismatch'
  | 'storage_type_mismatch';

export interface EmergencyBackupValidationError {
  code: EmergencyBackupValidationErrorCode;
  /** Neutraler Hinweis für die Anzeige — niemals Dateiinhalte. */
  detail?: string;
  fileRefId?: string;
  path?: string;
}

export type EmergencyBackupValidationWarningCode =
  | 'expired_temp_file'
  | 'uncommitted_file'
  | 'trashed_file'
  | 'legacy_local_data_url_file'
  | 'manifest_reported_mismatch';

export interface EmergencyBackupValidationWarning {
  code: EmergencyBackupValidationWarningCode;
  fileRefId?: string;
  detail?: string;
}

/** Eine tatsächlich gelesene und nachgerechnete Binärdatei. */
export interface ValidatedEmergencyBackupFile {
  fileRefId: string;
  localDataKey: string;
  path: string;
  mimeType: string;
  fileSize: number;
  /** Tatsächlich über die Bytes berechnet, nicht aus dem Manifest übernommen. */
  sha256: string;
  storageType: string;
  originalFileName: string;
  createdAt: string;
  lifecycleStatus: DocumentFileLifecycleStatus;
  committedAt?: string;
  expiresAt?: string;
  /** Bezogen auf den injizierten Prüfzeitpunkt. */
  expired: boolean;
}

export interface EmergencyBackupOutboxSummary {
  total: number;
  byStatus: Record<string, number>;
  byEntityType: Record<string, number>;
}

export interface EmergencyBackupRecordCounts {
  inboxItems: number;
  vorgaenge: number;
  tasks: number;
  documents: number;
  expenses: number;
  documentFileRefs: number;
  documentWorkResults: number;
}

export interface ValidatedEmergencyBackupBundle {
  /** Unveränderter Text aus raw-state.json. */
  sourceRawText: string;
  /** SHA-256 über die unveränderten Bytes von raw-state.json. */
  sourceRawTextSha256: string;
  /** Rein lesend normalisierter Zustand — noch nicht bereinigt. */
  appState: AppPersistedState;
  workspaceId: string;
  setupCompanyName: string;
  profileCompanyName: string;
  savedAt?: string;
  origin: string;
  storageKey: string;
  scopeKey: string;
  manifest: EmergencyBackupManifestV1;
  files: ValidatedEmergencyBackupFile[];
  recordCounts: EmergencyBackupRecordCounts;
  outboxSummary: EmergencyBackupOutboxSummary;
  warnings: EmergencyBackupValidationWarning[];
  /** True, sobald eine Datei nicht endgültig übernommen ist. */
  requiresLifecycleDecision: boolean;
  /**
   * Immer true: die enthaltene Outbox stammt aus einer alten Sitzung und darf
   * vor einer Wiederherstellung niemals übernommen werden. Dieser Sprint
   * bereinigt bewusst nichts — er weist nur aus.
   */
  outboxMustBeDiscardedBeforeRestore: true;
}

export type EmergencyBackupValidationResult =
  | { ok: true; bundle: ValidatedEmergencyBackupBundle }
  | { ok: false; errors: EmergencyBackupValidationError[] };

export interface EmergencyBackupValidationOptions {
  /** Injizierbarer Prüfzeitpunkt für die Lifecycle-Bewertung. */
  now?: string;
}
