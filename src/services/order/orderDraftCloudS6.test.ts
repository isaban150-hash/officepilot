/**
 * CLOUD-SYNC S6 — der Auftragsentwurf auf mehreren Geräten (Client-Seite).
 *
 * Geprüft wird der ganze Weg ohne Server: fachlicher Inhalt, Änderungsverfolger,
 * Sendeauftrag, Versand über den bestehenden Dispatcher, Abzug, Abgleich mit
 * Konfliktvertrag, Grabsteine, Verbrauch, Altbestand, Workspace-Schutz,
 * Speicherfehler, Multi-Tab, Offline und die Bindung der Anlage. Die
 * Serverseite (Version, Grabstein, Verbrauch, Bindung, Nummern, Rechte, RLS,
 * Gleichzeitigkeit) prüfen `supabase/tests/order_drafts_s6.sql` und
 * `supabase/tests/order_drafts_parallel_s6.sql` gegen PostgreSQL.
 *
 * Seit Phase 2 ist der Entwurfs-Sync freigegeben. Die Fälle mit Cloud-Seite
 * halten ihn trotzdem ausdrücklich fest (`enableOrderDraftCloudSyncForTests`);
 * die Notausschalter-Fälle (`disableOrderDraftCloudSyncForTests`) prüfen, dass
 * ohne Entwurfs-Sync nichts gesendet wird und alles wie vor S6 läuft.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDraft, OrderDraftCloudPayload, OrderDraftInput, WorkspaceOrderDraftRow } from '../../types/orderDraft';
import * as allowlist from '../sync/cloudSyncAllowlist';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import * as supabaseLib from '../../lib/supabase';
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
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { buildStorageKey, resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { bootstrapBusinessState } from '../storage/storageBootstrapService';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import { disableOrderDraftCloudSyncForTests, enableOrderDraftCloudSyncForTests } from '../../test/orderDraftCloudSwitch';
import {
  acceptOrderDraftCloudEnd,
  continueOrderDraftAsNew,
  createOrderDraft,
  deleteOrderDraft,
  discardOrderDraftAgain,
  getOrderDraftById,
  getOrderDraftStoreSnapshot,
  hydrateOrderDrafts,
  keepLocalOrderDraftVersion,
  keepOrderDraftAfterRejectedDiscard,
  listOrderDrafts,
  resetOrderDrafts,
  resolveOrderDraftCloudBinding,
  resolveOrderDraftRoute,
  takeCloudOrderDraftVersion,
  updateOrderDraft,
} from './orderDraftService';
import { buildOrderDraftCloudPushPayload, stripOrderDraftForCloud } from './orderDraftCloudService';

const WS = 'ws-order-draft-s6';
const DEVICE = 'device-order-draft-s6';
const UPDATED_AT = '2026-10-07T09:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Hilfen                                                              */
/* ------------------------------------------------------------------ */

function eingabe(titel = 'S6 Montage'): OrderDraftInput {
  return {
    customerId: 'cust-s6',
    customerBilling: {
      name: 'Muster Bau GmbH',
      contactPerson: '',
      street: 'Weg 6',
      zip: '33602',
      city: 'Bielefeld',
      email: '',
      phone: '',
    },
    title: titel,
    baustelle: 'Weg 6, Bielefeld',
    positions: [{ id: 'op-s6-1', description: 'Montage', plannedQuantity: 2, unit: 'Stunden', unitPrice: 100 }],
    taxStatus: 'standard_19',
    paymentTermsText: '14 Tage netto',
  };
}

function neu(titel?: string): OrderDraft {
  const r = createOrderDraft(WS, eingabe(titel));
  if (!r.success) throw new Error(r.errorKey);
  return r.draft;
}

function inhalt(draft: OrderDraft, overrides: Partial<OrderDraftCloudPayload> = {}): OrderDraftCloudPayload {
  return { ...stripOrderDraftForCloud(draft), ...overrides };
}

