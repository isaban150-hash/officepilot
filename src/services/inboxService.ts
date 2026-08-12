import {
  createMockInboxItemFromUpload,
  type CreateInboxFromUploadOptions,
} from './inboxUploadFactory';
import type {
  AppLanguage,
  ClassifiedDocumentKind,
  InboxItem,
  InboxPriority,
  InboxRecognizedDataChanges,
  InboxStatus,
  RecommendedAction,
} from '../types/models';
import { t, type TranslationKey } from '../i18n';
import { getPaperFolderById } from './paperFolderService';
import {
  findDocumentFileIntakeTransformPlanCarryContext,
  getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot,
  removeDocumentFileIntakeTransformPlanCarryContextForInboxItem,
  replaceDocumentFileIntakeTransformPlanCarryContextStore,
} from './documentFileIntakeTransformPlanCarryContextStoreService';
import {
  getDocumentWorkResult,
  removeDocumentWorkResultForInboxItem,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';
import { getAllExpensesFromStore } from './expenseStore';
import { getCachedSetup, persistAll } from './persistenceService';
import {
  hasActiveArchiveDocumentForInboxItem,
  releaseDocumentFileIfUnreferenced,
} from './documentFileReferenceService';
import { filterSyncActive, isEntitySyncActive, withTombstonedEntity, withUpdatedEntitySync } from './sync/syncMetaService';

export type { CreateInboxFromUploadOptions };
export { createMockInboxItemFromUpload } from './inboxUploadFactory';

const PRIORITY_ORDER: Record<InboxPriority, number> = {
  kritisch: 0,
  hoch: 1,
  mittel: 2,
  niedrig: 3,
};

let inboxItems: InboxItem[] = [];

export function getInboxStoreSnapshot(): InboxItem[] {
  return inboxItems.map((item) => ({
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    recognizedData: { ...item.recognizedData },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
    originalRecognizedData: item.originalRecognizedData
      ? { ...item.originalRecognizedData }
      : undefined,
    filingDecision: item.filingDecision ? { ...item.filingDecision } : undefined,
  }));
}

export function hydrateInboxStore(items: InboxItem[]): void {
  inboxItems = items.map((item) => ({
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    recognizedData: { ...item.recognizedData },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
    originalRecognizedData: item.originalRecognizedData
      ? { ...item.originalRecognizedData }
      : undefined,
    filingDecision: item.filingDecision ? { ...item.filingDecision } : undefined,
  }));
}

export interface InboxActionResult {
  success: boolean;
  message: string;
  messageKey?: import('../i18n').TranslationKey;
  messageParams?: Record<string, string>;
  item: InboxItem;
  taskCreated?: import('../types/models').Task;
}

function findItem(id: string): InboxItem | undefined {
  const item = inboxItems.find((i) => i.id === id);
  if (!item || !isEntitySyncActive(item)) return undefined;
  return item;
}

export function patchInboxItem(id: string, updates: Partial<InboxItem>): InboxItem | null {
  const index = inboxItems.findIndex((i) => i.id === id && isEntitySyncActive(i));
  if (index === -1) return null;
  const previous = inboxItems[index]!;
  const updated = withUpdatedEntitySync(
    { ...previous, ...updates },
    'inbox_item',
  );
  inboxItems = [...inboxItems.slice(0, index), updated, ...inboxItems.slice(index + 1)];
  const persistResult = persistAll();
  if (!persistResult.success) {
    inboxItems = [...inboxItems.slice(0, index), previous, ...inboxItems.slice(index + 1)];
    return null;
  }
  return updated;
}

export function resetInboxItems(): void {
  inboxItems = [];
}

export function stageInboxItem(item: InboxItem): InboxItem {
  inboxItems = [item, ...inboxItems];
  return { ...item };
}

export function removeStagedInboxItemById(id: string): boolean {
  const index = inboxItems.findIndex((item) => item.id === id);
  if (index === -1) return false;
  inboxItems = [...inboxItems.slice(0, index), ...inboxItems.slice(index + 1)];
  removeDocumentFileIntakeTransformPlanCarryContextForInboxItem(id);
  removeDocumentWorkResultForInboxItem(id);
  return true;
}

export function addInboxItem(item: InboxItem): InboxItem {
  const staged = stageInboxItem(item);
  persistAll();
  return staged;
}

export function processUpload(options: CreateInboxFromUploadOptions = {}): InboxItem {
  const item = createMockInboxItemFromUpload(options);
  return addInboxItem(item);
}

export function getInboxItems(): InboxItem[] {
  const copies = inboxItems.map((i) => ({ ...i }));
  const freshUploads = copies.filter((i) => i.isNewUpload && i.status !== 'abgelegt');
  const rest = copies.filter((i) => !(i.isNewUpload && i.status !== 'abgelegt'));
  return [...freshUploads, ...sortInboxItems(rest)];
}

export function getInboxItemById(id: string): InboxItem | undefined {
  const item = findItem(id);
  return item ? { ...item } : undefined;
}

export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => {
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return b.receivedAt.localeCompare(a.receivedAt);
  });
}

