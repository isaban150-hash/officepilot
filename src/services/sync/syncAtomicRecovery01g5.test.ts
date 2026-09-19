/**
 * SYNC-DURABILITY-01G5 — der Wiederanlauf muss als Ganzes verlässlich sein.
 *
 * Das 01G4-Audit hat drei Wege gefunden, auf denen die Wiederherstellung nach
 * einer verlorenen Bestätigung selbst versagt:
 *
 *  A  Der Sendenachweis entstand nur in einer Arbeitskopie des Sendewegs und
 *     wurde erst am Ende eines Laufs gespeichert. Stirbt die Seite zwischen
 *     „Server hat angenommen" und „Antwort verarbeitet", ist er verloren — und
 *     mit ihm die einzige Möglichkeit, den eigenen Schreibvorgang später
 *     wiederzuerkennen.
 *  B  Ein späterer Schreibvorgang überschrieb den noch ungeklärten Nachweis des
 *     vorigen. Danach ist die Serverfassung nicht mehr als die eigene erkennbar.
 *  C  Die Entscheidung des Wiederanlaufs wurde am Sendeauftrag vermerkt, das
 *     zugehörige Merge-Ergebnis aber verworfen, sobald **irgendeine** andere
 *     Entität desselben Typs in Streit lag. Der Auftrag galt dann als
 *     sendebereit, während die Entität noch die alte Basis trug — der nächste
 *     Versuch scheiterte aus demselben Grund erneut.
 *
 * Grundsatz, der hier festgehalten wird:
 *
 *   EIN UNGEKLÄRTER SENDENACHWEIS JE AKTIVEM SCHREIBVORGANG.
 *
 * Er entsteht vor dem Absenden, wird vor dem Absenden gespeichert, überlebt
 * Neustart und Absturz, und wird niemals still von einem neueren lokalen Stand
 * ersetzt — nur die Klärung selbst löst ihn auf.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Task } from '../../types/models';
import type { SyncMeta, SyncOutboxEntry, SyncOutboxStatus } from '../../types/sync';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import {
  getSyncOutboxSnapshot,
  recordOutboxSentProof,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { STORAGE_VERSION } from './syncMigrationService';
import { generateUuid } from './syncMetaService';
import { buildTaskCloudContentKey, stripTaskForCloud, type WorkspaceTaskRow } from '../task/taskCloudService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { getActiveStorageKey, persistSyncOutboxNow, savePersistedState } from '../persistenceService';
import { normalizeTask } from '../taskNormalize';

const WORKSPACE = 'ws-01g5';
const UPDATED_AT = '2026-07-02T09:00:00.000Z';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: '2026-07-01T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: 'device-01g5',
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return normalizeTask({
    id,
    title: `Unterlagen prüfen ${id}`,
    description: 'Beispiel',
    status: 'open',
    priority: 'mittel',
    category: 'dokumente',
    sourceType: 'inbox',
    sourceId: id,
    taskKind: 'inbox_template:dokument_pruefen',
    dedupeKey: `inbox:${id}:follow_up`,
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
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
    updated_by: 'device-remote',
  };
}

function outboxEntry(
  entityId: string,
  status: SyncOutboxStatus,
  extras: Partial<SyncOutboxEntry> = {},
): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType: 'task',
    entityId,
    operation: 'update',
    version: 0,
    queuedAt: UPDATED_AT,
    retryCount: 1,
    status,
    ...extras,
  } as SyncOutboxEntry;
}

function buildState(tasks: Task[], outbox: SyncOutboxEntry[]): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
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

describe('01G5 — der Sendenachweis', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('1 — entsteht im dauerhaften Bestand, nicht nur in einer Arbeitskopie', () => {
    /*
     * Der Nachweis muss den Weg überleben, auf dem er gebraucht wird: Er wird
     * vor dem Absenden festgehalten, und zwar dort, wo auch ein Neustart ihn
     * wiederfindet — nicht in einer Kopie, die erst am Ende eines Laufs
     * zurückgeschrieben wird.
     */
    const entry = outboxEntry('t-a', 'pending');
    resetSyncOutboxForTests([entry]);

    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-a', sentDeleted: false });

    const gespeichert = getSyncOutboxSnapshot().find((e) => e.id === entry.id);
    expect(gespeichert?.sentContentKey, 'der Nachweis steht im gemeinsamen Bestand').toBe('stand-a');
    expect(gespeichert?.sentAt, 'mit Zeitpunkt').toBeTruthy();
  });

  it('2 — überlebt einen Neustart, weil er vorher gespeichert wurde', () => {
    const entry = outboxEntry('t-a', 'pending');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-a', sentDeleted: false });

    // Ein Neustart lädt den Bestand neu — der Nachweis muss mitkommen.
    const nachNeustart = getSyncOutboxSnapshot();
    resetSyncOutboxForTests(nachNeustart);

    expect(getSyncOutboxSnapshot()[0]?.sentContentKey).toBe('stand-a');
  });

  it('3 — ein späterer Schreibvorgang ersetzt einen ungeklärten Nachweis nicht', () => {
    /*
     * Das ist der Kern von Befund B: Würde der zweite Schreibvorgang den
     * Nachweis des ersten überschreiben, wäre die Serverfassung, die aus dem
     * ersten stammt, nie mehr als die eigene erkennbar — der Auftrag bliebe für
     * immer liegen.
     */
    const entry = outboxEntry('t-a', 'pending');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-a', sentDeleted: false });

    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-b', sentDeleted: false });

    expect(
      getSyncOutboxSnapshot()[0]?.sentContentKey,
      'der ungeklärte Nachweis bleibt stehen',
    ).toBe('stand-a');
  });

  it('4 — ein abgeschlossener Auftrag trägt keinen Nachweis mehr', () => {
    const entry = outboxEntry('t-a', 'completed', {
      sentContentKey: 'stand-a',
      sentDeleted: false,
    });
    resetSyncOutboxForTests([entry]);

    // Ein neuer Schreibvorgang auf einem erledigten Auftrag darf vermerken.
    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-b', sentDeleted: false });
    expect(getSyncOutboxSnapshot()[0]?.sentContentKey).toBe('stand-b');
  });
});

