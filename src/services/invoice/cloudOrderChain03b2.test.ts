import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { VorgangInvoice } from '../../types/models';
import {
  getBilledQuantity,
  getBillableOpenQuantity,
  hasSchlussrechnung,
} from '../orderBillingRules';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import * as persistenceService from '../persistenceService';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import {
  applyFinalizedInvoiceToVorgang,
  hydrateVorgangStore,
  immutableInvoiceFingerprint,
  resolveMonotonicInvoiceStatus,
  upsertFinalizedInvoiceOnVorgang,
} from '../vorgangService';
import { applyInvoicePullAfterVorgangMerge } from './invoiceCloudPullOrchestrator';
import {
  mapPullRowsIsolated,
  mergeCloudInvoicesIntoVorgaenge,
  reconcileInvoiceFinalizeIntentAfterMerge,
} from './invoiceCloudPullMergeService';
import {
  getInvoiceFinalizeIntent,
  resetInvoiceFinalizeIntentsForTests,
  seedInvoiceFinalizeIntentForTests,
} from './invoiceFinalizeIntentService';
import * as workspaceInvoiceCloud from './workspaceInvoiceCloudService';
import {
  mapWorkspaceInvoicePullRowToVorgangInvoice,
  parseWorkspaceInvoicePullRow,
  rpcPullWorkspaceInvoiceRows,
  WorkspaceInvoiceCloudError,
} from './workspaceInvoiceCloudService';
import type { MappedWorkspaceInvoicePull } from './workspaceInvoiceCloudService';

const migration03a = resolve(
  process.cwd(),
  'supabase/migrations/20250723120000_workspace_invoice_cloud_foundation.sql',
);
const migration03b1 = resolve(
  process.cwd(),
  'supabase/migrations/20250723130000_workspace_invoice_finalize_vorgang_guard.sql',
);
const migration03b2 = resolve(
  process.cwd(),
  'supabase/migrations/20250723140000_workspace_invoice_pull.sql',
);

function cloudRow(overrides: Record<string, unknown> = {}) {
  const invoice = createAbschlagInvoice('op-test-1', 3, {
    id: 'inv-cloud-1',
    number: '2026-0001',
    invoiceSequenceNumber: 1,
    status: 'vorbereitet',
    payments: [
      { id: 'pay-x', date: '2026-07-01', amount: 5, createdAt: '2026-07-01T00:00:00.000Z' },
    ],
    paymentStatus: 'teilbezahlt',
    archiveDocumentId: 'should-not-map',
  });
  return {
    id: 'cloud-row-1',
    workspace_id: 'ws-1',
    vorgang_id: 'v-test-1',
    client_invoice_id: 'inv-cloud-1',
    invoice_number: '2026-0001',
    invoice_year: 2026,
    invoice_sequence_number: 1,
    invoice_type: 'abschlag',
    invoice_status: 'vorbereitet',
    payload: { ...invoice, payments: invoice.payments, archiveDocumentId: 'doc-x' },
    row_version: 1,
    created_at: '2026-07-23T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
    ...overrides,
  };
}

function toMapped(row = cloudRow()): MappedWorkspaceInvoicePull {
  const parsed = parseWorkspaceInvoicePullRow(row)!;
  return mapWorkspaceInvoicePullRowToVorgangInvoice(parsed);
}

