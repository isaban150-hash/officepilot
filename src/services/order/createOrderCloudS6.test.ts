/**
 * CLOUD-SYNC S6 — die Auftragsanlage mit Entwurfsbindung (Client-Seite).
 *
 * N  Wiederholung derselben Bindung nach verlorener Antwort → derselbe Auftrag
 * O  Wiederholung mit anderer Entwurfsversion → kein Erfolg, „bereits als
 *    Auftrag angelegt", nichts übernommen
 * P  atomarer Verbrauch: nach Erfolg kein Grabstein, kein Löschauftrag
 * Q  genau ein Auftrag, R genau eine Nummer — auch wenn der Auftrag hier schon
 *    existiert (kein zweiter Aufruf)
 * Notausschalter: ohne Entwurfs-Sync geht der Aufruf exakt wie vor S6 hinaus —
 * der Server nimmt ihn unverändert an (die Bindungsparameter haben den Default
 * null).
 *
 * Der Server ist ein Mock mit dem Vertrag aus 20261103120000; den echten
 * Vertrag prüfen `supabase/tests/order_drafts_s6.sql` und
 * `supabase/tests/order_drafts_parallel_s6.sql`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { getSyncOutboxSnapshot, hydrateSyncOutbox } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import * as syncUi from '../sync/syncUiService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../workspace/workspaceStore';
import { getAllVorgaenge, getVorgangById, hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import { createTestVorgang } from '../../test/fixtures';
import { calculateLineItemTotals } from '../invoiceService';
import { seedSyncChangeTrackerFromCurrentStores } from '../persistenceService';
import type { WorkspaceVorgangRow } from '../vorgang/vorgangCloudService';
import { disableOrderDraftCloudSyncForTests, enableOrderDraftCloudSyncForTests } from '../../test/orderDraftCloudSwitch';
import type { OrderDraft } from '../../types/orderDraft';
import {
  createOrderDraft,
  getOrderDraftById,
  getOrderDraftStoreSnapshot,
  hydrateOrderDrafts,
  resetOrderDrafts,
  updateOrderDraft,
} from './orderDraftService';
import { createOrderFromDraftWithCloud } from './createOrderCloudService';

const WORKSPACE = '6e49b0a1-dbee-4649-aa4e-68064d52c8f6';
const NOW = '2026-10-07T10:00:00.000Z';

type ServerDraft = { status: 'active' | 'consumed'; deleted: boolean; rowVersion: number };

/** Der Server mit dem S6-Vertrag: Bindung, Verbrauch, ehrlicher Replay, Nummernkreis. */
function mockServer() {
  const rows = new Map<string, WorkspaceVorgangRow>();
  const drafts = new Map<string, ServerDraft>();
  const calls: Array<Record<string, unknown>> = [];
  let seq = 0;
  let verloreneAntworten = 0;

  registerMockRpcHandler('create_workspace_order', (args) => {
    calls.push(args);
    const vid = String(args.p_vorgang_id);
    const gebunden = Object.prototype.hasOwnProperty.call(args, 'p_client_draft_id');
    const erwartet = Number(args.p_expected_draft_row_version);
    const draft = drafts.get(vid);
    if (gebunden) {
      if (!draft) throw new Error('order_draft_not_found');
      if (draft.deleted) throw new Error('order_draft_discarded');
      if (draft.status === 'consumed') {
        if (draft.rowVersion !== erwartet + 1) throw new Error('order_draft_already_consumed');
      } else if (draft.rowVersion !== erwartet) {
        throw new Error(`order_draft_version_conflict:${draft.rowVersion}`);
      }
    }
    const existing = rows.get(vid);
    if (existing) {
      if (gebunden && draft?.status !== 'consumed') throw new Error('order_draft_already_consumed');
      return { vorgang: existing, replayed: true };
    }
    const order = args.p_order as Record<string, unknown>;
    const positions = (order.positions as Array<Record<string, unknown>>).map((p) => ({ ...p, billable: true }));
    const totals = calculateLineItemTotals(
      positions.map((p) => ({ quantity: Number(p.plannedQuantity), unitPrice: Number(p.unitPrice) })),
      order.taxStatus as never,
    );
    seq += 1;
    const customer = (order.customerBilling as Record<string, unknown>).name;
    const row: WorkspaceVorgangRow = {
      workspace_id: WORKSPACE,
      vorgang_id: vid,
      payload: {
        id: vid,
        title: order.title,
        customer,
        baustelle: order.baustelle ?? '',
        status: 'beauftragt',
        materialSource: 'unclear',
        customerBilling: order.customerBilling,
        customerId: order.customerId,
        orderPositions: positions,
        contractConfirmation: {
          id: `conf-${vid}`,
          confirmedAt: NOW,
          customer,
          auftraggeber: customer,
          baustelle: order.baustelle ?? '',
          title: order.title,
          positions,
          negotiation: { conducted: false, notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
          immutable: true,
        },
        orderNumber: `AU-2026-${String(seq).padStart(4, '0')}`,
        orderDate: '2026-10-07',
        taxStatus: order.taxStatus,
        paymentTermsText: order.paymentTermsText,
        contractTotals: { subtotal: totals.subtotal, taxRate: totals.taxRate, tax: totals.tax, total: totals.total },
      },
      row_version: 1,
      deleted: false,
      deleted_at: null,
      updated_at: NOW,
      updated_by: 'user-1',
    };
    rows.set(vid, row);
    if (gebunden && draft) drafts.set(vid, { ...draft, status: 'consumed', rowVersion: draft.rowVersion + 1 });
    if (verloreneAntworten > 0) {
      verloreneAntworten -= 1;
      // Festgeschrieben, aber die Antwort erreicht das Gerät nie.
      throw new Error('Failed to fetch');
    }
    return { vorgang: row, replayed: false };
  });
  return {
    rows,
    drafts,
    calls,
    seq: () => seq,
    verliereNaechsteAntwort: () => {
      verloreneAntworten += 1;
    },
  };
}

function entwurf(): OrderDraft {
  const r = createOrderDraft(WORKSPACE, {
    customerId: undefined,
    customerBilling: { name: 'Muster Bau GmbH', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    title: 'S6 Heizung',
    baustelle: 'Weg 1',
    positions: [{ id: 'p1', description: 'Montage', plannedQuantity: 3, unit: 'Stunden', unitPrice: 90 }],
    taxStatus: 'standard_19',
    paymentTermsText: '14 Tage',
  });
  if (!r.success) throw new Error(r.errorKey);
  return r.draft;
}

/** Ein Entwurf, den die Cloud in Version `version` kennt — ohne offene Übertragung. */
function abgeglichen(version = 1): OrderDraft {
  const draft = entwurf();
  hydrateOrderDrafts([{ ...draft, sync: { updatedAt: NOW, version, deleted: false, deviceId: 'device-test', workspaceId: WORKSPACE } }]);
  hydrateSyncOutbox([]);
  seedSyncChangeTrackerFromCurrentStores();
  return getOrderDraftById(draft.id)!;
}

function offeneEntwurfsauftraege() {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'order_draft' && entry.status !== 'completed');
}

beforeEach(() => {
  localStorage.clear();
  resetOrderDrafts();
  resetVorgaenge();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  clearMockRpcHandlers();
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-10-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({ ...createCompanyProfileFromSetup(DEFAULT_SETUP), companyName: 'Beispiel GmbH' });
});

afterEach(() => {
  clearMockRpcHandlers();
  vi.restoreAllMocks();
});

describe('S6 Notausschalter — ohne Entwurfs-Sync exakt der bisherige Aufruf', () => {
  it('keine Bindungsangaben, Anlage wie bisher, Entwurf danach weg', async () => {
    disableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const draft = entwurf();
    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(Object.keys(server.calls[0]!).sort()).toEqual(['p_order', 'p_vorgang_id', 'p_workspace_id']);
    expect(getOrderDraftById(draft.id)).toBeNull();
    expect(getOrderDraftStoreSnapshot()).toHaveLength(0);
  });
});

describe('S6-P — Anlage mit Bindung, atomarer Verbrauch', () => {
  it('P1 — Kennung und erwartete Version gehen mit; danach kein Grabstein und kein Löschauftrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const draft = abgeglichen(1);
    server.drafts.set(draft.id, { status: 'active', deleted: false, rowVersion: 1 });

    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);
    expect(server.calls[0]).toMatchObject({ p_vorgang_id: draft.id, p_client_draft_id: draft.id, p_expected_draft_row_version: 1 });
    expect(getVorgangById(draft.id)?.orderNumber).toBe('AU-2026-0001');
    expect(server.drafts.get(draft.id)).toEqual({ status: 'consumed', deleted: false, rowVersion: 2 });
    // Verbraucht: kein Entwurf, kein Grabstein, kein Löschauftrag.
    expect(getOrderDraftStoreSnapshot()).toHaveLength(0);
    expect(offeneEntwurfsauftraege()).toHaveLength(0);
  });

  it('nicht vollständig angekommen: ein Sync-Lauf, dann ehrlich „noch nicht übertragen" — kein Aufruf', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const sync = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue({} as never);
    const draft = entwurf();
    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r).toEqual({ ok: false, reason: 'draft_not_synced' });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(0);
    expect(getOrderDraftById(draft.id)?.id).toBe(draft.id);
  });
});

