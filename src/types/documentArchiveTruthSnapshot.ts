/**
 * ARCHIVE-TRUTH-DURABILITY-01 — durable archive truth frozen at import time.
 * Stored on CompanyDocument; not a second DWR store or Truth engine.
 */
import type { BusinessInterpretationResult } from './businessInterpretation';
import type { DocumentAreaId } from './documentArea';
import type {
  DocumentFilingScope,
  DocumentFilingSpecialty,
} from './documentFilingDecision';
import type {
  DocumentWorkResultOverlayEntry,
  DocumentWorkResultSpecialistRefs,
} from './documentWorkResult';

export const DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Confirmed filing decision audit metadata that would otherwise live only on InboxItem.
 * Digital/paper folder paths remain on CompanyDocument fields.
 */
export type DocumentArchiveTruthFilingAudit = {
  readonly status: 'confirmed';
  readonly scope: DocumentFilingScope;
  readonly specialty?: DocumentFilingSpecialty;
  readonly customerLabel?: string;
  readonly projectLabel?: string;
  readonly companyAreaId?: DocumentAreaId;
  readonly documentKindLabelKey?: string;
  readonly companyAreaLabelKey?: string;
  readonly confirmedAt?: string;
};

/**
 * Immutable archive truth payload. Project back to TruthView via DWR resolver.
 * Contains durable BI + overlay + provenance metadata — no UI/session state.
 */
export type DocumentArchiveTruthSnapshot = {
  readonly schemaVersion: typeof DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION;
  readonly workspaceId?: string | null;
  /** Snapshot creation time (archive import). */
  readonly createdAt: string;
  readonly sourceInboxItemId: string;
  readonly analyzedAt: string;
  readonly analysisVersion: string;
  readonly sourceFingerprint: string;
  readonly businessInterpretation: BusinessInterpretationResult | null;
  readonly specialistRefs: DocumentWorkResultSpecialistRefs;
  readonly overlay: DocumentWorkResultOverlayEntry[];
  readonly filingDecision?: DocumentArchiveTruthFilingAudit;
};
