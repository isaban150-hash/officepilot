/**
 * REAL-DEVICE-CLOUD-COMPANY-TRACKER-ECHO-FIX-01 — auf dem echten iPhone kehrte
 * der Cloud-Sicherungshinweis nach einem erfolgreichen Firmen-Sync ohne jede
 * fachliche Änderung zurück.
 *
 * Ursache: `applyStateToStores` hydriert die Stores mit Default-Auffüllung und
 * fester Schlüsselreihenfolge, setzt die Tracker-Baseline aber aus dem **rohen**
 * Kandidaten. Ein späterer `persistAll()` vergleicht dagegen den
 * store-normalisierten `buildPersistedStateSnapshot()` — und meldet eine
 * Änderung, die es nie gab.
 *
 * Betroffen sind ausschließlich die beiden Remote-Apply-Pfade:
 * `applySyncPullCandidateSafely` (manueller Sync) und
 * `applyPersistedStateFromSync` (Cloud-Bootstrap).
 *
 * Reine Messung mit Produktionsfunktionen, neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPersistedStateFromSync,
  applyStateToStores,
  buildPersistedStateSnapshot,
  persistAll,
} from '../persistenceService';
import * as persistenceService from '../persistenceService';
import { applySyncPullCandidateSafely } from './syncPullPersistService';
import { createEmptySyncSimulationReport } from './syncSimulationReportService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import {
  getSyncOutboxSnapshot,
  hasPendingCompanyCloudBackup,
  resetSyncOutboxForTests,
} from './syncOutboxService';
import { createSyncClient } from './syncClientService';
import { resetSyncCoordinatorForTests } from './syncCoordinator';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { STORAGE_VERSION } from './syncMigrationService';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';
import type { SyncCoordinatorReport } from '../../types/sync';

const WORKSPACE_ID = 'tracker-echo-ws';
const COMPANY = 'Nordwind Haustechnik GmbH';

const BASE_SETUP = {
  ...DEFAULT_SETUP,
  companyName: COMPANY,
  industry: 'Sanitär',
  taxStatus: 'standard_19' as const,
  setupComplete: true,
  setupVersion: 1,
};

const BASE_PROFILE = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: COMPANY,
  street: 'Hafenweg 3',
  city: 'Hamburg',
};

/** Dreht die Schlüsselreihenfolge um — fachlich identisch, andere Darstellung. */
function reversedKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.keys(value)
    .reverse()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = value[key];
      return acc;
    }, {}) as T;
}

/** Entfernt ein Feld, das die Hydrierung aus den Defaults wieder ergänzt. */
function withoutField<T extends Record<string, unknown>>(value: T, field: keyof T): T {
  const clone = { ...value };
  delete clone[field];
  return clone;
}

function buildState(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    syncOutbox: [],
    setup: { ...BASE_SETUP },
    companyProfile: { ...BASE_PROFILE },
    setupSync: {
      version: 7,
      updatedAt: '2026-08-22T10:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    companyProfileSync: {
      version: 9,
      updatedAt: '2026-08-22T10:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    savedAt: '2026-08-22T10:00:00.000Z',
    ...overrides,
  } as unknown as AppPersistedState;
}

function emptyReport(): SyncCoordinatorReport {
  return {
    ...createEmptySyncSimulationReport('2026-08-22T10:00:00.000Z'),
    retryAttempts: 0,
    uploadCount: 0,
    downloadCount: 0,
  } as SyncCoordinatorReport;
}

const companyEntries = () =>
  getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'company_setup' || entry.entityType === 'company_profile',
  );

/** Lässt jeden Schreibversuch in den Speicher scheitern — wie ein Quota-Fehler. */
function failNextStorageWrites() {
  return vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
}

/** Bringt den lokalen Stand als Ausgangslage in Stores, Speicher und Baseline. */
function establishLocalBaseline(): void {
  applyStateToStores(buildState());
  persistAll();
  resetSyncOutboxForTests();
}

