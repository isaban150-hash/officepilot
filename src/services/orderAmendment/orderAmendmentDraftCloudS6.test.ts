/**
 * CLOUD-SYNC S6 — der Nachtragsentwurf auf mehreren Geräten (Client-Seite).
 *
 * S   fachlicher Inhalt: keine Sequenz, keine Absicht, kein Fingerprint
 * T   ein Cloud-Entwurf landet in genau seinem Vorgang
 * U   fehlt der Vorgang noch: nicht verloren, nicht falsch zugeordnet, später eingehängt
 * V   Versionskonflikt mit Entscheidung, kein Last-Write-Wins
 * W   verworfen: Grabstein neben dem Vorgang, kein Wiederbeleben
 * X   bestätigt (verbraucht): kein Wiederbeleben
 * Y   Altbestand: nur zu bestätigten Cloud-Aufträgen, nie mit Absicht
 * Z   Speicherfehler werden ehrlich gemeldet
 * AA  ein veralteter Tab meldet keinen falschen Erfolg
 * AC  atomarer Verbrauch über die Bestätigung mit Bindung
 * AD/AE genau ein bestätigter Nachtrag; Retry mit derselben Bindung
 * AF  sourceDraftId
 * AG  der Schlussrechnungs-Guard bleibt
 * AJ  kein Nachtragsentwurf und kein Grabstein gerät in einen fremden Workspace
 *
 * Die Serverseite prüfen `supabase/tests/order_drafts_s6.sql` und
 * `supabase/tests/order_drafts_parallel_s6.sql`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractConfirmationSnapshot, OrderAmendment, Vorgang } from '../../types/models';
import type { OrderAmendmentDraftCloudPayload, WorkspaceOrderAmendmentDraftRow } from '../../types/orderAmendmentDraftCloud';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import * as supabaseLib from '../../lib/supabase';
import * as billingRules from '../orderBillingRules';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { getSyncCoordinator } from '../sync/syncCoordinator';
import { pushPendingChangesFromUi } from '../sync/syncUiService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  clearInMemoryBusinessState,
  persistAll,
  resetBusinessStateWriteLocksForTests,
} from '../persistenceService';
import { bootstrapBusinessState } from '../storage/storageBootstrapService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { buildStorageKey, resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { getVorgangById, hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import { disableOrderDraftCloudSyncForTests, enableOrderDraftCloudSyncForTests } from '../../test/orderDraftCloudSwitch';
import {
  acceptOrderAmendmentDraftCloudEnd,
  addOrderAmendmentDraftPosition,
  continueOrderAmendmentDraftAsNew,
  createOrderAmendmentDraft,
  deleteOrderAmendmentDraft,
  keepLocalOrderAmendmentDraftVersion,
  resolveOrderAmendmentDraftCloudBinding,
  takeCloudOrderAmendmentDraftVersion,
  updateOrderAmendmentDraft,
} from '../orderAmendmentService';
import {
  getOrderAmendmentDraftTombstoneSnapshot,
  resetOrderAmendmentDraftTombstones,
} from './orderAmendmentDraftTombstoneStore';
import {
  buildOrderAmendmentDraftCloudPushPayload,
  planOrderAmendmentDraftBackfill,
  stripOrderAmendmentDraftForCloud,
} from './orderAmendmentDraftCloudService';
import { confirmOrderAmendmentWithCloud } from './orderAmendmentCloudConfirmOrchestrator';
import {
  getOrderAmendmentConfirmIntent,
  resetOrderAmendmentConfirmIntentsForTests,
} from './orderAmendmentConfirmIntentService';
import { parseWorkspaceOrderAmendmentPullRow } from './workspaceOrderAmendmentCloudService';
import { rebaseSyncCandidateOntoLocalChanges } from '../sync/syncLocalRebaseService';

const WS = 'ws-amendment-draft-s6';
const DEVICE = 'device-amendment-draft-s6';
const VORGANG = 'v-s6-auftrag';
const NOW = '2026-10-07T09:00:00.000Z';

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-s6',
    confirmedAt: NOW,
    customer: 'Muster Bau GmbH',
    auftraggeber: 'Muster Bau GmbH',
    baustelle: 'Weg 6',
    title: 'S6 Auftrag',
    positions: [
      { id: 'op-s6-1', description: 'Montage', plannedQuantity: 10, unit: 'Stunden', unitPrice: 65, category: 'arbeit', billable: true },
    ],
    negotiation: { notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
    immutable: true,
  };
}

function auftrag(id = VORGANG): Vorgang {
  return createTestVorgang({
    id,
    status: 'beauftragt',
    contractConfirmation: { ...snapshot(), id: `snapshot-${id}` },
    orderPositions: [createOrderPosition({ id: 'op-s6-1', plannedQuantity: 10, unit: 'Stunden', unitPrice: 65 })],
  });
}

function neuerEntwurf(titel = 'Zusatzleistung'): OrderAmendment {
  const created = createOrderAmendmentDraft(VORGANG, { title: titel });
  if (!created.success) throw new Error(created.errorKey);
  const added = addOrderAmendmentDraftPosition(VORGANG, created.amendment.id, {
    changeType: 'add',
    description: 'Zusatzposition',
    quantity: 2,
    unit: 'Stück',
    unitPrice: 25,
    category: 'material',
    billable: true,
  });
  if (!added.success) throw new Error(added.errorKey);
  return added.amendment;
}

function entwurf(id: string, vorgangId = VORGANG): OrderAmendment | undefined {
  return getVorgangById(vorgangId)?.orderAmendments?.find((item) => item.id === id);
}

function inhalt(draft: OrderAmendment, overrides: Partial<OrderAmendmentDraftCloudPayload> = {}): OrderAmendmentDraftCloudPayload {
  return { ...stripOrderAmendmentDraftForCloud(draft), ...overrides };
}

function zeile(
  payload: OrderAmendmentDraftCloudPayload | null,
  rowVersion: number,
  options: { id?: string; vorgangId?: string; deleted?: boolean; consumed?: string } = {},
): WorkspaceOrderAmendmentDraftRow {
  const id = options.id ?? payload?.id ?? 'oa-s6-zeile';
  const ended = Boolean(options.deleted || options.consumed);
  return {
    workspace_id: WS,
    client_draft_id: id,
    vorgang_id: options.vorgangId ?? payload?.vorgangId ?? VORGANG,
    status: options.consumed ? 'consumed' : 'active',
    payload: ended ? undefined : (JSON.parse(JSON.stringify(payload)) as Record<string, unknown>),
    consumed_client_amendment_id: options.consumed ?? null,
    row_version: rowVersion,
    deleted: options.deleted ?? false,
    deleted_at: options.deleted ? NOW : null,
    updated_at: NOW,
  };
}

function abgleich(rows: WorkspaceOrderAmendmentDraftRow[]) {
  const result = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), {
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
    orderDrafts: [],
    orderAmendmentDrafts: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);
  applyStateToStores(result.state);
  return result;
}

function entwurfsAuftraege() {
  return getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'order_amendment_draft' && entry.status !== 'completed',
  );
}

function sendenMit(antwort: (payload: Record<string, unknown>, version: number) => { rowVersion: number } | Error) {
  return vi
    .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
    .mockImplementation(async (_ws, type, payload, version) => {
      if (type !== 'order_amendment_draft') return { rowVersion: version + 1, payload: {}, entityId: null, deduped: false };
      const result = antwort(payload, version);
      if (result instanceof Error) throw result;
      return { rowVersion: result.rowVersion, payload: {}, entityId: null, deduped: false };
    });
}

async function senden() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  const adapter = new SupabaseSyncAdapter(null);
  vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
  getSyncCoordinator().setAdapter(adapter);
  return pushPendingChangesFromUi();
}

/** Ein bereits mit der Cloud abgeglichener Nachtragsentwurf in Version 1. */
async function abgeglichen(titel?: string): Promise<OrderAmendment> {
  const draft = neuerEntwurf(titel);
  sendenMit(() => ({ rowVersion: 1 }));
  await senden();
  vi.mocked(workspaceCloudService.rpcUpsertWorkspaceSyncEntity).mockRestore();
  const synced = entwurf(draft.id)!;
  if (synced.sync?.version !== 1) throw new Error('nicht abgeglichen');
  return synced;
}