function zeile(
  payload: OrderDraftCloudPayload | null,
  rowVersion: number,
  options: { id?: string; deleted?: boolean; consumed?: boolean } = {},
): WorkspaceOrderDraftRow {
  const id = options.id ?? payload?.id ?? 'v-s6-zeile';
  const ended = Boolean(options.deleted || options.consumed);
  return {
    workspace_id: WS,
    client_draft_id: id,
    status: options.consumed ? 'consumed' : 'active',
    // Endzustände reisen ohne Inhalt.
    payload: ended ? undefined : (JSON.parse(JSON.stringify(payload)) as Record<string, unknown>),
    consumed_vorgang_id: options.consumed ? id : null,
    row_version: rowVersion,
    deleted: options.deleted ?? false,
    deleted_at: options.deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

function abgleich(rows: WorkspaceOrderDraftRow[]) {
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
    orderDrafts: rows,
    orderAmendmentDrafts: [],
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);
  // Wie ein echter Abzug: anwenden, Baseline des Änderungsverfolgers setzen.
  applyStateToStores(result.state);
  return result;
}

function entwurfsAuftraege() {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'order_draft' && entry.status !== 'completed');
}

function gespeichert(id: string): OrderDraft | undefined {
  return getOrderDraftStoreSnapshot().find((draft) => draft.id === id);
}

type Antwort = { rowVersion: number } | Error;

function sendenMit(antwort: (payload: Record<string, unknown>, version: number) => Antwort) {
  return vi
    .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
    .mockImplementation(async (_ws, type, payload, version) => {
      if (type !== 'order_draft') return { rowVersion: version + 1, payload: {}, entityId: null, deduped: false };
      const result = antwort(payload, version);
      if (result instanceof Error) throw result;
      return { rowVersion: result.rowVersion, payload: {}, entityId: null, deduped: false };
    });
}

/** Der echte Sendelauf der App (Queue-Lauf, Adapter, sicheres Übernehmen) — nur die RPC ist ersetzt. */
async function senden() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  const adapter = new SupabaseSyncAdapter(null);
  vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
  getSyncCoordinator().setAdapter(adapter);
  return pushPendingChangesFromUi();
}

/** Ein anderer Tab hat fachlich neuer gespeichert (SYNC-AUTOMATIK-01A-FIX3). */
function andererTabSpeichert(): void {
  const key = buildStorageKey({ type: 'workspace', workspaceId: WS });
  const raw = localStorage.getItem(key);
  if (!raw) throw new Error('kein Bestand');
  localStorage.setItem(key, raw.replace(/^\{"businessRevision":(\d+)/, (_m, n: string) => `{"businessRevision":${Number(n) + 1}`));
}

/** Ein bereits mit der Cloud abgeglichener Entwurf in Version 1. */
async function abgeglichen(titel?: string): Promise<OrderDraft> {
  const draft = neu(titel);
  sendenMit(() => ({ rowVersion: 1 }));
  await senden();
  vi.mocked(workspaceCloudService.rpcUpsertWorkspaceSyncEntity).mockRestore();
  const synced = gespeichert(draft.id);
  if (synced?.sync?.version !== 1) throw new Error('nicht abgeglichen');
  return synced;
}

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS });
  resetOrderDrafts();
  resetVorgaenge();
  // Baseline des Änderungsverfolgers: Was ab jetzt entsteht, ist eine Änderung.
  persistAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A — Payload                                                         */
/* ------------------------------------------------------------------ */

