/**
 * TAGESARBEIT-V1 — Aufgaben, die der Nutzer selbst führt.
 *
 *  A  Anlegen (ohne/mit Frist, Titelregeln, zwei identische bleiben zwei)
 *  B  Bearbeiten (Titel, Beschreibung)
 *  C  Fristen setzen, verschieben, entfernen — manuell und automatisch
 *  D  Vorgangsbezug setzen, ändern, entfernen
 *  E  Löschen: manuell ja, automatisch nein — im Dienst, nicht in der Ansicht
 *  F  Schutz der Nutzerfrist bei erneuter Ableitung
 *  G  Erledigen/Wiedereröffnen bleibt unberührt
 *  H  Persistenzfehler: kein falscher Erfolg, sauberer Rückfall
 *  I  Cloud/Sync
 *  J  Datum und lokale Tagesgrenze
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import {
  completeTask,
  createManualTask,
  createTaskFromProposal,
  deleteManualTask,
  getTaskSummary,
  getTasksFiltered,
  reopenTask,
  toggleTaskCompletion,
  updateTask,
  TASK_TITLE_MAX_LENGTH,
} from './taskEngineService';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import {
  buildCloudDedupeKey,
  buildTaskCloudContentKey,
  buildTaskCloudPushPayload,
  hasStableCloudDedupeIdentity,
  parseTaskCloudPayload,
} from './task/taskCloudService';
import * as persistenceService from './persistenceService';
import type { Task, TaskProposal } from '../types/models';

const V1 = 'v-task-1';
const V2 = 'v-task-2';

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    title: 'Zahlung prüfen: Rechnung 2026-0001',
    description: 'Überfällige Ausgangsrechnung',
    priority: 'hoch',
    category: 'zahlungen',
    sourceType: 'invoice',
    sourceId: 'inv-0001',
    taskKind: 'payment_overdue',
    dueDate: '2026-10-20',
    autoCreated: true,
    ...overrides,
  };
}

function stored(id: string): Task | undefined {
  return getAllTasksFromStore().find((task) => task.id === id);
}

function erfolg(result: ReturnType<typeof createManualTask>): Task {
  if (!result.success) throw new Error(result.errorKey);
  return result.task;
}

beforeEach(() => {
  localStorage.clear();
  setTaskStoreForTests([]);
  hydrateVorgangStore([
    createTestVorgang({ id: V1, title: 'Bad Sanierung', customer: 'Kunde A' }),
    createTestVorgang({ id: V2, title: 'Heizung Neubau', customer: 'Kunde B' }),
  ]);
  vi.restoreAllMocks();
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

describe('A — Anlegen', () => {
  it('A1: manuelle Aufgabe ohne Frist', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(task.title).toBe('Kunde anrufen');
    expect(task.dueDate).toBeUndefined();
    expect(task.autoCreated).toBe(false);
    expect(task.sourceType).toBe('manual');
    expect(task.status).toBe('open');
    expect(stored(task.id)).toBeDefined();
  });

  it('A2: manuelle Aufgabe mit Frist', () => {
    const task = erfolg(createManualTask({ title: 'Angebot nachfassen', dueDate: '2026-10-15' }));
    expect(task.dueDate).toBe('2026-10-15');
  });

  it('A3: zwei identische manuelle Aufgaben bleiben zwei Aufgaben', () => {
    // Genau der in der Analyse gefundene dedupeKey-Fehler.
    const a = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    const b = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(a.id).not.toBe(b.id);
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(getAllTasksFromStore()).toHaveLength(2);
  });

  it('A4: auch zehn gleichlautende bleiben zehn', () => {
    for (let i = 0; i < 10; i += 1) erfolg(createManualTask({ title: 'Material bestellen' }));
    expect(getAllTasksFromStore()).toHaveLength(10);
  });

  it('A5: der Titel wird getrimmt; leer wird abgewiesen', () => {
    expect(erfolg(createManualTask({ title: '  Rechnung schreiben  ' })).title).toBe(
      'Rechnung schreiben',
    );
    expect(createManualTask({ title: '   ' })).toEqual({
      success: false,
      errorKey: 'task.error.titleInvalid',
    });
    expect(getAllTasksFromStore()).toHaveLength(1);
  });

  it('A6: ein Titel über 500 Zeichen wird abgewiesen — vor dem Server', () => {
    expect(createManualTask({ title: 'x'.repeat(TASK_TITLE_MAX_LENGTH + 1) })).toEqual({
      success: false,
      errorKey: 'task.error.titleInvalid',
    });
    expect(erfolg(createManualTask({ title: 'x'.repeat(TASK_TITLE_MAX_LENGTH) })).title).toHaveLength(
      TASK_TITLE_MAX_LENGTH,
    );
  });

  it('A7: eine unbrauchbare Frist wird abgewiesen statt gedeutet', () => {
    expect(createManualTask({ title: 'Termin', dueDate: 'übermorgen' })).toEqual({
      success: false,
      errorKey: 'task.error.dueDateInvalid',
    });
    expect(getAllTasksFromStore()).toHaveLength(0);
  });

  it('A8: ein unbekannter Vorgang wird abgewiesen', () => {
    expect(createManualTask({ title: 'Termin', linkedVorgangId: 'v-gibt-es-nicht' })).toEqual({
      success: false,
      errorKey: 'task.error.vorgangMissing',
    });
  });
});

describe('A2 — Entdopplung hängt an der Identität, nicht an der Quellart', () => {
  /*
   * Die Korrektur der dedupeKey-Kollision darf die Wiedervorlagen nicht
   * mitreissen: Auch sie tragen `sourceType: 'manual'`, aber einen eigenen
   * Schlüssel — und sollen sehr wohl entdoppelt werden.
   */
  function manuellerVorschlag(overrides: Partial<TaskProposal> = {}): TaskProposal {
    return {
      title: 'Wiedervorlage',
      description: 'Dokument erneut vorlegen',
      priority: 'mittel',
      category: 'dokumente',
      sourceType: 'manual',
      taskKind: 'document_reminder',
      autoCreated: false,
      ...overrides,
    };
  }

  it('A2.1: mit ausdrücklichem Schlüssel wird entdoppelt', () => {
    const vorschlag = manuellerVorschlag({ dedupeKey: 'reminder:doc-1:document_reminder' });
    const erst = createTaskFromProposal(vorschlag)!;
    const zweit = createTaskFromProposal(vorschlag)!;
    expect(zweit.id).toBe(erst.id);
    expect(getAllTasksFromStore()).toHaveLength(1);
  });

  it('A2.2: mit eigener Quellkennung ebenfalls', () => {
    const vorschlag = manuellerVorschlag({ sourceId: 'doc-1' });
    const erst = createTaskFromProposal(vorschlag)!;
    const zweit = createTaskFromProposal(vorschlag)!;
    expect(zweit.id).toBe(erst.id);
    expect(getAllTasksFromStore()).toHaveLength(1);
  });

  it('A2.3: ohne beides wird nicht entdoppelt — der reparierte Fall', () => {
    const vorschlag = manuellerVorschlag();
    const erst = createTaskFromProposal(vorschlag)!;
    const zweit = createTaskFromProposal(vorschlag)!;
    expect(zweit.id).not.toBe(erst.id);
    expect(getAllTasksFromStore()).toHaveLength(2);
  });

  it('A2.4: eine automatische Aufgabe mit Quelle bleibt entdoppelt', () => {
    const erst = createTaskFromProposal(proposal())!;
    const zweit = createTaskFromProposal(proposal())!;
    expect(zweit.id).toBe(erst.id);
    expect(getAllTasksFromStore()).toHaveLength(1);
  });
});

