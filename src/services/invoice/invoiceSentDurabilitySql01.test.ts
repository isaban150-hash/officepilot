/**
 * INVOICE-SENT-CLOUD-DURABILITY-01B — was die Datenbank beisteuert.
 *
 * Genau eine neue RPC: ein Lesezugriff auf den Versandzustand **einer**
 * Rechnung. Die schreibende `update_workspace_invoice_sent` bleibt unberührt —
 * sie trägt Erstversand, Korrektur und Retry bereits.
 *
 * **Was diese Tests beweisen können und was nicht:** Vitest hat keine
 * Datenbank. Geprüft wird die *Struktur* des SQL. Das Laufzeitverhalten steht
 * erst beim Dry-Run fest; hier wird keine Garantie behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250904120000_workspace_invoice_sent_read.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

const readFn = (() => {
  const start = sql.indexOf('create or replace function public.get_workspace_invoice_sent');
  expect(start, 'get_workspace_invoice_sent fehlt').toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

describe('SENT-DUR-SQL — Sicherheitsgrenze wie bei den bestehenden Invoice-RPCs', () => {
  it('T1: security definer mit festem search_path', () => {
    expect(readFn).toContain('security definer');
    expect(readFn).toContain('set search_path = public');
  });

  it('T2: Anmeldung und aktive Mitgliedschaft sind Pflicht', () => {
    expect(readFn).toContain('auth.uid()');
    expect(readFn).toContain("raise exception 'Nicht angemeldet'");
    expect(readFn).toContain('public.is_active_workspace_member(p_workspace_id)');
    expect(readFn).toContain("raise exception 'Kein Zugriff auf Workspace'");
  });

  it('T3: Identität über workspace_id + client_invoice_id, nie über die Nummer', () => {
    expect(readFn).toContain('workspace_id = p_workspace_id');
    expect(readFn).toContain('client_invoice_id = trim(p_client_invoice_id)');
    expect(readFn).not.toContain('invoice_number =');
  });

  it('T4: Rechte nach bestehendem Muster', () => {
    const signature = 'public.get_workspace_invoice_sent(uuid, text)';
    expect(sql).toContain(`revoke all on function ${signature} from public`);
    expect(sql).toContain(`grant execute on function ${signature} to authenticated`);
  });
});

describe('SENT-DUR-SQL — der Read bleibt schmal', () => {
  it('T5: Parameter sind Workspace und Rechnung, sonst nichts', () => {
    const header = sql.slice(
      sql.indexOf('create or replace function public.get_workspace_invoice_sent'),
      sql.indexOf(')', sql.indexOf('create or replace function public.get_workspace_invoice_sent')),
    );
    expect(header).toContain('p_workspace_id uuid');
    expect(header).toContain('p_client_invoice_id text');
  });

  it('T6: genau eine Rechnung, keine Workspace-Liste', () => {
    expect(readFn).not.toContain('jsonb_agg');
    expect(readFn).not.toContain('order by');
    expect(readFn).not.toContain('limit ');
  });

  it('T7: minimale Rückgabe — kein vollständiger Payload', () => {
    for (const key of ["'found'", "'invoice_status'", "'sent_at'", "'sent_via'", "'sent_note'"]) {
      expect(readFn, key).toContain(key);
    }
    expect(readFn).not.toContain("'payload'");
    expect(readFn).not.toContain("'positions'");
    expect(readFn).not.toContain("'amount'");
  });

  it('T8: der Read schreibt nicht', () => {
    for (const forbidden of ['update ', 'insert ', 'delete ']) {
      expect(readFn, forbidden).not.toContain(forbidden);
    }
  });
});

describe('SENT-DUR-SQL — keine weiteren Eingriffe', () => {
  it('T9: keine Tabelle, Spalte, Policy oder Datenmigration', () => {
    for (const forbidden of ['create table', 'add column', 'create policy', 'alter table']) {
      expect(sql.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('T10: die schreibende Sent-RPC wird nicht neu implementiert', () => {
    expect(sql).not.toContain('create or replace function public.update_workspace_invoice_sent');
    expect(sql).not.toContain('normalize_workspace_invoice_payload_for_idempotency');
    expect(sql).not.toContain('finalize_workspace_invoice');
  });
});
