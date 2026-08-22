/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02D — eine leere Remote-Firmenidentität
 * darf einen echten lokalen Betrieb niemals ersetzen.
 *
 * Reine Merge-Tests ohne Netzwerk, ohne UI, mit neutralen Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createSyncClient } from '../sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';

const WORKSPACE_ID = 'merge-guard-ws';
const LOCAL_COMPANY = 'Beispiel Lokalbetrieb GmbH';
const OTHER_COMPANY = 'Beispiel Fremdbetrieb GmbH';

function buildLocalState(options: {
  setupSyncVersion?: number | null;
  profileSyncVersion?: number | null;
  defaultLocal?: boolean;
}): AppPersistedState {
  const real = options.defaultLocal !== true;
  const state = {
    version: 5,
    setup: real
      ? {
          ...DEFAULT_SETUP,
          companyName: LOCAL_COMPANY,
          industry: 'Sanitär',
          taxStatus: 'kleinunternehmer_19',
          setupComplete: true,
          setupVersion: 1,
        }
      : { ...DEFAULT_SETUP },
    companyProfile: real
      ? {
          ...DEFAULT_COMPANY_PROFILE,
          companyName: LOCAL_COMPANY,
          street: 'Musterweg 5',
          iban: 'DE89370400440532013000',
        }
      : { ...DEFAULT_COMPANY_PROFILE },
    syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    syncOutbox: [],
    savedAt: '2026-08-15T13:11:18.373Z',
  } as unknown as AppPersistedState;

  if (options.setupSyncVersion !== null && options.setupSyncVersion !== undefined) {
    state.setupSync = {
      version: options.setupSyncVersion,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    };
  }
  if (options.profileSyncVersion !== null && options.profileSyncVersion !== undefined) {
    state.companyProfileSync = {
      version: options.profileSyncVersion,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    };
  }
  return state;
}

function buildPull(options: {
  setupName?: string | null;
  profileName?: string | null;
  setupRowVersion?: number;
  profileRowVersion?: number;
}) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload:
      options.setupName === null
        ? null
        : ({
            ...DEFAULT_SETUP,
            companyName: options.setupName ?? '',
            industry: 'Cloud-Branche',
            taxStatus: 'standard_19',
            setupComplete: true,
            setupVersion: 1,
          } as unknown as Record<string, unknown>),
    setupRowVersion: options.setupRowVersion ?? 7,
    setupUpdatedAt: '2026-05-05T08:00:00.000Z',
    companyProfilePayload:
      options.profileName === null
        ? null
        : ({
            ...DEFAULT_COMPANY_PROFILE,
            companyName: options.profileName ?? '',
            street: 'Cloudweg 1',
          } as unknown as Record<string, unknown>),
    companyProfileRowVersion: options.profileRowVersion ?? 9,
    companyProfileUpdatedAt: '2026-05-05T08:00:00.000Z',
    vorgaenge: [],
  };
}

const pendingOf = (entityType: string) =>
  getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === entityType && entry.status === 'pending',
  );