describe('B — Bearbeiten', () => {
  it('B1: Titel ändern', () => {
    const task = erfolg(createManualTask({ title: 'Alt' }));
    const result = updateTask(task.id, { title: 'Neu' });
    expect(result.success && result.task.title).toBe('Neu');
    expect(stored(task.id)!.title).toBe('Neu');
  });

  it('B2: Beschreibung ändern, Titel bleibt', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    updateTask(task.id, { description: 'Wegen Nachtrag Bad' });
    expect(stored(task.id)!.description).toBe('Wegen Nachtrag Bad');
    expect(stored(task.id)!.title).toBe('Kunde anrufen');
  });

  it('B3: ein nicht genanntes Feld bleibt unberührt', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen', dueDate: '2026-10-15' }));
    updateTask(task.id, { title: 'Kunde zurückrufen' });
    expect(stored(task.id)!.dueDate).toBe('2026-10-15');
  });

  it('B4: ein leerer Titel wird abgewiesen, der alte bleibt stehen', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(updateTask(task.id, { title: '  ' })).toEqual({
      success: false,
      errorKey: 'task.error.titleInvalid',
    });
    expect(stored(task.id)!.title).toBe('Kunde anrufen');
  });

  it('B5: eine unbekannte Aufgabe wird gemeldet', () => {
    expect(updateTask('t-gibt-es-nicht', { title: 'x' })).toEqual({
      success: false,
      errorKey: 'task.notFound',
    });
  });

  it('B6: lokale Fachänderung erhöht sync.version nicht', () => {
    const base: Task = {
      ...erfolg(createManualTask({ title: 'Kunde anrufen' })),
      sync: { version: 4, updatedAt: '2026-10-01T10:00:00.000Z', deleted: false } as never,
    };
    setTaskStoreForTests([base]);
    updateTask(base.id, { title: 'Kunde zurückrufen' });
    expect(stored(base.id)!.sync?.version).toBe(4);
  });
});

