import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { VorgangInvoice } from '../../types/models';
import { createSupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import { formatInvoiceNumber, reserveNextInvoiceNumber } from '../invoiceNumberService';
import { resetTestStores } from '../../test/resetStores';
import {
  buildWorkspaceInvoiceFinalizeInput,
  buildWorkspaceInvoiceFinalizePayload,
  formatWorkspaceInvoiceNumber,
  mapCloudPayloadToVorgangInvoice,
  rpcFinalizeWorkspaceInvoice,
  WorkspaceInvoiceCloudError,
} from './workspaceInvoiceCloudService';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250723120000_workspace_invoice_cloud_foundation.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

function sampleInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-client-1',
    number: 'ENTWURF',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Fliesen',
        quantity: 3,
        unit: 'm²',
        unitPrice: 45,
        lineTotal: 135,
      },
    ],
    subtotal: 135,
    taxStatus: 'standard_19',
    amount: 160.65,
    status: 'vorbereitet',
    date: '2026-07-23',
    createdAt: '2026-07-23T10:00:00.000Z',
    issueDate: '2026-07-23',
    customerSnapshot: {
      name: 'Kunde',
      contactPerson: '',
      street: 'A',
      zip: '1',
      city: 'B',
      email: '',
      phone: '',
    },
    payments: [
      {
        id: 'pay-1',
        date: '2026-07-23',
        amount: 10,
        createdAt: '2026-07-23T11:00:00.000Z',
      },
    ],
    paymentStatus: 'teilbezahlt',
    archiveDocumentId: 'doc-archive-1',
    ...overrides,
  };
}

describe('CLOUD-ORDER-CHAIN-03A migration', () => {
  it('legt Sequenz- und Invoice-Tabellen mit Unique Constraints an', () => {
    expect(sql).toContain('create table if not exists public.workspace_invoice_sequences');
    expect(sql).toContain('create table if not exists public.workspace_invoices');
    expect(sql).toContain('primary key (workspace_id, invoice_year)');
    expect(sql).toContain('constraint workspace_invoices_number_unique unique (workspace_id, invoice_number)');
    expect(sql).toContain(
      'constraint workspace_invoices_client_id_unique unique (workspace_id, client_invoice_id)',
    );
    expect(sql).toContain('payload jsonb not null');
  });

  it('definiert atomare finalize_workspace_invoice RPC', () => {
    expect(sql).toContain('finalize_workspace_invoice');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public');
    expect(sql).toContain('is_active_workspace_member');
    expect(sql).toContain('for update');
    expect(sql).toContain('idempotent_replay');
    expect(sql).toContain('Idempotenzkonflikt');
    expect(sql).toContain('format_workspace_invoice_number');
  });

  it('erlaubt keine direkten Writes / Deletes für Clients', () => {
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('workspace_invoices_select_member');
    expect(sql).toContain('grant select on public.workspace_invoices to authenticated');
    expect(sql).not.toMatch(/grant\s+insert\s+on\s+public\.workspace_invoices/i);
    expect(sql).not.toMatch(/grant\s+update\s+on\s+public\.workspace_invoices/i);
    expect(sql).not.toMatch(/grant\s+delete\s+on\s+public\.workspace_invoices/i);
    expect(sql).toContain(
      'grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb) to authenticated',
    );
  });

  it('nummer und insert liegen in einer Funktion (keine separate Reserve-RPC)', () => {
    expect(sql).toContain('last_sequence');
    expect(sql).not.toContain('reserve_workspace_invoice_number');
    expect(sql).toContain('insert into public.workspace_invoices');
    expect(sql).toContain('update public.workspace_invoice_sequences');
  });
});

