/**
 * CLOUD-SYNC S5 — die Freigabe eines an die Cloud gebundenen Rechnungsentwurfs
 * im echten Start-Coordinator.
 *
 * Geprüft wird die Client-Seite der atomaren Freigabe: Die Anfrage trägt
 * `clientDraftId` und die erwartete Entwurfsversion; ohne freigegebene
 * Cloud-Seite bleibt der R1-Aufruf unverändert; ein nicht angekommener Entwurf
 * beginnt gar nicht erst; eine Serverablehnung der Bindung gibt den Entwurf
 * nachweislich zurück (`finalizing → active`); „anderswo bereits freigegeben"
 * wird über den vorhandenen Kernweg auf die kanonische Rechnung aufgelöst.
 * Die Serverseite derselben Verträge (Sperre, Verbrauch, genau eine Nummer)
 * prüfen `supabase/tests/invoice_drafts_s5.sql` und der echte Parallellauf.
 *
 * Umgebung wie `invoiceFinalizationCoordinator01.test.ts`, gekürzt.
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPersistedState, InvoiceDraft, InvoiceDraftPosition, VorgangInvoice } from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';

import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as workspaceSyncPayloadService from '../workspace/workspaceSyncPayloadService';
import * as vorgangService from '../vorgangService';
import * as invoiceStore from './invoiceStore';
import * as archiveService from '../invoiceArchiveService';
import * as syncMetaService from '../sync/syncMetaService';
import * as allowlist from '../sync/cloudSyncAllowlist';
import { resumeInvoiceDraftFinalization, startInvoiceDraftFinalization } from './invoiceFinalizationCoordinator';
import { resetSyncOperationQueueForTests } from '../sync/syncOperationQueue';
import {
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { stripInvoiceDraftForCloud } from './invoiceDraftCloudService';
import { disableInvoiceDraftCloudSyncForTests } from '../../test/invoiceDraftCloudSwitch';
import {
  getInvoiceDraftCloudEntity,
  putInvoiceDraftCloudEntity,
  resetInvoiceDraftCloudStore,
} from './invoiceDraftCloudStore';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';

const WORKSPACE = 'ws-s5-f';
const SCOPE = `workspace:${WORKSPACE}`;
const VORGANG = 'vg-s5-f';
const DRAFT_ID = 'draft-s5-f';
const CLIENT_ID = 'inv-s5-eigen';
const OTHER_ID = 'inv-s5-anderes-geraet';

const cloudState = {
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  finalizeError: null as null | { message: string },
  lastInvoice: null as null | Record<string, unknown>,
  otherDeviceRow: false,
  /** Der Server schreibt, die Antwort geht aber verloren (Netzabbruch nach dem Commit). */
  commitThenLoseResponse: false,
  committedRows: [] as Record<string, unknown>[],
};

const appState = { snapshot: null as unknown as AppPersistedState };
const localState = { upsertCalls: [] as VorgangInvoice[] };

function buildPosition(index: number): InvoiceDraftPosition {
  return {
    id: `pos-${index}`,
    orderPositionId: `op-${index}`,
    description: `Beispielposition ${index}`,
    plannedQuantity: 10 + index,
    billedQuantity: 0,
    openQuantity: 10,
    quantity: 2 + index,
    unit: 'Stück',
    unitLabel: 'Stück',
    unitPrice: 10 + index,
    billable: true,
  };
}

function buildDraft(): InvoiceDraft {
  return {
    id: DRAFT_ID,
    vorgangId: VORGANG,
    vorgangTitle: 'Beispielvorgang',
    customer: 'Beispiel Kundschaft GmbH',
    baustelle: 'Musterweg 1',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'quantity_based',
    taxStatus: 'standard_19',
    materialSource: 'betrieb',
    positions: [buildPosition(1), buildPosition(2)],
    issueDate: '2026-08-21',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-20',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-04',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    customerBilling: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: 'kontakt@beispiel.example',
      phone: '030 0000000',
    },
    companySnapshot: {
      companyName: 'Beispiel Betrieb GmbH',
      legalForm: 'GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Betriebsstadt',
      country: 'Deutschland',
      contactPerson: 'B. Beispiel',
      phone: '030 1111111',
      email: 'info@betrieb.example',
      website: '',
      taxNumber: '11/222/33333',
      vatId: 'DE000000000',
      bankName: 'Beispielbank',
      iban: 'DE00000000000000000000',
      bic: 'BEISPIELXXX',
      defaultPaymentDays: 14,
      defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
      defaultSkonto: '',
      invoiceFooterNotes: '',
    } as InvoiceDraft['companySnapshot'],
    legalNotices: [],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: 'Einleitung',
    closingText: 'Schluss',
  } as InvoiceDraft;
}

