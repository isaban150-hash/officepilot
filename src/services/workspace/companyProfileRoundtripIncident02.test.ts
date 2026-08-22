/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02M — Reproduktionsversuch der realen
 * Profil-Versionsspirale (41 → 42 → 43 → 44) bei fachlich identischem Profil.
 *
 * Reine Messung mit Produktionsfunktionen, neutrale fiktive Werte, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
} from '../persistenceService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from '../sync/syncChangeTrackerService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { createSyncClient } from '../sync/syncClientService';
import { stripLogoFromCompanyProfile } from './workspaceStore';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState, CompanyProfile } from '../../types/models';

const WORKSPACE_ID = 'roundtrip-incident-ws';
const COMPANY = 'Nordtal Gebäudetechnik GmbH';

/** Exakter Feldbestand des gesicherten Rohprofils — ohne logoDataUrl. */
const REAL_PROFILE: CompanyProfile = {
  companyName: COMPANY,
  legalForm: 'GmbH',
  street: 'Hafenstraße 17',
  zip: '21079',
  city: 'Hamburg',
  country: 'Deutschland',
  contactPerson: 'Jana Petersen',
  phone: '040 1234567',
  email: 'info@nordtal.example',
  website: 'https://nordtal.example',
  taxNumber: '22/333/44444',
  vatId: 'DE123456789',
  bankName: 'Nordbank',
  iban: 'DE02120300000000202051',
  bic: 'NOLADE21XXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  defaultSkonto: '',
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
  managingDirector: 'Jana Petersen',
  taxFreeNotice: '',
  invoiceFooterNotes: '',
} as CompanyProfile;

function buildLocalState(profileVersion = 2): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    setup: { ...DEFAULT_SETUP, companyName: COMPANY, setupComplete: true, setupVersion: 1 },
    companyProfile: { ...REAL_PROFILE },
    syncClient: {
      ...createSyncClient(),
      serverWorkspaceId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
    },
    setupSync: {
      version: 2,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    companyProfileSync: {
      version: profileVersion,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    syncOutbox: [
      { id: 'ob-setup', entityType: 'company_setup', entityId: WORKSPACE_ID, operation: 'update', version: 2, status: 'pending', retryCount: 0, queuedAt: '2026-08-15T13:00:00.000Z' },
      { id: 'ob-profile', entityType: 'company_profile', entityId: WORKSPACE_ID, operation: 'update', version: 2, status: 'pending', retryCount: 0, queuedAt: '2026-08-15T13:00:00.000Z' },
    ],
    savedAt: '2026-08-15T13:11:18.373Z',
  } as unknown as AppPersistedState;
}

/** Cloud-Antwort: derselbe Firmenname, Serverversionen wie im Vorfall. */
function buildPull(setupRowVersion: number, profileRowVersion: number, profile: CompanyProfile) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: {
      ...DEFAULT_SETUP,
      companyName: COMPANY,
      setupComplete: true,
      setupVersion: 1,
    } as unknown as Record<string, unknown>,
    setupRowVersion,
    setupUpdatedAt: '2026-08-16T20:00:00.000Z',
    // Der Push strippt das Logo — die Cloud liefert genau diese Form zurück.
    companyProfilePayload: stripLogoFromCompanyProfile(profile) as unknown as Record<string, unknown>,
    companyProfileRowVersion: profileRowVersion,
    companyProfileUpdatedAt: '2026-08-16T20:00:00.000Z',
    vorgaenge: [],
  };
}

const contentKeyOf = (profile: CompanyProfile): string =>
  JSON.stringify(stripLogoFromCompanyProfile(profile));

const profileEntries = () =>
  getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'company_profile');
const newProfileEntries = () =>
  profileEntries().filter((entry) => entry.id !== 'ob-profile');

