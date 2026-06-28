import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { addTaskFromTemplate } from './taskService';
import {
  createMockInboxItemFromUpload,
  type CreateInboxFromUploadOptions,
} from './inboxUploadFactory';
import type {
  InboxItem,
  InboxPriority,
  InboxRecognizedDataChanges,
  InboxStatus,
  RecommendedAction,
  Task,
  VorgangLinkStatus,
} from '../types/models';
import { formatPaperFilingInstruction, getPaperFolderById } from './analysisService';
import { persistAll } from './persistenceService';

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
  }));
}

export interface InboxActionResult {
  success: boolean;
  message: string;
  item: InboxItem;
  taskCreated?: Task;
}

function findItem(id: string): InboxItem | undefined {
  return inboxItems.find((i) => i.id === id);
}

function updateItem(id: string, updates: Partial<InboxItem>): InboxItem | null {
  const index = inboxItems.findIndex((i) => i.id === id);
  if (index === -1) return null;
  const updated = { ...inboxItems[index], ...updates };
  inboxItems = [...inboxItems.slice(0, index), updated, ...inboxItems.slice(index + 1)];
  persistAll();
  return updated;
}

export function resetInboxItems(): void {
  inboxItems = MOCK_INBOX_ITEMS.map((item) => ({
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    recognizedData: { ...item.recognizedData },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
  }));
}

export function addInboxItem(item: InboxItem): InboxItem {
  inboxItems = [item, ...inboxItems];
  persistAll();
  return { ...item };
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
  const item = updateItem(id, { status: 'geprueft', isNewUpload: false });
  if (!item) return null;
  return { success: true, message: 'Dokument als geprüft markiert.', item };
}

export function confirmFiling(id: string): InboxActionResult | null {
  const item = updateItem(id, { status: 'abgelegt', isNewUpload: false });
  if (!item) return null;
  const filing = formatPaperFilingInstruction(item.paperFiling);
  let taskCreated: Task | undefined;
  if (item.taskTemplate) {
    taskCreated = addTaskFromTemplate(item.taskTemplate, item.id);
  }
  persistAll();
  return {
    success: true,
    message: `Abgelegt. ${filing}`,
    item,
    taskCreated,
  };
}

export function deferItem(id: string): InboxActionResult | null {
  const item = updateItem(id, { status: 'spaeter_klaeren', isNewUpload: false });
  if (!item) return null;
  return {
    success: true,
    message: 'Zur späteren Klärung gespeichert – nichts wurde gelöscht.',
    item,
  };
}

export function confirmDispose(id: string): InboxActionResult | null {
  const existing = findItem(id);
  if (!existing?.isAdvertisement) return null;
  const item = updateItem(id, { status: 'abgelegt', isNewUpload: false });
  if (!item) return null;
  return {
    success: true,
    message: 'Entsorgung bestätigt. Das Dokument wurde aus dem aktiven Eingang entfernt – nichts automatisch gelöscht.',
    item,
  };
}

export function saveAdvertisementAnyway(id: string): InboxActionResult | null {
  const existing = findItem(id);
  if (!existing?.isAdvertisement) return null;
  const item = updateItem(id, { status: 'abgelegt', recommendedAction: 'archivieren', isNewUpload: false });
  if (!item) return null;
  return {
    success: true,
    message: 'Werbung manuell gespeichert und abgelegt.',
    item,
  };
}

export function createTaskForItem(id: string): InboxActionResult | null {
  const existing = findItem(id);
  if (!existing?.taskTemplate) return null;
  const taskCreated = addTaskFromTemplate(existing.taskTemplate, existing.id);
  const item = updateItem(id, { status: 'geprueft', isNewUpload: false })!;
  return {
    success: true,
    message: `Aufgabe erstellt: ${taskCreated.title}`,
    item,
    taskCreated,
  };
}

export function getPriorityLabel(priority: InboxPriority): string {
  const labels: Record<InboxPriority, string> = {
    kritisch: 'Kritisch',
    hoch: 'Hoch',
    mittel: 'Mittel',
    niedrig: 'Niedrig',
  };
  return labels[priority];
}

export function getStatusLabel(status: InboxStatus): string {
  const labels: Record<InboxStatus, string> = {
    neu: 'Neu',
    geprueft: 'Geprüft',
    abgelegt: 'Abgelegt',
    spaeter_klaeren: 'Später klären',
  };
  return labels[status];
}

export function filterActiveItems(items: InboxItem[]): InboxItem[] {
  return items.filter((i) => i.status !== 'abgelegt');
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

  return updateItem(id, merged);
}

export function setInboxVorgangLink(
  inboxId: string,
  vorgangId: string,
  vorgangTitle: string,
  linkStatus: VorgangLinkStatus,
): InboxItem | null {
  return updateItem(inboxId, {
    vorgangId,
    vorgangTitle,
    vorgangLinkStatus: linkStatus,
    status: 'geprueft',
    isNewUpload: false,
  });
}

export function markInboxImportedToArchive(
  inboxId: string,
  documentId: string,
): InboxActionResult | null {
  const item = updateItem(inboxId, {
    status: 'abgelegt',
    importedToArchive: true,
    archiveDocumentId: documentId,
    isNewUpload: false,
  });
  if (!item) return null;
  return {
    success: true,
    message: 'Ins Dokumentenarchiv übernommen.',
    item,
  };
}