describe('S6-OD-A — der Cloud-Inhalt ist nur die fachliche Entwurfswahrheit', () => {
  it('A1 — genau die Eingaben; kein Workspace, keine Sync-Metadaten, kein Konflikt, keine Nummer', () => {
    const draft = neu();
    const mitAllem: OrderDraft = {
      ...draft,
      introText: 'Einleitung',
      sync: { updatedAt: UPDATED_AT, version: 3, deleted: false, deviceId: DEVICE, workspaceId: WS },
      conflict: {
        kind: 'version',
        detectedAt: UPDATED_AT,
        remote: { rowVersion: 4, status: 'active', deleted: false, payload: null },
      },
    };
    const payload = stripOrderDraftForCloud(mitAllem);
    expect(Object.keys(payload).sort()).toEqual(
      ['baustelle', 'createdAt', 'customerBilling', 'customerId', 'id', 'introText', 'paymentTermsText', 'positions', 'taxStatus', 'title', 'updatedAt'],
    );
    expect(Object.keys(payload.positions[0]!).sort()).toEqual(['description', 'id', 'plannedQuantity', 'unit', 'unitPrice']);
    const reist = JSON.stringify(buildOrderDraftCloudPushPayload(mitAllem));
    for (const verboten of ['workspaceId', '"sync"', '"conflict"', 'orderNumber', 'vorgangNumber', 'contractConfirmation']) {
      expect(reist, verboten).not.toContain(verboten);
    }
  });

  it('A2 — ein Grabstein reist ohne Inhalt', () => {
    const draft = neu();
    expect(buildOrderDraftCloudPushPayload(draft, true)).toEqual({ draft_id: draft.id, payload: {}, deleted: true });
  });
});

/* ------------------------------------------------------------------ */
/* C / AI — lokal → Sync, keine Schleife                               */
/* ------------------------------------------------------------------ */

describe('S6-OD-C — lokal gespeichert, über die bestehende Kette gesendet', () => {
  it('C0 — freigegeben: order_draft und order_amendment_draft stehen in der Freigabeliste', () => {
    expect(allowlist.SUPABASE_SYNC_ALLOWLIST.has('order_draft')).toBe(true);
    expect(allowlist.SUPABASE_SYNC_ALLOWLIST.has('order_amendment_draft')).toBe(true);
    expect(allowlist.isSupabaseSyncAllowed('order_draft')).toBe(true);
    expect(allowlist.isSupabaseSyncAllowed('order_amendment_draft')).toBe(true);
  });

  it('C1 — Notausschalter (Entwurfs-Sync aus): nichts erreicht die Cloud, der Sendeauftrag wird gegenstandslos abgeschlossen', async () => {
    disableOrderDraftCloudSyncForTests();
    const draft = neu();
    expect(entwurfsAuftraege().map((entry) => entry.entityId)).toEqual([draft.id]);
    const upsert = sendenMit(() => ({ rowVersion: 1 }));
    await senden();
    expect(upsert.mock.calls.filter(([, type]) => type === 'order_draft')).toHaveLength(0);
    expect(entwurfsAuftraege()).toHaveLength(0);
    expect(gespeichert(draft.id)?.sync).toBeUndefined();
  });

  it('C2/AI — freigegeben: Anlage geht mit Version 0 hinaus, die Serverversion kommt zurück, danach keine Schleife', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = neu();
    expect(entwurfsAuftraege()[0]?.operation).toBe('create');
    const gesehen: Array<{ payload: Record<string, unknown>; version: number }> = [];
    sendenMit((payload, version) => {
      gesehen.push({ payload, version });
      return { rowVersion: 1 };
    });
    await senden();
    expect(gesehen).toHaveLength(1);
    expect(gesehen[0]!.version).toBe(0);
    expect(gesehen[0]!.payload).toEqual({ draft_id: draft.id, payload: stripOrderDraftForCloud(draft), deleted: false });
    expect(gespeichert(draft.id)?.sync?.version).toBe(1);
    expect(entwurfsAuftraege()).toHaveLength(0);

    // AI — erneutes Speichern ohne Änderung und ein Abzug mit demselben Stand erzeugen nichts.
    persistAll();
    abgleich([zeile(inhalt(draft), 1)]);
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
    expect(gespeichert(draft.id)?.conflict).toBeUndefined();
  });

  it('C3 — eine Änderung geht mit der bestätigten Version hinaus', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    expect(updateOrderDraft(draft.id, { title: 'S6 Montage geändert' }).success).toBe(true);
    const gesehen: number[] = [];
    sendenMit((_payload, version) => {
      gesehen.push(version);
      return { rowVersion: 2 };
    });
    await senden();
    expect(gesehen).toEqual([1]);
    expect(gespeichert(draft.id)?.sync?.version).toBe(2);
  });

  it('C4 — Speichern ohne inhaltliche Änderung: keine neue Fassung, kein Sendeauftrag, die Bindung bleibt', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const vorher = gespeichert(draft.id)!;
    const r = updateOrderDraft(draft.id, { title: vorher.title, positions: vorher.positions.map((p) => ({ ...p })) });
    expect(r.success).toBe(true);
    expect(gespeichert(draft.id)?.updatedAt).toBe(vorher.updatedAt);
    expect(entwurfsAuftraege()).toHaveLength(0);
    expect(resolveOrderDraftCloudBinding(draft.id)).toEqual({
      ok: true,
      binding: { clientDraftId: draft.id, expectedDraftRowVersion: 1 },
    });
    // Eine echte Änderung bleibt eine Änderung.
    expect(updateOrderDraft(draft.id, { title: 'wirklich geändert' }).success).toBe(true);
    expect(entwurfsAuftraege().map((entry) => entry.entityId)).toEqual([draft.id]);
  });
});

