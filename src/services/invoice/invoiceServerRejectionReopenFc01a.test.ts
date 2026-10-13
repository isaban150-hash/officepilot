/**
 * FINANZ-CORE-01A (RE-01) — eine inhaltliche Serverablehnung nach `begin`
 * sperrt den Entwurf nicht mehr dauerhaft.
 *
 * Bisher: Der Server lehnte die Freigabe ab (Menge überschritten, Summen
 * passen nicht, Schlussrechnung vorhanden, keine Berechtigung, veralteter
 * Nachtragsstand). Belegbar `not_committed`, aber der Datensatz blieb
 * `finalizing`; jede Wiederaufnahme sendete dieselbe gespeicherte Anfrage und
 * bekam dieselbe Ablehnung. Der Entwurf war nicht mehr bearbeitbar.
 *
 * Jetzt: derselbe enge Rückweg `finalizing → active` wie nach einer
 * abgelehnten Entwurfsbindung — nur für genau diese Kennung, nur mit einer der
 * benannten Ablehnungen als Beleg. Netzfehler, unbekannte Ausgänge und
 * Idempotenzkonflikte bleiben gesperrt.
 *
 * Umgebung wie `invoiceDraftCloudFinalizeS5.test.ts`, gekürzt. Neutrale
 * Beispieldaten.
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
  reopenInvoiceDraftAfterServerRejection,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { stripInvoiceDraftForCloud } from './invoiceDraftCloudService';
import { putInvoiceDraftCloudEntity, resetInvoiceDraftCloudStore } from './invoiceDraftCloudStore';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';
import { hydrateInvoiceNumberSequence, resetInvoiceNumberSequence } from '../invoiceNumberService';
import { resetInvoiceNumberStartForTests } from './invoiceNumberStartService';

const WORKSPACE = 'ws-fc01a-r';
const SCOPE = `workspace:${WORKSPACE}`;
const VORGANG = 'vg-fc01a-r';
const DRAFT_ID = 'draft-fc01a-r';

const cloudState = {
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  /** Je Freigabe-RPC der nächste Fehler; `null` = der Server nimmt an. */
  finalizeErrors: [] as (null | { message: string })[],
  idCounter: 0,
  /** RE-02 — Antworten auf set_workspace_invoice_number_start, der Reihe nach. */
  numberStartResponses: [] as { data: unknown; error: unknown }[],
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

function rowFor(invoice: Record<string, unknown>, clientInvoiceId: string): Record<string, unknown> {
  return {
    id: `cloud-row-${clientInvoiceId}`,
    workspace_id: WORKSPACE,
    vorgang_id: VORGANG,
    client_invoice_id: clientInvoiceId,
    invoice_number: invoice.number,
    invoice_year: 2026,
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
          // Abgelehnte Freigaben schreiben nichts — der Cloud-Bestand bleibt leer.
          if (name === 'pull_workspace_invoices') return { data: [], error: null };
          if (name === 'set_workspace_invoice_number_start') {
            return cloudState.numberStartResponses.shift() ?? { data: null, error: { message: 'unerwartet' } };
          }
          const error = cloudState.finalizeErrors.length > 0 ? cloudState.finalizeErrors.shift()! : null;
          if (error) return { data: null, error };
          const invoice = serverEcho(args.p_invoice as Record<string, unknown>, String(args.p_client_invoice_id));
          return { data: { idempotent_replay: false, invoice, row: rowFor(invoice, String(args.p_client_invoice_id)) }, error: null };
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
  // Jede neue Freigabe bekommt eine neue Kennung — wie im echten Gerät.
  vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => {
    cloudState.idCounter += 1;
    return `inv-fc01a-${cloudState.idCounter}`;
  });
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type === 'invoice_draft' || allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

/** Der Entwurf ist vollständig in der Cloud angekommen. */
function spiegelAngekommen(version: number): void {
  putInvoiceDraftCloudEntity({
    id: DRAFT_ID,
    vorgangId: VORGANG,
    invoiceType: 'abschlag',
    status: 'active',
    core: stripInvoiceDraftForCloud(buildDraft()),
    sync: { version, deleted: false, updatedAt: '2026-08-21T08:30:00.000Z', deviceId: 'd1', workspaceId: WORKSPACE },
  });
}

async function seedActiveDraft(): Promise<void> {
  const created = await createInvoiceDraftRecord({ identity: identity(), draft: buildDraft(), now: '2026-08-21T08:00:00.000Z' });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  spiegelAngekommen(7);
}

const start = (expectedRevision = 1) =>
  startInvoiceDraftFinalization({ identity: identity(), expectedRevision, approvalOptions: {}, overbillingAcknowledged: false });

const finalizeCalls = () => cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice');

async function loadRecord() {
  const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: VORGANG, invoiceType: 'abschlag' });
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.record;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  cloudState.rpcCalls = [];
  cloudState.finalizeErrors = [];
  cloudState.idCounter = 0;
  cloudState.numberStartResponses = [];
  resetInvoiceNumberSequence();
  resetInvoiceNumberStartForTests();
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

