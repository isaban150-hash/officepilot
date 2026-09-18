/**
 * CLOUD-DURABILITY-CORE-01B — Vorgangsnotizen überleben das Gerät.
 *
 * Eine Notiz war bisher rein lokal (`vorgang_note` stand in
 * LOCAL_ONLY_SYNC_ENTITY_TYPES). Sie entstand offline, blieb offline und war
 * beim Gerätewechsel weg.
 *
 * **Drei Punkte tragen diesen Block und werden deshalb hart geprüft:**
 *
 * Erstens der Content-Key. Läge `sync` darin, erzeugte jede zurückgeschriebene
 * Serverversion den nächsten Push — dieselbe Schleife wie bei den Firmendaten.
 *
 * Zweitens der Grabstein. Er muss das zweite Gerät erreichen, die Notiz dort
 * entfernen und darf sie bei keinem späteren Pull wiederbeleben — auch nicht
 * über den Altbestand-Backfill.
 *
 * Drittens der Altbestand. Notizen aus der Zeit vor 01B meldet der
 * Change-Tracker nie nach; nur der ID-Mengenvergleich beim Provisioning bringt
 * sie in die Cloud.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyVorgangNotePushResultToState,
  buildVorgangNoteCloudContentKey,
  buildVorgangNoteCloudPushPayload,
  mapWorkspaceVorgangNoteRow,
  mergeVorgangNotesFromPull,
  planVorgangNoteBackfill,
  stripVorgangNoteForCloud,
  type WorkspaceVorgangNoteRow,
} from './vorgangNoteCloudService';
import {
  LOCAL_ONLY_SYNC_ENTITY_TYPES,
  SUPABASE_SYNC_ALLOWLIST,
} from '../sync/cloudSyncAllowlist';
import { listEntitiesByType } from '../sync/syncEntityRegistry';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import type { VorgangNote } from '../../types/communication';
import type { AppPersistedState } from '../../types/models';
import type { SyncMeta } from '../../types/sync';
import { DEFAULT_SETUP } from '../../data/mockData';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  trackPersistedChanges,
} from '../sync/syncChangeTrackerService';

const DEVICE = 'device-01b';
const WORKSPACE = 'ws-01b';

function note(overrides: Partial<VorgangNote> = {}): VorgangNote {
  return {
    id: 'note-0001',
    vorgangId: 'v-1000',
    vorgangTitle: 'Beispielauftrag Halle 2',
    body: 'Kunde bittet um Rückruf am Montag.',
    occurredAt: '2026-06-01T08:00:00.000Z',
    createdAt: '2026-06-01T08:00:00.000Z',
    source: 'user',
    ...overrides,
  };
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

function row(overrides: Partial<WorkspaceVorgangNoteRow> = {}): WorkspaceVorgangNoteRow {
  const base = note();
  return {
    workspace_id: WORKSPACE,
    client_note_id: base.id,
    client_vorgang_id: base.vorgangId,
    payload: stripVorgangNoteForCloud(base) as unknown as Record<string, unknown>,
    row_version: 1,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-06-02T10:00:00.000Z',
    updated_by: 'user-1',
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Payload und Content-Key                                                   */
/* ------------------------------------------------------------------------ */

describe('VORGANG-NOTE-CLOUD-01B — Payload und Content-Key', () => {
  it('1: der Cloud-Payload trägt keine Sync-Metadaten', () => {
    const payload = stripVorgangNoteForCloud({ ...note(), sync: syncMeta(3) });
    expect('sync' in payload).toBe(false);
    expect(payload.body).toBe('Kunde bittet um Rückruf am Montag.');
    expect(payload.vorgangId).toBe('v-1000');
  });

  it('2: eine neue Serverversion ändert den Content-Key nicht', () => {
    const before = buildVorgangNoteCloudContentKey({ ...note(), sync: syncMeta(1) });
    const after = buildVorgangNoteCloudContentKey({ ...note(), sync: syncMeta(7) });
    expect(after).toBe(before);
  });

  it('3: ein geänderter Text ändert den Content-Key', () => {
    const before = buildVorgangNoteCloudContentKey(note());
    const after = buildVorgangNoteCloudContentKey(note({ body: 'Rückruf erledigt.' }));
    expect(after).not.toBe(before);
  });

  it('4: die Push-Form trägt Notiz-ID, Vorgangsbezug und Grabstein-Flag', () => {
    const active = buildVorgangNoteCloudPushPayload(note());
    expect(active.note_id).toBe('note-0001');
    expect(active.vorgang_id).toBe('v-1000');
    expect(active.deleted).toBe(false);

    const tombstone = buildVorgangNoteCloudPushPayload(note(), true);
    expect(tombstone.deleted).toBe(true);
    // Der Vorgangsbezug bleibt auch am Grabstein erhalten.
    expect(tombstone.vorgang_id).toBe('v-1000');
  });
});

