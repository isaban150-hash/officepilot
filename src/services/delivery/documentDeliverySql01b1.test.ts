/**
 * EMAIL-01B1 — statische Sicherheitsgrenzen der Delivery-Migration (wie bei
 * den Invoice-RPC-Tests). Das Laufzeitverhalten prüft
 * `tests/e2e/localdbDocumentDeliverySql01b1.spec.ts` gegen die lokale DB.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260914120000_workspace_document_deliveries.sql'),
  'utf8',
);

function fn(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} fehlt`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$$;', sql.indexOf('as $$', start));
  return sql.slice(start, end);
}

describe('EMAIL-01B1 — Tabelle und Constraints', () => {
  it('T1: Idempotenz, Status-, Provider-, Kind-, Fehler- und Anhangsgrenzen sind Constraints', () => {
    expect(sql).toContain('unique (workspace_id, client_delivery_id)');
    expect(sql).toContain("document_kind in ('invoice', 'invoice_correction', 'letter', 'offer', 'other')");
    expect(sql).toContain("'prepared', 'queued', 'provider_accepted', 'failed', 'unknown'");
    expect(sql).toContain("'delivered', 'bounced', 'complained', 'rejected'");
    expect(sql).toContain("provider in ('brevo', 'stub')");
    expect(sql).toContain("error_category in ('auth', 'recipient', 'provider', 'attachment', 'network', 'unknown')");
    expect(sql).toContain("position(workspace_id::text || '/' in attachment_storage_path) = 1");
    expect(sql).toContain("attachment_sha256 ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("attachment_mime_type = 'application/pdf'");
    expect(sql).toContain('attempt_number >= 1');
    // Kein PDF-Blob, keine Provider-Rohantwort in der Zeile.
    expect(sql).not.toMatch(/attachment_bytes|provider_response|raw_response/);
  });

  it('T2: RLS nur lesend für Mitglieder; kein Client-Insert/-Update/-Delete', () => {
    expect(sql).toContain('alter table public.workspace_document_deliveries enable row level security');
    expect(sql).toContain('workspace_document_deliveries_select_member');
    expect(sql).not.toMatch(/on public\.workspace_document_deliveries for (insert|update|delete)/);
  });

  it('T3: Storage-Bucket privat, nur PDF, Pfadregel mit Hash, keine Delete-/Update-Policy (Retention)', () => {
    expect(sql).toContain("values ('document-deliveries', 'document-deliveries', false, 10485760, array['application/pdf'])");
    expect(fn('document_delivery_attachment_workspace_id')).toContain('[0-9a-f]{64}\\.pdf$');
    expect(sql).toContain('document_deliveries_select_member');
    expect(sql).toContain('document_deliveries_insert_writer');
    expect(sql).not.toMatch(/document_deliveries_(delete|update)/);
  });
});

describe('EMAIL-01B1 — Statusmaschine in SQL', () => {
  it('T4: provider_accepted kehrt nie zurück; Webhook-Zustände hängen an provider_accepted', () => {
    const body = fn('document_delivery_transition_allowed');
    expect(body).toContain("when p_from = 'queued' then p_to in ('provider_accepted', 'failed', 'rejected', 'unknown')");
    expect(body).toContain("when p_from = 'provider_accepted' then p_to in ('delivered', 'bounced', 'complained')");
    expect(body).toContain("when p_from = 'unknown' then p_to in ('provider_accepted', 'failed')");
    expect(body).not.toContain("'provider_accepted' then p_to in ('queued'");
  });
});

describe('EMAIL-01B1 — Create-RPC', () => {
  const create = fn('create_workspace_document_delivery');

  it('T5: security definer, Auth, Mitgliedschaft, Schreibrecht (owner/admin)', () => {
    expect(create).toContain('security definer');
    expect(create).toContain('set search_path = public');
    expect(create).toContain("raise exception 'Nicht angemeldet'");
    expect(create).toContain('public.is_active_workspace_member(p_workspace_id)');
    expect(create).toContain('public.can_write_workspace(p_workspace_id)');
    expect(create).toContain("raise exception 'Keine Schreibberechtigung'");
  });

  it('T6: Dokumentidentität über workspace_id + client_invoice_id; finalisiert; Storno/Korrektur-Regeln', () => {
    expect(create).toContain('client_invoice_id = v_linked_invoice_id');
    expect(create).not.toContain('vorgang_id =');
    expect(create).toContain("invoice_status not in ('vorbereitet', 'versendet')");
    expect(create).toContain("v_document_kind = 'invoice' and v_invoice.cancelled_at is not null");
    expect(create).toContain("cancellation_kind is distinct from 'correction'");
  });

  it('T7: Idempotenz-Replay vs. Konflikt vergleicht Dokument, Empfänger, Betreff, Text, Anhang-Hash', () => {
    expect(create).toContain('for update');
    expect(create).toContain("'outcome', 'replayed'");
    expect(create).toContain("raise exception 'Idempotenzkonflikt");
    for (const field of ['document_kind <> v_document_kind', 'linked_invoice_id is distinct from v_linked_invoice_id', 'recipient_email <> v_recipient', 'subject <> v_subject', 'body_text <> v_body', 'attachment_sha256 is distinct from v_sha']) {
      expect(create, field).toContain(field);
    }
  });

  it('T8: Anhang wird gegen Workspace, Hash-Pfad, Größe und PDF geprüft; Retry nur nach Fehlschlag', () => {
    expect(create).toContain('public.document_delivery_attachment_workspace_id(v_path) is distinct from p_workspace_id');
    expect(create).toContain("split_part(v_path, '/', 3) <> v_sha || '.pdf'");
    expect(create).toContain('p_attachment_size_bytes > 10485760');
    expect(create).toContain("v_mime <> 'application/pdf'");
    // V1-B1: Erstfassung erlaubte Retry aus unknown; die Guard-Migration ersetzt die Funktion (siehe deliveryRetryUnknownGuard01.test).
    expect(create).toContain("v_retry_of.status not in ('failed', 'rejected', 'unknown', 'bounced')");
    expect(create).toContain('v_attempt := v_retry_of.attempt_number + 1');
  });

  it('T9: kein Provider-Aufruf, Status queued, keine Rechnungsmutation', () => {
    expect(create).not.toMatch(/http|pg_net|net\.http|api\.brevo|curl/i);
    expect(create).toContain("v_provider, 'queued', v_user_id");
    expect(create).not.toContain('update public.workspace_invoices');
  });

  it('T10: Rechte nach bestehendem Muster; Status-Update nur service_role', () => {
    const sig = 'public.create_workspace_document_delivery(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text)';
    expect(sql).toContain(`revoke all on function ${sig} from public`);
    expect(sql).toContain(`grant execute on function ${sig} to authenticated`);
    const upd = 'public.update_workspace_document_delivery_status(uuid, text, text, text, text, text, bigint)';
    expect(sql).toContain(`revoke all on function ${upd} from authenticated`);
    expect(sql).toContain(`grant execute on function ${upd} to service_role`);
  });
});

describe('EMAIL-01B1 — Read-RPC und Sent-Kopplung', () => {
  it('T11: Historie workspace-isoliert, neueste zuerst', () => {
    const list = fn('list_workspace_document_deliveries');
    expect(list).toContain('public.is_active_workspace_member(p_workspace_id)');
    expect(list).toContain('d.workspace_id = p_workspace_id');
    expect(list).toContain('order by d.requested_at desc');
  });

  it('T12: Rechnung trägt sent_source/sent_delivery_id; manuelles Markieren setzt manual und stuft officepilot nicht zurück', () => {
    expect(sql).toContain("sent_source in ('manual', 'officepilot')");
    expect(sql).toContain('add column if not exists sent_delivery_id uuid null references public.workspace_document_deliveries (id)');
    const sent = fn('update_workspace_invoice_sent');
    expect(sent).toContain("v_sent_source := coalesce(v_existing.sent_source, 'manual')");
    expect(sent).toContain("'sentSource', v_sent_source");
    // Hardening-Nachbedingungen bleiben.
    expect(sent).toContain('returning * into v_updated');
    expect(sent).toContain("raise exception 'Sent-Update Nachbedingung verletzt: payload.sentVia'");
  });
});
