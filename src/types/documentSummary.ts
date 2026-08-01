/**
 * DOCUMENT-SUMMARY — presentation SSOT between document pipeline and UI.
 * No domain payloads, no OCR, no Proposal/LV objects.
 */
import type { TranslationKey } from '../i18n';
import type { DocumentCaseMatch } from './documentCaseMatch';
import type { ClassifiedDocumentKind } from './models';

export type DocumentSummaryFamily =
  | 'invoice_in'
  | 'invoice_out'
  | 'tank'
  | 'delivery'
  | 'authority'
  | 'letter'
  | 'offer'
  | 'contract'
  | 'generic';

export type DocumentSummaryWorkspaceType =
  | 'none'
  | 'contract_order'
  | 'assist'
  | 'generic';

export type DocumentSummaryActionId =
  | 'accept_contract_order'
  | 'contract_inquiry'
  | 'reject_contract_proposal'
  | 'apply_intake'
  | 'record_expense'
  | 'create_vorgang'
  | 'create_task'
  | 'link_vorgang'
  | 'open_vorgang'
  | 'select_vorgang'
  | 'review_document'
  | 'later';

export type DocumentSummaryFact = {
  id: string;
  /** Prefer labelKey; label allowed when already resolved (rare). */
  labelKey?: TranslationKey;
  label?: string;
  value: string;
};

export type DocumentSummaryAlert = {
  id: string;
  severity: 'info' | 'review' | 'critical';
  labelKey?: TranslationKey;
  label?: string;
  labelParams?: Record<string, string | number>;
};

export type DocumentSummaryActionRef = {
  id: DocumentSummaryActionId;
  labelKey: TranslationKey;
  enabled: boolean;
  disabledReasonKey?: TranslationKey;
};

export type DocumentSummaryDetailSection = {
  id: string;
  titleKey: TranslationKey;
  rows?: DocumentSummaryFact[];
  proseKey?: TranslationKey;
  proseParams?: Record<string, string | number>;
  proseText?: string;
  /** String list for Hauptleistungen-style detail blocks. */
  listItems?: string[];
  listEmptyKey?: TranslationKey;
};

export type DocumentSummary = {
  id: string;
  sourceInboxItemId: string;
  generatedAt: string;
  documentKind: ClassifiedDocumentKind;
  documentTypeLabelKey: TranslationKey;
  family: DocumentSummaryFamily;
  headline: string;
  subtitle?: string;
  facts: DocumentSummaryFact[];
  alerts: DocumentSummaryAlert[];
  /** VORGANG-INTELLIGENCE — presentation-only match; never persisted. */
  caseMatch?: DocumentCaseMatch;
  primaryAction: DocumentSummaryActionRef;
  secondaryActions: DocumentSummaryActionRef[];
  details: DocumentSummaryDetailSection[];
  workspaceType: DocumentSummaryWorkspaceType;
  hasDeepWorkspace: boolean;
};

export const DOCUMENT_SUMMARY_MAX_FACTS = 6;
export const DOCUMENT_SUMMARY_MAX_ALERTS = 3;
export const DOCUMENT_SUMMARY_MAX_SECONDARY = 2;
export const DOCUMENT_SUMMARY_SCHEMA_VERSION = 1;
