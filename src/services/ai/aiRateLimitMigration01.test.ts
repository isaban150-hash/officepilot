/**
 * SECURITY-GEMINI-KEY-01B — struktureller Test der Zähl-Migration.
 *
 * ACHTUNG, Reichweite: Dieser Test liest den Migrationstext. Er ist **kein**
 * Laufzeitnachweis — ob PostgreSQL die Rechte durchsetzt und ob die Zählung
 * unter echter Nebenläufigkeit dicht ist, zeigt erst der Remote-Test. Docker
 * ist auf dieser Maschine nicht verfügbar.
 *
 * Was er verhindert: dass beim Bearbeiten eine Schutzregel unbemerkt
 * verschwindet — etwa die fehlende Freigabe an `authenticated`, ohne die ein
 * Client seinen eigenen Zähler zurücksetzen könnte.
 */
import { describe, expect, it } from 'vitest';
import migrationSql from '../../../supabase/migrations/20250901120000_ai_usage_rate_limit.sql?raw';

const sql = migrationSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('KI-Zähltabelle (Struktur, kein Laufzeittest)', () => {
  it('legt eine Zähltabelle mit den vier Dimensionen an', () => {
    expect(sql).toMatch(/create table if not exists public\.ai_usage_counters/i);
    for (const column of ['user_id', 'workspace_id', 'operation', 'window_kind', 'window_start']) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/primary key \(user_id, workspace_id, operation, window_kind, window_start\)/i);
    expect(sql).toMatch(/window_kind in \('short', 'day'\)/i);
    expect(sql).toMatch(/create index if not exists ai_usage_counters_window_start_idx/i);
  });

  it('speichert keine Inhalte und keine Geschäftsdaten', () => {
    /*
     * Geprüft werden die Spalten der Tabelle, nicht beliebige Wörter — `text`
     * etwa ist der SQL-Typ von `operation` und völlig harmlos.
     */
    const createTable = sql.slice(
      sql.search(/create table if not exists public\.ai_usage_counters/i),
      sql.indexOf(');', sql.search(/create table if not exists public\.ai_usage_counters/i)),
    );

    for (const forbidden of [
      'prompt',
      'response',
      'answer',
      'document',
      'content',
      'company',
      'email',
      'amount',
      'api_key',
      'access_token',
    ]) {
      expect(createTable.toLowerCase(), forbidden).not.toContain(forbidden);
    }

    // Und die Tabelle führt genau die erwarteten Spalten.
    expect(createTable).toContain('request_count');
    expect(createTable).not.toMatch(/\bpayload\b/i);
  });

  it('sperrt den direkten Clientzugriff vollständig', () => {
    expect(sql).toMatch(/alter table public\.ai_usage_counters enable row level security/i);
    expect(sql).toMatch(
      /revoke all on public\.ai_usage_counters from public, anon, authenticated/i,
    );
    // Keine Policy: Unter RLS ist damit alles verboten, was nicht Service-Role ist.
    expect(sql).not.toMatch(/create policy/i);
  });

  it('prüft und zählt in einem atomaren Aufruf', () => {
    expect(sql).toMatch(/create or replace function public\.ai_usage_check_and_count/i);
    expect(sql).toContain('returns boolean');
    expect(sql).toMatch(/set search_path = public/i);

    // Kein "erst zählen, dann prüfen" über zwei Anweisungen: Upsert mit
    // returning liefert den Stand, den Postgres serialisiert hat.
    expect(sql).toMatch(/on conflict \(user_id, workspace_id, operation, window_kind, window_start\)/i);
    expect(sql).toMatch(/returning request_count into/i);
    expect(sql).not.toMatch(/select\s+count\(/i);
  });

  it('wertet beide Fenster aus und lehnt ungültige Limits ab', () => {
    expect(sql).toContain('v_short_count');
    expect(sql).toContain('v_day_count');
    expect(sql).toMatch(/if v_short_count > p_short_limit or v_day_count > p_daily_limit/i);
    expect(sql).toMatch(/ungueltige Limitkonfiguration/i);
  });

  it('gibt die Zählfunktion nur der Edge Function frei', () => {
    expect(sql).toMatch(
      /revoke all on function public\.ai_usage_check_and_count\([^)]*\)\s*\n?\s*from public, anon, authenticated/i,
    );

    /*
     * Ausdrücklich, nicht implizit: Der Widerruf oben nimmt auch das
     * PostgreSQL-Standardrecht an PUBLIC. Ohne diesen GRANT wäre nicht belegt,
     * dass service_role die Funktion überhaupt aufrufen kann.
     */
    const grants = sql.match(/grant execute on function[^;]+;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('ai_usage_check_and_count');
    expect(grants[0]).toMatch(/to service_role/i);

    // Und niemandem sonst.
    for (const role of ['authenticated', 'anon', 'public']) {
      expect(grants[0], role).not.toMatch(new RegExp(`to\\s+${role}\\b`, 'i'));
    }
  });

  it('fasst keine bestehende Struktur an', () => {
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/alter table public\.profiles/i);
    expect(sql).not.toMatch(/alter table public\.workspace/i);
    expect(sql).not.toMatch(/grant execute on function public\.(is_active_workspace_member|can_write_workspace)/i);
  });
});
