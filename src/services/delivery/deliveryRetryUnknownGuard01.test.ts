/**
 * V1-B1 (Final Server-Safety) — Retry nie aus `unknown`, serverseitig.
 *
 *  A/B/C  retry_of failed/rejected/bounced bleibt erlaubt
 *  D      retry_of unknown wird mit definiertem Contract-Fehler abgelehnt
 *  E/F    Rechnungs-/Korrekturregeln, Idempotenz und Anhangspruefung der
 *         Funktion sind gegenueber der Erstfassung unveraendert (Textvergleich)
 *  M      der Client bildet den Fehler auf `uncertain_pending` ab — nie roh
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { rpcCreateWorkspaceDocumentDelivery, type CreateDocumentDeliveryInput } from './documentDeliveryCloudService';

const original = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260914120000_workspace_document_deliveries.sql'), 'utf8');
const guard = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260921120000_workspace_document_delivery_retry_unknown_guard.sql'), 'utf8');

function functionBody(sql: string): string {
  const start = sql.indexOf('create or replace function public.create_workspace_document_delivery(');
  const end = sql.indexOf('\n$$;', start);
  return sql.slice(start, end);
}

function retryBlock(body: string): string {
  const start = body.indexOf('-- Bewusster Retry');
  const end = body.indexOf('insert into public.workspace_document_deliveries', start);
  return body.slice(start, end);
}

describe('V1-B1 — Server-Guard: create_workspace_document_delivery', () => {
  const originalBody = functionBody(original);
  const guardBody = functionBody(guard);

  it('D: retry_of unknown wird vor der Fehlschlag-Pruefung mit definiertem Fehler abgelehnt', () => {
    const block = retryBlock(guardBody);
    expect(block).toContain("if v_retry_of.status = 'unknown' then");
    expect(block).toContain("raise exception 'Erneuter Versand nicht moeglich: Versandstatus unklar'");
    expect(block.indexOf("v_retry_of.status = 'unknown'")).toBeLessThan(block.indexOf("v_retry_of.status not in"));
  });

  it('A/B/C: failed, rejected und bounced bleiben die einzigen erlaubten Retry-Quellen', () => {
    const block = retryBlock(guardBody);
    expect(block).toContain("v_retry_of.status not in ('failed', 'rejected', 'bounced')");
    expect(block).not.toContain("'unknown', 'bounced'");
    expect(block).toContain('v_attempt := v_retry_of.attempt_number + 1');
    expect(block).toContain("raise exception 'retry_of_delivery_id gehoert zu einem anderen Dokument'");
  });

  it('E/F: alles ausser dem Retry-Block ist identisch zur Erstfassung (Signatur, Rechte, Rechnung/Korrektur, Idempotenz, Anhang, Insert)', () => {
    const strip = (body: string) => body.replace(retryBlock(body), '<RETRY>');
    expect(strip(guardBody)).toBe(strip(originalBody));
    // Stichproben der unveraenderten Fachregeln
    expect(guardBody).toContain("if v_document_kind = 'invoice' and v_invoice.cancelled_at is not null then");
    expect(guardBody).toContain("if v_document_kind = 'invoice_correction'");
    expect(guardBody).toContain("raise exception 'Idempotenzkonflikt: client_delivery_id mit abweichendem Inhalt'");
    expect(guardBody).toContain("split_part(v_path, '/', 3) <> v_sha || '.pdf'");
  });

  it('Migration ist additiv: nur create or replace der Funktion, keine Tabellen-/Policy-Aenderung', () => {
    expect((guard.match(/create or replace function/g) ?? []).length).toBe(1);
    expect(guard).not.toMatch(/alter table|create table|create policy|drop /i);
  });

  it('M: Client bildet den Server-Fehler auf uncertain_pending ab; Rohtext bleibt nur als message', async () => {
    const input: CreateDocumentDeliveryInput = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      clientDeliveryId: 'cd-retry',
      identity: { kind: 'invoice', clientInvoiceId: 'inv-1' },
      recipientEmail: 'kunde@example.invalid',
      subject: 'S',
      bodyText: 'B',
      attachment: { storagePath: 'p', sha256: 'a'.repeat(64), sizeBytes: 10, filename: 'r.pdf' },
      provider: 'stub',
      retryOfDeliveryId: 'd-unknown',
    } as CreateDocumentDeliveryInput;
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: 'Erneuter Versand nicht moeglich: Versandstatus unklar' } })) } as never;
    const result = await rpcCreateWorkspaceDocumentDelivery(input, client);
    expect(result).toMatchObject({ ok: false, error: 'uncertain_pending' });
  });
});
