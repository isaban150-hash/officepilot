import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration01b1 = resolve(
  process.cwd(),
  'supabase/migrations/20250724150000_workspace_order_amendment_cloud_foundation.sql',
);
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

function readSql(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const sql = readSql(migration01b1);
const sql03a = readSql(migration03a);
const sql03b1 = readSql(migration03b1);
const sql03b2 = readSql(migration03b2);

function functionBody(source: string, name: string): string {
  const marker = `create or replace function public.${name}`;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const after = source.slice(start);
  const end = after.indexOf('$$;');
  expect(end).toBeGreaterThan(0);
  return after.slice(0, end);
}

describe('ORDER-AMENDMENT-01B1 migration isolation', () => {
  it('ändert keine bereits angewendeten Invoice-Migrationen', () => {
    expect(sql03a).toContain('finalize_workspace_invoice');
    expect(sql03a).not.toContain('workspace_order_amendments');
    expect(sql03a).not.toContain('expectedAmendmentSequence');
    expect(sql03b1).toContain('Vorgang gehört nicht zum Workspace');
    expect(sql03b1).not.toContain('workspace_order_amendments');
    expect(sql03b1).not.toContain('invoice_amendment_state_stale');
    expect(sql03b2).toContain('pull_workspace_invoices');
    expect(sql03b2).not.toContain('workspace_order_amendments');
  });

  it('liefert Foundation in einer neuen Folgemigration', () => {
    expect(sql).toContain('create table if not exists public.workspace_order_amendments');
    expect(sql).toContain('create or replace function public.confirm_workspace_order_amendment');
    expect(sql).toContain('create or replace function public.pull_workspace_order_amendments');
    expect(sql).toContain('create or replace function public.finalize_workspace_invoice');
  });
});

describe('ORDER-AMENDMENT-01B1 table + RLS', () => {
  it('definiert Tabelle mit erforderlichen Spalten und Constraints', () => {
    expect(sql).toContain('client_amendment_id text not null');
    expect(sql).toContain('sequence_no integer not null');
    expect(sql).toContain('content_fingerprint text not null');
    expect(sql).toContain('confirmed_at timestamptz not null');
    expect(sql).toContain('confirmed_by uuid not null');
    expect(sql).toContain('row_version bigint not null default 1');
    expect(sql).toContain("constraint workspace_order_amendments_status_check check (status = 'bestaetigt')");
    expect(sql).toContain('constraint workspace_order_amendments_sequence_positive check (sequence_no > 0)');
    expect(sql).toContain(
      "constraint workspace_order_amendments_payload_object_check check (jsonb_typeof(payload) = 'object')",
    );
    expect(sql).toContain(
      'constraint workspace_order_amendments_client_id_unique unique (workspace_id, client_amendment_id)',
    );
    expect(sql).toContain(
      'constraint workspace_order_amendments_sequence_unique unique (workspace_id, vorgang_id, sequence_no)',
    );
    expect(sql).toContain('constraint workspace_order_amendments_vorgang_fk');
    expect(sql).toContain('references public.workspace_vorgaenge (workspace_id, vorgang_id)');
    expect(sql).toContain('workspace_order_amendments_workspace_vorgang_idx');
    expect(sql).toContain('workspace_order_amendments_workspace_vorgang_sequence_idx');
  });

  it('aktiviert RLS und verhindert breite direkte Schreibrechte', () => {
    expect(sql).toContain('alter table public.workspace_order_amendments enable row level security');
    expect(sql).toContain('workspace_order_amendments_select_member');
    expect(sql).toContain('grant select on public.workspace_order_amendments to authenticated');
    expect(sql).not.toMatch(/grant\s+insert\s+on\s+public\.workspace_order_amendments/i);
    expect(sql).not.toMatch(/grant\s+update\s+on\s+public\.workspace_order_amendments/i);
    expect(sql).not.toMatch(/grant\s+delete\s+on\s+public\.workspace_order_amendments/i);
    expect(sql).toContain('prevent_workspace_order_amendment_mutation');
    expect(sql).toContain('workspace_order_amendments are write-once');
    expect(sql).toContain('before update or delete on public.workspace_order_amendments');
  });
});

describe('ORDER-AMENDMENT-01B1 confirm_workspace_order_amendment', () => {
  const confirm = functionBody(sql, 'confirm_workspace_order_amendment');

  it('ist Security Definer mit sicherem search_path', () => {
    expect(confirm).toContain('security definer');
    expect(confirm).toContain('set search_path = public');
    expect(sql).toContain(
      'grant execute on function public.confirm_workspace_order_amendment(uuid, text, text, jsonb) to authenticated',
    );
  });

  it('prüft Auth, Membership und sperrt zuerst workspace_vorgaenge', () => {
    expect(confirm).toContain('Nicht angemeldet');
    expect(confirm).toContain('is_active_workspace_member');
    expect(confirm).toContain('Kein Zugriff auf Workspace');
    expect(confirm).toContain('order_amendment_vorgang_not_found');
    expect(confirm).toMatch(
      /from public\.workspace_vorgaenge[\s\S]*?for update/,
    );
    const vorgangLockAt = confirm.search(/from public\.workspace_vorgaenge[\s\S]*?for update/);
    const amendmentLockAt = confirm.search(
      /from public\.workspace_order_amendments[\s\S]*?for update/,
    );
    expect(vorgangLockAt).toBeGreaterThanOrEqual(0);
    expect(amendmentLockAt).toBeGreaterThan(vorgangLockAt);
  });

  it('fordert Hauptsnapshot und blockiert finale Schlussrechnung nach Idempotenz', () => {
    expect(confirm).toContain("payload->'contractConfirmation'");
    expect(confirm).toContain('order_amendment_contract_confirmation_missing');
    expect(confirm).toContain('order_amendment_idempotency_conflict');
    expect(confirm).toContain('order_amendment_final_invoice_exists');
    expect(confirm).toContain("invoice_type = 'schluss'");
    expect(confirm).toContain("invoice_status in ('vorbereitet', 'versendet')");

    const idempotencyAt = confirm.indexOf('order_amendment_idempotency_conflict');
    const schlussAt = confirm.indexOf('order_amendment_final_invoice_exists');
    expect(idempotencyAt).toBeGreaterThanOrEqual(0);
    expect(schlussAt).toBeGreaterThan(idempotencyAt);
  });

  it('validiert Positionen gemäß 01A-Grenzen', () => {
    expect(confirm).toContain("'add'");
    expect(confirm).toContain("'quantity_increase'");
    expect(confirm).toContain('order_amendment_invalid_position');
    expect(confirm).toContain('order_amendment_parent_position_not_found');
    expect(confirm).toContain('order_amendment_position_id_conflict');
    expect(confirm).toContain('plannedQuantity');
    expect(confirm).toContain('unitPrice');
    expect(confirm).toContain("array['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal']");
    expect(confirm).toContain('NOT required to match parent');
  });

  it('vergibt sequence_no serverseitig und setzt confirmed_at/confirmed_by vom Server', () => {
    expect(confirm).toContain('coalesce(max(a.sequence_no), 0) + 1');
    expect(confirm).toContain("timezone('utc', now())");
    expect(confirm).toContain('v_user_id');
    expect(confirm).toContain("status");
    expect(confirm).toContain("'bestaetigt'");
    expect(confirm).toContain('content_fingerprint');
    expect(confirm).toContain('idempotent_replay');
  });

  it('nutzt serverseitigen kanonischen Fingerprint ohne Positions-Sortierung nach ID', () => {
    expect(sql).toContain('build_workspace_order_amendment_canonical_content');
    expect(sql).toContain('fingerprint_workspace_order_amendment_canonical');
    expect(confirm).toContain('fingerprint_workspace_order_amendment_canonical');
    expect(confirm).not.toContain('order by pos');
    expect(confirm).not.toContain('order by p.id');
  });
});

describe('ORDER-AMENDMENT-01B1 pull_workspace_order_amendments', () => {
  const pull = functionBody(sql, 'pull_workspace_order_amendments');

  it('prüft Auth/Membership, filtert Workspace und sortiert stabil', () => {
    expect(pull).toContain('security definer');
    expect(pull).toContain('set search_path = public');
    expect(pull).toContain('Nicht angemeldet');
    expect(pull).toContain('is_active_workspace_member');
    expect(pull).toContain('a.workspace_id = p_workspace_id');
    expect(pull).toContain("a.status = 'bestaetigt'");
    expect(pull).toContain('p_since');
    expect(pull).toContain('order by a.vorgang_id asc, a.sequence_no asc, a.client_amendment_id asc');
    expect(pull).toContain('content_fingerprint');
    expect(pull).toContain('confirmed_at');
    expect(pull).toContain('confirmed_by');
    expect(sql).toContain(
      'grant execute on function public.pull_workspace_order_amendments(uuid, timestamptz) to authenticated',
    );
  });
});

describe('ORDER-AMENDMENT-01B1 finalize_workspace_invoice hardening', () => {
  const finalize = functionBody(sql, 'finalize_workspace_invoice');

  it('behält die bestehende Signatur ohne Overload', () => {
    expect(sql).toContain(
      'create or replace function public.finalize_workspace_invoice(\n  p_workspace_id uuid,\n  p_vorgang_id text,\n  p_client_invoice_id text,\n  p_invoice jsonb\n)',
    );
    expect(sql).toContain(
      'grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb) to authenticated',
    );
    expect(sql).not.toContain('p_expected_amendment_sequence');
  });

  it('sperrt zuerst workspace_vorgaenge, dann Invoice, dann Nummernkreis', () => {
    const vorgangLockAt = finalize.search(/from public\.workspace_vorgaenge[\s\S]*?for update/);
    const invoiceLockAt = finalize.search(/from public\.workspace_invoices[\s\S]*?for update/);
    const sequenceLockAt = finalize.search(
      /from public\.workspace_invoice_sequences[\s\S]*?for update/,
    );
    expect(vorgangLockAt).toBeGreaterThanOrEqual(0);
    expect(invoiceLockAt).toBeGreaterThan(vorgangLockAt);
    expect(sequenceLockAt).toBeGreaterThan(invoiceLockAt);
  });

  it('prüft Amendment-Sequenz nur für neue Schlussrechnungen und vor Nummernkreis', () => {
    expect(finalize).toContain('invoice_amendment_state_stale');
    expect(finalize).toContain("v_invoice_type = 'schluss'");
    expect(finalize).toContain('expectedAmendmentSequence');
    expect(finalize).toContain('expected_amendment_sequence');
    expect(finalize).toContain('coalesce(max(a.sequence_no), 0)');
    expect(finalize).toContain('idempotent_replay');

    const replayReturnAt = finalize.indexOf("'idempotent_replay', true");
    const staleAt = finalize.indexOf('invoice_amendment_state_stale');
    const sequenceLockAt = finalize.search(
      /from public\.workspace_invoice_sequences[\s\S]*?for update/,
    );
    const invoiceInsertAt = finalize.search(/insert into public\.workspace_invoices/);
    expect(replayReturnAt).toBeGreaterThanOrEqual(0);
    expect(staleAt).toBeGreaterThan(replayReturnAt);
    expect(sequenceLockAt).toBeGreaterThan(staleAt);
    expect(invoiceInsertAt).toBeGreaterThan(staleAt);
  });

  it('lehnt widersprüchliche camelCase- und snake_case-Sequenzfelder ausdrücklich ab', () => {
    expect(finalize).toContain('v_has_expected_camel');
    expect(finalize).toContain('v_has_expected_snake');
    expect(finalize).toContain('v_parsed_camel is distinct from v_parsed_snake');
    expect(finalize).toMatch(
      /v_has_expected_camel and v_has_expected_snake[\s\S]*?invoice_amendment_state_stale/,
    );
    // Must not silently prefer one field via coalesce of the raw text values.
    expect(finalize).not.toMatch(
      /coalesce\(\s*nullif\(trim\(coalesce\(p_invoice->>'expectedAmendmentSequence'/,
    );
  });

  it('erlaubt gleichen Wert, nur camelCase, nur snake_case und Default 0', () => {
    expect(finalize).toContain('v_expected_amendment_sequence := v_parsed_camel');
    expect(finalize).toContain('v_expected_amendment_sequence := v_parsed_snake');
    expect(finalize).toContain('v_expected_amendment_sequence := 0');
    expect(finalize).toContain('elsif v_has_expected_camel then');
    expect(finalize).toContain('elsif v_has_expected_snake then');
  });

  it('lehnt Strings, Dezimal- und Negativwerte für Sequenzfelder ab', () => {
    expect(finalize).toContain("jsonb_typeof(v_expected_camel) <> 'number'");
    expect(finalize).toContain("jsonb_typeof(v_expected_snake) <> 'number'");
    expect(finalize).toContain('<> trunc(');
    expect(finalize).toContain('< 0');
  });

  it('entfernt expectedAmendmentSequence aus persistiertem Invoice-Inhalt', () => {
    expect(sql).toContain("- 'expectedAmendmentSequence'");
    expect(sql).toContain("- 'expected_amendment_sequence'");
    expect(sql).toContain('normalize_workspace_invoice_payload_for_idempotency');
  });

  it('blockiert Teil-/Abschlagsrechnungen nicht über die Amendment-Sequenz', () => {
    const schlussOnly = finalize.includes("if v_invoice_type = 'schluss' then");
    expect(schlussOnly).toBe(true);
    expect(finalize).not.toContain("v_invoice_type = 'abschlag'");
    expect(finalize).not.toContain("v_invoice_type = 'teilrechnung'");
  });
});

describe('ORDER-AMENDMENT-01B1 race semantics (SQL contract)', () => {
  it('beide RPCs sperren zuerst dieselbe Vorgang-Zeile', () => {
    const confirm = functionBody(sql, 'confirm_workspace_order_amendment');
    const finalize = functionBody(sql, 'finalize_workspace_invoice');
    expect(confirm).toMatch(/from public\.workspace_vorgaenge[\s\S]*?for update/);
    expect(finalize).toMatch(/from public\.workspace_vorgaenge[\s\S]*?for update/);
    expect(confirm).toContain('order_amendment_final_invoice_exists');
    expect(finalize).toContain('invoice_amendment_state_stale');
  });
});