/** Bestätigungs-RPC auf Client-Ebene: Argumente festhalten, Antwort wie der Server. */
function bestaetigungsServer(verhalten: (args: Record<string, unknown>) => Error | null = () => null) {
  const calls: Array<Record<string, unknown>> = [];
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'confirm_workspace_order_amendment') return { data: null, error: { message: `unerwartet: ${name}` } };
      calls.push(args);
      const fehler = verhalten(args);
      if (fehler) return { data: null, error: { message: fehler.message } };
      const amendment = args.p_amendment as Record<string, unknown>;
      const payload = {
        ...amendment,
        clientAmendmentId: args.p_client_amendment_id,
        vorgangId: args.p_vorgang_id,
        sequenceNo: 1,
        ...(args.p_source_draft_id ? { sourceDraftId: args.p_source_draft_id } : {}),
      };
      return {
        data: {
          row: {
            id: 'cloud-s6-1',
            workspace_id: WS,
            vorgang_id: args.p_vorgang_id,
            client_amendment_id: args.p_client_amendment_id,
            sequence_no: 1,
            status: 'bestaetigt',
            content_fingerprint: 'fp-s6',
            confirmed_at: NOW,
            confirmed_by: 'user-s6',
            row_version: 1,
            created_at: NOW,
            updated_at: NOW,
            payload,
          },
          amendment: payload,
          idempotent_replay: calls.length > 1,
        },
        error: null,
      };
    },
  } as never);
  return calls;
}