export function getInboxSummary(): { total: number; neu: number; urgent: number } {
  // Tombstoned / sync-inactive items never count towards the inbox badge.
  const active = filterSyncActive(inboxItems).filter(
    (i) => i.status !== 'abgelegt' && !(i.isAdvertisement && i.status === 'geprueft'),
  );
  return {
    total: active.length,
    neu: active.filter((i) => i.status === 'neu').length,
    urgent: active.filter((i) => i.priority === 'kritisch' || i.priority === 'hoch').length,
  };
}

export function markAsReviewed(id: string): InboxActionResult | null {
  const item = patchInboxItem(id, { status: 'geprueft', isNewUpload: false });
  if (!item) return null;
  return { success: true, messageKey: 'inbox.toast.reviewed', message: 'Dokument als geprüft markiert.', item };
}

export function deferItem(id: string): InboxActionResult | null {
  const item = patchInboxItem(id, { status: 'spaeter_klaeren', isNewUpload: false });
  if (!item) return null;
  return {
    success: true,
    messageKey: 'inbox.toast.deferred',
    message: 'Zur späteren Klärung gespeichert – nichts wurde gelöscht.',
    item,
  };
}

export function confirmDispose(id: string): InboxActionResult | null {
  const existing = findItem(id);
  if (!existing?.isAdvertisement) return null;
  const item = patchInboxItem(id, { status: 'abgelegt', isNewUpload: false });
  if (!item) return null;
  removeDocumentFileIntakeTransformPlanCarryContextForInboxItem(id);
  removeDocumentWorkResultForInboxItem(id);
  persistAll();
  return {
    success: true,
    messageKey: 'inbox.toast.disposed',
    message:
      'Entsorgung bestätigt. Das Dokument wurde aus dem aktiven Eingang entfernt – nichts automatisch gelöscht.',
    item,
  };
}

/**
 * DOCUMENT-INBOX-DELETE-01 — reasons a document may no longer be deleted from the inbox.
 * Deletion is only offered while the document is still purely an inbox entry.
 */
export type InboxDeleteBlockReason = 'vorgang' | 'archive' | 'expense';

const INBOX_DELETE_BLOCK_MESSAGE_KEYS: Record<InboxDeleteBlockReason, TranslationKey> = {
  vorgang: 'inbox.delete.blocked.vorgang',
  archive: 'inbox.delete.blocked.archive',
  expense: 'inbox.delete.blocked.expense',
};

