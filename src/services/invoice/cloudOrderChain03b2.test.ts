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
  mapCloudPayloadToVorgangInvoice,
  mapWorkspaceInvoicePullRowToVorgangInvoice,
  parseWorkspaceInvoicePullRow,
  rpcFinalizePreparedWorkspaceInvoice,
  rpcFinalizeWorkspaceInvoice,
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
  beforeEach(() => {    resetInvoiceFinalizeIntentsForTests();
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
  beforeEach(() => {    resetInvoiceFinalizeIntentsForTests();
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
  beforeEach(() => {    hydrateVorgangStore([createTestVorgang()]);
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

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B2 — Falsy-Parität des
 * Cloud-Payload-Mappings.
 * ========================================================================== */

/** Genau die optionalen Textfelder, die der Mapper heute abbildet. */
const OPTIONAL_TEXT_FIELDS = [
  'issueDate',
  'servicePeriodFrom',
  'servicePeriodTo',
  'paymentDueDate',
  'paymentTermsText',
  'skontoText',
  'introText',
  'closingText',
  'baustelle',
  'vorgangTitle',
  'sentAt',
  'sentNote',
] as const;

function mapPayload(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = createAbschlagInvoice('op-test-1', 3, {
    id: 'inv-cloud-1',
    number: '2026-0001',
    status: 'vorbereitet',
  });
  return mapCloudPayloadToVorgangInvoice({
    ...(base as unknown as Record<string, unknown>),
    ...overrides,
  }) as unknown as Record<string, unknown>;
}

describe('01P4D2B2 — Falsy-Parität im Cloud-Payload-Mapping', () => {
  it('Y1: ein leerer Textwert bleibt exakt leer', () => {
    for (const field of OPTIONAL_TEXT_FIELDS) {
      const mapped = mapPayload({ [field]: '' });
      expect(field in mapped, field).toBe(true);
      expect(mapped[field], field).toBe('');
      expect(mapped[field], field).not.toBeUndefined();
    }
  });

  it('Y2: fehlende, null- und ungültige Werte bleiben undefined', () => {
    for (const field of OPTIONAL_TEXT_FIELDS) {
      const missing = mapPayload({ [field]: undefined });
      expect(missing[field], `${field}:missing`).toBeUndefined();

      const nulled = mapPayload({ [field]: null });
      expect(nulled[field], `${field}:null`).toBeUndefined();

      // Keine Ersetzung durch '' und keine Trimmung.
      const padded = mapPayload({ [field]: '  ' });
      expect(padded[field], `${field}:padded`).toBe('  ');
    }
  });

  it('Y3: gültige Null-Werte bleiben erhalten', () => {
    const zeroed = mapPayload({
      abschlagNumber: 0,
      invoiceSequenceNumber: 0,
      subtotal: 0,
      amount: 0,
      calculationMode: 'fixed_amount',
      fixedAmountNet: 0,
    });
    expect(zeroed.abschlagNumber).toBe(0);
    expect(zeroed.invoiceSequenceNumber).toBe(0);
    expect(zeroed.subtotal).toBe(0);
    expect(zeroed.amount).toBe(0);
    expect(zeroed.fixedAmountNet).toBe(0);

    const absent = mapPayload({
      abschlagNumber: undefined,
      invoiceSequenceNumber: undefined,
      fixedAmountNet: undefined,
    });
    expect(absent.abschlagNumber).toBeUndefined();
    expect(absent.invoiceSequenceNumber).toBeUndefined();
    expect(absent.fixedAmountNet).toBeUndefined();
  });

  it('Y4: ungültige Typen werden nicht still in Text umgewandelt', () => {
    for (const field of OPTIONAL_TEXT_FIELDS) {
      for (const value of [5, true, false, { a: 1 }, ['x']]) {
        const mapped = mapPayload({ [field]: value });
        expect(mapped[field], `${field}:${JSON.stringify(value)}`).toBeUndefined();
      }
    }
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B3 — vollständige
 * Projektionsparität des Cloud-Payload-Mappings.
 * ========================================================================== */

describe('01P4D2B3 — vollständige Projektionsparität', () => {
  it('Z1: expectedAmendmentSequence bleibt exakt erhalten', () => {
    expect(mapPayload({ expectedAmendmentSequence: 0 }).expectedAmendmentSequence).toBe(0);
    expect(mapPayload({ expectedAmendmentSequence: 7 }).expectedAmendmentSequence).toBe(7);

    for (const invalid of [undefined, null, '0', 1.5, -1, true, {}, []]) {
      const mapped = mapPayload({ expectedAmendmentSequence: invalid });
      expect(
        mapped.expectedAmendmentSequence,
        `expectedAmendmentSequence:${JSON.stringify(invalid)}`,
      ).toBeUndefined();
    }
  });

  it('Z2: cancelledAt und cancelReason bleiben bytegenau erhalten', () => {
    for (const field of ['cancelledAt', 'cancelReason'] as const) {
      const kept = mapPayload({ [field]: '2026-08-01T10:00:00.000Z' });
      expect(kept[field], field).toBe('2026-08-01T10:00:00.000Z');

      // Ein leerer String ist ein gültiger Textwert und bleibt erhalten.
      const empty = mapPayload({ [field]: '' });
      expect(field in empty, `${field}:empty`).toBe(true);
      expect(empty[field], `${field}:empty`).toBe('');

      const padded = mapPayload({ [field]: '  ' });
      expect(padded[field], `${field}:padded`).toBe('  ');

      for (const invalid of [undefined, null, 5, true, {}, []]) {
        const mapped = mapPayload({ [field]: invalid });
        expect(mapped[field], `${field}:${JSON.stringify(invalid)}`).toBeUndefined();
      }
    }
  });

  it('Z3: Arrays werden nicht teilweise repariert', () => {
    expect(mapPayload({ legalNotices: ['a', ''] }).legalNotices).toEqual(['a', '']);
    expect(mapPayload({ legalNotices: [] }).legalNotices).toEqual([]);

    // Keine String()-Umwandlung und keine Teilreparatur.
    for (const invalid of [['a', 5], ['a', true], ['a', null], ['a', { b: 1 }], 'text', 5]) {
      const mapped = mapPayload({ legalNotices: invalid });
      expect(mapped.legalNotices, JSON.stringify(invalid)).toBeUndefined();
    }

    // Positionen bleiben unverändert; eine ungültige Liste wirft nicht.
    const positions = mapPayload({ positions: 'kein Array' }).positions;
    expect(positions).toEqual([]);
  });

  it('Z4: verbleibende Coercions sind fail-closed', () => {
    // id, number, type und status stammen aus geprüften Zeilenspalten.
    expect(parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_type: 'unbekannt' })).toBeNull();
    expect(parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_status: 'bezahlt' })).toBeNull();
    expect(parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_number: '' })).toBeNull();
    expect(
      parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_sequence_number: 0 }),
    ).toBeNull();

    // Der Parser prüft den Payload-Inhalt nicht — der Mapper muss es tun.
    expect(mapPayload({ date: 5 }).date).toBe('');
    expect(mapPayload({ createdAt: 5 }).createdAt).toBe('');
    // Kein erfundener lokaler Zeitpunkt bei fehlendem createdAt.
    expect(mapPayload({ createdAt: undefined }).createdAt).toBe('');
    expect(mapPayload({ subtotal: '5' }).subtotal).toBeUndefined();
    expect(mapPayload({ amount: '5' }).amount).toBeUndefined();
    expect(mapPayload({ sentVia: 'fantasie' }).sentVia).toBeUndefined();
    expect(mapPayload({ sentVia: 'email' }).sentVia).toBe('email');
    expect(mapPayload({ customerSnapshot: 'text' }).customerSnapshot).toBeUndefined();
    expect(mapPayload({ companySnapshot: ['x'] }).companySnapshot).toBeUndefined();
    expect(mapPayload({ taxStatus: 5 }).taxStatus).toBeUndefined();
  });
});

/* ========================================================================== *
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B4 — strenge Validierung
 * vor Mapping, Merge und Persistenz.
 * ========================================================================== */

describe('01P4D2B4 — strenge Cloud-Pull-Validierung', () => {
  it('P1: Rohzeilen werden ohne Coercion streng typgeprüft', () => {
    const stringColumns = [
      'id',
      'workspace_id',
      'vorgang_id',
      'client_invoice_id',
      'invoice_number',
    ] as const;
    for (const column of stringColumns) {
      for (const invalid of [5, true, ['a'], { a: 1 }, null, undefined, '   ']) {
        expect(
          parseWorkspaceInvoicePullRow({ ...cloudRow(), [column]: invalid }),
          `${column}:${JSON.stringify(invalid)}`,
        ).toBeNull();
      }
    }

    for (const column of ['invoice_type', 'invoice_status'] as const) {
      for (const invalid of [['abschlag'], { toString: () => 'abschlag' }, 5, true]) {
        expect(
          parseWorkspaceInvoicePullRow({ ...cloudRow(), [column]: invalid }),
          `${column}:${JSON.stringify(invalid)}`,
        ).toBeNull();
      }
    }

    for (const invalid of ['2026', null, 2026.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_year: invalid }),
        `invoice_year:${String(invalid)}`,
      ).toBeNull();
    }

    for (const invalid of ['1', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseWorkspaceInvoicePullRow({ ...cloudRow(), invoice_sequence_number: invalid }),
        `invoice_sequence_number:${String(invalid)}`,
      ).toBeNull();
    }

    for (const invalid of ['1', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseWorkspaceInvoicePullRow({ ...cloudRow(), row_version: invalid }),
        `row_version:${String(invalid)}`,
      ).toBeNull();
    }

    class Fremd {
      readonly id = 'x';
    }
    for (const invalid of [[], new Fremd(), 'text', 5, null]) {
      expect(
        parseWorkspaceInvoicePullRow({ ...cloudRow(), payload: invalid }),
        `payload:${JSON.stringify(String(invalid))}`,
      ).toBeNull();
    }

    // Die gültige Zeile bleibt gültig.
    expect(parseWorkspaceInvoicePullRow(cloudRow())).not.toBeNull();
  });

  it('P5: ungültiger Payload erhöht invalidCount vor jedem Mapping', () => {
    const invalidPayloads: [string, Record<string, unknown>][] = [
      ['date', { date: 5 }],
      ['createdAt', { createdAt: {} }],
      ['subtotal', { subtotal: '81' }],
      ['amount', { amount: Number.NaN }],
      ['taxStatus', { taxStatus: 'beliebig' }],
      ['positions', { positions: {} }],
      ['positionsfeld', { positions: [{ id: 'l', orderPositionId: 'o', description: 5 }] }],
      ['snapshot', { customerSnapshot: { name: 5 } }],
      ['abzuege', { previousAbschlagDeductions: [5] }],
      ['legalNotices', { legalNotices: ['a', 5] }],
    ];

    const mapperSpy = vi.spyOn(workspaceInvoiceCloud, 'mapWorkspaceInvoicePullRowToVorgangInvoice');

    for (const [label, overrides] of invalidPayloads) {
      const base = cloudRow();
      const row = {
        ...base,
        payload: { ...(base.payload as Record<string, unknown>), ...overrides },
      };
      expect(parseWorkspaceInvoicePullRow(row), label).toBeNull();

      mapperSpy.mockClear();
      const { mapped, invalidCount } = mapPullRowsIsolated([row], 'ws-1');
      expect(invalidCount, label).toBe(1);
      expect(mapped, label).toEqual([]);
      expect(mapperSpy, label).not.toHaveBeenCalled();
    }

    // Ein Payload-Array wird ebenfalls abgewiesen.
    expect(parseWorkspaceInvoicePullRow({ ...cloudRow(), payload: [] })).toBeNull();
    mapperSpy.mockRestore();
  });

  it('P9: die Legacy-Finalisierungsantwort wird vor dem Mapping geprüft', async () => {
    const invoice = createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-legacy-1',
      number: '2026-0009',
      invoiceSequenceNumber: 9,
      status: 'vorbereitet',
    });
    const validPayload = { ...(invoice as unknown as Record<string, unknown>) };
    delete validPayload.payments;
    delete validPayload.paymentStatus;
    delete validPayload.archiveDocumentId;

    /*
     * 01P4E1C S4 — das Fixture trug bisher nur fünf Spalten. Das SQL gibt mit
     * `to_jsonb(v_existing)` die **vollständige** Tabellenzeile zurück,
     * einschließlich `payload`, das mit `data.invoice` identisch ist.
     */
    const row = (invoicePayload: unknown) => ({
      id: 'cloud-row-legacy',
      workspace_id: 'ws-1',
      vorgang_id: 'v-test-1',
      client_invoice_id: 'inv-legacy-1',
      invoice_number: '2026-0009',
      invoice_year: 2026,
      invoice_sequence_number: 9,
      invoice_type: 'abschlag',
      invoice_status: 'vorbereitet',
      payload: invoicePayload,
      row_version: 1,
      created_at: '2026-08-21T10:00:00.000Z',
      updated_at: '2026-08-21T10:00:00.000Z',
    });

    const respond = (invoicePayload: unknown) =>
      ({
        // 01P4E1B — die Hülle ist jetzt strikt; das Fixture liefert sie vollständig.
        rpc: async () => ({
          data: {
            idempotent_replay: false,
            invoice: invoicePayload,
            row: row(invoicePayload),
          },
          error: null,
        }),
      }) as never;

    // Gültige Antwort wird weiterhin exakt gemappt.
    const ok = await rpcFinalizeWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        clientInvoiceId: 'inv-legacy-1',
        invoice,
      },
      respond(validPayload),
    );
    expect(ok.invoice.id).toBe('inv-legacy-1');
    expect(ok.invoice.amount).toBe(invoice.amount);
    expect(ok.invoice.createdAt).toBe(invoice.createdAt);

    // Ungültiger Pflichtfeldtyp wird typisiert abgelehnt — kein Teilergebnis.
    for (const broken of [
      { ...validPayload, amount: 'zwölf' },
      { ...validPayload, createdAt: 5 },
      { ...validPayload, positions: {} },
      { ...validPayload, taxStatus: 'beliebig' },
    ]) {
      await expect(
        rpcFinalizeWorkspaceInvoice(
          {
            workspaceId: 'ws-1',
            vorgangId: 'v-test-1',
            clientInvoiceId: 'inv-legacy-1',
            invoice,
          },
          respond(broken),
        ),
      ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }
  });

  it('P8: der normale Sync bleibt zeilenisoliert', () => {
    const valid = cloudRow();
    const base = cloudRow({ id: 'cloud-row-2', client_invoice_id: 'inv-cloud-2' });
    const broken = {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), amount: 'zwölf' },
    };

    const { mapped, invalidCount } = mapPullRowsIsolated([valid, broken], 'ws-1');
    expect(invalidCount).toBe(1);
    expect(mapped.length).toBe(1);
    expect(mapped[0]?.clientInvoiceId).toBe('inv-cloud-1');
  });
});

