/**
 * ANGEBOT->AUFTRAG-02B — gezielte Prüfungen der Annahme.
 *
 * A  Annahme über die (gemockte) Server-RPC: Auftrag mit AU-Nummer, Status
 *    `beauftragt`, eingefrorener Snapshot aus den Angebotspositionen,
 *    Angebot `angenommen` mit Rückverweis; nichts wird erneut eingereiht.
 * B  Wiederholung: zweiter Aufruf liefert denselben Auftrag, keine zweite Nummer.
 * C  Verlorene Antwort: Der Server hat angenommen, der Client nicht — der Pull
 *    übernimmt Angebot und Auftrag, der Server gewinnt.
 * D  Rechnungsentwürfe: Steuerstatus und Zahlungsbedingung kommen aus dem
 *    Auftrag (§13b), Vorgänge ohne Auftragsfelder behalten den Firmenstandard.
 * E  Nicht annehmbar: Entwurf, ohne Cloud, Serverablehnung.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Offer } from '../../types/offer';
import type { Vorgang } from '../../types/models';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetSyncClientForTests } from '../sync/syncClientService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, hydrateSyncOutbox } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { hydrateWorkspaceStore, resetWorkspaceStore } from '../workspace/workspaceStore';
import { addOfferDraft, getOfferById, markOfferSent, resetOffers, setOfferStoreForTests } from './offerService';
import { finalizeOfferWithCloud } from './offerFinalizeCloudService';
import type { WorkspaceOfferRow } from './offerCloudService';
import { stripVorgangForCloud, type WorkspaceVorgangRow } from '../vorgang/vorgangCloudService';
import { acceptOfferWithCloud } from './offerAcceptCloudService';
import { getVorgangById, hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import { buildInvoiceDraftForType, calculateInvoiceTotals } from '../invoiceService';
import { isContractPlanLocked } from '../orderPlanIntegrityService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { buildPersistedStateSnapshot } from '../persistenceService';

const WORKSPACE = '2e49b0a1-dbee-4649-aa4e-68064d52c8f5';
const NOW = '2026-09-21T10:00:00.000Z';
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

function entwurf(overrides: Partial<Parameters<typeof addOfferDraft>[1]> = {}): Offer {
  const r = addOfferDraft(WORKSPACE, {
    customerId: 'cust-1',
    customer: KUNDE,
    title: 'Badsanierung EG',
    baustelle: 'Musterweg 1, Bielefeld',
    positions: [
      { id: 'p1', description: 'Demontage', quantity: 4, unit: 'Stunden', unitPrice: 55 },
      { id: 'p2', description: 'Fliesen', quantity: 12.5, unit: 'm²', unitPrice: 48.9 },
      { id: 'p3', description: 'Nicht bestellt', quantity: 0, unit: 'Pauschal', unitPrice: 99 },
    ],
    taxStatus: 'reverse_charge_13b',
    offerDate: '2026-09-21',
    validUntil: '2026-10-21',
    introText: 'Vielen Dank für Ihre Anfrage.',
    closingText: 'Wir freuen uns auf Ihren Auftrag.',
    paymentTermsText: ZAHLUNG,
    ...overrides,
  });
  if (!r.success) throw new Error(r.errorKey);
  return r.offer;
}

/**
 * Der Server, wie ihn die Migration 20260929 definiert — als Mock mit
 * Angebots- und Vorgangszeilen und einer Jahressequenz.
 */
