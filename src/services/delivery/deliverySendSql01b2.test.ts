/**
 * EMAIL-01B2 — statische Grenzen der Send-Migration: Kopplungs-RPC nur
 * service_role, atomare Rechnungsübernahme, monotone Regel (manual → officepilot
 * mit Bewahrung, erste erfolgreiche Delivery bleibt), Korrekturbeleg ohne
 * Original-Mutation. Laufzeit: `tests/e2e/localdbSendDocument01b2.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260915120000_workspace_document_delivery_send.sql'), 'utf8');
const fnText = readFileSync(resolve(process.cwd(), 'supabase/functions/send-document/index.ts'), 'utf8');

function fn(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} fehlt`).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf('$$;', sql.indexOf('as $$', start)));
}

describe('EMAIL-01B2 — mark_workspace_document_delivery_accepted', () => {
  const accept = fn('mark_workspace_document_delivery_accepted');

  it('S1: nur service_role; Statusübergang und Provider-ID-Konflikt geprüft; kein Zurück von angenommenen Zuständen', () => {
    const sig = 'public.mark_workspace_document_delivery_accepted(uuid, text, bigint)';
    expect(sql).toContain(`revoke all on function ${sig} from authenticated`);
    expect(sql).toContain(`grant execute on function ${sig} to service_role`);
    expect(accept).toContain("document_delivery_transition_allowed(v_delivery.status, 'provider_accepted')");
    expect(accept).toContain("raise exception 'Delivery bereits mit anderer provider_message_id angenommen'");
    expect(accept).toContain("status not in ('provider_accepted', 'delivered', 'bounced', 'complained')");
  });

  it('S2: atomare Rechnungs-Kopplung in derselben Funktion — versendet, email, officepilot, delivery, Payload-Spiegel', () => {
    expect(accept).toContain("if v_delivery.document_kind = 'invoice' then");
    expect(accept).toContain("invoice_status = 'versendet'");
    expect(accept).toContain("sent_source = 'officepilot'");
    expect(accept).toContain('sent_delivery_id = v_delivery.id');
    expect(accept).toContain("'sentVia', 'email'");
    expect(accept).toContain("'sentSource', 'officepilot'");
    expect(accept).toContain("'sentDeliveryId', v_delivery.id::text");
    expect(accept).toContain("raise exception 'Sent-Kopplung Nachbedingung verletzt: invoice_status'");
  });

  it('S3: monotone Regel — manual wird bewahrt (sentManualPrior), erste erfolgreiche Delivery bleibt Referenz, Korrektur rührt das Original nicht an', () => {
    expect(accept).toContain("v_coupling := 'upgraded_from_manual'");
    expect(accept).toContain("'sentManualPrior', v_prior");
    expect(accept).toContain("v_coupling := 'kept_existing'");
    expect(accept).toContain("v_coupling := 'already_linked'");
    // Kopplungsblock ist ausschliesslich für document_kind = 'invoice'.
    expect(accept).not.toContain("document_kind = 'invoice_correction' then\n    update");
  });
});

describe('EMAIL-01B2 — Server-Lesepfad und Berechtigung', () => {
  it('S4: get_…_for_send liefert Snapshot für Absender/Reply-To und ist service_role-only; Schreibrecht wird für den Aufrufer geprüft', () => {
    const read = fn('get_workspace_document_delivery_for_send');
    expect(read).toContain("'company_snapshot', v_invoice.payload->'companySnapshot'");
    expect(sql).toContain('revoke all on function public.get_workspace_document_delivery_for_send(uuid, text) from authenticated');
    const write = fn('workspace_user_can_write');
    expect(write).toContain("wm.role in ('owner', 'admin')");
    expect(sql).toContain('grant execute on function public.workspace_user_can_write(uuid, uuid) to service_role');
  });
});

describe('EMAIL-01B2 — Edge Function Sicherheitsgrenzen (statisch)', () => {
  it('S5: Secrets nur aus Deno.env, Providerwahl fail-closed, Client setzt keine Fakten, Logs ohne Inhalte', () => {
    expect(fnText).toContain("Deno.env.get('BREVO_API_KEY')");
    expect(fnText).toContain("resolveMailProviderName(Deno.env.get('MAIL_PROVIDER'))");
    expect(fnText).toContain("fail('server_misconfigured')");
    expect(fnText).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(fnText).toContain("admin.rpc('mark_workspace_document_delivery_accepted'");
    expect(fnText).toContain("admin.rpc('update_workspace_document_delivery_status'");
    expect(fnText).toContain("admin.rpc('workspace_user_can_write'");
    expect(fnText).not.toMatch(/console\.log\([^)]*(apiKey|BREVO|body_text|recipient_email|contentBase64)/);
    expect(fnText).not.toContain('brevoApiKey: "');
  });
});
