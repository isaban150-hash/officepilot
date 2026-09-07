/**
 * LOAD_FAILED-UX-GUARD-01B — der Schutz endet bisher mit dem Ladevorgang.
 *
 * `PERSISTENCE-MIGRATION-FAILURE-GUARD-01B/01B2` bewahrt den Rohwert, wenn ein
 * gespeicherter Zustand nicht gelesen werden kann: kein Seed, kein Schreiben,
 * kein halb übernommener Stand.
 *
 * Danach steht die App aber mit leeren Fachspeichern da — und `persistAll()`
 * baut seinen Schnappschuss **aus diesen Speichern**, nicht aus dem
 * Ladeergebnis. Die erste beliebige Nutzeraktion überschreibt damit genau den
 * Bestand, den der Ladepfad gerettet hat.
 *
 * Diese Suite hält die zweite Schutzschicht fest: Solange für einen
 * Speicherbereich ein Ladefehler gilt, wird er nicht beschrieben.
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyStateToStores,
  createSeedState,
  isBusinessStateWriteLocked,
  loadPersistedStateResultFromKey,
  persistAll,
  savePersistedState,
  savePersistedStateToKey,
} from './persistenceService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import {
  buildStorageKey,
  setActiveStorageScope,
  type StorageScope,
} from './storage/storageScopeService';
import { createTestVorgang } from '../test/fixtures';

const SCOPE_A: StorageScope = { type: 'workspace', workspaceId: 'ws-a' };
const SCOPE_B: StorageScope = { type: 'workspace', workspaceId: 'ws-b' };
const KEY_A = buildStorageKey(SCOPE_A);
const KEY_B = buildStorageKey(SCOPE_B);

/** Ein gültiger Bestand für einen Bereich. */
function writeValidState(scope: StorageScope, vorgangId: string): string {
  setActiveStorageScope(scope);
  const seed = createSeedState();
  savePersistedStateToKey(scope, {
    ...seed,
    vorgaenge: [createTestVorgang({ id: vorgangId })],
  });
  const raw = localStorage.getItem(buildStorageKey(scope));
  expect(raw).not.toBeNull();
  return raw!;
}

/** Erzeugt einen aktiven Ladefehler für den Bereich und liefert den Rohwert. */
function makeLoadFailed(scope: StorageScope): string {
  const key = buildStorageKey(scope);
  const raw = '{beschädigt';
  localStorage.setItem(key, raw);
  setActiveStorageScope(scope);
  const result = bootstrapBusinessState({ workspaceId: (scope as { workspaceId: string }).workspaceId });
  expect(result.loadFailed, 'Der Ladefehler wurde nicht erkannt').toBe(true);
  return raw;
}

