/**
 * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01 — auf dem echten Gerät hing ein
 * Firmen-Outbox-Eintrag dauerhaft auf `blocked`: der Pull meldete eine
 * Versionsdrift, übernahm deshalb weder Payload noch Version, und der Push
 * scheiterte am selben veralteten Stand. Der rote Cloud-Sicherungsbanner blieb
 * ohne jeden Ausweg stehen.
 *
 * Sind lokaler und Remote-Payload fachlich identisch, gibt es keinen
 * Datenkonflikt — nur eine Versionshistorie. Genau dieser Fall wird hier
 * geschlossen. Alles andere bleibt unverändert Konflikt.
 *
 * Reine Merge-Tests ohne Netzwerk, ohne UI, mit neutralen Beispieldaten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import * as workspaceCloudService from './workspaceCloudService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createSyncClient } from '../sync/syncClientService';
import {
  getSyncOutboxSnapshot,
  hasPendingCompanyCloudBackup,
  resetSyncOutboxForTests,
} from '../sync/syncOutboxService';
import { applyStateToStores } from '../persistenceService';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxStatus } from '../../types/sync';

const WORKSPACE_ID = 'identical-state-ws';
const COMPANY = 'Beispiel Identisch GmbH';

const LOCAL_SETUP = {
  ...DEFAULT_SETUP,
  companyName: COMPANY,
  industry: 'Sanitär',
  taxStatus: 'standard_19',
  setupComplete: true,
  setupVersion: 1,
};

const LOCAL_PROFILE = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: COMPANY,
  street: 'Musterweg 5',
  iban: 'DE89370400440532013000',
};

function buildLocalState(options: {
  setupSyncVersion?: number;
  profileSyncVersion?: number;
  setupOverride?: Record<string, unknown>;
  profileOverride?: Record<string, unknown>;
}): AppPersistedState {
  return {
    version: 5,
    setup: { ...LOCAL_SETUP, ...(options.setupOverride ?? {}) },
    companyProfile: { ...LOCAL_PROFILE, ...(options.profileOverride ?? {}) },
    syncClient: { ...createSyncClient(), serverWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    setupSync: {
      version: options.setupSyncVersion ?? 3,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    },
    companyProfileSync: {
      version: options.profileSyncVersion ?? 4,
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
    // Wie im echten Lauf: der Kandidat startet mit dem aktuellen Outbox-Stand.
    syncOutbox: getSyncOutboxSnapshot(),
    savedAt: '2026-08-15T13:11:18.373Z',
  } as unknown as AppPersistedState;
}

/** Remote trägt bewusst eine andere Zeilenversion als lokal. */
function buildPull(options: {
  setupPayload?: Record<string, unknown> | null;
  profilePayload?: Record<string, unknown> | null;
  setupRowVersion?: number;
  profileRowVersion?: number;
}) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload:
      options.setupPayload === undefined
        ? ({ ...LOCAL_SETUP } as unknown as Record<string, unknown>)
        : options.setupPayload,
    setupRowVersion: options.setupRowVersion ?? 9,
    setupUpdatedAt: '2026-08-20T08:00:00.000Z',
    companyProfilePayload:
      options.profilePayload === undefined
        ? ({ ...LOCAL_PROFILE } as unknown as Record<string, unknown>)
        : options.profilePayload,
    companyProfileRowVersion: options.profileRowVersion ?? 11,
    companyProfileUpdatedAt: '2026-08-20T08:00:00.000Z',
    vorgaenge: [],
  };
}

function seedOutbox(
  entries: Array<{ entityType: SyncOutboxEntry['entityType']; status: SyncOutboxStatus }>,
): void {
  resetSyncOutboxForTests(
    entries.map((entry, index) => ({
      id: `outbox-${index}`,
      entityType: entry.entityType,
      entityId: WORKSPACE_ID,
      operation: 'update' as const,
      version: 3,
      queuedAt: '2026-08-15T13:05:00.000Z',
      retryCount: 1,
      status: entry.status,
      blockedReason: undefined,
    })),
  );
}

const entryFor = (entityType: string): SyncOutboxEntry | undefined =>
  getSyncOutboxSnapshot().find((entry) => entry.entityType === entityType);

/** 01C — der Abschluss steht zuerst im Kandidaten, nicht im globalen Zustand. */
const candidateEntryFor = (
  state: AppPersistedState,
  entityType: string,
): SyncOutboxEntry | undefined =>
  (state.syncOutbox ?? []).find((entry) => entry.entityType === entityType);

