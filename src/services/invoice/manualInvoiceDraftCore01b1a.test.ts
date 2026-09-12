/**
 * MANUAL-INVOICE-UI-01B1A — der nullfähige Draft-/Resume-/Prepared-Finalize-Kern.
 *
 * Die Rechnung ohne Auftrag geht denselben Durability-, Recovery-, Confirm-first-
 * und Cloud-Finalize-Weg wie eine Vorgangsrechnung — mit eigener, kollisions-
 * freier Kennung, ohne erfundenen Vorgang. Und: Bestehende Schlüssel für
 * Vorgangsentwürfe bleiben **byteidentisch**.
 *
 * Kein Netzwerk; Supabase, Vorgangs- und Archivspeicher als Attrappen nach dem
 * Muster von `invoicePreparedFinalize01`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvoiceDraft, VorgangInvoice } from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as vorgangService from '../vorgangService';
import * as archiveService from '../invoiceArchiveService';
import * as syncMetaService from '../sync/syncMetaService';
import {
  beginInvoiceDraftFinalization,
  buildInvoiceDraftRecordKey,
  buildManualInvoiceDraftRecordKey,
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  deleteInvoiceDraftRecord,
  resetInvoiceDraftDurabilityDatabaseForTests,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import {
  executePreparedInvoiceFinalization,
  prepareInvoiceDraftFinalization,
} from './invoicePreparedFinalizeService';
import {
  findLocalFinalInvoiceConflict,
  proveLocalInvoice,
} from './invoiceFinalizationCoordinator';
import {
  buildManualInvoiceFinalizeIntentKey,
  buildInvoiceFinalizeIntentKey,
} from './invoiceFinalizeIntentService';
import {
  buildReverseChargeConfirmationKey,
  isValidReverseChargeConfirmation,
  REVERSE_CHARGE_CONFIRMATION_KIND,
  REVERSE_CHARGE_CONFIRMATION_VERSION,
} from './reverseChargeConfirmationService';
import { defaultFinalizedInvoicePresenceCheck } from './useInvoiceDraftDurabilitySession';
import {
  buildInvoiceWizardDraftIdentity,
  resolveResumableInvoiceWizardStep,
} from '../uiSession/invoiceWizardResume';
import { hydrateInvoiceStore, resetInvoiceStore } from './invoiceStore';
import { setActiveStorageScope, resetStorageScopeForTests } from '../storage/storageScopeService';
import { resetTestStores } from '../../test/resetStores';

const WORKSPACE = 'ws-m';
const SCOPE = 'workspace:ws-m';
const VORGANG = 'vg-m-1';
const DRAFT_ID = 'draft-m-1';
const CLIENT_ID = 'inv-m-0001';
const NOW = '2026-09-12T08:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Umgebung                                                            */
/* ------------------------------------------------------------------ */

const cloud = {
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as null | { message: string; code?: string },
  replay: false,
};
const local = {
  manualUpsertCalls: [] as VorgangInvoice[],
  manualUpsert: null as null | ((invoice: VorgangInvoice) => unknown),
  vorgangUpsertCalls: [] as VorgangInvoice[],
  archiveCalls: [] as { vorgangId: string | null; invoice: VorgangInvoice }[],
  getVorgangCalls: 0,
};

function serverEcho(args: Record<string, unknown>) {
  const sent = { ...(args.p_invoice as Record<string, unknown>) };
  for (const key of ['number', 'invoiceSequenceNumber', 'payments', 'paymentStatus', 'archiveDocumentId', 'expectedAmendmentSequence']) {
    delete sent[key];
  }
  const issueDate = String(sent.issueDate ?? sent.date ?? '2026-09-12');
  const invoice = {
    ...sent,
    id: args.p_client_invoice_id,
    number: '2026-0021',
    invoiceSequenceNumber: 21,
    status: 'vorbereitet',
    date: issueDate,
    issueDate,
  };
  return {
    idempotent_replay: cloud.replay,
    invoice,
    row: {
      id: 'cloud-row-m',
      workspace_id: args.p_workspace_id,
      vorgang_id: args.p_vorgang_id,
      client_invoice_id: args.p_client_invoice_id,
      invoice_number: invoice.number,
      invoice_year: 2026,
      invoice_sequence_number: 21,
      invoice_type: invoice.type,
      invoice_status: 'vorbereitet',
      payload: invoice,
      row_version: 1,
      created_at: NOW,
      updated_at: NOW,
      updated_by: null,
    },
  };
}

