/**
 * CLOUD-SYNC S5 — der Rechnungsentwurf auf mehreren Geräten (Client-Seite).
 *
 * Geprüft wird der ganze Weg ohne Server: fachlicher Kern, Spiegel, Änderungs-
 * verfolger, Sendeauftrag, Versand über den bestehenden Dispatcher, Abzug,
 * Abgleich mit Konfliktvertrag, Grabsteine, Altbestand, Rehydrierung auf Gerät B
 * und die Entscheidungen des Nutzers. Die Serverseite (Version, Slot, Grabstein,
 * atomare Freigabe, Doppelfreigabe, Nummern, R1, Rollen, RLS) prüfen
 * `supabase/tests/invoice_drafts_s5.sql` und der echte Parallellauf
 * `supabase/tests/invoice_drafts_parallel_s5.sql` gegen PostgreSQL.
 *
 * Seit Phase 2 ist die Cloud-Seite freigegeben (Migration 20261102120000 remote
 * angewendet). Die Fälle, die den gesperrten Zustand prüfen (Notausschalter,
 * Phase 1), schalten ihn hier ausdrücklich ab.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceDraft } from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import type {
  InvoiceDraftCloudCore,
  WorkspaceInvoiceDraftRow,
} from '../../types/invoiceDraftCloud';
import * as allowlist from '../sync/cloudSyncAllowlist';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../persistenceService';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { getSyncCoordinator } from '../sync/syncCoordinator';
import { pushPendingChangesFromUi } from '../sync/syncUiService';
import { disableInvoiceDraftCloudSyncForTests } from '../../test/invoiceDraftCloudSwitch';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { applyStateToStores, buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { buildInvoiceDraftForType, buildManualInvoiceDraft, refreshDraftOrderProjection } from '../invoiceService';
import {
  beginInvoiceDraftFinalization,
  completeInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import {
  buildInvoiceDraftCloudPushPayload,
  buildInvoiceDraftCoreKey,
  planInvoiceDraftBackfill,
  stripInvoiceDraftForCloud,
} from './invoiceDraftCloudService';
import {
  getInvoiceDraftCloudEntity,
  getInvoiceDraftCloudSnapshot,
  putInvoiceDraftCloudEntity,
  resetInvoiceDraftCloudStore,
} from './invoiceDraftCloudStore';
import {
  acceptCloudDraftEnd,
  adoptSlotOwnerDraft,
  applyLocalDraftCommitToMirror,
  flushInvoiceDraftCloudMirror,
  noteInvoiceDraftCommitted,
  continueDraftAsNew,
  discardInvoiceDraft,
  getInvoiceDraftCloudConflict,
  keepLocalDraftVersion,
  keepOwnDraftDiscardSlotOwner,
  markInvoiceDraftCloudFromFinalizedRecord,
  reconcileInvoiceDraftOnOpen,
  rehydrateInvoiceDraftFromCloudCore,
  resetInvoiceDraftCloudBridgeForTests,
  resolveCloudDraftForEmptySlot,
  resolveInvoiceDraftCloudBinding,
  runInvoiceDraftCloudBackfillOnce,
  takeCloudDraftVersion,
} from './invoiceDraftCloudBridge';
import {
  hasValidReverseChargeConfirmation,
  writeReverseChargeConfirmation,
} from './reverseChargeConfirmationService';

const WS = 'ws-invoice-draft-s5';
const SCOPE = `workspace:${WS}`;
const DEVICE = 'device-invoice-draft-s5';
const VORGANG = 'v-s5-1';
const UPDATED_AT = '2026-10-06T09:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Hilfen                                                              */
/* ------------------------------------------------------------------ */

function cloudFreigeben(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type === 'invoice_draft' || allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

function seedVorgang(): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG,
      status: 'in_bearbeitung',
      orderPositions: [
        createOrderPosition({ id: 'op-s5-1', description: 'Montage', plannedQuantity: 20, unit: 'Stunden', unitPrice: 100, executedQuantity: 12 }),
        createOrderPosition({ id: 'op-s5-2', description: 'Material', plannedQuantity: 5, unit: 'Stück', unitPrice: 40 }),
      ],
    }),
  ]);
}

/** Ein freier Entwurf (ohne Auftrag) mit allen lokalen Besonderheiten. */
function freierEntwurf(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const draft = buildManualInvoiceDraft(
    {
      customerId: 'cust-s5',
      billing: { name: 'Muster Bau GmbH', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: '', phone: '' },
    },
    testSetup,
  );
  return {
    ...draft,
    id: 'draft-frei-s5',
    positions: [
      { id: 'manual-pos-1', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45, billable: true },
    ],
    companySnapshot: { ...draft.companySnapshot, companyName: 'Alt GmbH', logoDataUrl: 'data:image/png;base64,QUJD' },
    introText: 'Einleitung A',
    ...overrides,
  };
}

/** Ein Auftragsentwurf mit Projektion und Abzügen — wie ihn der Editor hält. */
function auftragsEntwurf(): InvoiceDraft {
  const built = buildInvoiceDraftForType(VORGANG, testSetup, 'rechnung');
  if (!built) throw new Error('Entwurf fehlt');
  return { ...built, id: 'draft-auftrag-s5', positions: built.positions.map((p) => ({ ...p, quantity: 3 })) };
}

function identity(draft: InvoiceDraft): InvoiceDraftIdentity {
  return {
    sourceScopeKey: SCOPE,
    workspaceId: WS,
    vorgangId: draft.vorgangId,
    invoiceType: draft.type,
    draftId: draft.id,
  };
}

async function lokalAnlegen(draft: InvoiceDraft) {
  const created = await createInvoiceDraftRecord({ identity: identity(draft), draft });
  if (!created.ok) throw new Error(`anlegen: ${created.reason}`);
  return created.record;
}

async function lokalSpeichern(draft: InvoiceDraft, revision: number) {
  const saved = await saveInvoiceDraftRecord({ identity: identity(draft), draft, expectedRevision: revision });
  if (!saved.ok) throw new Error(`speichern: ${saved.reason}`);
  return saved.record;
}