/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1B — strenge Hülle der
 * Legacy-Finalisierungsantwort und Nachweis der Zeilenisolation am **echten**
 * Pull-Orchestrator. Keine fachliche Identität, kein IDB- und kein
 * Serververtrag wird hier verändert.
 */
describe('01P4E1B — strenge Legacy-RPC-Hülle', () => {
  const legacyInvoice = () =>
    createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-legacy-r1',
      number: '2026-0011',
      invoiceSequenceNumber: 11,
      status: 'vorbereitet',
    });

  const legacyPayload = (): Record<string, unknown> => {
    const payload = { ...(legacyInvoice() as unknown as Record<string, unknown>) };
    delete payload.payments;
    delete payload.paymentStatus;
    delete payload.archiveDocumentId;
    return payload;
  };

  const legacyRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cloud-row-legacy-r1',
    workspace_id: 'ws-1',
    vorgang_id: 'v-test-1',
    client_invoice_id: 'inv-legacy-r1',
    invoice_number: '2026-0011',
    invoice_year: 2026,
    invoice_sequence_number: 11,
    invoice_type: 'abschlag',
    invoice_status: 'vorbereitet',
    payload: legacyPayload(),
    row_version: 4,
    created_at: '2026-08-21T10:00:00.000Z',
    updated_at: '2026-08-21T10:00:00.000Z',
    ...overrides,
  });

  const respond = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as never;

  const finalize = (data: unknown) =>
    rpcFinalizeWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        clientInvoiceId: 'inv-legacy-r1',
        invoice: legacyInvoice(),
      },
      respond(data),
    );

  it('R1a: eine gültige Antwort bleibt in jedem Feld exakt erhalten', async () => {
    const invoice = legacyInvoice();

    const fresh = await finalize({
      idempotent_replay: false,
      invoice: legacyPayload(),
      row: legacyRow(),
    });
    expect(fresh.idempotentReplay).toBe(false);
    expect(fresh.cloudInvoiceId).toBe('cloud-row-legacy-r1');
    expect(fresh.rowVersion).toBe(4);
    expect(fresh.invoice.id).toBe('inv-legacy-r1');
    expect(fresh.invoice.amount).toBe(invoice.amount);
    expect(fresh.invoice.createdAt).toBe(invoice.createdAt);

    const replay = await finalize({
      idempotent_replay: true,
      invoice: legacyPayload(),
      row: legacyRow({ id: 'cloud-row-legacy-r2', row_version: 7 }),
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.cloudInvoiceId).toBe('cloud-row-legacy-r2');
    expect(replay.rowVersion).toBe(7);
  });

  it('R1b: der Payload wird weiterhin vor dem Mapper geprüft', async () => {
    await expect(
      finalize({
        idempotent_replay: false,
        invoice: { ...legacyPayload(), taxStatus: 'beliebig' },
        row: legacyRow(),
      }),
    ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });

  it('R1c: idempotent_replay wird ausschließlich als echtes Boolean akzeptiert', async () => {
    const broken: unknown[] = [0, 1, 'false', 'true', null, {}, [], undefined];
    for (const value of broken) {
      const data: Record<string, unknown> = { invoice: legacyPayload(), row: legacyRow() };
      if (value !== undefined) data.idempotent_replay = value;
      await expect(finalize(data), JSON.stringify(value ?? 'fehlend')).rejects.toBeInstanceOf(
        WorkspaceInvoiceCloudError,
      );
    }
  });

  it('R1d: row muss ein reines Objekt sein', async () => {
    for (const value of [undefined, null, [], 'row', 5, true]) {
      const data: Record<string, unknown> = {
        idempotent_replay: false,
        invoice: legacyPayload(),
      };
      if (value !== undefined) data.row = value;
      await expect(finalize(data), JSON.stringify(value ?? 'fehlend')).rejects.toBeInstanceOf(
        WorkspaceInvoiceCloudError,
      );
    }
  });

  it('R1e: row.id muss ein nicht leerer echter String sein', async () => {
    for (const value of [5, true, {}, [], '', '   ', null, undefined]) {
      const row = legacyRow();
      if (value === undefined) delete (row as Record<string, unknown>).id;
      else (row as Record<string, unknown>).id = value;
      await expect(
        finalize({ idempotent_replay: false, invoice: legacyPayload(), row }),
        JSON.stringify(value ?? 'fehlend'),
      ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }
  });

  it('R1f: row.row_version muss eine ganze Zahl grösser null sein', async () => {
    for (const value of ['2', null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const row = legacyRow();
      if (value === undefined) delete (row as Record<string, unknown>).row_version;
      else (row as Record<string, unknown>).row_version = value;
      await expect(
        finalize({ idempotent_replay: false, invoice: legacyPayload(), row }),
        String(value ?? 'fehlend'),
      ).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }
  });

  it('R1g: eine abgelehnte Hülle liefert niemals ein Teilergebnis', async () => {
    const result = await finalize({
      idempotent_replay: 1,
      invoice: legacyPayload(),
      row: legacyRow(),
    }).then(
      (value) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    expect(result.resolved).toBe(false);
    expect((result as { error: unknown }).error).toBeInstanceOf(WorkspaceInvoiceCloudError);
    // Die bestehende fachliche Klassifikation bleibt erhalten.
    expect((result as { error: WorkspaceInvoiceCloudError }).error.code).toBe('unknown');
  });
});

describe('01P4E1B — Zeilenisolation im echten Pull-Orchestrator', () => {
  beforeEach(() => {
    resetInvoiceFinalizeIntentsForTests();
  });

  it('R3: eine ungültige Zeile wird gemeldet, die gültige normal übernommen', async () => {
    const valid = cloudRow();
    const base = cloudRow({ id: 'cloud-row-2', client_invoice_id: 'inv-cloud-2' });
    const broken = {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), amount: 'zwölf' },
    };

    const vorgang = createTestVorgang({ invoices: [] });
    const report = createEmptySyncSimulationReport();
    const client = {
      rpc: async (name: string) => {
        if (name !== 'pull_workspace_invoices') throw new Error(`unerwarteter RPC: ${name}`);
        return { data: [valid, broken], error: null };
      },
    } as never;

    const result = await applyInvoicePullAfterVorgangMerge({
      workspaceId: 'ws-1',
      vorgaenge: [vorgang],
      report,
      client,
    });

    // Kein globaler Abbruch im normalen Sync.
    expect(result.invoiceRpcFailed).toBe(false);
    expect(result.merge).not.toBeNull();

    // Die gültige Rechnung wird nach dem bestehenden Sync-Vertrag übernommen.
    const invoices = result.vorgaenge[0]!.invoices;
    expect(invoices.map((invoice) => invoice.id)).toEqual(['inv-cloud-1']);
    expect(result.merge!.insertedCount).toBe(1);

    // Kein Feld der ungültigen Rechnung erscheint lokal.
    expect(invoices.some((invoice) => invoice.id === 'inv-cloud-2')).toBe(false);
    expect(JSON.stringify(result.vorgaenge)).not.toContain('inv-cloud-2');
    expect(JSON.stringify(result.vorgaenge)).not.toContain('cloud-row-2');

    /*
     * Die ungültige Zeile wird als invalid_row gemeldet — der tatsächliche
     * Meldeweg des normalen Syncs ist der Simulationsbericht, nicht das
     * Merge-Ergebnis. Der Merge sieht die Zeile nie.
     */
    expect(report.conflictCount).toBe(1);
    expect(report.conflicts.map((conflict) => conflict.entityId)).toEqual([
      'invoice:inv-cloud-2',
    ]);
    expect(result.merge!.conflicts).toEqual([]);
  });

  it('01P4E1C S7: eine widersprüchliche Zeile erreicht den Merge nicht', async () => {
    const valid = cloudRow();
    const base = cloudRow({ id: 'cloud-row-s7', client_invoice_id: 'inv-cloud-s7' });
    // Typgültig, aber die Zeilenspalte widerspricht dem Payload.
    const contradictory = {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), id: 'inv-cloud-s7-anders' },
    };

    const report = createEmptySyncSimulationReport();
    const client = {
      rpc: async () => ({ data: [valid, contradictory], error: null }),
    } as never;

    const result = await applyInvoicePullAfterVorgangMerge({
      workspaceId: 'ws-1',
      vorgaenge: [createTestVorgang({ invoices: [] })],
      report,
      client,
    });

    expect(result.invoiceRpcFailed).toBe(false);
    expect(result.vorgaenge[0]!.invoices.map((invoice) => invoice.id)).toEqual(['inv-cloud-1']);
    expect(result.merge!.insertedCount).toBe(1);
    expect(result.merge!.conflicts).toEqual([]);
    expect(report.conflictCount).toBe(1);
    expect(report.conflicts.map((conflict) => conflict.entityId)).toEqual([
      'invoice:inv-cloud-s7',
    ]);
    expect(JSON.stringify(result.vorgaenge)).not.toContain('inv-cloud-s7');
  });

  it('R4: die bestehende Schutzgrenze vor dem Merge bleibt unverändert', () => {
    const base = cloudRow({ id: 'cloud-row-3', client_invoice_id: 'inv-cloud-3' });
    const broken = {
      ...base,
      payload: { ...(base.payload as Record<string, unknown>), amount: 'zwölf' },
    };
    const { mapped, invalidCount } = mapPullRowsIsolated([cloudRow(), broken], 'ws-1');
    expect(invalidCount).toBe(1);
    expect(mapped.map((entry) => entry.clientInvoiceId)).toEqual(['inv-cloud-1']);
  });
});

