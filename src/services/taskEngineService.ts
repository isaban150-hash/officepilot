import { getOverdueInvoices } from './invoiceOverviewService';
import { getClassificationForItem } from './documentClassificationService';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import {
  appendTaskToStore,
  findTasksInStore,
  getAllTasksFromStore,
  replaceTaskInStore,
} from './taskStore';
import {
  buildDedupeKey,
  getTodayIso,
  isTaskDone,
  isTaskOpen,
  mapTaskTypeToCategory,
  normalizeTask,
} from './taskNormalize';
import type {
  ClassifiedDocumentKind,
  CompanyProfile,
  ContractAnalysisResult,
  InboxItem,
  InboxTaskTemplate,
  RequiredDocument,
  Task,
  TaskCategory,
  TaskFilter,
  TaskProposal,
  TaskSummary,
  TaskType,
} from '../types/models';

export {
  buildDedupeKey,
  getTodayIso,
  isTaskDone,
  isTaskOpen,
  normalizeTask,
} from './taskNormalize';

function mapRequiredDocToCategory(docType: string): TaskCategory {
  if (docType === 'freistellungsbescheinigung') return 'steuern';
  return 'behoerden';
}

function baseInboxLinks(item: InboxItem) {
  return {
    linkedInboxId: item.id,
    linkedVorgangId: item.vorgangId,
    linkedVorgangTitle: item.vorgangTitle,
  };
}

export function findExistingOpenTaskByDedupeKey(dedupeKey: string): Task | null {
  const match = findTasksInStore(
    (task) => task.dedupeKey === dedupeKey && isTaskOpen(task),
  );
  return match[0] ?? null;
}

export function proposeTasksFromClassification(
  item: InboxItem,
  profile?: CompanyProfile,
): TaskProposal[] {
  if (!isDocumentAnalysisAllowed(item, profile)) return [];

  const classification = getClassificationForItem(item);
  const kind = classification.classifiedKind;
  const dueDate = item.deadline ?? classification.deadline ?? undefined;
  const links = baseInboxLinks(item);
  const proposals: TaskProposal[] = [];

  const push = (proposal: Omit<TaskProposal, 'sourceType' | 'sourceId'> & { taskKind: string }) => {
    proposals.push({
      ...links,
      sourceType: 'classification',
      sourceId: item.id,
      autoCreated: false,
      ...proposal,
    });
  };

  if (kind === 'mahnung' || kind === 'zahlungserinnerung') {
    push({
      title: 'Zahlung prüfen',
      description: `${classification.title} – offenen Betrag prüfen`,
      priority: 'kritisch',
      category: 'zahlungen',
      dueDate,
      taskKind: 'payment_check',
      type: 'dokument_pruefen',
    });
  }

  if (['bg_bau', 'aok', 'soka_bau', 'finanzamt'].includes(kind)) {
    push({
      title: 'Behörden-Schreiben prüfen',
      description: classification.explanation,
      priority: kind === 'finanzamt' ? 'hoch' : 'mittel',
      category: 'behoerden',
      dueDate,
      taskKind: `authority_review:${kind}`,
      type: 'dokument_pruefen',
    });
  }

  if (kind === 'freistellungsbescheinigung') {
    push({
      title: 'Gültigkeit der Freistellungsbescheinigung prüfen',
      description: classification.explanation,
      priority: 'hoch',
      category: 'steuern',
      dueDate: item.recognizedData.Gültig_bis ?? dueDate,
      taskKind: 'monitor_freistellung_validity',
      type: 'steuerberater_export',
    });
    push({
      title: 'Freistellungsbescheinigung an Auftraggeber senden',
      description: 'Bescheinigung bereithalten und Versand nach Bestätigung vorbereiten',
      priority: 'mittel',
      category: 'steuern',
      taskKind: 'send_freistellung_to_client',
      type: 'steuerberater_export',
    });
  }

  if (kind === 'abnahmeprotokoll') {
    push({
      title: 'Schlussrechnung prüfen',
      description: 'Abnahmeprotokoll vorhanden – Vorgang abschließen und Schlussrechnung vorbereiten',
      priority: 'hoch',
      category: 'rechnungen',
      dueDate,
      taskKind: 'review_schlussrechnung',
      type: 'rechnung_vorbereiten',
    });
  }

  return proposals;
}

