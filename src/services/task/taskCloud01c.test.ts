/**
 * CLOUD-DURABILITY-CORE-01C — Aufgaben überleben das Gerät, ohne sich zu
 * verdoppeln.
 *
 * Aufgaben waren rein lokal. Anders als Notizen entstehen sie **maschinell**:
 * Die Engine legt beim Öffnen der Aufgabenseite für jede überfällige Rechnung
 * eine an — auf jedem Gerät erneut, mit je eigener Kennung. Cloud-Durability
 * ohne Entdopplung hieße also: dieselbe Aufgabe doppelt, auf Dauer.
 *
 * **Drei Punkte tragen diesen Block und werden deshalb hart geprüft:**
 *
 * Erstens der Versionsvertrag. Vorher setzte die Anlage `version: 1` und jede
 * Statusänderung erhöhte sie — beides Behauptungen, die der Server nie
 * bestätigt hat. Erledigen wäre auf dem zweiten Gerät nie angekommen.
 *
 * Zweitens die Identität. Die Kennung bleibt zufällig; geräteübergreifend gilt
 * der fachliche `dedupeKey`, und zwar **nur** für automatische, aktive
 * Aufgaben. Zwei manuelle „Kunde anrufen" bleiben zwei Aufgaben.
 *
 * Drittens die Auflösung. Verliert die eigene Aufgabe gegen die kanonische der
 * Cloud, verschwindet sie aus dem Bestand — sonst stünde sie doppelt in der
 * Liste, und der nächste Backfill lüde sie erneut hoch.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTaskDedupeResolutionToState,
  applyTaskPushResultToState,
  buildCloudDedupeKey,
  buildTaskCloudContentKey,
  buildTaskCloudPushPayload,
  hasStableCloudDedupeIdentity,
  mapWorkspaceTaskRow,
  mergeTasksFromPull,
  planTaskBackfill,
  resolveLocalAutoTaskDuplicates,
  stripTaskForCloud,
  taskFromCloud,
  type WorkspaceTaskRow,
} from './taskCloudService';
import {
  LOCAL_ONLY_SYNC_ENTITY_TYPES,
  SUPABASE_SYNC_ALLOWLIST,
} from '../sync/cloudSyncAllowlist';
import { isCloudSyncBlockedMockTaskId } from '../storage/mockDataDetectionService';
import {
  completeTask,
  createTaskFromProposal,
  findExistingOpenTaskByDedupeKey,
  reopenTask,
} from '../taskEngineService';
import { normalizeTask } from '../taskNormalize';
import { setTaskStoreForTests } from '../taskStore';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { listEntitiesByType } from '../sync/syncEntityRegistry';
import type { AppPersistedState, Task, TaskProposal } from '../../types/models';
import type { SyncMeta } from '../../types/sync';

const DEVICE = 'device-01c';
const WORKSPACE = 'ws-01c';

function task(overrides: Partial<Task> = {}): Task {
  return normalizeTask({
    id: 't-auto-a',
    title: 'Zahlung prüfen: Rechnung 2026-0001',
    description: 'Überfällige Ausgangsrechnung',
    status: 'open',
    priority: 'hoch',
    category: 'zahlungen',
    sourceType: 'invoice',
    sourceId: 'inv-0001',
    taskKind: 'payment_overdue',
    dedupeKey: 'invoice:inv-0001:payment_overdue',
    autoCreated: true,
    createdAt: '2026-06-01T09:00:00.000Z',
    linkedInvoiceId: 'inv-0001',
    ...overrides,
  });
}

function manualTask(overrides: Partial<Task> = {}): Task {
  return normalizeTask({
    id: 't-manual-a',
    title: 'Kunde anrufen',
    description: 'Kunde anrufen',
    status: 'open',
    priority: 'mittel',
    category: 'sonstiges',
    sourceType: 'manual',
    sourceId: 'manual-src',
    taskKind: 'manual:call',
    dedupeKey: 'manual:manual-src:manual:call',
    autoCreated: false,
    createdAt: '2026-06-01T08:00:00.000Z',
    ...overrides,
  });
}

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: '2026-06-02T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function row(base: Task = task(), overrides: Partial<WorkspaceTaskRow> = {}): WorkspaceTaskRow {
  return {
    workspace_id: WORKSPACE,
    client_task_id: base.id,
    status: base.status,
    dedupe_key: buildCloudDedupeKey(base),
    auto_created: base.autoCreated,
    payload: stripTaskForCloud(base) as unknown as Record<string, unknown>,
    row_version: 1,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-06-02T10:00:00.000Z',
    updated_by: 'user-1',
    ...overrides,
  };
}

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    title: 'Zahlung prüfen: Rechnung 2026-0001',
    description: 'Überfällige Ausgangsrechnung',
    priority: 'hoch',
    category: 'zahlungen',
    sourceType: 'invoice',
    sourceId: 'inv-0001',
    taskKind: 'payment_overdue',
    autoCreated: true,
    type: 'dokument_pruefen',
    ...overrides,
  } as TaskProposal;
}

/* ------------------------------------------------------------------------ */
/* Versionsvertrag                                                           */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — Versionsvertrag', () => {
  beforeEach(() => setTaskStoreForTests([]));

  it('1: eine neu erzeugte automatische Aufgabe behauptet keine Serverversion', () => {
    const created = createTaskFromProposal(proposal());
    expect(created.sync?.version ?? 0).toBe(0);
  });

  it('2: eine manuell erzeugte Aufgabe ebenfalls nicht', () => {
    const created = createTaskFromProposal(
      proposal({ sourceType: 'manual', autoCreated: false, title: 'Kunde anrufen' }),
    );
    expect(created.sync?.version ?? 0).toBe(0);
    expect(created.autoCreated).toBe(false);
  });

  it('3: completeTask lässt die bestätigte Serverversion stehen', () => {
    const base = { ...task(), sync: syncMeta(4) };
    setTaskStoreForTests([base]);
    const done = completeTask(base.id);
    expect(done?.status).toBe('done');
    expect(done?.completedAt).toBeTruthy();
    expect(done?.sync?.version).toBe(4);
  });

  it('4: reopenTask lässt die bestätigte Serverversion stehen', () => {
    const base = { ...task({ status: 'done', completedAt: '2026-06-02T12:00:00.000Z' }), sync: syncMeta(7) };
    setTaskStoreForTests([base]);
    const reopened = reopenTask(base.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.sync?.version).toBe(7);
  });

  it('5: das Push-Ergebnis setzt ausschliesslich die Serverversion', () => {
    const tasks = applyTaskPushResultToState(
      [task()],
      't-auto-a',
      3,
      '2026-06-05T11:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
    );
    expect(tasks[0].title).toBe('Zahlung prüfen: Rechnung 2026-0001');
    expect(tasks[0].sync?.version).toBe(3);
  });
});

