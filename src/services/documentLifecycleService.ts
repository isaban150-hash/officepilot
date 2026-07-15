import type { CommunicationContextRef } from '../types/communication';
import type { CommunicationReplyStatus } from '../types/communicationHistory';
import type {
  DocumentLifecycleReason,
  DocumentLifecycleRef,
  DocumentLifecycleStatus,
  DocumentLifecycleView,
} from '../types/documentLifecycle';
import type { DocumentMemory, ProofMemory } from '../types/memory';
import type { InboxItem, PendingItem, PendingItemKind } from '../types/models';
import { getCommunicationReplyStatus, getEventsForContext } from './communicationHistoryService';
import { getDocumentById } from './documentService';
import { filterActiveItems, getInboxItemById, getInboxItems } from './inboxService';
import {
  getAllDocumentMemories,
  getDocumentMemoryByDocumentId,
  getPaperRegisterEntryForDocument,
  getProofsForVorgang,
} from './officePilotMemoryService';
import { isAdvertisementContext, resolvePaperFiling } from './paperFolderService';
import { getAllTasksFromStore } from './taskStore';
import { getTodayIso, isTaskOpen } from './taskNormalize';

const DEADLINE_ATTENTION_DAYS = 30;

const REPLY_STATUS_EVENT_TYPES = new Set([
  'marked_answered',
  'marked_no_reply_needed',
  'draft_copied',
  'draft_created',
  'document_answer',
  'marked_remind_later',
]);

function resolveLifecycleReplyStatus(input: {
  documentId?: string;
  inboxItem?: InboxItem;
  memory?: DocumentMemory;
}): CommunicationReplyStatus {
  const refs: CommunicationContextRef[] = [];
  if (input.documentId) refs.push({ type: 'document', id: input.documentId });
  if (input.memory?.mailImportId) refs.push({ type: 'mail', id: input.memory.mailImportId });
  if (input.inboxItem?.mailImportId) refs.push({ type: 'mail', id: input.inboxItem.mailImportId });
  if (input.inboxItem?.id) refs.push({ type: 'inbox', id: input.inboxItem.id });

  for (const ref of refs) {
    const status = resolveCommunicationReplyForLifecycle(ref);
    if (status !== 'no_reply_needed') return status;
  }
  return 'no_reply_needed';
}

function resolveCommunicationReplyForLifecycle(
  contextRef: CommunicationContextRef | null,
): CommunicationReplyStatus {
  if (!contextRef || contextRef.type === 'none') return 'no_reply_needed';
  const hasStatusEvents = getEventsForContext(contextRef).some((event) =>
    REPLY_STATUS_EVENT_TYPES.has(event.type),
  );
  if (!hasStatusEvents) return 'no_reply_needed';
  return getCommunicationReplyStatus(contextRef);
}