describe('C — Fristen', () => {
  it('C1: Frist setzen', () => {
    const task = erfolg(createManualTask({ title: 'Angebot' }));
    updateTask(task.id, { dueDate: '2026-11-02' });
    expect(stored(task.id)!.dueDate).toBe('2026-11-02');
  });

  it('C2: Frist verschieben', () => {
    const task = erfolg(createManualTask({ title: 'Angebot', dueDate: '2026-11-02' }));
    updateTask(task.id, { dueDate: '2026-11-09' });
    expect(stored(task.id)!.dueDate).toBe('2026-11-09');
  });

  it('C3: Frist entfernen — wirklich weg, kein Leerstring', () => {
    const task = erfolg(createManualTask({ title: 'Angebot', dueDate: '2026-11-02' }));
    updateTask(task.id, { dueDate: null });
    const nachher = stored(task.id)!;
    expect(nachher.dueDate).toBeUndefined();
    /*
     * `normalizeTask` fuehrt jedes Feld des Modells, auch ein leeres — der
     * Schluessel bleibt deshalb mit Wert `undefined` stehen. Entscheidend ist,
     * dass es **kein Leerstring** ist und dass nichts davon dauerhaft wird:
     * `JSON.stringify` laesst undefined fallen, und die Cloud-Nutzlast
     * ebenfalls (siehe I6).
     */
    expect(nachher.dueDate).not.toBe('');
    expect(JSON.parse(JSON.stringify(nachher))).not.toHaveProperty('dueDate');
  });

  it('C4: der leere String entfernt ebenfalls — so liefert ihn das Datumsfeld', () => {
    const task = erfolg(createManualTask({ title: 'Angebot', dueDate: '2026-11-02' }));
    updateTask(task.id, { dueDate: '' });
    expect(stored(task.id)!.dueDate).toBeUndefined();
  });

  it('C5: Frist einer automatisch erzeugten Aufgabe ändern', () => {
    const auto = createTaskFromProposal(proposal())!;
    expect(auto.autoCreated).toBe(true);
    expect(updateTask(auto.id, { dueDate: '2026-12-01' }).success).toBe(true);
    expect(stored(auto.id)!.dueDate).toBe('2026-12-01');
  });

  it('C6: Frist einer automatisch erzeugten Aufgabe entfernen', () => {
    const auto = createTaskFromProposal(proposal())!;
    expect(updateTask(auto.id, { dueDate: null }).success).toBe(true);
    expect(stored(auto.id)!.dueDate).toBeUndefined();
  });
});

describe('D — Vorgangsbezug', () => {
  it('D1: beim Anlegen setzen — Kennung und Titel', () => {
    const task = erfolg(createManualTask({ title: 'Aufmass', linkedVorgangId: V1 }));
    expect(task.linkedVorgangId).toBe(V1);
    expect(task.linkedVorgangTitle).toBe('Bad Sanierung');
  });

  it('D2: nachträglich setzen', () => {
    const task = erfolg(createManualTask({ title: 'Aufmass' }));
    updateTask(task.id, { linkedVorgangId: V1 });
    expect(stored(task.id)!.linkedVorgangTitle).toBe('Bad Sanierung');
  });

  it('D3: ändern zieht den Titel mit', () => {
    const task = erfolg(createManualTask({ title: 'Aufmass', linkedVorgangId: V1 }));
    updateTask(task.id, { linkedVorgangId: V2 });
    expect(stored(task.id)!.linkedVorgangId).toBe(V2);
    expect(stored(task.id)!.linkedVorgangTitle).toBe('Heizung Neubau');
  });

  it('D4: entfernen räumt Kennung und Titel gemeinsam — kein verwaister Titel', () => {
    const task = erfolg(createManualTask({ title: 'Aufmass', linkedVorgangId: V1 }));
    updateTask(task.id, { linkedVorgangId: null });
    const nachher = stored(task.id)!;
    expect(nachher.linkedVorgangId).toBeUndefined();
    expect(nachher.linkedVorgangTitle).toBeUndefined();
    expect(nachher.vorgangTitle).toBeUndefined();
  });
});