/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1C — die autoritativen
 * Zeilenspalten und ihre im Payload duplizierten Felder müssen exakt
 * zusammenpassen. Ein typgültiger, aber widersprüchlicher Datensatz wird
 * abgewiesen statt stillschweigend von den Spalten überschrieben.
 */
describe('01P4E1C — Zeilen-/Payload-Konsistenz beim Pull', () => {
  const withPayload = (overrides: Record<string, unknown>) => {
    const base = cloudRow();
    return { ...base, payload: { ...(base.payload as Record<string, unknown>), ...overrides } };
  };

  it('S1: jede der fünf duplizierten Kernfelder muss übereinstimmen', () => {
    // Kontrollfall: vollständig übereinstimmend bleibt gültig.
    expect(parseWorkspaceInvoicePullRow(cloudRow())).not.toBeNull();

    const contradictions: Array<[string, Record<string, unknown>]> = [
      ['id', { id: 'inv-cloud-anders' }],
      ['number', { number: '2026-9999' }],
      ['invoiceSequenceNumber', { invoiceSequenceNumber: 42 }],
      ['type', { type: 'rechnung' }],
      ['status', { status: 'entwurf' }],
    ];

    const spy = vi.spyOn(workspaceInvoiceCloud, 'mapWorkspaceInvoicePullRowToVorgangInvoice');
    for (const [label, overrides] of contradictions) {
      const row = withPayload(overrides);
      expect(parseWorkspaceInvoicePullRow(row), label).toBeNull();

      const { mapped, invalidCount } = mapPullRowsIsolated([row], 'ws-1');
      expect(invalidCount, label).toBe(1);
      expect(mapped, label).toEqual([]);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('S2: Zeilenspalten mit Whitespace werden abgewiesen statt getrimmt', () => {
    const columns = [
      'id',
      'workspace_id',
      'vorgang_id',
      'client_invoice_id',
      'invoice_number',
      'invoice_type',
      'invoice_status',
    ];
    for (const column of columns) {
      const original = String((cloudRow() as Record<string, unknown>)[column]);
      for (const padded of [` ${original}`, `${original} `, ` ${original} `]) {
        expect(
          parseWorkspaceInvoicePullRow(cloudRow({ [column]: padded })),
          `${column}:${JSON.stringify(padded)}`,
        ).toBeNull();
      }
    }

    // Whitespace innerhalb eines fachlich erlaubten Textes bleibt unangetastet.
    const parsed = parseWorkspaceInvoicePullRow(
      withPayload({ paymentTermsText: '  Zahlbar   in 14 Tagen  ' }),
    );
    expect(parsed).not.toBeNull();
    expect((parsed!.payload as Record<string, unknown>).paymentTermsText).toBe(
      '  Zahlbar   in 14 Tagen  ',
    );
  });
});

describe('01P4E1C — vollständige Bindung der Legacy-RPC-Antwort', () => {
  const invoice = () =>
    createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-legacy-s3',
      number: '2026-0013',
      invoiceSequenceNumber: 13,
      status: 'vorbereitet',
    });

  const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const value = { ...(invoice() as unknown as Record<string, unknown>) };
    delete value.payments;
    delete value.paymentStatus;
    delete value.archiveDocumentId;
    return { ...value, ...overrides };
  };

  /**
   * Der echte SQL-Vertrag ist in allen drei Rückgaben identisch:
   * `'invoice', v_existing.payload` und `'row', to_jsonb(v_existing)`.
   * `data.invoice` und `row.payload` sind deshalb dasselbe JSONB.
   */
  const envelope = (
    rowOverrides: Record<string, unknown> = {},
    payloadOverrides: Record<string, unknown> = {},
  ) => {
    const invoicePayload = payload(payloadOverrides);
    return {
      idempotent_replay: false,
      invoice: invoicePayload,
      row: {
        id: 'cloud-row-s3',
        workspace_id: 'ws-1',
        vorgang_id: 'v-test-1',
        client_invoice_id: 'inv-legacy-s3',
        invoice_number: '2026-0013',
        invoice_year: 2026,
        invoice_sequence_number: 13,
        invoice_type: 'abschlag',
        invoice_status: 'vorbereitet',
        payload: invoicePayload,
        row_version: 3,
        created_at: '2026-08-21T10:00:00.000Z',
        updated_at: '2026-08-21T10:00:00.000Z',
        ...rowOverrides,
      },
    };
  };

  const finalize = (data: unknown) =>
    rpcFinalizeWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        clientInvoiceId: 'inv-legacy-s3',
        invoice: invoice(),
      },
      { rpc: async () => ({ data, error: null }) } as never,
    );

  it('S3a: die vollständig gebundene Antwort bleibt gültig', async () => {
    const result = await finalize(envelope());
    expect(result.invoice.id).toBe('inv-legacy-s3');
    expect(result.invoice.number).toBe('2026-0013');
    expect(result.cloudInvoiceId).toBe('cloud-row-s3');
    expect(result.rowVersion).toBe(3);
    expect(result.idempotentReplay).toBe(false);
  });

  it('S3b: jede typgültige Abweichung zwischen Eingabe, Payload und Zeile wird abgewiesen', async () => {
    const cases: Array<[string, unknown]> = [
      ['row.workspace_id', envelope({ workspace_id: 'ws-2' })],
      ['row.vorgang_id', envelope({ vorgang_id: 'v-test-2' })],
      ['row.client_invoice_id', envelope({ client_invoice_id: 'inv-legacy-anders' })],
      ['row.invoice_number', envelope({ invoice_number: '2026-9999' })],
      ['row.invoice_sequence_number', envelope({ invoice_sequence_number: 99 })],
      ['row.invoice_type', envelope({ invoice_type: 'rechnung' })],
      ['row.invoice_status', envelope({ invoice_status: 'entwurf' })],
      ['payload.id', envelope({}, { id: 'inv-legacy-anders' })],
    ];

    for (const [label, data] of cases) {
      await expect(finalize(data), label).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
    }
  });

  it('S3c: row.payload muss strukturell gleich zu data.invoice sein', async () => {
    const base = envelope();
    const divergent = {
      ...base,
      row: { ...base.row, payload: { ...payload(), amount: 999 } },
    };
    await expect(finalize(divergent)).rejects.toBeInstanceOf(WorkspaceInvoiceCloudError);
  });

  it('S3d: row.id wird nicht getrimmt, sondern abgewiesen', async () => {
    for (const padded of [' cloud-row-s3', 'cloud-row-s3 ', ' cloud-row-s3 ']) {
      await expect(finalize(envelope({ id: padded })), padded).rejects.toBeInstanceOf(
        WorkspaceInvoiceCloudError,
      );
    }
  });
});

