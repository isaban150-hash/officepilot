import { patchInboxItem } from './inboxService';
import type { InboxItem, VorgangLinkStatus } from '../types/models';

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