export function proposeTaskFromInboxTemplate(
  item: InboxItem,
  template: InboxTaskTemplate,
  options: { autoCreated?: boolean } = {},
): TaskProposal {
  return {
    title: template.title,
    description: template.description,
    priority: item.priority,
    category: mapTaskTypeToCategory(template.type),
    dueDate: template.dueDate ?? item.deadline ?? undefined,
    linkedInboxId: item.id,
    linkedVorgangId: item.vorgangId ?? template.vorgangId,
    linkedVorgangTitle: item.vorgangTitle ?? template.vorgangTitle,
    sourceType: 'inbox',
    sourceId: item.id,
    taskKind: `inbox_template:${template.type}`,
    dedupeKey: `inbox:${item.id}:follow_up`,
    autoCreated: options.autoCreated ?? false,
    type: template.type,
  };
}

export function proposePrimaryInboxTask(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): TaskProposal | null {
  if (!isDocumentAnalysisAllowed(item, profile)) return null;

  const classificationProposals = proposeTasksFromClassification(item, profile);
  if (classificationProposals.length > 0) {
    return {
      ...classificationProposals[0],
      dedupeKey: `inbox:${item.id}:follow_up`,
      autoCreated: options.autoCreated ?? false,
    };
  }

  if (!item.taskTemplate) return null;
  return proposeTaskFromInboxTemplate(item, item.taskTemplate, options);
}

export function proposeTasksFromContract(
  analysis: ContractAnalysisResult,
  inboxId: string,
): TaskProposal[] {
  if (!analysis.isContract || analysis.requiredDocuments.length === 0) return [];

  return analysis.requiredDocuments.map((doc: RequiredDocument) => ({
    title: `Nachweis beschaffen: ${doc.type.replace(/_/g, ' ')}`,
    description: doc.reason,
    priority: doc.priority,
    category: mapRequiredDocToCategory(doc.type),
    linkedInboxId: inboxId,
    sourceType: 'contract',
    sourceId: inboxId,
    taskKind: `required_doc:${doc.type}`,
    autoCreated: false,
    type: 'dokument_pruefen' as TaskType,
  }));
}

export function proposeTasksFromOverdueInvoices(today?: Date | string): TaskProposal[] {
  return getOverdueInvoices(today).map((entry) => ({
    title: `Zahlung prüfen: Rechnung ${entry.invoice.number}`,
    description: `Überfällige Ausgangsrechnung für ${entry.customer} – offener Betrag ${entry.paymentSummary.openAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`,
    priority: entry.paymentSummary.openAmount >= 1000 ? ('kritisch' as const) : ('hoch' as const),
    category: 'zahlungen' as TaskCategory,
    dueDate: entry.invoice.paymentDueDate,
    linkedVorgangId: entry.vorgangId,
    linkedVorgangTitle: entry.vorgangTitle,
    linkedInvoiceId: entry.invoice.id,
    sourceType: 'invoice',
    sourceId: entry.invoice.id,
    taskKind: 'payment_overdue',
    autoCreated: true,
    type: 'dokument_pruefen' as TaskType,
  }));
}

function proposalToTask(proposal: TaskProposal): Task {
  const dedupeKey = buildDedupeKey(proposal);
  const now = new Date().toISOString();
  return normalizeTask({
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: proposal.title,
    description: proposal.description,
    status: 'open',
    priority: proposal.priority,
    category: proposal.category,
    dueDate: proposal.dueDate,
    linkedVorgangId: proposal.linkedVorgangId,
    linkedVorgangTitle: proposal.linkedVorgangTitle,
    linkedInboxId: proposal.linkedInboxId,
    linkedDocumentId: proposal.linkedDocumentId,
    linkedInvoiceId: proposal.linkedInvoiceId,
    sourceType: proposal.sourceType,
    sourceId: proposal.sourceId,
    taskKind: proposal.taskKind,
    dedupeKey,
    autoCreated: proposal.autoCreated ?? false,
    createdAt: now,
    type: proposal.type ?? 'dokument_pruefen',
  });
}