/* ------------------------------------------------------------------ */
/* B — Cloud-only → lokal                                              */
/* ------------------------------------------------------------------ */

describe('S6-OD-B — ein Entwurf eines anderen Geräts wird hier sichtbar', () => {
  it('B1 — der Abzug legt ihn mit Serverversion an; er wird nicht zurückgesendet', () => {
    enableOrderDraftCloudSyncForTests();
    const remote: OrderDraftCloudPayload = {
      id: 'v-s6-remote',
      customerBilling: eingabe().customerBilling,
      title: 'Vom Tablet',
      baustelle: 'Weg 7',
      positions: [{ id: 'op-r1', description: 'Prüfung', plannedQuantity: 1, unit: 'Pauschal', unitPrice: 80 }],
      taxStatus: 'standard_19',
      paymentTermsText: '7 Tage',
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    };
    abgleich([zeile(remote, 3)]);
    const draft = listOrderDrafts().find((item) => item.id === 'v-s6-remote');
    expect(draft?.title).toBe('Vom Tablet');
    expect(draft?.sync?.version).toBe(3);
    expect(draft?.workspaceId).toBe(WS);
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* D — Versionskonflikt                                                */
/* ------------------------------------------------------------------ */

describe('S6-OD-D — Cloud neuer und lokal geändert: sichtbarer Konflikt, kein Last-Write-Wins', () => {
  it('D1 — Konflikt mit beiden Ständen; der Entwurf nimmt bis zur Entscheidung keine Änderung an', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    expect(updateOrderDraft(draft.id, { title: 'Lokal geändert' }).success).toBe(true);
    const result = abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(result.conflicts).toContain(`order_draft:${draft.id}`);
    const lokal = getOrderDraftById(draft.id)!;
    expect(lokal.title).toBe('Lokal geändert');
    expect(lokal.conflict?.kind).toBe('version');
    expect(lokal.conflict?.remote.payload?.title).toBe('Anderswo geändert');
    expect(updateOrderDraft(draft.id, { title: 'Noch einmal' })).toEqual({ success: false, errorKey: 'order.draft.conflictOpen' });
    expect(deleteOrderDraft(draft.id)).toEqual({ success: false, errorKey: 'order.draft.conflictOpen' });
    expect(resolveOrderDraftCloudBinding(draft.id)).toEqual({ ok: false, reason: 'draft_conflict' });
  });

  it('D2 — „Cloud-Fassung übernehmen" ersetzt bewusst und sendet nichts', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderDraft(draft.id, { title: 'Lokal geändert' });
    abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(takeCloudOrderDraftVersion(draft.id)).toEqual({ ok: true });
    const lokal = getOrderDraftById(draft.id)!;
    expect(lokal.title).toBe('Anderswo geändert');
    expect(lokal.sync?.version).toBe(2);
    expect(lokal.conflict).toBeUndefined();
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });

  it('D3 — „Meine Fassung behalten" sendet bewusst gegen die gesehene Serverversion', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderDraft(draft.id, { title: 'Lokal geändert' });
    abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(keepLocalOrderDraftVersion(draft.id)).toEqual({ ok: true });
    const gesehen: Array<{ version: number; titel: unknown }> = [];
    sendenMit((payload, version) => {
      gesehen.push({ version, titel: (payload.payload as Record<string, unknown>).title });
      return { rowVersion: 3 };
    });
    await senden();
    expect(gesehen).toEqual([{ version: 2, titel: 'Lokal geändert' }]);
    expect(gespeichert(draft.id)?.sync?.version).toBe(3);
  });

  it('D4 — Cloud neuer, lokal nichts offen: die Cloud-Fassung wird übernommen', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const result = abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(result.conflicts).toHaveLength(0);
    expect(getOrderDraftById(draft.id)?.title).toBe('Anderswo geändert');
    expect(getOrderDraftById(draft.id)?.sync?.version).toBe(2);
  });

  it('D5 — der abgewiesene Versand bleibt als Konflikt stehen, nicht im Fehlertopf', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderDraft(draft.id, { title: 'Lokal geändert' });
    sendenMit(() => new workspaceCloudService.WorkspaceCloudError('Versionskonflikt order_draft:2', 'version_conflict', false));
    await senden();
    expect(entwurfsAuftraege()[0]?.status).toBe('blocked');
    expect(getOrderDraftById(draft.id)?.title).toBe('Lokal geändert');
  });
});

