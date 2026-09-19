/**
 * SYNC-DURABILITY-01G7 — ein Schreibvorgang, der den Server nie erreicht hat,
 * darf nicht für immer liegen bleiben.
 *
 * Seit 01G5 stellt der Sendeweg einen Schreibvorgang zurück, solange ein
 * ungeklärter Sendenachweis vorliegt und der lokale Stand inzwischen davon
 * abweicht. Das ist richtig, solange die Frage „hat der Server meinen
 * Schreibvorgang angenommen?" noch offen ist — sie wird beim nächsten Abgleich
 * beantwortet.
 *
 * Es gibt aber einen Fall, in dem sie **nie** beantwortet wurde: Der Aufruf
 * scheiterte, bevor der Server ihn ausführte. Dann ist der Server noch genau
 * auf der bestätigten Ausgangsbasis, der Abgleich findet nichts zu vergleichen,
 * der Nachweis bleibt ungeklärt — und der Sendeweg stellt zurück. Bei jedem
 * weiteren Durchgang aufs Neue. Die spätere Arbeit des Nutzers erreicht die
 * Cloud nie.
 *
 * Der Wiederanlauf muss deshalb drei Fälle unterscheiden:
 *
 *   A  Der Server ist weitergelaufen und trägt das Abgeschickte
 *      -> verlorene Bestätigung, Serverversion übernehmen.
 *   B  Der Server steht noch exakt auf der bestätigten Ausgangsbasis
 *      -> nicht angenommen, Nachweis auflösen, aktuellen Stand erneut senden.
 *   C  Der Server ist anders weitergelaufen
 *      -> echter Streitfall.
 *
 * Fall B wird nur angenommen, wenn die Serverversion **gleich** der bestätigten
 * Basis ist: Jeder angenommene Schreibvorgang erhöht sie, ein Gleichstand
 * beweist also, dass nichts angekommen ist. Geraten wird nichts, und es gibt
 * keine Zeitannahme.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Task } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxStatus } from '../../types/sync';
import type { VorgangNote } from '../../types/communication';
import { createSupabaseSyncAdapter } from './supabaseSyncAdapter';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import {
  getSyncOutboxSnapshot,
  recordOutboxSentProof,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { STORAGE_VERSION } from './syncMigrationService';
import { generateUuid } from './syncMetaService';
import { savePersistedState } from '../persistenceService';
import { normalizeTask } from '../taskNormalize';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import {
  buildTaskCloudContentKey,
  stripTaskForCloud,
  type WorkspaceTaskRow,
} from '../task/taskCloudService';
import {
  buildVorgangNoteCloudContentKey,
  stripVorgangNoteForCloud,
  type WorkspaceVorgangNoteRow,
} from '../vorgang/vorgangNoteCloudService';

const WORKSPACE = 'ws-01g7';
const DEVICE = 'device-01g7';
const UPDATED_AT = '2026-07-02T09:00:00.000Z';

function task(status: Task['status'], version: number, id = 't-01g7'): Task {
  return normalizeTask({
    id,
    title: 'Unterlagen prüfen',
    description: 'Beispiel',
    status,
    priority: 'mittel',
    category: 'dokumente',
    sourceType: 'inbox',
    sourceId: id,
    taskKind: 'inbox_template:dokument_pruefen',
    dedupeKey: `inbox:${id}:follow_up`,
    autoCreated: true,
    createdAt: '2026-07-01T09:00:00.000Z',
    sync: {
      updatedAt: UPDATED_AT,
      version,
      deleted: false,
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
    },
  });
}

function taskRow(base: Task, rowVersion: number, deleted = false): WorkspaceTaskRow {
  return {
    workspace_id: WORKSPACE,
    client_task_id: base.id,
    status: base.status,
    dedupe_key: base.dedupeKey,
    auto_created: base.autoCreated,
    payload: deleted ? {} : (stripTaskForCloud(base) as unknown as Record<string, unknown>),
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
    updated_by: 'device-remote',
  };
}

function note(body: string, version: number): VorgangNote {
  return {
    id: 'note-01g7',
    vorgangId: 'v-01g7',
    vorgangTitle: 'Beispielauftrag',
    body,
    occurredAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    source: 'user',
    sync: {
      updatedAt: UPDATED_AT,
      version,
      deleted: false,
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
    },
  } as VorgangNote;
}

function noteRow(base: VorgangNote, rowVersion: number): WorkspaceVorgangNoteRow {
  return {
    workspace_id: WORKSPACE,
    client_note_id: base.id,
    client_vorgang_id: base.vorgangId,
    payload: stripVorgangNoteForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: UPDATED_AT,
    updated_by: 'device-remote',
  };
}

function outboxEntry(
  entityType: 'task' | 'vorgang_note',
  entityId: string,
  status: SyncOutboxStatus,
  extras: Partial<SyncOutboxEntry> = {},
): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType,
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: UPDATED_AT,
    retryCount: 1,
    status,
    ...extras,
  } as SyncOutboxEntry;
}

function buildState(input: {
  tasks?: Task[];
  notes?: VorgangNote[];
  outbox?: SyncOutboxEntry[];
}): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, deviceId: DEVICE, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: input.outbox ?? [],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: input.tasks ?? [],
    vorgangNotes: input.notes ?? [],
    documents: [],
    savedAt: UPDATED_AT,
  } as AppPersistedState;
}

function emptyPull(overrides: Record<string, unknown> = {}) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    ...overrides,
  } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

function fakeClient() {
  const rpc = vi.fn(async () => ({ data: { row_version: 2, payload: {} }, error: null }));
  return { client: { rpc } as never, rpc };
}

async function push(state: AppPersistedState, client: never) {
  const adapter = createSupabaseSyncAdapter(client);
  return adapter.pushChanges({
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    state,
    outbox: state.syncOutbox ?? [],
  });
}

describe('01G7 — der Server hat den Schreibvorgang nicht angenommen', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('1 — Aufgabe: gescheiterter Aufruf, danach weitergearbeitet, der neue Stand geht hinaus', async () => {
    /*
     * Der vollständige Weg über Sendeweg, Abgleich und Bestand — nicht nur die
     * Planung. Ausgangslage: lokal und Server stehen auf Version 1 „offen".
     */
    const erledigt = task('done', 1);
    const entry = outboxEntry('task', erledigt.id, 'error');
    resetSyncOutboxForTests([entry]);
    savePersistedState(buildState({ tasks: [erledigt], outbox: [entry] }));

    // Der Nachweis für „erledigt" wurde gesichert, der Aufruf scheiterte davor.
    recordOutboxSentProof(entry.id, {
      sentContentKey: buildTaskCloudContentKey(erledigt),
      sentDeleted: false,
    });
    const mitNachweis = getSyncOutboxSnapshot();

    // Der Nutzer arbeitet weiter: archiviert.
    const archiviert = task('archived', 1);
    const nachWeiterarbeit = buildState({ tasks: [archiviert], outbox: mitNachweis });
    savePersistedState(nachWeiterarbeit);

    // Erster Versuch: zurückgestellt, weil die Frage offen ist. Das ist richtig.
    const ersterVersuch = fakeClient();
    await push(nachWeiterarbeit, ersterVersuch.client);
    expect(ersterVersuch.rpc, 'solange die Frage offen ist, wird zurückgestellt').not.toHaveBeenCalled();

    /*
     * Der Abgleich bringt die Antwort: Der Server steht noch exakt auf der
     * bestätigten Basis. Ein angenommener Schreibvorgang hätte sie erhöht —
     * also ist nichts angekommen.
     */
    const merge = mergeRemoteWorkspacePullIntoState(
      nachWeiterarbeit,
      emptyPull({ tasks: [taskRow(task('open', 1), 1)] }),
    );

    expect(merge.conflicts, 'ungesendete Arbeit ist kein Streitfall').toEqual([]);
    const nachAbgleich = merge.state.tasks?.find((t) => t.id === erledigt.id);
    expect(nachAbgleich?.status, 'die spätere Arbeit bleibt').toBe('archived');
    expect(nachAbgleich?.sync?.version, 'kein künstlicher Versionssprung').toBe(1);

    const auftrag = getSyncOutboxSnapshot().find((e) => e.entityId === erledigt.id);
    expect(auftrag?.sentContentKey, 'der Nachweis ist aufgelöst').toBeUndefined();
    expect(
      auftrag?.status === 'pending' || auftrag?.status === 'error',
      'der Auftrag ist wieder sendbar',
    ).toBe(true);
    expect(
      getSyncOutboxSnapshot().filter((e) => e.entityId === erledigt.id),
      'kein zweiter Auftrag',
    ).toHaveLength(1);

    // Zweiter Versuch: jetzt geht der aktuelle Stand wirklich hinaus.
    const zweiterVersuch = fakeClient();
    const ergebnis = await push(
      { ...merge.state, syncOutbox: getSyncOutboxSnapshot() },
      zweiterVersuch.client,
    );
    expect(zweiterVersuch.rpc, 'der aktuelle Stand wird gesendet').toHaveBeenCalledTimes(1);

    const gesendet = zweiterVersuch.rpc.mock.calls[0]?.[1] as Record<string, any>;
    expect(gesendet?.p_row_version, 'auf der unveränderten bestätigten Basis').toBe(1);
    expect(
      (gesendet?.p_payload as Record<string, unknown>)?.status,
      'und zwar die aktuelle Fassung, nicht der alte Nachweis',
    ).toBe('archived');
    expect(ergebnis.completedOutboxIds, 'der Auftrag ist erledigt').toHaveLength(1);
  });

  it('2 — Aufgabe: gescheiterter Aufruf, lokal unverändert, Wiederholung gelingt', async () => {
    const erledigt = task('done', 1);
    const entry = outboxEntry('task', erledigt.id, 'error');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, {
      sentContentKey: buildTaskCloudContentKey(erledigt),
      sentDeleted: false,
    });
    const state = buildState({ tasks: [erledigt], outbox: getSyncOutboxSnapshot() });
    savePersistedState(state);

    const merge = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(task('open', 1), 1)] }),
    );

    expect(merge.state.tasks?.find((t) => t.id === erledigt.id)?.status).toBe('done');
    const client = fakeClient();
    await push({ ...merge.state, syncOutbox: getSyncOutboxSnapshot() }, client.client);
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });

  it('3 — Notiz: nie angekommener Anlegevorgang, danach weitergearbeitet', async () => {
    /*
     * Beim Anlegen gibt es keine bestätigte Basis. Fehlt die Zeile nach dem
     * Abgleich vollständig, kann der Anlegevorgang den Server nicht erreicht
     * haben — er hätte sonst eine Zeile mit Version 1 hinterlassen, und auch
     * eine anderswo gelöschte Zeile käme als Grabstein zurück.
     */
    const erste = { ...note('Erstfassung', 0) };
    const entry = outboxEntry('vorgang_note', erste.id, 'error', { operation: 'create', version: 0 });
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, {
      sentContentKey: buildVorgangNoteCloudContentKey(erste),
      sentDeleted: false,
    });

    const zweite = note('Zweitfassung', 0);
    const state = buildState({ notes: [zweite], outbox: getSyncOutboxSnapshot() });
    savePersistedState(state);

    const ersterVersuch = fakeClient();
    await push(state, ersterVersuch.client);
    expect(ersterVersuch.rpc, 'zunächst zurückgestellt').not.toHaveBeenCalled();

    const merge = mergeRemoteWorkspacePullIntoState(state, emptyPull({ vorgangNotes: [] }));

    const auftrag = getSyncOutboxSnapshot().find((e) => e.entityId === erste.id);
    expect(auftrag?.sentContentKey, 'der Nachweis ist aufgelöst').toBeUndefined();
    expect(
      merge.state.vorgangNotes?.find((n) => n.id === erste.id)?.body,
      'die spätere Fassung bleibt',
    ).toBe('Zweitfassung');

    const zweiterVersuch = fakeClient();
    await push(
      { ...merge.state, syncOutbox: getSyncOutboxSnapshot() },
      zweiterVersuch.client,
    );
    expect(zweiterVersuch.rpc, 'jetzt wird angelegt').toHaveBeenCalledTimes(1);
    const gesendet = zweiterVersuch.rpc.mock.calls[0]?.[1] as Record<string, any>;
    expect(
      ((gesendet?.p_payload as Record<string, any>)?.payload as Record<string, unknown>)?.body,
      'mit der aktuellen Fassung',
    ).toBe('Zweitfassung');
  });

  it('4 — der Server ist weitergelaufen: das ist keine Nichtannahme', () => {
    /*
     * Die Sicherheitsbedingung. Steht der Server über der bestätigten Basis,
     * kann sehr wohl etwas angekommen sein — dann gilt der bisherige Weg
     * (Übernahme oder Streitfall), niemals „nicht angenommen".
     */
    const erledigt = task('done', 1);
    const entry = outboxEntry('task', erledigt.id, 'error');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, {
      sentContentKey: buildTaskCloudContentKey(erledigt),
      sentDeleted: false,
    });
    const state = buildState({ tasks: [erledigt], outbox: getSyncOutboxSnapshot() });

    const merge = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(erledigt, 2)] }),
    );

    expect(merge.conflicts).toEqual([]);
    expect(
      merge.state.tasks?.find((t) => t.id === erledigt.id)?.sync?.version,
      'das ist die verlorene Bestätigung: Serverversion übernehmen',
    ).toBe(2);
  });

  it('5 — der Server trägt etwas anderes: Streitfall, keine Nichtannahme', () => {
    const meine = task('done', 1);
    const entry = outboxEntry('task', meine.id, 'error');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, {
      sentContentKey: buildTaskCloudContentKey(meine),
      sentDeleted: false,
    });
    const state = buildState({ tasks: [meine], outbox: getSyncOutboxSnapshot() });

    const merge = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(task('archived', 1), 2)] }),
    );

    expect(merge.conflicts).toContain(`task:${meine.id}`);
    const lokal = merge.state.tasks?.find((t) => t.id === meine.id);
    expect(lokal?.status, 'die eigene Arbeit bleibt').toBe('done');
    expect(lokal?.sync?.version, 'die Basis bleibt unverändert').toBe(1);
  });

  it('6 — nie angekommene Löschung: sichere Wiederholung, keine Wiederbelebung', async () => {
    const geloescht = normalizeTask({ ...task('done', 1), sync: { ...task('done', 1).sync!, deleted: true } });
    const entry = outboxEntry('task', geloescht.id, 'error', { operation: 'delete' });
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, { sentContentKey: undefined, sentDeleted: true });
    const state = buildState({ tasks: [geloescht], outbox: getSyncOutboxSnapshot() });
    savePersistedState(state);

    const merge = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(task('done', 1), 1)] }),
    );

    const lokal = merge.state.tasks?.find((t) => t.id === geloescht.id);
    expect(lokal?.sync?.deleted, 'der Löschwunsch bleibt bestehen').toBe(true);

    const client = fakeClient();
    await push({ ...merge.state, syncOutbox: getSyncOutboxSnapshot() }, client.client);
    expect(client.rpc, 'die Löschung wird erneut gesendet').toHaveBeenCalledTimes(1);
    const gesendet = client.rpc.mock.calls[0]?.[1] as Record<string, any>;
    expect((gesendet?.p_payload as Record<string, unknown>)?.deleted).toBe(true);
  });

  it('7 — ohne Nachweis bleibt alles beim Alten', () => {
    // Kein Nachweis, keine Frage: Der Abgleich darf hier nichts anfassen.
    const offen = task('open', 1);
    const entry = outboxEntry('task', offen.id, 'pending');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ tasks: [offen], outbox: [entry] });

    const merge = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(offen, 1)] }),
    );

    expect(merge.conflicts).toEqual([]);
    expect(merge.state.tasks?.find((t) => t.id === offen.id)?.sync?.version).toBe(1);
  });
});
