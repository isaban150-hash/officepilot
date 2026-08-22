/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2A — lokaler Start-Coordinator.
 *
 * Ausschließlich synthetische, neutrale Daten. Kein Test behauptet einen
 * tabübergreifenden Schutz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppPersistedState,
  InvoiceDraft,
  InvoiceDraftPosition,
  VorgangInvoice,
} from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';

import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as workspaceSyncPayloadService from '../workspace/workspaceSyncPayloadService';
import * as vorgangService from '../vorgangService';
import * as archiveService from '../invoiceArchiveService';
import * as syncMetaService from '../sync/syncMetaService';
import * as intentService from './invoiceFinalizeIntentService';
import * as preparedModule from './invoicePreparedFinalizeService';

import {
  resumeInvoiceDraftFinalization,
  startInvoiceDraftFinalization,
} from './invoiceFinalizationCoordinator';
import { buildInvoicePayloadV1 } from './workspaceInvoiceFinalizeRequestValidator';
import { buildActualPreparedResponseProjection } from './invoicePreparedResponseProjection';
import * as preflightModule from './invoiceFinalizationPreflightService';
import * as durabilityModule from './invoiceDraftDurabilityService';
import * as invoiceServiceModule from '../invoiceService';
import {
  runQueuedSyncOperation,
  resetSyncOperationQueueForTests,
} from '../sync/syncOperationQueue';
import {
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import {
  INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX,
  type InvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';
import {
  buildStorageKey,
  resetStorageScopeForTests,
  setActiveStorageScope,
} from '../storage/storageScopeService';

const WORKSPACE = 'ws-d-1';
const SCOPE = 'workspace:ws-d-1';
const VORGANG = 'vg-d-1';
const DRAFT_ID = 'draft-d-1';
const CLIENT_ID = 'inv-d-0001';
const LONG_TEXT = `Hinweis ${'Beispieltext '.repeat(8)}Ende`;

const cloudState = {
  configured: true,
  session: { user: { id: 'u-1' } } as unknown,
  workspaceId: WORKSPACE,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  finalizeGate: null as null | Promise<void>,
  finalizeError: null as null | { message: string },
  finalizeOverrides: {} as Record<string, unknown>,
  pullError: null as null | { message: string },
  pullRows: [] as unknown[],
};

const appState = {
  snapshot: null as unknown as AppPersistedState,
  saved: [] as AppPersistedState[],
  saveOk: true,
};

const localState = {
  upsert: null as null | ((invoice: VorgangInvoice) => unknown),
  upsertCalls: [] as VorgangInvoice[],
  archive: null as null | ((invoice: VorgangInvoice) => unknown),
  archiveCalls: [] as VorgangInvoice[],
};

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

function buildDraft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
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
      invoiceFooterNotes: LONG_TEXT,
    } as InvoiceDraft['companySnapshot'],
    legalNotices: [LONG_TEXT],
    previousAbschlagDeductions: [],
    invoiceNumberPreview: 'Vorschau',
    introText: LONG_TEXT,
    closingText: LONG_TEXT,
    ...overrides,
  } as InvoiceDraft;
}

function buildSnapshot(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  return {
    version: 1,
    setup: { companyName: 'Beispiel Betrieb GmbH', taxStatus: 'standard_19' },
    inboxItems: [],
    tasks: [],
    documents: [],
    // Vollständig genug für den echten cloneVorgang im Merge.
    vorgaenge: [
      {
        id: VORGANG,
        invoices: [],
        orderPositions: [],
        documents: [],
        tasks: [],
        photos: [],
      },
    ],
    workspace: { id: WORKSPACE },
    syncClient: { serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE, deviceId: 'd1' },
    ...overrides,
  } as unknown as AppPersistedState;
}

function identity(overrides: Partial<InvoiceDraftIdentity> = {}): InvoiceDraftIdentity {
  return {
    sourceScopeKey: SCOPE,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'abschlag',
    draftId: DRAFT_ID,
    ...overrides,
  };
}

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    identity: identity(),
    expectedRevision: 1,
    approvalOptions: {},
    overbillingAcknowledged: false,
    ...overrides,
  };
}

/** Spiegelt finalize_workspace_invoice. */
function serverEcho(
  sent: Record<string, unknown>,
  clientInvoiceId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...sent };
  for (const key of [
    'number',
    'invoiceSequenceNumber',
    'invoice_sequence_number',
    'payments',
    'paymentStatus',
    'payment_status',
    'archiveDocumentId',
    'archive_document_id',
  ]) {
    delete payload[key];
  }
  const issueDate = String(payload.issueDate ?? payload.date ?? '2026-08-21');
  return {
    ...payload,
    id: clientInvoiceId,
    number: '2026-0011',
    invoiceSequenceNumber: 11,
    type: payload.type,
    status: 'vorbereitet',
    date: issueDate,
    issueDate,
    ...cloudState.finalizeOverrides,
  };
}

function installEnvironment(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(() => cloudState.configured);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
    () =>
      ({
        auth: {
          getSession: async () => ({ data: { session: cloudState.session }, error: null }),
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
          cloudState.rpcCalls.push({ name, args });
          if (name === 'pull_workspace_invoices') {
            if (cloudState.pullError) return { data: null, error: cloudState.pullError };
            return { data: cloudState.pullRows, error: null };
          }
          if (cloudState.finalizeGate) await cloudState.finalizeGate;
          if (cloudState.finalizeError) return { data: null, error: cloudState.finalizeError };
          const invoice = serverEcho(
            args.p_invoice as Record<string, unknown>,
            String(args.p_client_invoice_id),
          );
          return {
            data: {
              idempotent_replay: false,
              invoice,
              /*
               * 01P4E1E — die Zeile trug bisher nur sechs Spalten. Das SQL gibt
               * mit `to_jsonb(v_existing)` die **vollständige** Tabellenzeile
               * zurück. Alle Spalten werden aus genau diesem `invoice`
               * abgeleitet, damit ein Test-Override niemals einen künstlichen
               * Widerspruch zwischen Zeile und Payload erzeugt.
               */
              row: {
                id: 'cloud-row-d1',
                workspace_id: args.p_workspace_id,
                vorgang_id: args.p_vorgang_id,
                client_invoice_id: args.p_client_invoice_id,
                invoice_number: invoice.number,
                invoice_year: Number(
                  String(invoice.issueDate ?? invoice.date ?? '2026-08-21').slice(0, 4),
                ),
                invoice_sequence_number: invoice.invoiceSequenceNumber,
                invoice_type: invoice.type,
                invoice_status: invoice.status,
                payload: invoice,
                row_version: 1,
                created_at: '2026-08-21T09:00:00.000Z',
                updated_at: '2026-08-21T09:00:00.000Z',
              },
            },
            error: null,
          };
        },
      }) as never,
  );
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockImplementation(
    () => cloudState.workspaceId,
  );
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockImplementation(
    () => appState.snapshot,
  );
  vi.spyOn(persistenceService, 'savePersistedState').mockImplementation((state) => {
    if (!appState.saveOk) return false;
    appState.saved.push(state);
    appState.snapshot = state;
    return true;
  });
  vi.spyOn(persistenceService, 'applyStateToStores').mockImplementation(() => undefined);
  vi.spyOn(vorgangService, 'getVorgangById').mockImplementation(
    (id: string) => (id === VORGANG ? ({ id: VORGANG } as never) : undefined) as never,
  );
  vi.spyOn(vorgangService, 'upsertFinalizedInvoiceOnVorgang').mockImplementation(
    (_vorgangId: string, invoice: VorgangInvoice) => {
      localState.upsertCalls.push(invoice);
      const custom = localState.upsert?.(invoice);
      if (custom) return custom as never;
      // Die Rechnung liegt danach dauerhaft am Vorgang.
      appState.snapshot = {
        ...appState.snapshot,
        vorgaenge: (appState.snapshot.vorgaenge ?? []).map((entry) =>
          entry.id === VORGANG
            ? { ...entry, invoices: [...(entry.invoices ?? []), invoice] }
            : entry,
        ),
      } as AppPersistedState;
      return { ok: true, invoice, action: 'inserted' } as never;
    },
  );
  vi.spyOn(archiveService, 'archiveOutgoingInvoice').mockImplementation(
    (_vorgangId: string, invoice: VorgangInvoice) => {
      localState.archiveCalls.push(invoice);
      return (localState.archive?.(invoice) ?? { success: true, invoice }) as never;
    },
  );
  vi.spyOn(syncMetaService, 'generateEntityId').mockImplementation(() => CLIENT_ID);
}

