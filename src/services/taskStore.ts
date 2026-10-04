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
  return tasks.filter((task) => !task.sync?.deleted).map((t) => ({ ...t }));
}

/** 01C — Ersetzt den gesamten Aufgabenbestand (Dedupe-Aufloesung nach Push/Pull). */
export function replaceAllTasksInStore(items: Task[]): void {
  tasks = items.map((item) => normalizeTask(item));
  persistAll();
}

export function findTasksInStore(predicate: (task: Task) => boolean): Task[] {
  return tasks.filter(predicate).map((t) => ({ ...t }));
}

/**
 * TAGESARBEIT-V1 — Erfolg heisst dauerhaft gespeichert.
 *
 * Bis hierher riefen `appendTaskToStore` und `replaceTaskInStore` zwar
 * `persistAll()`, **prueften dessen Ergebnis aber nicht** und meldeten in jedem
 * Fall Erfolg. Solange Aufgaben nur automatisch entstanden, fiel das kaum auf:
 * Die naechste Ableitung legte sie ohnehin wieder an. Sobald der Nutzer selbst
 * eine Aufgabe tippt, ist derselbe Fehler die unangenehmste Form davon — der
 * Dialog schliesst sich zufrieden, und nach dem Neuladen ist die Aufgabe weg.
 *
 * Dieselbe Zusicherung, die `commitVorgangMutation` auf der Auftragsseite seit
 * ORDER-POSITION-CREATE-PERSIST-01B traegt: ein Commit-Punkt, und bei
 * fehlgeschlagener Persistenz faellt der vorherige Stand zurueck. Bewusst
 * **nur** fuer die Aufgaben-Schreibwege; die uebrigen Stores bleiben, wie sie
 * sind.
 */
export type TaskStoreWriteResult =
  | { ok: true; task: Task }
  | { ok: false; errorKey: 'task.persistFailed' | 'task.notFound' };

/**
 * Schreibt und gibt den Zustand bei fehlgeschlagener Persistenz zurueck.
 *
 * Der Ruecksetzer arbeitet auf dem **vorherigen Feld**, nicht auf einer Kopie
 * der einzelnen Aufgabe: Nur so ist der Speicher danach exakt der, der auch auf
 * der Platte steht — und nicht eine dritte Variante.
 */
function commitTasks(next: Task[], result: Task): TaskStoreWriteResult {
  const previous = tasks;
  tasks = next;
  if (!persistAll().success) {
    tasks = previous;
    return { ok: false, errorKey: 'task.persistFailed' };
  }
  return { ok: true, task: { ...result } };
}

/**
 * Legt eine Aufgabe an. Bei fehlgeschlagener Persistenz bleibt der Bestand
 * unveraendert — es entsteht kein Phantom im Arbeitsspeicher.
 */
export function appendTaskToStore(task: Task): TaskStoreWriteResult {
  return commitTasks([...tasks, { ...task }], task);
}

export function replaceTaskInStore(
  taskId: string,
  updater: (task: Task) => Task,
): Task | null {
  const result = replaceTaskInStoreChecked(taskId, updater);
  return result.ok ? result.task : null;
}

/**
 * Wie `replaceTaskInStore`, nennt dem Aufrufer aber den Grund.
 *
 * 01C — lokale Fachaenderung (erledigen, wieder oeffnen, archivieren, Frist
 * setzen) laesst `sync` unberuehrt, wie bei Vorgang, Kunde und Vorgangsnotiz.
 * Ein selbst erhoehter Wert wuerde vom Server als Versionskonflikt abgewiesen
 * und die Aenderung nie auf dem zweiten Geraet ankommen lassen.
 */
export function replaceTaskInStoreChecked(
  taskId: string,
  updater: (task: Task) => Task,
): TaskStoreWriteResult {
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return { ok: false, errorKey: 'task.notFound' };

  const updated = normalizeTask(updater({ ...tasks[index] }));
  const next = [...tasks.slice(0, index), updated, ...tasks.slice(index + 1)];
  return commitTasks(next, updated);
}

export function resetTasks(): void {
  tasks = (MOCK_TASKS as Array<Partial<Task> & Pick<Task, 'id' | 'title'>>).map((t) =>
    normalizeTask(t),
  );
}

export function setTaskStoreForTests(items: Task[]): void {
  tasks = items.map((item) => normalizeTask(item));
}
