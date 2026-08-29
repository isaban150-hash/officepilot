/**
 * DIAGNOSE OUTBOX-PRESERVE-ON-PULL-01 — reiner Nachweistest, kein Fix.
 *
 * Realbefund: Ein über den Intake angelegter Kunde und sein Vorgang sind lokal
 * vorhanden, der nächste Sync meldet aber „Gesendet: 0" bei „Fehler: 0". Aus
 * der Fallunterscheidung im Push folgt, dass zum Zeitpunkt des Syncs **kein**
 * Outbox-Eintrag mit erlaubtem Entitätstyp vorlag.
 *
 * Geprüfte Vermutung: `applyStateToStores` ruft
 * `hydrateSyncOutbox(state.syncOutbox ?? [])` und **ersetzt** damit die Outbox
 * durch die des angewendeten Zustands. Trägt ein Pull-Kandidat einen älteren
 * `syncOutbox`, verschwinden alle danach eingereihten Einträge.
 *
 * Dass dieses Risiko real ist, steht im Code selbst: `workspaceProvisioningService`
 * schützt sich ausdrücklich davor („Ohne den aktuellen Outbox-Snapshot würden
 * die gerade erzeugten Einträge durch einen alten `state.syncOutbox` wieder
 * verschwinden"). Ob der Pull-Apply-Pfad denselben Schutz hat, klärt dieser Test.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { applySyncPullCandidateSafely } from './syncPullPersistService';
import { createCustomer } from '../customerService';
import { commitVorgangMutation, hydrateVorgangStore } from '../vorgangService';
import { bootstrapBusinessState } from '../storage/storageBootstrapService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from './syncClientService';
import { resetSyncCoordinatorForTests } from './syncCoordinator';
import { getVorgangStoreSnapshot } from '../vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';
import type {
  SyncCoordinatorReport,
  SyncEntityType,
  SyncOutboxEntry,
  SyncOutboxStatus,
} from '../../types/sync';

function entry(
  id: string,
  entityType: SyncEntityType,
  entityId: string,
  status: SyncOutboxStatus,
): SyncOutboxEntry {
  return {
    id,
    entityType,
    entityId,
    operation: 'create',
    version: 1,
    queuedAt: '2026-08-29T11:00:00.000Z',
    retryCount: 0,
    status,
  };
}

const WORKSPACE = 'ws-outbox-preserve-01';

function emptyReport(): SyncCoordinatorReport {
  return {
    startedAt: '2026-08-29T12:00:00.000Z',
    finishedAt: '2026-08-29T12:00:01.000Z',
    durationMs: 1000,
    uploadCount: 0,
    downloadCount: 0,
    conflictCount: 0,
    retryAttempts: 0,
    mergedEntityCount: 0,
    errorCount: 0,
    errors: [],
    conflicts: [],
    syncedEntities: [],
  } as unknown as SyncCoordinatorReport;
}

function outboxKeys(): string[] {
  return getSyncOutboxSnapshot().map((entry) => `${entry.entityType}:${entry.operation}`);
}

function outboxStatusById(): Record<string, string> {
  return Object.fromEntries(
    getSyncOutboxSnapshot().map((entry) => [entry.entityId, entry.status]),
  );
}

describe('DIAGNOSE OUTBOX-PRESERVE-ON-PULL-01', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    resetSyncCoordinatorForTests();
    hydrateSyncClient({ ...createSyncClient(), workspaceId: WORKSPACE });
    bootstrapBusinessState({ userId: 'user-outbox-preserve', workspaceId: WORKSPACE });
  });

  it('reproduziert den Realablauf: Anlage, alter Pull-Kandidat, Apply', () => {
    /* 1. Der Zustand **vor** der Anlage — genau das, was ein Pull-Kandidat
     *    tragen würde, der aus einem älteren Snapshot stammt. */
    const staleSnapshot: AppPersistedState = buildPersistedStateSnapshot();
    const staleOutboxSize = (staleSnapshot.syncOutbox ?? []).length;

    /* 2. Kunde und Vorgang über die produktiven Pfade anlegen. Beide führen
     *    intern `persistAll()` aus, das den Change-Tracker auslöst. */
    const created = createCustomer({
      name: 'Beispiel Projektbau GmbH',
      street: 'Beispielstraße 2',
      zip: '20000',
      city: 'Beispielstadt',
    });
    expect(created.success).toBe(true);
    if (!created.success) throw new Error('customer create failed');

    hydrateVorgangStore([createTestVorgang({ id: 'v-outbox-preserve' })]);
    const committed = commitVorgangMutation('v-outbox-preserve', (current) => ({
      ...current,
      customerId: created.customer.id,
      title: 'Beispielauftrag',
    }));
    expect(committed.ok).toBe(true);

    /* 3. Vor dem Pull: Sind die Einträge da? */
    const before = outboxKeys();
    const hadCustomerCreate = before.includes('customer:create');
    const hadVorgangEntry = before.some((key) => key.startsWith('vorgang:'));

    // Diagnose-Ausgabe für den Bericht, keine Zusicherung.
    expect(Array.isArray(before)).toBe(true);

    /* 4. Ein Pull-Kandidat auf Basis des **alten** Outbox-Standes. Der übrige
     *    Zustand ist der aktuelle — nur `syncOutbox` ist veraltet, genau wie
     *    bei einem Kandidaten, der vor der Anlage aufgebaut wurde. */
    const current = buildPersistedStateSnapshot();
    const pullCandidate: AppPersistedState = {
      ...current,
      syncOutbox: staleSnapshot.syncOutbox ?? [],
    };

    /* 5. Der produktive Pull-Apply-Pfad. */
    const applied = applySyncPullCandidateSafely({
      state: pullCandidate,
      report: emptyReport(),
    });

    /* 6. Sind die Einträge danach noch da? */
    const after = outboxKeys();

    /* Der Nachweis, sichtbar im Fehlertext: Was war vorher da, was danach. */
    expect({
      staleOutboxSize,
      persisted: applied.persisted,
      before,
      hadCustomerCreate,
      hadVorgangEntry,
      after,
      customerSurvived: after.includes('customer:create'),
      vorgangSurvived: after.some((key) => key.startsWith('vorgang:')),
    }).toEqual({
      staleOutboxSize,
      persisted: true,
      before,
      hadCustomerCreate: true,
      hadVorgangEntry: true,
      after: before,
      customerSurvived: true,
      vorgangSurvived: true,
    });
  });

  it('Push-Ergebnisse im Kandidaten bleiben erhalten, neue Einträge kommen hinzu', () => {
    /*
     * Die Richtung ist entscheidend und nicht symmetrisch: Der Push dieses
     * Laufs markiert `completed` und `blocked` **nur** in seiner eigenen Kopie
     * — `acknowledgeChanges` schreibt sie nicht in den Store. Für gemeinsame
     * Einträge ist der Kandidat damit der neuere Stand.
     *
     * Der Store ist nur dort führend, wo er Einträge kennt, die der Kandidat
     * gar nicht hat: die im `await`-Fenster neu eingereihten.
     *
     * Würde der Store pauschal gewinnen, ginge jedes Push-Ergebnis verloren und
     * bereits gesendete Einträge liefen endlos erneut.
     */
    const candidateEntries = [
      entry('e-a', 'vorgang', 'v-a', 'completed'),
      entry('e-b', 'vorgang', 'v-b', 'blocked'),
      entry('e-c', 'customer', 'c-c', 'error'),
    ];
    const storeEntries = [
      // Veralteter Store-Stand derselben Einträge …
      entry('e-a', 'vorgang', 'v-a', 'pending'),
      entry('e-b', 'vorgang', 'v-b', 'pending'),
      entry('e-c', 'customer', 'c-c', 'pending'),
      // … plus einer, den der Kandidat nicht kennt.
      entry('e-neu', 'customer', 'c-neu', 'pending'),
    ];

    resetSyncOutboxForTests(storeEntries);
    const candidate: AppPersistedState = {
      ...buildPersistedStateSnapshot(),
      syncOutbox: candidateEntries,
    };

    const applied = applySyncPullCandidateSafely({ state: candidate, report: emptyReport() });

    expect(applied.persisted).toBe(true);
    expect(outboxStatusById()).toEqual({
      'v-a': 'completed',
      'v-b': 'blocked',
      'c-c': 'error',
      'c-neu': 'pending',
    });
    // Keine Verdopplung: drei aus dem Kandidaten, einer neu hinzugekommen.
    expect(getSyncOutboxSnapshot()).toHaveLength(4);
  });

  it('die Fachdaten des Pull-Kandidaten werden weiterhin übernommen', () => {
    /*
     * Der Schutz gilt ausschliesslich der Outbox. Alles andere am Kandidaten
     * muss unverändert ankommen — sonst wäre der Pull wirkungslos.
     */
    resetSyncOutboxForTests([entry('e-keep', 'customer', 'c-keep', 'blocked')]);

    const base = buildPersistedStateSnapshot();
    const candidate: AppPersistedState = {
      ...base,
      vorgaenge: [createTestVorgang({ id: 'v-from-cloud', title: 'Aus der Cloud' })],
      syncOutbox: [],
    };

    const applied = applySyncPullCandidateSafely({ state: candidate, report: emptyReport() });

    expect(applied.persisted).toBe(true);
    // Fachdaten übernommen …
    expect(getVorgangStoreSnapshot().map((v) => v.id)).toEqual(['v-from-cloud']);
    // … und die lokale Outbox samt Status unangetastet.
    expect(outboxStatusById()).toEqual({ 'c-keep': 'blocked' });
  });
});
