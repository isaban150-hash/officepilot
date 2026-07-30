/**
 * CRITICAL-WRITE-PERSIST-CHECK-01 — persist result on invoice finalize, contract confirm, filing/inbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrderPosition, createTestVorgang, testSetup } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { createAuftragInboxItem } from '../test/fixtures';
import {
  confirmFilingDecisionForTests,
  importInboxDocumentForTests,
} from '../test/confirmFilingDecisionForTests';
import * as supabaseLib from '../lib/supabase';
import * as persistenceService from './persistenceService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  persistAll,
} from './persistenceService';
import {
  confirmContractOrder,
} from './contractConfirmationService';
import {
  addNegotiationPriceProposal,
  prepareNegotiationDraft,
  startContractNegotiation,
} from './contractNegotiationService';
import {
  buildDocumentFilingDecisionDraft,
  confirmDocumentFilingDecision,
  isDocumentFilingDecisionConfirmed,
  resolveConfirmedFilingDecisionForInboxArchive,
} from './documentFilingDecisionService';
import {
  getAllDocuments,
  hydrateDocumentStore,
  importInboxDocument,
} from './documentService';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
  patchInboxItem,
} from './inboxService';
import {
  buildInvoiceFinalizationContentFingerprint,
  buildSchlussrechnungDraft,
} from './invoiceService';
import { finalizeInvoiceDraftWithCloud } from './invoice/invoiceCloudFinalizeOrchestrator';
import {
  getInvoiceFinalizeIntent,
  resetInvoiceFinalizeIntentsForTests,
  resolveInvoiceFinalizeIntent,
} from './invoice/invoiceFinalizeIntentService';
import * as workspaceInvoiceCloud from './invoice/workspaceInvoiceCloudService';
import {
  getVorgangById,
  hydrateVorgangStore,
  upsertFinalizedInvoiceOnVorgang,
} from './vorgangService';
import { setWorkspace } from './workspace/workspaceStore';

function mockCloudReady() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }),
    },
  } as never);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue({
    syncClient: { serverWorkspaceId: 'ws-1', workspaceId: 'ws-1', deviceId: 'd1' },
    workspace: { id: 'ws-1' },
  } as never);
}

function mockRpcSuccess(number = '2026-0100', sequence = 100) {
  return vi.spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice').mockImplementation(
    async (input) => ({
      invoice: {
        ...input.invoice,
        number,
        invoiceSequenceNumber: sequence,
        status: 'vorbereitet' as const,
      },
      idempotentReplay: false,
      rowVersion: 1,
      cloudInvoiceId: `cloud-${sequence}`,
    }),
  );
}

function seedNegotiatingVorgang(id: string) {
  hydrateVorgangStore([
    createTestVorgang({
      id,
      status: 'in_pruefung',
      customer: 'Müller Bau',
      baustelle: 'Hauptstr. 1',
      title: 'Werkvertrag Sanierung',
      orderPositions: [
        createOrderPosition({
          id: 'op-persist-1',
          description: 'Position 1',
          unitPrice: 22,
          unit: 'm²',
          plannedQuantity: 10,
        }),
      ],
    }),
  ]);
  startContractNegotiation(id);
  addNegotiationPriceProposal(id, {
    orderPositionId: 'op-persist-1',
    proposedUnitPrice: 25,
  });
  prepareNegotiationDraft(id, 'price_change');
}

describe('CRITICAL-WRITE-PERSIST-CHECK-01 — Invoice', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceFinalizeIntentsForTests();
    vi.restoreAllMocks();
    hydrateVorgangStore([createTestVorgang()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1 — RPC + lokale Persistenz ok: Intent gelöscht, Invoice nach Reload', async () => {
    mockCloudReady();
    mockRpcSuccess('2026-0101', 101);
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;

    const result = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getInvoiceFinalizeIntent('v-test-1')).toBeNull();

    vi.mocked(persistenceService.buildPersistedStateSnapshot).mockRestore();
    const snapshot = buildPersistedStateSnapshot();
    hydrateVorgangStore([]);
    applyStateToStores(snapshot);
    expect(getVorgangById('v-test-1')?.invoices.some((i) => i.id === result.invoice.id)).toBe(
      true,
    );
  });

  it('2 — RPC ok, lokale Persistenz fail: kein ok:true, Intent bleibt, stabile ID', async () => {
    mockCloudReady();
    mockRpcSuccess('2026-0102', 102);
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const fingerprint = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const intentBefore = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fingerprint,
    });

    const realPersist = persistAll;
    vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => ({
      success: false,
      failure: { reason: 'quota_exceeded' },
    }));

    const result = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('local_persist_failed');

    const intent = getInvoiceFinalizeIntent('v-test-1');
    expect(intent).not.toBeNull();
    expect(intent!.clientInvoiceId).toBe(intentBefore.clientInvoiceId);
    expect(getVorgangById('v-test-1')!.invoices).toHaveLength(0);

    // Restore persist for cleanup assertions
    vi.mocked(persistenceService.persistAll).mockImplementation(realPersist);
  });

  it('3 — Retry nach lokalem Persist-Fail: gleiche Client-ID, keine zweite Rechnung', async () => {
    mockCloudReady();
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const fingerprint = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const intent = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fingerprint,
    });

    let rpcCalls = 0;
    vi.spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice').mockImplementation(
      async (input) => {
        rpcCalls += 1;
        expect(input.invoice.id).toBe(intent.clientInvoiceId);
        return {
          invoice: {
            ...input.invoice,
            number: '2026-0103',
            invoiceSequenceNumber: 103,
            status: 'vorbereitet' as const,
          },
          idempotentReplay: rpcCalls > 1,
          rowVersion: rpcCalls,
          cloudInvoiceId: 'cloud-103',
        };
      },
    );

    vi.spyOn(persistenceService, 'persistAll').mockReturnValueOnce({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const first = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.reason).toBe('local_persist_failed');
    expect(getInvoiceFinalizeIntent('v-test-1')?.clientInvoiceId).toBe(intent.clientInvoiceId);

    const second = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.invoice.id).toBe(intent.clientInvoiceId);
    expect(getInvoiceFinalizeIntent('v-test-1')).toBeNull();
    expect(getVorgangById('v-test-1')!.invoices.filter((i) => i.id === intent.clientInvoiceId)).toHaveLength(
      1,
    );
    expect(rpcCalls).toBe(2);
  });

  it('4 — lokales Upsert mehrfach: keine doppelte Vorgang-Invoice', async () => {
    mockCloudReady();
    mockRpcSuccess('2026-0104', 104);
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const first = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = upsertFinalizedInvoiceOnVorgang('v-test-1', first.invoice);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.action).toBe('noop');
    expect(getVorgangById('v-test-1')!.invoices.filter((i) => i.id === first.invoice.id)).toHaveLength(
      1,
    );
  });

  it('5 — Reload nach Remote-ok / lokalem Persist-Fail: Intent bleibt, Wiederaufnahme', async () => {
    mockCloudReady();
    mockRpcSuccess('2026-0105', 105);
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const fingerprint = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const intent = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fingerprint,
    });

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    const failed = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(failed.ok).toBe(false);

    // Simulate app reload: intents are in separate localStorage key; vorgang store reset.
    vi.restoreAllMocks();
    mockCloudReady();
    hydrateVorgangStore([createTestVorgang()]);
    const reloadedIntent = getInvoiceFinalizeIntent('v-test-1');
    expect(reloadedIntent?.clientInvoiceId).toBe(intent.clientInvoiceId);

    vi.spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice').mockImplementation(
      async (input) => ({
        invoice: {
          ...input.invoice,
          number: '2026-0105',
          invoiceSequenceNumber: 105,
          status: 'vorbereitet' as const,
        },
        idempotentReplay: true,
        rowVersion: 2,
        cloudInvoiceId: 'cloud-105',
      }),
    );
    const resumed = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.invoice.id).toBe(intent.clientInvoiceId);
    expect(getInvoiceFinalizeIntent('v-test-1')).toBeNull();
  });
});

describe('CRITICAL-WRITE-PERSIST-CHECK-01 — Contract Confirmation', () => {
  beforeEach(() => {
    resetTestStores();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('6 — Confirmation mit Persistenz: Snapshot nach Reload', () => {
    seedNegotiatingVorgang('v-confirm-persist-ok');
    const result = confirmContractOrder('v-confirm-persist-ok');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const snapshot = buildPersistedStateSnapshot();
    hydrateVorgangStore([]);
    applyStateToStores(snapshot);
    const reloaded = getVorgangById('v-confirm-persist-ok');
    expect(reloaded?.status).toBe('beauftragt');
    expect(reloaded?.contractConfirmation?.id).toBe(result.snapshot.id);
  });

  it('7 — Persistenzfehler: success false, Memory zurückgerollt', () => {
    seedNegotiatingVorgang('v-confirm-persist-fail');
    const before = getVorgangById('v-confirm-persist-fail')!;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    const result = confirmContractOrder('v-confirm-persist-fail');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('confirmation.persistFailed');

    const after = getVorgangById('v-confirm-persist-fail')!;
    expect(after.contractConfirmation).toBeUndefined();
    expect(after.status).toBe(before.status);
    expect(after.negotiation?.closed).not.toBe(true);
  });

  it('8 — Retry nach Persistenzfehler: genau eine Bestätigung', () => {
    seedNegotiatingVorgang('v-confirm-persist-retry');
    vi.spyOn(persistenceService, 'persistAll').mockReturnValueOnce({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    expect(confirmContractOrder('v-confirm-persist-retry').success).toBe(false);

    const ok = confirmContractOrder('v-confirm-persist-retry');
    expect(ok.success).toBe(true);
    expect(confirmContractOrder('v-confirm-persist-retry').success).toBe(false);
    expect(getVorgangById('v-confirm-persist-retry')?.contractConfirmation).toBeTruthy();
  });
});

describe('CRITICAL-WRITE-PERSIST-CHECK-01 — Filing & Inbox', () => {
  beforeEach(() => {
    resetTestStores();
    localStorage.clear();
    vi.restoreAllMocks();
    hydrateDocumentStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('10 — Filing Decision persistiert: K1 erlaubt Archiv, Reload behält Confirm', () => {
    const item = createAuftragInboxItem({ id: 'inbox-cw-filing-ok' });
    hydrateInboxStore([item]);
    const draft = buildDocumentFilingDecisionDraft(item);
    const confirmed = confirmDocumentFilingDecision(item.id, draft);
    expect(confirmed).not.toBeNull();
    expect(isDocumentFilingDecisionConfirmed(confirmed!)).toBe(true);
    expect(resolveConfirmedFilingDecisionForInboxArchive(item.id).ok).toBe(true);

    const snapshot = buildPersistedStateSnapshot();
    hydrateInboxStore([]);
    applyStateToStores(snapshot);
    expect(isDocumentFilingDecisionConfirmed(getInboxItemById(item.id)!)).toBe(true);

    const imported = importInboxDocument(getInboxItemById(item.id)!, 'Mustermann Sanitär GmbH');
    expect(imported.success).toBe(true);
  });

  it('11 — Filing Persistenzfehler: Confirm zurückgerollt, K1 blockiert', () => {
    const item = createAuftragInboxItem({ id: 'inbox-cw-filing-fail' });
    hydrateInboxStore([item]);
    const draft = buildDocumentFilingDecisionDraft(item);

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    const confirmed = confirmDocumentFilingDecision(item.id, draft);
    expect(confirmed).toBeNull();
    expect(isDocumentFilingDecisionConfirmed(getInboxItemById(item.id)!)).toBe(false);
    expect(resolveConfirmedFilingDecisionForInboxArchive(item.id).ok).toBe(false);

    const archived = importInboxDocument(getInboxItemById(item.id)!, 'Mustermann Sanitär GmbH');
    expect(archived.success).toBe(false);
    if (!archived.success) {
      expect(archived.errorKey).toBe('document.filingDecisionRequired');
    }
  });

  it('12 — Inbox Importstatus persistiert: Archive-ID nach Reload', () => {
    const item = createAuftragInboxItem({ id: 'inbox-cw-import-ok' });
    hydrateInboxStore([item]);
    const imported = importInboxDocumentForTests(item, 'Mustermann Sanitär GmbH');
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    const marked = markInboxImportedToArchive(item.id, imported.document.id);
    expect(marked?.success).toBe(true);
    expect(marked?.item.archiveDocumentId).toBe(imported.document.id);

    const snapshot = buildPersistedStateSnapshot();
    hydrateInboxStore([]);
    applyStateToStores(snapshot);
    const reloaded = getInboxItemById(item.id)!;
    expect(reloaded.importedToArchive).toBe(true);
    expect(reloaded.archiveDocumentId).toBe(imported.document.id);
  });

  it('13 — Inbox Importstatus Persistenzfehler: kein scheinbarer Import', () => {
    const item = createAuftragInboxItem({ id: 'inbox-cw-import-fail' });
    hydrateInboxStore([item]);
    const imported = importInboxDocumentForTests(item, 'Mustermann Sanitär GmbH');
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    const marked = markInboxImportedToArchive(item.id, imported.document.id);
    expect(marked).toBeNull();
    const current = getInboxItemById(item.id)!;
    expect(current.importedToArchive).not.toBe(true);
    expect(current.archiveDocumentId).toBeUndefined();
  });

  it('14 — Retry nach Importstatus-Fail: kein doppeltes Archivdokument', () => {
    const item = createAuftragInboxItem({ id: 'inbox-cw-import-retry' });
    hydrateInboxStore([item]);
    const imported = importInboxDocumentForTests(item, 'Mustermann Sanitär GmbH');
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const docCountAfterImport = getAllDocuments().length;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValueOnce({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    expect(markInboxImportedToArchive(item.id, imported.document.id)).toBeNull();

    const marked = markInboxImportedToArchive(item.id, imported.document.id);
    expect(marked?.success).toBe(true);
    expect(getAllDocuments().length).toBe(docCountAfterImport);
  });

  it('15 — Duplikatpfad / patch Rollback: Dirty Memory vermieden', () => {
    const item = createAuftragInboxItem({ id: 'inbox-cw-patch-dirty' });
    hydrateInboxStore([item]);
    const before = getInboxItemById(item.id)!;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    expect(patchInboxItem(item.id, { priority: 'kritisch' })).toBeNull();
    expect(getInboxItemById(item.id)?.priority).toBe(before.priority);
  });

  it('16 — Workspace-Context: Filing Confirm im aktiven Workspace', () => {
    setWorkspace({
      id: 'ws-cw-local',
      name: 'Local',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    const item = createAuftragInboxItem({ id: 'inbox-cw-ws' });
    hydrateInboxStore([item]);
    const confirmed = confirmDocumentFilingDecision(
      item.id,
      buildDocumentFilingDecisionDraft(item),
    );
    expect(confirmed).not.toBeNull();
    expect(resolveConfirmedFilingDecisionForInboxArchive(item.id).ok).toBe(true);
  });
});