describe('CLOUD-ORDER-CHAIN-03B2 migration / RPC', () => {
  const sql03a = readFileSync(migration03a, 'utf8');
  const sql03b1 = readFileSync(migration03b1, 'utf8');
  const sql03b2 = readFileSync(migration03b2, 'utf8');

  it('03A-/03B1-Migrationen bleiben unverändert und 03B2 ergänzt nur Pull-RPC', () => {
    expect(sql03a).toContain('finalize_workspace_invoice');
    expect(sql03a).not.toContain('pull_workspace_invoices');
    expect(sql03b1).toContain('Vorgang gehört nicht zum Workspace');
    expect(sql03b1).not.toContain('pull_workspace_invoices');
    expect(sql03b2).toContain('create or replace function public.pull_workspace_invoices');
    expect(sql03b2).not.toContain('create table');
  });

  it('Pull-RPC prüft Auth, Membership und liefert typisierte Felder', () => {
    expect(sql03b2).toContain('security definer');
    expect(sql03b2).toContain('set search_path = public');
    expect(sql03b2).toContain('Nicht angemeldet');
    expect(sql03b2).toContain('is_active_workspace_member');
    expect(sql03b2).toContain('Kein Zugriff auf Workspace');
    expect(sql03b2).toContain('wi.workspace_id = p_workspace_id');
    expect(sql03b2).toContain('client_invoice_id');
    expect(sql03b2).toContain('invoice_number');
    expect(sql03b2).toContain('invoice_sequence_number');
    expect(sql03b2).toContain('payload');
    expect(sql03b2).toContain('row_version');
    expect(sql03b2).toContain('p_since');
    expect(sql03b2).toContain('grant execute on function public.pull_workspace_invoices');
    expect(sql03b2).not.toMatch(/grant\s+insert/i);
    expect(sql03b2).not.toMatch(/grant\s+update/i);
  });
});

describe('CLOUD-ORDER-CHAIN-03B2 pull mapping', () => {
  it('mappt Cloud-Zeile auf VorgangInvoice mit client_invoice_id als ID', () => {
    const mapped = toMapped();
    expect(mapped.invoice.id).toBe('inv-cloud-1');
    expect(mapped.invoice.number).toBe('2026-0001');
    expect(mapped.invoice.invoiceSequenceNumber).toBe(1);
    expect(mapped.invoice.type).toBe('abschlag');
    expect(mapped.invoice.status).toBe('vorbereitet');
    expect(mapped.vorgangId).toBe('v-test-1');
    expect(mapped.cloudInvoiceId).toBe('cloud-row-1');
    expect(mapped.invoice.positions).toHaveLength(1);
    expect(mapped.invoice.positions[0]?.lineTotal).toBe(195);
  });

  it('übernimmt keine Payments und keine PDF-/Archivdaten aus Cloud', () => {
    const mapped = toMapped();
    expect(mapped.invoice.payments).toBeUndefined();
    expect(mapped.invoice.paymentStatus).toBeUndefined();
    expect(mapped.invoice.archiveDocumentId).toBeUndefined();
  });

  it('lehnt unvollständige Zeilen ab', () => {
    expect(parseWorkspaceInvoicePullRow({ ...cloudRow(), client_invoice_id: '' })).toBeNull();
    expect(parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_status: 'bezahlt' })).toBeNull();
  });
});