function installEnvironment(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(() => true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
    () =>
      ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
        rpc: async (name: string, args: Record<string, unknown>) => {
          cloud.rpcCalls.push({ name, args });
          if (cloud.rpcError) return { data: null, error: cloud.rpcError };
          return { data: serverEcho(args), error: null };
        },
      }) as never,
  );
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockImplementation(
    () => ({ workspace: { id: WORKSPACE } }) as never,
  );
  vi.spyOn(vorgangService, 'getVorgangById').mockImplementation((id: string) => {
    local.getVorgangCalls += 1;
    return (id === VORGANG ? { id: VORGANG, invoices: [] } : undefined) as never;
  });
  vi.spyOn(vorgangService, 'upsertFinalizedManualInvoice').mockImplementation((invoice) => {
    local.manualUpsertCalls.push(invoice);
    return (local.manualUpsert?.(invoice) ?? { ok: true, invoice, action: 'inserted' }) as never;
  });
  vi.spyOn(vorgangService, 'upsertFinalizedInvoiceOnVorgang').mockImplementation((_v, invoice) => {
    local.vorgangUpsertCalls.push(invoice);
    return { ok: true, invoice, action: 'inserted' } as never;
  });
  vi.spyOn(archiveService, 'archiveOutgoingInvoice').mockImplementation(
    (vorgangId: string | null, invoice: VorgangInvoice) => {
      local.archiveCalls.push({ vorgangId, invoice });
      return { success: true, invoice, document: { id: 'doc-m' }, created: true } as never;
    },
  );
  vi.spyOn(archiveService, 'syncGeneratedInvoiceDocumentToCloud').mockResolvedValue(
    { outcome: 'synced' } as never,
  );
  vi.spyOn(archiveService, 'isGeneratedInvoiceDocumentSyncSilent').mockReturnValue(true);
  vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => CLIENT_ID);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const COMPANY = {
  companyName: 'Cirmak Haustechnik GmbH',
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  contactPerson: 'Herr Cirmak',
  phone: '0201 999999',
  email: 'buero@cirmak.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function manualDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  return {
    id: DRAFT_ID,
    vorgangId: null,
    customerId: 'cust-1',
    customer: 'Müller Bau GmbH',
    baustelle: '',
    type: 'rechnung',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [
      { id: 'pos-1', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitLabel: 'Pauschal', unitPrice: 45, billable: true },
    ],
    issueDate: '2026-09-12',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-01',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-26',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerBilling: { name: 'Müller Bau GmbH', contactPerson: '', street: 'Hauptstraße 12', zip: '45356', city: 'Essen', email: '', phone: '' },
    companySnapshot: COMPANY,
    legalNotices: [],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: '',
    closingText: '',
    ...overrides,
  } as InvoiceDraft;
}

function manualIdentity(overrides: Partial<InvoiceDraftIdentity> = {}): InvoiceDraftIdentity {
  return { sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung', draftId: DRAFT_ID, ...overrides };
}

const setup = { companyName: COMPANY.companyName, taxStatus: 'standard_19' } as never;

async function seedManualPrepared() {
  const created = await createInvoiceDraftRecord({ identity: manualIdentity(), draft: manualDraft(), now: NOW });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const prepared = await prepareInvoiceDraftFinalization({
    vorgangId: null,
    draft: manualDraft(),
    setup,
    approvalOptions: {},
    overbillingAcknowledged: false,
  });
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) throw new Error('prepare');
  const begun = await beginInvoiceDraftFinalization({
    identity: manualIdentity(),
    expectedRevision: 1,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request as never,
    approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
    now: NOW,
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);
  return prepared;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetTestStores();
  resetInvoiceStore();
  installEnvironment();
  cloud.rpcCalls = [];
  cloud.rpcError = null;
  cloud.replay = false;
  local.manualUpsertCalls = [];
  local.manualUpsert = null;
  local.vorgangUpsertCalls = [];
  local.archiveCalls = [];
  local.getVorgangCalls = 0;
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetStorageScopeForTests();
  await resetInvoiceDraftDurabilityDatabaseForTests();
  resetTestStores();
});

