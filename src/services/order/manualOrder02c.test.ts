/**
 * AUFTRAG-02C — gezielte Prüfungen der manuellen Auftragsanlage.
 *
 * A  Entwurf: anlegen, lokal persistiert, wieder aufnehmen, Blocker, kein Vorgang.
 * B  Verbindliche Anlage über die (gemockte) Server-RPC: AU-Nummer, Status,
 *    eingefrorener Snapshot, Entwurf erst danach weg, nichts erneut eingereiht.
 * C  Crash/Retry: Netzwerkfehler behält den Entwurf; verlorene Antwort führt zum
 *    Replay; ein bereits vorhandener Serverauftrag gewinnt über den veränderten Entwurf.
 * D  Rechnungsentwürfe: §13b aus dem manuellen Auftrag für rechnung/abschlag/schluss,
 *    Bestandsvorgang ohne Steuerstatus behält den Firmenstandard.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Vorgang } from '../../types/models';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { getSyncOutboxSnapshot, hydrateSyncOutbox } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../workspace/workspaceStore';
import { getVorgangById, hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import { buildInvoiceDraftForType, calculateLineItemTotals } from '../invoiceService';
import { isContractPlanLocked } from '../orderPlanIntegrityService';
import { buildPersistedStateSnapshot, loadPersistedState } from '../persistenceService';
import { createVorgangFromCloudRow, type WorkspaceVorgangRow } from '../vorgang/vorgangCloudService';
import {
  createOrderDraft,
  getOrderDraftBlockers,
  getOrderDraftById,
  hydrateOrderDrafts,
  listOrderDrafts,
  resetOrderDrafts,
  updateOrderDraft,
} from './orderDraftService';
import { createOrderFromDraftWithCloud } from './createOrderCloudService';

const WORKSPACE = '2e49b0a1-dbee-4649-aa4e-68064d52c8f5';
const NOW = '2026-09-22T10:00:00.000Z';
const ZAHLUNG = 'Zahlbar innerhalb von 7 Tagen ohne Abzug.';

const KUNDE = {
  name: 'Muster Baustoffe GmbH',
  contactPerson: 'Frau Muster',
  street: 'Musterweg 1',
  zip: '33602',
  city: 'Bielefeld',
  email: 'kunde@example.invalid',
  phone: '',
};

function entwurf(overrides: Partial<Parameters<typeof createOrderDraft>[1]> = {}) {
  const r = createOrderDraft(WORKSPACE, {
    customerId: 'cust-1',
    customerBilling: KUNDE,
    title: 'Heizung Erdgeschoss',
    baustelle: 'Musterweg 1, Bielefeld',
    positions: [
      { id: 'p1', description: 'Demontage', plannedQuantity: 4, unit: 'Stunden', unitPrice: 55 },
      { id: 'p2', description: 'Fliesen', plannedQuantity: 12.5, unit: 'm²', unitPrice: 48.9 },
    ],
    taxStatus: 'reverse_charge_13b',
    paymentTermsText: ZAHLUNG,
    ...overrides,
  });
  if (!r.success) throw new Error(r.errorKey);
  return r.draft;
}

/** Der Server, wie ihn die Migration 20260930 definiert — als Mock mit Jahressequenz. */
function mockServer() {
  const rows = new Map<string, WorkspaceVorgangRow>();
  let seq = 0;
  let calls = 0;

  const create = (args: Record<string, unknown>) => {
    calls += 1;
    const vid = String(args.p_vorgang_id);
    const existing = rows.get(vid);
    if (existing) return { vorgang: existing, replayed: true };
    const order = args.p_order as Record<string, unknown>;
    const positions = (order.positions as Array<Record<string, unknown>>).map((p) => ({
      id: p.id,
      description: p.description,
      plannedQuantity: p.plannedQuantity,
      unit: p.unit,
      unitPrice: p.unitPrice,
      billable: true,
    }));
    const totals = calculateLineItemTotals(
      positions.map((p) => ({ quantity: Number(p.plannedQuantity), unitPrice: Number(p.unitPrice) })),
      order.taxStatus as never,
    );
    seq += 1;
    const number = `AU-2026-${String(seq).padStart(4, '0')}`;
    const payload: Record<string, unknown> = {
      id: vid,
      title: order.title,
      customer: (order.customerBilling as Record<string, unknown>).name,
      baustelle: order.baustelle ?? '',
      status: 'beauftragt',
      materialSource: 'unclear',
      customerBilling: order.customerBilling,
      customerId: order.customerId,
      orderPositions: positions,
      contractConfirmation: {
        id: `conf-${vid}`,
        confirmedAt: NOW,
        customer: (order.customerBilling as Record<string, unknown>).name,
        auftraggeber: (order.customerBilling as Record<string, unknown>).name,
        baustelle: order.baustelle ?? '',
        title: order.title,
        positions,
        negotiation: { conducted: false, notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
        immutable: true,
      },
      orderNumber: number,
      orderDate: '2026-09-22',
      taxStatus: order.taxStatus,
      paymentTermsText: order.paymentTermsText,
      introText: order.introText,
      closingText: order.closingText,
      contractTotals: { subtotal: totals.subtotal, taxRate: totals.taxRate, tax: totals.tax, total: totals.total },
    };
    const row: WorkspaceVorgangRow = {
      workspace_id: WORKSPACE,
      vorgang_id: vid,
      payload,
      row_version: 1,
      deleted: false,
      deleted_at: null,
      updated_at: NOW,
      updated_by: 'user-1',
    };
    rows.set(vid, row);
    return { vorgang: row, replayed: false };
  };
  registerMockRpcHandler('create_workspace_order', create);
  return { rows, create, calls: () => calls, seq: () => seq };
}

beforeEach(() => {
  localStorage.clear();
  resetOrderDrafts();
  resetVorgaenge();
  resetCompanyProfile();
  resetSyncChangeTrackerForTests();
  hydrateSyncOutbox([]);
  clearMockRpcHandlers();
  resetWorkspaceStore();
  hydrateWorkspaceStore({ workspace: { id: WORKSPACE, name: 'Test', ownerUserId: 'user-1' } as never });
  resetSyncClientForTests({
    deviceId: 'device-test',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
    createdAt: '2026-09-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
  });
});

afterEach(() => {
  clearMockRpcHandlers();
});

describe('A — lokaler Entwurf', () => {
  it('Entwurf entsteht lokal, erzeugt keinen Vorgang und trägt seine spätere Vorgangskennung', () => {
    const draft = entwurf();
    expect(draft.id.startsWith('v-')).toBe(true);
    expect(getVorgangById(draft.id)).toBeUndefined();
    expect(listOrderDrafts().map((d) => d.id)).toEqual([draft.id]);
    // Kein Cloud-Zustand: nichts eingereiht.
    expect(getSyncOutboxSnapshot().filter((e) => e.status !== 'completed')).toHaveLength(0);
  });

  it('Entwurf überlebt den Neustart der App (Resume) mit stabiler Kennung', () => {
    const draft = entwurf();
    const r = updateOrderDraft(draft.id, { title: 'Heizung erstes Obergeschoss' });
    expect(r.success).toBe(true);

    // Neustart: Speicher leeren, aus dem persistierten Stand hydrieren.
    const persisted = buildPersistedStateSnapshot();
    resetOrderDrafts();
    expect(listOrderDrafts()).toHaveLength(0);
    hydrateOrderDrafts(persisted.orderDrafts ?? []);

    const wieder = getOrderDraftById(draft.id);
    expect(wieder?.id).toBe(draft.id);
    expect(wieder?.title).toBe('Heizung erstes Obergeschoss');
    expect(wieder?.customerBilling.street).toBe('Musterweg 1');
    expect(wieder?.positions).toHaveLength(2);
    expect(wieder?.taxStatus).toBe('reverse_charge_13b');
  });

  it('der persistierte Stand trägt den Entwurf (localStorage, kein Sync)', () => {
    const draft = entwurf();
    const geladen = loadPersistedState();
    expect(geladen?.orderDrafts?.map((d) => d.id)).toEqual([draft.id]);
  });

  it('Blocker benennen fehlende Angaben', () => {
    expect(getOrderDraftBlockers({ customerBilling: { name: '' } as never, title: '', positions: [] })).toEqual([
      'customer_missing',
      'title_missing',
      'positions_missing',
    ]);
    expect(
      getOrderDraftBlockers({
        customerBilling: KUNDE,
        title: 'x',
        positions: [{ id: 'p1', description: '', plannedQuantity: 0, unit: 'Stunden', unitPrice: 5 }],
      }),
    ).toEqual(['position_invalid']);
    expect(getOrderDraftBlockers(entwurf())).toEqual([]);
  });
});

describe('B — verbindliche Anlage', () => {
  it('AU-Nummer, Status, eingefrorener Snapshot; Entwurf erst nach Erfolg weg', async () => {
    const server = mockServer();
    const draft = entwurf();

    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);

    const vorgang = getVorgangById(draft.id);
    expect(vorgang?.orderNumber).toBe('AU-2026-0001');
    expect(vorgang?.status).toBe('beauftragt');
    expect(vorgang?.orderDate).toBe('2026-09-22');
    expect(vorgang?.sourceOfferId).toBeUndefined();
    expect(vorgang?.sourceOfferNumber).toBeUndefined();
    expect(vorgang?.customer).toBe(KUNDE.name);
    expect(vorgang?.customerId).toBe('cust-1');
    expect(vorgang?.customerBilling?.street).toBe('Musterweg 1');
    expect(vorgang?.taxStatus).toBe('reverse_charge_13b');
    expect(vorgang?.paymentTermsText).toBe(ZAHLUNG);
    // 4×55 + 12,5×48,9 = 831,25; §13b ohne Steuer
    expect(vorgang?.contractTotals).toEqual({ subtotal: 831.25, taxRate: 0, tax: 0, total: 831.25 });
    expect(vorgang?.orderPositions.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(vorgang?.contractConfirmation?.immutable).toBe(true);
    expect(vorgang?.contractConfirmation?.negotiation.conducted).toBe(false);
    expect(vorgang && isContractPlanLocked(vorgang)).toBe(true);

    // Der Entwurf ist erledigt, die Serverzeile ist Wahrheit.
    expect(listOrderDrafts()).toHaveLength(0);
    expect(getOrderDraftById(draft.id)).toBeNull();
    expect(getSyncOutboxSnapshot().filter((e) => e.status !== 'completed')).toHaveLength(0);
    expect(server.calls()).toBe(1);
  });

  it('zwei Entwürfe ergeben zwei Aufträge mit eigenen Nummern', async () => {
    mockServer();
    const a = entwurf();
    const b = entwurf({ title: 'Zweiter Auftrag' });
    const ra = await createOrderFromDraftWithCloud(a.id);
    const rb = await createOrderFromDraftWithCloud(b.id);
    expect(ra.ok && ra.vorgang.orderNumber).toBe('AU-2026-0001');
    expect(rb.ok && rb.vorgang.orderNumber).toBe('AU-2026-0002');
  });

  it('ohne Cloud keine Anlage — der Entwurf bleibt', async () => {
    const server = mockServer();
    const draft = entwurf();
    resetSyncClientForTests({
      deviceId: 'device-test',
      workspaceId: WORKSPACE,
      createdAt: '2026-09-01T00:00:00.000Z',
      syncPolicy: 'local_only',
    });
    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cloud_required');
    expect(getOrderDraftById(draft.id)?.id).toBe(draft.id);
    expect(server.calls()).toBe(0);
  });
});

describe('C — Crash, Retry, Recovery', () => {
  it('Netzwerkfehler: Entwurf bleibt, Retry liefert denselben Auftrag ohne zweite Nummer', async () => {
    const server = mockServer();
    const draft = entwurf();
    registerMockRpcHandler('create_workspace_order', () => {
      throw new Error('Failed to fetch');
    });
    const fehl = await createOrderFromDraftWithCloud(draft.id);
    expect(fehl.ok).toBe(false);
    if (!fehl.ok) expect(fehl.reason).toBe('network');
    expect(getOrderDraftById(draft.id)?.id).toBe(draft.id);
    expect(getVorgangById(draft.id)).toBeUndefined();

    registerMockRpcHandler('create_workspace_order', server.create);
    const zweit = await createOrderFromDraftWithCloud(draft.id);
    expect(zweit.ok && zweit.vorgang.orderNumber).toBe('AU-2026-0001');
    expect(server.seq()).toBe(1);
  });

  it('verlorene Antwort: der Server hat den Auftrag, der Retry bekommt denselben zurück', async () => {
    const server = mockServer();
    const draft = entwurf();
    // Erste Anlage gelingt serverseitig, die Antwort erreicht den Client nie.
    server.create({ p_workspace_id: WORKSPACE, p_vorgang_id: draft.id, p_order: { customerBilling: KUNDE, title: draft.title, taxStatus: draft.taxStatus, positions: draft.positions } });
    expect(getVorgangById(draft.id)).toBeUndefined();
    expect(getOrderDraftById(draft.id)?.id).toBe(draft.id);

    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(true);
    expect(r.vorgang.orderNumber).toBe('AU-2026-0001');
    expect(server.seq()).toBe(1);
    expect(listOrderDrafts()).toHaveLength(0);
  });

  it('nach dem Crash veränderter Entwurf überschreibt den bestätigten Auftrag nicht', async () => {
    const server = mockServer();
    const draft = entwurf();
    server.create({ p_workspace_id: WORKSPACE, p_vorgang_id: draft.id, p_order: { customerBilling: KUNDE, title: draft.title, taxStatus: draft.taxStatus, paymentTermsText: ZAHLUNG, positions: draft.positions } });
    // Der Nutzer tippt am Entwurf weiter, ohne zu wissen, dass der Auftrag existiert.
    updateOrderDraft(draft.id, { title: 'Nachträglich geändert', taxStatus: 'standard_19' });

    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok && r.replayed).toBe(true);
    const vorgang = getVorgangById(draft.id);
    expect(vorgang?.title).toBe('Heizung Erdgeschoss');
    expect(vorgang?.taxStatus).toBe('reverse_charge_13b');
    expect(vorgang?.sync?.version).toBe(1);
    expect(listOrderDrafts()).toHaveLength(0);
  });

  it('Auftrag kam über den Pull: der Entwurf gilt als erledigt und wird nicht mehr angeboten', async () => {
    const server = mockServer();
    const draft = entwurf();
    const antwort = server.create({ p_workspace_id: WORKSPACE, p_vorgang_id: draft.id, p_order: { customerBilling: KUNDE, title: draft.title, taxStatus: draft.taxStatus, positions: draft.positions } });
    // Der Auftrag erreicht dieses Gerät über den normalen Pull.
    hydrateVorgangStore([
      createVorgangFromCloudRow(antwort.vorgang!.payload as never, 1, NOW, false, 'device-test', WORKSPACE),
    ]);
    expect(listOrderDrafts()).toHaveLength(0);
    expect(getOrderDraftById(draft.id)).toBeNull();

    const r = await createOrderFromDraftWithCloud(draft.id);
    expect(r.ok && r.replayed && r.vorgang.orderNumber).toBe('AU-2026-0001');
    expect(server.calls()).toBe(1); // der lokale Auftrag genügt — kein zweiter Serveraufruf
  });
});