/** null when the item is still unused and may be deleted. */
export function getInboxDeleteBlockReason(item: InboxItem): InboxDeleteBlockReason | null {
  if (item.vorgangId?.trim()) return 'vorgang';
  if (item.archiveDocumentId?.trim() || item.importedToArchive) return 'archive';
  // R02: the inbox flags can be missing when the archive write succeeded but the
  // inbox marking failed to persist. The archive document itself is then the only
  // proof of origin — deleting the inbox row would drop the DWR for a live document.
  if (hasActiveArchiveDocumentForInboxItem(item.id)) return 'archive';
  if (getAllExpensesFromStore().some((expense) => expense.linkedInboxId === item.id)) {
    return 'expense';
  }
  return null;
}

function buildInboxDeleteFailure(item: InboxItem, messageKey: TranslationKey): InboxActionResult {
  return {
    success: false,
    messageKey,
    message: t(messageKey, getCachedSetup()?.language ?? 'de'),
    item: { ...item },
  };
}

/**
 * Tombstone delete for an inbox document that was never used elsewhere.
 *
 * Atomicity: the tombstone plus the DWR / carry-context removals are applied in
 * memory and committed by a single persistAll(). A failed persist rolls all three
 * back, so there is never a half-deleted state. The FileRef is only released after
 * the delete is committed and only when no other active entity still references it.
 */
export async function deleteInboxItem(id: string): Promise<InboxActionResult | null> {
  const index = inboxItems.findIndex((item) => item.id === id && isEntitySyncActive(item));
  if (index === -1) return null;
  const existing = inboxItems[index]!;

  const blockReason = getInboxDeleteBlockReason(existing);
  if (blockReason) {
    return buildInboxDeleteFailure(existing, INBOX_DELETE_BLOCK_MESSAGE_KEYS[blockReason]);
  }

  // Captured for rollback — nothing is finally removed before persistAll() succeeded.
  const previousCarryContext = findDocumentFileIntakeTransformPlanCarryContext(id);
  const previousWorkResult = getDocumentWorkResult(id);

  const tombstoned = withTombstonedEntity({ ...existing }, 'inbox_item');
  inboxItems = [...inboxItems.slice(0, index), tombstoned, ...inboxItems.slice(index + 1)];
  removeDocumentFileIntakeTransformPlanCarryContextForInboxItem(id);
  removeDocumentWorkResultForInboxItem(id);

  const persistResult = persistAll();
  if (!persistResult.success) {
    inboxItems = [...inboxItems.slice(0, index), existing, ...inboxItems.slice(index + 1)];
    if (previousCarryContext) {
      replaceDocumentFileIntakeTransformPlanCarryContextStore([
        ...getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot(),
        previousCarryContext,
      ]);
    }
    if (previousWorkResult) {
      upsertDocumentWorkResult(previousWorkResult);
    }
    return buildInboxDeleteFailure(existing, 'inbox.delete.failed');
  }

  // Shared FileRefs survive: the reference counter still sees the other holders.
  const released = await releaseDocumentFileIfUnreferenced(existing.fileRefId);
  if (released) {
    persistAll();
  }

  return {
    success: true,
    messageKey: 'inbox.toast.deleted',
    message: t('inbox.toast.deleted', getCachedSetup()?.language ?? 'de'),
    item: tombstoned,
  };
}

export function saveAdvertisementAnyway(id: string): InboxActionResult | null {
  const existing = findItem(id);
  if (!existing?.isAdvertisement) return null;
  const item = patchInboxItem(id, { status: 'abgelegt', recommendedAction: 'archivieren', isNewUpload: false });
  if (!item) return null;
  return {
    success: true,
    messageKey: 'inbox.toast.adSaved',
    message: 'Werbung manuell gespeichert und abgelegt.',
    item,
  };
}

export function getPriorityLabel(
  priority: InboxPriority,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  return t(`priority.${priority}` as TranslationKey, lang);
}

export function getStatusLabel(
  status: InboxStatus,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  return t(`inboxStatus.${status}` as TranslationKey, lang);
}

export function filterActiveItems(items: InboxItem[]): InboxItem[] {
  return filterSyncActive(items).filter((i) => i.status !== 'abgelegt');
}