function andererTabSpeichert(): void {
  const key = buildStorageKey({ type: 'workspace', workspaceId: WS });
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error('kein Bestand');
  localStorage.setItem(key, raw.replace(/^\{"businessRevision":(\d+)/, (_m, n: string) => `{"businessRevision":${Number(n) + 1}`));
}

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS });
  resetOrderAmendmentConfirmIntentsForTests();
  resetOrderAmendmentDraftTombstones();
  resetVorgaenge();
  hydrateVorgangStore([auftrag()]);
  persistAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('S6-AD-S — der Cloud-Inhalt ist nur der echte Nachtragsentwurf', () => {
  it('S1 — keine Sequenz, keine Absicht, kein Fingerprint, kein Status, keine Sync-Metadaten', () => {
    const draft = neuerEntwurf();
    const payload = stripOrderAmendmentDraftForCloud({
      ...draft,
      reason: 'Kundenwunsch',
      sync: { updatedAt: NOW, version: 2, deleted: false, deviceId: DEVICE, workspaceId: WS },
    });
    expect(Object.keys(payload).sort()).toEqual(['createdAt', 'id', 'positions', 'reason', 'title', 'updatedAt', 'vorgangId']);
    expect(Object.keys(payload.positions[0]!).sort()).toEqual(
      ['billable', 'category', 'changeType', 'description', 'id', 'quantity', 'unit', 'unitPrice'],
    );
    const reist = JSON.stringify(buildOrderAmendmentDraftCloudPushPayload(draft));
    for (const verboten of ['sequence', 'clientAmendmentId', 'Fingerprint', 'rpcInput', '"status"', '"sync"', 'conflict', 'plannedQuantity']) {
      expect(reist, verboten).not.toContain(verboten);
    }
    expect(buildOrderAmendmentDraftCloudPushPayload(draft, true)).toEqual({
      draft_id: draft.id,
      vorgang_id: VORGANG,
      payload: {},
      deleted: true,
    });
  });

  it('S2 — Notausschalter: ohne Entwurfs-Sync erreicht kein Nachtragsentwurf die Cloud; der Vorgang wird dadurch nicht gesendet', async () => {
    disableOrderDraftCloudSyncForTests();
    const draft = neuerEntwurf();
    expect(entwurfsAuftraege().map((entry) => entry.entityId)).toEqual([draft.id]);
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'vorgang' && entry.status !== 'completed')).toHaveLength(0);
    const upsert = sendenMit(() => ({ rowVersion: 1 }));
    await senden();
    expect(upsert.mock.calls.filter(([, type]) => type === 'order_amendment_draft')).toHaveLength(0);
    expect(entwurf(draft.id)?.sync).toBeUndefined();
  });

  it('S3 — freigegeben: der Entwurf geht als eigene Entität hinaus und trägt danach die Serverversion', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = neuerEntwurf();
    const gesehen: Array<{ payload: Record<string, unknown>; version: number }> = [];
    sendenMit((payload, version) => {
      gesehen.push({ payload, version });
      return { rowVersion: 1 };
    });
    await senden();
    expect(gesehen).toHaveLength(1);
    expect(gesehen[0]!.version).toBe(0);
    expect(gesehen[0]!.payload).toMatchObject({ draft_id: draft.id, vorgang_id: VORGANG, deleted: false });
    expect(entwurf(draft.id)?.sync?.version).toBe(1);
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });
});