describe('E — Löschen', () => {
  it('E1: manuelle Aufgabe löschen', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(deleteManualTask(task.id).success).toBe(true);
    expect(stored(task.id)).toBeUndefined();
  });

  it('E2: gelöscht wird als Grabstein mit erhaltener Serverversion', () => {
    const base: Task = {
      ...erfolg(createManualTask({ title: 'Kunde anrufen' })),
      sync: { version: 6, updatedAt: '2026-10-01T10:00:00.000Z', deleted: false } as never,
    };
    setTaskStoreForTests([base]);
    const result = deleteManualTask(base.id);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unerwartet');
    expect(result.task.sync?.deleted).toBe(true);
    // Nicht selbst erhöhen — der Server zählt.
    expect(result.task.sync?.version).toBe(6);
  });

  it('E3: eine automatisch erzeugte Aufgabe wird im Dienst abgewiesen', () => {
    const auto = createTaskFromProposal(proposal())!;
    expect(deleteManualTask(auto.id)).toEqual({
      success: false,
      errorKey: 'task.error.autoNotDeletable',
    });
    // Entscheidend: sie ist auch wirklich noch da.
    expect(stored(auto.id)).toBeDefined();
    expect(stored(auto.id)!.sync?.deleted).toBeFalsy();
  });

  it('E4: eine unbekannte Aufgabe wird gemeldet', () => {
    expect(deleteManualTask('t-gibt-es-nicht')).toEqual({
      success: false,
      errorKey: 'task.notFound',
    });
  });
});

describe('F — Schutz der Nutzerfrist bei erneuter Ableitung', () => {
  it('F1: die geänderte Nutzerfrist wird nicht überschrieben', () => {
    const auto = createTaskFromProposal(proposal())!;
    updateTask(auto.id, { dueDate: '2026-12-24' });

    const erneut = createTaskFromProposal(proposal());

    expect(erneut?.id).toBe(auto.id);
    expect(getAllTasksFromStore()).toHaveLength(1);
    expect(stored(auto.id)!.dueDate).toBe('2026-12-24');
  });

  it('F2: die entfernte Nutzerfrist wird nicht wiederhergestellt', () => {
    const auto = createTaskFromProposal(proposal())!;
    updateTask(auto.id, { dueDate: null });

    createTaskFromProposal(proposal());

    expect(getAllTasksFromStore()).toHaveLength(1);
    expect(stored(auto.id)!.dueDate).toBeUndefined();
  });

  it('F3: erledigt — eine spätere Episode darf eine neue Aufgabe mit neuer Frist sein', () => {
    const auto = createTaskFromProposal(proposal())!;
    updateTask(auto.id, { dueDate: null });
    completeTask(auto.id);

    const neu = createTaskFromProposal(proposal({ dueDate: '2027-01-15' }))!;

    expect(neu.id).not.toBe(auto.id);
    expect(neu.dueDate).toBe('2027-01-15');
    expect(getAllTasksFromStore()).toHaveLength(2);
  });

  it('F4: auch Titel und Beschreibung einer offenen Auto-Aufgabe bleiben stehen', () => {
    const auto = createTaskFromProposal(proposal())!;
    updateTask(auto.id, { title: 'Eigene Formulierung' });
    createTaskFromProposal(proposal());
    expect(stored(auto.id)!.title).toBe('Eigene Formulierung');
  });
});