describe('S6-N/O — Wiederholung: Erfolg nur für genau diese Entwurfsversion', () => {
  it('N1 — Antwort nach dem Festschreiben verloren: die Wiederholung mit derselben Bindung liefert denselben Auftrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const draft = abgeglichen(1);
    server.drafts.set(draft.id, { status: 'active', deleted: false, rowVersion: 1 });
    server.verliereNaechsteAntwort();

    const erster = await createOrderFromDraftWithCloud(draft.id);
    expect(erster).toMatchObject({ ok: false, reason: 'network' });
    expect(getOrderDraftById(draft.id)?.sync?.version).toBe(1);

    const zweiter = await createOrderFromDraftWithCloud(draft.id);
    expect(zweiter.ok, JSON.stringify(zweiter)).toBe(true);
    if (!zweiter.ok) return;
    expect(zweiter.replayed).toBe(true);
    expect(server.calls.map((call) => call.p_expected_draft_row_version)).toEqual([1, 1]);
    expect(server.seq(), 'genau eine Nummer').toBe(1);
    expect(getAllVorgaenge().filter((vorgang) => vorgang.id === draft.id), 'genau ein Auftrag').toHaveLength(1);
  });

  it('O1 — der Auftrag entstand aus einer anderen Fassung: kein Erfolg, nichts übernommen, Entwurf bleibt', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const sync = vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue({} as never);
    const draft = abgeglichen(1);
    // Ein anderes Gerät hat Version 2 bearbeitet und daraus den Auftrag angelegt (verbraucht → Version 3).
    server.drafts.set(draft.id, { status: 'consumed', deleted: false, rowVersion: 3 });
    server.rows.set(draft.id, { workspace_id: WORKSPACE, vorgang_id: draft.id, payload: {}, row_version: 1, deleted: false } as never);

    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r).toEqual({ ok: false, reason: 'already_created', vorgangId: draft.id });
    expect(getVorgangById(draft.id), 'keine Übernahme des fremden Auftrags als eigener Erfolg').toBeUndefined();
    expect(getOrderDraftById(draft.id)?.title).toBe('S6 Heizung');
    expect(sync).toHaveBeenCalled();
  });

  it('O1b — bereits verbraucht: ein Abgleich holt den Auftrag; der Befund nennt seine Nummer, kein Erfolg', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const draft = abgeglichen(1);
    server.drafts.set(draft.id, { status: 'consumed', deleted: false, rowVersion: 3 });
    server.rows.set(draft.id, { workspace_id: WORKSPACE, vorgang_id: draft.id, payload: {}, row_version: 1, deleted: false } as never);
    const sync = vi.spyOn(syncUi, 'runSyncFromUi').mockImplementation(async () => {
      // Wie der Abzug: Der Auftrag des anderen Geräts kommt an.
      hydrateVorgangStore([createTestVorgang({ id: draft.id, status: 'beauftragt', orderNumber: 'AU-2026-0009' })]);
      return {} as never;
    });
    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r).toEqual({ ok: false, reason: 'already_created', vorgangId: draft.id, orderNumber: 'AU-2026-0009' });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(1);
    expect(server.seq()).toBe(0);
  });

  it('O2 — die Cloud trägt eine neuere Entwurfsfassung: Konflikt, keine Anlage, keine Nummer', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue({} as never);
    const draft = abgeglichen(1);
    server.drafts.set(draft.id, { status: 'active', deleted: false, rowVersion: 2 });
    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r).toEqual({ ok: false, reason: 'draft_conflict' });
    expect(server.seq()).toBe(0);
    expect(server.rows.size).toBe(0);
  });

  it('O3 — anderswo verworfen: kein Auftrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    vi.spyOn(syncUi, 'runSyncFromUi').mockResolvedValue({} as never);
    const draft = abgeglichen(1);
    server.drafts.set(draft.id, { status: 'active', deleted: true, rowVersion: 2 });
    expect(await createOrderFromDraftWithCloud(draft.id)).toEqual({ ok: false, reason: 'draft_ended' });
    expect(server.seq()).toBe(0);
  });
});

