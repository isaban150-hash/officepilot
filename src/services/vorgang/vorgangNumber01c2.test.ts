/**
 * EINGANG-01C-2 — echte Vorgangsnummer VG-JJJJ-NNNN, Client-Seite.
 *
 * Die Nummer entsteht ausschliesslich auf dem Server. Der Client
 *  - bittet beim ersten Insert eines NEU angelegten Vorgangs darum (Push-Ebene),
 *  - übernimmt sie aus Push-Ergebnis, Pull, Lost-Ack und Server-RPCs,
 *  - erfindet nie eine und entfernt nie eine vorhandene,
 *  - markiert nie einen Altvorgang zur Nummerierung.
 * Die Datenbankseite prüft `tests/e2e/localdbVorgangNumber01c2.spec.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, Vorgang } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import { createAuftragInboxItem, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { getInboxItemById, hydrateInboxStore } from '../inboxService';
import { createVorgangFromInboxWithContract, createWorkflowVorgang } from '../intakeWorkflowService';
import { resolveOwnReferenceHits } from '../documentCaseMatchService';
import { createVorgangFromInbox, getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { applyPushResultToState } from '../sync/supabaseSyncAdapter';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { generateUuid } from '../sync/syncMetaService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import {
  buildVorgangCloudContentKey,
  buildVorgangCloudPushPayload,
  createVorgangFromCloudRow,
  mapWorkspaceVorgangRow,
  mergeVorgaengeFromPull,
  stripVorgangForCloud,
  type WorkspaceVorgangRow,
} from './vorgangCloudService';

const WORKSPACE = 'ws-01c2';
const UPDATED_AT = '2026-09-30T10:00:00.000Z';
const VG = 'VG-2026-0007';

function seedInbox(id = 'inbox-01c2') {
  const item = createAuftragInboxItem({
    id,
    sender: 'Beispiel Bau GmbH',
    recognizedData: { Kunde: 'Beispiel Bau GmbH' },
  });
  hydrateInboxStore([item]);
  return getInboxItemById(id)!;
}

/** Serverzeile wie aus `upsert_workspace_sync_entity` bzw. dem Pull (to_jsonb der Zeile). */
function serverRow(source: Vorgang, rowVersion: number, vorgangNumber: string | null): WorkspaceVorgangRow {
  const payload = stripVorgangForCloud(source) as unknown as Record<string, unknown>;
  return {
    workspace_id: WORKSPACE,
    vorgang_id: source.id,
    payload: vorgangNumber ? { ...payload, vorgangNumber } : payload,
    vorgang_number: vorgangNumber,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: UPDATED_AT,
    updated_by: 'dev-a',
  };
}