/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1C1 — kanonische Anfrage und
 * vollständige Antwortzeile im Legacy-Finalisierungspfad. Fehler **vor** dem
 * RPC bleiben `validation`, Fehler in einer **erhaltenen** Antwort `unknown`.
 */
describe('01P4E1C1 — kanonische Legacy-RPC-Anfrage', () => {
  const invoice = (overrides: Record<string, unknown> = {}) =>
    ({
      ...createAbschlagInvoice('op-test-1', 3, {
        id: 'inv-legacy-t1',
        number: '2026-0021',
        invoiceSequenceNumber: 21,
        status: 'vorbereitet',
      }),
      ...overrides,
    }) as ReturnType<typeof createAbschlagInvoice>;

  const expectRejectedBeforeRpc = async (
    input: {
      workspaceId: string;
      vorgangId: string;
      clientInvoiceId: string;
      invoice: ReturnType<typeof createAbschlagInvoice>;
    },
    label: string,
  ) => {
    const rpc = vi.fn();
    const outcome = await rpcFinalizeWorkspaceInvoice(input, { rpc } as never).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome, label).toBeInstanceOf(WorkspaceInvoiceCloudError);
    const failure = outcome as WorkspaceInvoiceCloudError;
    expect(failure.code, label).toBe('validation');
    expect(failure.retryable, label).toBe(false);
    expect(rpc, label).not.toHaveBeenCalled();
  };

  it('T1: nichtkanonische Eingabetexte werden vor dem RPC abgewiesen', async () => {
    const base = {
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      clientInvoiceId: 'inv-legacy-t1',
      invoice: invoice(),
    };
    const fields = ['workspaceId', 'vorgangId', 'clientInvoiceId'] as const;
    for (const field of fields) {
      const original = base[field];
      for (const padded of [` ${original}`, `${original} `, `\t${original}`, `${original}\n`]) {
        await expectRejectedBeforeRpc(
          { ...base, [field]: padded },
          `${field}:${JSON.stringify(padded)}`,
        );
      }
    }
  });

  it('T2: eine Kennungsabweichung im lokalen Beleg wird vor dem RPC abgewiesen', async () => {
    await expectRejectedBeforeRpc(
      {
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        clientInvoiceId: 'inv-legacy-t1',
        invoice: invoice({ id: 'inv-legacy-anders' }),
      },
      'invoice.id',
    );
  });
});