export function createTaskFromProposal(proposal: TaskProposal): Task {
  const dedupeKey = buildDedupeKey(proposal);
  const existing = findExistingOpenTaskByDedupeKey(dedupeKey);
  if (existing) return { ...existing };

  const task = proposalToTask({ ...proposal, dedupeKey });
  appendTaskToStore(task);
  return { ...task };
}

export function createTasksFromProposals(proposals: TaskProposal[]): Task[] {
  return proposals.map((proposal) => createTaskFromProposal(proposal));
}

export function createTaskFromInboxItem(
  item: InboxItem,
  profile?: CompanyProfile,
  options: { autoCreated?: boolean } = {},
): Task | null {
  const proposal = proposePrimaryInboxTask(item, profile, options);
  if (!proposal) return null;
  return createTaskFromProposal(proposal);
}

export function createTasksFromContractAnalysis(
  analysis: ContractAnalysisResult,
  inboxId: string,
): Task[] {
  return createTasksFromProposals(proposeTasksFromContract(analysis, inboxId));
}

export function syncOverdueInvoiceTasks(today?: Date | string): Task[] {
  return createTasksFromProposals(proposeTasksFromOverdueInvoices(today));
}

export function completeTask(taskId: string): Task | null {
  return replaceTaskInStore(taskId, (task) => {
    if (!isTaskOpen(task)) return task;
    return normalizeTask({
      ...task,
      status: 'done',
      completedAt: new Date().toISOString(),
      done: true,
    });
  });
}

export function reopenTask(taskId: string): Task | null {
  return replaceTaskInStore(taskId, (task) => {
    if (task.status !== 'done') return task;
    return normalizeTask({
      ...task,
      status: 'open',
      completedAt: undefined,
      done: false,
    });
  });
}

export function archiveTask(taskId: string): Task | null {
  return replaceTaskInStore(taskId, (task) =>
    normalizeTask({
      ...task,
      status: 'archived',
      completedAt: task.completedAt ?? new Date().toISOString(),
      done: true,
    }),
  );
}

export function toggleTaskCompletion(taskId: string): Task | null {
  const task = getAllTasksFromStore().find((t) => t.id === taskId);
  if (!task) return null;
  if (isTaskOpen(task)) return completeTask(taskId);
  if (task.status === 'done') return reopenTask(taskId);
  return task;
}

export function getTasksFiltered(
  filter: TaskFilter,
  today: Date | string = new Date(),
): Task[] {
  const todayIso = getTodayIso(today);
  const all = getAllTasksFromStore();

  switch (filter) {
    case 'offen':
      return all.filter(isTaskOpen);
    case 'heute':
      return all.filter((task) => isTaskOpen(task) && task.dueDate && task.dueDate <= todayIso);
    case 'ueberfaellig':
      return all.filter((task) => isTaskOpen(task) && task.dueDate && task.dueDate < todayIso);
    case 'kritisch':
      return all.filter((task) => isTaskOpen(task) && task.priority === 'kritisch');
    case 'erledigt':
      return all.filter(isTaskDone);
    default:
      return all;
  }
}

export function getTaskSummary(today: Date | string = new Date()): TaskSummary {
  const todayIso = getTodayIso(today);
  const all = getAllTasksFromStore();
  const openTasks = all.filter(isTaskOpen);
  return {
    open: openTasks.length,
    today: openTasks.filter((t) => t.dueDate && t.dueDate <= todayIso).length,
    overdue: openTasks.filter((t) => t.dueDate && t.dueDate < todayIso).length,
    critical: openTasks.filter((t) => t.priority === 'kritisch').length,
    done: all.filter(isTaskDone).length,
    total: all.length,
  };
}

export function isClassificationKindWithTasks(kind: ClassifiedDocumentKind): boolean {
  return (
    kind === 'mahnung' ||
    kind === 'zahlungserinnerung' ||
    kind === 'freistellungsbescheinigung' ||
    kind === 'abnahmeprotokoll' ||
    ['bg_bau', 'aok', 'soka_bau', 'finanzamt'].includes(kind)
  );
}