function stateWith(vorgaenge: Vorgang[], outbox: SyncOutboxEntry[] = []): AppPersistedState {
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

function outboxEntry(entityId: string): SyncOutboxEntry {
  return {
    id: generateUuid(),
    entityType: 'vorgang',
    entityId,
    entityId2: undefined,
    operation: 'create',
    version: 0,
    queuedAt: UPDATED_AT,
    retryCount: 1,
    status: 'blocked',
  } as SyncOutboxEntry;
}

function emptyPull(vorgaenge: WorkspaceVorgangRow[]) {
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
    vorgaenge,
    customers: [],
  } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

beforeEach(() => {
  localStorage.clear();
  resetTestStores();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests(createSyncClient());
});

describe('EINGANG-01C-2 — lokaler Create fordert an, erfindet nichts', () => {
  it('T10: manuelle Anlage aus dem Eingang — Nummernwunsch ja, lokale Nummer nein', () => {
    const created = createVorgangFromInbox(seedInbox(), undefined, 'betrieb');
    expect(created).not.toBeNull();
    const stored = getVorgangById(created!.vorgang.id)!;
    expect(stored.vorgangNumberRequested).toBe(true);
    expect(stored.vorgangNumber).toBeUndefined();

    // Payload bleibt frei von Nummer und Wunsch; der Wunsch liegt auf der Push-Ebene.
    const strip = stripVorgangForCloud(stored) as unknown as Record<string, unknown>;
    expect(strip).not.toHaveProperty('vorgangNumber');
    expect(strip).not.toHaveProperty('vorgangNumberRequested');
    expect(strip).not.toHaveProperty('request_vorgang_number');
    const push = buildVorgangCloudPushPayload(stored);
    expect(push.request_vorgang_number).toBe(true);
  });

  it('T12: intelligenter Eingang / Vertrag / Workflow — derselbe zentrale Create fordert an', () => {
    const viaContract = createVorgangFromInboxWithContract(seedInbox('inbox-01c2-contract'));
    const viaWorkflow = createWorkflowVorgang(seedInbox('inbox-01c2-workflow'), 'betrieb');
    for (const created of [viaContract, viaWorkflow]) {
      expect(created).not.toBeNull();
      const stored = getVorgangById(created!.vorgang.id)!;
      expect(stored.vorgangNumberRequested).toBe(true);
      expect(stored.vorgangNumber).toBeUndefined();
    }
  });

  it('T14/T18: Altbestand und hydrierte Vorgänge werden nie zur Nummerierung markiert', () => {
    const legacy = createTestVorgang({ id: 'v-legacy' });
    hydrateVorgangStore([legacy]);
    const stored = getVorgangById('v-legacy')!;
    expect(stored.vorgangNumberRequested).toBeUndefined();
    expect(stored.vorgangNumber).toBeUndefined();
    // Erst-Upload eines alten lokalen Vorgangs (Provisioning): kein Wunsch.
    expect(buildVorgangCloudPushPayload(stored)).not.toHaveProperty('request_vorgang_number');
  });

  it('Wunsch nur beim ersten Insert: nicht mit Serverversion, nicht als Grabstein, nicht mit Nummer', () => {
    const base = createTestVorgang({ id: 'v-flag', vorgangNumberRequested: true });
    expect(buildVorgangCloudPushPayload(base).request_vorgang_number).toBe(true);
    expect(buildVorgangCloudPushPayload(base, true)).not.toHaveProperty('request_vorgang_number');
    expect(
      buildVorgangCloudPushPayload({ ...base, sync: { updatedAt: UPDATED_AT, version: 1, deleted: false, deviceId: 'd', workspaceId: WORKSPACE } }),
    ).not.toHaveProperty('request_vorgang_number');
    expect(buildVorgangCloudPushPayload({ ...base, vorgangNumber: VG })).not.toHaveProperty('request_vorgang_number');
  });
});

describe('EINGANG-01C-2 — Übernahme der Servernummer', () => {
  it('T21: Push-Ergebnis — Nummer lokal übernommen, Wunsch erledigt, Payload danach deckungsgleich', () => {
    const local = createTestVorgang({ id: 'v-push', vorgangNumberRequested: true });
    const row = serverRow(local, 1, VG);
    const next = applyPushResultToState(stateWith([local]), 'vorgang', local.id, 1, UPDATED_AT, false, undefined, row as unknown as Record<string, unknown>);
    const adopted = next.vorgaenge.find((v) => v.id === local.id)!;
    expect(adopted.vorgangNumber).toBe(VG);
    expect(adopted.vorgangNumberRequested).toBeUndefined();
    expect(adopted.sync?.version).toBe(1);

    // Content-Key stabil: lokaler Strip == Serverpayload; kein weiterer Wunsch.
    expect(stripVorgangForCloud(adopted)).toEqual(row.payload);
    expect(buildVorgangCloudPushPayload(adopted)).not.toHaveProperty('request_vorgang_number');

    // Ein späteres Push-Ergebnis ohne Nummer entfernt sie nicht.
    const again = applyPushResultToState(next, 'vorgang', local.id, 2, UPDATED_AT, false, undefined, { payload: {} });
    expect(again.vorgaenge.find((v) => v.id === local.id)!.vorgangNumber).toBe(VG);
  });

  it('T13: zweites Gerät — Cloud-Nummer gewinnt gegen lokales undefined und gegen eine abweichende lokale', () => {
    const remoteSource = createTestVorgang({ id: 'v-pull' });
    const localWithout = { ...remoteSource, sync: { updatedAt: UPDATED_AT, version: 1, deleted: false, deviceId: 'd', workspaceId: WORKSPACE } };
    const merged = mergeVorgaengeFromPull([localWithout], [serverRow(remoteSource, 2, VG)], 'dev-b', WORKSPACE, { dirtyVorgangIds: new Set() });
    expect(merged.conflicts).toEqual([]);
    expect(merged.vorgaenge[0].vorgangNumber).toBe(VG);

    const localOther = { ...localWithout, vorgangNumber: 'VG-2026-0099' };
    const merged2 = mergeVorgaengeFromPull([localOther], [serverRow(remoteSource, 2, VG)], 'dev-b', WORKSPACE, { dirtyVorgangIds: new Set() });
    expect(merged2.vorgaenge[0].vorgangNumber).toBe(VG);

    // Neues Gerät ohne lokalen Stand.
    const fresh = mergeVorgaengeFromPull([], [serverRow(remoteSource, 2, VG)], 'dev-c', WORKSPACE);
    expect(fresh.vorgaenge[0].vorgangNumber).toBe(VG);
    expect(fresh.vorgaenge[0].vorgangNumberRequested).toBeUndefined();
  });

  it('Pull ohne Nummer entfernt eine vorhandene nicht; Altbestand bleibt ohne Nummer und ohne neue Schlüssel', () => {
    const source = createTestVorgang({ id: 'v-keep' });
    const localNumbered = { ...source, vorgangNumber: VG, sync: { updatedAt: UPDATED_AT, version: 1, deleted: false, deviceId: 'd', workspaceId: WORKSPACE } };
    const kept = mergeVorgaengeFromPull([localNumbered], [serverRow(source, 2, null)], 'dev-b', WORKSPACE, { dirtyVorgangIds: new Set() });
    expect(kept.vorgaenge[0].vorgangNumber).toBe(VG);

    const legacy = mergeVorgaengeFromPull([], [serverRow(createTestVorgang({ id: 'v-old' }), 3, null)], 'dev-b', WORKSPACE);
    expect(legacy.vorgaenge[0]).not.toHaveProperty('vorgangNumber');
    expect(legacy.vorgaenge[0]).not.toHaveProperty('vorgangNumberRequested');
  });

  it('mapWorkspaceVorgangRow: Spalte vor Payload; ohne Spalte (älterer Server) der Payload', () => {
    const source = createTestVorgang({ id: 'v-map' });
    const row = serverRow(source, 1, VG);
    expect(mapWorkspaceVorgangRow({ ...row, payload: { ...row.payload, vorgangNumber: 'VG-2026-0001' } })!.payload.vorgangNumber).toBe(VG);
    expect(mapWorkspaceVorgangRow({ ...row, vorgang_number: null })!.payload.vorgangNumber).toBeUndefined();
    const withoutColumn = { ...row } as Partial<WorkspaceVorgangRow>;
    delete withoutColumn.vorgang_number;
    expect(mapWorkspaceVorgangRow(withoutColumn as WorkspaceVorgangRow)!.payload.vorgangNumber).toBe(VG);
    // Ungültige Werte zählen nicht als Nummer.
    expect(mapWorkspaceVorgangRow({ ...row, vorgang_number: 'VG-ALT-1' })!.payload.vorgangNumber).toBeUndefined();
  });

  it('T22: Lost-Ack — die bereits vergebene Servernummer wird adoptiert, kein zweiter Wunsch', () => {
    const local = createTestVorgang({ id: 'v-lost', vorgangNumberRequested: true });
    const entry = outboxEntry(local.id);
    resetSyncOutboxForTests([entry]);
    const result = mergeRemoteWorkspacePullIntoState(stateWith([local], [entry]), emptyPull([serverRow(local, 1, VG)]));
    expect(result.conflicts).toEqual([]);
    const adopted = result.state.vorgaenge.find((v) => v.id === local.id)!;
    expect(adopted.sync?.version).toBe(1);
    expect(adopted.vorgangNumber).toBe(VG);
    expect(adopted.vorgangNumberRequested).toBeUndefined();
    const extracted = extractCloudSyncEntity(result.state, 'vorgang', local.id);
    expect(extracted?.rowVersion).toBe(1);
    expect(buildVorgangCloudPushPayload(adopted)).not.toHaveProperty('request_vorgang_number');
    expect(buildVorgangCloudContentKey(adopted)).toBe(JSON.stringify(serverRow(local, 1, VG).payload));
  });

  it('Provisioning: alter lokaler Vorgang ohne Cloud-Gegenstück wird ohne Nummernwunsch hochgeladen', () => {
    const legacy = createTestVorgang({ id: 'v-provision' });
    const result = mergeRemoteWorkspacePullIntoState(stateWith([legacy]), emptyPull([]));
    const stored = result.state.vorgaenge.find((v) => v.id === legacy.id)!;
    expect(stored.vorgangNumberRequested).toBeUndefined();
    expect(buildVorgangCloudPushPayload(stored)).not.toHaveProperty('request_vorgang_number');
  });

  it('T11: Server-Create (Angebot/Auftrag) — Nummer aus der RPC-Zeile sofort lokal', () => {
    const source = createTestVorgang({ id: 'v-order', orderNumber: 'AU-2026-0003' });
    const mapped = mapWorkspaceVorgangRow(serverRow(source, 1, VG))!;
    const vorgang = createVorgangFromCloudRow(mapped.payload, mapped.rowVersion, mapped.updatedAt, false, 'dev-a', WORKSPACE);
    expect(vorgang.vorgangNumber).toBe(VG);
    expect(vorgang.orderNumber).toBe('AU-2026-0003');
  });
});

describe('EINGANG-01C-2 — kein VG-Matching in diesem Block', () => {
  it('T15: eine VG-Nummer im Dokument ist keine Referenz; AU bleibt die einzige Auftragsreferenz', () => {
    const vorgang = createTestVorgang({ id: 'v-ref', vorgangNumber: 'VG-2026-0012', orderNumber: 'AU-2026-0012' });
    const item = createAuftragInboxItem({ id: 'inbox-ref', recognizedData: { Betreff: 'Ihr Vorgang VG-2026-0012' } });
    expect(resolveOwnReferenceHits(item, [vorgang])).toEqual([]);
    const withAu = createAuftragInboxItem({ id: 'inbox-ref-au', recognizedData: { Betreff: 'Auftrag AU-2026-0012, Nr. 2026-0012' } });
    expect(resolveOwnReferenceHits(withAu, [vorgang])).toEqual([{ kind: 'order', value: 'AU-2026-0012', vorgangId: 'v-ref' }]);
  });
});
