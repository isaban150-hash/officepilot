/**
 * SYNC-DURABILITY-HARDENING-01G4 — Wiederanlauf nach verlorener Bestätigung.
 *
 * Das abschliessende Audit hat drei Gegenbeispiele geliefert; alle drei wurden
 * zuerst gegen die laufende Anwendung und die lokal angewandte Serverfunktion
 * nachgestellt und erst danach behoben. Hier stehen die Zusagen, die das
 * Verhalten künftig festhalten:
 *
 *  A/B  Eine fehlende Versionsangabe ist keine bestätigte Version. Sie darf
 *       weder eine neuere Fassung überschreiben noch eine Löschung rückgängig
 *       machen. (Serverseitig; hier wird der Vertragstext der Migration
 *       geprüft, die echte Ausführung deckt der SQL-Vertragslauf ab.)
 *  C/D  Anlegen, Bestätigung verloren, danach weitergearbeitet: Die
 *       Serverversion wird zur Basis, die spätere Fassung bleibt und geht
 *       erneut auf die Reise.
 *  E/F  Ändern, Bestätigung verloren: Trägt der Server genau das Abgeschickte,
 *       ist der Auftrag erledigt — ohne zusätzlichen Versionssprung.
 *  G    Dasselbe für eine Löschung: Der eigene Grabstein steht schon, es gibt
 *       nichts mehr zu senden und nichts wiederzubeleben.
 *  H    Hat dagegen jemand anders geschrieben, bleibt es beim Konflikt und die
 *       eigene Arbeit steht.
 *  I    Was der Wiederanlauf entscheidet, steht danach wirklich im Bestand.
 *  J    Ein erledigter Auftrag wird nie wieder geöffnet.
 *
 * Neutrale Beispieldaten.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTaskCloudContentKey,
  mergeTasksFromPull,
  planTaskLostAckAdoption,
  stripTaskForCloud,
  type WorkspaceTaskRow,
} from '../task/taskCloudService';
import {
  buildVorgangNoteCloudContentKey,
  mergeVorgangNotesFromPull,
  planVorgangNoteLostAckAdoption,
  stripVorgangNoteForCloud,
  type WorkspaceVorgangNoteRow,
} from '../vorgang/vorgangNoteCloudService';
import { planLostAckAdoption, type LostAckSentWrite } from './syncLostAckAdoptionService';
import { normalizeTask } from '../taskNormalize';
import type { Task } from '../../types/models';
import type { VorgangNote } from '../../types/communication';
import type { SyncMeta } from '../../types/sync';

const DEVICE = 'device-01g4';
const WORKSPACE = 'ws-01g4';
const MIGRATION = 'supabase/migrations/20260926120000_sync_version_zero_guard.sql';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: '2026-07-01T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function note(overrides: Partial<VorgangNote> = {}): VorgangNote {
  return {
    id: 'note-01g4',
    vorgangId: 'v-01g4',
    vorgangTitle: 'Beispielauftrag',
    body: 'Erstfassung',
    occurredAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    source: 'user',
    ...overrides,
  };
}

function noteRow(base: VorgangNote, rowVersion: number, deleted = false): WorkspaceVorgangNoteRow {
  return {
    workspace_id: WORKSPACE,
    client_note_id: base.id,
    client_vorgang_id: base.vorgangId,
    payload: deleted ? {} : (stripVorgangNoteForCloud(base) as unknown as Record<string, unknown>),
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? '2026-07-02T09:00:00.000Z' : null,
    updated_at: '2026-07-02T09:00:00.000Z',
    updated_by: 'user-remote',
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return normalizeTask({
    id: 't-01g4',
    title: 'Unterlagen prüfen',
    description: 'Vor dem Sync angelegt',
    status: 'open',
    priority: 'mittel',
    category: 'dokumente',
    sourceType: 'inbox',
    sourceId: 'inbox-01g4',
    taskKind: 'inbox_template:dokument_pruefen',
    dedupeKey: 'inbox:inbox-01g4:follow_up',
    autoCreated: true,
    createdAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
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
    deleted_at: deleted ? '2026-07-02T09:00:00.000Z' : null,
    updated_at: '2026-07-02T09:00:00.000Z',
    updated_by: 'user-remote',
  };
}

function sent(contentKey: string | undefined, deleted = false): ReadonlyMap<string, LostAckSentWrite> {
  return new Map([['note-01g4', { contentKey, deleted }]]);
}

describe('01G4 — A/B: eine fehlende Versionsangabe ist keine Bestätigung', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('A/B — der Serververtrag kennt keinen dritten Zustand mehr', () => {
    /*
     * In SQL ist jeder Vergleich mit einer fehlenden Angabe selbst unbestimmt
     * und damit nicht wahr. Ohne diese Normalisierung fiele ein solcher Aufruf
     * durch **beide** Prüfungen und dürfte überschreiben sowie einen Grabstein
     * wiederbeleben. Nachgewiesen wurde das gegen die laufende Datenbank; hier
     * steht der Vertrag, damit er nicht wieder herausfällt.
     */
    expect(sql).toContain('p_row_version := coalesce(p_row_version, 0);');
    // Die Normalisierung muss vor jeder Bewertung stehen, sonst wirkt sie nicht.
    expect(sql.indexOf('p_row_version := coalesce(p_row_version, 0);')).toBeLessThan(
      sql.indexOf("if p_entity_type = 'vorgang' then"),
    );
    // Und die unbestätigte Version bleibt in allen vier Zweigen geprüft.
    expect(sql.match(/p_row_version <= 0/g) ?? []).toHaveLength(4);
  });
});