function buildSnapshot(): AppPersistedState {
  return {
    version: 1,
    setup: { companyName: 'Beispiel Betrieb GmbH', taxStatus: 'standard_19' },
    inboxItems: [],
    tasks: [],
    documents: [],
    vorgaenge: [{ id: VORGANG, invoices: [], orderPositions: [], documents: [], tasks: [], photos: [] }],
    workspace: { id: WORKSPACE },
    syncClient: { serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE, deviceId: 'd1' },
  } as unknown as AppPersistedState;
}

function identity(): InvoiceDraftIdentity {
  return { sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: VORGANG, invoiceType: 'abschlag', draftId: DRAFT_ID };
}

/** Spiegelt finalize_workspace_invoice: Nummer und Status vergibt der Server. */
function serverEcho(sent: Record<string, unknown>, clientInvoiceId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...sent };
  for (const key of ['number', 'invoiceSequenceNumber', 'invoice_sequence_number', 'payments', 'paymentStatus', 'payment_status', 'archiveDocumentId', 'archive_document_id']) {
    delete payload[key];
  }
  const issueDate = String(payload.issueDate ?? payload.date ?? '2026-08-21');
  return { ...payload, id: clientInvoiceId, number: '2026-0011', invoiceSequenceNumber: 11, type: payload.type, status: 'vorbereitet', date: issueDate, issueDate };
}

function rowFor(invoice: Record<string, unknown>, clientInvoiceId: string, rowId: string): Record<string, unknown> {
  return {
    id: rowId,
    workspace_id: WORKSPACE,
    vorgang_id: VORGANG,
    client_invoice_id: clientInvoiceId,
    invoice_number: invoice.number,
    invoice_year: Number(String(invoice.issueDate ?? '2026-08-21').slice(0, 4)),
    invoice_sequence_number: invoice.invoiceSequenceNumber,
    invoice_type: invoice.type,
    invoice_status: invoice.status,
    payload: invoice,
    row_version: 1,
    created_at: '2026-08-21T09:00:00.000Z',
    updated_at: '2026-08-21T09:00:00.000Z',
  };
}

function installEnvironment(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
    () =>
      ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
        rpc: async (name: string, args: Record<string, unknown>) => {
          cloudState.rpcCalls.push({ name, args });
          if (name === 'pull_workspace_invoices') {
            // Das andere Gerät hat denselben Entwurf bereits zur Rechnung gemacht — mit eigener Kennung.
            if (cloudState.otherDeviceRow && cloudState.lastInvoice) {
              const other = serverEcho(cloudState.lastInvoice, OTHER_ID);
              return { data: [rowFor(other, OTHER_ID, 'cloud-row-other')], error: null };
            }
            return { data: cloudState.committedRows, error: null };
          }
          cloudState.lastInvoice = args.p_invoice as Record<string, unknown>;
          if (cloudState.finalizeError) return { data: null, error: cloudState.finalizeError };
          const invoice = serverEcho(args.p_invoice as Record<string, unknown>, String(args.p_client_invoice_id));
          const row = rowFor(invoice, String(args.p_client_invoice_id), 'cloud-row-eigen');
          if (cloudState.commitThenLoseResponse) {
            cloudState.committedRows = [row];
            return { data: null, error: { message: 'Failed to fetch' } };
          }
          return { data: { idempotent_replay: false, invoice, row }, error: null };
        },
      }) as never,
  );
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockImplementation(() => WORKSPACE);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockImplementation(() => appState.snapshot);
  vi.spyOn(persistenceService, 'savePersistedState').mockImplementation((state) => {
    appState.snapshot = state;
    return true;
  });
  vi.spyOn(persistenceService, 'applyStateToStores').mockImplementation(() => undefined);
  const vorgangFromSnapshot = (id: string) => (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === id);
  vi.spyOn(vorgangService, 'getVorgangById').mockImplementation((id: string) => vorgangFromSnapshot(id) as never);
  vi.spyOn(vorgangService, 'getVorgangStoreSnapshot').mockImplementation(() => (appState.snapshot.vorgaenge ?? []) as never);
  vi.spyOn(invoiceStore, 'listInvoicesForVorgang').mockImplementation((id: string) => (vorgangFromSnapshot(id)?.invoices ?? []) as never);
  vi.spyOn(vorgangService, 'upsertFinalizedInvoiceOnVorgang').mockImplementation((_vorgangId: string, invoice: VorgangInvoice) => {
    localState.upsertCalls.push(invoice);
    appState.snapshot = {
      ...appState.snapshot,
      vorgaenge: (appState.snapshot.vorgaenge ?? []).map((entry) =>
        entry.id === VORGANG ? { ...entry, invoices: [...(entry.invoices ?? []), invoice] } : entry,
      ),
    } as AppPersistedState;
    return { ok: true, invoice, action: 'inserted' } as never;
  });
  vi.spyOn(archiveService, 'archiveOutgoingInvoice').mockImplementation(
    (_vorgangId: string, invoice: VorgangInvoice) => ({ success: true, invoice }) as never,
  );
  vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => CLIENT_ID);
}