describe('D — Rechnungsentwürfe aus dem manuellen Auftrag', () => {
  it('§13b und Zahlungsbedingung für Rechnung, Abschlag und Schlussrechnung; Legacy bleibt Firmenstandard', async () => {
    mockServer();
    const draft = entwurf();
    const r = await createOrderFromDraftWithCloud(draft.id);
    if (!r.ok) throw new Error(JSON.stringify(r));

    for (const type of ['rechnung', 'abschlag', 'schluss'] as const) {
      const invoice = buildInvoiceDraftForType(r.vorgang.id, DEFAULT_SETUP, type);
      expect(invoice, type).not.toBeNull();
      expect(invoice?.taxStatus, type).toBe('reverse_charge_13b');
      expect(invoice?.paymentTermsText, type).toBe(ZAHLUNG);
      expect(invoice?.customerBilling?.street, type).toBe('Musterweg 1');
      if (invoice) expect(calculateLineItemTotals(invoice.positions, invoice.taxStatus!).tax, type).toBe(0);
    }

    const legacy: Vorgang = {
      ...r.vorgang,
      id: 'v-legacy',
      orderNumber: undefined,
      orderDate: undefined,
      taxStatus: undefined,
      paymentTermsText: undefined,
      contractTotals: undefined,
    };
    hydrateVorgangStore([r.vorgang, legacy]);
    const ref = buildInvoiceDraftForType('v-legacy', DEFAULT_SETUP, 'rechnung');
    expect(ref?.taxStatus).toBe('standard_19');
    expect(ref?.paymentTermsText).not.toBe(ZAHLUNG);
  });
});