export const EDITABLE_PRIORITIES: InboxPriority[] = ['niedrig', 'mittel', 'hoch', 'kritisch'];

export const EDITABLE_ACTIONS: RecommendedAction[] = [
  'zuordnen',
  'abheften',
  'rechnung_vorbereiten',
  'archivieren',
  'klaeren',
  'zahlung_pruefen',
  'auftrag_annehmen',
  'steuerberater_vorbereiten',
  'entsorgen',
];

export function updateInboxItemRecognizedData(
  id: string,
  changes: InboxRecognizedDataChanges,
): InboxItem | null {
  const existing = findItem(id);
  if (!existing) return null;

  const merged: Partial<InboxItem> = {
    userModified: true,
    modifiedAt: new Date().toISOString(),
    status: existing.status === 'neu' ? 'geprueft' : existing.status,
    isNewUpload: false,
  };

  if (changes.sender !== undefined) merged.sender = changes.sender;
  if (changes.deadline !== undefined) merged.deadline = changes.deadline || null;
  if (changes.vorgangTitle !== undefined) merged.vorgangTitle = changes.vorgangTitle || undefined;
  if (changes.priority !== undefined) merged.priority = changes.priority;
  if (changes.recommendedAction !== undefined) {
    merged.recommendedAction = changes.recommendedAction;
    if (changes.recommendedAction !== 'entsorgen') {
      merged.isAdvertisement = false;
    }
  }

  if (changes.recognizedData !== undefined) {
    if (!existing.originalRecognizedData && !existing.userModified) {
      merged.originalRecognizedData = { ...existing.recognizedData };
    }
    merged.recognizedData = { ...existing.recognizedData, ...changes.recognizedData };
  }

  if (changes.digitalFolderPath !== undefined || changes.digitalFolderName !== undefined) {
    merged.digitalFolder = {
      ...existing.digitalFolder,
      ...(changes.digitalFolderPath !== undefined && { path: changes.digitalFolderPath }),
      ...(changes.digitalFolderName !== undefined && { name: changes.digitalFolderName }),
    };
  }

  if (changes.paperFilingFolderId !== undefined || changes.paperFilingRegister !== undefined) {
    const folderId = changes.paperFilingFolderId ?? existing.paperFiling.folderId;
    const folder = getPaperFolderById(folderId);
    merged.paperFiling = {
      ...existing.paperFiling,
      folderId,
      register: changes.paperFilingRegister ?? existing.paperFiling.register,
      label: folder?.name ?? existing.paperFiling.label,
    };
  }

  return patchInboxItem(id, merged);
}

export function markInboxImportedToArchive(
  inboxId: string,
  documentId: string,
): InboxActionResult | null {
  const item = patchInboxItem(inboxId, {
    status: 'abgelegt',
    importedToArchive: true,
    archiveDocumentId: documentId,
    isNewUpload: false,
  });
  if (!item) return null;
  return {
    success: true,
    messageKey: 'inbox.toast.archived',
    message: 'Ins Dokumentenarchiv übernommen.',
    item,
  };
}

export function finalizeInboxIntake(inboxId: string): InboxItem | null {
  const existing = findItem(inboxId);
  if (!existing) return null;

  if (existing.importedToArchive) {
    return patchInboxItem(inboxId, { isNewUpload: false });
  }

  return patchInboxItem(inboxId, {
    status: existing.status === 'neu' ? 'geprueft' : existing.status,
    isNewUpload: false,
  });
}

export function markInboxAsCompanyDocument(
  inboxId: string,
  category?: ClassifiedDocumentKind,
): InboxItem | null {
  return patchInboxItem(inboxId, {
    markedAsCompanyDocument: true,
    classifiedKind: category,
    userModified: true,
    modifiedAt: new Date().toISOString(),
    status: 'geprueft',
    isNewUpload: false,
  });
}