describe('RE-01 — inhaltliche Ablehnung beim Start: finalizing → active, nachweislich ohne Rechnung', () => {
  const faelle: [string, string, string][] = [
    ['Menge überschritten', 'invoice_quantity_exceeds_available', 'quantity_exceeds_available'],
    ['Summen passen nicht', 'invoice_totals_mismatch', 'server_integrity_rejected'],
    ['Position passt nicht', 'invoice_position_mismatch', 'server_integrity_rejected'],
    ['Steuerstatus passt nicht', 'invoice_tax_status_mismatch', 'server_integrity_rejected'],
    ['Schlussrechnung vorhanden', 'invoice_final_already_exists', 'final_invoice_exists'],
    ['keine Berechtigung', 'finance_forbidden_role', 'financial_action_denied'],
    ['Nachtragsstand veraltet', 'invoice_amendment_state_stale', 'amendment_state_stale'],
  ];

  it.each(faelle)('R1 — %s: Entwurf wieder bearbeitbar, Grund benannt, kein Neuladen nötig', async (_titel, serverMeldung, grund) => {
    await seedActiveDraft();
    const vorher = await loadRecord();
    cloudState.finalizeErrors = [{ message: serverMeldung }];

    const result = await start();
    expect(result).toMatchObject({ ok: false, reason: grund, cloudState: 'not_committed', draftReopened: true });
    expect(finalizeCalls()).toHaveLength(1);
    expect(localState.upsertCalls).toEqual([]);

    const record = await loadRecord();
    expect(record.status).toBe('active');
    expect(record.revision).toBe(3); // 1 aktiv → 2 finalizing → 3 nachweislich zurückgegeben
    expect(record.finalization).toBeUndefined();
    expect(record.preparationRawJson).toBeUndefined();
    expect(record.preparationSha256).toBeUndefined();
    // Der Inhalt bleibt bytegleich — nur der Abschluss ist zurückgegeben.
    expect(record.draftRawJson).toBe(vorher.draftRawJson);
    expect(record.draftSha256).toBe(vorher.draftSha256);

    const ux = mapFinalizationFailureToUx(result as Extract<typeof result, { ok: false }>);
    expect(ux.unlock).toBe(true);
    expect(ux.reloadRequired).toBe(false);
  });

  it('R2 — nach der Rückgabe gelingt eine neue Freigabe mit neuer Kennung; genau eine Rechnung entsteht', async () => {
    await seedActiveDraft();
    cloudState.finalizeErrors = [{ message: 'invoice_quantity_exceeds_available' }];
    const erste = await start();
    expect(erste).toMatchObject({ ok: false, draftReopened: true });

    // Inzwischen ist die Menge wieder frei (etwa nach einem Storno) — der Server nimmt an.
    const zweite = await start(3);
    expect(zweite.ok, JSON.stringify(zweite)).toBe(true);

    const [a, b] = finalizeCalls().map((call) => call.args);
    expect(finalizeCalls()).toHaveLength(2);
    expect(b!.p_client_invoice_id).not.toBe(a!.p_client_invoice_id);
    expect(localState.upsertCalls.map((invoice) => invoice.id)).toEqual([b!.p_client_invoice_id]);
    expect((await loadRecord()).status).toBe('finalized');
  });
});

describe('RE-01 — Wiederaufnahme: ein schon gesperrter Entwurf wird beim nächsten Versuch frei', () => {
  it('W1 — erst Netzfehler (bleibt gesperrt), dann lehnt der Server die gespeicherte Anfrage ab: zurückgegeben', async () => {
    await seedActiveDraft();
    cloudState.finalizeErrors = [{ message: 'Failed to fetch' }, { message: 'invoice_totals_mismatch' }];

    const first = await start();
    expect(first.ok).toBe(false);
    expect(first).not.toHaveProperty('draftReopened');
    expect((await loadRecord()).status).toBe('finalizing');

    const resumed = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(resumed).toMatchObject({ ok: false, reason: 'server_integrity_rejected', cloudState: 'not_committed', draftReopened: true });
    const [erster, zweiter] = finalizeCalls().map((call) => call.args);
    expect(zweiter!.p_client_invoice_id, 'dieselbe gespeicherte Anfrage').toBe(erster!.p_client_invoice_id);

    const record = await loadRecord();
    expect(record.status).toBe('active');
    expect(record.revision).toBe(3);
    expect(localState.upsertCalls).toEqual([]);
    const ux = mapFinalizationFailureToUx(resumed as Extract<typeof resumed, { ok: false }>);
    expect(ux.messageKey).toBe('invoice.approve.serverRejected');
    expect(ux.reloadRequired).toBe(false);
  });
});

