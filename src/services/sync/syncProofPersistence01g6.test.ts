/**
 * SYNC-DURABILITY-01G6 — ohne gesicherten Nachweis kein Schreibvorgang.
 *
 * Der abschliessende 01G5-Check hat drei Lücken gefunden. Alle drei betreffen
 * denselben Grundsatz: Der Sendenachweis ist nur dann etwas wert, wenn er
 * **nachweislich** dauerhaft liegt, bevor der Schreibvorgang das Gerät
 * verlässt, und wenn die Klärung, die ihn aufhebt, auch hält.
 *
 *  1  Der Sendeweg rief die Speicherung auf, sah sich ihr Ergebnis aber nicht
 *     an. Schlug sie fehl — kein Bestand unter dem aktiven Schlüssel,
 *     erschöpfter Speicher, unlesbarer Inhalt —, ging der Aufruf trotzdem
 *     hinaus. Dasselbe, wenn der Auftrag im gemeinsamen Bestand gar nicht
 *     auffindbar war: Der Vermerk kehrte still zurück.
 *  2  Der Abgleich der Sendeaufträge verglich die Nachweisfelder nicht. Eine
 *     bereits erfolgte Klärung konnte dadurch von einem älteren Stand wieder
 *     überschrieben werden.
 *  3  Geklärt wurde für jede Kennung, die der Pull mitbrachte — auch ohne
 *     jede Bewertung des Nachweises.
 *
 * Geprüft wird das Verhalten, nicht der Wortlaut des Quelltextes: Der echte
 * Sendeweg läuft gegen einen Ersatz-Client, der jeden Aufruf zählt.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Task } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxStatus } from '../../types/sync';
import { createSupabaseSyncAdapter } from './supabaseSyncAdapter';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import {
  getSyncOutboxSnapshot,
  recordOutboxSentProof,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { mergeOutboxAfterPull } from './syncOutboxMergeService';
import { STORAGE_VERSION } from './syncMigrationService';
import { generateUuid } from './syncMetaService';
import { getActiveStorageKey, savePersistedState } from '../persistenceService';
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
import type { VorgangNote } from '../../types/communication';

const WORKSPACE = 'ws-01g6';
const DEVICE = 'device-01g6';
const UPDATED_AT = '2026-07-02T09:00:00.000Z';

function task(id = 't-01g6'): Task {
  return normalizeTask({
    id,
    title: 'Unterlagen prüfen',
    description: 'Beispiel',
    status: 'done',
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
      version: 1,
      deleted: false,
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
    },
  });
}

function outboxEntry(
  entityId: string,
  status: SyncOutboxStatus = 'pending',
  extras: Partial<SyncOutboxEntry> = {},
): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType: 'task',
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: UPDATED_AT,
    retryCount: 0,
    status,
    ...extras,
  } as SyncOutboxEntry;
}

function buildState(tasks: Task[], outbox: SyncOutboxEntry[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, deviceId: DEVICE, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: outbox,
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks,
    documents: [],
    savedAt: UPDATED_AT,
  } as AppPersistedState;
}

/** Ein Ersatz-Client, der jeden Aufruf zählt und nichts verschickt. */
function fakeClient(onRpc?: () => void) {
  const rpc = vi.fn(async () => {
    onRpc?.();
    return { data: { row_version: 2, payload: {} }, error: null };
  });
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

describe('01G6 — ohne gesicherten Nachweis kein Schreibvorgang', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('1 — schlägt die Speicherung fehl, wird nichts gesendet', async () => {
    /*
     * Kein Bestand unter dem aktiven Schlüssel: Die Speicherung des Nachweises
     * kann nicht gelingen. Dann darf der Schreibvorgang das Gerät nicht
     * verlassen — sonst stünde der Server weiter als der Client, ohne dass
     * irgendetwas den eigenen Schreibvorgang später wiedererkennbar macht.
     */
    const entry = outboxEntry('t-01g6');
    resetSyncOutboxForTests([entry]);
    const state = buildState([task()], [entry]);
    const { client, rpc } = fakeClient();

    const result = await push(state, client);

    expect(rpc, 'kein Netzwerkaufruf ohne gesicherten Nachweis').not.toHaveBeenCalled();
    expect(result.completedOutboxIds, 'nichts gilt als erledigt').toEqual([]);
    expect(result.failedOutbox.length, 'der Fehlschlag wird gemeldet').toBeGreaterThan(0);
    expect(
      result.failedOutbox[0]?.retryable,
      'ein späterer Versuch bleibt möglich',
    ).toBe(true);
  });

  it('2 — fehlt der Auftrag im gemeinsamen Bestand, wird nichts gesendet', async () => {
    // Der Bestand ist speicherbar, aber der Auftrag ist dort nicht auffindbar.
    const entry = outboxEntry('t-01g6');
    const state = buildState([task()], [entry]);
    savePersistedState(state);
    resetSyncOutboxForTests([]);
    const { client, rpc } = fakeClient();

    const result = await push(state, client);

    expect(rpc, 'kein Netzwerkaufruf ohne auffindbaren Auftrag').not.toHaveBeenCalled();
    expect(result.failedOutbox.length).toBeGreaterThan(0);
  });

  it('3 — gelingt die Speicherung, wird gesendet, und der Nachweis liegt vorher fest', async () => {
    const entry = outboxEntry('t-01g6');
    const state = buildState([task()], [entry]);
    savePersistedState(state);
    resetSyncOutboxForTests([entry]);

    /*
     * Die Reihenfolge wird im Moment des Aufrufs geprüft: Wenn der Ersatz-Client
     * anläuft, muss der Nachweis bereits im gespeicherten Bestand stehen.
     */
    let nachweisBeimAufruf: string | undefined;
    const { client, rpc } = fakeClient(() => {
      const roh = JSON.parse(localStorage.getItem(getActiveStorageKey()) ?? '{}');
      nachweisBeimAufruf = ((roh.syncOutbox ?? []) as SyncOutboxEntry[]).find(
        (e) => e.id === entry.id,
      )?.sentContentKey;
    });

    await push(state, client);

    expect(rpc, 'jetzt darf gesendet werden').toHaveBeenCalledTimes(1);
    expect(
      nachweisBeimAufruf,
      'der Nachweis lag schon fest, als der Aufruf begann',
    ).toBeTruthy();
  });
});