function daysUntil(isoDate: string, todayIso: string): number {
  const today = new Date(`${todayIso.slice(0, 10)}T12:00:00`);
  const target = new Date(`${isoDate.slice(0, 10)}T12:00:00`);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function isAdvertisement(
  memory: DocumentMemory | undefined,
  inboxItem: InboxItem | undefined,
  documentIssuer?: string,
  documentText?: string,
): boolean {
  if (inboxItem?.isAdvertisement) return true;
  const haystack = `${documentText ?? ''} ${documentIssuer ?? ''}`.toLowerCase();
  if (/werbung|reklame|prospekt|newsletter|aktionsmail/.test(haystack)) return true;
  return isAdvertisementContext({
    classifiedKind: memory?.classifiedKind ?? inboxItem?.classifiedKind,
    documentType: inboxItem?.documentType,
    issuer: documentIssuer ?? inboxItem?.sender,
    isAdvertisement: inboxItem?.isAdvertisement,
  });
}

function needsPaperFolder(
  memory: DocumentMemory | undefined,
  inboxItem: InboxItem | undefined,
  documentPaperFolderId?: string,
): boolean {
  if (isAdvertisement(memory, inboxItem)) return false;
  const resolution = resolvePaperFiling({
    classifiedKind: memory?.classifiedKind ?? inboxItem?.classifiedKind,
    documentType: inboxItem?.documentType,
    issuer: inboxItem?.sender,
    linkedVorgangId: memory?.linkedVorgangId ?? inboxItem?.vorgangId,
    isAdvertisement: inboxItem?.isAdvertisement,
  });
  if (resolution.skipPhysicalFiling) return false;
  return Boolean(
    resolution.rule?.folderId ||
      memory?.paperFolder?.folderId ||
      documentPaperFolderId,
  );
}

function isPhysicallyFiled(documentId: string, memory?: DocumentMemory): boolean {
  const entry = getPaperRegisterEntryForDocument(documentId);
  return memory?.physicalFiled ?? entry?.physicalFiled ?? false;
}

function hasOpenDeadline(memory: DocumentMemory | undefined, inboxItem: InboxItem | undefined, todayIso: string): boolean {
  const deadline =
    memory?.summary?.deadline ??
    (memory?.validUntil ? memory.validUntil.slice(0, 10) : null) ??
    inboxItem?.deadline;
  if (!deadline) return false;
  const days = daysUntil(deadline, todayIso);
  return days <= DEADLINE_ATTENTION_DAYS;
}

function getMissingProofLabels(vorgangId: string | undefined): string[] {
  if (!vorgangId) return [];
  return getProofsForVorgang(vorgangId)
    .filter((item: ProofMemory) => item.status === 'missing')
    .map((item) => item.proofType);
}

function getOpenTasksForInbox(inboxId?: string): number {
  if (!inboxId) return 0;
  return getAllTasksFromStore().filter(
    (task) => isTaskOpen(task) && (task.linkedInboxId === inboxId || task.sourceId === inboxId),
  ).length;
}

function buildCompletedSteps(
  memory: DocumentMemory | undefined,
  hasDocument: boolean,
): string[] {
  const steps: string[] = [];
  if (hasDocument) steps.push('Digital archiviert');
  if (memory?.summary || memory?.letterExplanation) {
    steps.push('Klassifiziert und erklärt');
  } else if (memory?.classifiedKind) {
    steps.push('Klassifiziert');
  }
  if (memory?.paperFolder?.folderId || memory?.paperRegisterEntryId) {
    steps.push('Papierablage ermittelt');
  }
  return steps;
}

function resolvePrimaryStatus(input: {
  isAd: boolean;
  replyStatus: ReturnType<typeof getCommunicationReplyStatus>;
  needsPaper: boolean;
  physicalFiled: boolean;
  openDeadline: boolean;
  missingProofs: string[];
  openTasks: number;
  hasMemory: boolean;
  isInboxOnly: boolean;
}): DocumentLifecycleStatus {
  if (input.isAd) return 'done';

  const needsAction =
    input.replyStatus === 'needs_reply' ||
    input.openDeadline ||
    input.missingProofs.length > 0 ||
    input.openTasks > 0 ||
    (input.needsPaper && !input.physicalFiled && input.replyStatus !== 'answered');

  if (needsAction) return 'needs_action';

  if (input.replyStatus === 'draft_ready' || input.replyStatus === 'copied') {
    return 'waiting';
  }

  if (input.replyStatus === 'answered') {
    if (input.physicalFiled || !input.needsPaper) return 'done';
    return 'answered';
  }

  if (input.physicalFiled) return 'done';

  if (input.hasMemory) return 'recognized';
  if (input.isInboxOnly) return 'new';
  return 'recognized';
}

function buildOpenItems(input: {
  replyStatus: ReturnType<typeof getCommunicationReplyStatus>;
  needsPaper: boolean;
  physicalFiled: boolean;
  openDeadline: boolean;
  missingProofs: string[];
  openTasks: number;
  isAd: boolean;
}): { items: string[]; reasons: DocumentLifecycleReason[] } {
  if (input.isAd) {
    return { items: [], reasons: [] };
  }

  const items: string[] = [];
  const reasons: DocumentLifecycleReason[] = [];

  if (input.replyStatus === 'needs_reply') {
    items.push('Antwort offen');
    reasons.push('reply_open');
  }
  if (input.needsPaper && !input.physicalFiled) {
    items.push('Original noch abheften');
    reasons.push('file_original');
  }
  if (input.openDeadline) {
    items.push('Frist offen');
    reasons.push('deadline_open');
  }
  if (input.missingProofs.length > 0) {
    items.push('Nachweis fehlt');
    reasons.push('proof_missing');
  }
  if (input.openTasks > 0) {
    items.push('Aufgabe offen');
    reasons.push('task_open');
  }

  return { items, reasons };
}

function buildNextStep(
  status: DocumentLifecycleStatus,
  openItems: string[],
  reasons: DocumentLifecycleReason[],
): string {
  if (status === 'done') return 'Kein weiterer Schritt nötig.';
  if (reasons.includes('reply_open')) return 'Antwort vorbereiten oder als erledigt markieren.';
  if (reasons.includes('file_original')) return 'Original abheften und in OfficePilot bestätigen.';
  if (reasons.includes('deadline_open')) return 'Frist prüfen und rechtzeitig reagieren.';
  if (reasons.includes('proof_missing')) return 'Fehlende Nachweise beschaffen und archivieren.';
  if (reasons.includes('task_open')) return 'Offene Aufgabe erledigen.';
  if (status === 'waiting') return 'Entwurf prüfen und versenden.';
  if (status === 'answered') return 'Original abheften, falls noch offen.';
  if (status === 'filed') return 'Ablage ist erledigt – bei Bedarf Dokument nachlesen.';
  if (openItems.length === 0) return 'Dokument im Archiv prüfen.';
  return openItems[0] ?? 'Nächsten Schritt prüfen.';
}

function lifecycleRoute(documentId?: string, inboxId?: string): string {
  if (documentId) return `/dokumente/${documentId}`;
  if (inboxId) return `/ablage/${inboxId}`;
  return '/dokumente';
}

export function resolveDocumentLifecycle(
  ref: DocumentLifecycleRef,
  todayIso: string = getTodayIso(),
): DocumentLifecycleView | null {
  let memory: DocumentMemory | undefined;
  let inboxItem: InboxItem | undefined;
  let document = ref.documentId ? getDocumentById(ref.documentId) : undefined;

  if (ref.documentId) {
    memory = getDocumentMemoryByDocumentId(ref.documentId);
    if (memory?.inboxId) inboxItem = getInboxItemById(memory.inboxId);
  } else if (ref.inboxId) {
    inboxItem = getInboxItemById(ref.inboxId);
    if (inboxItem) {
      memory = getAllDocumentMemories().find((item) => item.inboxId === ref.inboxId);
      if (memory?.documentId) document = getDocumentById(memory.documentId);
    }
  }

  if (!document && !inboxItem && !memory) return null;

  const documentId = document?.id ?? memory?.documentId;
  const title = document?.title ?? memory?.title ?? inboxItem?.title ?? 'Dokument';
  const isAd = isAdvertisement(memory, inboxItem, document?.issuer, document?.recognizedText);
  const needsPaper = needsPaperFolder(memory, inboxItem, document?.paperFolder?.folderId);
  const physicalFiled = documentId ? isPhysicallyFiled(documentId, memory) : false;
  const replyStatus = resolveLifecycleReplyStatus({ documentId, inboxItem, memory });
  const openDeadline = hasOpenDeadline(memory, inboxItem, todayIso);
  const missingProofs = getMissingProofLabels(
    memory?.linkedVorgangId ?? document?.linkedVorgang?.vorgangId ?? inboxItem?.vorgangId,
  );
  const openTasks = getOpenTasksForInbox(memory?.inboxId ?? inboxItem?.id);

  const { items: openItems, reasons } = buildOpenItems({
    replyStatus,
    needsPaper,
    physicalFiled,
    openDeadline,
    missingProofs,
    openTasks,
    isAd,
  });

  let status = resolvePrimaryStatus({
    isAd,
    replyStatus,
    needsPaper,
    physicalFiled,
    openDeadline,
    missingProofs,
    openTasks,
    hasMemory: Boolean(memory),
    isInboxOnly: Boolean(inboxItem && !document),
  });

  if (physicalFiled && status === 'needs_action' && openItems.length === 1 && reasons[0] === 'file_original') {
    status = 'filed';
  } else if (physicalFiled && status !== 'done' && status !== 'waiting' && status !== 'answered') {
    if (openItems.filter((item) => item !== 'Original noch abheften').length === 0) {
      status = 'done';
    } else if (reasons.includes('file_original') === false) {
      status = physicalFiled ? 'filed' : status;
    }
  }

  if (physicalFiled && status === 'recognized' && openItems.length === 0) {
    status = 'done';
  }

  if (physicalFiled && openItems.length === 0 && status !== 'waiting') {
    status = 'done';
  }

  if (physicalFiled && status === 'needs_action' && !reasons.includes('file_original')) {
    status = 'filed';
  }

  return {
    status,
    title,
    documentId,
    inboxId: memory?.inboxId ?? inboxItem?.id,
    completedSteps: buildCompletedSteps(memory, Boolean(document)),
    openItems,
    nextStep: buildNextStep(status, openItems, reasons),
    openReasons: reasons,
    route: lifecycleRoute(documentId, memory?.inboxId ?? inboxItem?.id),
  };
}

export function getOpenDocumentLifecycleItems(
  todayIso: string = getTodayIso(),
): DocumentLifecycleView[] {
  const seen = new Set<string>();
  const items: DocumentLifecycleView[] = [];

  for (const memory of getAllDocumentMemories()) {
    const view = resolveDocumentLifecycle({ documentId: memory.documentId }, todayIso);
    if (!view || view.status === 'done' || view.openItems.length === 0) continue;
    const key = view.documentId ?? view.inboxId ?? view.title;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(view);
  }

  for (const inboxItem of filterActiveItems(getInboxItems())) {
    if (inboxItem.importedToArchive) continue;
    const view = resolveDocumentLifecycle({ inboxId: inboxItem.id }, todayIso);
    if (!view || view.status === 'done' || view.openItems.length === 0) continue;
    const key = view.inboxId ?? view.title;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(view);
  }

  return items;
}

function lifecyclePendingKind(reason: DocumentLifecycleReason): PendingItemKind {
  switch (reason) {
    case 'reply_open':
      return 'document_lifecycle_reply';
    case 'file_original':
      return 'document_lifecycle_filing';
    case 'deadline_open':
      return 'document_lifecycle_deadline';
    case 'proof_missing':
      return 'document_lifecycle_proof';
    default:
      return 'document_lifecycle_deadline';
  }
}

function lifecyclePendingPriority(reason: DocumentLifecycleReason): PendingItem['priority'] {
  switch (reason) {
    case 'deadline_open':
    case 'proof_missing':
      return 'hoch';
    case 'reply_open':
    case 'file_original':
      return 'mittel';
    default:
      return 'niedrig';
  }
}

export function scanDocumentLifecyclePending(
  todayIso: string = getTodayIso(),
): PendingItem[] {
  return getOpenDocumentLifecycleItems(todayIso).flatMap((view) =>
    view.openReasons
      .filter((reason) => reason !== 'task_open')
      .map((reason, index) => ({
      id: `lifecycle-${view.documentId ?? view.inboxId}-${reason}-${index}`,
      kind: lifecyclePendingKind(reason),
      title: view.title,
      description: view.openItems.find((_, i) => view.openReasons[i] === reason) ?? view.openItems[0],
      priority: lifecyclePendingPriority(reason),
      route: view.route,
      sourceType: 'document' as const,
      sourceId: view.documentId ?? view.inboxId,
    })),
  );
}

export function getDocumentLifecycleStatusLabel(status: DocumentLifecycleStatus): string {
  switch (status) {
    case 'new':
      return 'Neu erfasst';
    case 'recognized':
      return 'Erkannt und archiviert';
    case 'needs_action':
      return 'Handlung nötig';
    case 'waiting':
      return 'Warten auf Versand';
    case 'answered':
      return 'Beantwortet';
    case 'filed':
      return 'Original abgeheftet';
    case 'done':
      return 'Erledigt';
    default:
      return 'Unbekannt';
  }
}

export {
  DOCUMENT_FILE_LIFECYCLE_STATUSES,
  buildCommittedLifecycleFields,
  buildTempLifecycleFields,
  applyDocumentFileRefCommittedPromotion,
  isDocumentFileRefTempExpired,
  migrateDocumentFileRefsToCommitted,
  normalizeDocumentFileRefLifecycle,
  isCommittedFileRefLifecycle,
} from './documentFileStorageLifecycleService';
export type { DocumentFileLifecycleStatus } from './documentFileStorageLifecycleService';
