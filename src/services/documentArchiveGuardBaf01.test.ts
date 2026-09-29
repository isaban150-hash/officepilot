/**
 * BROWSER-ACCEPTANCE-FIX 01 / A1 — Struktur der serverseitigen Löschsperre.
 *
 * Vitest hat keine Datenbank; das Laufzeitverhalten prüft
 * `supabase/tests/document_archive_guard_baf01.sql`. Hier wird festgehalten,
 * dass die neue Fassung von `tombstone_workspace_document` nichts von der alten
 * verliert und die Sperre VOR der Änderung steht.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
const guardSql = read('20261019120000_workspace_document_archive_guard.sql');
const originalSql = read('20250827120000_workspace_generated_invoice_document_cloud.sql');

const body = (sql: string, next: string | null) => {
  const start = sql.indexOf('create or replace function public.tombstone_workspace_document');
  const end = next ? sql.indexOf(next, start) : sql.length;
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, end);
};
const originalBody = body(originalSql, 'create or replace function public.pull_workspace_documents');
const guardBody = body(guardSql, 'revoke all on function');

describe('BROWSER-ACCEPTANCE-FIX 01 / A1 — tombstone_workspace_document', () => {
  it('behält jede bisherige Prüfung und die Idempotenz', () => {
    for (const line of [
      "raise exception 'Nicht angemeldet'",
      "raise exception 'workspace_id fehlt'",
      'if not public.is_active_workspace_member(p_workspace_id) then',
      "raise exception 'Kein Zugriff auf Workspace'",
      "raise exception 'client_document_id fehlt'",
      "raise exception 'Dokument nicht gefunden'",
      'if v_existing.deleted_at is not null then',
      'row_version = row_version + 1',
      "raise exception 'Loeschung nicht angewendet'",
      'security definer',
      'set search_path = public',
    ]) {
      expect(originalBody).toContain(line);
      expect(guardBody).toContain(line);
    }
    expect(guardBody).not.toContain('delete from public.workspace_documents');
  });

  it('sperrt Belege festgeschriebener Rechnungen im selben Workspace, vor dem Update', () => {
    const guardAt = guardBody.indexOf(
      "raise exception 'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden'",
    );
    expect(guardAt).toBeGreaterThan(guardBody.indexOf('if v_existing.deleted_at is not null then'));
    expect(guardAt).toBeLessThan(guardBody.indexOf('update public.workspace_documents'));
    expect(guardBody).toContain("v_existing.document_kind in ('generated_invoice', 'generated_invoice_correction')");
    expect(guardBody).toContain('wi.workspace_id = p_workspace_id');
    expect(guardBody).toContain('wi.client_invoice_id = v_existing.linked_invoice_id');
    expect(guardBody).toContain("wi.invoice_status in ('vorbereitet', 'versendet')");
  });

  it('Rechte: public/anon entzogen, authenticated erlaubt', () => {
    expect(guardSql).toContain(
      'revoke all on function public.tombstone_workspace_document(uuid, text) from public, anon;',
    );
    expect(guardSql).toContain(
      'grant execute on function public.tombstone_workspace_document(uuid, text) to authenticated;',
    );
  });
});