describe('01G6 — eine Klärung muss halten', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('4 — Nachweis vorhanden und Nachweis aufgehoben sind nicht dasselbe', () => {
    /*
     * Der Abgleich entscheidet, ob ein älterer Stand einen neueren überschreiben
     * darf. Übersieht er die Nachweisfelder, kehrt ein bereits geklärter
     * Nachweis nach einem Neustart zurück.
     */
    const mitNachweis = outboxEntry('t-01g6', 'error', {
      sentContentKey: 'stand-a',
      sentDeleted: false,
      sentAt: UPDATED_AT,
    });
    const ohneNachweis: SyncOutboxEntry = {
      ...mitNachweis,
      sentContentKey: undefined,
      sentDeleted: undefined,
      sentAt: undefined,
    };

    const merged = mergeOutboxAfterPull({
      prePull: [mitNachweis],
      afterPush: [mitNachweis],
      afterPull: [ohneNachweis],
    });

    expect(
      merged[0]?.sentContentKey,
      'die Klärung des Pulls gilt, nicht der ältere Stand',
    ).toBeUndefined();
  });

  it('5 — ohne Klärung bleibt der Nachweis unangetastet', () => {
    const mitNachweis = outboxEntry('t-01g6', 'error', {
      sentContentKey: 'stand-a',
      sentDeleted: false,
      sentAt: UPDATED_AT,
    });

    const merged = mergeOutboxAfterPull({
      prePull: [mitNachweis],
      afterPush: [mitNachweis],
      afterPull: [mitNachweis],
    });

    expect(merged[0]?.sentContentKey).toBe('stand-a');
  });

  it('6 — ein erledigter Auftrag bleibt erledigt', () => {
    // Die bestehende Zusage aus 01G2 darf durch den schärferen Abgleich nicht kippen.
    const erledigt = outboxEntry('t-01g6', 'completed');
    const offen = outboxEntry('t-01g6', 'pending');

    const merged = mergeOutboxAfterPull({
      prePull: [offen],
      afterPush: [{ ...erledigt, id: offen.id }],
      afterPull: [offen],
    });

    expect(merged[0]?.status).toBe('completed');
  });
});