beforeEach(() => {
  localStorage.clear();
  setActiveStorageScope({ type: 'guest' });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LOAD_FAILED-UX-GUARD-01B — Schreibsperre je Speicherbereich', () => {
  it('R1: nach einem Ladefehler überschreibt persistAll den Bestand nicht', () => {
    const rawBefore = makeLoadFailed(SCOPE_A);

    const result = persistAll();

    expect(result.success, 'Der Schreibvorgang meldete Erfolg').toBe(false);
    expect(localStorage.getItem(KEY_A), 'Der Bestand wurde überschrieben').toBe(rawBefore);
  });

  it('R2: auch ein direkter Business-Save schreibt nicht', () => {
    const rawBefore = makeLoadFailed(SCOPE_A);

    expect(savePersistedState(createSeedState())).toBe(false);
    expect(savePersistedStateToKey(SCOPE_A, createSeedState()).success).toBe(false);
    expect(localStorage.getItem(KEY_A)).toBe(rawBefore);
  });

  it('R2b: dabei wird der Speicher überhaupt nicht beschrieben', () => {
    makeLoadFailed(SCOPE_A);
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');

    persistAll();
    savePersistedState(createSeedState());

    expect(setItem.mock.calls.filter(([key]) => key === KEY_A)).toEqual([]);
  });

  it('R3: ein gesunder anderer Bereich bleibt beschreibbar', () => {
    const rawA = makeLoadFailed(SCOPE_A);

    expect(isBusinessStateWriteLocked(KEY_A)).toBe(true);
    expect(isBusinessStateWriteLocked(KEY_B)).toBe(false);
    expect(savePersistedStateToKey(SCOPE_B, createSeedState()).success).toBe(true);
    expect(localStorage.getItem(KEY_B)).not.toBeNull();
    expect(localStorage.getItem(KEY_A), 'Der gesperrte Bereich wurde berührt').toBe(rawA);
  });

  it('R4: ein erfolgreicher Load desselben Bereichs hebt die Sperre auf', () => {
    makeLoadFailed(SCOPE_A);
    expect(isBusinessStateWriteLocked(KEY_A)).toBe(true);

    // Der Bereich enthält wieder einen lesbaren Bestand.
    localStorage.setItem(KEY_A, JSON.stringify({ ...createSeedState() }));
    setActiveStorageScope(SCOPE_A);
    const result = bootstrapBusinessState({ workspaceId: 'ws-a' });

    expect(result.loadFailed ?? false).toBe(false);
    expect(isBusinessStateWriteLocked(KEY_A)).toBe(false);
    expect(persistAll().success).toBe(true);
  });

  it('R5: ein erfolgreicher Load eines anderen Bereichs hebt die Sperre nicht auf', () => {
    const rawA = makeLoadFailed(SCOPE_A);
    writeValidState(SCOPE_B, 'v-b');

    setActiveStorageScope(SCOPE_B);
    bootstrapBusinessState({ workspaceId: 'ws-b' });

    expect(isBusinessStateWriteLocked(KEY_A), 'Ein fremder Bereich löste die Sperre').toBe(true);
    expect(localStorage.getItem(KEY_A)).toBe(rawA);
  });

  it('R6: ein echter Erststart bleibt unverändert — Seed wird gespeichert', () => {
    setActiveStorageScope(SCOPE_A);
    const result = bootstrapBusinessState({ workspaceId: 'ws-a' });

    expect(result.loadFailed ?? false).toBe(false);
    expect(isBusinessStateWriteLocked(KEY_A)).toBe(false);
    expect(localStorage.getItem(KEY_A), 'Der Seed wurde nicht gespeichert').not.toBeNull();
  });

  it('R7: ein erfolgreich geladener Bestand bleibt beschreibbar', () => {
    writeValidState(SCOPE_A, 'v-a');
    setActiveStorageScope(SCOPE_A);

    expect(loadPersistedStateResultFromKey(KEY_A).status).toBe('loaded');
    expect(isBusinessStateWriteLocked(KEY_A)).toBe(false);
    bootstrapBusinessState({ workspaceId: 'ws-a' });
    expect(persistAll().success).toBe(true);
  });

  /*
   * R8 — ein Schreibversuch ist kein Wiederherstellungssignal. Wer bei
   * gesperrtem Bereich schreibt, darf die Sperre damit nicht aufheben; sonst
   * genügte ein zweiter Versuch, um den Bestand doch zu überschreiben.
   */
  it('R8: ein Schreibversuch hebt die Sperre nicht auf', () => {
    const rawBefore = makeLoadFailed(SCOPE_A);

    persistAll();
    persistAll();
    savePersistedState(createSeedState());

    expect(isBusinessStateWriteLocked(KEY_A)).toBe(true);
    expect(localStorage.getItem(KEY_A)).toBe(rawBefore);
  });

  /*
   * R9 — der Weg zurück. Eine ausdrückliche Wiederherstellung setzt den
   * vollständigen Zustand in die Speicher; erst diese Übernahme macht den
   * Bereich wieder beschreibbar. Dieselbe Reihenfolge nutzt der bestehende
   * Sicherungs-Rückweg (`commitRestoredState`).
   */
  it('R9: eine vollständige Übernahme in die Speicher gibt den Bereich frei', () => {
    makeLoadFailed(SCOPE_A);
    expect(isBusinessStateWriteLocked(KEY_A)).toBe(true);

    setActiveStorageScope(SCOPE_A);
    applyStateToStores({
      ...createSeedState(),
      vorgaenge: [createTestVorgang({ id: 'v-wiederhergestellt' })],
    });

    expect(isBusinessStateWriteLocked(KEY_A)).toBe(false);
    expect(persistAll().success).toBe(true);
  });
});