describe('OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02D — leere Remote-Identität', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests();
  });

  const emptyNameCases: { label: string; setupSyncVersion: number | null; name: string }[] = [
    { label: 'lokale Sync-Version fehlt', setupSyncVersion: null, name: '' },
    { label: 'lokale Sync-Version 0', setupSyncVersion: 0, name: '' },
    { label: 'lokale Version kleiner als Remote', setupSyncVersion: 2, name: '' },
    { label: 'lokale Version gleich Remote', setupSyncVersion: 7, name: '' },
    { label: 'Remote-Name nur Leerzeichen', setupSyncVersion: 7, name: '   ' },
  ];

  for (const testCase of emptyNameCases) {
    it(`M-${testCase.label}: echter lokaler Bestand bleibt vollständig erhalten`, () => {
      const local = buildLocalState({
        setupSyncVersion: testCase.setupSyncVersion,
        profileSyncVersion: testCase.setupSyncVersion,
      });
      const merged = mergeRemoteWorkspacePullIntoState(
        local,
        buildPull({ setupName: testCase.name, profileName: testCase.name }) as never,
      );

      expect(merged.state.setup.companyName, 'Setup-Name verloren').toBe(LOCAL_COMPANY);
      expect(merged.state.companyProfile?.companyName, 'Profilname verloren').toBe(LOCAL_COMPANY);
      expect(merged.state.setup.setupComplete).toBe(true);
      expect(merged.state.setup.industry).toBe('Sanitär');
      expect(merged.state.setup.taxStatus).toBe('kleinunternehmer_19');
      expect(merged.state.companyProfile?.street).toBe('Musterweg 5');
      expect(merged.state.companyProfile?.iban).toBe('DE89370400440532013000');

      // Genau ein pending Auftrag je Firmenentität, keine Duplikate.
      expect(pendingOf('company_setup').length, 'company_setup nicht genau einmal').toBe(1);
      expect(pendingOf('company_profile').length, 'company_profile nicht genau einmal').toBe(1);
    });
  }

  it('M-unterschiedliche Versionen: Setup und Profil werden unabhängig geschützt', () => {
    const local = buildLocalState({ setupSyncVersion: 7, profileSyncVersion: 2 });
    const merged = mergeRemoteWorkspacePullIntoState(
      local,
      buildPull({ setupName: '', profileName: '', setupRowVersion: 7, profileRowVersion: 9 }) as never,
    );

    expect(merged.state.setup.companyName).toBe(LOCAL_COMPANY);
    expect(merged.state.companyProfile?.companyName).toBe(LOCAL_COMPANY);
    expect(pendingOf('company_setup').length).toBe(1);
  });

  it('M-Remote-Payload vollständig null: bisheriges Verhalten bleibt', () => {
    const local = buildLocalState({ setupSyncVersion: 2, profileSyncVersion: 2 });
    const merged = mergeRemoteWorkspacePullIntoState(
      local,
      buildPull({ setupName: null, profileName: null }) as never,
    );

    expect(merged.state.setup.companyName).toBe(LOCAL_COMPANY);
    expect(pendingOf('company_setup').length).toBe(1);
    expect(pendingOf('company_profile').length).toBe(1);
  });

  it('M-lokaler Defaultzustand: leere Cloud wird wie bisher übernommen', () => {
    const local = buildLocalState({ setupSyncVersion: null, defaultLocal: true });
    const merged = mergeRemoteWorkspacePullIntoState(
      local,
      buildPull({ setupName: '', profileName: '' }) as never,
    );

    // Kein echter lokaler Bestand: das bisherige Verhalten bleibt unverändert.
    expect(merged.state.setup.companyName).toBe('');
    expect(pendingOf('company_setup')).toEqual([]);
  });

  it('M-echter anderer Remote-Name bleibt ein Konflikt', () => {
    const local = buildLocalState({ setupSyncVersion: 2, profileSyncVersion: 2 });
    const merged = mergeRemoteWorkspacePullIntoState(
      local,
      buildPull({ setupName: OTHER_COMPANY, profileName: OTHER_COMPANY }) as never,
    );

    expect(merged.conflicts).toContain('company_setup');
    expect(merged.state.setup.companyName).toBe(LOCAL_COMPANY);
  });

  it('M-Sync-Meta trägt danach die vorhandene Serverversion', () => {
    const local = buildLocalState({ setupSyncVersion: 2, profileSyncVersion: 2 });
    const merged = mergeRemoteWorkspacePullIntoState(
      local,
      buildPull({ setupName: '', profileName: '', setupRowVersion: 7, profileRowVersion: 9 }) as never,
    );

    // Damit der reguläre Push die erwartete Serverversion sendet — kein p_row_version 0.
    expect(merged.state.setupSync?.version).toBe(7);
    expect(merged.state.companyProfileSync?.version).toBe(9);
    expect(merged.state.setup.companyName).toBe(LOCAL_COMPANY);
  });
});