describe('01G4 — C/D: Anlegen, Bestätigung verloren, danach weitergearbeitet', () => {
  it('C — Notiz: Serverversion wird Basis, die spätere Fassung bleibt', () => {
    const local = { ...note({ body: 'Zweitfassung nach Funkloch' }), sync: syncMeta(0) };
    const remote = noteRow(note({ body: 'Erstfassung' }), 1);

    const plan = planVorgangNoteLostAckAdoption([local], [remote], new Set([local.id]));

    expect(plan.adopt, 'der eigene verlorene Anlegevorgang wird übernommen').toEqual([local.id]);
    expect(plan.settle).toEqual([]);
    expect(plan.baseVersions.get(local.id), 'die unberührte Erstzeile ist die Basis').toBe(1);
  });

  it('D — Aufgabe: derselbe Weg nach einem Statuswechsel', () => {
    const local = { ...task({ status: 'done' }), sync: syncMeta(0) };
    const remote = taskRow(task({ status: 'open' }), 1);

    const plan = planTaskLostAckAdoption([local], [remote], new Set([local.id]));

    expect(plan.adopt).toEqual([local.id]);
    expect(plan.baseVersions.get(local.id)).toBe(1);
  });

  it('C/D — ohne offenen Sendeauftrag wird nichts übernommen', () => {
    const local = { ...note({ body: 'Zweitfassung' }), sync: syncMeta(0) };
    const plan = planVorgangNoteLostAckAdoption([local], [noteRow(note(), 1)], new Set());
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
  });

  it('C/D — eine bereits weitergeschriebene Serverzeile beweist nichts', () => {
    /*
     * Jeder Schreibvorgang erhöht die Version. Steht dort mehr als die
     * Erstzeile, hat jemand anders geschrieben — dann wird nichts übernommen.
     */
    const local = { ...note({ body: 'Zweitfassung' }), sync: syncMeta(0) };
    const plan = planVorgangNoteLostAckAdoption([local], [noteRow(note(), 2)], new Set([local.id]));
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
  });
});

