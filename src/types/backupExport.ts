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
  /**
   * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Rechnungen zählen eigenständig.
   *
   * Optional, weil Sicherungen aus der Zeit davor den Abschnitt nicht kennen.
   * Ohne ihn meldete eine Sicherung „0 Rechnungen", obwohl sie welche enthält.
   */
  invoiceEntries?: number;
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

/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.23 „Vollständige Zählung“, D-03.2) — die fachlichen Bereiche in der Reihenfolge der
 * Liste 1.23. Dieselbe Zählung steht vor dem Download und im Manifest (`areaCounts`).
 */
export const BACKUP_AREA_KEYS = [
  'customers',
  'vorgaenge',
  'offers',
  'invoices',
  'payments',
  'expenses',
  'documents',
  'files',
  'letters',
  'emails',
  'tasks',
  'knowledge',
  'bankTransactions',
  'employees',
  'employeePayments',
  'accountingAssignments',
  'settings',
] as const;

export type BackupAreaKey = (typeof BACKUP_AREA_KEYS)[number];

export type BackupAreaCounts = Record<BackupAreaKey, number>;

/**
 * EINRICHTUNG-01 (S-13) — eine Datei, die beim Erstellen fehlte und auf
 * ausdrücklichen Wunsch weggelassen wurde. Nur Kennung und Anzeigename,
 * nie Inhalt oder Pfad.
 */
export interface BackupMissingFileEntry {
  fileRefId: string;
  originalFileName?: string;
}

export interface BackupManifest {
  schemaVersion: number;
  exportedAt: string;
  recordCounts: BackupRecordCounts;
  fileCount: number;
  totalFileBytes: number;
  files: BackupFileManifestEntry[];
  /**
   * EINRICHTUNG-01 (AP7; 1.23) — Zählung je Bereich. Optional, weil ältere Sicherungen sie nicht tragen; ist sie
   * vorhanden, prüft das Einspielen sie gegen den enthaltenen Bestand.
   */
  areaCounts?: BackupAreaCounts;
  /**
   * EINRICHTUNG-01 (S-13) — Teilsicherung: gesetzt nur, wenn Dateien mit
   * Zustimmung weggelassen wurden. Die Prüfung beim Einspielen zeigt die Lücke.
   */
  incomplete?: true;
  missingFiles?: BackupMissingFileEntry[];
}

export type BackupExportFailureReason =
  | 'missing_blob'
  | 'build_failed'
  | 'download_failed'
  | 'contains_credentials';

export type BackupExportResult =
  | {
      ok: true;
      filename: string;
      blob: Blob;
      manifest: BackupManifest;
      /** EINRICHTUNG-01 (S-13) — Teilsicherung mit Zustimmung. */
      incomplete?: boolean;
      objectUrl?: string;
      revokeObjectUrl?: () => void;
    }
  | {
      ok: false;
      reason: BackupExportFailureReason;
      /** Safe, non-sensitive user-facing message key or short code. */
      errorKey: string;
      /** EINRICHTUNG-01 (S-13) — welche Dateien fehlen (nur Kennung/Anzeigename). */
      missingFiles?: BackupMissingFileEntry[];
      /** EINRICHTUNG-01 (S-11.4) — Fundstellen von Zugangsdaten, nie deren Werte. */
      credentialPaths?: string[];
    };