/* ------------------------------------------------------------------------ */
/* Serverzeile                                                               */
/* ------------------------------------------------------------------------ */

describe('VORGANG-NOTE-CLOUD-01B — Serverzeile', () => {
  it('5: eine aktive Zeile wird vollständig gelesen', () => {
    const mapped = mapWorkspaceVorgangNoteRow(row({ row_version: 4 }));
    expect(mapped?.noteId).toBe('note-0001');
    expect(mapped?.vorgangId).toBe('v-1000');
    expect(mapped?.rowVersion).toBe(4);
    expect(mapped?.payload?.body).toBe('Kunde bittet um Rückruf am Montag.');
  });

  it('6: ein Grabstein ohne Fachinhalt bleibt gültig', () => {
    const mapped = mapWorkspaceVorgangNoteRow(
      row({ payload: {}, deleted: true, deleted_at: '2026-06-03T09:00:00.000Z' }),
    );
    expect(mapped?.deleted).toBe(true);
    expect(mapped?.payload).toBeNull();
    // Der Vorgangsbezug kommt aus der Spalte, nicht aus dem Payload.
    expect(mapped?.vorgangId).toBe('v-1000');
  });

  it('7: Serverspalten wandern nicht in den Fachdatensatz', () => {
    const mapped = mapWorkspaceVorgangNoteRow(
      row({ payload: { ...(row().payload as object), workspace_id: WORKSPACE, row_version: 9 } }),
    );
    expect(mapped?.payload && 'workspace_id' in mapped.payload).toBe(false);
    expect(mapped?.payload && 'row_version' in mapped.payload).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Merge und Grabstein                                                       */
/* ------------------------------------------------------------------------ */

describe('VORGANG-NOTE-CLOUD-01B — Merge', () => {
  it('8: eine unbekannte Cloud-Notiz kommt lokal an', () => {
    const merged = mergeVorgangNotesFromPull([], [row()], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes.map((entry) => entry.id)).toEqual(['note-0001']);
    expect(merged.notes[0].sync?.version).toBe(1);
  });

  it('9: eine anderswo geänderte Notiz gewinnt mit höherer Version', () => {
    const local = { ...note(), sync: syncMeta(1) };
    const remote = row({
      row_version: 2,
      payload: stripVorgangNoteForCloud(
        note({ body: 'Rückruf erfolgt, Termin steht.' }),
      ) as unknown as Record<string, unknown>,
    });
    const merged = mergeVorgangNotesFromPull([local], [remote], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes[0].body).toBe('Rückruf erfolgt, Termin steht.');
    expect(merged.notes[0].sync?.version).toBe(2);
  });

  it('10: gleiche Version mit abweichendem Inhalt ist ein Konflikt', () => {
    const local = { ...note({ body: 'Lokal geändert.' }), sync: syncMeta(1) };
    const merged = mergeVorgangNotesFromPull([local], [row({ row_version: 1 })], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual(['vorgang_note:note-0001']);
  });

  it('11: gleiche Version mit gleichem Inhalt erzeugt keinen Konflikt', () => {
    const local = { ...note(), sync: syncMeta(1) };
    const merged = mergeVorgangNotesFromPull([local], [row({ row_version: 1 })], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes).toHaveLength(1);
  });

  it('12: ein Grabstein entfernt die Notiz auf diesem Gerät', () => {
    const local = { ...note(), sync: syncMeta(1) };
    const merged = mergeVorgangNotesFromPull(
      [local],
      [row({ row_version: 2, deleted: true, payload: {} })],
      DEVICE,
      WORKSPACE,
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes).toEqual([]);
  });

  it('13: eine lokal gelöschte Notiz wird von einer älteren Cloud-Zeile nicht wiederbelebt', () => {
    const local = {
      ...note(),
      sync: syncMeta(1, { deleted: true, deletedAt: '2026-06-04T07:00:00.000Z' }),
    };
    const merged = mergeVorgangNotesFromPull([local], [row({ row_version: 1 })], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes[0].sync?.deleted).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Altbestand                                                                */
/* ------------------------------------------------------------------------ */

describe('VORGANG-NOTE-CLOUD-01B — Altbestand', () => {
  it('14: eine Bestandsnotiz ohne Cloud-Zeile wird nachgemeldet', () => {
    expect(planVorgangNoteBackfill([note()], [])).toEqual(['note-0001']);
  });

  it('15: eine bereits hochgeladene Notiz wird nicht erneut gemeldet', () => {
    expect(planVorgangNoteBackfill([note()], [row()])).toEqual([]);
  });

  it('16: ein Remote-Grabstein zählt als vorhandene ID — keine Wiederbelebung', () => {
    expect(planVorgangNoteBackfill([note()], [row({ deleted: true, payload: {} })])).toEqual([]);
  });

  it('17: eine lokal gelöschte Notiz wird nie als Altbestand hochgeladen', () => {
    const local = { ...note(), sync: syncMeta(1, { deleted: true }) };
    expect(planVorgangNoteBackfill([local], [])).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* Registrierung und Push-Ergebnis                                           */
/* ------------------------------------------------------------------------ */

describe('VORGANG-NOTE-CLOUD-01B — Registrierung', () => {
  it('18: vorgang_note ist freigegeben und nicht mehr nur-lokal', () => {
    expect(SUPABASE_SYNC_ALLOWLIST.has('vorgang_note')).toBe(true);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('vorgang_note')).toBe(false);
  });

  it('19: die Registry findet Notizen über state.vorgangNotes', () => {
    const state = { vorgangNotes: [note(), note({ id: 'note-0002' })] } as AppPersistedState;
    expect(listEntitiesByType(state, 'vorgang_note').map((entry) => entry.id)).toEqual([
      'note-0001',
      'note-0002',
    ]);
  });

  it('20: der Push-Extraktor liefert Version und Grabstein-Stand', () => {
    const state = {
      vorgangNotes: [{ ...note(), sync: syncMeta(5, { deleted: true }) }],
    } as AppPersistedState;
    const extracted = extractCloudSyncEntity(state, 'vorgang_note', 'note-0001');
    expect(extracted?.entityType).toBe('vorgang_note');
    expect(extracted?.rowVersion).toBe(5);
    expect(extracted && 'deleted' in extracted && extracted.deleted).toBe(true);
  });

  it('21: das Push-Ergebnis setzt nur die Serverversion, nicht den Text', () => {
    const notes = applyVorgangNotePushResultToState(
      [note()],
      'note-0001',
      3,
      '2026-06-05T11:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
    );
    expect(notes[0].body).toBe('Kunde bittet um Rückruf am Montag.');
    expect(notes[0].sync?.version).toBe(3);
    expect(notes[0].sync?.deleted).toBe(false);
  });

  it('22: ein gepushter Grabstein bleibt lokal als Grabstein stehen', () => {
    const notes = applyVorgangNotePushResultToState(
      [{ ...note(), sync: syncMeta(2) }],
      'note-0001',
      3,
      '2026-06-05T11:00:00.000Z',
      true,
      DEVICE,
      WORKSPACE,
    );
    expect(notes[0].sync?.deleted).toBe(true);
    expect(notes[0].sync?.deletedAt).toBe('2026-06-05T11:00:00.000Z');
  });
});

/* ------------------------------------------------------------------------ */
/* Der Weg in die Outbox                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Hier wird der eigentliche Anspruch des Blocks geprüft: `vorgangNoteService`
 * schreibt **nicht** in die Cloud. Er speichert lokal, und der vorhandene
 * Change-Tracker macht daraus einen Sendeauftrag. Genau dieser Pfad muss
 * Neuanlage, Änderung und Grabstein tragen — ein zweiter Outbox-Weg entsteht
 * nicht.
 */
function trackerState(notes: VorgangNote[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    invoiceEntries: [],
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    vorgangNotes: notes,
    savedAt: '2026-06-01T10:00:00.000Z',
  } as unknown as AppPersistedState;
}

function noteOutboxEntries() {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'vorgang_note');
}

describe('VORGANG-NOTE-CLOUD-01B — Change-Tracker', () => {
  beforeEach(() => {
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('23: eine neu angelegte Notiz wird eingereiht', () => {
    // Erster Lauf: Basislinie, kein Auftrag.
    trackPersistedChanges(trackerState([]));
    expect(noteOutboxEntries()).toHaveLength(0);

    trackPersistedChanges(trackerState([{ ...note(), sync: syncMeta(0, { version: 0 }) }]));
    const entries = noteOutboxEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].entityId).toBe('note-0001');
    expect(entries[0].operation).toBe('create');
  });

  it('24: eine geänderte Notiz wird erneut eingereiht, eine bloss neue Serverversion nicht', () => {
    const base = { ...note(), sync: syncMeta(1) };
    trackPersistedChanges(trackerState([base]));
    expect(noteOutboxEntries()).toHaveLength(0);

    // Nur die Serverversion wandert zurück — keine fachliche Änderung.
    trackPersistedChanges(trackerState([{ ...base, sync: syncMeta(2) }]));
    expect(noteOutboxEntries()).toHaveLength(0);

    trackPersistedChanges(
      trackerState([{ ...base, body: 'Rückruf erledigt.', sync: syncMeta(2) }]),
    );
    const entries = noteOutboxEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('update');
  });

  it('25: eine gelöschte Notiz wird als Grabstein eingereiht', () => {
    const base = { ...note(), sync: syncMeta(1) };
    trackPersistedChanges(trackerState([base]));
    resetSyncOutboxForTests([]);

    trackPersistedChanges(
      trackerState([
        { ...base, sync: syncMeta(1, { deleted: true, deletedAt: '2026-06-04T07:00:00.000Z' }) },
      ]),
    );
    const entries = noteOutboxEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('delete');
  });
});