describe('01G4 — E/F/G: Bestätigung einer Änderung oder Löschung verloren', () => {
  it('E — Notiz: der Server trägt genau das Abgeschickte, der Auftrag ist erledigt', () => {
    const geaendert = note({ body: 'Geänderte Fassung' });
    const local = { ...geaendert, sync: syncMeta(1) };
    const remote = noteRow(geaendert, 2);

    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [remote],
      new Set([local.id]),
      sent(buildVorgangNoteCloudContentKey(geaendert)),
    );

    expect(plan.settle, 'nichts mehr zu senden').toEqual([local.id]);
    expect(plan.adopt).toEqual([]);
    expect(plan.baseVersions.get(local.id), 'kein unnötiger Versionssprung').toBe(2);
  });

  it('E — wurde seither weitergearbeitet, geht die neuere Fassung erneut los', () => {
    const abgeschickt = note({ body: 'Zwischenfassung' });
    const local = { ...note({ body: 'Noch neuere Fassung' }), sync: syncMeta(1) };
    const remote = noteRow(abgeschickt, 2);

    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [remote],
      new Set([local.id]),
      sent(buildVorgangNoteCloudContentKey(abgeschickt)),
    );

    expect(plan.adopt).toEqual([local.id]);
    expect(plan.settle).toEqual([]);
    expect(plan.baseVersions.get(local.id)).toBe(2);
  });

  it('F — Aufgabe: Statusänderung bestätigt, nur die Antwort fehlte', () => {
    const erledigt = task({ status: 'done' });
    const local = { ...erledigt, sync: syncMeta(1) };
    const plan = planTaskLostAckAdoption(
      [local],
      [taskRow(erledigt, 2)],
      new Set([local.id]),
      new Map([[local.id, { contentKey: buildTaskCloudContentKey(erledigt), deleted: false }]]),
    );

    expect(plan.settle).toEqual([local.id]);
    expect(plan.baseVersions.get(local.id)).toBe(2);
  });

  it('G — Löschung: der eigene Grabstein steht bereits', () => {
    const local = { ...note(), sync: syncMeta(1, { deleted: true }) };
    const remote = noteRow(note(), 2, true);

    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [remote],
      new Set([local.id]),
      sent(undefined, true),
    );

    expect(plan.settle, 'erledigt — kein zweiter Grabstein').toEqual([local.id]);
    expect(plan.adopt).toEqual([]);
  });

  it('G — eine abgeschickte Löschung rechtfertigt keine aktive Serverfassung', () => {
    const local = { ...note(), sync: syncMeta(1, { deleted: true }) };
    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [noteRow(note({ body: 'Vom Kollegen geändert' }), 2)],
      new Set([local.id]),
      sent(undefined, true),
    );
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
  });

  it('G — ein fremder Grabstein bestätigt keinen aktiven Schreibvorgang', () => {
    const abgeschickt = note({ body: 'Meine Fassung' });
    const local = { ...abgeschickt, sync: syncMeta(1) };
    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [noteRow(note(), 2, true)],
      new Set([local.id]),
      sent(buildVorgangNoteCloudContentKey(abgeschickt)),
    );
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
  });
});

