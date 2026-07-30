import { analyzeContractFromInbox } from './contractAnalysisService';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import { getCompanyProfile } from './companyProfileService';
import { getDocumentById } from './documentService';
import { formatPaperFilingInstruction } from './paperFolderService';
import {
  createTaskFromInboxItem,
  createTasksFromContractAnalysis,
} from './taskEngineService';
import { getInboxItemById, patchInboxItem, type InboxActionResult } from './inboxService';
import type { InboxItem } from '../types/models';

/** True only when inbox points at a resolvable, active archive document. */
export function inboxHasArchiveTruth(item: InboxItem): boolean {
  if (!item.importedToArchive || !item.archiveDocumentId) return false;
  return Boolean(getDocumentById(item.archiveDocumentId));
}

export function confirmFiling(id: string): InboxActionResult | null {
  const existing = getInboxItemById(id);
  if (!existing) return null;

  if (!inboxHasArchiveTruth(existing)) {
    return {
      success: false,
      messageKey: 'inbox.toast.filingRequiresArchive',
      message: 'Dokument wurde noch nicht archiviert.',
      item: existing,
    };
  }

  const item = patchInboxItem(id, { status: 'abgelegt', isNewUpload: false });
  if (!item) return null;
  const filing = formatPaperFilingInstruction(item.paperFiling);
  const taskCreated = createTaskFromInboxItem(item, getCompanyProfile(), { autoCreated: true }) ?? undefined;
  return {
    success: true,
    messageKey: 'inbox.toast.filed',
    messageParams: { filing },
    message: `Abgelegt. ${filing}`,
    item,
    taskCreated,
  };
}

export function createTaskForItem(id: string): InboxActionResult | null {
  const existing = getInboxItemById(id);
  if (!existing) return null;
  if (!isDocumentAnalysisAllowed(existing, getCompanyProfile())) return null;

  const taskCreated = createTaskFromInboxItem(existing, getCompanyProfile(), { autoCreated: false });
  if (!taskCreated) return null;

  const item = patchInboxItem(id, { status: 'geprueft', isNewUpload: false })!;
  return {
    success: true,
    messageKey: 'inbox.toast.taskFromItem',
    messageParams: { title: taskCreated.title },
    message: `Aufgabe erstellt: ${taskCreated.title}`,
    item,
    taskCreated,
  };
}

export function createContractTasksForItem(id: string): InboxActionResult | null {
  const existing = getInboxItemById(id);
  if (!existing) return null;
  if (!isDocumentAnalysisAllowed(existing, getCompanyProfile())) return null;

  const analysis = analyzeContractFromInbox(existing);
  const createdTasks = createTasksFromContractAnalysis(analysis, existing.id);
  if (createdTasks.length === 0) return null;

  const item = patchInboxItem(id, { status: 'geprueft', isNewUpload: false })!;
  return {
    success: true,
    messageKey: 'inbox.toast.contractTasks',
    messageParams: { count: String(createdTasks.length) },
    message: `${createdTasks.length} Aufgabe(n) aus Vertrag erstellt`,
    item,
    taskCreated: createdTasks[0],
  };
}