async function seedActiveDraft(draft: InvoiceDraft = buildDraft()): Promise<void> {
  const created = await createInvoiceDraftRecord({
    identity: identity(),
    draft,
    now: '2026-08-21T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
}

function seedIntent(
  scope: Parameters<typeof buildStorageKey>[0],
  intent: InvoiceFinalizeIntent,
): void {
  const key = `${buildStorageKey(scope)}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`;
  const raw = localStorage.getItem(key);
  const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  map[intent.vorgangId] = intent;
  localStorage.setItem(key, JSON.stringify(map));
}

function rpcNames(): string[] {
  return cloudState.rpcCalls.map((call) => call.name);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  cloudState.configured = true;
  cloudState.session = { user: { id: 'u-1' } };
  cloudState.workspaceId = WORKSPACE;
  cloudState.rpcCalls = [];
  cloudState.finalizeGate = null;
  cloudState.finalizeError = null;
  cloudState.finalizeOverrides = {};
  cloudState.pullError = null;
  cloudState.pullRows = [];
  appState.snapshot = buildSnapshot();
  appState.saved = [];
  appState.saveOk = true;
  localState.upsert = null;
  localState.upsertCalls = [];
  localState.archive = null;
  localState.archiveCalls = [];
  installEnvironment();
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  resetStorageScopeForTests();
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

async function loadRecord() {
  return loadInvoiceDraftRecordByLocator({
    sourceScopeKey: SCOPE,
    workspaceId: WORKSPACE,
    vorgangId: VORGANG,
    invoiceType: 'abschlag',
  });
}

describe('01P4D2A — lokaler Start-Coordinator', () => {
  it('S1: ein vollständiger Start endet mit finalized', async () => {
    await seedActiveDraft();

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(rpcNames().filter((name) => name === 'pull_workspace_invoices').length).toBe(1);
    expect(rpcNames().filter((name) => name === 'finalize_workspace_invoice').length).toBe(1);
    expect(result.clientInvoiceId).toBe(CLIENT_ID);
    expect(result.invoice.id).toBe(CLIENT_ID);
    expect(result.invoice.number).toBe('2026-0011');
    expect(result.cloudState).toBe('confirmed');
    expect(result.revision).toBe(3);

    const record = await loadRecord();
    expect(record.ok, JSON.stringify(record)).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.revision).toBe(3);
      expect(record.record.finalization?.clientInvoiceId).toBe(CLIENT_ID);
      expect(record.record.finalization?.finalizedInvoiceId).toBe(CLIENT_ID);
    }

    const vorgang = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG);
    expect(vorgang?.invoices?.some((invoice) => invoice.id === CLIENT_ID)).toBe(true);
  });

  it('S2: der gesamte Ablauf liegt in einem Queue-Lauf', async () => {
    await seedActiveDraft();
    const order: string[] = [];
    let release: (() => void) | null = null;
    cloudState.finalizeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const started = startInvoiceDraftFinalization(startInput()).then((result) => {
      order.push('coordinator:done');
      return result;
    });

    await vi.waitFor(() =>
      expect(rpcNames()).toContain('finalize_workspace_invoice'),
    );
    const follower = runQueuedSyncOperation(async () => {
      order.push('follower:start');
      return 'follower';
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).not.toContain('follower:start');
    expect(localState.upsertCalls.length).toBe(0);

    order.push('gate:released');
    release?.();
    const result = await started;
    await follower;

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(order.indexOf('follower:start')).toBeGreaterThan(order.indexOf('gate:released'));
    // Das Coordinator-Promise löst erst nach complete auf.
    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.record.status).toBe('finalized');
  });

  it('S3: ein Preflight-Fehler verhindert jeden weiteren Schritt', async () => {
    await seedActiveDraft();
    cloudState.workspaceId = 'ws-fremd';

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('workspace_changed');
      expect(result.clientInvoiceId).toBeUndefined();
    }
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.revision).toBe(1);
    }
  });

  it('S4: ein abweichender Kandidaten-Fingerprint liefert fingerprint_drift', async () => {
    await seedActiveDraft();
    const original = preparedModule.prepareInvoiceDraftFinalization;
    vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization').mockImplementation(
      async (input) => {
        const prepared = await original(input);
        if (!prepared.ok) return prepared;
        // Synthetisch widersprüchlicher Rückgabefall — kein Builder gestubbt.
        return { ...prepared, contentFingerprint: `${prepared.contentFingerprint}-drift` };
      },
    );

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('fingerprint_drift');
      expect(result.clientInvoiceId).toBeUndefined();
    }
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.preparationRawJson).toBeUndefined();
    }
  });

  it('S5: eine Revisionsänderung vor begin liefert conflict', async () => {
    await seedActiveDraft();
    const original = preparedModule.prepareInvoiceDraftFinalization;
    vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization').mockImplementation(
      async (input) => {
        const prepared = await original(input);
        // Nach prepare, vor begin: der Entwurf wird gespeichert.
        await saveInvoiceDraftRecord({
          identity: identity(),
          draft: buildDraft({ introText: 'zwischendurch' }),
          expectedRevision: 1,
          now: '2026-08-21T08:45:00.000Z',
        });
        return prepared;
      },
    );

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('conflict');
      expect(result.clientInvoiceId).toBeUndefined();
    }
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.revision).toBe(2);
    }
  });

  it('S6: Workspace- oder Scope-Wechsel vor begin blockiert', async () => {
    for (const [label, mutate] of [
      ['workspace_changed', () => void (cloudState.workspaceId = 'ws-fremd')],
      ['scope_mismatch', () => setActiveStorageScope({ type: 'guest' })],
    ] as [string, () => void][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      cloudState.rpcCalls = [];
      cloudState.workspaceId = WORKSPACE;
      setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
      appState.snapshot = buildSnapshot();
      await seedActiveDraft();

      const original = preparedModule.prepareInvoiceDraftFinalization;
      const spy = vi
        .spyOn(preparedModule, 'prepareInvoiceDraftFinalization')
        .mockImplementation(async (input) => {
          const prepared = await original(input);
          mutate();
          return prepared;
        });

      const result = await startInvoiceDraftFinalization(startInput());
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe(label);
      expect(rpcNames(), label).not.toContain('finalize_workspace_invoice');

      const record = await loadRecord();
      expect(record.ok, label).toBe(true);
      if (record.ok) expect(record.record.status, label).toBe('active');
      spy.mockRestore();
    }
  });

  it('S7: eine neue Legacy-Intent-Lage vor begin wird ausgewertet', async () => {
    // (a) Ungeklärter Intent blockiert.
    await seedActiveDraft();
    const original = preparedModule.prepareInvoiceDraftFinalization;
    const spy = vi
      .spyOn(preparedModule, 'prepareInvoiceDraftFinalization')
      .mockImplementation(async (input) => {
        const prepared = await original(input);
        seedIntent(
          { type: 'workspace', workspaceId: WORKSPACE },
          {
            workspaceId: WORKSPACE,
            vorgangId: VORGANG,
            clientInvoiceId: 'inv-alt-unbekannt',
            contentFingerprint: 'fp-alt',
            createdAt: '2026-08-10T09:00:00.000Z',
          },
        );
        return prepared;
      });

    const blocked = await startInvoiceDraftFinalization(startInput());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('legacy_intent_unresolved');
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');
    // Der Intent bleibt unverändert.
    expect(
      localStorage.getItem(
        `${buildStorageKey({ type: 'workspace', workspaceId: WORKSPACE })}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`,
      ),
    ).not.toBeNull();
    spy.mockRestore();

    // (b) Beschädigter Speicher blockiert.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    localStorage.clear();
    cloudState.rpcCalls = [];
    appState.snapshot = buildSnapshot();
    await seedActiveDraft();
    const corruptSpy = vi
      .spyOn(preparedModule, 'prepareInvoiceDraftFinalization')
      .mockImplementation(async (input) => {
        const prepared = await original(input);
        localStorage.setItem(
          `${buildStorageKey({ type: 'workspace', workspaceId: WORKSPACE })}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`,
          '{ kein json',
        );
        return prepared;
      });

    const corrupt = await startInvoiceDraftFinalization(startInput());
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toBe('intent_corrupt');
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');
    corruptSpy.mockRestore();
  });

  it('S8: ein verlorenes Begin-CAS führt nie zu einer zweiten Kennung', async () => {
    await seedActiveDraft();
    const original = preparedModule.prepareInvoiceDraftFinalization;
    vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization').mockImplementation(
      async (input) => {
        const prepared = await original(input);
        if (!prepared.ok) return prepared;
        // Ein Fremdlauf gewinnt das CAS zuerst.
        const { beginInvoiceDraftFinalization } = await import('./invoiceDraftDurabilityService');
        await beginInvoiceDraftFinalization({
          identity: identity(),
          expectedRevision: 1,
          clientInvoiceId: 'inv-fremd-0001',
          contentFingerprint: prepared.contentFingerprint,
          request: {
            ...prepared.request,
            clientInvoiceId: 'inv-fremd-0001',
            invoice: { ...prepared.request.invoice, id: 'inv-fremd-0001' },
          } as never,
          approvalContext: JSON.parse(
            JSON.stringify(prepared.approvalContext),
          ) as Record<string, unknown>,
          now: '2026-08-21T08:50:00.000Z',
        });
        return prepared;
      },
    );

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['conflict', 'status_conflict']).toContain(result.reason);
    }
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      // Nur die Kennung des Gewinners liegt dauerhaft vor.
      expect(record.record.finalization?.clientInvoiceId).toBe('inv-fremd-0001');
    }
  });

  it('S10: ein Execute-Fehler lässt den Datensatz finalizing', async () => {
    for (const [label, seed, expected] of [
      [
        'unknown',
        () => void (cloudState.finalizeError = { message: 'Failed to fetch' }),
        'unknown',
      ],
      [
        'conflict',
        () => void (cloudState.finalizeError = { message: 'Idempotenzkonflikt: abweichend' }),
        'conflict',
      ],
      [
        'local_persist_failed',
        () => {
          cloudState.finalizeError = null;
          localState.upsert = () => ({ ok: false, reason: 'local_persist_failed' });
        },
        'confirmed',
      ],
    ] as [string, () => void, string][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      cloudState.rpcCalls = [];
      cloudState.finalizeError = null;
      localState.upsert = null;
      appState.snapshot = buildSnapshot();
      await seedActiveDraft();
      seed();

      const result = await startInvoiceDraftFinalization(startInput());
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.cloudState, label).toBe(expected);
        expect(result.clientInvoiceId, label).toBe(CLIENT_ID);
        expect(result.recovery, label).not.toBe(undefined);
      }

      // Genau ein Finalisierungsversuch im selben Startlauf.
      expect(
        rpcNames().filter((name) => name === 'finalize_workspace_invoice').length,
        label,
      ).toBe(1);

      const record = await loadRecord();
      expect(record.ok, label).toBe(true);
      if (record.ok) {
        expect(record.record.status, label).toBe('finalizing');
        expect(record.record.revision, label).toBe(2);
        expect(record.record.finalization?.clientInvoiceId, label).toBe(CLIENT_ID);
        expect(record.record.finalization?.finalizedAt, label).toBeUndefined();
      }
    }
  });

  it('S12: eine Archivwarnung verhindert complete nicht', async () => {
    await seedActiveDraft();
    localState.archive = () => ({ success: false, reason: 'archive_failed' });

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.archiveWarning).toBe(true);
    expect(localState.archiveCalls.length).toBe(1);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.finalization?.archiveWarning).toBe(true);
    }
  });

  it('S9/S11: committed_but_unverified endet ohne erfundenen Erfolg', async () => {
    // S9 — begin committed_but_unverified: kein execute, kein complete.
    await seedActiveDraft();
    const durability = await import('./invoiceDraftDurabilityService');
    const beginOriginal = durability.beginInvoiceDraftFinalization;
    const beginSpy = vi
      .spyOn(durability, 'beginInvoiceDraftFinalization')
      .mockImplementation(async (input) => {
        const written = await beginOriginal(input);
        expect(written.ok).toBe(true);
        return { ok: false, reason: 'committed_but_unverified' } as never;
      });

    const afterBegin = await startInvoiceDraftFinalization(startInput());
    expect(afterBegin.ok).toBe(false);
    if (!afterBegin.ok) {
      expect(afterBegin.reason).toBe('committed_but_unverified');
      expect(afterBegin.recovery).toBe('reload_required');
      // Die Kennung steht nachweislich dauerhaft im Datensatz.
      expect(afterBegin.clientInvoiceId).toBe(CLIENT_ID);
    }
    expect(rpcNames()).not.toContain('finalize_workspace_invoice');
    beginSpy.mockRestore();

    // S11 — complete committed_but_unverified: kein zweiter RPC, kein Erfolg.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    cloudState.rpcCalls = [];
    appState.snapshot = buildSnapshot();
    await seedActiveDraft();
    const completeOriginal = durability.completeInvoiceDraftFinalization;
    const completeSpy = vi
      .spyOn(durability, 'completeInvoiceDraftFinalization')
      .mockImplementation(async (input) => {
        const written = await completeOriginal(input);
        expect(written.ok).toBe(true);
        return { ok: false, reason: 'committed_but_unverified' } as never;
      });

    const afterComplete = await startInvoiceDraftFinalization(startInput());
    expect(afterComplete.ok).toBe(false);
    if (!afterComplete.ok) {
      expect(afterComplete.reason).toBe('committed_but_unverified');
      expect(afterComplete.recovery).toBe('reload_required');
      expect(afterComplete.cloudState).toBe('confirmed');
      expect(afterComplete.clientInvoiceId).toBe(CLIENT_ID);
    }
    expect(rpcNames().filter((name) => name === 'finalize_workspace_invoice').length).toBe(1);
    completeSpy.mockRestore();
  });

  it('S-Intent: der Coordinator erzeugt, überschreibt und löscht keinen Intent', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');
    const resolveIntent = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
    const clearIntent = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');

    await seedActiveDraft();
    setItem.mockClear();

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);

    expect(resolveIntent).not.toHaveBeenCalled();
    expect(clearIntent).not.toHaveBeenCalled();
    expect(
      setItem.mock.calls.filter(([key]) =>
        String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
      ),
    ).toEqual([]);
    expect(
      removeItem.mock.calls.filter(([key]) =>
        String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
      ),
    ).toEqual([]);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2A1 — geschlossene
 * Nachweise des Start-Coordinators.
 * ========================================================================== */