describe('01G5 — Wiederanlauf und Sendeauftrag gehören zusammen', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('5 — ein Streitfall beschädigt den Wiederanlauf einer anderen Aufgabe nicht', () => {
    /*
     * Befund C. Aufgabe A ist wiederherstellbar: Der Server trägt die unberührte
     * Erstzeile des eigenen, im Funkloch verlorenen Anlegevorgangs. Aufgabe B
     * liegt wirklich in Streit — ein anderes Gerät hat geschrieben.
     *
     * Vorher entschied der Streit um B auch über A: Der Sendeauftrag von A galt
     * als sendebereit, aber die Aufgabe behielt die alte Basis, weil das ganze
     * Merge-Ergebnis verworfen wurde. Der nächste Versuch musste erneut
     * scheitern.
     */
    const a = { ...task('t-a'), sync: syncMeta(0) };
    const b = { ...task('t-b', { status: 'done' }), sync: syncMeta(1) };
    const entryA = outboxEntry(a.id, 'blocked', { operation: 'create' });
    const entryB = outboxEntry(b.id, 'pending');
    resetSyncOutboxForTests([entryA, entryB]);
    const state = buildState([a, b], [entryA, entryB]);

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({
        tasks: [
          // A: die unberührte Erstzeile — der eigene verlorene Anlegevorgang.
          taskRow(task('t-a'), 1),
          // B: ein anderes Gerät hat etwas anderes geschrieben.
          taskRow(task('t-b', { status: 'archived' }), 2),
        ],
      }),
    );

    const mergedA = result.state.tasks?.find((t) => t.id === a.id);
    const outboxA = getSyncOutboxSnapshot().filter((e) => e.entityId === a.id);
    const offenA = outboxA.filter((e) => e.status !== 'completed');

    expect(result.conflicts, 'der Streit um B wird gemeldet').toContain(`task:${b.id}`);

    /*
     * Die eigentliche Zusage: Auftragslage und bestätigte Basis stammen aus
     * derselben Entscheidung. Gilt der Auftrag als sendebereit, muss die
     * Aufgabe die übernommene Basis tragen.
     */
    if (offenA.length > 0) {
      expect(
        mergedA?.sync?.version,
        'sendebereit heisst: die übernommene Basis steht auch an der Aufgabe',
      ).toBe(1);
    }
    expect(mergedA?.sync?.version, 'die Basis von A wurde übernommen').toBe(1);

    // Und die eigene Arbeit an B bleibt unangetastet.
    const mergedB = result.state.tasks?.find((t) => t.id === b.id);
    expect(mergedB?.status, 'die eigene Arbeit an B bleibt').toBe('done');
  });

  it('6 — ohne Streitfall bleibt alles wie bisher', () => {
    const a = { ...task('t-a'), sync: syncMeta(0) };
    const entryA = outboxEntry(a.id, 'blocked', { operation: 'create' });
    resetSyncOutboxForTests([entryA]);
    const state = buildState([a], [entryA]);

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(task('t-a'), 1)] }),
    );

    expect(result.conflicts).toEqual([]);
    expect(result.state.tasks?.find((t) => t.id === a.id)?.sync?.version).toBe(1);
  });

  it('7 — der Streitfall allein verliert keine fremde Arbeit', () => {
    /*
     * Gegenprobe zu Test 5: Wird das Merge-Ergebnis künftig auch bei Streit
     * übernommen, darf das die strittige Aufgabe selbst nicht verändern.
     */
    const b = { ...task('t-b', { status: 'done' }), sync: syncMeta(1) };
    const entryB = outboxEntry(b.id, 'pending');
    resetSyncOutboxForTests([entryB]);
    const state = buildState([b], [entryB]);

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(task('t-b', { status: 'archived' }), 2)] }),
    );

    expect(result.conflicts).toContain(`task:${b.id}`);
    const mergedB = result.state.tasks?.find((t) => t.id === b.id);
    expect(mergedB?.status, 'die lokale Fassung bleibt stehen').toBe('done');
    expect(mergedB?.sync?.version, 'und behält ihre bestätigte Basis').toBe(1);
  });

  it('8 — der Inhaltsschlüssel beschreibt den abgeschickten Stand', () => {
    // Belegt, dass Nachweis und Serverfassung überhaupt vergleichbar sind.
    const erledigt = task('t-a', { status: 'done' });
    expect(buildTaskCloudContentKey(erledigt)).toBe(
      buildTaskCloudContentKey(normalizeTask({ ...erledigt })),
    );
    expect(buildTaskCloudContentKey(erledigt)).not.toBe(
      buildTaskCloudContentKey(task('t-a', { status: 'open' })),
    );
  });
});