function cloudSeiteFreigeben(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type === 'invoice_draft' || allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

/** Der Entwurf ist vollständig in der Cloud angekommen — mit Serverversion `version`. */
function spiegelAngekommen(version: number, draft: InvoiceDraft = buildDraft()): void {
  putInvoiceDraftCloudEntity({
    id: DRAFT_ID,
    vorgangId: VORGANG,
    invoiceType: 'abschlag',
    status: 'active',
    core: stripInvoiceDraftForCloud(draft),
    sync: { version, deleted: false, updatedAt: '2026-08-21T08:30:00.000Z', deviceId: 'd1', workspaceId: WORKSPACE },
  });
}

async function seedActiveDraft(): Promise<void> {
  const created = await createInvoiceDraftRecord({ identity: identity(), draft: buildDraft(), now: '2026-08-21T08:00:00.000Z' });
  expect(created.ok, JSON.stringify(created)).toBe(true);
}

const start = () =>
  startInvoiceDraftFinalization({ identity: identity(), expectedRevision: 1, approvalOptions: {}, overbillingAcknowledged: false });

const finalizeCalls = () => cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice');

async function loadRecord() {
  return loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: VORGANG, invoiceType: 'abschlag' });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  cloudState.rpcCalls = [];
  cloudState.finalizeError = null;
  cloudState.lastInvoice = null;
  cloudState.otherDeviceRow = false;
  cloudState.commitThenLoseResponse = false;
  cloudState.committedRows = [];
  appState.snapshot = buildSnapshot();
  localState.upsertCalls = [];
  installEnvironment();
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  resetInvoiceDraftCloudStore();
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  resetStorageScopeForTests();
  resetInvoiceDraftCloudStore();
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

