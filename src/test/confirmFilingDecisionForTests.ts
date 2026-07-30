import {
  confirmProposedDocumentFilingDecision,
} from '../services/documentFilingDecisionService';
import {
  importInboxDocument,
  updateDocumentFromInbox,
  type DocumentMutationResult,
  type ImportInboxDocumentOptions,
} from '../services/documentService';
import { archiveMailInboxItem } from '../services/mailImportService';
import { addInboxItem, getInboxItemById } from '../services/inboxService';
import type { InboxItem } from '../types/models';

/**
 * Test-only: explicit filing confirm before Smart Intake archive expectations.
 * Mirrors the required user confirm in production UI — never auto-confirm in product code.
 */
export function confirmFilingDecisionForTests(inboxId: string): InboxItem {
  const item = getInboxItemById(inboxId);
  if (!item) {
    throw new Error(`confirmFilingDecisionForTests: inbox item missing (${inboxId})`);
  }
  if (item.filingDecision?.status === 'confirmed') return item;
  const confirmed = confirmProposedDocumentFilingDecision(item);
  if (!confirmed) {
    throw new Error(`confirmFilingDecisionForTests: confirm failed (${inboxId})`);
  }
  return confirmed;
}

/**
 * Test-only: ensure inbox row exists, confirm filing, then call production import.
 * Production code must keep calling importInboxDocument directly (gate enforced there).
 */
export function importInboxDocumentForTests(
  item: InboxItem,
  linkedCompany: string,
  options?: ImportInboxDocumentOptions,
): DocumentMutationResult {
  if (!getInboxItemById(item.id)) {
    addInboxItem(item);
  }
  confirmFilingDecisionForTests(item.id);
  return importInboxDocument(getInboxItemById(item.id)!, linkedCompany, options);
}

/** Test-only wrapper for updateDocumentFromInbox with store confirm. */
export function updateDocumentFromInboxForTests(
  documentId: string,
  item: InboxItem,
  linkedCompany: string,
): DocumentMutationResult {
  if (!getInboxItemById(item.id)) {
    addInboxItem(item);
  }
  confirmFilingDecisionForTests(item.id);
  return updateDocumentFromInbox(documentId, getInboxItemById(item.id)!, linkedCompany);
}

/** Test-only wrapper for archiveMailInboxItem with store confirm. */
export function archiveMailInboxItemForTests(
  item: InboxItem,
  linkedCompany: string,
  mailImportId?: string,
): string | null {
  if (!getInboxItemById(item.id)) {
    addInboxItem(item);
  }
  confirmFilingDecisionForTests(item.id);
  return archiveMailInboxItem(getInboxItemById(item.id)!, linkedCompany, mailImportId);
}