/* ------------------------------------------------------------------------ */
/* Content-Key                                                               */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — Content-Key', () => {
  it('6: der Cloud-Payload trägt keine Sync-Metadaten und keine Legacy-Spiegel', () => {
    const payload = stripTaskForCloud({ ...task(), sync: syncMeta(3) }) as Record<string, unknown>;
    expect('sync' in payload).toBe(false);
    expect('type' in payload).toBe(false);
    expect('vorgangId' in payload).toBe(false);
    expect('vorgangTitle' in payload).toBe(false);
    expect('done' in payload).toBe(false);
  });

  it('7: eine neue Serverversion ändert den Content-Key nicht (kein Echo-Push)', () => {
    const before = buildTaskCloudContentKey({ ...task(), sync: syncMeta(1) });
    const after = buildTaskCloudContentKey({ ...task(), sync: syncMeta(9) });
    expect(after).toBe(before);
  });

  it('8: jede fachliche Änderung ändert den Content-Key', () => {
    const base = task();
    const key = buildTaskCloudContentKey(base);
    const variants: Task[] = [
      task({ title: 'Anderer Titel' }),
      task({ description: 'Andere Beschreibung' }),
      task({ status: 'done', completedAt: '2026-06-02T12:00:00.000Z' }),
      task({ priority: 'kritisch' }),
      task({ category: 'rechnungen' }),
      task({ dueDate: '2026-07-01' }),
      task({ linkedVorgangId: 'v-1' }),
      task({ linkedInboxId: 'inbox-1' }),
      task({ linkedDocumentId: 'doc-1' }),
      task({ linkedInvoiceId: 'inv-9999' }),
      task({ sourceType: 'manual' }),
      task({ sourceId: 'inv-0002' }),
      task({ taskKind: 'payment_check' }),
      task({ dedupeKey: 'anders' }),
      task({ autoCreated: false }),
      task({ createdAt: '2026-06-02T09:00:00.000Z' }),
    ];
    for (const variant of variants) {
      expect(buildTaskCloudContentKey(variant), JSON.stringify(variant)).not.toBe(key);
    }
  });

  it('9: die Legacy-Spiegel allein ändern den Content-Key nicht', () => {
    const base = task();
    const mirrored = { ...base, type: 'rechnung_vorbereiten' as Task['type'], done: true, vorgangTitle: 'X' };
    expect(buildTaskCloudContentKey(mirrored)).toBe(buildTaskCloudContentKey(base));
  });
});

