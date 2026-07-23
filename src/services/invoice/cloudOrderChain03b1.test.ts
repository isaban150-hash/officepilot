import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAbschlagInvoice, createTestVorgang, testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import {
  buildInvoiceFinalizationCandidate,
  buildInvoiceFinalizationContentFingerprint,
  buildSchlussrechnungDraft,
  finalizeInvoiceDraft,
} from '../invoiceService';
import { getBilledQuantity, getOpenQuantity } from '../orderBillingRules';
import {
  getInvoiceNumberSequenceSnapshot,
  reserveNextInvoiceNumber,
} from '../invoiceNumberService';
import {
  getVorgangById,
  hydrateVorgangStore,
  upsertFinalizedInvoiceOnVorgang,
} from '../vorgangService';
import {
  getInvoiceFinalizeIntent,
  resetInvoiceFinalizeIntentsForTests,
  resolveInvoiceFinalizeIntent,
} from './invoiceFinalizeIntentService';
import { finalizeInvoiceDraftWithCloud } from './invoiceCloudFinalizeOrchestrator';
import * as workspaceInvoiceCloud from './workspaceInvoiceCloudService';

const migration03a = resolve(
  process.cwd(),
  'supabase/migrations/20250723120000_workspace_invoice_cloud_foundation.sql',
);
const migration03b1 = resolve(
  process.cwd(),
  'supabase/migrations/20250723130000_workspace_invoice_finalize_vorgang_guard.sql',
);

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

describe('CLOUD-ORDER-CHAIN-03B1 migration hardening', () => {
  const sql03a = readFileSync(migration03a, 'utf8');
  const sql03b1 = readFileSync(migration03b1, 'utf8');

  it('03A-Migration bleibt unverändert und enthält Foundation', () => {
    expect(sql03a).toContain('workspace_invoice_sequences');
    expect(sql03a).toContain('workspace_invoices');
    expect(sql03a).toContain('finalize_workspace_invoice');
    expect(sql03a).not.toContain('Vorgang gehört nicht zum Workspace');
  });

  it('03B1 härtet RPC mit Vorgang-Workspace-Prüfung', () => {
    expect(sql03b1).toContain('create or replace function public.finalize_workspace_invoice');
    expect(sql03b1).toContain('workspace_vorgaenge');
    expect(sql03b1).toContain('Vorgang gehört nicht zum Workspace oder existiert nicht');
    expect(sql03b1).toContain('is_active_workspace_member');
    expect(sql03b1).toContain('deleted = false');
    expect(sql03b1).toContain('idempotent_replay');
    expect(sql03b1).toContain('for update');
    expect(sql03b1).not.toContain('create table');
  });
});