/* ------------------------------------------------------------------ */
/* A — Schlüssel                                                       */
/* ------------------------------------------------------------------ */

describe('01B1A — Draft-Schlüssel', () => {
  /*
   * T1: Der Beweis für den Bestand ist ein **fest kodierter** Schlüsseltext,
   * unabhängig von der Implementierung. Ändert sich das Format, fällt dieser
   * Test — genau das soll er.
   */
  it('T1: ein bestehender Vorgangs-Draft-Key bleibt byteidentisch', () => {
    const key = buildInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, vorgangId: VORGANG, invoiceType: 'abschlag' });
    expect(key).toBe('["officepilot-invoice-draft",1,"workspace:ws-m","vg-m-1","abschlag"]');
  });

  it('T2: der bestehende Vorgangs-UI-Session-Schlüssel bleibt byteidentisch', () => {
    const identity = buildInvoiceWizardDraftIdentity({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: VORGANG, invoiceType: 'abschlag' });
    expect(identity).toBe('workspace:ws-m#ws-m#vg-m-1#abschlag');
    const rc = buildReverseChargeConfirmationKey({ sourceScopeKey: SCOPE, vorgangId: VORGANG, invoiceType: 'rechnung', draftId: DRAFT_ID });
    expect(rc).toBe(`${REVERSE_CHARGE_CONFIRMATION_KIND}:workspace:ws-m:vg-m-1:rechnung:draft-m-1`);
    expect(buildInvoiceFinalizeIntentKey(VORGANG, DRAFT_ID)).toBe(VORGANG);
  });

  it('T3: der Manual-Draft bekommt einen eigenen, kollisionsfreien Schlüssel', () => {
    const manual = buildInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, vorgangId: null, invoiceType: 'rechnung' });
    expect(manual).toBe(buildManualInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, invoiceType: 'rechnung' }));
    expect(manual).toBe('["officepilot-invoice-draft",1,"workspace:ws-m",["manual-invoice",1],"rechnung"]');
    // Kein String-Sentinel: selbst ein Vorgang namens „null" oder „manual" trifft ihn nicht.
    for (const sentinel of ['null', 'manual', 'manual-invoice', '["manual-invoice",1]', '']) {
      expect(buildInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, vorgangId: sentinel, invoiceType: 'rechnung' })).not.toBe(manual);
    }
    // Die Sitzungs- und §13b-Schlüssel folgen derselben Trennung.
    expect(buildInvoiceWizardDraftIdentity({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' })).toMatch(/^\[/);
    expect(buildReverseChargeConfirmationKey({ sourceScopeKey: SCOPE, vorgangId: null, invoiceType: 'rechnung', draftId: DRAFT_ID })).toMatch(/^\[/);
    expect(buildInvoiceFinalizeIntentKey(null, DRAFT_ID)).toBe(buildManualInvoiceFinalizeIntentKey(DRAFT_ID));
  });

  it('T5/T6: Vorgangs-Drafts bleiben getrennt, Manual kollidiert mit keinem', () => {
    const a = buildInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, vorgangId: 'vg-1', invoiceType: 'rechnung' });
    const b = buildInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, vorgangId: 'vg-2', invoiceType: 'rechnung' });
    const m = buildInvoiceDraftRecordKey({ sourceScopeKey: SCOPE, vorgangId: null, invoiceType: 'rechnung' });
    expect(new Set([a, b, m]).size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* A — Durability                                                      */
/* ------------------------------------------------------------------ */

describe('01B1A — Manual-Draft-Durability', () => {
  it('T4/T7: genau ein Manual-Draft je Workspace, und er überlebt persist/read', async () => {
    const created = await createInvoiceDraftRecord({ identity: manualIdentity(), draft: manualDraft(), now: NOW });
    expect(created.ok, JSON.stringify(created)).toBe(true);

    const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' });
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.record.vorgangId).toBeNull();
    expect(loaded.draft.vorgangId).toBeNull();
    expect(loaded.draft.customerId).toBe('cust-1');

    // Ein zweiter Manual-Draft im selben Workspace ist derselbe Slot — kein zweiter Datensatz.
    const again = await createInvoiceDraftRecord({ identity: manualIdentity({ draftId: 'draft-m-2' }), draft: manualDraft({ id: 'draft-m-2' }), now: NOW });
    expect(again.ok).toBe(false);
  });

  it('T8/T9: save (flush) und remove funktionieren für Manual', async () => {
    const created = await createInvoiceDraftRecord({ identity: manualIdentity(), draft: manualDraft(), now: NOW });
    expect(created.ok).toBe(true);
    const saved = await saveInvoiceDraftRecord({ identity: manualIdentity(), expectedRevision: 1, draft: manualDraft({ introText: 'geändert' }), now: NOW });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const reloaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' });
    expect(reloaded.ok && reloaded.draft.introText).toBe('geändert');

    const removed = await deleteInvoiceDraftRecord({ identity: manualIdentity(), expectedRevision: 2 });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    const gone = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' });
    expect(gone.ok).toBe(false);
  });

  it('A-Regel: Abschlag/Schluss ohne Vorgang sind kein gültiger Entwurf', async () => {
    for (const invoiceType of ['abschlag', 'schluss'] as const) {
      const created = await createInvoiceDraftRecord({
        identity: manualIdentity({ invoiceType }),
        draft: manualDraft({ type: invoiceType }),
        now: NOW,
      });
      expect(created.ok, invoiceType).toBe(false);
    }
  });

  it('T10: der Presence-Check erkennt eine finalisierte Manual-Rechnung über die Registry', () => {
    hydrateInvoiceStore([{ invoice: { id: CLIENT_ID } as VorgangInvoice, vorgangId: null }]);
    expect(defaultFinalizedInvoicePresenceCheck(null, CLIENT_ID)).toBe(true);
    expect(defaultFinalizedInvoicePresenceCheck(null, 'inv-anders')).toBe(false);
    // Dieselbe Kennung an einem Vorgang ist eine andere Rechnung.
    hydrateInvoiceStore([{ invoice: { id: CLIENT_ID } as VorgangInvoice, vorgangId: VORGANG }]);
    expect(defaultFinalizedInvoicePresenceCheck(null, CLIENT_ID)).toBe(false);
    expect(local.getVorgangCalls).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* B — Resume-Primitive                                                */
/* ------------------------------------------------------------------ */

describe('01B1A — Resume', () => {
  it('B: resolveResumableInvoiceWizardStep ist vorgangsunabhängig', () => {
    expect(resolveResumableInvoiceWizardStep({ requested: 'preview', hasDraft: true, taxDecisionSettled: true, finalizationLocked: false })).toBe('preview');
    expect(resolveResumableInvoiceWizardStep({ requested: 'preview', hasDraft: false, taxDecisionSettled: true, finalizationLocked: false })).toBe('positions');
    expect(resolveResumableInvoiceWizardStep({ requested: 'edit', hasDraft: true, taxDecisionSettled: true, finalizationLocked: true })).toBe('positions');
  });
});

/* ------------------------------------------------------------------ */
/* C/D/E — Prepared Finalize                                           */
/* ------------------------------------------------------------------ */

describe('01B1A — Prepared Finalize ohne Auftrag', () => {
  it('T11/T15/T16/T17/T18/T19/T23: der Manual-Pfad läuft ohne getVorgangById und endet im First-Class-Speicher', async () => {
    await seedManualPrepared();
    local.getVorgangCalls = 0;

    const result = await executePreparedInvoiceFinalization({ identity: manualIdentity(), expectedRevision: 2 });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(local.getVorgangCalls, 'getVorgangById im Manual-Erfolgspfad').toBe(0);
    expect(cloud.rpcCalls).toHaveLength(1);
    expect(cloud.rpcCalls[0]!.name).toBe('finalize_workspace_invoice');
    expect(cloud.rpcCalls[0]!.args.p_vorgang_id, 'kein echtes NULL an den RPC').toBeNull();
    expect((cloud.rpcCalls[0]!.args.p_invoice as Record<string, unknown>).customerId).toBe('cust-1');
    expect(local.manualUpsertCalls).toHaveLength(1);
    expect(local.vorgangUpsertCalls).toHaveLength(0);
    expect(local.manualUpsertCalls[0]!.customerId).toBe('cust-1');
    expect(local.manualUpsertCalls[0]!.number).toBe('2026-0021');
    expect(local.archiveCalls).toHaveLength(1);
    expect(local.archiveCalls[0]!.vorgangId).toBeNull();
    expect(archiveService.syncGeneratedInvoiceDocumentToCloud).toHaveBeenCalledTimes(1);
    expect(result.cloudState).toBe('confirmed');
  });

  it('T12/T13: Abschlag und Schluss ohne Vorgang werden vor jedem Netzgang abgewiesen', async () => {
    for (const type of ['abschlag', 'schluss'] as const) {
      const prepared = await prepareInvoiceDraftFinalization({
        vorgangId: null,
        draft: manualDraft({ type }),
        setup,
        approvalOptions: {},
        overbillingAcknowledged: false,
      });
      expect(prepared.ok, type).toBe(false);
      if (!prepared.ok) expect(prepared.reason).toBe('vorgang_missing');
    }
    expect(cloud.rpcCalls).toHaveLength(0);
  });

  it('T14: der Manual-Intent-Schlüssel ist getrennt vom Vorgangs-Schlüssel', () => {
    expect(buildInvoiceFinalizeIntentKey(null, DRAFT_ID)).toBe('manual:draft-m-1');
    expect(buildInvoiceFinalizeIntentKey(DRAFT_ID, DRAFT_ID)).toBe(DRAFT_ID);
    expect(buildInvoiceFinalizeIntentKey(null, DRAFT_ID)).not.toBe(buildInvoiceFinalizeIntentKey(DRAFT_ID, DRAFT_ID));
  });

  it('T20/T21: ein lokaler Persist-Fehler bleibt wiederaufnehmbar — Datensatz bleibt finalizing, Cloud confirmed', async () => {
    await seedManualPrepared();
    local.manualUpsert = () => ({ ok: false, reason: 'local_persist_failed' });

    const result = await executePreparedInvoiceFinalization({ identity: manualIdentity(), expectedRevision: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('local_persist_failed');
    expect(result.cloudState).toBe('confirmed');
    expect(local.archiveCalls, 'Archiv trotz fehlgeschlagener Persistenz').toHaveLength(0);
    // Der Entwurf wird nicht entfernt — der Wiederaufnahmeweg bleibt offen.
    const record = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' });
    expect(record.ok && record.record.status).toBe('finalizing');
  });

  it('T22: ein identischer Replay erzeugt keine zweite Rechnung', async () => {
    await seedManualPrepared();
    cloud.replay = true;
    const result = await executePreparedInvoiceFinalization({ identity: manualIdentity(), expectedRevision: 2 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.idempotentReplay).toBe(true);
    expect(local.manualUpsertCalls).toHaveLength(1);
    expect(local.manualUpsertCalls[0]!.id).toBe(CLIENT_ID);
  });

  it('C: proveLocalInvoice und der Single-Final-Guard arbeiten ohne Vorgang', () => {
    hydrateInvoiceStore([{ invoice: { id: 'inv-x', type: 'rechnung', positions: [] } as unknown as VorgangInvoice, vorgangId: null }]);
    local.getVorgangCalls = 0;
    const proof = proveLocalInvoice({
      identity: manualIdentity(),
      clientInvoiceId: CLIENT_ID,
      contentFingerprint: 'fp',
      request: { invoice: { type: 'rechnung' } } as never,
    });
    expect(proof.kind).not.toBe('blocked');
    expect(local.getVorgangCalls).toBe(0);
    expect(findLocalFinalInvoiceConflict(null, 'rechnung', CLIENT_ID)).toBeNull();
    expect(findLocalFinalInvoiceConflict(null, 'schluss', CLIENT_ID)).toBeNull();
  });

  it('T26: der Vorgangspfad läuft unverändert über upsertFinalizedInvoiceOnVorgang', async () => {
    const identity = manualIdentity({ vorgangId: VORGANG, invoiceType: 'rechnung' });
    const draft = manualDraft({ vorgangId: VORGANG, vorgangTitle: 'Dach' });
    expect((await createInvoiceDraftRecord({ identity, draft, now: NOW })).ok).toBe(true);
    const prepared = await prepareInvoiceDraftFinalization({ vorgangId: VORGANG, draft, setup, approvalOptions: {}, overbillingAcknowledged: false });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const begun = await beginInvoiceDraftFinalization({ identity, expectedRevision: 1, clientInvoiceId: prepared.clientInvoiceId, contentFingerprint: prepared.contentFingerprint, request: prepared.request as never, approvalContext: prepared.approvalContext as unknown as Record<string, unknown>, now: NOW });
    expect(begun.ok).toBe(true);

    const result = await executePreparedInvoiceFinalization({ identity, expectedRevision: 2 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(cloud.rpcCalls[0]!.args.p_vorgang_id).toBe(VORGANG);
    expect(local.vorgangUpsertCalls).toHaveLength(1);
    expect(local.manualUpsertCalls).toHaveLength(0);
    expect(local.archiveCalls[0]!.vorgangId).toBe(VORGANG);
  });
});

/* ------------------------------------------------------------------ */
/* F — Confirm-first                                                   */
/* ------------------------------------------------------------------ */

describe('01B1A — Confirm-first ohne Auftrag', () => {
  it('T24: die §13b-Bestätigung ist ohne Vorgang gültig, gebunden an den Entwurf', () => {
    const sha = 'a'.repeat(64);
    const confirmation = {
      kind: REVERSE_CHARGE_CONFIRMATION_KIND,
      version: REVERSE_CHARGE_CONFIRMATION_VERSION,
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: null,
      invoiceType: 'rechnung' as const,
      draftId: DRAFT_ID,
      draftSha256: sha,
      confirmedAt: NOW,
    };
    expect(isValidReverseChargeConfirmation(confirmation)).toBe(true);
    // Keine Abschwächung: leere Kennung, Abschlag ohne Vorgang und fehlende SHA bleiben ungültig.
    expect(isValidReverseChargeConfirmation({ ...confirmation, vorgangId: '' })).toBe(false);
    expect(isValidReverseChargeConfirmation({ ...confirmation, invoiceType: 'abschlag' })).toBe(false);
    expect(isValidReverseChargeConfirmation({ ...confirmation, draftSha256: 'x' })).toBe(false);
  });

  it('T25: Leistungszeitraum-Bestätigung bleibt im Manual-Pfad ein Blocker', async () => {
    const prepared = await prepareInvoiceDraftFinalization({
      vorgangId: null,
      draft: manualDraft({ servicePeriodConfirmed: false }),
      setup,
      approvalOptions: {},
      overbillingAcknowledged: false,
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.reason).toBe('validation_failed');
    expect(cloud.rpcCalls).toHaveLength(0);
  });
});
