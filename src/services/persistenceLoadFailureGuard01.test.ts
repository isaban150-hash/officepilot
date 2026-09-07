/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — „keine Daten" und „Daten nicht
 * lesbar" sind nicht dasselbe.
 *
 * Der Ladepfad fing bisher jeden Fehler und lieferte `null` — denselben Wert,
 * den auch ein leerer Speicher ergibt. Die Aufrufer schlossen daraus auf einen
 * Erststart, wendeten leere Seed-Daten an und **schrieben sie über den
 * vorhandenen Schlüssel**. Ein Parse-, Migrations- oder Normalisierungsfehler
 * löschte damit den gesamten lokalen Bestand des Nutzers.
 *
 * Genau das ist die Voraussetzung, die vor jeder weiteren Storage-Migration
 * stehen muss: Eine fehlschlagende Migration darf blockieren, aber niemals
 * überschreiben.
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSeedState,
  hydrateStoresFromStorage,
  loadPersistedStateResultFromKey,
  resetBusinessStateWriteLocksForTests,
  savePersistedStateToKey,
} from './persistenceService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import {
  buildStorageKey,
  setActiveStorageScope,
  type StorageScope,
} from './storage/storageScopeService';
import { getAllVorgaenge } from './vorgangService';
import { STORAGE_VERSION } from './sync/syncMigrationService';
import { getSyncClient, resetSyncClientForTests } from './sync/syncClientService';
import { getSyncOutboxSnapshot, hydrateSyncOutbox } from './sync/syncOutboxService';
import { createTestVorgang } from '../test/fixtures';

const SCOPE: StorageScope = { type: 'guest' };
const KEY = buildStorageKey(SCOPE);

/** Ein gültiger V5-Zustand mit genau einem Vorgang — der „Bestand" des Nutzers. */
function writeValidState(): string {
  const seed = createSeedState();
  savePersistedStateToKey(SCOPE, { ...seed, vorgaenge: [createTestVorgang({ id: 'v-bestand' })] });
  const raw = localStorage.getItem(KEY);
  expect(raw, 'Vorbereiteter Bestand fehlt').not.toBeNull();
  return raw!;
}

beforeEach(() => {
  localStorage.clear();
  // LOAD_FAILED-UX-GUARD-01B — Sperren sind Modulzustand; kein Fall erbt den anderen.
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope(SCOPE);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — die drei Ladezustände', () => {
  it('R1: ohne gespeicherten Zustand meldet der Ladepfad `absent`', () => {
    expect(loadPersistedStateResultFromKey(KEY)).toEqual({ status: 'absent', storageKey: KEY });
  });

  it('R1b: `absent` darf weiterhin zu Seed-Daten führen', () => {
    const result = bootstrapBusinessState();

    expect(result.loadFailed ?? false).toBe(false);
    expect(localStorage.getItem(KEY), 'Seed wurde nicht geschrieben').not.toBeNull();
  });

  it('R4: ein gültiger Zustand wird unverändert geladen', () => {
    writeValidState();

    const result = loadPersistedStateResultFromKey(KEY);
    expect(result.status).toBe('loaded');
    expect(
      result.status === 'loaded' ? result.state.vorgaenge.map((v) => v.id) : [],
    ).toEqual(['v-bestand']);
  });

  it('R2: ungültiges JSON meldet `failed`, nicht `absent`', () => {
    localStorage.setItem(KEY, '{kein gültiges json');

    const result = loadPersistedStateResultFromKey(KEY);
    expect(result.status, 'Ein Lesefehler galt als „keine Daten"').toBe('failed');
  });

  it('R3: eine unlesbare Struktur meldet `failed`, nicht `absent`', () => {
    // Syntaktisch gültig, aber von keinem Versionsvalidator erkannt.
    localStorage.setItem(KEY, JSON.stringify({ version: 99, irgendwas: true }));

    expect(loadPersistedStateResultFromKey(KEY).status).toBe('failed');
  });
});

