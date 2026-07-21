/** Local backup full-replace restore (PILOT-BACKUP-RESTORE-APPLY-01). */

import type { ValidatedBackupBundle } from './backupValidate';
import type { AppPersistedState } from './models';
import type { BackupManifest } from './backupExport';

export type BackupRestorePhase =
  | 'safety_backup'
  | 'stage_blobs'
  | 'verify_staged'
  | 'prepare_state'
  | 'promote_blobs'
  | 'commit_state'
  | 'verify_restored'
  | 'cleanup_old'
  | 'cleanup_staging'
  | 'rollback'
  | 'reload';

export type BackupRestoreFailureReason =
  | 'not_validated'
  | 'not_confirmed'
  | 'safety_failed'
  | 'stage_failed'
  | 'verify_staged_failed'
  | 'prepare_failed'
  | 'promote_failed'
  | 'commit_failed'
  | 'verify_failed'
  | 'rollback_failed'
  | 'failed';

export type BackupRestoreErrorKey =
  | 'backup.restore.error.notValidated'
  | 'backup.restore.error.notConfirmed'
  | 'backup.restore.error.safety'
  | 'backup.restore.error.stage'
  | 'backup.restore.error.commit'
  | 'backup.restore.error.verify'
  | 'backup.restore.error.rollback'
  | 'backup.restore.error.failed';

export type BackupRestorePhaseKey =
  | 'backup.restore.phase.safety'
  | 'backup.restore.phase.stage'
  | 'backup.restore.phase.commit'
  | 'backup.restore.phase.verify'
  | 'backup.restore.phase.rollback';

export type BackupRestoreResult =
  | {
      ok: true;
      reloaded: boolean;
    }
  | {
      ok: false;
      reason: BackupRestoreFailureReason;
      errorKey: BackupRestoreErrorKey;
      /** True when live data was rolled back from the safety backup. */
      rolledBack?: boolean;
      /** True when rollback itself failed after a commit attempt. */
      rollbackFailed?: boolean;
    };

export interface BackupRestoreInput {
  /** Must be a successful result from backupValidateService. */
  validated: ValidatedBackupBundle | BackupValidationResultLike;
  /** Explicit user confirmation required. */
  confirmed: boolean;
  /** When false, skip window reload (tests). Default true. */
  reload?: boolean;
}

/** Structural check without importing circular validation internals. */
export type BackupValidationResultLike =
  | ValidatedBackupBundle
  | { ok: false; reason: string; errorKey: string };

export interface BackupRestoreDeps {
  onPhase?: (phase: BackupRestorePhase) => void;
  /** Test hook: throw/fail after completing this phase name (before next). */
  failAfterPhase?: BackupRestorePhase;
  reload?: () => void;
}

export interface SafetyBackupArtifacts {
  zipBytes: Uint8Array;
  manifest: BackupManifest;
  appState: AppPersistedState;
  validated: ValidatedBackupBundle;
}