describe('REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests();
  });

  it('I1: identisches company_setup schließt den blockierten Eintrag ab', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const state = buildLocalState({ setupSyncVersion: 3 });

    const merged = mergeRemoteWorkspacePullIntoState(state, buildPull({ profilePayload: null }));

    // Kein fachlicher Konflikt mehr für diese Entität.
    expect(merged.conflicts).not.toContain('company_setup');
    // Die lokalen Firmendaten bleiben unangetastet.
    expect(merged.state.setup).toEqual(state.setup);
    // Die Serverversion wird übernommen — die Drift ist geschlossen.
    expect(merged.state.setupSync?.version).toBe(9);
    // 01C — der Abschluss reist im Kandidaten und wirkt erst nach dem Apply.
    expect(candidateEntryFor(merged.state, 'company_setup')?.status).toBe('completed');
    applyStateToStores(merged.state);
    expect(entryFor('company_setup')?.status).toBe('completed');
  });

  it('I2: identisches company_profile schließt den blockierten Eintrag ab', () => {
    seedOutbox([{ entityType: 'company_profile', status: 'blocked' }]);
    const state = buildLocalState({ profileSyncVersion: 4 });

    const merged = mergeRemoteWorkspacePullIntoState(state, buildPull({ setupPayload: null }));

    expect(merged.conflicts).not.toContain('company_profile');
    expect(merged.state.companyProfile).toEqual(state.companyProfile);
    expect(merged.state.companyProfileSync?.version).toBe(11);
    expect(candidateEntryFor(merged.state, 'company_profile')?.status).toBe('completed');
    applyStateToStores(merged.state);
    expect(entryFor('company_profile')?.status).toBe('completed');
  });

  it('I3: der Banner erlischt, wenn kein aktiver Firmeneintrag mehr übrig ist', () => {
    seedOutbox([
      { entityType: 'company_setup', status: 'blocked' },
      { entityType: 'company_profile', status: 'blocked' },
    ]);
    expect(hasPendingCompanyCloudBackup()).toBe(true);

    const merged = mergeRemoteWorkspacePullIntoState(buildLocalState({}), buildPull({}));
    applyStateToStores(merged.state);

    expect(hasPendingCompanyCloudBackup()).toBe(false);
  });

  it('I4: echte unterschiedliche Firmendaten bleiben ein Konflikt', () => {
    seedOutbox([
      { entityType: 'company_setup', status: 'blocked' },
      { entityType: 'company_profile', status: 'blocked' },
    ]);
    const state = buildLocalState({});
    const merged = mergeRemoteWorkspacePullIntoState(
      state,
      buildPull({
        setupPayload: { ...LOCAL_SETUP, companyName: 'Beispiel Fremdbetrieb GmbH' },
        profilePayload: { ...LOCAL_PROFILE, street: 'Cloudweg 1' },
      }),
    );

    expect(merged.conflicts).toContain('company_setup');
    expect(merged.conflicts).toContain('company_profile');
    // Nichts übernommen, nichts überschrieben.
    expect(merged.state.setup).toEqual(state.setup);
    expect(merged.state.companyProfile).toEqual(state.companyProfile);
    expect(merged.state.setupSync?.version).toBe(3);
    expect(merged.state.companyProfileSync?.version).toBe(4);
    // Outbox unverändert, Banner bleibt aktiv.
    expect(entryFor('company_setup')?.status).toBe('blocked');
    expect(entryFor('company_profile')?.status).toBe('blocked');
    expect(hasPendingCompanyCloudBackup()).toBe(true);
  });

  it('I5: gemischter Fall — nur die identische Entität wird abgeschlossen', () => {
    seedOutbox([
      { entityType: 'company_setup', status: 'blocked' },
      { entityType: 'company_profile', status: 'blocked' },
    ]);
    const state = buildLocalState({});
    const merged = mergeRemoteWorkspacePullIntoState(
      state,
      buildPull({ profilePayload: { ...LOCAL_PROFILE, street: 'Cloudweg 1' } }),
    );

    expect(merged.conflicts).not.toContain('company_setup');
    expect(merged.conflicts).toContain('company_profile');
    applyStateToStores(merged.state);
    expect(entryFor('company_setup')?.status).toBe('completed');
    expect(entryFor('company_profile')?.status).toBe('blocked');
    // Genau deshalb bleibt der Banner stehen: es gibt noch echte ungesicherte Daten.
    expect(hasPendingCompanyCloudBackup()).toBe(true);
  });

  it('I6: der Identical-State-Abschluss ruft keinen Upsert-RPC auf', () => {
    seedOutbox([
      { entityType: 'company_setup', status: 'blocked' },
      { entityType: 'company_profile', status: 'blocked' },
    ]);
    const upsertSpy = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity');

    mergeRemoteWorkspacePullIntoState(buildLocalState({}), buildPull({}));

    expect(upsertSpy).not.toHaveBeenCalled();
    upsertSpy.mockRestore();
  });

  it('I7: Race-Guard — ein bereits neu eingereihter Eintrag wird nicht abgeschlossen', () => {
    // `pending` heißt: seit dem gescheiterten Push kam eine neue lokale Änderung.
    seedOutbox([{ entityType: 'company_setup', status: 'pending' }]);
    const state = buildLocalState({});

    const merged = mergeRemoteWorkspacePullIntoState(state, buildPull({ profilePayload: null }));

    expect(entryFor('company_setup')?.status).toBe('pending');
    expect(merged.state.setup).toEqual(state.setup);
    // Ohne belastbaren Guard bleibt es beim bisherigen Verhalten.
    expect(merged.state.setupSync?.version).toBe(3);
    expect(merged.conflicts).toContain('company_setup');
  });

  it('I8: ohne Versionsdrift ändert sich nichts am bisherigen Verhalten', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const state = buildLocalState({ setupSyncVersion: 9 });

    const merged = mergeRemoteWorkspacePullIntoState(
      state,
      buildPull({ setupRowVersion: 9, profilePayload: null }),
    );

    // Gleiche Version: schon bisher kein Konflikt, Remote wird regulär übernommen.
    expect(merged.conflicts).not.toContain('company_setup');
    expect(merged.state.setupSync?.version).toBe(9);
  });

  /*
   * REAL-DEVICE-CLOUD-COMPANY-IDENTICAL-COMPLETE-01C — Atomicity.
   *
   * Der Abschluss darf nicht am Kandidaten vorbei in den Modulzustand
   * geschrieben werden: `applyStateToStores` hydriert die Outbox aus
   * `candidate.syncOutbox` und würde eine reine Modulmutation wieder auf
   * `blocked` zurücksetzen — während die neue Sync-Metaversion sehr wohl
   * persistiert wird. Danach ist die Versionsdrift weg und der Zweig wird nie
   * wieder betreten: der Eintrag hinge endgültig fest.
   */
  it('A1: der Abschluss reist im zurückgegebenen Kandidaten mit', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const merged = mergeRemoteWorkspacePullIntoState(
      buildLocalState({}),
      buildPull({ profilePayload: null }),
    );

    const candidateEntry = (merged.state.syncOutbox ?? []).find(
      (entry) => entry.entityType === 'company_setup',
    );
    expect(candidateEntry?.status, 'Kandidat trägt den Abschluss nicht').toBe('completed');
    // Version und Abschluss reisen im selben Objekt.
    expect(merged.state.setupSync?.version).toBe(9);
  });

  it('A2: vor dem Apply bleibt der Bannerzustand unverändert', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    expect(hasPendingCompanyCloudBackup()).toBe(true);

    const merged = mergeRemoteWorkspacePullIntoState(buildLocalState({}), buildPull({}));

    // Der reine Merge darf den globalen Zustand nicht anfassen.
    expect(hasPendingCompanyCloudBackup(), 'Banner zu früh erloschen').toBe(true);
    expect(entryFor('company_setup')?.status, 'Modulzustand zu früh geändert').toBe('blocked');
    // Der Kandidat trägt den Abschluss trotzdem schon.
    expect(
      (merged.state.syncOutbox ?? []).find((entry) => entry.entityType === 'company_setup')?.status,
    ).toBe('completed');
  });

  it('A3: erst das Apply der Persistenzgrenze übernimmt beide Änderungen', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const merged = mergeRemoteWorkspacePullIntoState(buildLocalState({}), buildPull({}));

    applyStateToStores(merged.state);

    expect(entryFor('company_setup')?.status).toBe('completed');
    expect(hasPendingCompanyCloudBackup()).toBe(false);
  });

  it('A4: ein Merge ohne Apply lässt den globalen Zustand vollständig unberührt', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const before = getSyncOutboxSnapshot();

    mergeRemoteWorkspacePullIntoState(buildLocalState({}), buildPull({}));

    // skipPersist oder Tab-Abbruch: nichts wurde global verändert.
    expect(getSyncOutboxSnapshot()).toEqual(before);
    expect(hasPendingCompanyCloudBackup()).toBe(true);
  });

  it('A5: nach einem Rollback auf den Vorzustand gilt wieder blocked und alte Version', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const previous = buildLocalState({});
    applyStateToStores(previous);
    const merged = mergeRemoteWorkspacePullIntoState(previous, buildPull({}));

    // Persistenzfehler: die bestehende Infrastruktur stellt den Vorzustand her.
    applyStateToStores(previous);

    expect(entryFor('company_setup')?.status).toBe('blocked');
    expect(hasPendingCompanyCloudBackup()).toBe(true);
    // Und der Fall bleibt beim nächsten Lauf erneut erkennbar.
    const again = mergeRemoteWorkspacePullIntoState(previous, buildPull({}));
    expect(
      (again.state.syncOutbox ?? []).find((entry) => entry.entityType === 'company_setup')?.status,
    ).toBe('completed');
    expect(merged.state.setupSync?.version).toBe(9);
  });

  it('I9: ein lokaler Defaultzustand wird nicht als identische echte Firma behandelt', () => {
    seedOutbox([{ entityType: 'company_setup', status: 'blocked' }]);
    const state = buildLocalState({});
    state.setup = { ...DEFAULT_SETUP };
    (state as { setupSync?: unknown }).setupSync = {
      version: 3,
      updatedAt: '2026-08-15T13:00:00.000Z',
      deleted: false,
      deviceId: 'device-local',
      workspaceId: WORKSPACE_ID,
    };

    const merged = mergeRemoteWorkspacePullIntoState(
      state,
      buildPull({ setupPayload: { ...DEFAULT_SETUP }, profilePayload: null }),
    );

    // Der Defaultzweig übernimmt Remote wie bisher — kein Identical-State-Abschluss.
    expect(merged.conflicts).not.toContain('company_setup');
    expect(entryFor('company_setup')?.status).toBe('blocked');
  });
});