describe('01P4E1C1 — vollständige Legacy-Antwortzeile', () => {
  const invoice = () =>
    createAbschlagInvoice('op-test-1', 3, {
      id: 'inv-legacy-t3',
      number: '2026-0023',
      invoiceSequenceNumber: 23,
      status: 'vorbereitet',
    });

  const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const value = { ...(invoice() as unknown as Record<string, unknown>) };
    delete value.payments;
    delete value.paymentStatus;
    delete value.archiveDocumentId;
    return { ...value, ...overrides };
  };

  const envelope = (
    rowOverrides: Record<string, unknown> = {},
    payloadOverrides: Record<string, unknown> = {},
    options: { idempotentReplay?: boolean; rowPayload?: unknown } = {},
  ) => {
    const invoicePayload = payload(payloadOverrides);
    const row: Record<string, unknown> = {
      id: 'cloud-row-t3',
      workspace_id: 'ws-1',
      vorgang_id: 'v-test-1',
      client_invoice_id: 'inv-legacy-t3',
      invoice_number: '2026-0023',
      invoice_year: 2026,
      invoice_sequence_number: 23,
      invoice_type: 'abschlag',
      invoice_status: 'vorbereitet',
      payload: 'rowPayload' in options ? options.rowPayload : invoicePayload,
      row_version: 5,
      created_at: '2026-08-21T10:00:00.000Z',
      updated_at: '2026-08-21T10:00:00.000Z',
      updated_by: null,
    };
    for (const [key, value] of Object.entries(rowOverrides)) {
      if (value === undefined) delete row[key];
      else row[key] = value;
    }
    return {
      idempotent_replay: options.idempotentReplay ?? false,
      invoice: invoicePayload,
      row,
    };
  };

  const finalize = (data: unknown) =>
    rpcFinalizeWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        clientInvoiceId: 'inv-legacy-t3',
        invoice: invoice(),
      },
      { rpc: async () => ({ data, error: null }) } as never,
    );

  const expectUnknown = async (data: unknown, label: string) => {
    const outcome = await finalize(data).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome, label).toBeInstanceOf(WorkspaceInvoiceCloudError);
    expect((outcome as WorkspaceInvoiceCloudError).code, label).toBe('unknown');
  };

  it('T3: eine unvollständige oder ungültige Antwortzeile wird abgewiesen', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['invoice_year fehlt', { invoice_year: undefined }],
      ['invoice_year ungültig', { invoice_year: 1999 }],
      ['invoice_year kein Integer', { invoice_year: 2026.5 }],
      ['invoice_sequence_number fehlt', { invoice_sequence_number: undefined }],
      ['invoice_sequence_number String', { invoice_sequence_number: '23' }],
      ['invoice_sequence_number 0', { invoice_sequence_number: 0 }],
      ['invoice_sequence_number Bruch', { invoice_sequence_number: 23.5 }],
      ['invoice_number fehlt', { invoice_number: undefined }],
      ['invoice_type fehlt', { invoice_type: undefined }],
      ['invoice_status fehlt', { invoice_status: undefined }],
      ['row.payload fehlt', { payload: undefined }],
      ['row.payload Array', { payload: [] }],
      ['row.payload String', { payload: 'nope' }],
    ];

    const mapperSpy = vi.spyOn(workspaceInvoiceCloud, 'mapWorkspaceInvoicePullRowToVorgangInvoice');
    for (const [label, rowOverrides] of cases) {
      await expectUnknown(envelope(rowOverrides), label);
    }
    expect(mapperSpy).not.toHaveBeenCalled();
    mapperSpy.mockRestore();
  });

  it('T4a: der frische Legacy-RPC verlangt eine gültige invoiceSequenceNumber', async () => {
    await expectUnknown(envelope({}, { invoiceSequenceNumber: undefined }), 'fehlt');
    await expectUnknown(envelope({}, { invoiceSequenceNumber: 99 }), 'abweichend');
  });

  it('T4b: der normale Pull bleibt ohne invoiceSequenceNumber gültig', () => {
    const base = cloudRow();
    const legacyPayload = { ...(base.payload as Record<string, unknown>) };
    delete legacyPayload.invoiceSequenceNumber;
    const parsed = parseWorkspaceInvoicePullRow({ ...base, payload: legacyPayload });
    expect(parsed).not.toBeNull();
    // Die autoritative Zeilenspalte bleibt maßgeblich.
    expect(parsed!.invoice_sequence_number).toBe(1);
  });

  it('T5: row.payload wird strukturell verglichen, nicht textuell', async () => {
    const base = envelope();
    // Gleiche Inhalte, andere Schlüsselreihenfolge — bleibt gültig.
    const reordered = Object.fromEntries(
      Object.entries(base.invoice as Record<string, unknown>).reverse(),
    );
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(base.invoice));
    const ok = await finalize({ ...base, row: { ...base.row, payload: reordered } });
    expect(ok.invoice.id).toBe('inv-legacy-t3');

    // Inhaltliche Abweichung wird abgewiesen.
    await expectUnknown(
      { ...base, row: { ...base.row, payload: { ...payload(), amount: 999 } } },
      'amount',
    );
  });

  it('T6: der vollständige Gutfall bleibt exakt erhalten', async () => {
    const source = invoice();

    for (const idempotentReplay of [false, true]) {
      const result = await finalize(envelope({}, {}, { idempotentReplay }));
      expect(result.idempotentReplay).toBe(idempotentReplay);
      expect(result.cloudInvoiceId).toBe('cloud-row-t3');
      expect(result.rowVersion).toBe(5);
      expect(result.invoice.id).toBe('inv-legacy-t3');
      expect(result.invoice.number).toBe('2026-0023');
      expect(result.invoice.invoiceSequenceNumber).toBe(23);
      expect(result.invoice.amount).toBe(source.amount);
      expect(result.invoice.createdAt).toBe(source.createdAt);
      expect(result.invoice.date).toBe(source.date);
    }
  });
});