function mockServer() {
  const offers = new Map<string, WorkspaceOfferRow>();
  const vorgaenge = new Map<string, WorkspaceVorgangRow>();
  let offerSeq = 0;
  let orderSeq = 0;
  let acceptCalls = 0;

  registerMockRpcHandler('finalize_workspace_offer', (args) => {
    const id = String(args.p_offer_id);
    offerSeq += 1;
    const number = `AN-2026-${String(offerSeq).padStart(4, '0')}`;
    const payload = {
      ...(args.p_payload as Record<string, unknown>),
      status: 'freigegeben',
      offerNumber: number,
      offerSequenceNumber: offerSeq,
      contentFingerprint: args.p_fingerprint,
      finalizedAt: NOW,
    };
    const row: WorkspaceOfferRow = {
      workspace_id: WORKSPACE,
      client_offer_id: id,
      client_customer_id: 'cust-1',
      offer_number: number,
      offer_sequence_number: offerSeq,
      status: 'freigegeben',
      payload,
      row_version: 2,
      deleted: false,
      deleted_at: null,
      updated_at: NOW,
    };
    offers.set(id, row);
    return { row, row_version: row.row_version, replayed: false };
  });

  const accept = (args: Record<string, unknown>) => {
    acceptCalls += 1;
    const id = String(args.p_offer_id);
    const vid = String(args.p_vorgang_id);
    const offer = offers.get(id);
    if (!offer) throw new Error('Angebot nicht gefunden');
    if (offer.status === 'angenommen') {
      const existing = vorgaenge.get(String(offer.payload.resultingVorgangId));
      return { offer, vorgang: existing, replayed: true };
    }
    if (offer.status !== 'freigegeben' && offer.status !== 'versendet') {
      throw new Error(`Angebot kann im Zustand ${offer.status} nicht angenommen werden`);
    }
    if (vorgaenge.has(vid)) throw new Error('Vorgangskennung bereits vergeben');
    const pl = offer.payload as Record<string, unknown> & { positions: Array<Record<string, unknown>>; customer: typeof KUNDE };
    orderSeq += 1;
    const number = `AU-2026-${String(orderSeq).padStart(4, '0')}`;
    const positions = pl.positions
      .filter((p) => typeof p.quantity === 'number' && (p.quantity as number) > 0)
      .map((p) => ({
        id: p.id,
        description: p.description,
        plannedQuantity: p.quantity,
        unit: p.unit,
        unitPrice: p.unitPrice,
        billable: true,
      }));
    const vorgangPayload: Record<string, unknown> = {
      id: vid,
      title: pl.title,
      customer: pl.customer.name,
      baustelle: pl.baustelle ?? '',
      status: 'beauftragt',
      materialSource: 'unclear',
      customerBilling: pl.customer,
      customerId: pl.customerId,
      orderPositions: positions,
      contractConfirmation: {
        id: `conf-${vid}`,
        confirmedAt: NOW,
        customer: pl.customer.name,
        auftraggeber: pl.customer.name,
        baustelle: pl.baustelle ?? '',
        title: pl.title,
        positions,
        negotiation: { conducted: false, notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
        immutable: true,
      },
      sourceOfferId: id,
      sourceOfferNumber: offer.offer_number,
      orderNumber: number,
      orderDate: '2026-09-21',
      taxStatus: pl.taxStatus,
      paymentTermsText: pl.paymentTermsText,
      introText: pl.introText,
      closingText: pl.closingText,
      contractTotals: pl.totals,
    };
    const vorgangRow: WorkspaceVorgangRow = {
      workspace_id: WORKSPACE,
      vorgang_id: vid,
      payload: vorgangPayload,
      row_version: 1,
      deleted: false,
      deleted_at: null,
      updated_at: NOW,
      updated_by: 'user-1',
    };
    vorgaenge.set(vid, vorgangRow);
    const nextOffer: WorkspaceOfferRow = {
      ...offer,
      status: 'angenommen',
      payload: { ...offer.payload, status: 'angenommen', resultingVorgangId: vid, decidedAt: NOW },
      row_version: offer.row_version + 1,
    };
    offers.set(id, nextOffer);
    return { offer: nextOffer, vorgang: vorgangRow, replayed: false };
  };
  registerMockRpcHandler('accept_workspace_offer', accept);
  return { offers, vorgaenge, accept, acceptCalls: () => acceptCalls, orderSeq: () => orderSeq };
}

async function freigegebenesAngebot(overrides: Parameters<typeof entwurf>[0] = {}): Promise<Offer> {
  const offer = entwurf(overrides);
  const r = await finalizeOfferWithCloud(offer.id);
  if (!r.ok) throw new Error(JSON.stringify(r));
  const nach = getOfferById(offer.id);
  if (!nach) throw new Error('Angebot fehlt');
  // Die Freigabe ist Serverwahrheit; ein offener Sendeauftrag wäre hier nur Testrauschen.
  hydrateSyncOutbox([]);
  return nach;
}

function pullMit(server: ReturnType<typeof mockServer>) {
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
    vorgaenge: [...server.vorgaenge.values()],
    customers: [],
    offers: [...server.offers.values()],
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

beforeEach(() => {
  localStorage.clear();
  resetOffers();
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

describe('A — Annahme über den Server', () => {
  it('Auftrag mit AU-Nummer, eingefrorenem Snapshot und Rückverweis; nichts erneut eingereiht', async () => {
    const server = mockServer();
    const offer = await freigegebenesAngebot();

    const r = await acceptOfferWithCloud(offer.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);

    // Auftrag
    const vorgang = getVorgangById(r.vorgang.id);
    expect(vorgang).toBeDefined();
    expect(vorgang?.orderNumber).toBe('AU-2026-0001');
    expect(vorgang?.status).toBe('beauftragt');
    expect(vorgang?.sourceOfferId).toBe(offer.id);
    expect(vorgang?.sourceOfferNumber).toBe('AN-2026-0001');
    expect(vorgang?.orderDate).toBe('2026-09-21');
    expect(vorgang?.customer).toBe(KUNDE.name);
    expect(vorgang?.customerId).toBe('cust-1');
    expect(vorgang?.customerBilling?.name).toBe(KUNDE.name);
    expect(vorgang?.taxStatus).toBe('reverse_charge_13b');
    expect(vorgang?.paymentTermsText).toBe(ZAHLUNG);
    expect(vorgang?.contractTotals?.total).toBe(offer.totals?.total);
    expect(vorgang?.sync?.version).toBe(1);

    // Positionen: nur Mengen > 0, Plan = angebotene Menge, Preis übernommen
    expect(vorgang?.orderPositions.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(vorgang?.orderPositions[1]?.plannedQuantity).toBe(12.5);
    expect(vorgang?.orderPositions[1]?.unitPrice).toBe(48.9);

    // Snapshot: dieselbe Struktur wie beim Werkvertrag, ohne Verhandlung, unveränderlich, gesperrt
    const conf = vorgang?.contractConfirmation;
    expect(conf?.immutable).toBe(true);
    expect(conf?.negotiation.conducted).toBe(false);
    expect(conf?.positions).toHaveLength(2);
    expect(conf?.customer).toBe(KUNDE.name);
    expect(vorgang && isContractPlanLocked(vorgang)).toBe(true);

    // Angebot
    const nach = getOfferById(offer.id);
    expect(nach?.status).toBe('angenommen');
    expect(nach?.resultingVorgangId).toBe(r.vorgang.id);
    expect(nach?.offerNumber).toBe('AN-2026-0001');
    expect(nach?.sync?.version).toBe(3);

    // Beide Zeilen sind Serverwahrheit: kein Sendeauftrag steht an
    expect(getSyncOutboxSnapshot().filter((e) => e.status !== 'completed')).toHaveLength(0);
    expect(server.acceptCalls()).toBe(1);
  });

  it('Rücklauf: der Client pusht Snapshot, Plan und Auftragsfakten byte-gleich zur Serverzeile (Server-Guards greifen nicht)', async () => {
    const server = mockServer();
    const offer = await freigegebenesAngebot();
    const r = await acceptOfferWithCloud(offer.id);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const serverRow = server.vorgaenge.get(r.vorgang.id);
    if (!serverRow) throw new Error('Serverzeile fehlt');
    // Was der Client beim nächsten Push (z. B. Statuswechsel) senden würde …
    const push = JSON.parse(JSON.stringify(stripVorgangForCloud(getVorgangById(r.vorgang.id)!))) as Record<string, unknown>;
    // … entspricht in allen serverseitig festgeschriebenen Feldern exakt der Serverzeile.
    for (const key of ['contractConfirmation', 'orderPositions', 'customerBilling', 'customerId', 'taxStatus', 'paymentTermsText', 'introText', 'closingText', 'contractTotals', 'sourceOfferId', 'sourceOfferNumber', 'orderNumber', 'orderDate'] as const) {
      expect(push[key], key).toEqual(serverRow.payload[key]);
    }
  });

  it('zwei Angebote: die Server-Sequenz zählt weiter, zwei getrennte Aufträge', async () => {
    mockServer();
    const a = await freigegebenesAngebot();
    const b = await freigegebenesAngebot({ title: 'Zweites' });
    const ra = await acceptOfferWithCloud(a.id);
    const rb = await acceptOfferWithCloud(b.id);
    expect(ra.ok && ra.vorgang.orderNumber).toBe('AU-2026-0001');
    expect(rb.ok && rb.vorgang.orderNumber).toBe('AU-2026-0002');
    expect(ra.ok && rb.ok && ra.vorgang.id !== rb.vorgang.id).toBe(true);
  });
});

describe('B — Wiederholung', () => {
  it('zweite Annahme liefert denselben Auftrag; keine zweite Nummer', async () => {
    const server = mockServer();
    const offer = await freigegebenesAngebot();
    const r1 = await acceptOfferWithCloud(offer.id);
    const r2 = await acceptOfferWithCloud(offer.id);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.replayed).toBe(true);
    expect(r2.vorgang.id).toBe(r1.vorgang.id);
    expect(server.orderSeq()).toBe(1);
    expect(server.acceptCalls()).toBe(1); // lokal bereits angenommen: kein Serveraufruf nötig
  });

  it('Server-Replay: lokal noch nicht angenommen, Server schon → derselbe Auftrag', async () => {
    const server = mockServer();
    const offer = await freigegebenesAngebot();
    // Die Antwort der ersten Annahme ging verloren.
    server.accept({ p_workspace_id: WORKSPACE, p_offer_id: offer.id, p_vorgang_id: 'v-verloren', p_row_version: 0 });
    expect(getOfferById(offer.id)?.status).toBe('freigegeben');

    const r = await acceptOfferWithCloud(offer.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(true);
    expect(r.vorgang.id).toBe('v-verloren');
    expect(r.vorgang.orderNumber).toBe('AU-2026-0001');
    expect(getOfferById(offer.id)?.resultingVorgangId).toBe('v-verloren');
    expect(getVorgangById('v-verloren')?.orderNumber).toBe('AU-2026-0001');
    expect(server.orderSeq()).toBe(1);
  });
});

describe('C — verlorene Antwort, Pull übernimmt', () => {
  it.each([false, true])('Server gewinnt (lokal nach dem Crash abweichend: %s): Angebot angenommen, Auftrag vorhanden, überholter Sendeauftrag abgeschlossen', async (lokalAbweichend) => {
    const server = mockServer();
    const offer = await freigegebenesAngebot();
    server.accept({ p_workspace_id: WORKSPACE, p_offer_id: offer.id, p_vorgang_id: 'v-server', p_row_version: 0 });
    if (lokalAbweichend) {
      // Nach dem Crash wurde das Angebot lokal noch als versendet markiert — ein älterer, abweichender Stand.
      expect(markOfferSent(offer.id).success).toBe(true);
      expect(getOfferById(offer.id)?.status).toBe('versendet');
    }
    // Lokal hängt noch ein Update des Angebots in der Warteschlange.
    enqueueSyncOutbox({ entityType: 'offer', entityId: offer.id, operation: 'update', version: 2 });

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit(server));
    expect(merged.conflicts).toEqual([]);

    const lokalOffer = merged.state.offers?.find((o) => o.id === offer.id);
    expect(lokalOffer?.status).toBe('angenommen');
    expect(lokalOffer?.resultingVorgangId).toBe('v-server');
    expect(lokalOffer?.sync?.version).toBe(3);

    const lokalVorgang = merged.state.vorgaenge?.find((v) => v.id === 'v-server');
    expect(lokalVorgang?.orderNumber).toBe('AU-2026-0001');
    expect(lokalVorgang?.sourceOfferId).toBe(offer.id);
    expect(lokalVorgang?.status).toBe('beauftragt');
    expect(lokalVorgang?.taxStatus).toBe('reverse_charge_13b');
    expect(lokalVorgang?.contractConfirmation?.immutable).toBe(true);

    expect(
      getSyncOutboxSnapshot().filter((e) => e.entityType === 'offer' && e.entityId === offer.id && e.status !== 'completed'),
    ).toHaveLength(0);

    // Nach dem Sync: keine zweite Annahme, kein zweiter Serveraufruf
    setOfferStoreForTests(merged.state.offers ?? []);
    hydrateVorgangStore(merged.state.vorgaenge ?? []);
    const r = await acceptOfferWithCloud(offer.id);
    expect(r.ok && r.replayed && r.vorgang.id === 'v-server').toBe(true);
    expect(server.acceptCalls()).toBe(1);
  });
});

describe('D — Rechnungsentwürfe aus dem Auftrag', () => {
  it('§13b und Zahlungsbedingung aus dem Auftrag; Legacy-Vorgang behält den Firmenstandard', async () => {
    mockServer();
    const offer = await freigegebenesAngebot();
    const r = await acceptOfferWithCloud(offer.id);
    if (!r.ok) throw new Error(JSON.stringify(r));

    for (const type of ['rechnung', 'abschlag', 'schluss'] as const) {
      const draft = buildInvoiceDraftForType(r.vorgang.id, DEFAULT_SETUP, type);
      expect(draft, type).not.toBeNull();
      expect(draft?.taxStatus, type).toBe('reverse_charge_13b');
      expect(draft?.paymentTermsText, type).toBe(ZAHLUNG);
      if (draft) expect(calculateInvoiceTotals(draft, DEFAULT_SETUP).tax, type).toBe(0);
    }

    // Vorgang ohne Auftragsfelder (Werkvertrag): Firmenstandard
    const legacy: Vorgang = {
      ...r.vorgang,
      id: 'v-legacy',
      sourceOfferId: undefined,
      sourceOfferNumber: undefined,
      orderNumber: undefined,
      orderDate: undefined,
      taxStatus: undefined,
      paymentTermsText: undefined,
      introText: undefined,
      closingText: undefined,
      contractTotals: undefined,
    };
    hydrateVorgangStore([r.vorgang, legacy]);
    const ref = buildInvoiceDraftForType('v-legacy', DEFAULT_SETUP, 'rechnung');
    expect(ref?.taxStatus).toBe('standard_19');
    expect(ref?.paymentTermsText).not.toBe(ZAHLUNG);
    expect(ref?.paymentTermsText?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('E — nicht annehmbar', () => {
  it('Entwurf: kein Serveraufruf', async () => {
    const server = mockServer();
    const offer = entwurf();
    const r = await acceptOfferWithCloud(offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_acceptable');
    expect(server.acceptCalls()).toBe(0);
  });

  it('ohne Cloud keine Annahme', async () => {
    const server = mockServer();
    const offer = await freigegebenesAngebot();
    resetSyncClientForTests({
      deviceId: 'device-test',
      workspaceId: WORKSPACE,
      createdAt: '2026-09-01T00:00:00.000Z',
      syncPolicy: 'local_only',
    });
    const r = await acceptOfferWithCloud(offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('cloud_required');
    expect(server.acceptCalls()).toBe(0);
    expect(getOfferById(offer.id)?.status).toBe('freigegeben');
  });

  it('Server lehnt ab: lokal bleibt alles unverändert', async () => {
    mockServer();
    const offer = await freigegebenesAngebot();
    registerMockRpcHandler('accept_workspace_offer', () => {
      throw new Error('Keine Schreibberechtigung');
    });
    const r = await acceptOfferWithCloud(offer.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('server_rejected');
    expect(getOfferById(offer.id)?.status).toBe('freigegeben');
    expect(getOfferById(offer.id)?.resultingVorgangId).toBeUndefined();
  });
});
