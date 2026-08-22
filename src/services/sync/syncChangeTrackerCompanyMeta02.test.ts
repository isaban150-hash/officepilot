/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02D — eine reine Server-Metaänderung
 * (Version, Zeitstempel, Gerät, Workspace) darf für Firmendaten keinen neuen
 * Outbox-Auftrag erzeugen. Echte Inhaltsänderungen weiterhin schon.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './syncChangeTrackerService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { createSyncClient } from './syncClientService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';

const WORKSPACE_ID = 'tracker-meta-ws';
const COMPANY = 'Beispiel Trackerbetrieb GmbH';

function buildState(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  return {
    version: 5,
    setup: { ...DEFAULT_SETUP, companyName: COMPANY, setupComplete: true, setupVersion: 1 },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY },
    syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    setupSync: {
      version: 2,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-a',
      workspaceId: WORKSPACE_ID,
    },
    companyProfileSync: {
      version: 2,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-a',
      workspaceId: WORKSPACE_ID,
    },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    syncOutbox: [],
    savedAt: '2026-08-15T13:11:18.373Z',
    ...overrides,
  } as unknown as AppPersistedState;
}

const entriesFor = (entityType: string) =>
  getSyncOutboxSnapshot().filter((entry) => entry.entityType === entityType);

describe('OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02D — Change-Tracker für Firmendaten', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests();
    resetSyncChangeTrackerFromState(buildState());
  });

  it('T1: nur die Setup-Version geändert → kein Auftrag', () => {
    const next = buildState();
    next.setupSync = { ...next.setupSync!, version: 8 };
    trackPersistedChanges(next);
    expect(entriesFor('company_setup')).toEqual([]);
  });

  it('T2: nur updatedAt geändert → kein Auftrag', () => {
    const next = buildState();
    next.setupSync = { ...next.setupSync!, updatedAt: '2026-08-16T09:00:00.000Z' };
    trackPersistedChanges(next);
    expect(entriesFor('company_setup')).toEqual([]);
  });

  it('T3: Profil — nur Version und updatedAt geändert → kein Auftrag', () => {
    const next = buildState();
    next.companyProfileSync = {
      ...next.companyProfileSync!,
      version: 11,
      updatedAt: '2026-08-16T09:00:00.000Z',
      deviceId: 'device-b',
    };
    trackPersistedChanges(next);
    expect(entriesFor('company_profile')).toEqual([]);
  });

  it('T4: echter Setup-Inhalt geändert → genau ein Auftrag', () => {
    const next = buildState();
    next.setup = { ...next.setup, companyName: 'Beispiel Trackerbetrieb GmbH & Co KG' };
    trackPersistedChanges(next);
    expect(entriesFor('company_setup').length).toBe(1);
  });

  it('T5: echter Profil-Inhalt geändert → genau ein Auftrag', () => {
    const next = buildState();
    next.companyProfile = { ...next.companyProfile!, street: 'Neue Straße 7' };
    trackPersistedChanges(next);
    expect(entriesFor('company_profile').length).toBe(1);
  });

  it('T6: deleted geändert → genau ein Auftrag', () => {
    const next = buildState();
    next.setupSync = { ...next.setupSync!, deleted: true };
    trackPersistedChanges(next);
    expect(entriesFor('company_setup').length).toBe(1);
  });

  it('T7: wiederholtes Persistieren desselben Inhalts → kein weiterer Auftrag', () => {
    const next = buildState();
    next.setup = { ...next.setup, companyName: 'Beispiel Trackerbetrieb GmbH & Co KG' };
    trackPersistedChanges(next);
    expect(entriesFor('company_setup').length).toBe(1);

    const again = buildState({ setup: { ...next.setup } });
    again.setupSync = { ...again.setupSync!, version: 12, updatedAt: '2026-08-17T08:00:00.000Z' };
    trackPersistedChanges(again);
    expect(entriesFor('company_setup').length, 'zweiter Auftrag trotz gleichem Inhalt').toBe(1);
  });
});