describe('RE-01 — Grenzen: kein Rückweg auf Verdacht', () => {
  it.each([
    ['Netzfehler (Ausgang unbekannt)', 'Failed to fetch'],
    ['unbekannte Servermeldung', 'etwas ganz anderes ist passiert'],
    ['Idempotenzkonflikt', 'Idempotenzkonflikt: andere Anfrage unter derselben Kennung'],
    ['Zugriff verweigert (nicht benannt)', 'Kein Zugriff auf diesen Workspace'],
  ])('G1 — %s: der Abschluss bleibt begonnen', async (_titel, serverMeldung) => {
    await seedActiveDraft();
    cloudState.finalizeErrors = [{ message: serverMeldung }];

    const result = await start();
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('draftReopened');
    const record = await loadRecord();
    expect(record.status).toBe('finalizing');
    expect(record.revision).toBe(2);
    expect(record.finalization?.clientInvoiceId).toBeTruthy();
  });

  it('G2 — der Speicherweg selbst ist eng: nur finalizing, nur diese Kennung, nur diese Revision, nur ein benannter Grund', async () => {
    await seedActiveDraft();
    cloudState.finalizeErrors = [{ message: 'Failed to fetch' }];
    await start();
    const finalizing = await loadRecord();
    const clientInvoiceId = finalizing.finalization!.clientInvoiceId;

    const fremdeKennung = await reopenInvoiceDraftAfterServerRejection({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: 'inv-andere',
      serverRejection: 'quantity_exceeds_available',
    });
    expect(fremdeKennung).toMatchObject({ ok: false, reason: 'finalization_mismatch' });

    const falscheRevision = await reopenInvoiceDraftAfterServerRejection({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId,
      serverRejection: 'quantity_exceeds_available',
    });
    expect(falscheRevision).toMatchObject({ ok: false, reason: 'conflict', currentRevision: 2 });

    const unbenannt = await reopenInvoiceDraftAfterServerRejection({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId,
      serverRejection: 'rpc_failed' as never,
    });
    expect(unbenannt).toMatchObject({ ok: false, reason: 'invalid_finalization' });
    expect((await loadRecord()).status).toBe('finalizing');

    const richtig = await reopenInvoiceDraftAfterServerRejection({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId,
      serverRejection: 'server_integrity_rejected',
    });
    expect(richtig.ok).toBe(true);

    // Ein zweiter Rückweg auf einen aktiven Entwurf ist ausgeschlossen.
    const nochmal = await reopenInvoiceDraftAfterServerRejection({
      identity: identity(),
      expectedRevision: 3,
      clientInvoiceId,
      serverRejection: 'server_integrity_rejected',
    });
    expect(nochmal).toMatchObject({ ok: false, reason: 'status_conflict', currentStatus: 'active' });
  });
});

describe('RE-02 — die Startnummer geht vor der ersten Nummernvergabe an den Server', () => {
  it('Z1: ein Netzfehler hält die Freigabe vor begin an; danach Startnummer, dann Freigabe', async () => {
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 123 });
    await seedActiveDraft();
    cloudState.numberStartResponses = [
      { data: null, error: { message: 'Failed to fetch' } },
      { data: { applied: true, year: 2026, last_sequence: 123 }, error: null },
    ];

    const erste = await start();
    expect(erste).toMatchObject({ ok: false, reason: 'offline_or_unconfigured', recovery: 'retry_allowed', cloudState: 'not_committed' });
    expect(finalizeCalls()).toEqual([]);
    const unberuehrt = await loadRecord();
    expect(unberuehrt.status).toBe('active');
    expect(unberuehrt.revision).toBe(1);

    const zweite = await start();
    expect(zweite.ok, JSON.stringify(zweite)).toBe(true);
    const folge = cloudState.rpcCalls.map((call) => call.name).filter((name) => name !== 'pull_workspace_invoices');
    expect(folge).toEqual(['set_workspace_invoice_number_start', 'set_workspace_invoice_number_start', 'finalize_workspace_invoice']);
    expect(cloudState.rpcCalls.find((call) => call.name === 'set_workspace_invoice_number_start')?.args).toMatchObject({
      p_year: 2026,
      p_last_sequence: 123,
    });
  });

  it('Z2: ein Server ohne die Funktion verhält sich wie bisher — die Freigabe läuft', async () => {
    hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 123 });
    await seedActiveDraft();
    cloudState.numberStartResponses = [{ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }];

    const result = await start();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(finalizeCalls()).toHaveLength(1);
  });
});
