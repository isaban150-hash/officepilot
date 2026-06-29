/**
 * @deprecated Legacy-Wrapper. Neue Aufrufe direkt über `taskEngineService` und `taskStore`.
 */
import type { InboxItem, InboxTaskTemplate, Task } from '../types/models';
import {
  createTaskFromInboxItem,
  completeTask,
  getTasksFiltered,
  reopenTask,
  toggleTaskCompletion,
} from './taskEngineService';
import { isTaskOpen } from './taskNormalize';
import { getAllTasksFromStore } from './taskStore';

/** @deprecated Use `taskStore` exports directly. */
export {
  getTaskStoreSnapshot,
  hydrateTaskStore,
  resetTasks,
} from './taskStore';

/** @deprecated Use `taskEngineService.completeTask`. */
export { completeTask, reopenTask };

/** @deprecated Use `getAllTasksFromStore` from `taskStore`. */
export function getAllTasks(): Task[] {
  return getAllTasksFromStore();
}

/** @deprecated Use `getAllTasksFromStore` with `isTaskOpen`. */
export function getOpenTasks(): Task[] {
  return getAllTasksFromStore().filter(isTaskOpen);
}

/** @deprecated Use `toggleTaskCompletion` from `taskEngineService`. */
export function toggleTaskDone(taskId: string): Task[] {
  toggleTaskCompletion(taskId);
  return getAllTasks();
}

/** @deprecated Use `getTasksFiltered` from `taskEngineService`. */
export function getTodayTasks(referenceDate?: Date | string): Task[] {
  return getTasksFiltered('heute', referenceDate ?? new Date());
}

/** @deprecated Use `createTaskFromInboxItem` from `taskEngineService`. */
export function addTaskFromTemplate(
  template: InboxTaskTemplate,
  sourceInboxId: string,
  itemOverrides: Partial<InboxItem> = {},
): Task {
  const item = {
    id: sourceInboxId,
    title: template.description,
    documentType: 'sonstiges' as const,
    sender: '',
    priority: 'mittel' as const,
    deadline: template.dueDate ?? null,
    recommendedAction: 'zuordnen' as const,
    digitalFolder: { id: 'd', name: 'n', path: '/' },
    paperFiling: { folderId: 'folder-1', register: 'A', label: 'x' },
    status: 'neu' as const,
    receivedAt: new Date().toISOString().slice(0, 10),
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: template.title,
    securityHint: '',
    taskTemplate: template,
    vorgangId: template.vorgangId,
    vorgangTitle: template.vorgangTitle,
    ...itemOverrides,
  } satisfies InboxItem;

  const created = createTaskFromInboxItem(item);
  if (!created) {
    throw new Error('Task could not be created from template');
  }
  return created;
}