describe('CLOUD-ORDER-CHAIN-03B2 merge', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceFinalizeIntentsForTests();
  });

  it('ergänzt neue Cloud-Rechnung einmal und hält Legacy lokal', () => {
    const legacy = createAbschlagInvoice('op-test-1', 1, {
      id: 'inv-legacy',
      number: 'LEGACY-1',
    });
    const vorgang = createTestVorgang({ invoices: [legacy] });
    const merged = mergeCloudInvoicesIntoVorgaenge([vorgang], [toMapped()], {
      workspaceId: 'ws-1',
    });
    expect(merged.insertedCount).toBe(1);
    expect(merged.vorgaenge[0]!.invoices).toHaveLength(2);
    expect(merged.vorgaenge[0]!.invoices.some((i) => i.id === 'inv-legacy')).toBe(true);
    expect(merged.vorgaenge[0]!.invoices.some((i) => i.id === 'inv-cloud-1')).toBe(true);
  });

  it('gleiche ID + gleicher Inhalt = noop ohne Doppelung', () => {
    const invoice = toMapped().invoice;
    const vorgang = createTestVorgang({ invoices: [invoice] });
    const merged = mergeCloudInvoicesIntoVorgaenge([vorgang], [toMapped()], {
      workspaceId: 'ws-1',
    });
    expect(merged.noopCount).toBe(1);
    expect(merged.insertedCount).toBe(0);
    expect(merged.vorgaenge[0]!.invoices).toHaveLength(1);
  });

  it('gleiche ID + anderer Inhalt = Konflikt', () => {
    const local = toMapped().invoice;
    const vorgang = createTestVorgang({
      invoices: [{ ...local, amount: 999 }],
    });
    const merged = mergeCloudInvoicesIntoVorgaenge([vorgang], [toMapped()], {
      workspaceId: 'ws-1',
    });
    expect(merged.conflicts.some((c) => c.reason === 'id_content_conflict')).toBe(true);
    expect(merged.vorgaenge[0]!.invoices[0]!.amount).toBe(999);
  });

  it('gleiche Nummer + andere ID = Konflikt; gleiche ID + andere Nummer = Konflikt', () => {
    const local = createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-other',
      number: '2026-0001',
    });
    const numberConflict = mergeCloudInvoicesIntoVorgaenge(
      [createTestVorgang({ invoices: [local] })],
      [toMapped()],
      { workspaceId: 'ws-1' },
    );
    expect(numberConflict.conflicts.some((c) => c.reason === 'number_id_conflict')).toBe(true);

    const sameIdOtherNumber = mergeCloudInvoicesIntoVorgaenge(
      [
        createTestVorgang({
          invoices: [{ ...toMapped().invoice, number: '2026-9999' }],
        }),
      ],
      [toMapped()],
      { workspaceId: 'ws-1' },
    );
    expect(sameIdOtherNumber.conflicts.some((c) => c.reason === 'id_content_conflict')).toBe(
      true,
    );
  });

  it('Orphan-Invoice wird nicht falsch zugeordnet', () => {
    const merged = mergeCloudInvoicesIntoVorgaenge(
      [createTestVorgang({ id: 'v-other' })],
      [toMapped()],
      { workspaceId: 'ws-1' },
    );
    expect(merged.conflicts.some((c) => c.reason === 'orphan')).toBe(true);
    expect(merged.vorgaenge[0]!.invoices).toHaveLength(0);
  });

  it('ungültige Cloud-Zeile blockiert andere Rechnungen nicht', () => {
    const report = createEmptySyncSimulationReport(new Date().toISOString());
    const { mapped, invalidCount } = mapPullRowsIsolated(
      [cloudRow({ client_invoice_id: '' }), cloudRow()],
      'ws-1',
      report,
    );
    expect(invalidCount).toBe(1);
    expect(mapped).toHaveLength(1);
    const merged = mergeCloudInvoicesIntoVorgaenge([createTestVorgang()], mapped, {
      workspaceId: 'ws-1',
      report,
    });
    expect(merged.insertedCount).toBe(1);
  });

  it('bewahrt lokale PDF-/Archivdaten bei noop', () => {
    const cloud = toMapped().invoice;
    const local: VorgangInvoice = {
      ...cloud,
      archiveDocumentId: 'local-archive',
      payments: [
        { id: 'pay-1', date: '2026-07-01', amount: 10, createdAt: '2026-07-01T00:00:00.000Z' },
      ],
    };
    const applied = applyFinalizedInvoiceToVorgang(createTestVorgang({ invoices: [local] }), cloud);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.action).toBe('noop');
    expect(applied.invoice.archiveDocumentId).toBe('local-archive');
    expect(applied.invoice.payments).toHaveLength(1);
  });
});