describe('S6-AD-T/U — Cloud-Entwürfe landen in genau ihrem Vorgang', () => {
  it('T1 — der Entwurf eines anderen Geräts erscheint im richtigen Vorgang, nicht in einem anderen', () => {
    enableOrderDraftCloudSyncForTests();
    hydrateVorgangStore([auftrag(), auftrag('v-s6-anderer')]);
    persistAll();
    const remote: OrderAmendmentDraftCloudPayload = {
      id: 'oa-s6-remote',
      vorgangId: VORGANG,
      title: 'Vom Tablet',
      positions: [{ id: 'oad-r1', changeType: 'add', description: 'Prüfung', quantity: 1, unit: 'Pauschal', unitPrice: 80 }],
      createdAt: NOW,
      updatedAt: NOW,
    };
    abgleich([zeile(remote, 2)]);
    expect(entwurf('oa-s6-remote')?.title).toBe('Vom Tablet');
    expect(entwurf('oa-s6-remote')?.sync?.version).toBe(2);
    expect(getVorgangById('v-s6-anderer')?.orderAmendments ?? []).toHaveLength(0);
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });

  it('U1 — fehlt der Auftrag lokal noch, geht der Entwurf nicht verloren und landet nirgends falsch; später wird er eingehängt', () => {
    enableOrderDraftCloudSyncForTests();
    const remote: OrderAmendmentDraftCloudPayload = {
      id: 'oa-s6-spaeter',
      vorgangId: 'v-s6-spaeter',
      title: 'Kommt später an',
      positions: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    abgleich([zeile(remote, 1)]);
    expect(getVorgangById(VORGANG)?.orderAmendments?.some((item) => item.id === 'oa-s6-spaeter')).toBeFalsy();
    hydrateVorgangStore([...(buildPersistedStateSnapshot().vorgaenge ?? []), auftrag('v-s6-spaeter')]);
    abgleich([zeile(remote, 1)]);
    expect(entwurf('oa-s6-spaeter', 'v-s6-spaeter')?.title).toBe('Kommt später an');
  });
});

describe('S6-AD-V — Versionskonflikt', () => {
  it('V1 — Konflikt am konkreten Entwurf; Bearbeiten gesperrt; „Cloud-Fassung übernehmen" sendet nichts', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    expect(updateOrderAmendmentDraft(VORGANG, draft.id, { title: 'Lokal geändert' }).success).toBe(true);
    const result = abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(result.conflicts).toContain(`order_amendment_draft:${draft.id}`);
    expect(entwurf(draft.id)?.conflict?.kind).toBe('version');
    expect(entwurf(draft.id)?.title).toBe('Lokal geändert');
    expect(updateOrderAmendmentDraft(VORGANG, draft.id, { title: 'x' })).toEqual({ success: false, errorKey: 'order_amendment_conflict_open' });
    expect(resolveOrderAmendmentDraftCloudBinding(VORGANG, draft.id)).toEqual({ ok: false, reason: 'draft_conflict' });
    expect(takeCloudOrderAmendmentDraftVersion(VORGANG, draft.id)).toEqual({ ok: true });
    expect(entwurf(draft.id)?.title).toBe('Anderswo geändert');
    expect(entwurf(draft.id)?.sync?.version).toBe(2);
    expect(entwurf(draft.id)?.conflict).toBeUndefined();
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });

  it('V2 — „Meine Fassung behalten" sendet bewusst gegen die gesehene Serverversion', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderAmendmentDraft(VORGANG, draft.id, { title: 'Lokal geändert' });
    abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(keepLocalOrderAmendmentDraftVersion(VORGANG, draft.id)).toEqual({ ok: true });
    const gesehen: Array<{ version: number; titel: unknown }> = [];
    sendenMit((payload, version) => {
      gesehen.push({ version, titel: (payload.payload as Record<string, unknown>).title });
      return { rowVersion: 3 };
    });
    await senden();
    expect(gesehen).toEqual([{ version: 2, titel: 'Lokal geändert' }]);
  });

  it('V3 — Cloud neuer, lokal nichts offen: übernommen', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(entwurf(draft.id)?.title).toBe('Anderswo geändert');
    expect(entwurf(draft.id)?.conflict).toBeUndefined();
  });
});

