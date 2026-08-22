/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4C — Queue und fail-closed
 * Cloud-Preflight.
 *
 * Ausschließlich synthetische, neutrale Daten. Kein Test behauptet einen
 * tabübergreifenden Schutz.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPersistedState, InvoiceDraft, InvoiceDraftPosition } from '../../types/models';
import type { InvoiceDraftIdentity } from '../../types/invoiceDraftDurability';

import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import * as workspaceSyncPayloadService from '../workspace/workspaceSyncPayloadService';
import * as queueModule from '../sync/syncOperationQueue';
import * as syncUiService from '../sync/syncUiService';
import * as syncCoordinatorModule from '../sync/syncCoordinator';
import * as intentService from './invoiceFinalizeIntentService';

import {
  isActiveSyncOperationLease,
  runQueuedSyncOperation,
  resetSyncOperationQueueForTests,
  type SyncOperationLease,
} from '../sync/syncOperationQueue';
import {
  runInvoiceFinalizationCloudReconciliationWithinSyncOperation,
  runInvoiceFinalizationPreflight,
  runInvoiceFinalizationPreflightWithinSyncOperation,
} from './invoiceFinalizationPreflightService';
import * as durabilityModule from './invoiceDraftDurabilityService';
import {
  INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX,
  type InvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';
import {
  beginInvoiceDraftFinalization,
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
  saveInvoiceDraftRecord,
} from './invoiceDraftDurabilityService';
import {
  buildStorageKey,
  resetStorageScopeForTests,
  setActiveStorageScope,
} from '../storage/storageScopeService';
import { buildInvoiceFinalizationContentFingerprint } from '../invoiceService';
import { prepareInvoiceDraftFinalization } from './invoicePreparedFinalizeService';

const WORKSPACE = 'ws-c-1';
const SCOPE = 'workspace:ws-c-1';
const VORGANG = 'vg-c-1';
const DRAFT_ID = 'draft-c-1';
const LONG_TEXT = `Hinweis ${'Beispieltext '.repeat(10)}Ende`;

const cloudState = {
  configured: true,
  session: { user: { id: 'u-1' } } as unknown,
  sessionGate: null as null | Promise<void>,
  /** Hält den RPC an, nachdem er nachweislich begonnen hat. */
  rpcGate: null as null | Promise<void>,
  rpcStarted: [] as string[],
  workspaceId: WORKSPACE,
  rows: [] as unknown[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as null | { message: string },
};

const appState = {
  snapshot: null as unknown as AppPersistedState,
  saved: [] as AppPersistedState[],
  saveOk: true,
  applied: [] as AppPersistedState[],
  /** Läuft unmittelbar nach einer erfolgreichen Persistenz. */
  onSaved: null as null | (() => void),
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

function buildSetup(companyName = 'Beispiel Betrieb GmbH') {
  return { companyName, taxStatus: 'standard_19' } as never;
}

function buildSnapshot(overrides: Partial<AppPersistedState> = {}): AppPersistedState {
  return {
    version: 1,
    setup: buildSetup(),
    inboxItems: [],
    tasks: [],
    documents: [],
    vorgaenge: [{ id: VORGANG, invoices: [] }],
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

function buildCloudRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloud-row-1',
    workspace_id: WORKSPACE,
    vorgang_id: VORGANG,
    client_invoice_id: 'inv-cloud-0001',
    invoice_number: '2026-0007',
    invoice_year: 2026,
    invoice_sequence_number: 7,
    invoice_type: 'abschlag',
    invoice_status: 'vorbereitet',
    payload: {
      id: 'inv-cloud-0001',
      number: '2026-0007',
      type: 'abschlag',
      positions: [],
      subtotal: 10,
      amount: 11.9,
      taxStatus: 'standard_19',
      status: 'vorbereitet',
      date: '2026-08-21',
      createdAt: '2026-08-21T09:00:00.000Z',
      issueDate: '2026-08-21',
    },
    row_version: 1,
    created_at: '2026-08-21T09:00:00.000Z',
    updated_at: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

function intentKey(scope: Parameters<typeof buildStorageKey>[0]): string {
  return `${buildStorageKey(scope)}${INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX}`;
}

function seedIntent(
  scope: Parameters<typeof buildStorageKey>[0],
  intent: InvoiceFinalizeIntent,
): void {
  const key = intentKey(scope);
  const raw = localStorage.getItem(key);
  const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  map[intent.vorgangId] = intent;
  localStorage.setItem(key, JSON.stringify(map));
}

function installEnvironment(): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockImplementation(() => cloudState.configured);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockImplementation(
    () =>
      ({
        auth: {
          getSession: async () => {
            if (cloudState.sessionGate) await cloudState.sessionGate;
            return { data: { session: cloudState.session }, error: null };
          },
        },
        rpc: async (name: string, args: Record<string, unknown>) => {
          cloudState.rpcCalls.push({ name, args });
          cloudState.rpcStarted.push(name);
          if (cloudState.rpcGate) await cloudState.rpcGate;
          if (cloudState.rpcError) return { data: null, error: cloudState.rpcError };
          return { data: cloudState.rows, error: null };
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
    appState.onSaved?.();
    return true;
  });
  vi.spyOn(persistenceService, 'applyStateToStores').mockImplementation((state) => {
    appState.applied.push(state);
  });
}

async function seedActiveDraft(draft: InvoiceDraft = buildDraft()): Promise<void> {
  const created = await createInvoiceDraftRecord({
    identity: identity(),
    draft,
    now: '2026-08-21T08:00:00.000Z',
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetSyncOperationQueueForTests();
  localStorage.clear();
  cloudState.configured = true;
  cloudState.session = { user: { id: 'u-1' } };
  cloudState.sessionGate = null;
  cloudState.rpcGate = null;
  cloudState.rpcStarted = [];
  cloudState.workspaceId = WORKSPACE;
  cloudState.rows = [];
  cloudState.rpcCalls = [];
  cloudState.rpcError = null;
  appState.snapshot = buildSnapshot();
  appState.saved = [];
  appState.saveOk = true;
  appState.applied = [];
  appState.onSaved = null;
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

describe('01P4C — gemeinsame Sync-Queue', () => {
  it('L1: ein Lauf umfasst Netzwerk und anschließende Persistenz', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runQueuedSyncOperation(async () => {
      order.push('a:start');
      await gate;
      order.push('a:persist');
      return 'a';
    });
    const second = runQueuedSyncOperation(async () => {
      order.push('b:start');
      return 'b';
    });

    // Der zweite Lauf darf erst nach der Persistenz des ersten beginnen.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    release?.();
    expect(await first).toBe('a');
    expect(await second).toBe('b');
    expect(order).toEqual(['a:start', 'a:persist', 'b:start']);
  });

  it('L2: ein Wurf gibt die Queue frei', async () => {
    await expect(
      runQueuedSyncOperation(async () => {
        throw new Error('simulierter Fehler');
      }),
    ).rejects.toThrow('simulierter Fehler');

    await expect(runQueuedSyncOperation(async () => 'danach')).resolves.toBe('danach');
  });

  it('L3: ein wartender Lauf bildet seinen Snapshot erst beim Start', async () => {
    const seen: number[] = [];
    let counter = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runQueuedSyncOperation(async () => {
      await gate;
      counter += 1;
      return counter;
    });
    const second = runQueuedSyncOperation(async () => {
      // Snapshot entsteht erst hier — nicht beim Einreihen.
      seen.push(counter);
      return counter;
    });

    expect(seen).toEqual([]);
    release?.();
    await first;
    await second;
    expect(seen).toEqual([1]);
    // Kein geteiltes Ergebnis.
    expect(await first).not.toBe(undefined);
  });

  it('L5: runSyncFromUi läuft innerhalb der Queue', async () => {
    const queued = vi.spyOn(queueModule, 'runQueuedSyncOperation');
    vi.spyOn(syncCoordinatorModule, 'getSyncCoordinator').mockReturnValue({
      runSync: async () => ({
        state: appState.snapshot,
        report: { errors: [], errorCount: 0 } as never,
        success: true,
        skipPersist: true,
      }),
    } as never);

    await syncUiService.runSyncFromUi();
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('L6: retrySyncFromUi verwendet dieselbe Queue', async () => {
    const queued = vi.spyOn(queueModule, 'runQueuedSyncOperation');
    vi.spyOn(syncCoordinatorModule, 'getSyncCoordinator').mockReturnValue({
      retrySync: async () => ({
        state: appState.snapshot,
        report: { errors: [], errorCount: 0 } as never,
        success: true,
        skipPersist: true,
      }),
    } as never);

    await syncUiService.retrySyncFromUi();
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('L5b: Preflight und normaler Sync laufen im selben Tab nicht gleichzeitig', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sync = runQueuedSyncOperation(async () => {
      order.push('sync:start');
      await gate;
      order.push('sync:end');
      return 'sync';
    });

    await seedActiveDraft();
    cloudState.rows = [];
    const preflight = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    }).then((result) => {
      order.push('preflight:done');
      return result;
    });

    expect(cloudState.rpcCalls.length).toBe(0);
    release?.();
    await sync;
    await preflight;
    expect(order[0]).toBe('sync:start');
    expect(order[1]).toBe('sync:end');
    expect(order[2]).toBe('preflight:done');
  });
});

describe('01P4C — fail-closed Cloud-Preflight', () => {
  it('L11: eine ungültige oder workspace-fremde Zeile verhindert Merge und Persistenz', async () => {
    for (const [label, rows] of [
      ['unlesbare Zeile', [buildCloudRow(), { kaputt: true }]],
      ['fremder Workspace', [buildCloudRow({ workspace_id: 'ws-fremd' })]],
    ] as [string, unknown[]][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      appState.saved = [];
      await seedActiveDraft();
      cloudState.rows = rows;

      const result = await runInvoiceFinalizationPreflight({
        identity: identity(),
        expectedRevision: 1,
      });
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe('pull_incomplete');
      expect(appState.saved.length, label).toBe(0);
    }
  });

  it('L12: ein Pull-Fehler blockiert ohne Persistenz', async () => {
    await seedActiveDraft();
    cloudState.rpcError = { message: 'Failed to fetch' };

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('pull_failed');
    expect(appState.saved.length).toBe(0);
  });

  it('L13: ein Persistenzfehler blockiert', async () => {
    await seedActiveDraft();
    cloudState.rows = [];
    appState.saveOk = false;

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason, JSON.stringify(result)).toBe('persist_failed');
  });

  it('L14: ein Revisionswechsel während des Pulls liefert conflict', async () => {
    await seedActiveDraft();
    cloudState.rows = [];
    let release: (() => void) | null = null;
    cloudState.sessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    await saveInvoiceDraftRecord({
      identity: identity(),
      draft: buildDraft({ introText: 'zwischendurch geändert' }),
      expectedRevision: 1,
      now: '2026-08-21T08:30:00.000Z',
    });
    release?.();

    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) expect(result.reason).toBe('conflict');
  });

  it('L4: eine lokale Änderung während des Pulls bleibt im persistierten Zustand', async () => {
    await seedActiveDraft();
    cloudState.rows = [];
    let release: (() => void) | null = null;
    cloudState.sessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    // Der Nutzer arbeitet weiter, während der Preflight wartet.
    appState.snapshot = buildSnapshot({
      tasks: [{ id: 't-neu', title: 'Während des Pulls angelegt' }] as never,
    });
    release?.();

    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(appState.saved.length).toBe(1);
    expect(appState.saved[0]?.tasks?.[0]?.id).toBe('t-neu');
    expect(appState.snapshot.tasks?.[0]?.id).toBe('t-neu');
  });

  it('L15: der Setup-Snapshot stammt aus dem neuesten Zustand und ist getrennt', async () => {
    const draft = buildDraft();
    await seedActiveDraft(draft);
    cloudState.rows = [];

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.revision).toBe(1);
    expect(result.setupSnapshot.companyName).toBe('Beispiel Betrieb GmbH');
    expect(result.contentFingerprint).toBe(
      buildInvoiceFinalizationContentFingerprint(result.draft, result.setupSnapshot),
    );

    // Getrennte Objekte: äußere Mutation wirkt nicht auf den App-Zustand.
    (result.setupSnapshot as { companyName: string }).companyName = 'Fremde Firma GmbH';
    (result.draft as { introText?: string }).introText = 'manipuliert';
    expect(appState.snapshot.setup.companyName).toBe('Beispiel Betrieb GmbH');

    const reloaded = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.draft.introText).toBe(LONG_TEXT);
  });

  it('L16: ein exakt lokal aufgelöster Altintent blockiert nicht, auch unter fremdem Scope', async () => {
    const draft = buildDraft();
    await seedActiveDraft(draft);

    // Eine dauerhaft lokale Rechnung mit genau diesem Inhalt.
    const existing = {
      id: 'inv-alt-0001',
      number: '2026-0003',
      type: 'gutschrift',
      positions: [],
      subtotal: 5,
      amount: 5.95,
      taxStatus: 'standard_19',
      status: 'vorbereitet',
      date: '2026-08-10',
      createdAt: '2026-08-10T09:00:00.000Z',
    };
    appState.snapshot = buildSnapshot({
      vorgaenge: [{ id: VORGANG, invoices: [existing] }] as never,
    });
    const fingerprint = (
      await import('../invoiceService')
    ).buildInvoiceContentFingerprintFromInvoice(existing as never);

    seedIntent(
      { type: 'guest' },
      {
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId: 'inv-alt-0001',
        contentFingerprint: fingerprint,
        createdAt: '2026-08-10T09:00:00.000Z',
      },
    );

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.cloudReconciliation.resolvedLegacyIntentCount).toBe(1);
    expect(result.cloudReconciliation.warnings).toContain('wrong_storage_scope');
    // Der Intent bleibt unangetastet.
    expect(localStorage.getItem(intentKey({ type: 'guest' }))).not.toBeNull();
  });

  it('L17: gleicher Fingerprint mit anderer ID liefert possible_existing_invoice', async () => {
    const draft = buildDraft();
    await seedActiveDraft(draft);

    // Eine lokale Rechnung mit exakt dem Inhalt des aktiven Entwurfs.
    const setup = buildSetup();
    const candidate = (await import('../invoiceService')).buildInvoiceFinalizationCandidate;
    vi.spyOn(
      await import('../vorgangService'),
      'getVorgangById',
    ).mockReturnValue({ id: VORGANG } as never);
    const built = candidate(VORGANG, draft, setup, 'inv-vorhanden-1', {});
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    appState.snapshot = buildSnapshot({
      vorgaenge: [{ id: VORGANG, invoices: [built.invoice] }] as never,
    });

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('possible_existing_invoice');
      expect(result.existingInvoiceId).toBe('inv-vorhanden-1');
    }
  });

  it('L18: gleiche ID mit anderem Fingerprint liefert legacy_intent_conflict', async () => {
    await seedActiveDraft();
    const existing = {
      id: 'inv-alt-0002',
      number: '2026-0004',
      type: 'gutschrift',
      positions: [],
      subtotal: 5,
      amount: 5.95,
      taxStatus: 'standard_19',
      status: 'vorbereitet',
      date: '2026-08-10',
      createdAt: '2026-08-10T09:00:00.000Z',
    };
    appState.snapshot = buildSnapshot({
      vorgaenge: [{ id: VORGANG, invoices: [existing] }] as never,
    });

    seedIntent(
      { type: 'workspace', workspaceId: WORKSPACE },
      {
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId: 'inv-alt-0002',
        contentFingerprint: 'fp-abweichend',
        createdAt: '2026-08-10T09:00:00.000Z',
      },
    );

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('legacy_intent_conflict');
  });

  it('L18b: ein Altintent ohne jeden Treffer liefert legacy_intent_unresolved', async () => {
    await seedActiveDraft();
    seedIntent(
      { type: 'workspace', workspaceId: WORKSPACE },
      {
        workspaceId: WORKSPACE,
        vorgangId: VORGANG,
        clientInvoiceId: 'inv-verwaist-1',
        contentFingerprint: 'fp-verwaist',
        createdAt: '2026-08-10T09:00:00.000Z',
      },
    );

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('legacy_intent_unresolved');
  });

  it('L19: ein legitimer weiterer Entwurf mit anderem Fingerprint bleibt erlaubt', async () => {
    await seedActiveDraft();
    const other = {
      id: 'inv-alt-0003',
      number: '2026-0005',
      type: 'abschlag',
      abschlagNumber: 9,
      positions: [],
      subtotal: 1,
      amount: 1.19,
      taxStatus: 'standard_19',
      status: 'vorbereitet',
      date: '2026-08-05',
      createdAt: '2026-08-05T09:00:00.000Z',
    };
    appState.snapshot = buildSnapshot({
      vorgaenge: [{ id: VORGANG, invoices: [other] }] as never,
    });

    const result = await runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('N1: ein Workspace-Wechsel nach erfolgreicher Persistenz blockiert', async () => {
    await seedActiveDraft();
    cloudState.rows = [];
    let release: (() => void) | null = null;
    cloudState.rpcGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Unmittelbar nach der erfolgreichen Persistenz wechselt der Workspace.
    appState.onSaved = () => {
      cloudState.workspaceId = 'ws-fremd';
    };

    const pending = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    // Der RPC hat nachweislich begonnen.
    await vi.waitFor(() => expect(cloudState.rpcStarted).toContain('pull_workspace_invoices'));
    release?.();

    const result = await pending;
    expect(appState.saved.length).toBe(1);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) expect(result.reason).toBe('workspace_changed');
    expect(JSON.stringify(result)).not.toContain('clientInvoiceId');

    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.revision).toBe(1);
    }
    expect(cloudState.rpcCalls.every((call) => call.name !== 'finalize_workspace_invoice')).toBe(
      true,
    );
  });

  it('N2: ein Scope-Wechsel nach erfolgreicher Persistenz blockiert', async () => {
    await seedActiveDraft();
    cloudState.rows = [];
    let release: (() => void) | null = null;
    cloudState.rpcGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Unmittelbar nach der erfolgreichen Persistenz wechselt der Scope.
    appState.onSaved = () => {
      setActiveStorageScope({ type: 'guest' });
    };

    const pending = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    await vi.waitFor(() => expect(cloudState.rpcStarted).toContain('pull_workspace_invoices'));
    release?.();

    const result = await pending;
    expect(appState.saved.length).toBe(1);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_mismatch');
    expect(JSON.stringify(result)).not.toContain('clientInvoiceId');
    expect(cloudState.rpcCalls.every((call) => call.name !== 'finalize_workspace_invoice')).toBe(
      true,
    );
  });

  it('N3: ein Setup-Wechsel während des angehaltenen RPC liefert das neue Setup', async () => {
    const draft = buildDraft();
    await seedActiveDraft(draft);
    cloudState.rows = [];
    let release: (() => void) | null = null;
    cloudState.rpcGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    });
    await vi.waitFor(() => expect(cloudState.rpcStarted).toContain('pull_workspace_invoices'));
    // Erst jetzt — der RPC läuft nachweislich — wechselt das Setup.
    appState.snapshot = buildSnapshot({ setup: buildSetup('Neue Betrieb GmbH') });
    release?.();

    const result = await pending;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.setupSnapshot.companyName).toBe('Neue Betrieb GmbH');
    expect(JSON.stringify(result.setupSnapshot)).not.toContain('Beispiel Betrieb GmbH');
    expect(result.contentFingerprint).toBe(
      buildInvoiceFinalizationContentFingerprint(result.draft, result.setupSnapshot),
    );

    // Derselbe Snapshot muss prepare exakt denselben Fingerprint liefern.
    vi.spyOn(await import('../vorgangService'), 'getVorgangById').mockReturnValue({
      id: VORGANG,
    } as never);
    const prepared = await prepareInvoiceDraftFinalization({
      vorgangId: VORGANG,
      draft: result.draft,
      setup: result.setupSnapshot,
      approvalOptions: {},
      overbillingAcknowledged: false,
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (prepared.ok) {
      expect(prepared.contentFingerprint).toBe(result.contentFingerprint);
      expect(prepared.request.invoice.vorgangTitle).toBe(result.draft.vorgangTitle);
    }

    // Nachträgliche Mutation wirkt weder auf App-State noch auf IndexedDB.
    (result.setupSnapshot as { companyName: string }).companyName = 'Manipuliert';
    (result.draft as { introText?: string }).introText = 'manipuliert';
    expect(appState.snapshot.setup.companyName).toBe('Neue Betrieb GmbH');
    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(record.ok).toBe(true);
    if (record.ok) expect(record.draft.introText).toBe(LONG_TEXT);
  });

  it('N4: Bootstrap-Sync und Persistenz liegen in demselben Queue-Callback', async () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/services/workspace/workspaceCloudBootstrapService.ts'),
      'utf8',
    );

    const start = source.indexOf('runQueuedSyncOperation(');
    expect(start).toBeGreaterThan(-1);
    // Der Callback endet mit seiner schließenden Klammerfolge vor `if (queuedSync)`.
    const end = source.indexOf('if (queuedSync)', start);
    expect(end).toBeGreaterThan(start);
    const callbackBody = source.slice(start, end);

    expect(callbackBody).toContain('coordinator.runSync(buildPersistedStateSnapshot())');
    expect(callbackBody).toContain('applySyncPullCandidateSafely(');
    expect(callbackBody).toContain('syncResult.skipPersist');
    expect(callbackBody).toContain("reason: 'pull'");
    expect(callbackBody).toContain('!applied.persisted');
    expect(callbackBody).toContain("reason: 'persist'");
    // Kein verschachtelter Queue-Lauf innerhalb des Callbacks.
    expect(callbackBody).not.toContain('runSyncFromUi');
    expect(callbackBody).not.toContain('syncCompanyDataAfterSetup');
    expect(callbackBody.split('runQueuedSyncOperation(').length).toBe(2);
  });

  it('L20: kein Fehlerfall erzeugt Kennung, Intent-Schreibvorgang oder Finalisierung', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');
    const resolveIntent = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
    const clearIntent = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');

    await seedActiveDraft();
    setItem.mockClear();
    removeItem.mockClear();

    const cases: (() => void)[] = [
      () => {
        cloudState.rpcError = { message: 'Failed to fetch' };
      },
      () => {
        cloudState.rpcError = null;
        cloudState.rows = [{ kaputt: true }];
      },
      () => {
        cloudState.rows = [];
        cloudState.workspaceId = 'ws-fremd';
      },
      () => {
        cloudState.workspaceId = WORKSPACE;
        cloudState.configured = false;
      },
    ];

    for (const seed of cases) {
      seed();
      const result = await runInvoiceFinalizationPreflight({
        identity: identity(),
        expectedRevision: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result)).not.toContain('clientInvoiceId');
      }
    }

    expect(resolveIntent).not.toHaveBeenCalled();
    expect(clearIntent).not.toHaveBeenCalled();

    // Kein Schreib- oder Löschzugriff auf einen Intent-Schlüssel.
    const intentWrites = setItem.mock.calls.filter(([key]) =>
      String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
    );
    const intentRemovals = removeItem.mock.calls.filter(([key]) =>
      String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
    );
    expect(intentWrites).toEqual([]);
    expect(intentRemovals).toEqual([]);

    // Gelesen werden darf nur der Pull; finalisiert wird nie.
    const rpcNames = new Set(cloudState.rpcCalls.map((call) => call.name));
    expect(rpcNames.has('finalize_workspace_invoice')).toBe(false);
    for (const name of rpcNames) {
      expect(name).toBe('pull_workspace_invoices');
    }
    // Der Entwurf bleibt aktiv und unverändert.
    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('active');
      expect(record.record.revision).toBe(1);
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D1 — aktive Queue-Lease und
 * Recovery-Cloudphase.
 * ========================================================================== */

describe('01P4D1 — aktive Queue-Lease', () => {
  it('Q1: die Lease gilt nur während des Callbacks', async () => {
    let captured: SyncOperationLease | null = null;

    const insideActive = await runQueuedSyncOperation(async (lease) => {
      captured = lease;
      return isActiveSyncOperationLease(lease);
    });

    expect(insideActive).toBe(true);
    expect(captured).not.toBeNull();
    expect(isActiveSyncOperationLease(captured!)).toBe(false);
  });

  it('Q2: eine gefälschte Lease wird typisiert abgelehnt', async () => {
    await seedActiveDraft();
    const forged = {} as unknown as SyncOperationLease;

    for (const call of [
      () => runInvoiceFinalizationPreflightWithinSyncOperation(
        { identity: identity(), expectedRevision: 1 },
        forged,
      ),
      () =>
        runInvoiceFinalizationCloudReconciliationWithinSyncOperation(
          { identity: identity() },
          forged,
        ),
    ]) {
      const result = await call();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unexpected_error');
        expect(result.detail).toBe('inactive_sync_operation_lease');
      }
    }

    expect(cloudState.rpcCalls.length).toBe(0);
    expect(appState.saved.length).toBe(0);
  });

  it('Q3: eine abgelaufene Lease wird typisiert abgelehnt', async () => {
    await seedActiveDraft();
    let expired: SyncOperationLease | null = null;
    await runQueuedSyncOperation(async (lease) => {
      expired = lease;
      return true;
    });

    const result = await runInvoiceFinalizationCloudReconciliationWithinSyncOperation(
      { identity: identity() },
      expired!,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unexpected_error');
      expect(result.detail).toBe('inactive_sync_operation_lease');
    }
    expect(cloudState.rpcCalls.length).toBe(0);
    expect(appState.saved.length).toBe(0);
  });

  it('Q4: die Lease bleibt über awaits hinweg aktiv', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured: SyncOperationLease | null = null;

    const run = runQueuedSyncOperation(async (lease) => {
      captured = lease;
      const before = isActiveSyncOperationLease(lease);
      await gate;
      const after = isActiveSyncOperationLease(lease);
      return { before, after };
    });

    await Promise.resolve();
    release?.();
    const result = await run;
    expect(result).toEqual({ before: true, after: true });
    expect(isActiveSyncOperationLease(captured!)).toBe(false);
  });

  it('Q5: der öffentliche Preflight hält die Queue bis zum vollständigen Ende', async () => {
    await seedActiveDraft();
    cloudState.rows = [];

    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Die zweite IDB-Prüfung nach der Cloud-Persistenz wird angehalten.
    const original = durabilityModule.loadInvoiceDraftRecord;
    let loads = 0;
    vi.spyOn(durabilityModule, 'loadInvoiceDraftRecord').mockImplementation(async (input) => {
      loads += 1;
      if (loads === 2) {
        order.push('preflight:second-load');
        await gate;
      }
      return original(input);
    });

    const preflight = runInvoiceFinalizationPreflight({
      identity: identity(),
      expectedRevision: 1,
    }).then((result) => {
      order.push('preflight:done');
      return result;
    });

    await vi.waitFor(() => expect(order).toContain('preflight:second-load'));
    const follower = runQueuedSyncOperation(async () => {
      order.push('follower:start');
      return 'follower';
    });

    // Solange der Preflight wartet, darf der zweite Lauf nicht beginnen.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).not.toContain('follower:start');

    order.push('gate:released');
    release?.();
    const result = await preflight;
    await follower;

    expect(result.ok, JSON.stringify(result)).toBe(true);
    // Der zweite Lauf startete erst, nachdem die angehaltene zweite
    // IDB-Prüfung freigegeben und der Preflight-Callback beendet war.
    expect(order.indexOf('follower:start')).toBeGreaterThan(order.indexOf('gate:released'));
    expect(order.indexOf('follower:start')).toBeGreaterThan(
      order.indexOf('preflight:second-load'),
    );
  });

  it('Q6: der queuegebundene Preflight läuft ohne zweiten Queue-Lauf', async () => {
    await seedActiveDraft();
    cloudState.rows = [];

    const result = await runQueuedSyncOperation((lease) =>
      runInvoiceFinalizationPreflightWithinSyncOperation(
        { identity: identity(), expectedRevision: 1 },
        lease,
      ),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    expect(result.draft.id).toBe(DRAFT_ID);
    expect(result.setupSnapshot.companyName).toBe('Beispiel Betrieb GmbH');
    expect(result.contentFingerprint).toBe(
      buildInvoiceFinalizationContentFingerprint(result.draft, result.setupSnapshot),
    );
    expect(appState.saved.length).toBe(1);
  });

  it('Q7: die Recovery-Cloudphase akzeptiert einen finalizing-Datensatz', async () => {
    await seedActiveDraft();
    cloudState.rows = [];

    // Einen gültigen finalizing-Datensatz erzeugen.
    vi.spyOn(await import('../vorgangService'), 'getVorgangById').mockReturnValue({
      id: VORGANG,
    } as never);
    const prepared = await prepareInvoiceDraftFinalization({
      vorgangId: VORGANG,
      draft: buildDraft(),
      setup: buildSetup(),
      approvalOptions: {},
      overbillingAcknowledged: false,
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    const begun = await beginInvoiceDraftFinalization({
      identity: identity(),
      expectedRevision: 1,
      clientInvoiceId: prepared.clientInvoiceId,
      contentFingerprint: prepared.contentFingerprint,
      request: prepared.request as never,
      approvalContext: prepared.approvalContext as unknown as Record<string, unknown>,
      now: '2026-08-21T09:30:00.000Z',
    });
    expect(begun.ok, JSON.stringify(begun)).toBe(true);

    const setItem = vi.spyOn(localStorage, 'setItem');
    const removeItem = vi.spyOn(localStorage, 'removeItem');
    const resolveIntent = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
    const clearIntent = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');

    const result = await runQueuedSyncOperation((lease) =>
      runInvoiceFinalizationCloudReconciliationWithinSyncOperation({ identity: identity() }, lease),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.pulledRowCount).toBe(0);
      expect(result.mergedInvoiceCount).toBe(0);
    }

    // since:null und ausschließlich der Pull.
    expect(cloudState.rpcCalls.length).toBe(1);
    expect(cloudState.rpcCalls[0]?.name).toBe('pull_workspace_invoices');
    expect(cloudState.rpcCalls[0]?.args.p_since).toBeNull();
    expect(appState.saved.length).toBe(1);

    // Der finalizing-Datensatz bleibt unverändert.
    const record = await loadInvoiceDraftRecordByLocator({
      sourceScopeKey: SCOPE,
      workspaceId: WORKSPACE,
      vorgangId: VORGANG,
      invoiceType: 'abschlag',
    });
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.record.status).toBe('finalizing');
      expect(record.record.revision).toBe(2);
      expect(record.record.finalization?.clientInvoiceId).toBe(prepared.clientInvoiceId);
    }

    // Keine Kennung, kein Request, keine Intent-Mutation.
    expect(JSON.stringify(result)).not.toContain('clientInvoiceId');
    expect(JSON.stringify(result)).not.toContain('invoicePayload');
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
    expect(cloudState.rpcCalls.every((call) => call.name !== 'finalize_workspace_invoice')).toBe(
      true,
    );
  });

  it('Q8: nach einem Wurf wird die Lease entwertet und die Queue freigegeben', async () => {
    let captured: SyncOperationLease | null = null;

    await expect(
      runQueuedSyncOperation(async (lease) => {
        captured = lease;
        throw new Error('simulierter Fehler');
      }),
    ).rejects.toThrow('simulierter Fehler');

    expect(isActiveSyncOperationLease(captured!)).toBe(false);

    const next = await runQueuedSyncOperation(async (lease) => {
      expect(isActiveSyncOperationLease(lease)).toBe(true);
      expect(lease).not.toBe(captured);
      return 'danach';
    });
    expect(next).toBe('danach');
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B4 — keine Persistenz bei
 * ungültiger Cloud-Zeile.
 * ========================================================================== */

describe('01P4D2B4 — keine Preflight-Persistenz bei ungültiger Zeile', () => {
  it('P6: eine ungültige Payload-Zeile verhindert jede Persistenz', async () => {
    const validRow = buildCloudRow();
    const brokenRow = buildCloudRow({
      id: 'cloud-row-2',
      client_invoice_id: 'inv-cloud-0002',
      payload: {
        ...(buildCloudRow().payload as Record<string, unknown>),
        amount: 'zwölf',
      },
    });

    for (const [label, rows] of [
      ['nur ungültig', [brokenRow]],
      ['gültig und ungültig', [validRow, brokenRow]],
    ] as [string, unknown[]][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      appState.saved = [];
      appState.applied = [];
      cloudState.rpcCalls = [];
      await seedActiveDraft();
      cloudState.rows = rows;

      const setItem = vi.spyOn(localStorage, 'setItem');
      const resolveIntent = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
      const clearIntent = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');

      const result = await runInvoiceFinalizationPreflight({
        identity: identity(),
        expectedRevision: 1,
      });
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe('pull_incomplete');

      expect(appState.saved.length, label).toBe(0);
      expect(appState.applied.length, label).toBe(0);
      expect(
        cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
        label,
      ).toEqual([]);
      expect(resolveIntent, label).not.toHaveBeenCalled();
      expect(clearIntent, label).not.toHaveBeenCalled();
      expect(
        setItem.mock.calls.filter(([key]) =>
          String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
        ),
        label,
      ).toEqual([]);
      setItem.mockRestore();
      resolveIntent.mockRestore();
      clearIntent.mockRestore();
    }
  });

  /*
   * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1C — ein typgültiger, aber
   * in sich widersprüchlicher Datensatz darf ebenso wenig persistiert werden
   * wie ein strukturell kaputter.
   */
  it('01P4E1C S5: eine widersprüchliche Zeile verhindert jede Persistenz', async () => {
    const validRow = buildCloudRow();
    const contradictoryRow = buildCloudRow({
      id: 'cloud-row-s5',
      client_invoice_id: 'inv-cloud-0005',
      payload: {
        ...(buildCloudRow().payload as Record<string, unknown>),
        id: 'inv-cloud-0005',
        number: '2026-9999',
      },
    });

    for (const [label, rows] of [
      ['nur widersprüchlich', [contradictoryRow]],
      ['gültig und widersprüchlich', [validRow, contradictoryRow]],
    ] as [string, unknown[]][]) {
      await resetInvoiceDraftDurabilityDatabaseForTests();
      appState.saved = [];
      appState.applied = [];
      cloudState.rpcCalls = [];
      await seedActiveDraft();
      cloudState.rows = rows;

      const setItem = vi.spyOn(localStorage, 'setItem');
      const resolveIntent = vi.spyOn(intentService, 'resolveInvoiceFinalizeIntent');
      const clearIntent = vi.spyOn(intentService, 'clearInvoiceFinalizeIntent');

      const result = await runInvoiceFinalizationPreflight({
        identity: identity(),
        expectedRevision: 1,
      });
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.reason, label).toBe('pull_incomplete');

      expect(appState.saved.length, label).toBe(0);
      expect(appState.applied.length, label).toBe(0);
      expect(
        cloudState.rpcCalls.filter((call) => call.name === 'finalize_workspace_invoice'),
        label,
      ).toEqual([]);
      expect(resolveIntent, label).not.toHaveBeenCalled();
      expect(clearIntent, label).not.toHaveBeenCalled();
      expect(
        setItem.mock.calls.filter(([key]) =>
          String(key).endsWith(INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX),
        ),
        label,
      ).toEqual([]);
      setItem.mockRestore();
      resolveIntent.mockRestore();
      clearIntent.mockRestore();
    }
  });
});