describe('CLOUD-ORDER-CHAIN-03B2 Mehrgerät / Billing', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('Gerät B pullt finalisierte Rechnung einmal; Billing zählt einmal', () => {
    const cloud = toMapped();
    const empty = createTestVorgang({
      orderPositions: [
        {
          id: 'op-test-1',
          description: 'Testleistung',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
          category: 'arbeit',
          executedQuantity: 10,
        },
      ],
      invoices: [],
    });
    const first = mergeCloudInvoicesIntoVorgaenge([empty], [cloud], { workspaceId: 'ws-1' });
    const second = mergeCloudInvoicesIntoVorgaenge(first.vorgaenge, [cloud], {
      workspaceId: 'ws-1',
    });
    expect(first.insertedCount).toBe(1);
    expect(second.noopCount).toBe(1);
    expect(second.vorgaenge[0]!.invoices).toHaveLength(1);
    expect(second.vorgaenge[0]!.invoices[0]!.positions[0]?.quantity).toBe(3);
    expect(second.vorgaenge[0]!.invoices[0]!.amount).toBe(cloud.invoice.amount);

    const v = second.vorgaenge[0]!;
    expect(getBilledQuantity(v, 'op-test-1')).toBe(3);
    expect(getBillableOpenQuantity(v, 'op-test-1')).toBe(7);
  });

  it('Abschlag und Schluss-Lock nach Pull korrekt; Doppel-Pull ändert Billing nicht', () => {
    const abschlag = toMapped();
    const schlussInvoice = createAbschlagInvoice('op-test-1', 7, {
      id: 'inv-schluss',
      number: '2026-0002',
      type: 'schluss',
      abschlagNumber: undefined,
      invoiceSequenceNumber: 2,
    });
    const schluss: MappedWorkspaceInvoicePull = {
      ...abschlag,
      clientInvoiceId: 'inv-schluss',
      cloudInvoiceId: 'cloud-row-2',
      invoice: schlussInvoice,
    };
    const base = createTestVorgang({
      orderPositions: [
        {
          id: 'op-test-1',
          description: 'Testleistung',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
          category: 'arbeit',
          executedQuantity: 10,
        },
      ],
    });
    const after = mergeCloudInvoicesIntoVorgaenge([base], [abschlag, schluss], {
      workspaceId: 'ws-1',
    });
    expect(hasSchlussrechnung(after.vorgaenge[0]!)).toBe(true);
    expect(getBilledQuantity(after.vorgaenge[0]!, 'op-test-1')).toBe(10);
    const again = mergeCloudInvoicesIntoVorgaenge(after.vorgaenge, [abschlag, schluss], {
      workspaceId: 'ws-1',
    });
    expect(getBilledQuantity(again.vorgaenge[0]!, 'op-test-1')).toBe(10);
    expect(again.vorgaenge[0]!.invoices).toHaveLength(2);
  });
});