/* ------------------------------------------------------------------ */
/* E / K — verworfen, kein Wiederbeleben, ehrlicher Speicherfehler      */
/* ------------------------------------------------------------------ */

describe('S6-OD-E — verworfen wird nie wiederbelebt', () => {
  it('E1 — Verwerfen eines abgeglichenen Entwurfs: Grabstein ohne Inhalt, nach Bestätigung verschwunden', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    expect(deleteOrderDraft(draft.id)).toEqual({ success: true });
    expect(listOrderDrafts()).toHaveLength(0);
    expect(gespeichert(draft.id)?.sync?.deleted).toBe(true);
    expect(entwurfsAuftraege()[0]?.operation).toBe('delete');
    const gesehen: Array<Record<string, unknown>> = [];
    sendenMit((payload) => {
      gesehen.push(payload);
      return { rowVersion: 2 };
    });
    await senden();
    expect(gesehen).toEqual([{ draft_id: draft.id, payload: {}, deleted: true }]);
    expect(gespeichert(draft.id)).toBeUndefined();
    // Der Server kennt den Grabstein: Ein späterer Abzug belebt nichts.
    abgleich([zeile(null, 2, { id: draft.id, deleted: true })]);
    expect(gespeichert(draft.id)).toBeUndefined();
  });

  it('E2 — anderswo verworfen, hier nichts offen: der Entwurf verschwindet', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    abgleich([zeile(null, 2, { id: draft.id, deleted: true })]);
    expect(gespeichert(draft.id)).toBeUndefined();
  });

  it('E3 — anderswo verworfen, hier geändert: Konflikt; „Als neuen Entwurf behalten" nur mit neuer Kennung', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderDraft(draft.id, { title: 'Hier weiter bearbeitet' });
    abgleich([zeile(null, 2, { id: draft.id, deleted: true })]);
    expect(getOrderDraftById(draft.id)?.conflict?.kind).toBe('deleted');
    const r = continueOrderDraftAsNew(draft.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draftId).toBeTruthy();
    expect(r.draftId).not.toBe(draft.id);
    expect(gespeichert(draft.id)).toBeUndefined();
    const fresh = getOrderDraftById(r.draftId!)!;
    expect(fresh.title).toBe('Hier weiter bearbeitet');
    expect(fresh.sync).toBeUndefined();
    expect(entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation])).toEqual([[r.draftId, 'create']]);
  });

  it('E4 — „Verwerfen annehmen" entfernt den Entwurf ohne Sendeauftrag', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderDraft(draft.id, { title: 'Hier weiter bearbeitet' });
    abgleich([zeile(null, 2, { id: draft.id, deleted: true })]);
    expect(acceptOrderDraftCloudEnd(draft.id)).toEqual({ ok: true });
    expect(gespeichert(draft.id)).toBeUndefined();
    persistAll();
    expect(entwurfsAuftraege()).toHaveLength(0);
  });

  it('E5 — Notausschalter: Verwerfen löscht hart, es entsteht kein Grabstein', () => {
    disableOrderDraftCloudSyncForTests();
    const draft = neu();
    expect(deleteOrderDraft(draft.id)).toEqual({ success: true });
    expect(gespeichert(draft.id)).toBeUndefined();
  });

  it('E6 — hier verworfen, anderswo geändert: das Verwerfen wird nicht übernommen, der Entwurf ist sichtbar wieder da', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    deleteOrderDraft(draft.id);
    const result = abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(result.conflicts).toContain(`order_draft:${draft.id}`);
    const wieder = getOrderDraftById(draft.id)!;
    expect(wieder.title).toBe('Anderswo geändert');
    expect(wieder.conflict?.kind).toBe('discard_rejected');
    expect(entwurfsAuftraege()).toHaveLength(0);
    expect(keepOrderDraftAfterRejectedDiscard(draft.id)).toEqual({ ok: true });
    expect(getOrderDraftById(draft.id)?.conflict).toBeUndefined();
  });

  it('E7 — „Erneut verwerfen" verwirft auf der neuen Fassung', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    deleteOrderDraft(draft.id);
    abgleich([zeile(inhalt(draft, { title: 'Anderswo geändert' }), 2)]);
    expect(discardOrderDraftAgain(draft.id)).toEqual({ ok: true });
    expect(listOrderDrafts()).toHaveLength(0);
    const gesehen: number[] = [];
    sendenMit((_payload, version) => {
      gesehen.push(version);
      return { rowVersion: 3 };
    });
    await senden();
    expect(gesehen).toEqual([2]);
  });
});

