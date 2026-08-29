/**
 * TOMBSTONE-VERSION-CONTRACT-02 — Löschen ist eine Fachänderung wie jede andere.
 *
 * Seit SYNC-VERSION-CONTRACT-02 ist `Vorgang.sync.version` ausschliesslich die
 * zuletzt vom **Server** bestätigte `row_version`. Der Löschpfad hielt sich als
 * einziger nicht daran: `withTombstonedEntity` erhöhte die Version, und bei
 * fehlender Meta erfand `createDefaultSyncMeta` zusätzlich den Startwert 1.
 *
 * Folgen vor dem Fix:
 *  - synchronisierter Vorgang v5 → lokal 6 → Push erwartet 6 gegen Server 5 →
 *    Versionskonflikt. Löschen war über die Cloud gar nicht möglich.
 *  - nie bestätigter Vorgang → lokal 2 statt 0 → die Lost-Ack-Wiederherstellung
 *    aus CREATE-RETRY-CONFLICT-02 konnte nicht greifen.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Vorgang } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import { deleteVorgang, getVorgangStoreSnapshot, hydrateVorgangStore } from '../vorgangService';
import { applyStateToStores, buildPersistedStateSnapshot } from '../persistenceService';
import { createSyncClient, hydrateSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import {
  getSyncOutboxSnapshot,
  resetSyncOutboxForTests,
} from '../sync/syncOutboxService';
import {
  resetSyncChangeTrackerForTests,
  trackPersistedChanges,
} from '../sync/syncChangeTrackerService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { generateUuid } from '../sync/syncMetaService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { stripVorgangForCloud, type WorkspaceVorgangRow } from './vorgangCloudService';
import { resetTestStores } from '../../test/resetStores';

const WORKSPACE = 'ws-tombstone-02';
const UPDATED_AT = '2026-08-30T10:00:00.000Z';

function baseVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-tombstone-02',
    title: 'Beispielauftrag',
    customer: 'Beispiel Industriebau GmbH',
    baustelle: 'Beispielstraße 5',
    status: 'eingegangen',
    materialSource: 'unclear',
    orderPositions: [],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    ...overrides,
  } as Vorgang;
}

function syncedVorgang(version: number): Vorgang {
  return baseVorgang({
    sync: {
      updatedAt: UPDATED_AT,
      version,
      deleted: false,
      deviceId: 'dev-alt',
      workspaceId: WORKSPACE,
    },
  });
}

function buildState(vorgaenge: Vorgang[], outbox: SyncOutboxEntry[] = []): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: outbox,
    setup: DEFAULT_SETUP,
    vorgaenge,
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: UPDATED_AT,
  } as AppPersistedState;
}

function remoteRow(source: Vorgang, rowVersion: number, deleted = false): WorkspaceVorgangRow {
  return {
    workspace_id: WORKSPACE,
    vorgang_id: source.id,
    payload: stripVorgangForCloud(source) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
    updated_by: 'dev-a',
  };
}

function outboxEntry(entityId: string, status: SyncOutboxEntry['status']): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType: 'vorgang',
    entityId,
    operation: 'delete',
    version: 0,
    queuedAt: UPDATED_AT,
    retryCount: 1,
    status,
  } as SyncOutboxEntry;
}

function deletedFromStore(id: string): Vorgang | undefined {
  return getVorgangStoreSnapshot().find((v) => v.id === id);
}

describe('TOMBSTONE-VERSION-CONTRACT-02', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
    hydrateSyncClient({ ...createSyncClient(), workspaceId: WORKSPACE });
  });

  it('T1 — bestätigte Version 5 überlebt das Löschen unverändert', () => {
    hydrateVorgangStore([syncedVorgang(5)]);
    const result = deleteVorgang('v-tombstone-02');
    expect(result.success).toBe(true);

    const tombstone = deletedFromStore('v-tombstone-02');
    expect(tombstone?.sync?.version).toBe(5);
    expect(tombstone?.sync?.deleted).toBe(true);
  });

  it('T2 — ohne bestätigte Serverversion bleibt die Erwartung 0', () => {
    hydrateVorgangStore([baseVorgang()]);
    expect(deleteVorgang('v-tombstone-02').success).toBe(true);

    const tombstone = deletedFromStore('v-tombstone-02');
    expect(tombstone?.sync?.version ?? 0).toBe(0);
    expect(tombstone?.sync?.deleted).toBe(true);
  });

  it('T3 — der Change-Tracker erzeugt weiterhin genau einen delete-Auftrag', () => {
    hydrateVorgangStore([syncedVorgang(5)]);
    // Basislinie auf den aktiven Stand setzen, sonst gilt der Vorgang als neu.
    trackPersistedChanges(buildState([syncedVorgang(5)]));
    resetSyncOutboxForTests([]);

    deleteVorgang('v-tombstone-02');
    trackPersistedChanges(buildState(getVorgangStoreSnapshot()));

    const entries = getSyncOutboxSnapshot().filter((e) => e.entityId === 'v-tombstone-02');
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe('delete');
  });

  it('T4 — der Push erwartet beim synchronisierten Löschen die Serverversion 5', () => {
    hydrateVorgangStore([syncedVorgang(5)]);
    deleteVorgang('v-tombstone-02');

    const extracted = extractCloudSyncEntity(
      buildState(getVorgangStoreSnapshot()),
      'vorgang',
      'v-tombstone-02',
    );
    expect(extracted?.rowVersion).toBe(5);
    expect(extracted?.deleted).toBe(true);
  });

  it('T5 — der Push erwartet beim nie bestätigten Löschen 0', () => {
    hydrateVorgangStore([baseVorgang()]);
    deleteVorgang('v-tombstone-02');

    const extracted = extractCloudSyncEntity(
      buildState(getVorgangStoreSnapshot()),
      'vorgang',
      'v-tombstone-02',
    );
    expect(extracted?.rowVersion).toBe(0);
    expect(extracted?.deleted).toBe(true);
  });

  it('T6/T7 — Lost-Ack-Löschung: Adoption greift, Folge-Push erwartet 1', () => {
    /*
     * Der vollständige Weg über die produktiven Pfade: löschen, blockiert
     * werden, ziehen, übernehmen, erneut senden.
     */
    hydrateVorgangStore([baseVorgang()]);
    deleteVorgang('v-tombstone-02');

    const entry = outboxEntry('v-tombstone-02', 'blocked');
    resetSyncOutboxForTests([entry]);
    const state = buildState(getVorgangStoreSnapshot(), [entry]);

    const merged = mergeRemoteWorkspacePullIntoState(state, {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [remoteRow(baseVorgang(), 1)],
      customers: [],
    } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);

    expect(merged.conflicts).toEqual([]);
    const adopted = merged.state.vorgaenge.find((v) => v.id === 'v-tombstone-02');
    // T6: Basisversion übernommen, Löschwunsch unangetastet.
    expect({ version: adopted?.sync?.version, deleted: adopted?.sync?.deleted }).toEqual({
      version: 1,
      deleted: true,
    });
    // T6: derselbe Eintrag ist wieder sendbar.
    const after = getSyncOutboxSnapshot().filter((e) => e.entityId === 'v-tombstone-02');
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pending');
    expect(after[0].operation).toBe('delete');

    // T7: der nächste Push sendet die adoptierte Erwartung.
    const extracted = extractCloudSyncEntity(merged.state, 'vorgang', 'v-tombstone-02');
    expect(extracted?.rowVersion).toBe(1);
    expect(extracted?.deleted).toBe(true);
  });

  it('T8 — Remote-Grabstein v1 gegen echten lokalen Löschzustand wird abgeschlossen', () => {
    hydrateVorgangStore([baseVorgang()]);
    deleteVorgang('v-tombstone-02');

    const entry = outboxEntry('v-tombstone-02', 'blocked');
    resetSyncOutboxForTests([entry]);
    const state = buildState(getVorgangStoreSnapshot(), [entry]);

    mergeRemoteWorkspacePullIntoState(state, {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [remoteRow(baseVorgang(), 1, true)],
      customers: [],
    } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);

    expect(getSyncOutboxSnapshot().find((e) => e.id === entry.id)?.status).toBe('completed');
  });

  it('T9 — Remote-Grabstein v1 gegen lokal aktiven Vorgang belebt nichts wieder', () => {
    const local = baseVorgang();
    const entry = outboxEntry(local.id, 'blocked');
    resetSyncOutboxForTests([entry]);
    const state = buildState([local], [entry]);

    const merged = mergeRemoteWorkspacePullIntoState(state, {
      workspace: null,
      members: [],
      settings: null,
      setupPayload: null,
      setupRowVersion: 0,
      setupUpdatedAt: null,
      companyProfilePayload: null,
      companyProfileRowVersion: 0,
      companyProfileUpdatedAt: null,
      vorgaenge: [remoteRow(local, 1, true)],
      customers: [],
    } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);

    // Keine Adoption: Die Version bleibt unbestätigt.
    const after = merged.state.vorgaenge.find((v) => v.id === local.id);
    expect(after?.sync?.version ?? 0).toBe(0);
    // Und der Eintrag wird nicht stillschweigend wieder aktiviert.
    expect(getSyncOutboxSnapshot()[0].status).toBe('blocked');
  });

  it('T10 — Löschwunsch, bekannte Version und Auftrag überleben den Neustart', () => {
    hydrateVorgangStore([syncedVorgang(5)]);
    trackPersistedChanges(buildState([syncedVorgang(5)]));
    resetSyncOutboxForTests([]);

    deleteVorgang('v-tombstone-02');
    const snapshot = buildPersistedStateSnapshot();

    // Neustart simulieren: Stores leeren, Zustand erneut anwenden.
    resetTestStores();
    resetSyncOutboxForTests([]);
    applyStateToStores(snapshot);

    const restored = deletedFromStore('v-tombstone-02');
    expect({ deleted: restored?.sync?.deleted, version: restored?.sync?.version }).toEqual({
      deleted: true,
      version: 5,
    });
    expect(
      getSyncOutboxSnapshot().some(
        (e) => e.entityId === 'v-tombstone-02' && e.operation === 'delete',
      ),
    ).toBe(true);
  });

  it('T11 — das Löschen bleibt fachlich unverändert: aktiv weg, Grabstein da', () => {
    hydrateVorgangStore([syncedVorgang(5)]);
    const result = deleteVorgang('v-tombstone-02');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unerwartet');
    expect(result.vorgang.sync?.deleted).toBe(true);
    expect(result.vorgang.sync?.deletedAt).toBeTruthy();
    // Ein zweites Löschen findet keinen aktiven Vorgang mehr.
    expect(deleteVorgang('v-tombstone-02')).toEqual({
      success: false,
      errorKey: 'vorgang.notFound',
    });
  });
});