describe('S6-AD-W — verworfen', () => {
  it('W1 — Verwerfen: der Entwurf verschwindet aus dem Vorgang, ein Grabstein ohne Inhalt geht hinaus und verschwindet danach', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const result = deleteOrderAmendmentDraft(VORGANG, draft.id);
    expect(result.success).toBe(true);
    expect(entwurf(draft.id)).toBeUndefined();
    expect(getOrderAmendmentDraftTombstoneSnapshot().map((t) => t.id)).toEqual([draft.id]);
    expect(entwurfsAuftraege()[0]?.operation).toBe('delete');
    const gesehen: Array<Record<string, unknown>> = [];
    sendenMit((payload) => {
      gesehen.push(payload);
      return { rowVersion: 2 };
    });
    await senden();
    expect(gesehen).toEqual([{ draft_id: draft.id, vorgang_id: VORGANG, payload: {}, deleted: true }]);
    expect(getOrderAmendmentDraftTombstoneSnapshot()).toHaveLength(0);
    abgleich([zeile(null, 2, { id: draft.id, deleted: true })]);
    expect(entwurf(draft.id)).toBeUndefined();
  });

  it('W2 — anderswo verworfen, hier geändert: Konflikt; als neuer Entwurf nur mit neuer Kennung und neuen Positionskennungen', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderAmendmentDraft(VORGANG, draft.id, { title: 'Hier weiter' });
    abgleich([zeile(null, 2, { id: draft.id, deleted: true })]);
    expect(entwurf(draft.id)?.conflict?.kind).toBe('deleted');
    const r = continueOrderAmendmentDraftAsNew(VORGANG, draft.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draftId).not.toBe(draft.id);
    const fresh = entwurf(r.draftId!)!;
    expect(fresh.title).toBe('Hier weiter');
    expect(fresh.positions.map((p) => p.id)).not.toContain(draft.positions[0]!.id);
    expect(entwurf(draft.id)).toBeUndefined();
  });

  it('W3 — anderswo verworfen, hier nichts offen: verschwindet; „Verwerfen annehmen" ohne Sendeauftrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const a = await abgeglichen('A');
    abgleich([zeile(null, 2, { id: a.id, deleted: true })]);
    expect(entwurf(a.id)).toBeUndefined();
    const b = await abgeglichen('B');
    updateOrderAmendmentDraft(VORGANG, b.id, { title: 'B geändert' });
    abgleich([zeile(null, 2, { id: b.id, deleted: true })]);
    expect(acceptOrderAmendmentDraftCloudEnd(VORGANG, b.id)).toEqual({ ok: true });
    persistAll();
    expect(entwurf(b.id)).toBeUndefined();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });
});

describe('S6-AD-X — bestätigt (verbraucht)', () => {
  it('X1 — anderswo bestätigt: ohne offene Änderung weg, mit offener Änderung ein sichtbarer Konflikt', async () => {
    enableOrderDraftCloudSyncForTests();
    const a = await abgeglichen('A');
    const b = await abgeglichen('B');
    updateOrderAmendmentDraft(VORGANG, b.id, { title: 'B geändert' });
    abgleich([zeile(null, 2, { id: a.id, consumed: 'oam-x' }), zeile(null, 2, { id: b.id, consumed: 'oam-y' })]);
    expect(entwurf(a.id)).toBeUndefined();
    expect(entwurf(b.id)?.conflict?.kind).toBe('consumed');
    expect(entwurf(b.id)?.conflict?.remote.consumedRef).toBe('oam-y');
  });
});

describe('S6-AD-Y — Altbestand', () => {
  it('Y1 — nur zu bestätigten Cloud-Aufträgen, nie mit Absicht, nie bekannt, nie mit Konflikt', () => {
    const vorgang: Vorgang = {
      ...auftrag(),
      orderAmendments: [
        { id: 'oa-y1', vorgangId: VORGANG, status: 'entwurf', title: 'neu', positions: [], createdAt: NOW, updatedAt: NOW },
        { id: 'oa-y2', vorgangId: VORGANG, status: 'entwurf', title: 'bekannt', positions: [], createdAt: NOW, updatedAt: NOW },
        { id: 'oa-y3', vorgangId: VORGANG, status: 'entwurf', title: 'Absicht', positions: [], createdAt: NOW, updatedAt: NOW },
        {
          id: 'oa-y4', vorgangId: VORGANG, status: 'entwurf', title: 'gesendet', positions: [], createdAt: NOW, updatedAt: NOW,
          sync: { updatedAt: NOW, version: 1, deleted: false, deviceId: DEVICE, workspaceId: WS },
        },
      ],
    };
    const geplant = planOrderAmendmentDraftBackfill({
      vorgaenge: [vorgang, { ...auftrag('v-s6-lokal'), orderAmendments: [{ id: 'oa-y5', vorgangId: 'v-s6-lokal', status: 'entwurf', title: 'lokal', positions: [], createdAt: NOW, updatedAt: NOW }] }],
      remoteRows: [zeile(null, 1, { id: 'oa-y2', deleted: true })],
      cloudOrderIds: new Set([VORGANG]),
      intentDraftIds: new Set(['oa-y3']),
    });
    expect(geplant).toEqual(['oa-y1']);
  });
});