describe('S5 §24/AC — die Freigabe trägt die Entwurfsbindung; ohne sie bleibt R1 unverändert', () => {
  it('B1 — mit freigegebener Cloud-Seite: clientDraftId und erwartete Version gehen in dieselbe Freigabe-RPC', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);

    const result = await start();
    expect(result.ok, JSON.stringify(result)).toBe(true);

    expect(finalizeCalls()).toHaveLength(1);
    const args = finalizeCalls()[0]!.args;
    expect(args.p_client_draft_id).toBe(DRAFT_ID);
    expect(args.p_expected_draft_row_version).toBe(7);
    expect(args.p_client_invoice_id).toBe(CLIENT_ID);

    const record = await loadRecord();
    if (!record.ok) throw new Error(record.reason);
    expect(record.record.status).toBe('finalized');
    const preparation = JSON.parse(record.record.preparationRawJson!) as { request: Record<string, unknown> };
    expect(preparation.request.formatVersion).toBe(4);
    expect(preparation.request).toMatchObject({ clientDraftId: DRAFT_ID, expectedDraftRowVersion: 7 });

    // Der Spiegel weiß danach: Dieser Entwurf ist zur Rechnung geworden — kein Wiederauftauchen.
    expect(getInvoiceDraftCloudEntity(DRAFT_ID)).toMatchObject({ status: 'finalized', finalizedClientInvoiceId: CLIENT_ID, core: null });
  });

  it('AC — ohne freigegebene Cloud-Seite: der R1-Aufruf ist unverändert (keine Bindungsparameter)', async () => {
    disableInvoiceDraftCloudSyncForTests();
    await seedActiveDraft();

    const result = await start();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const args = finalizeCalls()[0]!.args;
    expect(Object.keys(args).sort()).toEqual(
      ['p_client_invoice_id', 'p_invoice', 'p_overbilling_acknowledged', 'p_vorgang_id', 'p_workspace_id'].sort(),
    );
    const record = await loadRecord();
    if (!record.ok) throw new Error(record.reason);
    const preparation = JSON.parse(record.record.preparationRawJson!) as { request: Record<string, unknown> };
    expect(preparation.request).not.toHaveProperty('clientDraftId');
    expect(preparation.request).not.toHaveProperty('expectedDraftRowVersion');
  });

  it('B2 — ein nicht angekommener Entwurf beginnt gar nicht erst: keine Kennung, keine Freigabe-RPC, nichts gesperrt', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();

    const result = await start();
    expect(result).toMatchObject({ ok: false, reason: 'draft_not_synced', recovery: 'retry_allowed', cloudState: 'not_committed' });
    // Der Preflight liest vorab nur den Rechnungsbestand; eine Freigabe wird nie versucht.
    expect(finalizeCalls()).toEqual([]);
    const record = await loadRecord();
    expect(record.ok && record.record.status).toBe('active');
    expect(record.ok && record.record.revision).toBe(1);
    expect(mapFinalizationFailureToUx(result as never).messageKey).toBe('invoiceDraftCloud.approve.notSynced');
  });

  it('B3 — ein offener Konflikt oder ein Ende sperrt die Freigabe ebenso vor jedem Beginn', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);
    putInvoiceDraftCloudEntity({ ...getInvoiceDraftCloudEntity(DRAFT_ID)!, conflict: { kind: 'version', detectedAt: '2026-08-21T09:00:00.000Z' } });
    expect(await start()).toMatchObject({ ok: false, reason: 'draft_conflict' });

    putInvoiceDraftCloudEntity({ id: DRAFT_ID, vorgangId: VORGANG, invoiceType: 'abschlag', status: 'finalized', core: null, finalizedClientInvoiceId: OTHER_ID, sync: { version: 8, deleted: false, updatedAt: '2026-08-21T09:00:00.000Z', deviceId: 'd2', workspaceId: WORKSPACE } });
    expect(await start()).toMatchObject({ ok: false, reason: 'draft_ended' });
    // Der Preflight liest vorab nur den Rechnungsbestand; eine Freigabe wird nie versucht.
    expect(finalizeCalls()).toEqual([]);
  });
});

describe('S5 §25 — der Server lehnt die Bindung ab: finalizing → active nur beweisgebunden', () => {
  it('P1 — anderswo geändert (Versionskonflikt): finalizing → active, keine Rechnung, keine Nummer, kein Journal', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);
    cloudState.finalizeError = { message: 'invoice_draft_version_conflict:8' };

    const result = await start();
    expect(result).toMatchObject({ ok: false, reason: 'draft_binding_rejected', recovery: 'reload_required', cloudState: 'not_committed' });
    expect(finalizeCalls()).toHaveLength(1);
    expect(localState.upsertCalls).toEqual([]);

    const record = await loadRecord();
    if (!record.ok) throw new Error(record.reason);
    expect(record.record.status).toBe('active');
    expect(record.record.revision).toBe(3); // 1 aktiv → 2 finalizing → 3 nachweislich zurückgegeben
    expect(record.record.finalization).toBeUndefined();
    expect(record.record.preparationRawJson).toBeUndefined();
    expect(mapFinalizationFailureToUx(result as never).messageKey).toBe('invoiceDraftCloud.approve.changedElsewhere');
  });

  it('P2 — ohne benannte Serverablehnung bleibt der Abschluss begonnen (kein Rückweg auf Verdacht)', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);
    cloudState.finalizeError = { message: 'Failed to fetch' };

    const result = await start();
    expect(result.ok).toBe(false);
    const record = await loadRecord();
    expect(record.ok && record.record.status).toBe('finalizing');
  });
});