describe('01G4 — H: fremder Inhalt bleibt ein Konflikt', () => {
  it('H — der Server trägt etwas anderes als das Abgeschickte', () => {
    const abgeschickt = note({ body: 'Meine Fassung' });
    const local = { ...abgeschickt, sync: syncMeta(1) };
    const fremd = noteRow(note({ body: 'Die Fassung des Kollegen' }), 2);

    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [fremd],
      new Set([local.id]),
      sent(buildVorgangNoteCloudContentKey(abgeschickt)),
    );

    expect(plan.adopt, 'keine Übernahme fremder Arbeit').toEqual([]);
    expect(plan.settle).toEqual([]);

    // Und der Merge meldet ihn weiterhin als das, was er ist.
    const merge = mergeVorgangNotesFromPull([local], [fremd], DEVICE, WORKSPACE, new Set([local.id]));
    expect(merge.conflicts).toEqual([`vorgang_note:${local.id}`]);
    expect(merge.notes[0]?.body, 'die eigene Arbeit steht').toBe('Meine Fassung');
  });

  it('H — ohne Sendenachweis wird auf bestätigter Fassung nichts übernommen', () => {
    /*
     * Ohne den Nachweis ist nicht entscheidbar, wessen Schreibvorgang der
     * neuere Serverstand ist. Dann gilt die vorsichtige Antwort.
     */
    const local = { ...note({ body: 'Meine Fassung' }), sync: syncMeta(1) };
    const plan = planVorgangNoteLostAckAdoption(
      [local],
      [noteRow(note({ body: 'Fremde Fassung' }), 2)],
      new Set([local.id]),
    );
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
  });

  it('H — Aufgabe: fremder Statuswechsel bleibt Konflikt', () => {
    const abgeschickt = task({ status: 'done' });
    const local = { ...abgeschickt, sync: syncMeta(1) };
    const fremd = taskRow(task({ status: 'archived' }), 2);

    const plan = planTaskLostAckAdoption(
      [local],
      [fremd],
      new Set([local.id]),
      new Map([[local.id, { contentKey: buildTaskCloudContentKey(abgeschickt), deleted: false }]]),
    );
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);

    const merge = mergeTasksFromPull([local], [fremd], DEVICE, WORKSPACE, new Set([local.id]));
    expect(merge.conflicts).toEqual([`task:${local.id}`]);
    expect(merge.tasks[0]?.status, 'die eigene Arbeit steht').toBe('done');
  });
});

describe('01G4 — J: ein erledigter Auftrag zählt nicht mehr', () => {
  it('J — ein abgeschlossener Sendeauftrag rechtfertigt keine Übernahme', () => {
    /*
     * Der Sendenachweis lebt nur, solange der Auftrag offen ist. Sonst könnte
     * eine längst bestätigte Fassung später eine fremde Änderung überschreiben.
     */
    const abgeschickt = note({ body: 'Längst bestätigt' });
    const local = { ...abgeschickt, sync: syncMeta(1) };
    const plan = planLostAckAdoption(
      [local],
      new Map([[local.id, { rowVersion: 2, deleted: false, contentKey: buildVorgangNoteCloudContentKey(abgeschickt) }]]),
      // Kein aktiver Auftrag mehr.
      new Set(),
      { sentWrites: sent(buildVorgangNoteCloudContentKey(abgeschickt)) },
    );
    expect(plan.adopt).toEqual([]);
    expect(plan.settle).toEqual([]);
  });
});

describe('01G4 — der Wiederanlauf lässt den Merge in Ruhe', () => {
  let local: VorgangNote & { sync: SyncMeta };

  beforeEach(() => {
    local = { ...note({ body: 'Zweitfassung nach Funkloch' }), sync: syncMeta(0) };
  });

  it('die übernommene Zeile wird dem Merge entzogen, der lokale Text bleibt', () => {
    /*
     * Das ist der Kern des schwersten Befunds: Ohne die vorgezogene Übernahme
     * meldete der Merge hier einen Konflikt, die Basis bliebe unbestätigt, und
     * der nächste Schreibversuch würde vom Serververtrag abgewiesen — der
     * Auftrag stünde für immer still.
     */
    const remote = noteRow(note({ body: 'Erstfassung' }), 1);
    const plan = planVorgangNoteLostAckAdoption([local], [remote], new Set([local.id]));
    const adopted = new Set([...plan.adopt, ...plan.settle]);

    const merge = mergeVorgangNotesFromPull(
      [{ ...local, sync: { ...local.sync, version: plan.baseVersions.get(local.id) ?? 1 } }],
      [remote].filter((row) => !adopted.has(row.client_note_id)),
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );

    expect(merge.conflicts, 'kein Konflikt mehr').toEqual([]);
    expect(merge.notes[0]?.body).toBe('Zweitfassung nach Funkloch');
    expect(merge.notes[0]?.sync?.version, 'auf bestätigter Basis erneut sendbar').toBe(1);
  });
});