/* ------------------------------------------------------------------------ */
/* Identität und Dedupe-Semantik                                             */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — Identität', () => {
  it('10: eine automatische Aufgabe mit echter Quelle hat eine Dedupe-Identität', () => {
    expect(hasStableCloudDedupeIdentity(task())).toBe(true);
    expect(buildCloudDedupeKey(task())).toBe('invoice:inv-0001:payment_overdue');
  });

  it('11: manuelle Aufgaben tragen nie eine Dedupe-Identität', () => {
    expect(hasStableCloudDedupeIdentity(manualTask())).toBe(false);
    expect(buildCloudDedupeKey(manualTask())).toBe('');
  });

  it('12: Legacy ohne belastbare Quelle bleibt getrennt (sourceId = eigene Kennung)', () => {
    const legacy = normalizeTask({ id: 't-legacy-1', title: 'Dokument prüfen', autoCreated: true });
    expect(legacy.sourceId).toBe('t-legacy-1');
    expect(hasStableCloudDedupeIdentity(legacy)).toBe(false);
    expect(buildCloudDedupeKey(legacy)).toBe('');
  });

  it('13: die Push-Form trägt Status, Dedupe-Identität und Auto-Kennzeichen', () => {
    const payload = buildTaskCloudPushPayload(task());
    expect(payload.task_id).toBe('t-auto-a');
    expect(payload.status).toBe('open');
    expect(payload.dedupe_key).toBe('invoice:inv-0001:payment_overdue');
    expect(payload.auto_created).toBe(true);
    expect(payload.deleted).toBe(false);

    const manual = buildTaskCloudPushPayload(manualTask());
    expect(manual.dedupe_key).toBe('');
    expect(manual.auto_created).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Pull und Merge                                                            */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — Pull und Merge', () => {
  it('14: eine Cloud-Zeile wird vollständig und normalisiert gelesen', () => {
    const mapped = mapWorkspaceTaskRow(row(task(), { row_version: 4 }));
    expect(mapped?.taskId).toBe('t-auto-a');
    expect(mapped?.rowVersion).toBe(4);
    const pulled = taskFromCloud(
      mapped!.taskId,
      mapped!.payload!,
      mapped!.rowVersion,
      mapped!.updatedAt,
      false,
      DEVICE,
      WORKSPACE,
    );
    // normalizeTask füllt die Legacy-Spiegel wieder auf.
    expect(pulled.done).toBe(false);
    expect(pulled.type).toBeTruthy();
    expect(pulled.category).toBe('zahlungen');
    expect(pulled.sync?.version).toBe(4);
  });

  it('15: Serverspalten wandern nicht in den Fachdatensatz', () => {
    const mapped = mapWorkspaceTaskRow(
      row(task(), { payload: { ...(row().payload as object), workspace_id: WORKSPACE, row_version: 9 } }),
    );
    expect(mapped?.payload && 'workspace_id' in mapped.payload).toBe(false);
    expect(mapped?.payload && 'row_version' in mapped.payload).toBe(false);
  });

  it('16: eine unbekannte Cloud-Aufgabe kommt lokal an', () => {
    const merged = mergeTasksFromPull([], [row()], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.tasks.map((entry) => entry.id)).toEqual(['t-auto-a']);
  });

  it('17: die höhere Serverversion gewinnt — auch beim Wiederöffnen', () => {
    const local = { ...task({ status: 'done', completedAt: '2026-06-02T12:00:00.000Z' }), sync: syncMeta(1) };
    const remote = row(task({ status: 'open' }), { row_version: 2 });
    const merged = mergeTasksFromPull([local], [remote], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    // Keine Sonderregel „erledigt gewinnt": die Serverversion entscheidet.
    expect(merged.tasks[0].status).toBe('open');
    expect(merged.tasks[0].sync?.version).toBe(2);
  });

  it('18: gleiche Version mit abweichendem Inhalt ist ein Konflikt', () => {
    const local = { ...task({ title: 'Lokal geändert' }), sync: syncMeta(1) };
    const merged = mergeTasksFromPull([local], [row(task(), { row_version: 1 })], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual(['task:t-auto-a']);
  });

  it('19: gleiche Version mit gleichem Inhalt erzeugt keinen Konflikt', () => {
    const local = { ...task(), sync: syncMeta(1) };
    const merged = mergeTasksFromPull([local], [row(task(), { row_version: 1 })], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.tasks).toHaveLength(1);
  });

  it('20: ein Grabstein entfernt die Aufgabe auf diesem Gerät', () => {
    const local = { ...task(), sync: syncMeta(1) };
    const merged = mergeTasksFromPull(
      [local],
      [row(task(), { row_version: 2, deleted: true, payload: {} })],
      DEVICE,
      WORKSPACE,
    );
    expect(merged.tasks).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* Kanonische Auflösung                                                      */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — kanonische Auflösung', () => {
  it('21: die unterlegene eigene Aufgabe weicht der kanonischen Cloud-Aufgabe', () => {
    const own = task({ id: 't-auto-b', createdAt: '2026-06-01T09:00:03.000Z' });
    const canonical = { ...task({ id: 't-auto-a' }), sync: syncMeta(1) };
    const result = applyTaskDedupeResolutionToState([own], 't-auto-b', canonical);
    expect(result.map((entry) => entry.id)).toEqual(['t-auto-a']);
  });

  it('22: nach dem Pull bleibt von zwei gleichen automatischen Aufgaben eine übrig', () => {
    const canonical = { ...task({ id: 't-auto-a' }), sync: syncMeta(1) };
    const own = task({ id: 't-auto-b', createdAt: '2026-06-01T09:00:03.000Z' });
    const resolved = resolveLocalAutoTaskDuplicates([canonical, own]);
    expect(resolved.removedIds).toEqual(['t-auto-b']);
    expect(resolved.tasks.map((entry) => entry.id)).toEqual(['t-auto-a']);
  });

  it('23: eine Aufgabe mit offenem Sendeauftrag wird nicht still entfernt', () => {
    const canonical = { ...task({ id: 't-auto-a' }), sync: syncMeta(1) };
    const own = task({ id: 't-auto-b', createdAt: '2026-06-01T09:00:03.000Z' });
    const resolved = resolveLocalAutoTaskDuplicates([canonical, own], new Set(['t-auto-b']));
    expect(resolved.removedIds).toEqual([]);
    expect(resolved.tasks).toHaveLength(2);
  });

  it('24: zwei gleichnamige manuelle Aufgaben bleiben beide erhalten', () => {
    const a = manualTask({ id: 't-manual-a' });
    const b = manualTask({ id: 't-manual-b', createdAt: '2026-06-01T08:05:00.000Z' });
    const resolved = resolveLocalAutoTaskDuplicates([a, b]);
    expect(resolved.removedIds).toEqual([]);
    expect(resolved.tasks).toHaveLength(2);
  });

  it('25: eine erledigte und eine offene Episode desselben Schlüssels bleiben nebeneinander', () => {
    const done = { ...task({ id: 't-auto-a', status: 'done', completedAt: '2026-06-02T12:00:00.000Z' }), sync: syncMeta(2) };
    const fresh = task({ id: 't-auto-c', createdAt: '2026-06-03T09:00:00.000Z' });
    const resolved = resolveLocalAutoTaskDuplicates([done, fresh]);
    expect(resolved.removedIds).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* Engine-Dedupe                                                             */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — Engine-Dedupe', () => {
  beforeEach(() => setTaskStoreForTests([]));

  it('26: eine aus der Cloud gezogene Aufgabe verhindert die erneute Erzeugung', () => {
    const pulled = { ...task({ id: 't-auto-a' }), sync: syncMeta(1) };
    setTaskStoreForTests([pulled]);
    const created = createTaskFromProposal(proposal());
    expect(created.id).toBe('t-auto-a');
  });

  it('27: ein Grabstein gilt nicht als Dedupe-Treffer', () => {
    const tombstoned = {
      ...task({ id: 't-auto-a' }),
      sync: syncMeta(2, { deleted: true, deletedAt: '2026-06-04T07:00:00.000Z' }),
    };
    setTaskStoreForTests([tombstoned]);
    expect(findExistingOpenTaskByDedupeKey('invoice:inv-0001:payment_overdue')).toBeNull();
    const created = createTaskFromProposal(proposal());
    expect(created.id).not.toBe('t-auto-a');
  });

  it('28: eine erledigte Aufgabe erlaubt weiterhin eine neue Episode', () => {
    const first = createTaskFromProposal(proposal());
    completeTask(first.id);
    const second = createTaskFromProposal(proposal());
    expect(second.id).not.toBe(first.id);
  });
});

/* ------------------------------------------------------------------------ */
/* Altbestand, Demo-Aufgaben, Registrierung                                  */
/* ------------------------------------------------------------------------ */

describe('TASK-CLOUD-01C — Altbestand und Registrierung', () => {
  it('29: eine Bestandsaufgabe ohne Cloud-Zeile wird nachgemeldet', () => {
    expect(planTaskBackfill([task()], [])).toEqual(['t-auto-a']);
  });

  it('30: eine bereits hochgeladene Aufgabe wird nicht erneut gemeldet', () => {
    expect(planTaskBackfill([task()], [row()])).toEqual([]);
  });

  it('31: ein Remote-Grabstein zählt als vorhandene Kennung', () => {
    expect(planTaskBackfill([task()], [row(task(), { deleted: true, payload: {} })])).toEqual([]);
  });

  it('32: Demo-Aufgaben werden nie nachgemeldet', () => {
    const demo = normalizeTask({ id: 't-001', title: 'Dokument prüfen' });
    expect(planTaskBackfill([demo, task()], [])).toEqual(['t-auto-a']);
  });

  it('33: der Demo-Guard prüft exakte Kennungen, keine Präfixe', () => {
    expect(isCloudSyncBlockedMockTaskId('t-001')).toBe(true);
    expect(isCloudSyncBlockedMockTaskId('t-003')).toBe(true);
    expect(isCloudSyncBlockedMockTaskId('t-0012')).toBe(false);
    expect(isCloudSyncBlockedMockTaskId('t-00123456-abcd')).toBe(false);
    expect(isCloudSyncBlockedMockTaskId(undefined)).toBe(false);
  });

  it('34: task ist freigegeben und nicht mehr nur-lokal', () => {
    expect(SUPABASE_SYNC_ALLOWLIST.has('task')).toBe(true);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('task')).toBe(false);
  });

  it('35: Registry und Push-Extraktor kennen die Aufgabe', () => {
    const state = {
      tasks: [{ ...task(), sync: syncMeta(5) }, task({ id: 't-auto-z' })],
    } as AppPersistedState;
    expect(listEntitiesByType(state, 'task').map((entry) => entry.id)).toEqual(['t-auto-a', 't-auto-z']);
    const extracted = extractCloudSyncEntity(state, 'task', 't-auto-a');
    expect(extracted?.entityType).toBe('task');
    expect(extracted?.rowVersion).toBe(5);
  });
});