describe('CLOUD-ORDER-CHAIN-03A TypeScript binding', () => {
  it('baut RPC-Payload aus VorgangInvoice ohne Payments/PDF/Archiv', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(sampleInvoice());
    expect(payload.id).toBe('inv-client-1');
    expect(payload.positions).toHaveLength(1);
    expect(payload.payments).toBeUndefined();
    expect(payload.paymentStatus).toBeUndefined();
    expect(payload.archiveDocumentId).toBeUndefined();
    expect((payload.positions as { lineTotal: number }[])[0]?.lineTotal).toBe(135);
  });

  it('mappt Cloud-Response zurück auf VorgangInvoice', () => {
    const mapped = mapCloudPayloadToVorgangInvoice({
      id: 'inv-client-1',
      number: '2026-0007',
      type: 'abschlag',
      abschlagNumber: 1,
      invoiceSequenceNumber: 7,
      positions: sampleInvoice().positions,
      subtotal: 135,
      taxStatus: 'standard_19',
      amount: 160.65,
      status: 'vorbereitet',
      date: '2026-07-23',
      createdAt: '2026-07-23T10:00:00.000Z',
      payments: [{ id: 'should-ignore' }],
      archiveDocumentId: 'should-ignore',
    });

    expect(mapped.number).toBe('2026-0007');
    expect(mapped.invoiceSequenceNumber).toBe(7);
    expect(mapped.positions).toHaveLength(1);
    expect(mapped.payments).toBeUndefined();
    expect(mapped.archiveDocumentId).toBeUndefined();
  });

  it('formatWorkspaceInvoiceNumber entspricht lokalem Format', () => {
    expect(formatWorkspaceInvoiceNumber(2026, 1)).toBe(formatInvoiceNumber(2026, 1));
    expect(formatWorkspaceInvoiceNumber(2026, 12)).toBe('2026-0012');
  });

  it('rpcFinalizeWorkspaceInvoice mappt Erfolg und Idempotenz', async () => {
    const invoice = sampleInvoice();
    const rpc = vi.fn().mockResolvedValue({
      data: {
        idempotent_replay: true,
        invoice: {
          ...buildWorkspaceInvoiceFinalizePayload(invoice),
          number: '2026-0003',
          invoiceSequenceNumber: 3,
          status: 'vorbereitet',
        },
        row: {
          id: 'cloud-row-1',
          workspace_id: 'ws-1',
          vorgang_id: 'v-1',
          client_invoice_id: 'inv-client-1',
          invoice_number: '2026-0003',
          invoice_year: 2026,
          invoice_sequence_number: 3,
          invoice_type: 'abschlag',
          invoice_status: 'vorbereitet',
          payload: {},
          row_version: 1,
          created_at: '2026-07-23T10:00:00.000Z',
          updated_at: '2026-07-23T10:00:00.000Z',
          updated_by: null,
        },
      },
      error: null,
    });

    const result = await rpcFinalizeWorkspaceInvoice(
      buildWorkspaceInvoiceFinalizeInput('ws-1', 'v-1', invoice),
      { rpc } as never,
    );

    expect(rpc).toHaveBeenCalledWith('finalize_workspace_invoice', {
      p_workspace_id: 'ws-1',
      p_vorgang_id: 'v-1',
      p_client_invoice_id: 'inv-client-1',
      p_invoice: expect.objectContaining({
        id: 'inv-client-1',
        positions: expect.any(Array),
      }),
    });
    expect(result.idempotentReplay).toBe(true);
    expect(result.invoice.number).toBe('2026-0003');
    expect(result.cloudInvoiceId).toBe('cloud-row-1');
  });

  it('rpcFinalizeWorkspaceInvoice mappt Idempotenzkonflikt', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id' },
    });

    await expect(
      rpcFinalizeWorkspaceInvoice(
        buildWorkspaceInvoiceFinalizeInput('ws-1', 'v-1', sampleInvoice()),
        { rpc } as never,
      ),
    ).rejects.toMatchObject({
      name: 'WorkspaceInvoiceCloudError',
      code: 'idempotency_conflict',
    } satisfies Partial<WorkspaceInvoiceCloudError>);
  });

  it('lokaler Nummernkreis und Finalize-Flow bleiben unverändert nutzbar', () => {
    resetTestStores();
    const reserved = reserveNextInvoiceNumber();
    expect(reserved.formatted).toMatch(/^\d{4}-\d{4}$/);
    expect(reserved.sequenceNumber).toBeGreaterThan(0);
  });

  it('SupabaseSyncAdapter.reserveInvoiceNumber bleibt sicher abgelehnt', async () => {
    const adapter = createSupabaseSyncAdapter(null);
    await expect(adapter.reserveInvoiceNumber('ws-1')).rejects.toThrow(
      /finalize_workspace_invoice|nicht getrennt reserviert/i,
    );
  });
});
