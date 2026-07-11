import { getDocumentStoreSnapshot } from './documentService';
import { attachCompanyDocumentToVorgang } from './vorgangService';
import type { CompanyDocument, InboxItem, VorgangDocument } from '../types/models';

export function resolveVorgangDocumentDisplayName(doc: VorgangDocument): string {
  if (doc.companyDocumentId) {
    const archived = getDocumentStoreSnapshot().find((entry) => entry.id === doc.companyDocumentId);
    if (archived) return archived.title;
  }
  return doc.name;
}

export function linkArchivedDocumentToVorgang(
  companyDocument: CompanyDocument,
  inboxItem?: InboxItem,
): void {
  const vorgangId = inboxItem?.vorgangId ?? companyDocument.linkedVorgang?.vorgangId;
  if (!vorgangId) return;
  attachCompanyDocumentToVorgang(vorgangId, companyDocument, inboxItem);
}