describe('01G6 — aufgehoben wird nur, was bewertet wurde', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  function taskRow(base: Task, rowVersion: number): WorkspaceTaskRow {
    return {
      workspace_id: WORKSPACE,
      client_task_id: base.id,
      status: base.status,
      dedupe_key: base.dedupeKey,
      auto_created: base.autoCreated,
      payload: stripTaskForCloud(base) as unknown as Record<string, unknown>,
      row_version: rowVersion,
      deleted: false,
      deleted_at: null,
      updated_at: UPDATED_AT,
      updated_by: 'device-remote',
    };
  }

  function note(body: string): VorgangNote {
    return {
      id: 'note-01g6',
      vorgangId: 'v-01g6',
      vorgangTitle: 'Beispielauftrag',
      body,
      occurredAt: '2026-07-01T08:00:00.000Z',
      createdAt: '2026-07-01T08:00:00.000Z',
      source: 'user',
      sync: {
        updatedAt: UPDATED_AT,
        version: 1,
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

  it('7 — mehrdeutige Lage: der Nachweis bleibt', () => {
    /*
     * Eine bestätigte Fassung, deren Zeile der Abgleich überhaupt nicht
     * mitbringt. Daraus lässt sich nichts schliessen — weder eine Annahme noch
     * eine Nichtannahme —, also bleibt der Nachweis stehen.
     *
     * Abzugrenzen von 01G7: Steht die Zeile auf derselben Version wie die
     * bestätigte Basis, ist das sehr wohl eine Antwort („nicht angenommen").
     * Diesen Fall prüft syncUnacceptedWrite01g7.
     */
    const offen = task();
    const entry = outboxEntry(offen.id, 'error', {
      sentContentKey: 'stand-a',
      sentDeleted: false,
      sentAt: UPDATED_AT,
    });
    resetSyncOutboxForTests([entry]);

    mergeRemoteWorkspacePullIntoState(
      buildState([offen], [entry]),
      emptyPull({ tasks: [] }),
    );

    expect(
      getSyncOutboxSnapshot().find((e) => e.id === entry.id)?.sentContentKey,
      'ohne Bewertung bleibt der Nachweis stehen',
    ).toBe('stand-a');
  });

  it('8 — echte Bewertung: der Nachweis wird aufgehoben (Aufgabe)', () => {
    const erledigt = task();
    const entry = outboxEntry(erledigt.id, 'error', {
      sentContentKey: buildTaskCloudContentKey(erledigt),
      sentDeleted: false,
      sentAt: UPDATED_AT,
    });
    resetSyncOutboxForTests([entry]);

    const result = mergeRemoteWorkspacePullIntoState(
      buildState([erledigt], [entry]),
      emptyPull({ tasks: [taskRow(erledigt, 2)] }),
    );

    expect(result.conflicts, 'der eigene Schreibvorgang ist kein Streit').toEqual([]);
    expect(
      result.state.tasks?.find((t) => t.id === erledigt.id)?.sync?.version,
      'die Serverversion ist jetzt die Basis',
    ).toBe(2);
    expect(
      getSyncOutboxSnapshot().find((e) => e.entityId === erledigt.id)?.sentContentKey,
      'die Frage ist beantwortet',
    ).toBeUndefined();
  });

  it('9 — echter Streit: lokale Arbeit und Basis bleiben unangetastet', () => {
    /*
     * Der Server trägt etwas anderes als das Abgeschickte. Die Frage ist damit
     * ebenfalls beantwortet — mit „nicht meiner". Die eigene Arbeit bleibt
     * stehen, die Basis bleibt alt, und der nächste Schreibversuch wird vom
     * Serververtrag abgewiesen statt fremde Arbeit zu überschreiben.
     */
    const meine = task();
    const entry = outboxEntry(meine.id, 'error', {
      sentContentKey: buildTaskCloudContentKey(meine),
      sentDeleted: false,
      sentAt: UPDATED_AT,
    });
    resetSyncOutboxForTests([entry]);

    const fremd = normalizeTask({ ...meine, status: 'archived' });
    const result = mergeRemoteWorkspacePullIntoState(
      buildState([meine], [entry]),
      emptyPull({ tasks: [taskRow(fremd, 2)] }),
    );

    expect(result.conflicts).toContain('task:' + meine.id);
    const lokal = result.state.tasks?.find((t) => t.id === meine.id);
    expect(lokal?.status, 'die eigene Arbeit steht').toBe('done');
    expect(lokal?.sync?.version, 'die Basis wird nicht angehoben').toBe(1);
  });

  it('10 — derselbe Weg für Vorgangsnotizen', () => {
    const meine = note('Meine Fassung');
    const entry: SyncOutboxEntry = {
      ...outboxEntry(meine.id, 'error', {
        sentContentKey: buildVorgangNoteCloudContentKey(meine),
        sentDeleted: false,
        sentAt: UPDATED_AT,
      }),
      entityType: 'vorgang_note',
    };
    resetSyncOutboxForTests([entry]);

    const state = { ...buildState([], [entry]), vorgangNotes: [meine] } as AppPersistedState;
    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ vorgangNotes: [noteRow(meine, 2)] }),
    );

    expect(result.conflicts).toEqual([]);
    expect(
      result.state.vorgangNotes?.find((n) => n.id === meine.id)?.sync?.version,
      'die Serverversion ist jetzt die Basis',
    ).toBe(2);
    expect(
      getSyncOutboxSnapshot().find((e) => e.entityId === meine.id)?.sentContentKey,
      'der Nachweis ist aufgehoben',
    ).toBeUndefined();
  });

  it('11 — Notiz in mehrdeutiger Lage: der Nachweis bleibt', () => {
    const meine = note('Meine Fassung');
    const entry: SyncOutboxEntry = {
      ...outboxEntry(meine.id, 'error', {
        sentContentKey: 'stand-a',
        sentDeleted: false,
        sentAt: UPDATED_AT,
      }),
      entityType: 'vorgang_note',
    };
    resetSyncOutboxForTests([entry]);

    // Auch hier: Die Zeile fehlt im Abgleich, die Lage bleibt offen.
    const state = { ...buildState([], [entry]), vorgangNotes: [meine] } as AppPersistedState;
    mergeRemoteWorkspacePullIntoState(state, emptyPull({ vorgangNotes: [] }));

    expect(
      getSyncOutboxSnapshot().find((e) => e.entityId === meine.id)?.sentContentKey,
    ).toBe('stand-a');
  });
});
