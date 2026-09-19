/**
 * CLOUD-DURABILITY-CORE-01C — Cloud-Anbindung der Aufgaben.
 *
 * Diese Datei trägt ausschliesslich Transport und Identität: Payload,
 * Content-Key, Parsen der Serverzeile, Merge, Dedupe-Auflösung und
 * Backfill-Planung. Sie enthält **keine** Generatorlogik — welche Aufgabe aus
 * welchem Anlass entsteht, bleibt unverändert in `taskEngineService`.
 *
 * Die tragende Entscheidung dieses Blocks steht hier an einer Stelle:
 *
 * Die Aufgabenkennung bleibt eine zufällige Client-ID. Zwei Geräte, die
 * dieselbe automatische Aufgabe erzeugen, erzeugen deshalb zwei Kennungen —
 * aber nur **eine** darf überleben. Die geräteübergreifende fachliche Identität
 * ist der vorhandene `dedupeKey`, und sie gilt ausschliesslich für automatisch
 * erzeugte, fachlich aktive Aufgaben. Manuelle Aufgaben haben keine solche
 * Identität: Zwei Mitarbeiter, die unabhängig „Kunde anrufen" notieren, meinen
 * zwei Aufgaben, und Titel, Beschreibung oder Fälligkeit dürfen daran nichts
 * ändern.
 */