/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1E — der Prepared-RPC
 * erhält dieselbe strikte Antwortgrenze wie der gehärtete Legacy-Pfad.
 * Keine Coercion, keine Defaults, kein Teilergebnis.
 */
describe('01P4E1E — strikte Prepared-RPC-Hülle', () => {
  const CLIENT_ID = 'inv-prepared-e1';

  const preparedPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const invoice = createAbschlagInvoice('op-test-1', 3, {
      id: CLIENT_ID,
      number: '2026-0031',
      invoiceSequenceNumber: 31,
      status: 'vorbereitet',
    });
    const value = { ...(invoice as unknown as Record<string, unknown>) };
    delete value.payments;
    delete value.paymentStatus;
    delete value.archiveDocumentId;
    return { ...value, ...overrides };
  };

  const envelope = (
    rowOverrides: Record<string, unknown> = {},
    payloadOverrides: Record<string, unknown> = {},
    options: { idempotentReplay?: unknown; rowPayload?: unknown } = {},
  ) => {
    const invoicePayload = preparedPayload(payloadOverrides);
    const row: Record<string, unknown> = {
      id: 'cloud-row-e1',
      workspace_id: 'ws-1',
      vorgang_id: 'v-test-1',
      client_invoice_id: CLIENT_ID,
      invoice_number: '2026-0031',
      invoice_year: 2026,
      invoice_sequence_number: 31,
      invoice_type: 'abschlag',
      invoice_status: 'vorbereitet',
      payload: 'rowPayload' in options ? options.rowPayload : invoicePayload,
      row_version: 6,
      created_at: '2026-08-21T10:00:00.000Z',
      updated_at: '2026-08-21T10:00:00.000Z',
      updated_by: null,
    };
    for (const [key, value] of Object.entries(rowOverrides)) {
      if (value === undefined) delete row[key];
      else row[key] = value;
    }
    const data: Record<string, unknown> = { invoice: invoicePayload, row };
    if (!('idempotentReplay' in options)) data.idempotent_replay = false;
    else if (options.idempotentReplay !== undefined) {
      data.idempotent_replay = options.idempotentReplay;
    }
    return data;
  };

  const call = (data: unknown) =>
    rpcFinalizePreparedWorkspaceInvoice(
      {
        workspaceId: 'ws-1',
        vorgangId: 'v-test-1',
        clientInvoiceId: CLIENT_ID,
        invoicePayload: preparedPayload(),
      },
      { rpc: async () => ({ data, error: null }) } as never,
    );

  const expectUnknown = async (data: unknown, label: string) => {
    const outcome = await call(data).then(
      (value) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    expect(outcome.resolved, label).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error, label).toBeInstanceOf(WorkspaceInvoiceCloudError);
    expect((error as WorkspaceInvoiceCloudError).code, label).toBe('unknown');
    // Kein Teilergebnis: es existiert kein Rückgabewert.
    expect((outcome as { value?: unknown }).value, label).toBeUndefined();
  };

  it('E1: der vollständige Gutfall bleibt für beide Replay-Werte exakt erhalten', async () => {
    const expected = preparedPayload();
    for (const idempotentReplay of [false, true]) {
      const result = await call(envelope({}, {}, { idempotentReplay }));
      expect(result.idempotentReplay).toBe(idempotentReplay);
      expect(result.cloudInvoiceId).toBe('cloud-row-e1');
      expect(result.rowVersion).toBe(6);
      // Der Rohpayload wird weder gemappt noch normalisiert.
      expect(result.rawInvoicePayload).toEqual(expected);
      expect(result.rawInvoicePayload.amount).toBe(expected.amount);
      expect(result.rawInvoicePayload.date).toBe(expected.date);
      expect(result.rawInvoicePayload.number).toBe('2026-0031');
      expect(result.rawInvoicePayload.invoiceSequenceNumber).toBe(31);
    }
  });

  it('E2: idempotent_replay wird ausschließlich als echtes Boolean akzeptiert', async () => {
    const broken: unknown[] = [undefined, null, 0, 1, 'false', 'true', [], {}];
    for (const value of broken) {
      await expectUnknown(
        envelope({}, {}, { idempotentReplay: value }),
        JSON.stringify(value ?? 'fehlend'),
      );
    }
  });

  it('E3: eine unvollständige Antwortzeile wird abgewiesen', async () => {
    class FremdeZeile {
      id = 'cloud-row-e1';
    }
    const rowCases: Array<[string, unknown]> = [
      ['row fehlt', undefined],
      ['row null', null],
      ['row Array', []],
      ['row Klasseninstanz', new FremdeZeile()],
      ['row String', 'row'],
    ];
    for (const [label, value] of rowCases) {
      const data = envelope();
      if (value === undefined) delete data.row;
      else data.row = value;
      await expectUnknown(data, label);
    }

    const columnCases: Array<[string, Record<string, unknown>]> = [
      ['invoice_year fehlt', { invoice_year: undefined }],
      ['invoice_year ungültig', { invoice_year: 1999 }],
      ['invoice_year Bruch', { invoice_year: 2026.5 }],
      ['invoice_sequence_number fehlt', { invoice_sequence_number: undefined }],
      ['invoice_sequence_number String', { invoice_sequence_number: '31' }],
      ['invoice_sequence_number 0', { invoice_sequence_number: 0 }],
      ['invoice_sequence_number negativ', { invoice_sequence_number: -1 }],
      ['invoice_sequence_number Bruch', { invoice_sequence_number: 31.5 }],
      ['invoice_number fehlt', { invoice_number: undefined }],
      ['invoice_type fehlt', { invoice_type: undefined }],
      ['invoice_status fehlt', { invoice_status: undefined }],
      ['row.payload fehlt', { payload: undefined }],
      ['row.payload null', { payload: null }],
      ['row.payload Array', { payload: [] }],
      ['row.payload String', { payload: 'nope' }],
    ];
    for (const [label, rowOverrides] of columnCases) {
      await expectUnknown(envelope(rowOverrides), label);
    }
  });

  it('E4: row.id und row.row_version werden ohne Coercion geprüft', async () => {
    const idCases: unknown[] = [' cloud-row-e1', 'cloud-row-e1 ', '', '   ', 5, null, undefined];
    for (const value of idCases) {
      await expectUnknown(envelope({ id: value }), `id:${JSON.stringify(value ?? 'fehlend')}`);
    }

    const versionCases: unknown[] = [
      '2',
      null,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
    ];
    for (const value of versionCases) {
      await expectUnknown(envelope({ row_version: value }), `row_version:${String(value)}`);
    }
  });

  it('E5: row.payload wird unbedingt und strukturell verglichen', async () => {
    // Andere Schlüsselreihenfolge, gleicher Inhalt — bleibt gültig.
    const base = envelope();
    const reordered = Object.fromEntries(
      Object.entries(base.invoice as Record<string, unknown>).reverse(),
    );
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(base.invoice));
    const ok = await call({
      ...base,
      row: { ...(base.row as Record<string, unknown>), payload: reordered },
    });
    expect(ok.cloudInvoiceId).toBe('cloud-row-e1');

    // Inhaltliche Abweichung wird abgewiesen.
    await expectUnknown(
      envelope({}, {}, { rowPayload: preparedPayload({ amount: 999 }) }),
      'amount',
    );
    // Der Vergleich wird nie übersprungen.
    await expectUnknown(envelope({}, {}, { rowPayload: undefined }), 'fehlend');
    await expectUnknown(envelope({}, {}, { rowPayload: null }), 'null');
  });

  it('E6: Anfrage, Zeile und Payload werden exakt gebunden', async () => {
    const cases: Array<[string, unknown]> = [
      ['row.workspace_id', envelope({ workspace_id: 'ws-2' })],
      ['row.vorgang_id', envelope({ vorgang_id: 'v-test-2' })],
      ['row.client_invoice_id', envelope({ client_invoice_id: 'inv-fremd' })],
      ['payload.id', envelope({}, { id: 'inv-fremd' })],
      ['payload.number', envelope({ invoice_number: '2026-9999' })],
      ['payload.type', envelope({ invoice_type: 'rechnung' })],
      ['payload.status', envelope({ invoice_status: 'entwurf' })],
    ];
    for (const [label, data] of cases) {
      await expectUnknown(data, label);
    }
  });

  it('E7: die frische Sequenz im Antwortpayload ist Pflicht', async () => {
    await expectUnknown(envelope({}, { invoiceSequenceNumber: undefined }), 'fehlt');
    await expectUnknown(envelope({}, { invoiceSequenceNumber: 0 }), 'null');
    await expectUnknown(envelope({}, { invoiceSequenceNumber: 31.5 }), 'Bruch');
    await expectUnknown(envelope({ invoice_sequence_number: 99 }), 'abweichend');

    // Der normale Pull bleibt ohne dieses optionale Payload-Feld gültig.
    const base = cloudRow();
    const legacyPayload = { ...(base.payload as Record<string, unknown>) };
    delete legacyPayload.invoiceSequenceNumber;
    expect(parseWorkspaceInvoicePullRow({ ...base, payload: legacyPayload })).not.toBeNull();
  });
});
