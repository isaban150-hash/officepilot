import { MOCK_TASKS } from '../data/mockData';
import type { Task } from '../types/models';
import { normalizeTask } from './taskNormalize';
import { persistAll } from './persistenceService';

let tasks: Task[] = [];

function cloneTasks(items: Task[]): Task[] {
  return items.map((t) => ({ ...t }));
}

export function getTaskStoreSnapshot(): Task[] {
  return cloneTasks(tasks);
}

export function hydrateTaskStore(items: Task[]): void {
  tasks = items.map((item) => normalizeTask(item));
}

export function getAllTasksFromStore(): Task[] {
  return cloneTasks(tasks);
}

export function findTasksInStore(predicate: (task: Task) => boolean): Task[] {
  return tasks.filter(predicate).map((t) => ({ ...t }));
}

export function appendTaskToStore(task: Task): void {
  tasks = [...tasks, { ...task }];
  persistAll();
}

export function replaceTaskInStore(
  taskId: string,
  updater: (task: Task) => Task,
): Task | null {
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return null;
  const updated = normalizeTask(updater({ ...tasks[index] }));
  tasks = [...tasks.slice(0, index), updated, ...tasks.slice(index + 1)];
  persistAll();
  return { ...updated };
}

export function resetTasks(): void {
  tasks = (MOCK_TASKS as Array<Partial<Task> & Pick<Task, 'id' | 'title'>>).map((t) =>
    normalizeTask(t),
  );
}

export function setTaskStoreForTests(items: Task[]): void {
  tasks = items.map((item) => normalizeTask(item));
}
