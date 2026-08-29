/**
 * CREATE-RETRY-CONFLICT-02 — Wiederanlauf nach verlorener Create-Bestätigung.
 *
 * Realfall: Der erste Push eines neuen Vorgangs/Kunden sendet `p_row_version = 0`.
 * Der Server fügt ein (`row_version = 1`), die Antwort erreicht den Client nicht.
 * Lokal bleibt `sync` leer und der Outbox-Eintrag aktiv.
 *
 * Mit dem verschärften Serververtrag („0 heisst: darf noch nicht existieren")
 * endet jeder Wiederholungsversuch in einem Versionskonflikt. Ohne die hier
 * geprüfte Wiederherstellung käme der Datensatz nie mehr in die Cloud.
 *
 * Der Sicherheitsbeweis steht im Serververtrag: Jeder Schreibvorgang erhöht
 * `row_version`, auch ein Grabstein. `row_version === 1` bedeutet daher, dass
 * seit dem Einfügen kein weiterer Server-Write erfolgte.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Customer, Vorgang } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxOperation, SyncOutboxStatus } from '../../types/sync';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { resetSyncChangeTrackerForTests } from './syncChangeTrackerService';
import { STORAGE_VERSION } from './syncMigrationService';
import { generateUuid } from './syncMetaService';
import {
  planVorgangLostAckAdoption,
  stripVorgangForCloud,
  type WorkspaceVorgangRow,
} from '../vorgang/vorgangCloudService';
import {
  buildCustomerCloudPushPayload,
  planCustomerLostAckAdoption,
  type WorkspaceCustomerRow,
} from '../customer/customerCloudService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';

const WORKSPACE = 'ws-1';
const UPDATED_AT = '2026-08-30T10:00:00.000Z';

function localVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-lost-ack',
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

function localCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'c-lost-ack',
    name: 'Beispiel Industriebau GmbH',
    street: 'Beispielstraße 5',
    zip: '20000',
    city: 'Beispielstadt',
    createdAt: UPDATED_AT,
    ...overrides,
  } as Customer;
}

/** Remote-Zeile aus dem produktiven Schreibpfad — kein handgebauter Payload. */
function vorgangRow(source: Vorgang, rowVersion: number, deleted = false): WorkspaceVorgangRow {
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

function customerRow(source: Customer, rowVersion: number, deleted = false): WorkspaceCustomerRow {
  return {
    workspace_id: WORKSPACE,
    customer_id: source.id,
    payload: buildCustomerCloudPushPayload(source, deleted) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
    updated_by: 'dev-a',
  };
}

function outboxEntry(
  entityType: 'vorgang' | 'customer',
  entityId: string,
  status: SyncOutboxStatus,
  operation: SyncOutboxOperation = 'create',
): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType,
    entityId,
    entityId2: undefined,
    operation,
    version: 0,
    queuedAt: UPDATED_AT,
    retryCount: 1,
    status,
  } as SyncOutboxEntry;
}

function buildState(input: {
  vorgaenge?: Vorgang[];
  customers?: Customer[];
  outbox?: SyncOutboxEntry[];
}): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: input.outbox ?? [],
    setup: DEFAULT_SETUP,
    vorgaenge: input.vorgaenge ?? [],
    customers: input.customers ?? [],
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: UPDATED_AT,
  } as AppPersistedState;
}

function emptyPull(overrides: Record<string, unknown> = {}) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    ...overrides,
  } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