describe('PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — der Bestand bleibt', () => {
  /*
   * R5/R6 — der eigentliche Schaden. Geprüft wird nicht, ob ein vorheriger
   * Arbeitsspeicherzustand überlebt, sondern der Kaltstart: Beim Hochfahren
   * gibt es noch keinen Fachzustand, und genau dort schrieb der Seed bisher
   * über die vorhandenen Daten.
   */
  it('R5: ein Kaltstart auf beschädigtem Bestand schreibt keine Seed-Daten', () => {
    writeValidState();
    const rawBefore = 'BESCHÄDIGT{';
    localStorage.setItem(KEY, rawBefore);

    const result = bootstrapBusinessState();

    expect(result.loadFailed, 'Der Fehler wurde als Erststart maskiert').toBe(true);
    expect(localStorage.getItem(KEY), 'Der Rohwert wurde überschrieben').toBe(rawBefore);
    expect(getAllVorgaenge(), 'Ein leerer Fachzustand wurde angewendet').toEqual([]);
  });

  it('R5b: dasselbe über hydrateStoresFromStorage', () => {
    const rawBefore = JSON.stringify({ version: 99, kaputt: true });
    localStorage.setItem(KEY, rawBefore);

    hydrateStoresFromStorage();

    expect(localStorage.getItem(KEY), 'Der Rohwert wurde überschrieben').toBe(rawBefore);
  });

  /*
   * R6 — nicht nur das Ergebnis, sondern der Schreibvorgang selbst: Bei einem
   * Ladefehler darf die Schreibgrenze gar nicht erst erreicht werden.
   */
  it('R6: bei einem Ladefehler wird der Speicher überhaupt nicht beschrieben', () => {
    localStorage.setItem(KEY, '{kaputt');
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');

    bootstrapBusinessState();

    const writesToKey = setItem.mock.calls.filter(([key]) => key === KEY);
    expect(writesToKey, `Schreibzugriffe auf ${KEY}: ${writesToKey.length}`).toEqual([]);
  });

  /*
   * R7 — ein Ladefehler in einem Bereich darf keinen anderen anfassen.
   */
  it('R7: ein anderer Storage-Bereich bleibt unberührt', () => {
    const otherScope: StorageScope = { type: 'workspace', workspaceId: 'ws-fremd' };
    const otherKey = buildStorageKey(otherScope);
    localStorage.setItem(otherKey, 'fremder-bestand');
    localStorage.setItem(KEY, '{kaputt');

    bootstrapBusinessState();

    expect(localStorage.getItem(otherKey)).toBe('fremder-bestand');
  });

  /*
   * R8 — der Rohwert muss zeichengenau erhalten bleiben, nicht nur strukturell.
   * Ein „normalisiert und zurückgeschrieben" wäre bereits Datenverlust.
   */
  it('R8: der Rohwert bleibt zeichengenau erhalten', () => {
    const rawBefore = '  {"version": 5, "unvollständig": true}  ';
    localStorage.setItem(KEY, rawBefore);

    bootstrapBusinessState();

    expect(localStorage.getItem(KEY)).toBe(rawBefore);
  });
});

/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B2 — der späte Fehler.
 *
 * Die Ladekette hat mehrere Stufen. Ein Zustand konnte die Versionsprüfung und
 * die Migration bestehen und erst danach an der Aufbereitung scheitern — nach
 * dem Rückschreiben des migrierten Standes und nach der Übernahme des
 * Sync-Zustands. Beides geschah also, bevor feststand, dass der Ladevorgang
 * überhaupt gelingt.
 */
