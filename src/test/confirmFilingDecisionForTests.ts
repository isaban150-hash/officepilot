import { confirmProposedDocumentFilingDecision } from '../services/documentFilingDecisionService';
import { getInboxItemById } from '../services/inboxService';
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