describe('01P4D2A1 — Start-Coordinator-Nachweise', () => {
  it('V1: die Queue bleibt bis hinter complete geschlossen', async () => {
    await seedActiveDraft();
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const completeOriginal = durabilityModule.completeInvoiceDraftFinalization;
    vi.spyOn(durabilityModule, 'completeInvoiceDraftFinalization').mockImplementation(
      async (completeInput) => {
        order.push('complete:begin');
        await gate;
        const result = await completeOriginal(completeInput);
        order.push('complete:end');
        return result;
      },
    );

    const started = startInvoiceDraftFinalization(startInput());
    await vi.waitFor(() => expect(order).toContain('complete:begin'));

    let statusAtFollowerStart: string | undefined;
    const follower = runQueuedSyncOperation(async () => {
      order.push('follower:start');
      const record = await loadRecord();
      statusAtFollowerStart = record.ok ? record.record.status : 'unknown';
      return 'follower';
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).not.toContain('follower:start');

    release?.();
    const result = await started;
    await follower;

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(order.indexOf('follower:start')).toBeGreaterThan(order.indexOf('complete:end'));
    // Der zweite Lauf sieht beim Start bereits den Grabstein.
    expect(statusAtFollowerStart).toBe('finalized');
  });

  it('V2: prepare erhält exakt die Preflight-Objekte', async () => {
    await seedActiveDraft();

    let preflightDraft: unknown;
    let preflightSetup: unknown;
    const preflightOriginal = preflightModule.runInvoiceFinalizationPreflightWithinSyncOperation;
    vi.spyOn(
      preflightModule,
      'runInvoiceFinalizationPreflightWithinSyncOperation',
    ).mockImplementation(async (preflightInput, lease) => {
      const preflight = await preflightOriginal(preflightInput, lease);
      if (preflight.ok) {
        preflightDraft = preflight.draft;
        preflightSetup = preflight.setupSnapshot;
      }
      return preflight;
    });

    let sameDraft = false;
    let sameSetup = false;
    const prepareOriginal = preparedModule.prepareInvoiceDraftFinalization;
    vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization').mockImplementation(
      async (prepareInput) => {
        sameDraft = prepareInput.draft === preflightDraft;
        sameSetup = prepareInput.setup === preflightSetup;
        return prepareOriginal(prepareInput);
      },
    );

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(sameDraft).toBe(true);
    expect(sameSetup).toBe(true);
  });

  it('V3: ein exakt lokal aufgelöster Altintent blockiert den Start nicht', async () => {
    await seedActiveDraft();

    // Eine ältere, inhaltlich andere Rechnung desselben Vorgangs.
    const olderInvoice = {
      id: 'inv-alt-d-0001',
      number: '2026-0002',
      type: 'abschlag',
      abschlagNumber: 9,
      positions: [],
      subtotal: 4,
      amount: 4.76,
      taxStatus: 'standard_19',
      status: 'vorbereitet',
      date: '2026-08-02',
      createdAt: '2026-08-02T09:00:00.000Z',
    } as unknown as VorgangInvoice;

    const prepareOriginal = preparedModule.prepareInvoiceDraftFinalization;
    vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization').mockImplementation(
      async (prepareInput) => {
        const prepared = await prepareOriginal(prepareInput);
        if (!prepared.ok) return prepared;

        // Nach prepare, vor dem Guard: Rechnung und passender Altintent.
        appState.snapshot = {
          ...appState.snapshot,
          vorgaenge: (appState.snapshot.vorgaenge ?? []).map((entry) =>
            entry.id === VORGANG ? { ...entry, invoices: [olderInvoice] } : entry,
          ),
        } as AppPersistedState;

        const olderFingerprint =
          invoiceServiceModule.buildInvoiceContentFingerprintFromInvoice(olderInvoice);
        expect(olderFingerprint).not.toBe(prepared.contentFingerprint);

        seedIntent(
          { type: 'guest' },
          {
            workspaceId: WORKSPACE,
            vorgangId: VORGANG,
            clientInvoiceId: olderInvoice.id,
            contentFingerprint: olderFingerprint,
            createdAt: '2026-08-02T09:00:00.000Z',
          },
        );
        return prepared;
      },
    );

    const intentKey = `${buildStorageKey({ type: 'guest' })}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`;
    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.clientInvoiceId).toBe(CLIENT_ID);
    expect(rpcNames().filter((name) => name === 'finalize_workspace_invoice').length).toBe(1);

    // Der Altintent bleibt unverändert erhalten.
    const stored = JSON.parse(localStorage.getItem(intentKey) ?? '{}') as Record<string, unknown>;
    expect((stored[VORGANG] as { clientInvoiceId?: string })?.clientInvoiceId).toBe(
      olderInvoice.id,
    );

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.record.status).toBe('finalized');
  });

  it('V4: Execute-Fehler erhalten die exakte Recovery-Zuordnung', async () => {
    const cases: [string, () => void, string, string][] = [
      [
        'unbekannte Cloud-Antwort',
        () => void (cloudState.finalizeError = { message: 'Failed to fetch' }),
        'unknown',
        'reload_required',
      ],
      [
        'Idempotenzkonflikt',
        () => void (cloudState.finalizeError = { message: 'Idempotenzkonflikt: abweichend' }),
        'conflict',
        'blocked',
      ],
      [
        'lokale Persistenz scheitert',
        () => {
          cloudState.finalizeError = null;
          localState.upsert = () => ({ ok: false, reason: 'local_persist_failed' });
        },
        'confirmed',
        'reload_required',
      ],
    ];

    for (const [label, seed, expectedCloudState, expectedRecovery] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      cloudState.rpcCalls = [];
      cloudState.finalizeError = null;
      localState.upsert = null;
      appState.snapshot = buildSnapshot();
      await seedActiveDraft();
      seed();

      const result = await startInvoiceDraftFinalization(startInput());
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.cloudState, label).toBe(expectedCloudState);
        expect(result.recovery, label).toBe(expectedRecovery);
        expect(result.clientInvoiceId, label).toBe(CLIENT_ID);
      }

      expect(
        rpcNames().filter((name) => name === 'finalize_workspace_invoice').length,
        label,
      ).toBe(1);

      const record = await loadRecord();
      expect(record.ok, label).toBe(true);
      if (record.ok) {
        expect(record.record.status, label).toBe('finalizing');
        expect(record.record.finalization?.finalizedAt, label).toBeUndefined();
        expect(record.record.finalization?.clientInvoiceId, label).toBe(CLIENT_ID);
      }
    }
  });

  it('V5: ein unerwarteter Wurf hinterlässt keine Queue-Arbeit', async () => {
    await seedActiveDraft();
    vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization').mockImplementation(() => {
      throw new Error('simulierter Fehler');
    });

    const result = await startInvoiceDraftFinalization(startInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unexpected_error');
      expect(result.clientInvoiceId).toBeUndefined();
    }

    expect(rpcNames()).not.toContain('finalize_workspace_invoice');
    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.revision).toBe(1);
    }

    // Die Queue ist frei, und es läuft nichts im Hintergrund nach.
    const rpcCountBefore = cloudState.rpcCalls.length;
    const follower = await runQueuedSyncOperation(async () => 'danach');
    expect(follower).toBe('danach');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cloudState.rpcCalls.length).toBe(rpcCountBefore);
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B — Recovery und Resume.
 * ========================================================================== */

