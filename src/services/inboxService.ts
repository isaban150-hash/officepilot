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
import { removeDocumentFileIntakeTransformPlanCarryContextForInboxItem } from './documentFileIntakeTransformPlanCarryContextStoreService';
import { removeDocumentWorkResultForInboxItem } from './documentWorkResultStoreService';
import { getCachedSetup, persistAll } from './persistenceService';
import { filterSyncActive, isEntitySyncActive, withUpdatedEntitySync } from './sync/syncMetaService';

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
  const active = inboxItems.filter(
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