describe('S5-AA — Retry derselben clientInvoiceId', () => {
  it('AA1 — nach einem Netzfehler sendet die Wiederaufnahme dieselbe gespeicherte Anfrage: dieselbe Kennung, dieselbe Bindung', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);
    cloudState.finalizeError = { message: 'Failed to fetch' };
    const first = await start();
    expect(first.ok).toBe(false);

    // Inzwischen hat ein Abzug den Spiegel bewegt — die gespeicherte Anfrage bleibt trotzdem eingefroren.
    spiegelAngekommen(9);
    cloudState.finalizeError = null;
    const resumed = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);

    const [erster, zweiter] = finalizeCalls().map((call) => call.args);
    expect(finalizeCalls()).toHaveLength(2);
    expect(zweiter!.p_client_invoice_id).toBe(erster!.p_client_invoice_id);
    expect(zweiter!.p_client_draft_id).toBe(DRAFT_ID);
    expect(zweiter!.p_expected_draft_row_version, 'die Bindung der Vorbereitung, nicht der neue Spiegelstand').toBe(7);
    expect(zweiter!.p_invoice).toEqual(erster!.p_invoice);
    expect(localState.upsertCalls.map((invoice) => invoice.id)).toEqual([CLIENT_ID]);
  });

  it('AA2 — Antwort nach dem Commit verloren: die Wiederaufnahme findet die Rechnung in der Cloud, keine zweite Freigabe', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);
    cloudState.commitThenLoseResponse = true;
    const first = await start();
    expect(first.ok).toBe(false);
    const zwischen = await loadRecord();
    expect(zwischen.ok && zwischen.record.status).toBe('finalizing');

    cloudState.commitThenLoseResponse = false;
    const resumed = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    expect(finalizeCalls(), 'keine zweite Freigabe-RPC').toHaveLength(1);
    const invoices = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG)?.invoices ?? [];
    expect(invoices.map((invoice) => [invoice.id, invoice.number])).toEqual([[CLIENT_ID, '2026-0011']]);
    expect(getInvoiceDraftCloudEntity(DRAFT_ID)).toMatchObject({ status: 'finalized', finalizedClientInvoiceId: CLIENT_ID });
  });
});

describe('S5-AB — anderswo bereits freigegeben: genau eine Rechnung, über den vorhandenen Kernweg', () => {
  it('AB1 — die kanonische Rechnung des anderen Geräts wird übernommen; keine zweite Rechnung, keine zweite Nummer', async () => {
    cloudSeiteFreigeben();
    await seedActiveDraft();
    spiegelAngekommen(7);
    cloudState.finalizeError = { message: `invoice_draft_already_finalized:${OTHER_ID}` };
    cloudState.otherDeviceRow = true;

    const result = await start();
    expect(result).toMatchObject({ ok: false, reason: 'draft_finalized_elsewhere', existingInvoiceId: OTHER_ID });
    expect(finalizeCalls()).toHaveLength(1);

    // Lokal liegt genau die eine Rechnung des anderen Geräts — die eigene Kennung kam nie zustande.
    const invoices = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG)?.invoices ?? [];
    expect(invoices.map((invoice) => invoice.id)).toEqual([OTHER_ID]);
    expect(invoices[0]!.number).toBe('2026-0011');

    const record = await loadRecord();
    if (!record.ok) throw new Error(record.reason);
    expect(record.record.status).toBe('finalized');
    expect(record.record.finalization?.finalizedInvoiceId).toBe(OTHER_ID);
    expect(getInvoiceDraftCloudEntity(DRAFT_ID)).toMatchObject({ status: 'finalized', finalizedClientInvoiceId: OTHER_ID });
    expect(mapFinalizationFailureToUx(result as never).messageKey).toBe('invoiceDraftCloud.approve.finalizedElsewhere');
  });
});
