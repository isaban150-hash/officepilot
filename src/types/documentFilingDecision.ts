import type { DocumentAreaId } from './documentArea';
import type { DigitalFolder, PaperFilingRule } from './models';

export const DOCUMENT_FILING_SCOPES = ['customer', 'company'] as const;

export type DocumentFilingScope = (typeof DOCUMENT_FILING_SCOPES)[number];

export const DOCUMENT_FILING_DECISION_STATUSES = ['proposed', 'confirmed'] as const;

export type DocumentFilingDecisionStatus =
  (typeof DOCUMENT_FILING_DECISION_STATUSES)[number];

export const DOCUMENT_FILING_SPECIALTIES = ['hotel_travel'] as const;

export type DocumentFilingSpecialty = (typeof DOCUMENT_FILING_SPECIALTIES)[number];

/**
 * Confirm-first Ablageentscheidung (Kunde vs. Unternehmen).
 * Persistiert optional auf InboxItem; keine zweite Filing-Architektur.
 */
export interface DocumentFilingDecisionRecord {
  readonly status: DocumentFilingDecisionStatus;
  readonly scope: DocumentFilingScope;
  readonly customerLabel?: string;
  readonly projectLabel?: string;
  readonly companyAreaId?: DocumentAreaId;
  /** Display-only specialty (no new ClassifiedDocumentKind). */
  readonly specialty?: DocumentFilingSpecialty;
  readonly documentKindLabelKey?: string;
  readonly companyAreaLabelKey?: string;
  readonly digitalPath: string;
  readonly digitalFolderName: string;
  readonly paperFolderId?: string;
  readonly paperRegister?: string;
  readonly paperLabel?: string;
  readonly skipPhysicalFiling: boolean;
  readonly confirmedAt?: string;
}

/** Editable proposal / draft used by UI before confirm. */
export interface DocumentFilingDecisionDraft {
  readonly scope: DocumentFilingScope;
  readonly customerLabel: string;
  readonly projectLabel: string;
  readonly companyAreaId: DocumentAreaId;
  readonly specialty: DocumentFilingSpecialty | null;
  readonly documentKindLabelKey: string;
  readonly companyAreaLabelKey: string;
  readonly digitalFolder: DigitalFolder;
  readonly paperFiling: PaperFilingRule | null;
  readonly skipPhysicalFiling: boolean;
  readonly status: DocumentFilingDecisionStatus;
}