describe('S6-OD-K — Verwerfen meldet nie Erfolg, wenn das Speichern scheitert', () => {
  it('K1 — Speicher voll: Fehler, der Entwurf bleibt vollständig erhalten, die Warteschlange unverändert', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    const vorher = getSyncOutboxSnapshot();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('voll', 'QuotaExceededError');
    });
    expect(deleteOrderDraft(draft.id)).toEqual({ success: false, errorKey: 'order.draft.discardFailed' });
    setItem.mockRestore();
    expect(getOrderDraftById(draft.id)?.title).toBe(draft.title);
    expect(gespeichert(draft.id)?.sync?.deleted).toBe(false);
    expect(getSyncOutboxSnapshot()).toEqual(vorher);
  });
});

/* ------------------------------------------------------------------ */
/* F / H — verbraucht, kein Backfill bestehender Vorgänge              */
/* ------------------------------------------------------------------ */

describe('S6-OD-F — verbraucht (zum Auftrag geworden) wird nie wiederbelebt', () => {
  it('F1 — anderswo zum Auftrag geworden, hier nichts offen: der Entwurf verschwindet', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    abgleich([zeile(null, 2, { id: draft.id, consumed: true })]);
    expect(gespeichert(draft.id)).toBeUndefined();
  });

  it('F2 — hier geändert: sichtbarer Konflikt „bereits als Auftrag angelegt", Adresse bleibt beim Entwurf', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = await abgeglichen();
    updateOrderDraft(draft.id, { title: 'Hier geändert' });
    hydrateVorgangStore([createTestVorgang({ id: draft.id, title: 'Auftrag' })]);
    abgleich([zeile(null, 2, { id: draft.id, consumed: true })]);
    const lokal = getOrderDraftById(draft.id)!;
    expect(lokal.conflict?.kind).toBe('consumed');
    expect(resolveOrderDraftRoute(draft.id).kind).toBe('draft');
    expect(resolveOrderDraftCloudBinding(draft.id)).toEqual({ ok: false, reason: 'draft_conflict' });
  });

  it('H1 — eine Kennung, die bereits ein Vorgang ist, wird weder hochgeladen noch behalten', () => {
    hydrateOrderDrafts([{ ...stripOrderDraftForCloud(neu()), id: 'v-s6-auftrag', workspaceId: WS }]);
    hydrateVorgangStore([createTestVorgang({ id: 'v-s6-auftrag', title: 'Auftrag' })]);
    persistAll();
    enableOrderDraftCloudSyncForTests();
    resetSyncOutboxForTests([]);
    abgleich([]);
    expect(entwurfsAuftraege().map((entry) => entry.entityId)).not.toContain('v-s6-auftrag');
    expect(gespeichert('v-s6-auftrag')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* G — Altbestand                                                      */
/* ------------------------------------------------------------------ */

describe('S6-OD-G — Altbestand: nur aktive, unbekannte Entwürfe, Version 0, kein Wiederbeleben', () => {
  it('G1 — Entwürfe aus der Zeit vor der Freigabe gehen danach genau einmal hinaus; Serverkennungen (auch Grabsteine) nie', async () => {
    disableOrderDraftCloudSyncForTests();
    const a = neu('A');
    const b = neu('B');
    const c = neu('C');
    sendenMit(() => ({ rowVersion: 1 }));
    await senden(); // vor der Freigabe: Aufträge gegenstandslos abgeschlossen.
    expect(entwurfsAuftraege()).toHaveLength(0);
    vi.restoreAllMocks();

    enableOrderDraftCloudSyncForTests();
    abgleich([zeile(null, 2, { id: b.id, deleted: true }), zeile(inhalt(c), 1)]);
    const geplant = entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation, entry.version]);
    expect(geplant).toEqual([[a.id, 'create', 0]]);
    // b ist anderswo verworfen (lokal sauber) — weg; c ist bereits in der Cloud — übernommen.
    expect(gespeichert(b.id)).toBeUndefined();
    expect(gespeichert(c.id)?.sync?.version).toBe(1);

    // Idempotent: ein zweiter Abzug plant nichts doppelt.
    abgleich([zeile(null, 2, { id: b.id, deleted: true }), zeile(inhalt(c), 1)]);
    expect(entwurfsAuftraege().filter((entry) => entry.entityId === a.id)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* I / J / AJ — Workspace-Schutz                                       */
/* ------------------------------------------------------------------ */

describe('S6-OD-I/J — kein Entwurf gerät in einen fremden Workspace', () => {
  it('I1 — ein Entwurf eines anderen Workspace wird weder verfolgt noch gesendet', () => {
    enableOrderDraftCloudSyncForTests();
    hydrateOrderDrafts([{ ...stripOrderDraftForCloud(neu()), id: 'v-s6-fremd', workspaceId: 'ws-fremd' }]);
    resetSyncOutboxForTests([]);
    persistAll();
    expect(entwurfsAuftraege().map((entry) => entry.entityId)).not.toContain('v-s6-fremd');
    expect(extractCloudSyncEntity(buildPersistedStateSnapshot(), 'order_draft', 'v-s6-fremd')).toBeNull();
  });

  it('J1 — Bereichswechsel leert den Speicher; ein Ladefehler in B behält keinen Entwurf aus A; zurück in A ist er wieder da', () => {
    const userId = 'user-s6';
    bootstrapBusinessState({ userId, workspaceId: 'ws-s6-a' });
    const draft = createOrderDraft('ws-s6-a', eingabe('Nur in A'));
    expect(draft.success).toBe(true);
    expect(listOrderDrafts()).toHaveLength(1);

    clearInMemoryBusinessState();
    expect(listOrderDrafts()).toHaveLength(0);
    expect(getOrderDraftStoreSnapshot()).toHaveLength(0);

    bootstrapBusinessState({ userId, workspaceId: 'ws-s6-a' });
    expect(listOrderDrafts()).toHaveLength(1);
    localStorage.setItem(buildStorageKey({ type: 'workspace', workspaceId: 'ws-s6-b' }), '{kaputt');
    const b = bootstrapBusinessState({ userId, workspaceId: 'ws-s6-b' });
    expect(b.loadFailed).toBe(true);
    expect(listOrderDrafts(), 'kein Entwurf aus A im Speicher von B').toHaveLength(0);
    expect(getOrderDraftStoreSnapshot()).toHaveLength(0);

    bootstrapBusinessState({ userId, workspaceId: 'ws-s6-a' });
    expect(listOrderDrafts().map((item) => item.title)).toEqual(['Nur in A']);
  });
});

/* ------------------------------------------------------------------ */
/* L — Multi-Tab                                                       */
/* ------------------------------------------------------------------ */

describe('S6-OD-L — ein veralteter Tab meldet keinen falschen Erfolg', () => {
  it('L1 — Verwerfen und Ändern scheitern ehrlich; der Bestand des anderen Tabs bleibt unangetastet', () => {
    const draft = neu();
    andererTabSpeichert();
    const roh = localStorage.getItem(buildStorageKey({ type: 'workspace', workspaceId: WS }));
    expect(deleteOrderDraft(draft.id)).toEqual({ success: false, errorKey: 'order.draft.discardFailed' });
    expect(updateOrderDraft(draft.id, { title: 'x' })).toEqual({ success: false, errorKey: 'order.draft.saveFailed' });
    expect(getOrderDraftById(draft.id)?.title).toBe(draft.title);
    expect(localStorage.getItem(buildStorageKey({ type: 'workspace', workspaceId: WS }))).toBe(roh);
  });
});

/* ------------------------------------------------------------------ */
/* M — Offline → Online                                                */
/* ------------------------------------------------------------------ */

describe('S6-OD-M — offline gespeichert bleibt gespeichert und geht später hinaus', () => {
  it('M1 — Netzfehler: Entwurf lokal unverändert, Auftrag bleibt offen; danach geht er normal hinaus', async () => {
    enableOrderDraftCloudSyncForTests();
    const draft = neu();
    sendenMit(() => new workspaceCloudService.WorkspaceCloudError('Failed to fetch', 'network', true));
    await senden();
    expect(getOrderDraftById(draft.id)?.title).toBe(draft.title);
    expect(entwurfsAuftraege()).toHaveLength(1);
    expect(resolveOrderDraftCloudBinding(draft.id)).toEqual({ ok: false, reason: 'draft_not_synced' });
    vi.mocked(workspaceCloudService.rpcUpsertWorkspaceSyncEntity).mockRestore();
    sendenMit(() => ({ rowVersion: 1 }));
    await senden();
    expect(gespeichert(draft.id)?.sync?.version).toBe(1);
    expect(entwurfsAuftraege()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Bindung                                                             */
/* ------------------------------------------------------------------ */

describe('S6-OD-Bindung — die Anlage bindet nur einen vollständig angekommenen Entwurf', () => {
  it('ohne Entwurfs-Sync (Notausschalter) keine Bindung; freigegeben: Kennung = Vorgangskennung, erwartete Version = Serverversion', async () => {
    disableOrderDraftCloudSyncForTests();
    const lokal = neu();
    expect(resolveOrderDraftCloudBinding(lokal.id)).toEqual({ ok: true, binding: null });
    enableOrderDraftCloudSyncForTests();
    expect(resolveOrderDraftCloudBinding(lokal.id)).toEqual({ ok: false, reason: 'draft_not_synced' });
    expect(allowlist.isSupabaseSyncAllowed('order_draft')).toBe(true);
    const draft = await abgeglichen();
    expect(resolveOrderDraftCloudBinding(draft.id)).toEqual({
      ok: true,
      binding: { clientDraftId: draft.id, expectedDraftRowVersion: 1 },
    });
    deleteOrderDraft(draft.id);
    expect(resolveOrderDraftCloudBinding(draft.id)).toEqual({ ok: false, reason: 'draft_ended' });
  });
});