describe('G — Erledigen und Wiedereröffnen', () => {
  it('G1: erledigen und wiedereröffnen funktionieren unverändert', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(completeTask(task.id)?.status).toBe('done');
    expect(stored(task.id)!.completedAt).toBeTruthy();
    expect(reopenTask(task.id)?.status).toBe('open');
    expect(stored(task.id)!.completedAt).toBeUndefined();
  });

  it('G2: die Umschaltung der Liste bleibt korrekt', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    toggleTaskCompletion(task.id);
    expect(getTasksFiltered('erledigt').map((t) => t.id)).toContain(task.id);
    toggleTaskCompletion(task.id);
    expect(getTasksFiltered('offen').map((t) => t.id)).toContain(task.id);
  });

  it('G3: eine gelöschte Aufgabe taucht in keinem Filter mehr auf', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    deleteManualTask(task.id);
    expect(getTasksFiltered('offen').map((t) => t.id)).not.toContain(task.id);
    expect(getTasksFiltered('erledigt').map((t) => t.id)).not.toContain(task.id);
  });
});

describe('H — Persistenzfehler', () => {
  function persistenzScheitert() {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: {},
    } as never);
  }

  it('H1: Anlegen scheitert — kein Phantom im Speicher, Aufrufer bekommt den Fehler', () => {
    persistenzScheitert();
    const result = createManualTask({ title: 'Kunde anrufen' });
    expect(result).toEqual({ success: false, errorKey: 'task.persistFailed' });
    expect(getAllTasksFromStore()).toHaveLength(0);
  });

  it('H2: Bearbeiten scheitert — der vorherige Zustand steht wieder', () => {
    const task = erfolg(createManualTask({ title: 'Alt', dueDate: '2026-10-15' }));
    persistenzScheitert();

    const result = updateTask(task.id, { title: 'Neu', dueDate: '2026-12-01' });

    expect(result).toEqual({ success: false, errorKey: 'task.persistFailed' });
    const nachher = stored(task.id)!;
    expect(nachher.title).toBe('Alt');
    expect(nachher.dueDate).toBe('2026-10-15');
  });

  it('H3: Löschen scheitert — kein falscher Löscherfolg', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    persistenzScheitert();

    const result = deleteManualTask(task.id);

    expect(result).toEqual({ success: false, errorKey: 'task.persistFailed' });
    expect(stored(task.id)).toBeDefined();
    expect(stored(task.id)!.sync?.deleted).toBeFalsy();
  });

  it('H4: auch die automatische Ableitung hinterlässt kein Phantom', () => {
    persistenzScheitert();
    expect(createTaskFromProposal(proposal())).toBeNull();
    expect(getAllTasksFromStore()).toHaveLength(0);
  });
});

describe('I — Cloud und Sync', () => {
  it('I1: eine manuelle Aufgabe trägt serverseitig keine Entdopplungsidentität', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(hasStableCloudDedupeIdentity(task)).toBe(false);
    expect(buildCloudDedupeKey(task)).toBe('');
    const payload = buildTaskCloudPushPayload(task);
    expect(payload.dedupe_key).toBe('');
    expect(payload.auto_created).toBe(false);
  });

  it('I2: eine automatische Aufgabe behält ihre Entdopplungsidentität', () => {
    const auto = createTaskFromProposal(proposal())!;
    expect(buildCloudDedupeKey(auto)).toBe('invoice:inv-0001:payment_overdue');
  });

  it('I3: Anlegen behauptet keine Serverversion', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    expect(task.sync?.version ?? 0).toBe(0);
  });

  it('I4: eine Bearbeitung ändert den Inhaltsschlüssel — sonst würde nie gepusht', () => {
    const task = erfolg(createManualTask({ title: 'Alt' }));
    const vorher = buildTaskCloudContentKey(stored(task.id)!);
    updateTask(task.id, { title: 'Neu' });
    expect(buildTaskCloudContentKey(stored(task.id)!)).not.toBe(vorher);
  });

  it('I5: das Entfernen der Frist ändert den Inhaltsschlüssel ebenfalls', () => {
    const task = erfolg(createManualTask({ title: 'Angebot', dueDate: '2026-11-02' }));
    const vorher = buildTaskCloudContentKey(stored(task.id)!);
    updateTask(task.id, { dueDate: null });
    expect(buildTaskCloudContentKey(stored(task.id)!)).not.toBe(vorher);
  });

  it('I6: Frist und Vorgang reisen mit — und sind nach dem Entfernen wirklich fort', () => {
    const task = erfolg(
      createManualTask({ title: 'Aufmass', dueDate: '2026-11-02', linkedVorgangId: V1 }),
    );
    const mit = buildTaskCloudPushPayload(stored(task.id)!).payload as Record<string, unknown>;
    expect(mit.dueDate).toBe('2026-11-02');
    expect(mit.linkedVorgangId).toBe(V1);

    updateTask(task.id, { dueDate: null, linkedVorgangId: null });
    const ohne = buildTaskCloudPushPayload(stored(task.id)!).payload as Record<string, unknown>;
    expect('dueDate' in ohne).toBe(false);
    expect('linkedVorgangId' in ohne).toBe(false);
    expect('linkedVorgangTitle' in ohne).toBe(false);
  });

  it('I7: Löschen sendet einen Grabstein', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    const result = deleteManualTask(task.id);
    if (!result.success) throw new Error('unerwartet');
    expect(buildTaskCloudPushPayload(result.task, true).deleted).toBe(true);
  });

  it('I8: zweites Gerät — die Nutzlast liest sich vollständig zurück', () => {
    const task = erfolg(
      createManualTask({ title: 'Aufmass', dueDate: '2026-11-02', linkedVorgangId: V1 }),
    );
    const payload = buildTaskCloudPushPayload(stored(task.id)!).payload as Record<string, unknown>;

    const zurueck = parseTaskCloudPayload(JSON.parse(JSON.stringify(payload)), task.id);

    expect(zurueck?.title).toBe('Aufmass');
    expect(zurueck?.dueDate).toBe('2026-11-02');
    expect(zurueck?.linkedVorgangId).toBe(V1);
    expect(zurueck?.autoCreated).toBe(false);
  });

  it('I9: ohne Frist kommt auf dem zweiten Gerät auch keine an', () => {
    const task = erfolg(createManualTask({ title: 'Kunde anrufen' }));
    const payload = buildTaskCloudPushPayload(stored(task.id)!).payload as Record<string, unknown>;
    expect(parseTaskCloudPayload(JSON.parse(JSON.stringify(payload)), task.id)?.dueDate).toBeUndefined();
  });
});

