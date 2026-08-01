import { getInboxItemById, patchInboxItem } from './inboxService';
import type { InboxItem, VorgangLinkStatus } from '../types/models';

export function resolveInboxItemForLinking(item: InboxItem): InboxItem {
  return getInboxItemById(item.id) ?? item;
}

export function setInboxVorgangLink(
  inboxId: string,
  vorgangId: string,
  vorgangTitle: string,
  linkStatus: VorgangLinkStatus,
): InboxItem | null {
  return patchInboxItem(inboxId, {
    vorgangId,
    vorgangTitle,
    vorgangLinkStatus: linkStatus,
    status: 'geprueft',
    isNewUpload: false,
  });
}

/** Clears Vorgang link fields after a failed archive-document bind (rollback). */
export function clearInboxVorgangLink(inboxId: string): InboxItem | null {
  return patchInboxItem(inboxId, {
    vorgangId: undefined,
    vorgangTitle: undefined,
    vorgangLinkStatus: undefined,
  });
}