describe('S6-AD-Z/AA — ehrliche Speicherfehler', () => {
  it('Z1 — Speicher voll: Anlegen und Verwerfen melden den Fehler; nichts bleibt halb', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('voll', 'QuotaExceededError');
    });
    expect(createOrderAmendmentDraft(VORGANG)).toEqual({ success: false, errorKey: 'order_amendment_persist_failed' });
    expect(deleteOrderAmendmentDraft(VORGANG, draft.id)).toEqual({ success: false, errorKey: 'order_amendment_persist_failed' });
    setItem.mockRestore();
    expect(getVorgangById(VORGANG)?.orderAmendments?.map((item) => item.id)).toEqual([draft.id]);
    expect(getOrderAmendmentDraftTombstoneSnapshot()).toHaveLength(0);
  });

  it('AA1 — veralteter Tab: kein falscher Erfolg, der Bestand des anderen Tabs bleibt', () => {
    const draft = neuerEntwurf();
    andererTabSpeichert();
    expect(updateOrderAmendmentDraft(VORGANG, draft.id, { title: 'x' })).toEqual({ success: false, errorKey: 'order_amendment_persist_failed' });
    expect(createOrderAmendmentDraft(VORGANG)).toEqual({ success: false, errorKey: 'order_amendment_persist_failed' });
    expect(entwurf(draft.id)?.title).toBe('Zusatzleistung');
  });
});

