/**
 * COMPANY-PROFILE-SYNC-LOSS-01B — der Pull darf eine noch nicht gesendete
 * Firmenänderung nicht überschreiben.
 *
 * Der Schutz existierte bereits für Vorgang und Kunde (`activeOutboxEntityIds`),
 * fehlte aber für `company_profile` und `company_setup`. Dadurch konnte eine
 * lokale Änderung still verschwinden: Der Versionsvergleich allein entschied für
 * den Remote-Stand, es gab keinen Konflikt und keine Meldung.
 *
 * Reine Merge-Tests ohne Netzwerk, ohne UI, neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createSyncClient } from '../sync/syncClientService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxStatus } from '../../types/sync';

const WORKSPACE_ID = 'preserve-guard-ws';
const LOCAL_COMPANY = 'Beispiel Lokalbetrieb GmbH';
const CLOUD_COMPANY = 'Beispiel Cloudbetrieb GmbH';

/** Der lokal geänderte, noch nicht gesendete Wert. */
const LOCAL_DIRECTOR = 'Lokale Änderung';
const LOCAL_INDUSTRY = 'Lokale Branche';

function outboxEntry(
  entityType: 'company_profile' | 'company_setup',
  status: SyncOutboxStatus,
): SyncOutboxEntry {
  return {
    id: `outbox-${entityType}-${status}`,
    entityType,
    entityId: WORKSPACE_ID,
    operation: 'update',
    version: 4,
    queuedAt: '2026-08-31T10:00:00.000Z',
    retryCount: 0,
    status,
  };
}

function buildLocalState(outbox: SyncOutboxEntry[]): AppPersistedState {
  return {
    version: 5,
    setup: {
      ...DEFAULT_SETUP,
      companyName: LOCAL_COMPANY,
      industry: LOCAL_INDUSTRY,
      setupComplete: true,
      setupVersion: 1,
    },
    companyProfile: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: LOCAL_COMPANY,
      managingDirector: LOCAL_DIRECTOR,
    },
    setupSync: {
      version: 4,
      updatedAt: '2026-08-31T10:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    companyProfileSync: {
      version: 4,
      updatedAt: '2026-08-31T10:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    customers: [],
    syncOutbox: outbox,
    savedAt: '2026-08-31T10:00:00.000Z',
  } as unknown as AppPersistedState;
}

/**
 * Der Remote-Stand trägt dieselbe Version wie der lokale — genau die Lage aus
 * dem Realtest. `rowVersion >= localVersion` war damit erfüllt, und der Pull
 * übernahm den Cloud-Stand, obwohl lokal eine ungesendete Änderung lag.
 */
function buildPull() {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: {
      ...DEFAULT_SETUP,
      companyName: CLOUD_COMPANY,
      industry: 'Cloud-Branche',
      setupComplete: true,
      setupVersion: 1,
    } as unknown as Record<string, unknown>,
    setupRowVersion: 4,
    setupUpdatedAt: '2026-08-31T09:00:00.000Z',
    companyProfilePayload: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: CLOUD_COMPANY,
      managingDirector: '',
    } as unknown as Record<string, unknown>,
    companyProfileRowVersion: 4,
    companyProfileUpdatedAt: '2026-08-31T09:00:00.000Z',
    vorgaenge: [],
    customers: [],
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

describe('COMPANY-PROFILE-SYNC-LOSS-01B — Preserve-Schutz für Firmen-Entitäten', () => {
  beforeEach(() => {
    resetTestStores();
    resetSyncOutboxForTests();
  });

  // TEST 1
  it('bewahrt das lokale CompanyProfile bei aktivem Auftrag', () => {
    const state = buildLocalState([outboxEntry('company_profile', 'pending')]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

    expect(merged.companyProfile?.managingDirector).toBe(LOCAL_DIRECTOR);
    expect(merged.companyProfile?.companyName).toBe(LOCAL_COMPANY);
  });

  // TEST 2
  it('übernimmt das Remote-Profil ohne aktiven Auftrag wie bisher', () => {
    const state = buildLocalState([]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

    expect(merged.companyProfile?.companyName).toBe(CLOUD_COMPANY);
    expect(merged.companyProfile?.managingDirector).toBe('');
    expect(merged.companyProfileSync?.version).toBe(4);
  });

  // TEST 3
  it('bewahrt das lokale CompanySetup bei aktivem Auftrag', () => {
    const state = buildLocalState([outboxEntry('company_setup', 'pending')]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

    expect(merged.setup.industry).toBe(LOCAL_INDUSTRY);
    expect(merged.setup.companyName).toBe(LOCAL_COMPANY);
  });

  // TEST 4
  it('übernimmt das Remote-Setup ohne aktiven Auftrag wie bisher', () => {
    const state = buildLocalState([]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

    expect(merged.setup.companyName).toBe(CLOUD_COMPANY);
    expect(merged.setup.industry).toBe('Cloud-Branche');
  });

  /*
   * Der Schutz gilt für alle aktiven Status. `blocked` ist der wichtigste Fall:
   * Ein Push, der an einem Versionskonflikt scheiterte, hinterlässt genau diesen
   * Status — und dann liegt lokal ein neuerer Stand, der nicht verschwinden darf.
   */
  it.each<SyncOutboxStatus>(['pending', 'error', 'blocked'])(
    'schützt auch bei Auftragsstatus %s',
    (status) => {
      const state = buildLocalState([
        outboxEntry('company_profile', status),
        outboxEntry('company_setup', status),
      ]);
      const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

      expect(merged.companyProfile?.managingDirector).toBe(LOCAL_DIRECTOR);
      expect(merged.setup.industry).toBe(LOCAL_INDUSTRY);
    },
  );

  /* Ein abgeschlossener Auftrag ist kein Grund mehr, etwas zu bewahren. */
  it.each<SyncOutboxStatus>(['completed', 'failed'])(
    'bewahrt bei Auftragsstatus %s nicht mehr',
    (status) => {
      const state = buildLocalState([
        outboxEntry('company_profile', status),
        outboxEntry('company_setup', status),
      ]);
      const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

      expect(merged.companyProfile?.companyName).toBe(CLOUD_COMPANY);
      expect(merged.setup.companyName).toBe(CLOUD_COMPANY);
    },
  );

  /* Die beiden Entitäten werden unabhängig voneinander geschützt. */
  it('schützt nur die Entität mit aktivem Auftrag', () => {
    const state = buildLocalState([outboxEntry('company_profile', 'pending')]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

    expect(merged.companyProfile?.managingDirector).toBe(LOCAL_DIRECTOR);
    expect(merged.setup.companyName).toBe(CLOUD_COMPANY);
  });

  /* Ein Auftrag eines fremden Workspace darf nichts bewahren. */
  it('ignoriert Aufträge eines anderen Workspace', () => {
    const foreign = { ...outboxEntry('company_profile', 'pending'), entityId: 'anderer-workspace' };
    const state = buildLocalState([foreign]);
    const { state: merged } = mergeRemoteWorkspacePullIntoState(state, buildPull());

    expect(merged.companyProfile?.companyName).toBe(CLOUD_COMPANY);
  });
});