/** Legt einen gültigen finalizing-Datensatz an und liefert dessen Vorbereitung. */
async function seedFinalizing(
  draftOverrides: Partial<InvoiceDraft> = {},
): Promise<{
  clientInvoiceId: string;
  contentFingerprint: string;
  request: Record<string, unknown>;
}> {
  const invoiceType = (draftOverrides.type ?? 'abschlag') as InvoiceDraftIdentity['invoiceType'];
  const seedIdentity = identity({ invoiceType });
  const created = await createInvoiceDraftRecord({
    identity: seedIdentity,
    draft: buildDraft(draftOverrides),
    now: '2026-08-21T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);

  const prepared = await preparedModule.prepareInvoiceDraftFinalization({
    vorgangId: VORGANG,
    draft: buildDraft(draftOverrides),
    setup: { companyName: 'Beispiel Betrieb GmbH', taxStatus: 'standard_19' } as never,
    approvalOptions: {},
    overbillingAcknowledged: false,
  });
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  if (!prepared.ok) throw new Error('prepare fehlgeschlagen');

  const begun = await durabilityModule.beginInvoiceDraftFinalization({
    identity: seedIdentity,
    expectedRevision: 1,
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request as never,
    approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
    now: '2026-08-21T09:30:00.000Z',
  });
  expect(begun.ok, JSON.stringify(begun)).toBe(true);

  return {
    clientInvoiceId: prepared.clientInvoiceId,
    contentFingerprint: prepared.contentFingerprint,
    request: prepared.request as unknown as Record<string, unknown>,
  };
}

/** Genau die Rechnung, die `execute` lokal übernehmen würde. */
function buildProvenLocalInvoice(request: Record<string, unknown>): VorgangInvoice {
  const invoice = request.invoice as Record<string, unknown>;
  const issueDate = String(invoice.issueDate ?? invoice.date);
  return {
    ...(invoice as unknown as VorgangInvoice),
    id: String(request.clientInvoiceId),
    number: '2026-0011',
    invoiceSequenceNumber: 11,
    status: 'vorbereitet',
    date: issueDate,
    issueDate,
    paymentStatus: 'offen',
    payments: [],
  } as VorgangInvoice;
}

/** Echte synthetische Cloud-Rohzeile zur gespeicherten Vorbereitung. */
function buildCloudRow(
  prepared: { clientInvoiceId: string; request: Record<string, unknown> },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload = {
    ...(prepared.request.invoicePayload as Record<string, unknown>),
    id: prepared.clientInvoiceId,
    number: '2026-0011',
    invoiceSequenceNumber: 11,
    status: 'vorbereitet',
  };
  return {
    id: 'cloud-row-real-1',
    workspace_id: WORKSPACE,
    vorgang_id: VORGANG,
    client_invoice_id: prepared.clientInvoiceId,
    invoice_number: '2026-0011',
    invoice_year: 2026,
    invoice_sequence_number: 11,
    invoice_type: 'abschlag',
    invoice_status: 'vorbereitet',
    payload,
    row_version: 1,
    created_at: '2026-08-21T09:00:00.000Z',
    updated_at: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

function placeInvoice(invoice: VorgangInvoice): void {
  appState.snapshot = {
    ...appState.snapshot,
    vorgaenge: (appState.snapshot.vorgaenge ?? []).map((entry) =>
      entry.id === VORGANG ? { ...entry, invoices: [invoice] } : entry,
    ),
  } as AppPersistedState;
}

function installNoNewPreparationSpies() {
  return {
    prepare: vi.spyOn(preparedModule, 'prepareInvoiceDraftFinalization'),
    begin: vi.spyOn(durabilityModule, 'beginInvoiceDraftFinalization'),
    generate: vi.spyOn(syncMetaService, 'generateEntityId'),
    resolveIntent: vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent'),
    clearIntent: vi.spyOn(intentService, 'clearInvoiceFinalizeIntent'),
    setItem: vi.spyOn(localStorage, 'setItem'),
    removeItem: vi.spyOn(localStorage, 'removeItem'),
  };
}

function expectNoNewPreparation(spies: ReturnType<typeof installNoNewPreparationSpies>): void {
  expect(spies.prepare).not.toHaveBeenCalled();
  expect(spies.begin).not.toHaveBeenCalled();
  expect(spies.generate).not.toHaveBeenCalled();
  expect(spies.resolveIntent).not.toHaveBeenCalled();
  expect(spies.clearIntent).not.toHaveBeenCalled();
  expect(
    spies.setItem.mock.calls.filter(([key]) =>
      String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
    ),
  ).toEqual([]);
  expect(
    spies.removeItem.mock.calls.filter(([key]) =>
      String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
    ),
  ).toEqual([]);
}

describe('01P4D2B — Finalizing-Recovery und Resume', () => {
  it('W1: ein finalized-Datensatz ist terminal', async () => {
    const prepared = await seedFinalizing();
    const invoice = buildProvenLocalInvoice(prepared.request);
    placeInvoice(invoice);
    const done = await durabilityModule.completeInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 2,
      clientInvoiceId: prepared.clientInvoiceId,
      contentFingerprint: prepared.contentFingerprint,
      finalizedInvoiceId: prepared.clientInvoiceId,
      archiveWarning: false,
      now: '2026-08-21T09:40:00.000Z',
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);

    cloudState.rpcCalls = [];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe('already_finalized');
      expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);
      expect(result.revision).toBe(3);
    }
    expect(cloudState.rpcCalls).toEqual([]);
    expectNoNewPreparation(spies);
  });

  it('W2: ein aktiver Entwurf ist kein Resume-Fall', async () => {
    await seedActiveDraft();
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('status_conflict');
    expect(cloudState.rpcCalls).toEqual([]);
    expectNoNewPreparation(spies);
  });

  it('W3: eine vollständig nachgewiesene lokale Rechnung führt direkt zu complete', async () => {
    const prepared = await seedFinalizing();
    const invoice = buildProvenLocalInvoice(prepared.request);
    placeInvoice(invoice);

    // Der vollständige Nachweis ist tatsächlich rekonstruierbar.
    expect(
      buildActualPreparedResponseProjection(buildInvoicePayloadV1(invoice) ?? {}),
    ).toBe(prepared.request.expectedResponseProjectionRawJson);

    cloudState.rpcCalls = [];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe('completed_local');
      expect(result.archiveWarning).toBe(false);
    }

    expect(cloudState.rpcCalls).toEqual([]);
    expect(localState.upsertCalls.length).toBe(0);
    expect(localState.archiveCalls.length).toBe(1);
    expectNoNewPreparation(spies);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.revision).toBe(3);
      expect(record.record.finalization?.finalizedInvoiceId).toBe(prepared.clientInvoiceId);
    }
  });

  it('W4: eine Abweichung nur in der Antwortprojektion blockiert', async () => {
    const prepared = await seedFinalizing();
    const invoice = buildProvenLocalInvoice(prepared.request);
    // Geschäfts-Fingerprint bleibt gleich, die Projektion nicht.
    const tampered = {
      ...invoice,
      legalNotices: ['nachträglich verändert'],
    } as VorgangInvoice;
    expect(
      invoiceServiceModule.buildInvoiceContentFingerprintFromInvoice(tampered),
    ).toBe(invoiceServiceModule.buildInvoiceContentFingerprintFromInvoice(invoice));
    placeInvoice(tampered);

    cloudState.rpcCalls = [];
    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(['projection_mismatch', 'finalization_mismatch']).toContain(result.reason);
      expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }
    expect(cloudState.rpcCalls).toEqual([]);
    expect(localState.archiveCalls.length).toBe(0);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.record.status).toBe('finalizing');
  });

  it('W5/W6: abweichender Inhalt und fremde Kennung blockieren', async () => {
    // W5 — gleiche ID, anderer Geschäftsinhalt.
    const prepared = await seedFinalizing();
    const invoice = buildProvenLocalInvoice(prepared.request);
    placeInvoice({ ...invoice, paymentTermsText: 'abweichend' } as VorgangInvoice);

    cloudState.rpcCalls = [];
    const mismatch = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toBe('finalization_mismatch');
    expect(cloudState.rpcCalls).toEqual([]);

    // W6 — gleicher Fingerprint, andere Kennung.
    placeInvoice({ ...invoice, id: 'inv-fremd-d-1' } as VorgangInvoice);
    cloudState.rpcCalls = [];
    const foreign = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe('possible_existing_invoice');
    expect(cloudState.rpcCalls).toEqual([]);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.record.status).toBe('finalizing');
  });

  it('W7: ein Cloud-Treffer beendet den Fall ohne Finalize-RPC', async () => {
    const prepared = await seedFinalizing();
    const invoice = buildProvenLocalInvoice(prepared.request);

    /*
     * Der Merge selbst ist durch invoiceCloudPullMergeService abgedeckt. Hier
     * wird die Entscheidungskette des Coordinators geprüft: der Abgleich
     * gelingt und übernimmt die Rechnung dauerhaft.
     */
    vi.spyOn(
      preflightModule,
      'runInvoiceFinalizationCloudReconciliationWithinSyncOperation',
    ).mockImplementation(async () => {
      placeInvoice(invoice);
      appState.saved.push(appState.snapshot);
      return { ok: true, pulledRowCount: 1, mergedInvoiceCount: 1, warnings: [] };
    });

    cloudState.rpcCalls = [];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.decision).toBe('completed_cloud_pull');

    expect(cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice')).toEqual(
      [],
    );
    expectNoNewPreparation(spies);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.record.status).toBe('finalized');
  });

  it('W8: ein leerer Pull führt zur Wiederholung mit dem gespeicherten Request', async () => {
    const prepared = await seedFinalizing();
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.decision).toBe('finalized');
      expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }

    const pulls = cloudState.rpcCalls.filter((call) => call.name === 'pull_workspace_invoices');
    const finalizes = cloudState.rpcCalls.filter(
      (call) => call.name === 'finalize_workspace_invoice',
    );
    expect(pulls.length).toBe(1);
    expect(pulls[0]?.args.p_since).toBeNull();
    expect(finalizes.length).toBe(1);
    expect(finalizes[0]?.args.p_client_invoice_id).toBe(prepared.clientInvoiceId);
    // Exakt der gespeicherte Request, einschließlich createdAt.
    expect(finalizes[0]?.args.p_invoice).toEqual(prepared.request.invoicePayload);
    expectNoNewPreparation(spies);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.revision).toBe(3);
    }
  });

  it('W9: ein gescheiterter Cloud-Abgleich verhindert jeden Finalize-RPC', async () => {
    const cases: [string, () => void][] = [
      ['pull_failed', () => void (cloudState.pullError = { message: 'Failed to fetch' })],
      ['pull_incomplete', () => void (cloudState.pullRows = [{ kaputt: true }])],
      ['workspace_changed', () => void (cloudState.workspaceId = 'ws-fremd')],
      ['scope_mismatch', () => setActiveStorageScope({ type: 'guest' })],
      ['persist_failed', () => void (appState.saveOk = false)],
    ];

    for (const [label, seed] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      localStorage.clear();
      cloudState.rpcCalls = [];
      cloudState.pullError = null;
      cloudState.pullRows = [];
      cloudState.workspaceId = WORKSPACE;
      appState.saveOk = true;
      appState.snapshot = buildSnapshot();
      setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
      const prepared = await seedFinalizing();
      cloudState.rpcCalls = [];
      seed();
      const spies = installNoNewPreparationSpies();

      const result = await resumeInvoiceDraftFinalization({ identity: identity() });
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.reason, label).toBe(label);
        expect(result.clientInvoiceId, label).toBe(prepared.clientInvoiceId);
      }
      expect(
        cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
        label,
      ).toEqual([]);
      expectNoNewPreparation(spies);

      const record = await loadRecord();
      expect(record.ok, label).toBe(true);
      if (record.ok) expect(record.record.status, label).toBe('finalizing');
    }
  });

  it('W10: Archiv-Recovery deckt alle drei Lagen ab', async () => {
    // (1) und (2) sind aus Coordinator-Sicht derselbe idempotente Aufruf.
    const prepared = await seedFinalizing();
    placeInvoice(buildProvenLocalInvoice(prepared.request));
    const linked = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (linked.ok) expect(linked.archiveWarning).toBe(false);
    expect(localState.archiveCalls.length).toBe(1);

    // (3) Archivierung scheitert — complete läuft trotzdem, mit Warnung.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    localStorage.clear();
    appState.snapshot = buildSnapshot();
    localState.archiveCalls = [];
    const second = await seedFinalizing();
    placeInvoice(buildProvenLocalInvoice(second.request));
    localState.archive = () => ({ success: false, reason: 'archive_failed' });

    const warned = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(warned.ok, JSON.stringify(warned)).toBe(true);
    if (warned.ok) expect(warned.archiveWarning).toBe(true);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.finalization?.archiveWarning).toBe(true);
    }
  });

  it('W11: complete committed_but_unverified erfindet keinen Erfolg', async () => {
    const prepared = await seedFinalizing();
    placeInvoice(buildProvenLocalInvoice(prepared.request));

    const completeOriginal = durabilityModule.completeInvoiceDraftFinalization;
    vi.spyOn(durabilityModule, 'completeInvoiceDraftFinalization').mockImplementation(
      async (completeInput) => {
        const written = await completeOriginal(completeInput);
        expect(written.ok).toBe(true);
        return { ok: false, reason: 'committed_but_unverified' } as never;
      },
    );

    cloudState.rpcCalls = [];
    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('committed_but_unverified');
      expect(result.recovery).toBe('reload_required');
      expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }
    expect(cloudState.rpcCalls).toEqual([]);
  });

  it('W12: zwei gleichzeitige Resume-Aufrufe erzeugen genau einen Finalize-RPC', async () => {
    const prepared = await seedFinalizing();
    let release: (() => void) | null = null;
    cloudState.finalizeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cloudState.rpcCalls = [];

    const first = resumeInvoiceDraftFinalization({ identity: identity() });
    await vi.waitFor(() => expect(rpcNames()).toContain('finalize_workspace_invoice'));
    const second = resumeInvoiceDraftFinalization({ identity: identity() });

    release?.();
    const firstResult = await first;
    const secondResult = await second;

    expect(firstResult.ok, JSON.stringify(firstResult)).toBe(true);
    if (firstResult.ok) expect(firstResult.decision).toBe('finalized');
    expect(secondResult.ok, JSON.stringify(secondResult)).toBe(true);
    if (secondResult.ok) {
      expect(secondResult.decision).toBe('already_finalized');
      expect(secondResult.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice').length,
    ).toBe(1);
  });

  it('W13: die Intent-Lage wird im Recovery-Fall vollständig ausgewertet', async () => {
    const scopeKey = { type: 'workspace' as const, workspaceId: WORKSPACE };

    // (a) Beschädigter Speicher blockiert.
    let prepared = await seedFinalizing();
    localStorage.setItem(
      `${buildStorageKey(scopeKey)}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`,
      '{ kein json',
    );
    cloudState.rpcCalls = [];
    const corrupt = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toBe('intent_corrupt');
    expect(cloudState.rpcCalls).toEqual([]);

    // (b) Gleiche Kennung, abweichender Fingerprint blockiert.
    localStorage.clear();
    seedIntent(scopeKey, {
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      clientInvoiceId: prepared.clientInvoiceId,
      contentFingerprint: 'fp-abweichend',
      createdAt: '2026-08-10T09:00:00.000Z',
    });
    cloudState.rpcCalls = [];
    const conflicting = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.reason).toBe('legacy_intent_conflict');
    expect(cloudState.rpcCalls).toEqual([]);

    // (c) Gleiche Kennung und gleicher Fingerprint erlauben die Fortsetzung.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    localStorage.clear();
    appState.snapshot = buildSnapshot();
    cloudState.rpcCalls = [];
    prepared = await seedFinalizing();
    seedIntent(scopeKey, {
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      clientInvoiceId: prepared.clientInvoiceId,
      contentFingerprint: prepared.contentFingerprint,
      createdAt: '2026-08-10T09:00:00.000Z',
    });
    const allowed = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    // Der Intent bleibt unverändert.
    const stored = JSON.parse(
      localStorage.getItem(`${buildStorageKey(scopeKey)}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`) ??
        '{}',
    ) as Record<string, { clientInvoiceId?: string }>;
    expect(stored[VORGANG]?.clientInvoiceId).toBe(prepared.clientInvoiceId);
  });

  it('X1: der gemeinsame Execute-Recovery-Vertrag gilt für jeden Grund', async () => {
    const cases: [string, string, string][] = [
      // Vorübergehende Voraussetzung — später erneut Resume.
      ['offline_or_unconfigured', 'not_committed', 'retry_allowed'],
      ['auth_missing', 'not_committed', 'retry_allowed'],
      ['workspace_missing', 'not_committed', 'retry_allowed'],
      ['workspace_changed', 'not_committed', 'retry_allowed'],
      ['scope_mismatch', 'not_committed', 'retry_allowed'],
      ['storage_failed', 'not_committed', 'retry_allowed'],
      // Zustandsrennen.
      ['conflict', 'not_committed', 'reload_required'],
      ['status_conflict', 'not_committed', 'reload_required'],
      // Unsicherer Ausgang.
      ['rpc_failed', 'unknown', 'reload_required'],
      // Bestätigt, lokale Persistenz gescheitert.
      ['local_persist_failed', 'confirmed', 'reload_required'],
      // Dauerhafte Inhalts- und Identitätskonflikte.
      ['idempotency_conflict', 'conflict', 'blocked'],
      ['cloud_response_mismatch', 'confirmed', 'blocked'],
      ['local_conflict', 'confirmed', 'blocked'],
      ['request_invalid', 'not_committed', 'blocked'],
      ['approval_context_invalid', 'not_committed', 'blocked'],
      ['fingerprint_mismatch', 'not_committed', 'blocked'],
      ['corrupt', 'not_committed', 'blocked'],
      ['unsupported_preparation', 'not_committed', 'blocked'],
      ['amendment_state_stale', 'not_committed', 'blocked'],
    ];

    for (const [reason, cloudStateValue, expectedRecovery] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      localStorage.clear();
      cloudState.rpcCalls = [];
      appState.snapshot = buildSnapshot();
      const prepared = await seedFinalizing();

      const spy = vi
        .spyOn(preparedModule, 'executePreparedInvoiceFinalization')
        .mockResolvedValue({
          ok: false,
          reason: reason as never,
          cloudState: cloudStateValue as never,
        });
      const spies = installNoNewPreparationSpies();

      const result = await resumeInvoiceDraftFinalization({ identity: identity() });
      expect(result.ok, reason).toBe(false);
      if (!result.ok) {
        expect(result.reason, reason).toBe(reason);
        expect(result.recovery, reason).toBe(expectedRecovery);
        expect(result.clientInvoiceId, reason).toBe(prepared.clientInvoiceId);
      }
      expectNoNewPreparation(spies);

      const record = await loadRecord();
      expect(record.ok, reason).toBe(true);
      if (record.ok) {
        expect(record.record.status, reason).toBe('finalizing');
        expect(record.record.revision, reason).toBe(2);
        expect(record.record.finalization?.finalizedAt, reason).toBeUndefined();
      }
      spy.mockRestore();
    }
  });

  it('X2: die Reconciliation-Zuordnung unterscheidet vorübergehend und dauerhaft', async () => {
    const cases: [string, () => void, string][] = [
      [
        'pull_failed',
        () => void (cloudState.pullError = { message: 'Failed to fetch' }),
        'retry_allowed',
      ],
      ['persist_failed', () => void (appState.saveOk = false), 'retry_allowed'],
      ['workspace_changed', () => void (cloudState.workspaceId = 'ws-fremd'), 'retry_allowed'],
      ['scope_mismatch', () => setActiveStorageScope({ type: 'guest' }), 'retry_allowed'],
      ['pull_incomplete', () => void (cloudState.pullRows = [{ kaputt: true }]), 'blocked'],
    ];

    for (const [label, seed, expectedRecovery] of cases) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      localStorage.clear();
      cloudState.rpcCalls = [];
      cloudState.pullError = null;
      cloudState.pullRows = [];
      cloudState.workspaceId = WORKSPACE;
      appState.saveOk = true;
      appState.snapshot = buildSnapshot();
      setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
      const prepared = await seedFinalizing();
      cloudState.rpcCalls = [];
      seed();
      const spies = installNoNewPreparationSpies();

      const result = await resumeInvoiceDraftFinalization({ identity: identity() });
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.reason, label).toBe(label);
        expect(result.recovery, label).toBe(expectedRecovery);
        expect(result.clientInvoiceId, label).toBe(prepared.clientInvoiceId);
      }

      expect(
        cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
        label,
      ).toEqual([]);
      expectNoNewPreparation(spies);

      const record = await loadRecord();
      expect(record.ok, label).toBe(true);
      if (record.ok) {
        expect(record.record.status, label).toBe('finalizing');
        expect(record.record.revision, label).toBe(2);
        expect(record.record.finalization?.clientInvoiceId, label).toBe(prepared.clientInvoiceId);
      }
    }
  });

  it('X3: fremde Zeile und echter Merge-Konflikt blockieren', async () => {
    // (1) Workspace-fremde, strukturell gültige Rohzeile.
    let prepared = await seedFinalizing();
    cloudState.rpcCalls = [];
    cloudState.pullRows = [buildCloudRow(prepared, { workspace_id: 'ws-fremd' })];

    const foreign = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(foreign.ok, JSON.stringify(foreign)).toBe(false);
    if (!foreign.ok) {
      expect(foreign.reason).toBe('pull_incomplete');
      expect(foreign.recovery).toBe('blocked');
    }
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
    ).toEqual([]);

    // (2) Echter Merge-Konflikt: gleiche Nummer, andere Kennung.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    localStorage.clear();
    cloudState.rpcCalls = [];
    cloudState.pullRows = [];
    appState.snapshot = buildSnapshot();
    prepared = await seedFinalizing();

    const conflicting = {
      ...buildProvenLocalInvoice(prepared.request),
      id: 'inv-lokal-anders',
      // Gleiche Nummer wie die Cloud-Zeile, aber anderer Inhalt und andere ID.
      number: '2026-0011',
      paymentTermsText: 'lokal abweichend',
    } as VorgangInvoice;
    placeInvoice(conflicting);
    cloudState.pullRows = [buildCloudRow(prepared)];
    cloudState.rpcCalls = [];
    const spies = installNoNewPreparationSpies();

    const conflict = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(conflict.ok, JSON.stringify(conflict)).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('merge_conflict');
      expect(conflict.recovery).toBe('blocked');
    }
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
    ).toEqual([]);
    expectNoNewPreparation(spies);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.record.status).toBe('finalizing');
  });

  it('01P4D2B2 Y5: die reale Cloud-Brücke führt bis complete', async () => {
    const prepared = await seedFinalizing();
    cloudState.rpcCalls = [];
    cloudState.pullRows = [buildCloudRow(prepared)];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.decision).toBe('completed_cloud_pull');
    expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);

    // Echte Zeile, echter Pull, echter Merge, echte Persistenz.
    const pulls = cloudState.rpcCalls.filter((call) => call.name === 'pull_workspace_invoices');
    expect(pulls.length).toBe(1);
    expect(pulls[0]?.args.p_since).toBeNull();
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
    ).toEqual([]);
    expect(appState.saved.length).toBeGreaterThan(0);

    const merged = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG);
    const adopted = merged?.invoices?.find(
      (invoice) => invoice.id === prepared.clientInvoiceId,
    );
    expect(adopted, 'Cloud-Rechnung wurde nicht übernommen').toBeDefined();

    // Der leere Skontotext überlebt das Mapping exakt.
    expect((adopted as unknown as { skontoText?: string }).skontoText).toBe('');

    // Geschäfts-Fingerprint **und** rekonstruierte Projektion stimmen.
    expect(
      invoiceServiceModule.buildInvoiceContentFingerprintFromInvoice(adopted!),
    ).toBe(prepared.contentFingerprint);
    expect(buildActualPreparedResponseProjection(buildInvoicePayloadV1(adopted!) ?? {})).toBe(
      prepared.request.expectedResponseProjectionRawJson,
    );

    expect(localState.archiveCalls.length).toBe(1);
    expect(localState.upsertCalls.length).toBe(0);
    expectNoNewPreparation(spies);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.finalization?.clientInvoiceId).toBe(prepared.clientInvoiceId);
      expect(record.record.finalization?.finalizedInvoiceId).toBe(prepared.clientInvoiceId);
    }
  });

  it('01P4D2B3 Z5: die reale Schlussrechnungs-Cloud-Brücke führt bis complete', async () => {
    // Eine Schlussrechnung trägt keine Abschlagsnummer und eine eingefrorene
    // Nachtragsfolge — hier bewusst 0.
    const prepared = await seedFinalizing({
      type: 'schluss',
      abschlagNumber: undefined,
      calculationMode: undefined,
      expectedAmendmentSequence: 0,
    });
    cloudState.rpcCalls = [];
    cloudState.pullRows = [buildCloudRow(prepared, { invoice_type: 'schluss' })];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({
      identity: identity({ invoiceType: 'schluss' }),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.decision).toBe('completed_cloud_pull');
    expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);

    const pulls = cloudState.rpcCalls.filter((call) => call.name === 'pull_workspace_invoices');
    expect(pulls.length).toBe(1);
    expect(pulls[0]?.args.p_since).toBeNull();
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
    ).toEqual([]);
    expect(appState.saved.length).toBeGreaterThan(0);

    const merged = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG);
    const adopted = merged?.invoices?.find(
      (invoice) => invoice.id === prepared.clientInvoiceId,
    );
    expect(adopted, 'Cloud-Rechnung wurde nicht übernommen').toBeDefined();
    expect(adopted?.expectedAmendmentSequence).toBe(0);

    expect(
      invoiceServiceModule.buildInvoiceContentFingerprintFromInvoice(adopted!),
    ).toBe(prepared.contentFingerprint);
    expect(buildActualPreparedResponseProjection(buildInvoicePayloadV1(adopted!) ?? {})).toBe(
      prepared.request.expectedResponseProjectionRawJson,
    );

    expect(localState.archiveCalls.length).toBe(1);
    expectNoNewPreparation(spies);

    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'schluss',
    });
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalized');
      expect(record.record.finalization?.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }
  });

  it('01P4D2B4 P7: eine ungültige Cloud-Zeile verhindert jede Resume-Persistenz', async () => {
    const prepared = await seedFinalizing();
    cloudState.rpcCalls = [];
    const base = buildCloudRow(prepared);
    cloudState.pullRows = [
      {
        ...base,
        payload: { ...(base.payload as Record<string, unknown>), amount: 'zwölf' },
      },
    ];
    appState.saved = [];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pull_incomplete');
      expect(result.recovery).toBe('blocked');
      expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }

    expect(appState.saved.length).toBe(0);
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
    ).toEqual([]);
    expect(localState.archiveCalls.length).toBe(0);
    expectNoNewPreparation(spies);

    // Kein Cloud-Beleg wurde lokal eingefügt.
    const vorgang = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG);
    expect(vorgang?.invoices ?? []).toEqual([]);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalizing');
      expect(record.record.revision).toBe(2);
      expect(record.record.finalization?.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }
  });

  /*
   * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1C — Widerspruch zwischen
   * Zeilenspalte und Payload verhält sich wie eine kaputte Zeile.
   */
  it('01P4E1C S6: eine widersprüchliche Cloud-Zeile verhindert jede Resume-Persistenz', async () => {
    const prepared = await seedFinalizing();
    cloudState.rpcCalls = [];
    const base = buildCloudRow(prepared);
    cloudState.pullRows = [
      {
        ...base,
        // Typgültig, aber die Zeilenspalte widerspricht dem Payload.
        payload: { ...(base.payload as Record<string, unknown>), number: '2026-9999' },
      },
    ];
    appState.saved = [];
    const spies = installNoNewPreparationSpies();

    const result = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('pull_incomplete');
      expect(result.recovery).toBe('blocked');
      expect(result.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }

    expect(appState.saved.length).toBe(0);
    expect(
      cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
    ).toEqual([]);
    expect(localState.archiveCalls.length).toBe(0);
    expectNoNewPreparation(spies);

    const vorgang = (appState.snapshot.vorgaenge ?? []).find((entry) => entry.id === VORGANG);
    expect(vorgang?.invoices ?? []).toEqual([]);

    const record = await loadRecord();
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalizing');
      expect(record.record.revision).toBe(2);
      expect(record.record.finalization?.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }
  });

  it('W14: kein Resume-Pfad erzeugt Kennung, Vorbereitung oder Intent', async () => {
    // Erfolgspfad über Execute — Spies erst nach dem Aufbau setzen.
    await seedFinalizing();
    const successSpies = installNoNewPreparationSpies();
    const success = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(success.ok, JSON.stringify(success)).toBe(true);
    expectNoNewPreparation(successSpies);
    vi.restoreAllMocks();
    installEnvironment();

    // Fehlerpfad.
    await resetInvoiceDraftDurabilityDatabaseForTests();
    localStorage.clear();
    appState.snapshot = buildSnapshot();
    await seedFinalizing();
    cloudState.pullError = { message: 'Failed to fetch' };
    const failureSpies = installNoNewPreparationSpies();
    const failure = await resumeInvoiceDraftFinalization({ identity: identity() });
    expect(failure.ok).toBe(false);
    expectNoNewPreparation(failureSpies);
  });
});
