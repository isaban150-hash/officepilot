/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P2 — Typen für Zielsicherung und
 * lokale Quarantäne.
 *
 * Die Quarantäne ist bewusst KEIN StorageScope. Sie besitzt eigene Schlüssel,
 * einen eigenen Blob-Namensraum und eine eigene, eng begrenzte API. Damit kann
 * sie weder als aktiver App-Bereich gesetzt werden noch in eine der
 * bestehenden Fallback-/Kopierketten geraten.
 */
import type { ValidatedEmergencyBackupBundle } from './emergencyBackupValidate';

export const QUARANTINE_KIND = 'officepilot-emergency-quarantine' as const;
export const QUARANTINE_FORMAT_VERSION = 1 as const;

/** Zentrale Schlüsselbildung — nirgends sonst zusammensetzen. */
export const QUARANTINE_MARKER_PREFIX = 'officepilot-emergency-quarantine-marker:' as const;
export const QUARANTINE_STATE_PREFIX = 'officepilot-emergency-quarantine-state:' as const;

export function buildQuarantineMarkerKey(token: string): string {
  return `${QUARANTINE_MARKER_PREFIX}${token}`;
}

export function buildQuarantineStateKey(token: string): string {
  return `${QUARANTINE_STATE_PREFIX}${token}`;
}

export type QuarantineStatus = 'staging' | 'complete';

export interface QuarantineFileEntry {
  fileRefId: string;
  /** Getrennt vom fileRefId erhalten — beide werden später gebraucht. */
  localDataKey: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
}

/**
 * Vergleichswerte des Zielbereichs. 02Q muss genau diese vor einer späteren
 * Ersetzung erneut prüfen.
 */
export interface TargetScopeSnapshot {
  rawTextSha256: string;
  files: { fileRefId: string; fileSize: number; sha256: string }[];
}

export interface QuarantineMarker {
  kind: typeof QUARANTINE_KIND;
  formatVersion: typeof QUARANTINE_FORMAT_VERSION;
  token: string;
  status: QuarantineStatus;
  sourceStorageKey: string;
  sourceScopeKey: string;
  workspaceId: string;
  archiveSha256: string;
  sourceRawTextSha256: string;
  files: QuarantineFileEntry[];
  createdAt: string;
  completedAt?: string;
  /** Nur im complete-Marker: Prüfgrundlage für 02Q. */
  targetSnapshot?: TargetScopeSnapshot;
}

export interface QuarantineStateEnvelope {
  kind: typeof QUARANTINE_KIND;
  formatVersion: typeof QUARANTINE_FORMAT_VERSION;
  token: string;
  sourceStorageKey: string;
  sourceScopeKey: string;
  workspaceId: string;
  savedAt?: string;
  /** Unveränderter Ziel-Rohtext. */
  rawText: string;
  archiveSha256: string;
  sourceRawTextSha256: string;
  files: QuarantineFileEntry[];
  quarantinedAt: string;
}

/** Vorbereitete, noch nicht durch erneute Dateiauswahl bestätigte Sitzung. */
export interface PreparedTargetBackupSession {
  sourceStorageKey: string;
  sourceScopeKey: string;
  workspaceId: string;
  zipBlob: Blob;
  archiveSha256: string;
  sourceRawTextSha256: string;
  files: QuarantineFileEntry[];
  bundle: ValidatedEmergencyBackupBundle;
  targetSnapshot: TargetScopeSnapshot;
  suggestedFilename: string;
}

/** Erst nach vollständigem Gleichheitsbeweis der erneut gewählten Datei. */
export interface VerifiedTargetBackupSession extends PreparedTargetBackupSession {
  /** Bündel der ERNEUT ausgewählten Datei — nur dessen Bytes werden geschrieben. */
  reselectedBundle: ValidatedEmergencyBackupBundle;
}

export type PrepareTargetBackupFailure =
  | 'unsupported_target_key'
  | 'target_missing'
  | 'backup_build_failed'
  | 'backup_invalid'
  /** Der Zielbereich hat sich waehrend der Vorbereitung veraendert. */
  | 'target_changed';

/** Beobachtungspunkte der Vorbereitung — Testhaken, keine Diagnoseinstrumentierung. */
export type PrepareStage = 'snapshot_before' | 'zip_built' | 'validated' | 'snapshot_after';

export interface PrepareTargetBackupDeps {
  onStage?: (stage: PrepareStage) => void;
}

export type PrepareTargetBackupResult =
  | { ok: true; session: PreparedTargetBackupSession }
  | { ok: false; reason: PrepareTargetBackupFailure; detail?: string; errors?: string[] };

export type VerifyReselectedFailure =
  | 'unknown_session'
  | 'invalid_backup'
  | 'archive_hash_mismatch'
  | 'raw_state_hash_mismatch'
  | 'identity_mismatch'
  | 'file_set_mismatch';

export type VerifyReselectedResult =
  | { ok: true; session: VerifiedTargetBackupSession }
  | { ok: false; reason: VerifyReselectedFailure; detail?: string };

export type QuarantineFailure =
  | 'unknown_session'
  | 'insecure_random'
  | 'staging_exists'
  | 'target_changed'
  | 'blob_write_failed'
  | 'blob_verify_failed'
  | 'envelope_failed'
  | 'marker_failed'
  | 'token_collision';

export interface QuarantineSuccess {
  ok: true;
  token: string;
  markerKey: string;
  stateKey: string;
  quarantineScopeKey: string;
  marker: QuarantineMarker;
}

export interface QuarantineFailureResult {
  ok: false;
  reason: QuarantineFailure;
  detail?: string;
  /** Gesetzt, sobald ein staging-Marker geschrieben wurde. */
  token?: string;
  /** True, wenn eigene Daten dieses Vorgangs entfernt wurden. */
  cleanedUp?: boolean;
  /** Bei staging_exists: der bereits vorhandene fremde Vorgang. */
  existingToken?: string;
}

export type QuarantineResult = QuarantineSuccess | QuarantineFailureResult;

/** Ausdrückliche Bereinigung — niemals automatisch. */
export type CleanupQuarantineResult =
  | { ok: true; token: string; deletedBlobs: number }
  | {
      ok: false;
      reason: 'not_found' | 'not_staging' | 'blob_delete_failed' | 'marker_delete_failed';
      detail?: string;
    };

/**
 * Phasen für gezielte Fehlerinjektion im Test — dasselbe Muster wie
 * `BackupRestoreDeps.failAfterPhase`. Produktionscode bleibt frei von
 * Diagnoseinstrumentierung.
 */
export type QuarantinePhase =
  | 'staging_marker'
  | 'write_blob'
  | 'read_back_blob'
  | 'write_envelope'
  | 'read_back_envelope'
  | 'recheck_target'
  | 'final_verify'
  | 'complete_marker'
  | 'verify_complete_marker';

export interface QuarantineDeps {
  onPhase?: (phase: QuarantinePhase, index?: number) => void;
  /** Wirft nach der genannten Phase; `failAtIndex` grenzt die Datei ein. */
  failAtPhase?: QuarantinePhase;
  failAtIndex?: number;
  /**
   * Simuliert einen harten Tababbruch: es wird nichts bereinigt, damit der
   * staging-Marker und die bereits geschriebenen Daten erhalten bleiben.
   */
  simulateHardAbort?: boolean;
  now?: string;
}