describe('S6-AD-AC..AG — Bestätigung mit Bindung', () => {
  it('AC1 — Notausschalter: die Bestätigung geht ohne Bindungsangaben hinaus', async () => {
    disableOrderDraftCloudSyncForTests();
    const draft = neuerEntwurf();
    const calls = bestaetigungsServer();
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(Object.keys(calls[0]!).sort()).toEqual(['p_amendment', 'p_client_amendment_id', 'p_vorgang_id', 'p_workspace_id']);
  });

  it('AC2/AF — freigegeben: Entwurfskennung und Version gehen mit; danach verbraucht, kein Grabstein, sourceDraftId am Nachtrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const calls = bestaetigungsServer();
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(calls[0]).toMatchObject({ p_source_draft_id: draft.id, p_expected_draft_row_version: 1 });
    expect(entwurf(draft.id)).toBeUndefined();
    expect(getOrderAmendmentDraftTombstoneSnapshot()).toHaveLength(0);
    expect(entwurfsAuftraege()).toHaveLength(0);
    const confirmed = getVorgangById(VORGANG)?.confirmedOrderAmendments ?? [];
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.sourceDraftId).toBe(draft.id);
  });

  it('AD1/AE1 — Antwort verloren: der Retry sendet dieselbe Kennung mit derselben Bindung; es bleibt ein Nachtrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    let verloren = true;
    const calls = bestaetigungsServer(() => {
      if (verloren) {
        verloren = false;
        return new Error('Failed to fetch');
      }
      return null;
    });
    const erster = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(erster).toMatchObject({ ok: false, intentRetained: true, draftLocked: true });
    expect(getOrderAmendmentConfirmIntent(VORGANG, draft.id)?.binding).toEqual({ sourceDraftId: draft.id, expectedDraftRowVersion: 1 });
    const zweiter = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(zweiter.ok, JSON.stringify(zweiter)).toBe(true);
    expect(calls.map((call) => [call.p_client_amendment_id, call.p_source_draft_id, call.p_expected_draft_row_version])).toEqual([
      [calls[0]!.p_client_amendment_id, draft.id, 1],
      [calls[0]!.p_client_amendment_id, draft.id, 1],
    ]);
    expect(getVorgangById(VORGANG)?.confirmedOrderAmendments).toHaveLength(1);
  });

  it('AD2 — ein anderes Gerät hat denselben Entwurf bereits bestätigt: kein zweiter Nachtrag, ehrlicher Befund', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    bestaetigungsServer(() => new Error('order_amendment_draft_already_consumed'));
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(r).toMatchObject({ ok: false, reason: 'draft_consumed', errorKey: 'orderAmendmentCloud.confirm.consumed' });
    expect(getVorgangById(VORGANG)?.confirmedOrderAmendments ?? []).toHaveLength(0);
    expect(getOrderAmendmentConfirmIntent(VORGANG, draft.id)).toBeNull();
    expect(entwurf(draft.id)?.title).toBe('Zusatzleistung');
  });

  it('AD3 — ein noch nicht übertragener Entwurf wird nicht bestätigt (erst zur Ruhe bringen)', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = neuerEntwurf();
    const syncUi = await import('../sync/syncUiService');
    const sync = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue({} as never);
    const calls = bestaetigungsServer();
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(r).toMatchObject({ ok: false, reason: 'draft_not_synced' });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('AD4 — veraltetes Gerät mit eigener Änderung: der Sync-Lauf bringt den anderswo bestätigten Nachtrag — „bereits bestätigt", nie „verworfen", kein Aufruf', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    expect(updateOrderAmendmentDraft(VORGANG, draft.id, { title: 'Hier geändert' }).success).toBe(true);
    const calls = bestaetigungsServer();
    const syncUi = await import('../sync/syncUiService');
    const sync = vi.spyOn(syncUi, 'runSyncFromUi').mockImplementation(async () => {
      const bestaetigt = parseWorkspaceOrderAmendmentPullRow(
        {
          id: 'cloud-ad4', workspace_id: WS, vorgang_id: VORGANG, client_amendment_id: 'oam-anderes-geraet', sequence_no: 1,
          status: 'bestaetigt', content_fingerprint: 'fp', confirmed_at: NOW, confirmed_by: 'user', row_version: 1,
          created_at: NOW, updated_at: NOW,
          payload: {
            title: 'Zusatzleistung', positions: [{ id: 'oad-ad4', changeType: 'add', description: 'Zusatz', plannedQuantity: 1, unit: 'Stück', unitPrice: 5 }],
            clientAmendmentId: 'oam-anderes-geraet', vorgangId: VORGANG, sequenceNo: 1, sourceDraftId: draft.id,
          },
        },
        WS,
      )!;
      const v = getVorgangById(VORGANG)!;
      hydrateVorgangStore([
        {
          ...v,
          confirmedOrderAmendments: [bestaetigt],
          orderAmendments: (v.orderAmendments ?? []).map((a) =>
            a.id === draft.id
              ? { ...a, conflict: { kind: 'consumed', detectedAt: NOW, remote: { rowVersion: 2, status: 'consumed', deleted: false, payload: null, consumedRef: 'oam-anderes-geraet' } } }
              : a,
          ),
        },
      ]);
      return {} as never;
    });
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, reason: 'draft_consumed', errorKey: 'orderAmendmentCloud.confirm.consumed' });
    expect(calls).toHaveLength(0);
    expect(getOrderAmendmentConfirmIntent(VORGANG, draft.id)).toBeNull();
    expect(getVorgangById(VORGANG)?.confirmedOrderAmendments).toHaveLength(1);
  });

  it('AF2 — ein anderswo bestätigter Nachtrag nennt seinen Entwurf; dieser Entwurf wird hier nicht noch einmal bestätigt', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const row = {
      id: 'cloud-af2', workspace_id: WS, vorgang_id: VORGANG, client_amendment_id: 'oam-af2', sequence_no: 1, status: 'bestaetigt',
      content_fingerprint: 'fp', confirmed_at: NOW, confirmed_by: 'user', row_version: 1, created_at: NOW, updated_at: NOW,
      payload: {
        title: 'Zusatzleistung', positions: [{ id: 'oad-af2', changeType: 'add', description: 'Zusatz', plannedQuantity: 1, unit: 'Stück', unitPrice: 5 }],
        clientAmendmentId: 'oam-af2', vorgangId: VORGANG, sequenceNo: 1, sourceDraftId: draft.id,
      },
    };
    const parsed = parseWorkspaceOrderAmendmentPullRow(row, WS);
    expect(parsed?.sourceDraftId).toBe(draft.id);
    hydrateVorgangStore([{ ...getVorgangById(VORGANG)!, confirmedOrderAmendments: [parsed!] }]);
    const calls = bestaetigungsServer();
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(r).toMatchObject({ ok: false, reason: 'already_confirmed' });
    expect(calls).toHaveLength(0);
  });

  it('AG1 — der Schlussrechnungs-Guard bleibt: nach der Schlussrechnung keine Bestätigung, auch nicht mit Bindung', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    vi.spyOn(billingRules, 'hasFinalSchlussrechnung').mockReturnValue(true);
    const calls = bestaetigungsServer();
    const r = await confirmOrderAmendmentWithCloud(VORGANG, draft.id);
    expect(r).toMatchObject({ ok: false, reason: 'final_invoice_exists' });
    expect(calls).toHaveLength(0);
  });
});

