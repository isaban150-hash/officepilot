import { MOCK_TASKS } from '../data/mockData';
import type { InboxTaskTemplate, Task } from '../types/models';
import { persistAll } from './persistenceService';

let tasks: Task[] = [];

export function getTaskStoreSnapshot(): Task[] {
  return tasks.map((t) => ({ ...t }));
}

export function hydrateTaskStore(items: Task[]): void {
  tasks = items.map((t) => ({ ...t }));
}

export function getAllTasks(): Task[] {
  return tasks.map((t) => ({ ...t }));
}

export function getOpenTasks(): Task[] {
  return tasks.filter((t) => !t.done);
}

export function toggleTaskDone(taskId: string): Task[] {
  tasks = tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t));
  persistAll();
  return getAllTasks();
}

export function getTodayTasks(): Task[] {
  const today = '2026-03-27';
  return tasks.filter((t) => !t.done && t.dueDate && t.dueDate <= today);
}

export function addTaskFromTemplate(template: InboxTaskTemplate, sourceInboxId: string): Task {
  const newTask: Task = {
    id: `t-${Date.now()}`,
    type: template.type,
    title: template.title,
    description: `${template.description} (aus Eingang ${sourceInboxId})`,
    vorgangId: template.vorgangId,
    vorgangTitle: template.vorgangTitle,
    done: false,
    dueDate: template.dueDate,
  };
  tasks = [...tasks, newTask];
  persistAll();
  return { ...newTask };
}

export function resetTasks(): void {
  tasks = MOCK_TASKS.map((t) => ({ ...t }));
}