describe('S6-Q/R — genau ein Auftrag, genau eine Nummer', () => {
  it('der Auftrag ist hier schon da: kein zweiter Aufruf, kein Erfolg mit womöglich anderem Inhalt', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const draft = abgeglichen(1);
    server.drafts.set(draft.id, { status: 'active', deleted: false, rowVersion: 1 });
    const erster = await createOrderFromDraftWithCloud(draft.id);
    expect(erster.ok).toBe(true);
    // Ein zweiter Tab mit demselben, noch offenen Entwurf.
    hydrateOrderDrafts([{ ...draft }]);
    const zweiter = await createOrderFromDraftWithCloud(draft.id);
    expect(zweiter).toEqual({ ok: false, reason: 'already_created', vorgangId: draft.id, orderNumber: 'AU-2026-0001' });
    expect(server.calls).toHaveLength(1);
    expect(server.seq()).toBe(1);
  });

  it('veraltetes Gerät mit eigener Änderung: der Sync-Lauf zeigt den anderswo angelegten Auftrag — „bereits angelegt", nie „verworfen", kein Aufruf', async () => {
    enableOrderDraftCloudSyncForTests();
    const server = mockServer();
    const draft = abgeglichen(1);
    expect(updateOrderDraft(draft.id, { title: 'Hier geändert' }).success).toBe(true);
    const sync = vi.spyOn(syncUi, 'runSyncFromUi').mockImplementation(async () => {
      // Wie der Abzug: Der Auftrag ist da; der lokal geänderte Entwurf steht als „verbraucht" mit Abweichung.
      hydrateVorgangStore([createTestVorgang({ id: draft.id, status: 'beauftragt', orderNumber: 'AU-2026-0007' })]);
      hydrateOrderDrafts(
        getOrderDraftStoreSnapshot().map((d) =>
          d.id === draft.id
            ? { ...d, conflict: { kind: 'consumed', detectedAt: NOW, remote: { rowVersion: 2, status: 'consumed', deleted: false, payload: null, consumedRef: draft.id } } }
            : d,
        ),
      );
      return {} as never;
    });
    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: false, reason: 'already_created', vorgangId: draft.id, orderNumber: 'AU-2026-0007' });
    expect(server.calls).toHaveLength(0);
  });
});
