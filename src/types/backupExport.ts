/** Local OfficePilot backup export (PILOT-BACKUP-EXPORT-01). */

export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupFileManifestEntry {
  fileRefId: string;
  path: string;
  mimeType: string;
  fileSize: number;
  originalFileName?: string;
  contentHash?: string;
}

export interface BackupRecordCounts {
  inboxItems: number;
  vorgaenge: number;
  tasks: number;
  documents: number;
  expenses: number;
  uploadedDocuments: number;
  documentFileRefs: number;
  documentFileRepresentationBindings: number;
  communicationHistory: number;
  knowledgeFacts: number;
  vorgangNotes: number;
  dunningDocumentations: number;
  mailImports: number;
}

export interface BackupManifest {
  schemaVersion: number;
  exportedAt: string;
  recordCounts: BackupRecordCounts;
  fileCount: number;
  totalFileBytes: number;
  files: BackupFileManifestEntry[];
}

export type BackupExportFailureReason =
  | 'missing_blob'
  | 'build_failed'
  | 'download_failed';

export type BackupExportResult =
  | {
      ok: true;
      filename: string;
      blob: Blob;
      manifest: BackupManifest;
      objectUrl?: string;
      revokeObjectUrl?: () => void;
    }
  | {
      ok: false;
      reason: BackupExportFailureReason;
      /** Safe, non-sensitive user-facing message key or short code. */
      errorKey: string;
    };