describe('S6-AD-AI — während eines Sync-Laufs gespeichert: keine verlorene Serverversion, kein unnötiger Konflikt', () => {
  function mitEntwurf(titel: string, version: number | null): ReturnType<typeof buildPersistedStateSnapshot> {
    const state = buildPersistedStateSnapshot();
    return {
      ...state,
      vorgaenge: (state.vorgaenge ?? []).map((v) =>
        v.id === VORGANG
          ? {
              ...v,
              orderAmendments: [
                {
                  id: 'oa-ai',
                  vorgangId: VORGANG,
                  status: 'entwurf',
                  title: titel,
                  positions: [],
                  createdAt: NOW,
                  updatedAt: NOW,
                  ...(version === null ? {} : { sync: { updatedAt: NOW, version, deleted: false, deviceId: DEVICE, workspaceId: WS } }),
                },
              ],
            }
          : v,
      ),
    };
  }
  const entwurfIn = (state: ReturnType<typeof buildPersistedStateSnapshot>) =>
    state.vorgaenge?.find((v) => v.id === VORGANG)?.orderAmendments?.find((a) => a.id === 'oa-ai');

  it('AI2 — der Lauf setzt nur die Serverversion, lokal wurde der Titel geändert: Titel bleibt, Version kommt an', () => {
    const r = rebaseSyncCandidateOntoLocalChanges({
      base: mitEntwurf('Nachtrag', null),
      local: mitEntwurf('Neuer Titel während des Laufs', null),
      candidate: mitEntwurf('Nachtrag', 1),
    });
    expect(entwurfIn(r.state)?.title).toBe('Neuer Titel während des Laufs');
    expect(entwurfIn(r.state)?.sync?.version).toBe(1);
    expect(r.contentConflicts).toBe(0);
  });

  it('AI3 — der Lauf brachte Inhalt eines anderen Geräts, lokal wurde ebenfalls geändert: lokal bleibt mit alter Version (Server entscheidet)', () => {
    const r = rebaseSyncCandidateOntoLocalChanges({
      base: mitEntwurf('Nachtrag', 1),
      local: mitEntwurf('Hier geändert', 1),
      candidate: mitEntwurf('Anderswo geändert', 2),
    });
    expect(entwurfIn(r.state)?.title).toBe('Hier geändert');
    expect(entwurfIn(r.state)?.sync?.version).toBe(1);
    expect(r.contentConflicts).toBeGreaterThan(0);
  });
});

describe('S6-AD-AJ — kein Nachtragsentwurf und kein Grabstein gerät in einen fremden Workspace', () => {
  it('AJ1 — Bereichswechsel: aus A ist in B nichts sichtbar und nichts sendbar; zurück in A ist der Grabstein wieder da', async () => {
    enableOrderDraftCloudSyncForTests();
    const userId = 'user-s6';
    const offen = neuerEntwurf('Bleibt in A');
    const draft = await abgeglichen('Verworfen in A');
    expect(deleteOrderAmendmentDraft(VORGANG, draft.id).success).toBe(true);
    expect(extractCloudSyncEntity(buildPersistedStateSnapshot(), 'order_amendment_draft', draft.id)).toMatchObject({ deleted: true });

    clearInMemoryBusinessState();
    expect(getOrderAmendmentDraftTombstoneSnapshot()).toHaveLength(0);
    expect(extractCloudSyncEntity(buildPersistedStateSnapshot(), 'order_amendment_draft', draft.id)).toBeNull();
    expect(extractCloudSyncEntity(buildPersistedStateSnapshot(), 'order_amendment_draft', offen.id)).toBeNull();

    localStorage.setItem(buildStorageKey({ type: 'workspace', workspaceId: 'ws-s6-b' }), '{kaputt');
    const b = bootstrapBusinessState({ userId, workspaceId: 'ws-s6-b' });
    expect(b.loadFailed).toBe(true);
    expect(getOrderAmendmentDraftTombstoneSnapshot(), 'kein Grabstein aus A im Speicher von B').toHaveLength(0);
    expect(getVorgangById(VORGANG), 'kein Vorgang aus A im Speicher von B').toBeUndefined();
    const upsert = sendenMit(() => ({ rowVersion: 9 }));
    await senden().catch(() => undefined);
    expect(upsert.mock.calls.filter(([, type]) => type === 'order_amendment_draft'), 'kein Versand aus A in B').toHaveLength(0);
    upsert.mockRestore();

    bootstrapBusinessState({ userId, workspaceId: WS });
    expect(getOrderAmendmentDraftTombstoneSnapshot().map((t) => t.id)).toEqual([draft.id]);
    expect(entwurf(offen.id)?.title).toBe('Bleibt in A');
    expect(entwurf(draft.id)).toBeUndefined();
  });
});