import { isTaskOpen, normalizeTask } from '../taskNormalize';
import { isCloudSyncBlockedMockTaskId } from '../storage/mockDataDetectionService';
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import {
  planLostAckAdoption,
  type LostAckAdoptionPlan,
  type LostAckRemoteRow,
  type LostAckSentWrite,
} from '../sync/syncLostAckAdoptionService';
import type { Task, TaskCategory, TaskPriority, TaskSourceType, TaskStatus } from '../../types/models';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_tasks` — exakt die Spalten der Migration. */
export interface WorkspaceTaskRow {
  id?: string;
  workspace_id: string;
  client_task_id: string;
  status: string;
  dedupe_key: string;
  auto_created: boolean;
  payload: Record<string, unknown>;
  row_version: number;
  deleted: boolean;
  deleted_at: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/**
 * Fachlicher Cloud-Payload einer Aufgabe — ohne jede Cloud-Metainformation und
 * ohne die abgeleiteten Legacy-Spiegel.
 *
 * Geprüft an `normalizeTask`: `vorgangId`, `vorgangTitle` und `done` werden dort
 * aus `linkedVorgangId`, `linkedVorgangTitle` und `status` **abgeleitet** und
 * gehören deshalb nicht in die Cloud. `type` ist zwar ein Eingabefeld, dient
 * aber nur noch als Vorlage für die Kategorie und wird nirgends angezeigt; die
 * Kategorie selbst reist mit, es geht also nichts Sichtbares verloren.
 */
export interface TaskCloudPayload {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: TaskCategory;
  sourceType: TaskSourceType;
  taskKind: string;
  dedupeKey: string;
  autoCreated: boolean;
  createdAt: string;
  dueDate?: string;
  completedAt?: string;
  sourceId?: string;
  linkedVorgangId?: string;
  linkedVorgangTitle?: string;
  linkedInboxId?: string;
  linkedDocumentId?: string;
  linkedInvoiceId?: string;
}

const KNOWN_STATUS: TaskStatus[] = ['open', 'in_progress', 'done', 'archived'];
const ACTIVE_STATUS: TaskStatus[] = ['open', 'in_progress'];
const KNOWN_SOURCE_TYPES: TaskSourceType[] = [
  'inbox',
  'classification',
  'contract',
  'invoice',
  'manual',
  'system',
];
const KNOWN_PRIORITIES: TaskPriority[] = ['kritisch', 'hoch', 'mittel', 'niedrig'];
const KNOWN_CATEGORIES: TaskCategory[] = [
  'dokumente',
  'rechnungen',
  'zahlungen',
  'behoerden',
  'mitarbeiter',
  'baustelle',
  'fahrzeuge',
  'versicherungen',
  'steuern',
  'sonstiges',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Fachlich aktiv = offen oder in Arbeit; abgeleitet aus dem echten `TaskStatus`. */
export function isCloudActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_STATUS.includes(status);
}

/**
 * Trägt diese Aufgabe eine belastbare geräteübergreifende Identität?
 *
 * Nur dann darf der Server sie gegen eine gleichnamige Aufgabe eines anderen
 * Geräts entdoppeln. Drei Bedingungen, alle notwendig:
 *
 *  1. Sie ist automatisch entstanden. Manuelle Aufgaben werden **nie**
 *     entdoppelt, auch nicht bei gleichem Titel.
 *  2. Sie hat einen `dedupeKey`.
 *  3. Ihr `sourceId` ist eine geteilte Fachkennung — Rechnung, Eingang,
 *     Vorgang. `normalizeTask` setzt bei fehlender Quelle die **eigene
 *     Aufgabenkennung** ein; ein daraus gebauter Schlüssel ist auf jedem Gerät
 *     ein anderer und beweist gar nichts. Solche Altlasten bleiben getrennt,
 *     statt sie über Titel oder Datum zu raten.
 */
export function hasStableCloudDedupeIdentity(task: Task): boolean {
  if (!task.autoCreated) return false;
  if (!isNonEmptyString(task.dedupeKey)) return false;
  if (!isNonEmptyString(task.sourceId)) return false;
  if (task.sourceId === task.id) return false;
  return true;
}

/** Die Dedupe-Identität, wie sie in der Cloud-Spalte steht (leer = keine). */
export function buildCloudDedupeKey(task: Task): string {
  return hasStableCloudDedupeIdentity(task) ? task.dedupeKey : '';
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Content-Key wandern. Optionale Felder reisen nur
 * mit, wenn sie belegt sind — sonst unterschieden sich „Feld fehlt" und „Feld
 * ist undefined" im Schlüssel und lösten Schein-Pushes aus.
 */
export function stripTaskForCloud(task: Task): TaskCloudPayload {
  const payload: TaskCloudPayload = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    category: task.category,
    sourceType: task.sourceType,
    taskKind: task.taskKind,
    dedupeKey: task.dedupeKey,
    autoCreated: task.autoCreated,
    createdAt: task.createdAt,
  };
  if (isNonEmptyString(task.dueDate)) payload.dueDate = task.dueDate;
  if (isNonEmptyString(task.completedAt)) payload.completedAt = task.completedAt;
  if (isNonEmptyString(task.sourceId)) payload.sourceId = task.sourceId;
  if (isNonEmptyString(task.linkedVorgangId)) payload.linkedVorgangId = task.linkedVorgangId;
  if (isNonEmptyString(task.linkedVorgangTitle)) payload.linkedVorgangTitle = task.linkedVorgangTitle;
  if (isNonEmptyString(task.linkedInboxId)) payload.linkedInboxId = task.linkedInboxId;
  if (isNonEmptyString(task.linkedDocumentId)) payload.linkedDocumentId = task.linkedDocumentId;
  if (isNonEmptyString(task.linkedInvoiceId)) payload.linkedInvoiceId = task.linkedInvoiceId;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Push eine neue `row_version` zurück; flösse
 * sie hier ein, löste jede Rückschreibung den nächsten Push aus.
 */
export function buildTaskCloudContentKey(task: Task): string {
  return JSON.stringify(stripTaskForCloud(task));
}

/**
 * Push-Form: Identität, die drei serverseitig gebrauchten Merkmale und die
 * Nutzlast. `status`, `dedupe_key` und `auto_created` stehen als eigene Spalten,
 * weil der Eindeutigkeitsindex für aktive automatische Aufgaben sie braucht —
 * alles Übrige bleibt Payload.
 */
export function buildTaskCloudPushPayload(task: Task, deleted = false): Record<string, unknown> {
  return {
    task_id: task.id,
    status: task.status,
    dedupe_key: buildCloudDedupeKey(task),
    auto_created: task.autoCreated === true,
    payload: stripTaskForCloud(task),
    deleted,
  };
}

function resolveStatus(value: unknown): TaskStatus {
  return KNOWN_STATUS.includes(value as TaskStatus) ? (value as TaskStatus) : 'open';
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseTaskCloudPayload(
  payload: Record<string, unknown> | null,
): TaskCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id)) return null;

  const parsed: TaskCloudPayload = {
    id: inner.id,
    title: text(inner.title),
    description: text(inner.description),
    status: resolveStatus(inner.status),
    priority: KNOWN_PRIORITIES.includes(inner.priority as TaskPriority)
      ? (inner.priority as TaskPriority)
      : 'mittel',
    category: KNOWN_CATEGORIES.includes(inner.category as TaskCategory)
      ? (inner.category as TaskCategory)
      : 'dokumente',
    sourceType: KNOWN_SOURCE_TYPES.includes(inner.sourceType as TaskSourceType)
      ? (inner.sourceType as TaskSourceType)
      : 'system',
    taskKind: text(inner.taskKind) || 'legacy:dokument_pruefen',
    dedupeKey: text(inner.dedupeKey),
    autoCreated: inner.autoCreated === true,
    createdAt: text(inner.createdAt),
  };
  if (isNonEmptyString(inner.dueDate)) parsed.dueDate = inner.dueDate;
  if (isNonEmptyString(inner.completedAt)) parsed.completedAt = inner.completedAt;
  if (isNonEmptyString(inner.sourceId)) parsed.sourceId = inner.sourceId;
  if (isNonEmptyString(inner.linkedVorgangId)) parsed.linkedVorgangId = inner.linkedVorgangId;
  if (isNonEmptyString(inner.linkedVorgangTitle)) parsed.linkedVorgangTitle = inner.linkedVorgangTitle;
  if (isNonEmptyString(inner.linkedInboxId)) parsed.linkedInboxId = inner.linkedInboxId;
  if (isNonEmptyString(inner.linkedDocumentId)) parsed.linkedDocumentId = inner.linkedDocumentId;
  if (isNonEmptyString(inner.linkedInvoiceId)) parsed.linkedInvoiceId = inner.linkedInvoiceId;
  return parsed;
}

export function mapWorkspaceTaskRow(row: WorkspaceTaskRow): {
  taskId: string;
  payload: TaskCloudPayload | null;
  dedupeKey: string;
  autoCreated: boolean;
  status: TaskStatus;
  rowVersion: number;
  deleted: boolean;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_task_id)) return null;
  const parsed = parseTaskCloudPayload(row.payload);
  // Ein Grabstein ohne Fachinhalt bleibt gültig — ohne ihn käme die Löschung nie an.
  if (!parsed && !row.deleted) return null;
  return {
    taskId: row.client_task_id,
    payload: parsed,
    dedupeKey: row.dedupe_key ?? '',
    autoCreated: Boolean(row.auto_created),
    status: resolveStatus(row.status ?? parsed?.status),
    rowVersion: Number(row.row_version),
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

/** Cloud-Zeile → Aufgabe: immer über `normalizeTask`, damit die Legacy-Spiegel stimmen. */
export function taskFromCloud(
  taskId: string,
  payload: TaskCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Task {
  return normalizeTask({
    ...payload,
    id: taskId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : undefined,
      deviceId,
      workspaceId,
    },
  });
}

/**
 * Zeilenweiser Merge nach `task.id`, aufgebaut auf der vorhandenen
 * `mergeSyncEntities`-Engine. Kein Feld-Merge und **keine** Sonderregel
 * „erledigt gewinnt": Wiederöffnen bleibt möglich, die Serverversion
 * entscheidet. Gleiche Version mit abweichendem fachlichem Inhalt meldet einen
 * Konflikt, statt eine ungesynchronisierte lokale Änderung zu verwerfen.
 *
 * SYNC-DURABILITY-HARDENING-01G — `dirtyIds` sind die Kennungen, für die ein
 * **offener Sendeauftrag** in der Outbox liegt: lokale Arbeit, die der Server
 * noch nicht gesehen hat. Sie ist der Grund, warum der Pull nicht einfach der
 * höheren Serverversion folgen darf.
 *
 * `sync.version` ist ausschliesslich die zuletzt **bestätigte** Serverversion;
 * eine lokale Änderung erhöht sie nicht. Eine ungesendete Änderung sieht damit
 * aus wie ein unveränderter Datensatz — und wurde bisher von einer neueren
 * Serverfassung stillschweigend ersetzt. Ist die Entität offen, meldet der Merge
 * stattdessen einen Konflikt; der Aufrufer verwirft dann den gesamten
 * Merge-Vorschlag und die lokale Fassung bleibt stehen, bis der Push sie sendet.
 */
export function mergeTasksFromPull(
  localTasks: Task[],
  remoteRows: WorkspaceTaskRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { tasks: Task[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localTasks.map((task) => [task.id, task]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceTaskRow(row);
    if (!mapped) continue;

    if (mapped.deleted) {
      // Anderswo aufgelöst oder gelöscht: hier verschwindet die Aufgabe —
      // ausser sie trägt noch ungesendete lokale Arbeit (01G).
      if (dirtyIds.has(mapped.taskId) && byId.has(mapped.taskId)) {
        conflicts.push(`task:${mapped.taskId}`);
        continue;
      }
      byId.delete(mapped.taskId);
      continue;
    }
    if (!mapped.payload) continue;

    const local = byId.get(mapped.taskId) ?? null;
    const remote = taskFromCloud(
      mapped.taskId,
      mapped.payload,
      mapped.rowVersion,
      mapped.updatedAt,
      false,
      deviceId,
      workspaceId,
    );

    if (!local) {
      byId.set(remote.id, remote);
      continue;
    }
    if (local.sync?.deleted === true) continue;

    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (buildTaskCloudContentKey(local) === buildTaskCloudContentKey(remote)) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`task:${mapped.taskId}`);
      }
      continue;
    }

    /*
     * 01G/01G2 — offene lokale Änderung gegen abweichende Serverfassung.
     * Verglichen wird der fachliche Inhalt, nicht die Versionszahl: Nach einem
     * verlorenen ACK steht dort unsere eigene Fassung mit höherer Version, und
     * das ist kein Streit, sondern die fehlende Bestätigung.
     */
    if (dirtyIds.has(mapped.taskId) && mapped.rowVersion !== (local.sync?.version ?? 0)) {
      if (buildTaskCloudContentKey(local) !== buildTaskCloudContentKey(remote)) {
        conflicts.push(`task:${mapped.taskId}`);
        continue;
      }
      byId.set(remote.id, remote);
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'task');
    if (merged.conflict) {
      conflicts.push(`task:${mapped.taskId}`);
      continue;
    }
    const entity = merged.entity;
    if (entity) byId.set(entity.id, entity);
  }

  return { tasks: [...byId.values()], conflicts };
}

/**
 * Entdopplung im lokalen Bestand nach einem Pull.
 *
 * Fall: Gerät B hat die automatische Aufgabe selbst erzeugt (ID-B, noch nie
 * gesendet) und zieht danach die kanonische Zeile von Gerät A (ID-A). Beide
 * sind aktiv, beide tragen denselben `dedupeKey` — der Nutzer sähe dieselbe
 * Aufgabe zweimal.
 *
 * Kanonisch ist, was die Cloud kennt (bestätigte `sync.version`); bei
 * Gleichstand die ältere Aufgabe, bei identischem Zeitstempel die
 * lexikographisch kleinere Kennung. So entscheiden beide Geräte gleich.
 *
 * `protectedIds` sind Kennungen mit offenem Sendeauftrag. Sie werden **nicht**
 * still entfernt: Der Adapter fände die Entität sonst nicht mehr und liefe in
 * eine endlose Wiederholung. Für sie erledigt die serverseitige
 * Dedupe-Antwort die Auflösung beim nächsten Push.
 */
export function resolveLocalAutoTaskDuplicates(
  tasks: Task[],
  protectedIds: ReadonlySet<string> = new Set(),
): { tasks: Task[]; removedIds: string[] } {
  const byKey = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.sync?.deleted) continue;
    if (!hasStableCloudDedupeIdentity(task)) continue;
    if (!isTaskOpen(task)) continue;
    const list = byKey.get(task.dedupeKey);
    if (list) list.push(task);
    else byKey.set(task.dedupeKey, [task]);
  }

  const removedIds = new Set<string>();
  for (const candidates of byKey.values()) {
    if (candidates.length < 2) continue;
    const ranked = [...candidates].sort((a, b) => {
      const aKnown = (a.sync?.version ?? 0) > 0 ? 0 : 1;
      const bKnown = (b.sync?.version ?? 0) > 0 ? 0 : 1;
      if (aKnown !== bKnown) return aKnown - bKnown;
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      return a.id.localeCompare(b.id);
    });
    for (const loser of ranked.slice(1)) {
      if (protectedIds.has(loser.id)) continue;
      removedIds.add(loser.id);
    }
  }

  if (removedIds.size === 0) return { tasks, removedIds: [] };
  return {
    tasks: tasks.filter((task) => !removedIds.has(task.id)),
    removedIds: [...removedIds],
  };
}

/**
 * Serverseitige Dedupe-Antwort auf einen Push: Die eigene Aufgabe hat verloren.
 *
 * Die unterlegene Kennung wird **entfernt**, nicht als Grabstein behalten: Sie
 * hat die Cloud nie erreicht, es gibt dort nichts zu löschen, und ein Grabstein
 * ohne Serverzeile wäre ein Sendeauftrag ins Leere. Gefahrlos ist das, weil
 * Aufgabenkennungen ausserhalb des Aufgabenbestands nirgends dauerhaft
 * referenziert werden (geprüft: kein `linkedTaskId`, keine Fremdschlüssel;
 * `taskCreated` ist nur eine kurzlebige Rückmeldung für den Hinweistext).
 */
export function applyTaskDedupeResolutionToState(
  tasks: Task[],
  losingTaskId: string,
  canonical: Task,
): Task[] {
  const withoutLoser = tasks.filter((task) => task.id !== losingTaskId);
  const index = withoutLoser.findIndex((task) => task.id === canonical.id);
  if (index < 0) return [...withoutLoser, canonical];
  return [
    ...withoutLoser.slice(0, index),
    canonical,
    ...withoutLoser.slice(index + 1),
  ];
}

/**
 * Altbestand — Aufgaben aus der Zeit vor 01C. Der Change-Tracker meldet sie nie
 * nach, weil er den vorhandenen Stand beim Start zur Basislinie macht. Es
 * entsteht trotzdem keine Sondermigration: Die geplanten Kennungen gehen durch
 * dieselbe `enqueueSyncOutbox`-Tür wie jede normale Änderung.
 *
 * Verglichen wird gegen **alle** Remote-Kennungen inklusive Grabsteine, sonst
 * lüde ein zweites Gerät eine anderswo entfernte Aufgabe wieder hoch.
 * Demo-Aufgaben bleiben lokal.
 */
export function planTaskBackfill(localTasks: Task[], remoteRows: WorkspaceTaskRow[]): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.client_task_id));
  return localTasks
    .filter((task) => !task.sync?.deleted)
    .filter((task) => !isCloudSyncBlockedMockTaskId(task.id))
    .filter((task) => !remoteIds.has(task.id))
    .map((task) => task.id);
}

/** Setzt nach erfolgreichem Push die Serverversion — ohne Fachdaten anzufassen. */
export function applyTaskPushResultToState(
  tasks: Task[],
  taskId: string,
  rowVersion: number,
  updatedAt: string,
  deleted: boolean,
  deviceId: string,
  workspaceId: string,
): Task[] {
  return tasks.map((task) => {
    if (task.id !== taskId) return task;
    const sync: SyncMeta = {
      updatedAt,
      version: rowVersion,
      deleted,
      deletedAt: deleted ? updatedAt : task.sync?.deletedAt,
      deviceId,
      workspaceId,
    };
    return { ...task, sync };
  });
}

/**
 * SYNC-DURABILITY-HARDENING-01G4 — Wiederanlauf nach verlorener Bestätigung.
 *
 * Gleiche Lage wie bei den Vorgangsnotizen: Ohne diesen Weg bliebe eine
 * Aufgabe, deren Anlege- oder Änderungsbestätigung im Funkloch verschwand, mit
 * einem stillgelegten Sendeauftrag zurück, sobald der Nutzer danach noch etwas
 * an ihr geändert hat. Die Bewertung liegt in `planLostAckAdoption`; hier wird
 * nur die Serverzeile in die dort erwartete Form gebracht.
 */
export function planTaskLostAckAdoption(
  localTasks: Task[],
  remoteRows: WorkspaceTaskRow[],
  activeOutboxTaskIds: ReadonlySet<string>,
  sentWrites?: ReadonlyMap<string, LostAckSentWrite>,
): LostAckAdoptionPlan {
  const remotes = new Map<string, LostAckRemoteRow>();
  for (const row of remoteRows) {
    const mapped = mapWorkspaceTaskRow(row);
    if (!mapped) continue;
    remotes.set(mapped.taskId, {
      rowVersion: mapped.rowVersion,
      deleted: mapped.deleted,
      contentKey: mapped.payload
        ? buildTaskCloudContentKey(
            taskFromCloud(mapped.taskId, mapped.payload, mapped.rowVersion, mapped.updatedAt, false, '', ''),
          )
        : undefined,
    });
  }
  return planLostAckAdoption(localTasks, remotes, activeOutboxTaskIds, {
    sentWrites,
    localContentKey: buildTaskCloudContentKey,
  });
}