function zeile(
  core: InvoiceDraftCloudCore | null,
  rowVersion: number,
  options: { id?: string; deleted?: boolean; finalized?: string; vorgangId?: string | null } = {},
): WorkspaceInvoiceDraftRow {
  const id = options.id ?? core?.id ?? 'draft-frei-s5';
  return {
    workspace_id: WS,
    client_draft_id: id,
    vorgang_id: options.vorgangId !== undefined ? options.vorgangId : (core?.vorgangId ?? null),
    invoice_type: core?.type ?? 'rechnung',
    status: options.finalized ? 'finalized' : 'active',
    // Grabsteine reisen ohne Inhalt.
    payload: options.deleted || options.finalized ? (undefined as unknown as Record<string, unknown>) : (JSON.parse(JSON.stringify(core)) as Record<string, unknown>),
    finalized_client_invoice_id: options.finalized ?? null,
    row_version: rowVersion,
    deleted: options.deleted ?? false,
    deleted_at: options.deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

function abgleich(rows: WorkspaceInvoiceDraftRow[]) {
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
    invoiceDrafts: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1]);
  // Wie ein echter Abzug: anwenden, Baseline des Änderungsverfolgers setzen.
  applyStateToStores(result.state);
  return result;
}

function entwurfsAuftraege() {
  return getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'invoice_draft' && entry.status !== 'completed');
}

function sendenMit(antwort: (payload: Record<string, unknown>, version: number) => { rowVersion: number } | Error) {
  const upsert = vi
    .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
    .mockImplementation(async (_ws, type, payload, version) => {
      // Andere Bestände (z. B. nach einem Abzug hochzuladende Stammdaten) gehen still durch.
      if (type !== 'invoice_draft') return { rowVersion: version + 1, payload: {}, entityId: null, deduped: false };
      const result = antwort(payload, version);
      if (result instanceof Error) throw result;
      return { rowVersion: result.rowVersion, payload: {}, entityId: null, deduped: false };
    });
  return upsert;
}

/** Der echte Sendelauf der App (Queue-Lauf, Adapter, sicheres Übernehmen) — nur die RPC ist ersetzt. */
async function senden() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  const adapter = new SupabaseSyncAdapter(null);
  vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
  getSyncCoordinator().setAdapter(adapter);
  return pushPendingChangesFromUi();
}

beforeEach(async () => {
  localStorage.clear();
  resetStorageScopeForTests();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WS, serverWorkspaceId: WS });
  resetInvoiceDraftCloudStore();
  resetInvoiceDraftCloudBridgeForTests();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  seedVorgang();
  // Baseline des Änderungsverfolgers: Was ab jetzt entsteht, ist eine Änderung.
  persistAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A–E — der Cloud-Payload ist nur der fachliche Kern                  */
/* ------------------------------------------------------------------ */

describe('S5-D0 — Freischaltung', () => {
  it('D0 — nach der Remote-Migration ist der Rechnungsentwurf freigegeben und nicht mehr nur-lokal', () => {
    expect(allowlist.isSupabaseSyncAllowed('invoice_draft')).toBe(true);
    expect(allowlist.SUPABASE_SYNC_ALLOWLIST.has('invoice_draft')).toBe(true);
    expect(allowlist.LOCAL_ONLY_SYNC_ENTITY_TYPES.has('invoice_draft')).toBe(false);
  });
});