describe('CLOUD-ORDER-CHAIN-03B1 finalize cutover', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceFinalizeIntentsForTests();
    vi.restoreAllMocks();
    hydrateVorgangStore([createTestVorgang()]);
  });

  it('Candidate baut ohne lokale Nummernreserve', () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const before = getInvoiceNumberSequenceSnapshot().lastIssuedNumber;
    const result = buildInvoiceFinalizationCandidate(
      'v-test-1',
      draft,
      testSetup,
      'inv-stable-1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.id).toBe('inv-stable-1');
    expect(result.invoice.number).toBe('ENTWURF');
    expect(result.invoice.invoiceSequenceNumber).toBeUndefined();
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(before);
  });

  it('Intent bleibt über Reload und gleichen Fingerprint stabil', () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const fp = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const first = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fp,
    });
    const second = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fp,
    });
    expect(second.clientInvoiceId).toBe(first.clientInvoiceId);
    expect(getInvoiceFinalizeIntent('v-test-1')?.clientInvoiceId).toBe(first.clientInvoiceId);
  });

  it('Inhaltsänderung erzeugt neue client_invoice_id', () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const fp1 = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const first = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fp1,
    });
    draft.positions[0]!.quantity = 2;
    const fp2 = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const second = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: fp2,
    });
    expect(second.clientInvoiceId).not.toBe(first.clientInvoiceId);
  });

  it('gleicher Workspace + gleicher Fingerprint + unterschiedliche Vorgang-ID → unterschiedliche client_invoice_id', () => {
    const fingerprint = JSON.stringify({ type: 'schluss', amount: 100, positions: [] });
    const forVorgangA = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-a',
      contentFingerprint: fingerprint,
    });
    const forVorgangB = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-b',
      contentFingerprint: fingerprint,
    });
    expect(forVorgangA.vorgangId).toBe('v-a');
    expect(forVorgangB.vorgangId).toBe('v-b');
    expect(forVorgangA.contentFingerprint).toBe(forVorgangB.contentFingerprint);
    expect(forVorgangA.workspaceId).toBe(forVorgangB.workspaceId);
    expect(forVorgangA.clientInvoiceId).not.toBe(forVorgangB.clientInvoiceId);
  });

  it('upsertFinalizedInvoiceOnVorgang ist idempotent und erkennt Konflikte', () => {
    const invoice = {
      ...createAbschlagInvoice('op-test-1', 4, { id: 'inv-up-1', number: '2026-0099' }),
      invoiceSequenceNumber: 99,
    };
    const first = upsertFinalizedInvoiceOnVorgang('v-test-1', invoice);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.action).toBe('inserted');

    const noop = upsertFinalizedInvoiceOnVorgang('v-test-1', invoice);
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.action).toBe('noop');
    expect(getVorgangById('v-test-1')!.invoices.filter((i) => i.id === 'inv-up-1')).toHaveLength(1);

    const conflict = upsertFinalizedInvoiceOnVorgang('v-test-1', {
      ...invoice,
      amount: 999,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.reason).toBe('id_content_conflict');

    const numberConflict = upsertFinalizedInvoiceOnVorgang('v-test-1', {
      ...invoice,
      id: 'inv-other',
      number: '2026-0099',
    });
    expect(numberConflict.ok).toBe(false);
    if (numberConflict.ok) return;
    expect(numberConflict.reason).toBe('number_id_conflict');
  });

  it('Cloud-Finalize übernimmt Servernummer und zählt Billing einmal', async () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const beforeSeq = getInvoiceNumberSequenceSnapshot().lastIssuedNumber;
    mockCloudReady();

    vi.spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice').mockImplementation(
      async (input) => ({
        invoice: {
          ...input.invoice,
          number: '2026-0042',
          invoiceSequenceNumber: 42,
          status: 'vorbereitet',
        },
        idempotentReplay: false,
        rowVersion: 1,
        cloudInvoiceId: 'cloud-row-42',
      }),
    );

    const result = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.number).toBe('2026-0042');
    expect(result.invoice.invoiceSequenceNumber).toBe(42);
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBe(beforeSeq);
    expect(getInvoiceFinalizeIntent('v-test-1')).toBeNull();

    const vorgang = getVorgangById('v-test-1')!;
    expect(vorgang.invoices.filter((i) => i.id === result.invoice.id)).toHaveLength(1);
    expect(getBilledQuantity(vorgang, 'op-test-1')).toBe(result.invoice.positions[0]!.quantity);
    expect(getOpenQuantity(vorgang, 'op-test-1')).toBe(
      Math.max(0, 10 - result.invoice.positions[0]!.quantity),
    );
  });

  it('Offline-Gate erzeugt keinen lokalen Finalbeleg', async () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const beforeInvoices = getVorgangById('v-test-1')!.invoices.length;

    const result = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('offline_or_unconfigured');
    expect(getVorgangById('v-test-1')!.invoices).toHaveLength(beforeInvoices);
    expect(getInvoiceFinalizeIntent('v-test-1')).toBeNull();
  });

  it('RPC-Fehler behält Intent und erzeugt keine lokale Rechnung', async () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    mockCloudReady();

    vi.spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice').mockRejectedValue(
      new workspaceInvoiceCloud.WorkspaceInvoiceCloudError('Netzwerk weg', 'network', true),
    );

    const result = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(result.ok).toBe(false);
    const intent = getInvoiceFinalizeIntent('v-test-1');
    expect(intent).not.toBeNull();
    expect(getVorgangById('v-test-1')!.invoices).toHaveLength(0);

    const again = resolveInvoiceFinalizeIntent({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      contentFingerprint: buildInvoiceFinalizationContentFingerprint(draft, testSetup),
    });
    expect(again.clientInvoiceId).toBe(intent!.clientInvoiceId);
  });

  it('lokales Upsert nach Erfolg ist noop (keine zweite Rechnung)', async () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    mockCloudReady();

    vi.spyOn(workspaceInvoiceCloud, 'rpcFinalizeWorkspaceInvoice').mockImplementation(
      async (input) => ({
        invoice: {
          ...input.invoice,
          number: '2026-0007',
          invoiceSequenceNumber: 7,
          status: 'vorbereitet' as const,
        },
        idempotentReplay: false,
        rowVersion: 1,
        cloudInvoiceId: 'cloud-7',
      }),
    );

    const first = await finalizeInvoiceDraftWithCloud('v-test-1', draft, testSetup);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = upsertFinalizedInvoiceOnVorgang('v-test-1', first.invoice);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.action).toBe('noop');
    expect(getVorgangById('v-test-1')!.invoices.filter((i) => i.number === '2026-0007')).toHaveLength(
      1,
    );
  });

  it('Payments werden im Cloud-Payload nicht übertragen', () => {
    const payload = workspaceInvoiceCloud.buildWorkspaceInvoiceFinalizePayload({
      ...createAbschlagInvoice('op-test-1', 1, { id: 'inv-pay' }),
      payments: [
        {
          id: 'p1',
          date: '2026-07-01',
          amount: 10,
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      paymentStatus: 'teilbezahlt',
      archiveDocumentId: 'arch-1',
    });
    expect(payload.payments).toBeUndefined();
    expect(payload.paymentStatus).toBeUndefined();
    expect(payload.archiveDocumentId).toBeUndefined();
  });

  it('Legacy lokale finalizeInvoiceDraft bleibt für Tests nutzbar', () => {
    const draft = buildSchlussrechnungDraft('v-test-1', testSetup)!;
    const before = getInvoiceNumberSequenceSnapshot().lastIssuedNumber;
    const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    expect(getInvoiceNumberSequenceSnapshot().lastIssuedNumber).toBeGreaterThan(before);
    const reserved = reserveNextInvoiceNumber();
    expect(reserved.formatted).toMatch(/^\d{4}-\d{4}$/);
  });
});