describe('CLOUD-ORDER-CHAIN-03B2 Intent / Status / Fehler', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceFinalizeIntentsForTests();
    vi.restoreAllMocks();
  });

  it('passender Cloud-Beleg löscht Intent; abweichender Fingerprint nicht', () => {
    const cloud = toMapped();
    const fingerprint = buildInvoiceContentFingerprintFromInvoice(cloud.invoice);

    seedInvoiceFinalizeIntentForTests({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      clientInvoiceId: cloud.clientInvoiceId,
      contentFingerprint: fingerprint,
      createdAt: new Date().toISOString(),
    });
    expect(
      reconcileInvoiceFinalizeIntentAfterMerge({
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        invoice: cloud.invoice,
      }),
    ).toBe('cleared');
    expect(getInvoiceFinalizeIntent('v-test-1')).toBeNull();

    seedInvoiceFinalizeIntentForTests({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      clientInvoiceId: cloud.clientInvoiceId,
      contentFingerprint: 'different-fp',
      createdAt: new Date().toISOString(),
    });
    expect(
      reconcileInvoiceFinalizeIntentAfterMerge({
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        invoice: cloud.invoice,
      }),
    ).toBe('fingerprint_conflict');
    expect(getInvoiceFinalizeIntent('v-test-1')).not.toBeNull();
  });

  it('Persistenzfehler-Pfad: Intent bleibt bis nach erfolgreichem Batch-Persist', () => {
    const cloud = toMapped();
    seedInvoiceFinalizeIntentForTests({
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      clientInvoiceId: cloud.clientInvoiceId,
      contentFingerprint: buildInvoiceContentFingerprintFromInvoice(cloud.invoice),
      createdAt: new Date().toISOString(),
    });
    const merged = mergeCloudInvoicesIntoVorgaenge([createTestVorgang()], [cloud], {
      workspaceId: 'ws-1',
    });
    expect(merged.pendingIntentClears).toContain('v-test-1');
    // Merge only schedules clear — intent remains until caller persists successfully.
    expect(getInvoiceFinalizeIntent('v-test-1')).not.toBeNull();
  });

  it('Cloud vorbereitet setzt lokal versendet nicht zurück; versendet hebt monoton an', () => {
    expect(resolveMonotonicInvoiceStatus('versendet', 'vorbereitet')).toBe('versendet');
    expect(resolveMonotonicInvoiceStatus('vorbereitet', 'versendet')).toBe('versendet');

    const local = { ...toMapped().invoice, status: 'versendet' as const };
    const cloud = { ...toMapped().invoice, status: 'vorbereitet' as const };
    const applied = applyFinalizedInvoiceToVorgang(
      createTestVorgang({ invoices: [local] }),
      cloud,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.invoice.status).toBe('versendet');

    const raise = applyFinalizedInvoiceToVorgang(
      createTestVorgang({
        invoices: [{ ...toMapped().invoice, status: 'vorbereitet' }],
      }),
      { ...toMapped().invoice, status: 'versendet' },
    );
    expect(raise.ok && raise.action === 'status_raised').toBe(true);
    if (!raise.ok) return;
    expect(raise.invoice.status).toBe('versendet');
  });

  it('Invoice-RPC-Fehler verwirft Vorgang-Pull nicht', async () => {
    vi.spyOn(workspaceInvoiceCloud, 'rpcPullWorkspaceInvoiceRows').mockRejectedValue(
      new WorkspaceInvoiceCloudError('Kein Zugriff auf Workspace', 'rls', false),
    );

    const localVorgang = createTestVorgang({
      invoices: [createAbschlagInvoice('op-test-1', 1, { id: 'inv-local', number: 'L-1' })],
    });
    const report = createEmptySyncSimulationReport(new Date().toISOString());
    const result = await applyInvoicePullAfterVorgangMerge({
      workspaceId: 'ws-1',
      vorgaenge: [localVorgang],
      report,
    });

    expect(result.invoiceRpcFailed).toBe(true);
    expect(report.errors.some((e) => e.outboxId === 'invoice-pull')).toBe(true);
    expect(result.vorgaenge[0]!.invoices.some((i) => i.id === 'inv-local')).toBe(true);
  });

  it('Batch-Merge ruft persistAll nicht pro Rechnung auf', () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const a = toMapped();
    const b: MappedWorkspaceInvoicePull = {
      ...a,
      clientInvoiceId: 'inv-cloud-2',
      cloudInvoiceId: 'cloud-row-2',
      invoice: {
        ...a.invoice,
        id: 'inv-cloud-2',
        number: '2026-0002',
        invoiceSequenceNumber: 2,
      },
    };
    mergeCloudInvoicesIntoVorgaenge([createTestVorgang()], [a, b], {
      workspaceId: 'ws-1',
      reconcileIntents: false,
    });
    expect(persistSpy).not.toHaveBeenCalled();
    persistSpy.mockRestore();
  });

  it('kein Cross-Workspace-Merge', () => {
    const foreign = { ...toMapped(), workspaceId: 'ws-other' };
    const merged = mergeCloudInvoicesIntoVorgaenge([createTestVorgang()], [foreign], {
      workspaceId: 'ws-1',
    });
    expect(merged.insertedCount).toBe(0);
    expect(merged.conflicts.some((c) => c.reason === 'orphan')).toBe(true);
  });
});

describe('CLOUD-ORDER-CHAIN-03B2 upsert reuse', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore([createTestVorgang()]);
  });

  it('upsertFinalizedInvoiceOnVorgang bleibt idempotent über Fingerprint', () => {
    const invoice = toMapped().invoice;
    expect(upsertFinalizedInvoiceOnVorgang('v-test-1', invoice).ok).toBe(true);
    expect(upsertFinalizedInvoiceOnVorgang('v-test-1', invoice)).toMatchObject({
      ok: true,
      action: 'noop',
    });
    expect(immutableInvoiceFingerprint(invoice, 'v-test-1')).toBe(
      immutableInvoiceFingerprint({ ...invoice }, 'v-test-1'),
    );
  });
});

describe('CLOUD-ORDER-CHAIN-03B2 RPC client errors', () => {
  it('rpcPullWorkspaceInvoiceRows wirft bei RLS', async () => {
    await expect(
      rpcPullWorkspaceInvoiceRows('ws-1', {
        client: {
          rpc: async () => ({ data: null, error: { message: 'Kein Zugriff auf Workspace' } }),
        } as never,
      }),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });
});