describe('CREATE-RETRY-CONFLICT-02 Lost-Ack-Adoption', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests(createSyncClient());
  });

  it('C1 — Vorgang, Ack verloren, lokal unverändert: Basis 1 übernommen, kein Konflikt', () => {
    const local = localVorgang();
    const entry = outboxEntry('vorgang', local.id, 'blocked');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ vorgaenge: [local], outbox: [entry] });

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ vorgaenge: [vorgangRow(local, 1)] }),
    );

    expect(result.conflicts).toEqual([]);
    const merged = result.state.vorgaenge.find((v) => v.id === local.id);
    expect(merged?.sync?.version).toBe(1);
    expect(merged?.title).toBe('Beispielauftrag');
  });

  it('C2 — Ack verloren, danach lokale Bearbeitung: lokale Werte bleiben, Push erwartet 1', () => {
    /* Der Kernfall: Remote trägt den ursprünglichen Create, lokal wurde
     * weitergearbeitet. Beides muss überleben. */
    const remoteOrigin = localVorgang();
    const local = localVorgang({ title: 'Lokal weitergearbeitet', status: 'in_pruefung' });
    const entry = outboxEntry('vorgang', local.id, 'blocked', 'update');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ vorgaenge: [local], outbox: [entry] });

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ vorgaenge: [vorgangRow(remoteOrigin, 1)] }),
    );

    expect(result.conflicts).toEqual([]);
    const merged = result.state.vorgaenge.find((v) => v.id === local.id);
    expect({ title: merged?.title, status: merged?.status, version: merged?.sync?.version }).toEqual(
      { title: 'Lokal weitergearbeitet', status: 'in_pruefung', version: 1 },
    );

    // Der nächste Push sendet die adoptierte Basis, nicht mehr 0.
    const extracted = extractCloudSyncEntity(result.state, 'vorgang', local.id);
    expect(extracted?.rowVersion).toBe(1);
  });

  it('C3 — mehrere lokale Bearbeitungen: genau ein aktiver Eintrag, Version erst durch Adoption', () => {
    const local = localVorgang({ title: 'Dritte Fassung' });
    // Version bleibt bis zur Adoption 0, unabhängig von der Zahl der Änderungen.
    expect(local.sync?.version ?? 0).toBe(0);

    const entry = outboxEntry('vorgang', local.id, 'blocked', 'update');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ vorgaenge: [local], outbox: [entry] });

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ vorgaenge: [vorgangRow(localVorgang(), 1)] }),
    );

    expect(result.state.vorgaenge[0].sync?.version).toBe(1);
    expect(getSyncOutboxSnapshot().filter((e) => e.entityId === local.id)).toHaveLength(1);
  });

  it('C4 — Remote v2: keine Adoption, echter Konflikt, blocked bleibt blocked', () => {
    const local = localVorgang({ title: 'Lokal weitergearbeitet' });
    const entry = outboxEntry('vorgang', local.id, 'blocked', 'update');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ vorgaenge: [local], outbox: [entry] });

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ vorgaenge: [vorgangRow(localVorgang({ title: 'Fremd' }), 2)] }),
    );

    expect(result.conflicts).toContain(`vorgang:${local.id}`);
    // Kein Merge übernommen, lokaler Stand unangetastet, Version nicht adoptiert.
    expect(result.state.vorgaenge[0].title).toBe('Lokal weitergearbeitet');
    expect(result.state.vorgaenge[0].sync?.version ?? 0).toBe(0);
    expect(getSyncOutboxSnapshot()[0].status).toBe('blocked');
  });

  it('C5 — blocked wird wieder pending, ohne zweiten Eintrag', () => {
    const local = localVorgang();
    const entry = outboxEntry('vorgang', local.id, 'blocked');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ vorgaenge: [local], outbox: [entry] });

    mergeRemoteWorkspacePullIntoState(state, emptyPull({ vorgaenge: [vorgangRow(local, 1)] }));

    const after = getSyncOutboxSnapshot().filter((e) => e.entityId === local.id);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pending');
    expect(after[0].id).toBe(entry.id);
  });

  it('C6 — lokaler Löschwunsch gegen aktive Remote-Zeile v1: Adoption, Löschung bleibt bestehen', () => {
    const local = localVorgang({
      sync: {
        updatedAt: UPDATED_AT,
        version: 0,
        deleted: true,
        deletedAt: UPDATED_AT,
        deviceId: 'dev-a',
        workspaceId: WORKSPACE,
      },
    });
    const entry = outboxEntry('vorgang', local.id, 'blocked', 'delete');
    resetSyncOutboxForTests([entry]);

    const plan = planVorgangLostAckAdoption(
      [local],
      [vorgangRow(localVorgang(), 1)],
      new Set([local.id]),
    );

    expect(plan).toEqual({ adopt: [local.id], settle: [] });
  });

  it('C7 — Remote-Grabstein v1 bei lokalem Löschwunsch: erledigt, kein zweiter Grabstein', () => {
    const local = localVorgang({
      sync: {
        updatedAt: UPDATED_AT,
        version: 0,
        deleted: true,
        deletedAt: UPDATED_AT,
        deviceId: 'dev-a',
        workspaceId: WORKSPACE,
      },
    });
    const entry = outboxEntry('vorgang', local.id, 'blocked', 'delete');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ vorgaenge: [local], outbox: [entry] });

    const plan = planVorgangLostAckAdoption(
      [local],
      [vorgangRow(localVorgang(), 1, true)],
      new Set([local.id]),
    );
    expect(plan).toEqual({ adopt: [], settle: [local.id] });

    mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ vorgaenge: [vorgangRow(localVorgang(), 1, true)] }),
    );
    expect(getSyncOutboxSnapshot().find((e) => e.id === entry.id)?.status).toBe('completed');
  });

  it('C8 — Remote-Grabstein v1 bei lokal aktivem Datensatz: keine Adoption, keine Wiederbelebung', () => {
    const local = localVorgang();
    const plan = planVorgangLostAckAdoption(
      [local],
      [vorgangRow(local, 1, true)],
      new Set([local.id]),
    );
    expect(plan).toEqual({ adopt: [], settle: [] });
  });

  it('C9 — Customer: Ack verloren, danach Adressänderung', () => {
    const remoteOrigin = localCustomer();
    const local = localCustomer({ street: 'Neue Straße 9' });
    const entry = outboxEntry('customer', local.id, 'blocked', 'update');
    resetSyncOutboxForTests([entry]);
    const state = buildState({ customers: [local], outbox: [entry] });

    const result = mergeRemoteWorkspacePullIntoState(
      state,
      emptyPull({ customers: [customerRow(remoteOrigin, 1)] }),
    );

    expect(result.conflicts).toEqual([]);
    const merged = (result.state.customers ?? []).find((c) => c.id === local.id);
    expect({ street: merged?.street, version: merged?.sync?.version }).toEqual({
      street: 'Neue Straße 9',
      version: 1,
    });
    expect(getSyncOutboxSnapshot().find((e) => e.id === entry.id)?.status).toBe('pending');
  });

  it('C10 — Customer Remote v2: keine Adoption', () => {
    const local = localCustomer({ street: 'Neue Straße 9' });
    const plan = planCustomerLostAckAdoption(
      [local],
      [customerRow(localCustomer(), 2)],
      new Set([local.id]),
    );
    expect(plan).toEqual({ adopt: [], settle: [] });
  });

  it('C11 — Inhaltsgleichheit ist keine Voraussetzung', () => {
    const local = localVorgang({ title: 'Völlig anderer Titel', baustelle: 'Andere Straße 1' });
    const plan = planVorgangLostAckAdoption(
      [local],
      [vorgangRow(localVorgang(), 1)],
      new Set([local.id]),
    );
    expect(plan.adopt).toEqual([local.id]);
  });

  it('C12 — die Outbox-Operation spielt keine Rolle', () => {
    const local = localVorgang();
    for (const operation of ['create', 'update', 'delete'] as const) {
      resetSyncOutboxForTests([outboxEntry('vorgang', local.id, 'blocked', operation)]);
      const plan = planVorgangLostAckAdoption(
        [local],
        [vorgangRow(local, 1)],
        new Set([local.id]),
      );
      expect(plan.adopt).toEqual([local.id]);
    }
  });

  it('ohne aktiven Outbox-Eintrag wird nichts adoptiert', () => {
    /*
     * Sonst würde jeder Bestandsdatensatz ohne Sync-Meta die Remote-Basis
     * einsammeln — der Lost-Ack-Fall ist an einen offenen Auftrag gebunden.
     */
    const local = localVorgang();
    const plan = planVorgangLostAckAdoption([local], [vorgangRow(local, 1)], new Set<string>());
    expect(plan).toEqual({ adopt: [], settle: [] });
  });

  it('Backfill-Schutz: fehlende Remote-ID wird eingereiht, nicht adoptiert', () => {
    const localV = localVorgang();
    const localC = localCustomer();
    const state = buildState({ vorgaenge: [localV], customers: [localC] });

    mergeRemoteWorkspacePullIntoState(state, emptyPull({ vorgaenge: [], customers: [] }));

    const outbox = getSyncOutboxSnapshot();
    expect(outbox.some((e) => e.entityType === 'customer' && e.entityId === localC.id)).toBe(true);
    // Nichts adoptiert — es gibt keine Remote-Zeile.
    expect(state.vorgaenge[0].sync?.version ?? 0).toBe(0);
  });
});