describe('S5-A..E — fachlicher Kern', () => {
  it('A — der Kern trägt genau die Eingaben und eingefrorenen Snapshots', () => {
    const core = stripInvoiceDraftForCloud(auftragsEntwurf());
    expect(Object.keys(core).sort()).toEqual(
      [
        'baustelle', 'closingText', 'companySnapshot', 'currencyCode', 'customer', 'customerBilling',
        'id', 'introText', 'issueDate', 'legalNotices', 'materialSource', 'paymentDueDate',
        'paymentTermsText', 'positions', 'servicePeriodConfirmed', 'servicePeriodFrom', 'servicePeriodTo',
        'skontoText', 'taxStatus', 'type', 'vorgangId', 'vorgangTitle',
        ...(core.brandingSnapshot ? ['brandingSnapshot'] : []),
        ...(core.customerId ? ['customerId'] : []),
        ...(core.calculationMode ? ['calculationMode'] : []),
      ].sort(),
    );
    expect(Object.keys(core.positions[0]!).sort()).toEqual(
      ['billable', 'category', 'description', 'id', 'orderPositionId', 'quantity', 'unit', 'unitLabel', 'unitPrice']
        .filter((key) => key in core.positions[0]!)
        .sort(),
    );
  });

  it('B — das gerätelokale Legacy-Logo reist nicht', () => {
    const draft = freierEntwurf();
    const core = stripInvoiceDraftForCloud(draft);
    expect(core.companySnapshot).not.toHaveProperty('logoDataUrl');
    expect(core.companySnapshot.companyName).toBe('Alt GmbH');
    const payload = JSON.stringify(
      buildInvoiceDraftCloudPushPayload({ id: draft.id, vorgangId: null, invoiceType: 'rechnung', status: 'active', core }),
    );
    expect(payload).not.toContain('data:image');
  });

  it('C — Umschlag, Freigabejournal und Vorbereitung reisen nie', async () => {
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    const begun = await beginInvoiceDraftFinalization({
      identity: identity(draft),
      expectedRevision: record.revision,
      clientInvoiceId: 'inv-s5-c',
      contentFingerprint: 'fp-s5',
      request: { workspaceId: WS, vorgangId: null, clientInvoiceId: 'inv-s5-c', invoice: { id: 'inv-s5-c', type: 'rechnung' } },
      approvalContext: { reverseCharge13bConfirmed: true },
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    // Ein begonnener Abschluss wird nicht gespiegelt.
    expect(applyLocalDraftCommitToMirror(begun.record, draft)).toBe('skipped');
    const entity = getInvoiceDraftCloudEntity(draft.id)!;
    const reist = JSON.stringify([entity.core, buildInvoiceDraftCloudPushPayload(entity)]);
    for (const verboten of ['finalization', 'preparationRawJson', 'draftRawJson', 'draftSha256', 'approvalContext', 'revision', 'recordCreatedAt', 'localLink', 'inv-s5-c']) {
      expect(reist, verboten).not.toContain(`"${verboten}`);
    }
    // Gerätelokal bleibt gerätelokal: Der Link liegt nur im Spiegel dieses Geräts.
    expect(entity.localLink?.draftSha256).toBe(record.draftSha256);
  });

  it('D — die §13b-Bestätigung reist nicht', async () => {
    const draft = freierEntwurf({ taxStatus: 'reverse_charge_13b' });
    const record = await lokalAnlegen(draft);
    writeReverseChargeConfirmation({
      sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung', draftId: draft.id, draftSha256: record.draftSha256,
    });
    applyLocalDraftCommitToMirror(record, draft);
    const entity = getInvoiceDraftCloudEntity(draft.id)!;
    expect(entity.core?.taxStatus, 'der Steuerfall reist').toBe('reverse_charge_13b');
    const payload = JSON.stringify(buildInvoiceDraftCloudPushPayload(entity));
    expect(payload).not.toMatch(/reverseCharge13bConfirmed|reverse-charge-confirmation|confirmedAt/);
  });

  it('E — abgeleitete Mengen und Abzüge werden nicht dupliziert', () => {
    const core = stripInvoiceDraftForCloud({ ...auftragsEntwurf(), previousAbschlagDeductions: [{ invoiceId: 'i', invoiceNumber: '1', date: '2026-01-01', subtotal: 1, amount: 1 }] });
    for (const position of core.positions) {
      for (const key of ['plannedQuantity', 'executedQuantity', 'billedQuantity', 'openQuantity']) {
        expect(position).not.toHaveProperty(key);
      }
    }
    expect(core).not.toHaveProperty('previousAbschlagDeductions');
    expect(core).not.toHaveProperty('invoiceNumberPreview');
  });
});

/* ------------------------------------------------------------------ */
/* F–K — Öffnen eines Slots                                            */
/* ------------------------------------------------------------------ */

describe('S5-F..K — lokal und Cloud beim Öffnen', () => {
  it('F — nur in der Cloud: Gerät B setzt denselben Entwurf mit derselben Kennung fort', async () => {
    cloudFreigeben();
    const a = auftragsEntwurf();
    abgleich([zeile(stripInvoiceDraftForCloud(a), 3)]);

    const b = resolveCloudDraftForEmptySlot(VORGANG, 'rechnung');
    expect(b?.id).toBe(a.id);
    expect(b?.invoiceNumberPreview).toBe('ENTWURF');
    const record = await lokalAnlegen(b!);
    applyLocalDraftCommitToMirror(record, b!);
    persistAll();
    expect(entwurfsAuftraege(), 'keine Rücksendung des eben geladenen Stands').toEqual([]);
  });

  it('G — nur lokal: der Entwurf wird gespiegelt und mit Version 0 angelegt', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    expect(applyLocalDraftCommitToMirror(record, draft)).toBe('created');
    expect(entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation])).toEqual([[draft.id, 'create']]);

    const upsert = sendenMit((payload, version) => {
      expect(version).toBe(0);
      expect(Object.keys(payload).sort()).toEqual(['deleted', 'draft_id', 'invoice_type', 'payload', 'vorgang_id']);
      expect(payload.vorgang_id).toBeNull();
      return { rowVersion: 1 };
    });
    await senden();
    expect(upsert.mock.calls.filter((call) => call[1] === 'invoice_draft')).toHaveLength(1);
    expect(getInvoiceDraftCloudEntity(draft.id)?.sync?.version).toBe(1);
  });

  it('H — identisch: kein Push, keine Änderung', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    persistAll();
    const vorher = getSyncOutboxSnapshot().length;
    expect(applyLocalDraftCommitToMirror(record, draft)).toBe('in_sync');
    expect(reconcileInvoiceDraftOnOpen({ record, draft })).toEqual({ kind: 'none' });
    expect(getSyncOutboxSnapshot().length).toBe(vorher);
  });

  it('I — Cloud neuer, lokal sauber: still und sicher übernommen', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);

    const neuer = stripInvoiceDraftForCloud({ ...draft, introText: 'Von Gerät A geändert' });
    abgleich([zeile(neuer, 2)]);

    const decision = reconcileInvoiceDraftOnOpen({ record, draft });
    expect(decision.kind).toBe('adopt_remote');
    if (decision.kind !== 'adopt_remote') return;
    expect(decision.draft.introText).toBe('Von Gerät A geändert');
    // Das Legacy-Logo dieses Geräts bleibt lokal.
    expect(decision.draft.companySnapshot.logoDataUrl).toBe('data:image/png;base64,QUJD');
  });

  it('I2 — nach der stillen Übernahme ist der nächste bestätigte Stand gleich dem Spiegel (kein Scheinkonflikt, kein Push)', async () => {
    cloudFreigeben();
    const draft = auftragsEntwurf();
    let record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);
    abgleich([zeile(stripInvoiceDraftForCloud({ ...draft, introText: 'Von Gerät A' }), 2)]);

    const decision = reconcileInvoiceDraftOnOpen({ record, draft });
    if (decision.kind !== 'adopt_remote') throw new Error(decision.kind);
    record = await lokalSpeichern(decision.draft, record.revision);
    expect(applyLocalDraftCommitToMirror(record, decision.draft)).toBe('in_sync');
    expect(reconcileInvoiceDraftOnOpen({ record, draft: decision.draft })).toEqual({ kind: 'none' });
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);
  });

  it('J — Cloud neuer, lokal geändert: sichtbarer Konflikt, nichts überschrieben', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    let record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);

    // Lokal weitergearbeitet, aber noch nicht gespiegelt (Bündelung, Absturz).
    const lokal = { ...draft, introText: 'Hier geändert' };
    record = await lokalSpeichern(lokal, record.revision);
    // Inzwischen hat die Cloud eine andere Fassung.
    abgleich([zeile(stripInvoiceDraftForCloud({ ...draft, introText: 'Dort geändert' }), 2)]);

    const decision = reconcileInvoiceDraftOnOpen({ record, draft: lokal });
    expect(decision.kind).toBe('conflict');
    if (decision.kind !== 'conflict') return;
    expect(decision.conflict.kind).toBe('version');
    expect(decision.conflict.remote?.core?.introText).toBe('Dort geändert');
    expect(getInvoiceDraftCloudEntity(draft.id)?.core?.introText, 'Spiegel unangetastet').toBe('Dort geändert');
    expect(entwurfsAuftraege(), 'kein Push über den fremden Stand').toEqual([]);
  });

  it('J2 — eigener Push ausstehend, Cloud neuer: Konflikt am Spiegel mit beiden Ständen', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    let record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);
    const lokal = { ...draft, introText: 'Hier geändert' };
    record = await lokalSpeichern(lokal, record.revision);
    applyLocalDraftCommitToMirror(record, lokal);
    expect(entwurfsAuftraege()).toHaveLength(1);

    const result = abgleich([zeile(stripInvoiceDraftForCloud({ ...draft, introText: 'Dort geändert' }), 2)]);
    expect(result.conflicts).toContain(`invoice_draft:${draft.id}`);
    const entity = getInvoiceDraftCloudEntity(draft.id)!;
    expect(entity.core?.introText, 'der eigene Stand bleibt').toBe('Hier geändert');
    expect(entity.sync?.version, 'mit seiner alten Version').toBe(1);
    expect(entity.conflict?.remote?.core?.introText).toBe('Dort geändert');
  });

  it('K — zwei offline erzeugte Entwürfe im selben Slot: ausdrücklicher Konflikt, kein Altbestand-Kreislauf', async () => {
    cloudFreigeben();
    const eigener = freierEntwurf({ id: 'draft-offline-b' });
    const record = await lokalAnlegen(eigener);
    applyLocalDraftCommitToMirror(record, eigener);
    const fremd = stripInvoiceDraftForCloud(freierEntwurf({ id: 'draft-offline-a', introText: 'Gerät A' }));

    const result = abgleich([zeile(fremd, 1)]);
    expect(result.conflicts).toContain('invoice_draft_slot:draft-offline-b');
    const conflict = getInvoiceDraftCloudConflict('draft-offline-b');
    expect(conflict).toMatchObject({ kind: 'slot', slotDraftId: 'draft-offline-a' });
    expect(planInvoiceDraftBackfill(getInvoiceDraftCloudSnapshot(), [zeile(fremd, 1)])).toEqual([]);
    // Ein leerer Slot (anderes Gerät) setzte nur den unbestrittenen Cloud-Entwurf fort — nie den umstrittenen.
    expect(resolveCloudDraftForEmptySlot(null, 'rechnung')?.id).toBe('draft-offline-a');
  });

  it('K2 — Slot: „anderen übernehmen" ersetzt den eigenen Entwurf durch den fremden', async () => {
    cloudFreigeben();
    const eigener = freierEntwurf({ id: 'draft-offline-b' });
    const record = await lokalAnlegen(eigener);
    applyLocalDraftCommitToMirror(record, eigener);
    abgleich([zeile(stripInvoiceDraftForCloud(freierEntwurf({ id: 'draft-offline-a', introText: 'Gerät A' })), 1)]);

    const decision = await adoptSlotOwnerDraft(record);
    expect(decision).toEqual({ ok: true, reload: true });
    const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung' });
    expect(loaded.ok && loaded.record.draftId).toBe('draft-offline-a');
    expect(loaded.ok && loaded.draft.introText).toBe('Gerät A');
    expect(getInvoiceDraftCloudEntity('draft-offline-b')).toBeNull();
  });

  it('K3 — Slot: „meinen behalten" verwirft den fremden über die bestehende Kette', async () => {
    cloudFreigeben();
    const eigener = freierEntwurf({ id: 'draft-offline-b' });
    const record = await lokalAnlegen(eigener);
    applyLocalDraftCommitToMirror(record, eigener);
    abgleich([zeile(stripInvoiceDraftForCloud(freierEntwurf({ id: 'draft-offline-a' })), 4)]);

    expect(keepOwnDraftDiscardSlotOwner(record)).toEqual({ ok: true, reload: false });
    const fremd = getInvoiceDraftCloudEntity('draft-offline-a')!;
    expect(fremd.sync?.deleted).toBe(true);
    expect(fremd.sync?.version, 'gegen die bekannte Version').toBe(4);
    expect(entwurfsAuftraege().find((entry) => entry.entityId === 'draft-offline-a')?.operation).toBe('delete');
    expect(getInvoiceDraftCloudEntity('draft-offline-b')?.conflict).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* L–M — Grabsteine                                                     */
/* ------------------------------------------------------------------ */

describe('S5-L..M — verworfen und finalisiert werden nie wiederbelebt', () => {
  it('L — anderswo verworfen: Hinweis statt stillem Löschen, kein Push, Fortsetzen nur mit neuer Kennung', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 2, { deleted: true })]);

    const decision = reconcileInvoiceDraftOnOpen({ record, draft });
    expect(decision).toMatchObject({ kind: 'conflict', conflict: { kind: 'deleted' } });
    expect(applyLocalDraftCommitToMirror(record, { ...draft, introText: 'trotzdem' })).toBe('blocked');
    persistAll();
    expect(entwurfsAuftraege(), 'kein Wiederbeleben über den Spiegel').toEqual([]);
    expect(await runInvoiceDraftCloudBackfillOnce(WS)).toMatchObject({ mirrored: 0, skippedKnown: 1 });

    const fortgesetzt = await continueDraftAsNew(record, draft);
    expect(fortgesetzt).toEqual({ ok: true, reload: true });
    const neu = getInvoiceDraftCloudSnapshot().find((entity) => entity.id !== draft.id && !entity.sync?.deleted);
    expect(neu?.id).toMatch(/^draft-/);
    expect(neu?.id).not.toBe(draft.id);
    expect(getInvoiceDraftCloudEntity(draft.id)?.sync?.deleted, 'die alte Kennung bleibt verworfen').toBe(true);
    expect(entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation])).toEqual([[neu!.id, 'create']]);
  });

  it('L2 — Verwerfen bestätigen: Grabstein bleibt, lokaler Entwurf weg, kein Push', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);
    abgleich([zeile(null, 2, { id: draft.id, deleted: true, vorgangId: null })]);
    reconcileInvoiceDraftOnOpen({ record, draft });

    expect(await acceptCloudDraftEnd(record)).toEqual({ ok: true, reload: true });
    const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung' });
    expect(loaded.ok).toBe(false);
    expect(getInvoiceDraftCloudEntity(draft.id)).toMatchObject({ core: null, sync: { deleted: true, version: 2 } });
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);
    expect(resolveCloudDraftForEmptySlot(null, 'rechnung'), 'ein Grabstein wird nie neu angelegt').toBeNull();
  });

  it('M — anderswo finalisiert: Hinweis mit Rechnung, keine Wiederbelebung, kein Push', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 1)]);
    applyLocalDraftCommitToMirror(record, draft);
    abgleich([zeile(null, 2, { id: draft.id, finalized: 'inv-a', vorgangId: null })]);

    const decision = reconcileInvoiceDraftOnOpen({ record, draft });
    expect(decision).toMatchObject({ kind: 'conflict', conflict: { kind: 'finalized', remote: { finalizedClientInvoiceId: 'inv-a' } } });
    expect(await continueDraftAsNew(record, draft), 'Fortsetzen nur nach Verwerfen').toEqual({ ok: false, reason: 'not_allowed' });
    expect(keepLocalDraftVersion(record, draft)).toEqual({ ok: false, reason: 'no_conflict' });

    const end = await acceptCloudDraftEnd(record);
    expect(end).toEqual({ ok: true, reload: true, finalizedInvoiceId: 'inv-a' });
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);
    expect(resolveCloudDraftForEmptySlot(null, 'rechnung')).toBeNull();
  });

  it('M2 — eigene Freigabe: der Spiegel vermerkt den Abschluss vor dem Rollover (kein Wiederauftauchen)', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    const begun = await beginInvoiceDraftFinalization({
      identity: identity(draft),
      expectedRevision: record.revision,
      clientInvoiceId: 'inv-eigen',
      contentFingerprint: 'fp',
      request: { workspaceId: WS, vorgangId: null, clientInvoiceId: 'inv-eigen', invoice: { id: 'inv-eigen', type: 'rechnung' } },
      approvalContext: {},
    });
    if (!begun.ok) throw new Error(begun.reason);
    const done = await completeInvoiceDraftFinalization({
      identity: identity(draft),
      expectedRevision: begun.record.revision,
      clientInvoiceId: 'inv-eigen',
      contentFingerprint: 'fp',
      finalizedInvoiceId: 'inv-eigen',
      archiveWarning: false,
    });
    if (!done.ok) throw new Error(done.reason);

    markInvoiceDraftCloudFromFinalizedRecord(done.record);
    expect(getInvoiceDraftCloudEntity(draft.id)).toMatchObject({ status: 'finalized', finalizedClientInvoiceId: 'inv-eigen', core: null });
    expect(resolveCloudDraftForEmptySlot(null, 'rechnung')).toBeNull();
    persistAll();
    expect(entwurfsAuftraege(), 'ein lokal beendeter Entwurf wird nicht gesendet').toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* N–P — Altbestand                                                     */
/* ------------------------------------------------------------------ */

describe('S5-N..P — einmaliger, idempotenter Altbestand', () => {
  it('N — aktive Entwürfe des Workspace werden mit ihrer Kennung gespiegelt, genau einmal', async () => {
    const frei = freierEntwurf();
    const auftrag = auftragsEntwurf();
    await lokalAnlegen(frei);
    await lokalAnlegen(auftrag);
    // Ein Entwurf eines anderen Workspace bleibt unberührt.
    const fremd = freierEntwurf({ id: 'draft-fremd' });
    await createInvoiceDraftRecord({
      identity: { sourceScopeKey: 'workspace:ws-fremd', workspaceId: 'ws-fremd', vorgangId: null, invoiceType: 'rechnung', draftId: fremd.id },
      draft: fremd,
    });

    const report = await runInvoiceDraftCloudBackfillOnce(WS);
    expect(report).toMatchObject({ mirrored: 2, skippedNotActive: 0, skippedKnown: 0 });
    expect(getInvoiceDraftCloudSnapshot().map((entity) => entity.id).sort()).toEqual([auftrag.id, frei.id].sort());
    expect(getInvoiceDraftCloudEntity(frei.id)?.core?.companySnapshot).not.toHaveProperty('logoDataUrl');
    expect(entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation, entry.version]).sort()).toEqual(
      [[auftrag.id, 'create', 1], [frei.id, 'create', 1]].sort(),
    );
    expect(await runInvoiceDraftCloudBackfillOnce(WS), 'nur einmal je Lauf').toBeNull();
  });

  it('O/P — begonnene und abgeschlossene Freigaben werden nicht übernommen', async () => {
    const begonnen = freierEntwurf();
    const record = await lokalAnlegen(begonnen);
    await beginInvoiceDraftFinalization({
      identity: identity(begonnen),
      expectedRevision: record.revision,
      clientInvoiceId: 'inv-o',
      contentFingerprint: 'fp',
      request: { workspaceId: WS, vorgangId: null, clientInvoiceId: 'inv-o', invoice: { id: 'inv-o', type: 'rechnung' } },
      approvalContext: {},
    });
    const fertig = auftragsEntwurf();
    const fertigRecord = await lokalAnlegen(fertig);
    const b2 = await beginInvoiceDraftFinalization({
      identity: identity(fertig),
      expectedRevision: fertigRecord.revision,
      clientInvoiceId: 'inv-p',
      contentFingerprint: 'fp',
      request: { workspaceId: WS, vorgangId: VORGANG, clientInvoiceId: 'inv-p', invoice: { id: 'inv-p', type: 'rechnung' } },
      approvalContext: {},
    });
    if (!b2.ok) throw new Error(b2.reason);
    await completeInvoiceDraftFinalization({
      identity: identity(fertig),
      expectedRevision: b2.record.revision,
      clientInvoiceId: 'inv-p',
      contentFingerprint: 'fp',
      finalizedInvoiceId: 'inv-p',
      archiveWarning: false,
    });

    const report = await runInvoiceDraftCloudBackfillOnce(WS);
    expect(report).toMatchObject({ mirrored: 0, skippedNotActive: 2 });
    expect(getInvoiceDraftCloudSnapshot()).toEqual([]);
    expect(entwurfsAuftraege()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Q–R — Versionskonflikt und bewusste Auflösung                       */
/* ------------------------------------------------------------------ */

describe('S5-Q..R — Versionskonflikt ohne Last-Write-Wins', () => {
  async function konfliktAufbauen() {
    cloudFreigeben();
    const draft = freierEntwurf();
    let record = await lokalAnlegen(draft);
    abgleich([zeile(stripInvoiceDraftForCloud(draft), 2)]);
    applyLocalDraftCommitToMirror(record, draft);
    const lokal = { ...draft, introText: 'Hier geändert' };
    record = await lokalSpeichern(lokal, record.revision);
    applyLocalDraftCommitToMirror(record, lokal);
    // Der Server kennt inzwischen Version 3 → der Versand wird abgewiesen.
    sendenMit(() => new workspaceCloudService.WorkspaceCloudError('Versionskonflikt invoice_draft:3', 'version_conflict', false));
    await senden();
    expect(entwurfsAuftraege()[0]?.status).toBe('blocked');
    abgleich([zeile(stripInvoiceDraftForCloud({ ...draft, introText: 'Dort geändert' }), 3)]);
    return { draft, lokal, record };
  }

  it('Q — veraltete Version: blockiert, beide Stände festgehalten', async () => {
    const { draft } = await konfliktAufbauen();
    const entity = getInvoiceDraftCloudEntity(draft.id)!;
    expect(entity.conflict).toMatchObject({ kind: 'version', remote: { rowVersion: 3 } });
    expect(entity.core?.introText).toBe('Hier geändert');
  });

  it('R1 — „Meine Fassung behalten": bewusster Schreibversuch gegen die zuletzt geladene Version 3', async () => {
    const { record, lokal } = await konfliktAufbauen();
    vi.restoreAllMocks();
    cloudFreigeben();
    expect(keepLocalDraftVersion(record, lokal)).toEqual({ ok: true, reload: false });
    const upsert = sendenMit((payload, version) => {
      expect(version).toBe(3);
      expect((payload.payload as { introText: string }).introText).toBe('Hier geändert');
      return { rowVersion: 4 };
    });
    await senden();
    expect(upsert.mock.calls.filter((call) => call[1] === 'invoice_draft')).toHaveLength(1);
    expect(getInvoiceDraftCloudEntity(lokal.id)?.sync?.version).toBe(4);
  });

  it('R2 — „Cloud-Fassung übernehmen": lokal ersetzt, Mengen neu, kein Push, §13b verfällt', async () => {
    const { record, lokal } = await konfliktAufbauen();
    writeReverseChargeConfirmation({
      sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung', draftId: lokal.id, draftSha256: record.draftSha256,
    });
    const result = await takeCloudDraftVersion(record, lokal);
    expect(result).toEqual({ ok: true, reload: true });
    const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung' });
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.draft.introText).toBe('Dort geändert');
    expect(loaded.draft.companySnapshot.logoDataUrl, 'Legacy-Logo bleibt gerätelokal').toBe('data:image/png;base64,QUJD');
    expect(getInvoiceDraftCloudEntity(lokal.id)).toMatchObject({ sync: { version: 3 }, core: { introText: 'Dort geändert' } });
    expect(getInvoiceDraftCloudEntity(lokal.id)?.conflict).toBeUndefined();
    persistAll();
    expect(entwurfsAuftraege(), 'keine leere neue Serverversion').toEqual([]);
    expect(
      hasValidReverseChargeConfirmation({
        sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung', draftId: lokal.id, draftSha256: loaded.record.draftSha256,
      }),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* S–T — mehrere Tabs, offline                                          */
/* ------------------------------------------------------------------ */

describe('S5-S..T — mehrere Tabs und offline', () => {
  it('S — ein veralteter Tab speichert nicht und spiegelt nichts', async () => {
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    // Tab A speichert.
    const a = await lokalSpeichern({ ...draft, introText: 'Tab A' }, record.revision);
    applyLocalDraftCommitToMirror(a, { ...draft, introText: 'Tab A' });
    // Tab B hält die alte Revision und speichert.
    const b = await saveInvoiceDraftRecord({ identity: identity(draft), draft: { ...draft, introText: 'Tab B' }, expectedRevision: record.revision });
    expect(b).toMatchObject({ ok: false, reason: 'conflict' });
    expect(getInvoiceDraftCloudEntity(draft.id)?.core?.introText, 'nur der bestätigte Stand reist').toBe('Tab A');
  });

  it('T — offline angelegt und bearbeitet, später gesendet; ein Netzfehler zerstört nichts', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    let record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    const zwei = { ...draft, introText: 'Offline weitergeschrieben' };
    record = await lokalSpeichern(zwei, record.revision);
    applyLocalDraftCommitToMirror(record, zwei);

    sendenMit(() => new workspaceCloudService.WorkspaceCloudError('Failed to fetch', 'network', true));
    await senden();
    expect(entwurfsAuftraege()[0]?.status).toBe('error');
    const lokal = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung' });
    expect(lokal.ok && lokal.draft.introText, 'der lokale Stand bleibt').toBe('Offline weitergeschrieben');

    vi.restoreAllMocks();
    cloudFreigeben();
    sendenMit((payload, version) => {
      expect(version).toBe(0);
      expect((payload.payload as { introText: string }).introText).toBe('Offline weitergeschrieben');
      return { rowVersion: 1 };
    });
    await senden();
    expect(entwurfsAuftraege()).toEqual([]);
    expect(getInvoiceDraftCloudEntity(draft.id)?.sync?.version).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* U–W — §13b, Snapshots, Live-Mengen                                   */
/* ------------------------------------------------------------------ */

describe('S5-U..W — was reist und was neu entsteht', () => {
  it('U — §13b: Gerät B muss selbst bestätigen', async () => {
    cloudFreigeben();
    const a = freierEntwurf({ taxStatus: 'reverse_charge_13b' });
    const aRecord = await lokalAnlegen(a);
    writeReverseChargeConfirmation({
      sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung', draftId: a.id, draftSha256: aRecord.draftSha256,
    });
    // Gerät B: eigener localStorage, eigene IndexedDB.
    localStorage.clear();
    await resetInvoiceDraftDurabilityDatabaseForTests();
    resetInvoiceDraftCloudStore();
    abgleich([zeile(stripInvoiceDraftForCloud(a), 1)]);
    const b = resolveCloudDraftForEmptySlot(null, 'rechnung')!;
    expect(b.taxStatus, 'der Steuerfall reist').toBe('reverse_charge_13b');
    const bRecord = await lokalAnlegen(b);
    expect(
      hasValidReverseChargeConfirmation({
        sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung', draftId: b.id, draftSha256: bRecord.draftSha256,
      }),
    ).toBe(false);
  });

  it('V — eingefrorene Snapshots bleiben eingefroren, auch wenn Gerät B anders eingerichtet ist', () => {
    cloudFreigeben();
    const a = freierEntwurf({ paymentTermsText: 'Zahlbar in 21 Tagen', skontoText: '2 % in 8 Tagen' });
    abgleich([zeile(stripInvoiceDraftForCloud(a), 1)]);
    const b = resolveCloudDraftForEmptySlot(null, 'rechnung')!;
    expect(b.companySnapshot.companyName).toBe('Alt GmbH');
    expect(b.customerBilling).toEqual(a.customerBilling);
    expect(b.customerId).toBe('cust-s5');
    expect(b.paymentTermsText).toBe('Zahlbar in 21 Tagen');
    expect(b.skontoText).toBe('2 % in 8 Tagen');
    expect(b.legalNotices).toEqual(a.legalNotices);
    expect(b.brandingSnapshot).toEqual(a.brandingSnapshot);
    expect(b.currencyCode).toBe(a.currencyCode);
    expect(b.companySnapshot).not.toHaveProperty('logoDataUrl');
  });

  it('W — Live-Mengen und Abzüge werden auf B aus Auftrag und Rechnungen neu abgeleitet (Äquivalenz)', () => {
    cloudFreigeben();
    const vorgang = getVorgangById(VORGANG)!;
    const a = auftragsEntwurf();
    const aAktuell = refreshDraftOrderProjection(a, vorgang).draft;
    abgleich([zeile(stripInvoiceDraftForCloud(a), 1)]);
    const b = rehydrateInvoiceDraftFromCloudCore(getInvoiceDraftCloudEntity(a.id)!.core!);
    const { logoDataUrl: _logo, ...aFirma } = aAktuell.companySnapshot;
    expect({ ...b, companySnapshot: b.companySnapshot }).toEqual({ ...aAktuell, companySnapshot: aFirma });
    expect(b.positions[0]).toMatchObject({ plannedQuantity: 20, executedQuantity: 12, billedQuantity: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* AE — keine Sync-Schleife; Bindung; Verwerfen                         */
/* ------------------------------------------------------------------ */

describe('S5-AE — keine Schleife, Bindung, sichtbares Verwerfen', () => {
  it('AE — wiederholtes Speichern ohne fachliche Änderung erzeugt keinen Push; ein Abzug derselben Fassung ebenso', async () => {
    cloudFreigeben();
    const draft = auftragsEntwurf();
    let record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    sendenMit(() => ({ rowVersion: 1 }));
    await senden();
    expect(entwurfsAuftraege()).toEqual([]);

    // Nur die Auftragsprojektion ändert sich (Ist-Menge) — der Kern bleibt.
    const projiziert = { ...draft, positions: draft.positions.map((p) => ({ ...p, executedQuantity: 99, openQuantity: 1 })) };
    record = await lokalSpeichern(projiziert, record.revision);
    expect(applyLocalDraftCommitToMirror(record, projiziert)).toBe('in_sync');
    for (let i = 0; i < 3; i += 1) applyLocalDraftCommitToMirror(record, projiziert);
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);

    // Ein Abzug derselben Fassung (jsonb mit anderer Schlüsselreihenfolge) ist keine Änderung.
    const core = stripInvoiceDraftForCloud(draft);
    const umsortiert = Object.fromEntries(Object.entries(core).reverse()) as unknown as InvoiceDraftCloudCore;
    expect(buildInvoiceDraftCoreKey(umsortiert)).toBe(buildInvoiceDraftCoreKey(core));
    abgleich([zeile(umsortiert, 1)]);
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);
  });

  it('AE2 — Bindung: ohne Freigabe der Cloud-Seite keine; mit ihr nur für einen vollständig angekommenen Entwurf', async () => {
    disableInvoiceDraftCloudSyncForTests();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    expect(resolveInvoiceDraftCloudBinding(draft)).toEqual({ ok: true, binding: null });

    cloudFreigeben();
    expect(resolveInvoiceDraftCloudBinding(draft)).toEqual({ ok: false, reason: 'draft_not_synced' });
    sendenMit(() => ({ rowVersion: 1 }));
    await senden();
    expect(resolveInvoiceDraftCloudBinding(draft)).toEqual({
      ok: true,
      binding: { clientDraftId: draft.id, expectedDraftRowVersion: 1 },
    });
    expect(resolveInvoiceDraftCloudBinding({ ...draft, introText: 'nicht gespiegelt' })).toEqual({ ok: false, reason: 'draft_not_synced' });
  });

  it('AE3 — sichtbares Verwerfen: erst Grabstein, dann lokal weg; keine Rechnung berührt', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    applyLocalDraftCommitToMirror(record, draft);
    sendenMit(() => ({ rowVersion: 1 }));
    await senden();
    vi.restoreAllMocks();
    cloudFreigeben();

    expect(await discardInvoiceDraft(record, draft)).toEqual({ ok: true, reload: true });
    const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WS, vorgangId: null, invoiceType: 'rechnung' });
    expect(loaded.ok).toBe(false);
    expect(entwurfsAuftraege().map((entry) => [entry.entityId, entry.operation])).toEqual([[draft.id, 'delete']]);
    sendenMit((payload, version) => {
      expect(version).toBe(1);
      expect(payload.deleted).toBe(true);
      expect(payload.payload).toEqual({});
      return { rowVersion: 2 };
    });
    await senden();
    expect(getInvoiceDraftCloudEntity(draft.id)?.sync).toMatchObject({ deleted: true, version: 2 });
    expect(resolveCloudDraftForEmptySlot(null, 'rechnung')).toBeNull();
  });

  it('AF — zwei Editoren desselben Entwurfs: der Spiegel folgt nur dem jüngeren Stand, nie hin und her', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const r1 = await lokalAnlegen(draft);
    expect(applyLocalDraftCommitToMirror(r1, draft)).toBe('created');
    const neu = { ...draft, introText: 'Revision 2' };
    const r2 = await lokalSpeichern(neu, r1.revision);
    expect(applyLocalDraftCommitToMirror(r2, neu)).toBe('mirrored');

    const persistAufrufe = vi.spyOn(persistence, 'persistAll');
    // Der veraltete Editor (Revision 1) meldet sich erneut — er berührt den Spiegel nicht.
    for (let i = 0; i < 5; i += 1) {
      expect(applyLocalDraftCommitToMirror(r1, draft)).toBe('stale');
      expect(reconcileInvoiceDraftOnOpen({ record: r1, draft })).toEqual({ kind: 'none' });
    }
    // Derselbe Rang mit anderem Inhalt (z. B. eine verwaiste Instanz) ist ebenso veraltet: der erste Stand bleibt.
    expect(applyLocalDraftCommitToMirror({ ...r2, draftSha256: 'f'.repeat(64) }, draft)).toBe('stale');
    expect(persistAufrufe).not.toHaveBeenCalled();
    expect(getInvoiceDraftCloudEntity(draft.id)?.core?.introText).toBe('Revision 2');

    // Eine später angelegte Linie (z. B. nach verlorener IndexedDB aus der Cloud neu angelegt) folgt dagegen.
    const spaeter = { ...r2, createdAt: '2099-01-01T00:00:00.000Z', revision: 1, draftSha256: 'e'.repeat(64) };
    expect(applyLocalDraftCommitToMirror(spaeter, neu)).toBe('in_sync');
    expect(getInvoiceDraftCloudEntity(draft.id)?.localLink).toMatchObject({ recordCreatedAt: '2099-01-01T00:00:00.000Z', revision: 1 });
    expect(applyLocalDraftCommitToMirror(r2, neu), 'die ältere Linie ist danach veraltet').toBe('stale');
  });

  it('AG — der Abgleich beim Öffnen schreibt nichts: kein Anlegen, kein Spiegeln, keine Link-Pflege', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const r1 = await lokalAnlegen(draft);
    const persistAufrufe = vi.spyOn(persistence, 'persistAll');
    // Nie gespiegelt: Das übernimmt der Speicherweg, nicht der Abgleich.
    expect(reconcileInvoiceDraftOnOpen({ record: r1, draft })).toEqual({ kind: 'none' });
    expect(getInvoiceDraftCloudEntity(draft.id)).toBeNull();
    expect(persistAufrufe).not.toHaveBeenCalled();

    persistAufrufe.mockRestore();
    applyLocalDraftCommitToMirror(r1, draft);
    const neu = { ...draft, introText: 'lokal neuer' };
    const r2 = await lokalSpeichern(neu, r1.revision);
    const zweiter = vi.spyOn(persistence, 'persistAll');
    // Lokal neuer: Der Abgleich lässt den Spiegel stehen — der Speicherweg spiegelt.
    expect(reconcileInvoiceDraftOnOpen({ record: r2, draft: neu })).toEqual({ kind: 'none' });
    expect(getInvoiceDraftCloudEntity(draft.id)?.core?.introText).toBe('Einleitung A');
    expect(zweiter).not.toHaveBeenCalled();
  });

  it('AH — Cloud-Seite gesperrt (Phase 1 / Notausschalter): der Spiegel ist nur ein lokaler Schatten, die Editoren bleiben wie vor S5', async () => {
    disableInvoiceDraftCloudSyncForTests();
    // Ein Entwurf wird bestätigt und still gespiegelt …
    const x = freierEntwurf({ id: 'draft-schatten-x', introText: 'Erster Entwurf' });
    const rx = await lokalAnlegen(x);
    expect(applyLocalDraftCommitToMirror(rx, x)).toBe('created');
    // … dann ist die IndexedDB leer (zurückgesetzt): Der Slot beginnt wie bisher neu, nichts wird aus dem Spiegel fortgesetzt.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    expect(resolveCloudDraftForEmptySlot(null, 'rechnung')).toBeNull();

    // Ein neuer Entwurf im selben Slot: kein Slot-Konflikt, kein Sperren, kein Abgleich.
    const y = freierEntwurf({ id: 'draft-schatten-y', introText: 'Neuer Entwurf' });
    const ry = await lokalAnlegen(y);
    expect(applyLocalDraftCommitToMirror(ry, y)).toBe('created');
    expect(getInvoiceDraftCloudEntity(y.id)?.conflict).toBeUndefined();
    expect(getInvoiceDraftCloudConflict(y.id)).toBeNull();
    expect(reconcileInvoiceDraftOnOpen({ record: ry, draft: y })).toEqual({ kind: 'none' });
    // Ohne Cloud-Seite gibt es keine Bindung: die Freigabe läuft wie bisher.
    expect(resolveInvoiceDraftCloudBinding(y)).toEqual({ ok: true, binding: null });
    // Der Schatten folgt dem bestätigten lokalen Stand.
    const y2 = { ...y, introText: 'Weitergeschrieben' };
    const ry2 = await lokalSpeichern(y2, ry.revision);
    expect(applyLocalDraftCommitToMirror(ry2, y2)).toBe('mirrored');
    expect(getInvoiceDraftCloudEntity(y.id)?.core?.introText).toBe('Weitergeschrieben');

    // Gegenprobe: Mit freigegebener Cloud-Seite und einem dem Server bekannten Entwurf im Slot entstünde ein sichtbarer Slot-Konflikt.
    cloudFreigeben();
    const bekannt = getInvoiceDraftCloudEntity(x.id)!;
    putInvoiceDraftCloudEntity({ ...bekannt, sync: { version: 2, deleted: false, updatedAt: UPDATED_AT, deviceId: 'device-anderes', workspaceId: WS } });
    const z = freierEntwurf({ id: 'draft-schatten-z' });
    await resetInvoiceDraftDurabilityDatabaseForTests();
    const rz = await lokalAnlegen(z);
    expect(applyLocalDraftCommitToMirror(rz, z)).toBe('conflict');
    expect(getInvoiceDraftCloudConflict(z.id)).toMatchObject({ kind: 'slot' });
  });

  it('AI — Workspace-Wechsel: ein noch gebündelter Entwurf des alten Bereichs landet nie im Spiegel des neuen', async () => {
    cloudFreigeben();
    const draft = freierEntwurf();
    const record = await lokalAnlegen(draft);
    noteInvoiceDraftCommitted(record, draft);

    // Bereichswechsel: Der Spiegel des alten Bereichs wird geleert — die wartende Spiegelung verfällt mit.
    resetInvoiceDraftCloudStore();
    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-anderer-betrieb' });
    expect(flushInvoiceDraftCloudMirror(), 'nichts wartet mehr').toEqual([]);
    expect(getInvoiceDraftCloudSnapshot()).toEqual([]);

    // Selbst ein direkt gemeldeter Stand des alten Bereichs wird abgewiesen.
    expect(applyLocalDraftCommitToMirror(record, draft)).toBe('skipped');
    expect(reconcileInvoiceDraftOnOpen({ record, draft })).toEqual({ kind: 'none' });
    expect(getInvoiceDraftCloudSnapshot()).toEqual([]);
    persistAll();
    expect(entwurfsAuftraege()).toEqual([]);
  });

  it('AE4 — ein Spiegel ohne Inhalt und ohne Konflikt ist kein Altbestand', () => {
    putInvoiceDraftCloudEntity({ id: 'x', vorgangId: null, invoiceType: 'rechnung', status: 'finalized', core: null, finalizedClientInvoiceId: 'inv-x' });
    expect(planInvoiceDraftBackfill(getInvoiceDraftCloudSnapshot(), [])).toEqual([]);
  });
});