describe('J — Datum und lokale Tagesgrenze', () => {
  it('J1: um 00:30 Ortszeit bleibt die Frist der gewählte Tag', () => {
    // 03D — der Fehler war `toISOString()`: In MEZ/MESZ liegt der UTC-Tag
    // zwischen lokaler und UTC-Mitternacht einen Tag zurück.
    vi.setSystemTime(new Date(2026, 9, 3, 0, 30, 0));
    const task = erfolg(createManualTask({ title: 'Termin', dueDate: '2026-10-03' }));
    expect(task.dueDate).toBe('2026-10-03');
    expect(getTasksFiltered('heute', new Date()).map((t) => t.id)).toContain(task.id);
    vi.useRealTimers();
  });

  it('J2: ein Datum mit Zeitanteil wird auf den Kalendertag kanonisiert', () => {
    const task = erfolg(createManualTask({ title: 'Termin', dueDate: '2026-10-03T22:30:00.000Z' }));
    expect(task.dueDate).toBe('2026-10-03');
  });

  it('J3: Kennzahl und Filter behandeln denselben heutigen Tag gleich', () => {
    const heute = new Date(2026, 9, 3, 12, 0, 0);
    vi.setSystemTime(heute);
    // Altbestand mit Zeitanteil — genau der Fall, der beide auseinanderlaufen liess.
    setTaskStoreForTests([
      {
        id: 't-legacy',
        title: 'Altbestand mit Zeitanteil',
        dueDate: '2026-10-03T00:00:00.000Z',
        status: 'open',
        autoCreated: true,
      } as never,
    ]);

    const imFilter = getTasksFiltered('heute', heute).length;
    const inDerKennzahl = getTaskSummary(heute).today;

    expect(imFilter).toBe(1);
    expect(inDerKennzahl).toBe(imFilter);
    vi.useRealTimers();
  });

  it('J4: überfällig bleibt überfällig, heute nicht', () => {
    const heute = new Date(2026, 9, 3, 12, 0, 0);
    const gestern = erfolg(createManualTask({ title: 'Gestern', dueDate: '2026-10-02' }));
    const morgen = erfolg(createManualTask({ title: 'Morgen', dueDate: '2026-10-04' }));
    expect(getTasksFiltered('ueberfaellig', heute).map((t) => t.id)).toEqual([gestern.id]);
    expect(getTasksFiltered('heute', heute).map((t) => t.id)).not.toContain(morgen.id);
    expect(getTaskSummary(heute).overdue).toBe(1);
  });
});