describe('PERSISTENCE-MIGRATION-FAILURE-GUARD-01B2 — Fehler nach der Migration', () => {
  /**
   * Ein gültiger V4-Zustand mit einer Auffälligkeit, die erst die spätere
   * Aufbereitung bemerkt: `documents` ist kein Array, und `cloneVorgang` ruft
   * darauf `.map` auf. Die Versionsprüfung schaut nur auf die obersten Felder.
   */
  function buildV4StateFailingLate(): Record<string, unknown> {
    return {
      version: 4,
      syncClient: { deviceId: 'dev-1', workspaceId: 'ws-1' },
      syncOutbox: [],
      setup: { companyName: 'Alt GmbH', setupComplete: true },
      inboxItems: [],
      tasks: [],
      documents: [],
      vorgaenge: [
        {
          id: 'v-alt',
          title: 'Bestandsvorgang',
          customer: 'Kunde',
          baustelle: '',
          status: 'in_bearbeitung',
          orderPositions: [],
          // 🔴 Kein Array — bemerkt erst `cloneVorgang` in der Aufbereitung.
          documents: null,
          tasks: [],
          photos: [],
          invoices: [],
        },
      ],
    };
  }

  it('R9: eine nach der Migration scheiternde Ladekette lässt den Rohwert unberührt', () => {
    const rawBefore = JSON.stringify(buildV4StateFailingLate());
    localStorage.setItem(KEY, rawBefore);

    const result = loadPersistedStateResultFromKey(KEY);

    expect(result.status, 'Der späte Fehler wurde nicht erkannt').toBe('failed');
    expect(
      localStorage.getItem(KEY),
      'Der migrierte Stand wurde trotz Ladefehler zurückgeschrieben',
    ).toBe(rawBefore);
  });

  it('R10: dabei wird der Speicher überhaupt nicht beschrieben', () => {
    localStorage.setItem(KEY, JSON.stringify(buildV4StateFailingLate()));
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');

    loadPersistedStateResultFromKey(KEY);

    expect(setItem.mock.calls.filter(([key]) => key === KEY)).toEqual([]);
  });

  /*
   * R11 — der Sync-Zustand ist Teil desselben gespeicherten Standes und darf
   * bei einem Ladefehler ebenso wenig übernommen werden wie die Fachdaten.
   */
  it('R11: der Sync-Zustand bleibt bei einem Ladefehler unverändert', () => {
    resetSyncClientForTests({ deviceId: 'dev-A', workspaceId: 'ws-A' });
    hydrateSyncOutbox([]);

    localStorage.setItem(KEY, JSON.stringify(buildV4StateFailingLate()));
    const result = loadPersistedStateResultFromKey(KEY);

    expect(result.status).toBe('failed');
    expect(getSyncClient(), 'Ein fremder Sync-Client wurde übernommen').toMatchObject({
      deviceId: 'dev-A',
      workspaceId: 'ws-A',
    });
  });

  it('R11b: auch die Outbox bleibt unverändert', () => {
    resetSyncClientForTests({ deviceId: 'dev-A', workspaceId: 'ws-A' });
    hydrateSyncOutbox([]);

    const state = buildV4StateFailingLate();
    state.syncOutbox = [
      { id: 'out-fremd', entityType: 'vorgang', entityId: 'v-alt', operation: 'upsert' },
    ];
    localStorage.setItem(KEY, JSON.stringify(state));

    loadPersistedStateResultFromKey(KEY);

    expect(getSyncOutboxSnapshot(), 'Eine fremde Outbox wurde übernommen').toEqual([]);
  });

  /*
   * R12 — die Gegenprobe. Verhindert wird ausschliesslich das Schreiben auf
   * einem letztlich gescheiterten Ladevorgang; eine vollständig gelungene
   * Migration wird weiterhin gespeichert.
   */
  it('R12: eine vollständig gelungene Migration wird weiterhin zurückgeschrieben', () => {
    const state = buildV4StateFailingLate();
    (state.vorgaenge as Array<Record<string, unknown>>)[0]!.documents = [];
    const rawBefore = JSON.stringify(state);
    localStorage.setItem(KEY, rawBefore);

    const result = loadPersistedStateResultFromKey(KEY);

    expect(result.status).toBe('loaded');
    const rawAfter = localStorage.getItem(KEY);
    expect(rawAfter, 'Die gelungene Migration wurde nicht gespeichert').not.toBe(rawBefore);
    // FIRST-CLASS-LOCAL-INVOICE-STORE-01B — die Kette endet jetzt bei V6.
    expect(JSON.parse(rawAfter!).version, 'Der gespeicherte Stand ist nicht aktuell').toBe(
      STORAGE_VERSION,
    );
  });
});
