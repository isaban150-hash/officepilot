import type {
  Task,
  TaskCategory,
  TaskSourceType,
  TaskStatus,
  TaskType,
} from '../types/models';

const OPEN_STATUSES: TaskStatus[] = ['open', 'in_progress'];

export function isTaskOpen(task: Pick<Task, 'status'>): boolean {
  return OPEN_STATUSES.includes(task.status);
}

export function isTaskDone(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done' || task.status === 'archived';
}

export function buildDedupeKey(
  proposal: { sourceType: TaskSourceType; sourceId?: string; taskKind: string; dedupeKey?: string },
): string {
  if (proposal.dedupeKey) return proposal.dedupeKey;
  return `${proposal.sourceType}:${proposal.sourceId ?? 'none'}:${proposal.taskKind}`;
}

export function normalizeTask(raw: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  const status: TaskStatus =
    raw.status ?? (raw.done === true ? 'done' : 'open');
  const linkedVorgangId = raw.linkedVorgangId ?? raw.vorgangId;
  const linkedVorgangTitle = raw.linkedVorgangTitle ?? raw.vorgangTitle;
  const type: TaskType = raw.type ?? 'dokument_pruefen';
  const taskKind = raw.taskKind ?? `legacy:${type}`;
  const sourceType = raw.sourceType ?? 'system';
  const sourceId = raw.sourceId ?? raw.id;
  const dedupeKey = raw.dedupeKey ?? buildDedupeKey({ sourceType, sourceId, taskKind });
  const createdAt = raw.createdAt ?? new Date().toISOString();

  return {
    id: raw.id,
    title: raw.title,
    description: raw.description ?? raw.title,
    status,
    priority: raw.priority ?? 'mittel',
    category: raw.category ?? mapTaskTypeToCategory(type),
    dueDate: raw.dueDate,
    linkedVorgangId,
    linkedVorgangTitle,
    linkedInboxId: raw.linkedInboxId,
    linkedDocumentId: raw.linkedDocumentId,
    linkedInvoiceId: raw.linkedInvoiceId,
    sourceType,
    sourceId,
    taskKind,
    dedupeKey,
    autoCreated: raw.autoCreated ?? false,
    createdAt,
    completedAt:
      raw.completedAt ??
      (status === 'done' || status === 'archived' ? createdAt : undefined),
    type,
    vorgangId: linkedVorgangId,
    vorgangTitle: linkedVorgangTitle,
    done: isTaskDone({ status }),
  };
}

export function mapTaskTypeToCategory(type: TaskType): TaskCategory {
  switch (type) {
    case 'rechnung_vorbereiten':
      return 'rechnungen';
    case 'steuerberater_export':
    case 'kontoauszug_hochladen':
      return 'steuern';
    default:
      return 'dokumente';
  }
}

export function getTodayIso(referenceDate?: Date | string): string {
  if (referenceDate instanceof Date) {
    return referenceDate.toISOString().slice(0, 10);
  }
  if (typeof referenceDate === 'string' && referenceDate.length >= 10) {
    return referenceDate.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}