describe('01G5 — der tatsächliche Persistenzpfad', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('9 — der Nachweis steht im gespeicherten Bestand, nicht nur im Arbeitsspeicher', () => {
    /*
     * Die eigentliche Zusage von Befund A: Der Nachweis muss **vor** dem
     * Absenden dort liegen, wo ein Neustart ihn wiederfindet. Geprüft wird
     * deshalb nicht der Arbeitsspeicher, sondern das, was tatsächlich
     * geschrieben wurde.
     */
    const storageKey = getActiveStorageKey();
    savePersistedState(buildState([task('t-a')], []));

    const entry = outboxEntry('t-a', 'pending');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-a', sentDeleted: false });

    const geschrieben = persistSyncOutboxNow();
    expect(geschrieben, 'das Schreiben gelingt').toBe(true);

    const rohdaten = JSON.parse(localStorage.getItem(storageKey)!);
    const gespeicherterAuftrag = (rohdaten.syncOutbox as SyncOutboxEntry[]).find(
      (e) => e.id === entry.id,
    );
    expect(
      gespeicherterAuftrag?.sentContentKey,
      'der Nachweis steht im gespeicherten Bestand',
    ).toBe('stand-a');
  });

  it('10 — das gezielte Schreiben rührt die übrigen Bereiche nicht an', () => {
    /*
     * Ein vollständiges Speichern mitten im Lauf würde den Stand der anderen
     * Bereiche aus den Arbeitsspeichern übernehmen, die während einer
     * Synchronisation bewusst auseinanderlaufen. Geschrieben wird nur die
     * Warteschlange.
     */
    const storageKey = getActiveStorageKey();
    const vorher = buildState([task('t-a', { status: 'done' })], []);
    savePersistedState(vorher);

    const entry = outboxEntry('t-a', 'pending');
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, { sentContentKey: 'stand-a', sentDeleted: false });
    persistSyncOutboxNow();

    const nachher = JSON.parse(localStorage.getItem(storageKey)!);
    expect(nachher.tasks?.[0]?.status, 'die Aufgaben bleiben, wie sie waren').toBe('done');
    expect(nachher.syncOutbox, 'nur die Warteschlange ist neu').toHaveLength(1);
  });

  it('11 — ein Löschnachweis überlebt und wird sauber abgeschlossen', () => {
    const geloescht = { ...task('t-a'), sync: syncMeta(1, { deleted: true }) };
    const entry = outboxEntry(geloescht.id, 'error', { operation: 'delete' });
    resetSyncOutboxForTests([entry]);
    recordOutboxSentProof(entry.id, { sentContentKey: undefined, sentDeleted: true });

    // Neustart: der Bestand wird neu geladen.
    resetSyncOutboxForTests(getSyncOutboxSnapshot());
    expect(getSyncOutboxSnapshot()[0]?.sentDeleted, 'der Löschnachweis überlebt').toBe(true);

    const state = buildState([geloescht], getSyncOutboxSnapshot());
    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ tasks: [taskRow(task('t-a'), 2, true)] }),
    );

    expect(result.conflicts, 'die eigene Löschung ist kein Streit').toEqual([]);
    const auftrag = getSyncOutboxSnapshot().find((e) => e.entityId === geloescht.id);
    expect(auftrag?.status, 'erledigt — es gibt nichts mehr zu senden').toBe('completed');
    expect(auftrag?.sentDeleted, 'und der Nachweis ist aufgelöst').toBeUndefined();
  });

  it('12 — nach dem Wiederanlauf passen Auftragslage und bestätigte Basis zusammen', () => {
    /*
     * Die zusammenfassende Zusage: Für jede Aufgabe gilt danach entweder
     * „erledigt" oder „sendebereit auf der übernommenen Basis" — nie
     * „sendebereit auf der alten Basis", denn genau daran scheiterte der
     * nächste Versuch.
     */
    const a = { ...task('t-a'), sync: syncMeta(0) };
    const b = { ...task('t-b', { status: 'done' }), sync: syncMeta(1) };
    const entryA = outboxEntry(a.id, 'blocked', { operation: 'create' });
    const entryB = outboxEntry(b.id, 'pending');
    resetSyncOutboxForTests([entryA, entryB]);

    const result = mergeRemoteWorkspacePullIntoState(
      buildState([a, b], [entryA, entryB]),
      emptyPull({
        tasks: [taskRow(task('t-a'), 1), taskRow(task('t-b', { status: 'archived' }), 2)],
      }),
    );

    for (const aufgabe of result.state.tasks ?? []) {
      const auftraege = getSyncOutboxSnapshot().filter((e) => e.entityId === aufgabe.id);
      const offen = auftraege.filter((e) => e.status !== 'completed');
      if (offen.length === 0) continue;
      /*
       * Ein offener Auftrag darf nie auf einer Basis stehen, die der Server
       * längst überholt hat, ohne dass die Entität das weiss.
       */
      const remoteVersion = aufgabe.id === a.id ? 1 : 2;
      if (offen.some((e) => e.status === 'pending')) {
        expect(
          aufgabe.sync?.version === remoteVersion || aufgabe.sync?.version === 1,
          `Auftragslage und Basis von ${aufgabe.id} stammen aus derselben Entscheidung`,
        ).toBe(true);
      }
    }

    expect(result.state.tasks?.find((t) => t.id === a.id)?.sync?.version).toBe(1);
  });
});