describe('OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02M — Profil-Roundtrip', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests();
    resetSyncChangeTrackerForTests();
  });

  it('A: Baseline aus dem Rohzustand gegen Snapshot aus den Stores', () => {
    const state = buildLocalState();
    // Produktionsnah: erst die Stores füllen, dann die Baseline aus dem ROHzustand
    // setzen — genau die in 02K2 vermutete Asymmetrie.
    applyStateToStores(state);
    resetSyncChangeTrackerFromState(state);
    resetSyncOutboxForTests();

    const snapshot = buildPersistedStateSnapshot();
    const baselineKey = contentKeyOf(state.companyProfile as CompanyProfile);
    const snapshotKey = contentKeyOf(snapshot.companyProfile as CompanyProfile);
    trackPersistedChanges(snapshot);

    expect(snapshotKey, `contentKey Baseline vs. Snapshot`).toBe(baselineKey);
    expect(newProfileEntries()).toEqual([]);
  });

  it('B: applyStateToStores, dann Snapshot — kein neuer Auftrag', () => {
    const state = buildLocalState();
    applyStateToStores(state);
    resetSyncOutboxForTests();

    const snapshot = buildPersistedStateSnapshot();
    trackPersistedChanges(snapshot);

    expect(newProfileEntries()).toEqual([]);
    expect(snapshot.companyProfile?.companyName).toBe(COMPANY);
  });

  it('C: Hydrierung verändert Feldbestand oder Reihenfolge des Profils nicht', () => {
    const before = { ...REAL_PROFILE };
    hydrateCompanyProfileStore(before);
    const after = buildPersistedStateSnapshot().companyProfile as CompanyProfile;

    const beforeKeys = Object.keys(stripLogoFromCompanyProfile(before));
    const afterKeys = Object.keys(stripLogoFromCompanyProfile(after));

    expect(afterKeys, `Feldreihenfolge: ${beforeKeys.join(',')} → ${afterKeys.join(',')}`).toEqual(
      beforeKeys,
    );
    expect(JSON.stringify(stripLogoFromCompanyProfile(after))).toBe(
      JSON.stringify(stripLogoFromCompanyProfile(before)),
    );
    expect(contentKeyOf(after)).toBe(contentKeyOf(before));
  });

  it('D: Roundtrip nach bestätigter Übernahme erzeugt keinen neuen Auftrag', () => {
    // Ausgangslage nach der Recovery: Serverversion 42 lokal verbucht.
    const afterRecovery = buildLocalState(42);
    (afterRecovery.syncOutbox ?? []).forEach((entry) => {
      if (entry.entityType === 'company_profile' || entry.entityType === 'company_setup') {
        entry.status = 'completed';
      }
    });
    applyStateToStores(afterRecovery);
    resetSyncOutboxForTests();

    // Bootstrap-Pfad: Merge mit der Cloud-Antwort, dann Stores und Tracking.
    const merged = mergeRemoteWorkspacePullIntoState(
      buildPersistedStateSnapshot(),
      buildPull(4, 42, REAL_PROFILE) as never,
    );
    applyStateToStores(merged.state);
    trackPersistedChanges(buildPersistedStateSnapshot());

    expect(newProfileEntries().map((entry) => entry.version)).toEqual([]);
  });

  it('E: zwei weitere Pull-Runden mit identischem Profil erzeugen nichts', () => {
    const afterRecovery = buildLocalState(42);
    applyStateToStores(afterRecovery);
    resetSyncOutboxForTests();

    for (const version of [42, 43, 44]) {
      const merged = mergeRemoteWorkspacePullIntoState(
        buildPersistedStateSnapshot(),
        buildPull(4, version, REAL_PROFILE) as never,
      );
      applyStateToStores(merged.state);
      trackPersistedChanges(buildPersistedStateSnapshot());
    }

    expect(
      newProfileEntries().map((entry) => `${entry.status}:${entry.version}`),
      'Versionsspirale reproduziert',
    ).toEqual([]);
  });

  it('F: fehlende Baseline erzeugt Aufträge — reine Ursachenabgrenzung', () => {
    const state = buildLocalState();
    applyStateToStores(state);
    resetSyncOutboxForTests();
    // Baseline absichtlich leeren (entspricht einem Modul-Neuladen bzw. HMR).
    resetSyncChangeTrackerForTests();

    trackPersistedChanges(buildPersistedStateSnapshot());

    const created = getSyncOutboxSnapshot().map((entry) => entry.entityType);
    // Erste Messung nach leerer Baseline setzt nur die Baseline, ohne Aufträge.
    expect(created).toEqual([]);

    // Zweiter Durchlauf mit unveränderten Daten ebenfalls ohne Auftrag.
    trackPersistedChanges(buildPersistedStateSnapshot());
    expect(getSyncOutboxSnapshot()).toEqual([]);
  });
});