describe('REAL-DEVICE-CLOUD-COMPANY-TRACKER-ECHO-FIX-01', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests();
    resetSyncChangeTrackerForTests();
    resetSyncCoordinatorForTests();
  });

  it('A: manueller Pull mit anderer Schlüsselreihenfolge erzeugt kein Echo', () => {
    establishLocalBaseline();

    // Wie aus Postgres jsonb: identische Felder, andere Reihenfolge.
    const remote = buildState({
      setup: reversedKeys({ ...BASE_SETUP }),
      companyProfile: reversedKeys({ ...BASE_PROFILE }),
    } as Partial<AppPersistedState>);

    const applied = applySyncPullCandidateSafely({ state: remote, report: emptyReport() });
    expect(applied.persisted).toBe(true);

    resetSyncOutboxForTests();
    persistAll();

    expect(companyEntries(), 'Tracker-Echo nach Pull').toEqual([]);
    expect(hasPendingCompanyCloudBackup()).toBe(false);
    // Die fachlichen Firmendaten sind unverändert.
    expect(buildPersistedStateSnapshot().setup.companyName).toBe(COMPANY);
    expect(buildPersistedStateSnapshot().companyProfile?.street).toBe('Hafenweg 3');
  });

  it('B: manueller Pull mit fehlendem Defaultfeld erzeugt kein Echo', () => {
    establishLocalBaseline();

    const remote = buildState({
      setup: withoutField({ ...BASE_SETUP }, 'communicationChannel'),
      companyProfile: withoutField({ ...BASE_PROFILE }, 'skontoDays'),
    } as Partial<AppPersistedState>);

    expect(applySyncPullCandidateSafely({ state: remote, report: emptyReport() }).persisted).toBe(
      true,
    );

    resetSyncOutboxForTests();
    persistAll();

    expect(companyEntries(), 'Echo durch Default-Auffüllung').toEqual([]);
    expect(hasPendingCompanyCloudBackup()).toBe(false);
  });

  it('C: Cloud-Bootstrap-Apply erzeugt kein Echo', () => {
    establishLocalBaseline();

    applyPersistedStateFromSync(
      buildState({
        setup: reversedKeys({ ...BASE_SETUP }),
        companyProfile: withoutField({ ...BASE_PROFILE }, 'skontoDays'),
      } as Partial<AppPersistedState>),
    );

    resetSyncOutboxForTests();
    persistAll();

    expect(companyEntries(), 'Echo im Bootstrap-Pfad').toEqual([]);
    expect(hasPendingCompanyCloudBackup()).toBe(false);
  });

  it('D: Persistenzfehler stellt Stores, Baseline und Banner auf previous zurück', () => {
    establishLocalBaseline();
    const before = buildPersistedStateSnapshot();

    const saveSpy = vi.spyOn(persistenceService, 'savePersistedState').mockReturnValue(false);
    const applied = applySyncPullCandidateSafely({
      state: buildState({
        setup: { ...BASE_SETUP, companyName: 'Fremdbetrieb GmbH' },
      } as Partial<AppPersistedState>),
      report: emptyReport(),
    });
    saveSpy.mockRestore();

    expect(applied.persisted).toBe(false);
    // Der abgelehnte Kandidat hinterlässt keine Spur.
    expect(buildPersistedStateSnapshot().setup.companyName).toBe(before.setup.companyName);

    resetSyncOutboxForTests();
    persistAll();

    expect(companyEntries(), 'Baseline des verworfenen Kandidaten wirkt nach').toEqual([]);
    expect(hasPendingCompanyCloudBackup()).toBe(false);
  });

  it('E: eine echte lokale Firmenänderung erzeugt danach genau einen Eintrag', () => {
    establishLocalBaseline();
    expect(
      applySyncPullCandidateSafely({
        state: buildState({ setup: reversedKeys({ ...BASE_SETUP }) } as Partial<AppPersistedState>),
        report: emptyReport(),
      }).persisted,
    ).toBe(true);

    resetSyncOutboxForTests();
    persistAll();
    expect(companyEntries()).toEqual([]);

    // Echte Nutzeränderung an einem Firmenfeld.
    persistenceService.setCachedSetup({ ...BASE_SETUP, industry: 'Elektro' });
    persistAll();

    const created = companyEntries();
    expect(created).toHaveLength(1);
    expect(created[0]?.entityType).toBe('company_setup');
    expect(created[0]?.operation).toBe('update');
    expect(created[0]?.status).toBe('pending');
    expect(hasPendingCompanyCloudBackup()).toBe(true);
  });

  /*
   * 01C — Bootstrap-Persistenzfehler. `applyPersistedStateFromSync` rollt
   * bewusst NICHT zurück: die Stores tragen danach weiterhin den angewendeten
   * Remote-Kandidaten. Genau deshalb muss die Tracker-Baseline auch im
   * Fehlerfall dem Store-Zustand folgen — sonst bleibt sie roh, während der
   * nächste `persistAll()` gegen den normalisierten Snapshot vergleicht.
   */
  it('G: Bootstrap-Persistenzfehler erzeugt kein Tracker-Echo', () => {
    establishLocalBaseline();

    const remote = buildState({
      setup: reversedKeys({ ...BASE_SETUP }),
      companyProfile: withoutField({ ...BASE_PROFILE }, 'skontoDays'),
    } as Partial<AppPersistedState>);

    /**
     * `applyPersistedStateFromSync` ruft `savePersistedState` modulintern auf —
     * ein Spy auf dem Export griffe dort nicht. Der Fehlschlag wird deshalb am
     * Speicher selbst erzwungen, wie bei einem Quota-Fehler auf iOS.
     */
    const writeSpy = failNextStorageWrites();
    applyPersistedStateFromSync(remote);
    writeSpy.mockRestore();

    // Bestehender Bootstrap-Vertrag: der Kandidat bleibt angewendet, es wird
    // nicht zurückgerollt. Das ist hier ausdrücklich die Erwartung.
    expect(buildPersistedStateSnapshot().setup.companyName).toBe(COMPANY);
    expect(buildPersistedStateSnapshot().companyProfile?.street).toBe('Hafenweg 3');

    resetSyncOutboxForTests();
    persistAll();

    expect(companyEntries(), 'Echo nach Bootstrap-Persistenzfehler').toEqual([]);
    expect(hasPendingCompanyCloudBackup()).toBe(false);
  });

  it('H: nach einem Bootstrap-Persistenzfehler wirkt eine echte Änderung weiter', () => {
    establishLocalBaseline();

    const writeSpy = failNextStorageWrites();
    applyPersistedStateFromSync(
      buildState({ setup: reversedKeys({ ...BASE_SETUP }) } as Partial<AppPersistedState>),
    );
    writeSpy.mockRestore();

    resetSyncOutboxForTests();
    persistAll();
    expect(companyEntries()).toEqual([]);

    persistenceService.setCachedSetup({ ...BASE_SETUP, industry: 'Elektro' });
    persistAll();

    const created = companyEntries();
    expect(created).toHaveLength(1);
    expect(created[0]?.entityType).toBe('company_setup');
    expect(created[0]?.operation).toBe('update');
    expect(created[0]?.status).toBe('pending');
  });

  it('F: ein weiterer persistAll ohne Änderung erzeugt keinen zweiten Eintrag', () => {
    establishLocalBaseline();
    expect(
      applySyncPullCandidateSafely({
        state: buildState({ setup: reversedKeys({ ...BASE_SETUP }) } as Partial<AppPersistedState>),
        report: emptyReport(),
      }).persisted,
    ).toBe(true);

    resetSyncOutboxForTests();
    persistAll();
    persistenceService.setCachedSetup({ ...BASE_SETUP, industry: 'Elektro' });
    persistAll();
    const afterChange = companyEntries().length;

    persistAll();
    persistAll();

    expect(companyEntries()).toHaveLength(afterChange);
  });
});
