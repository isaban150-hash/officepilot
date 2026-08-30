/**
 * SECURITY-GEMINI-KEY-01B-R4 — die Zählfunktion als SECURITY DEFINER.
 *
 * Realbefund: `service_role` durfte die Funktion aufrufen, aber die Funktion
 * lief als SECURITY INVOKER — also mit den Rechten des Aufrufers, und der hat
 * auf die Zähltabelle keine. Ergebnis war `rate_check_failed` und ein
 * fail-closed `server_misconfigured`.
 *
 * Der Ausweg ist bewusst **nicht**, `service_role` direkte Tabellenrechte zu
 * geben: Dann wäre der Zähler von aussen manipulierbar, sobald irgendwo sonst
 * mit dem Service-Role-Schlüssel gearbeitet wird. Stattdessen bleibt die
 * Tabelle geschlossen und nur diese eine Funktion erreicht sie.
 *
 * Strukturprüfung, kein Laufzeitnachweis.
 */
import { describe, expect, it } from 'vitest';
import migrationSql from '../../../supabase/migrations/20250901130000_ai_usage_counter_security_definer.sql?raw';
import baseMigrationSql from '../../../supabase/migrations/20250901120000_ai_usage_rate_limit.sql?raw';

function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const sql = stripComments(migrationSql);
const base = stripComments(baseMigrationSql);

describe('R4: SECURITY DEFINER für die Zählfunktion (Struktur)', () => {
  it('setzt SECURITY DEFINER auf die bestehende Funktion', () => {
    expect(sql).toMatch(
      /alter function public\.ai_usage_check_and_count\(\s*uuid, uuid, text, integer, integer, integer\s*\)\s*security definer;/i,
    );
  });

  it('setzt den search_path ausdrücklich auf public', () => {
    /*
     * Bei SECURITY DEFINER ist ein fester Suchpfad Pflicht — sonst liesse sich
     * die Funktion über einen manipulierten `search_path` auf fremde Objekte
     * lenken.
     */
    expect(sql).toMatch(
      /alter function public\.ai_usage_check_and_count\([^)]*\)\s*set search_path = public;/i,
    );
  });

  it('hält den Rechtevertrag: nur service_role darf ausführen', () => {
    expect(sql).toMatch(
      /revoke all on function public\.ai_usage_check_and_count\([^)]*\)\s*\n?\s*from public, anon, authenticated;/i,
    );

    const grants = sql.match(/grant[^;]+;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/execute on function public\.ai_usage_check_and_count/i);
    expect(grants[0]).toMatch(/to service_role;/i);

    for (const role of ['authenticated', 'anon', 'public']) {
      expect(grants[0], role).not.toMatch(new RegExp(`to\\s+${role}\\b`, 'i'));
    }
  });

  it('vergibt keine direkten Tabellenrechte an service_role', () => {
    /*
     * Der Kern der Entscheidung: Die Zähltabelle bleibt für alle geschlossen,
     * auch für den Service-Role-Zugang.
     */
    expect(sql).not.toMatch(/grant[^;]*on public\.ai_usage_counters/i);
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete)[^;]*to service_role/i);
  });

  it('fügt keine Policy hinzu und ändert keine Tabelle', () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/row level security/i);
    expect(sql).not.toMatch(/drop /i);
  });

  it('lässt Zähllogik, Parameter und Grenzwerte unverändert', () => {
    /*
     * Geändert wird per ALTER, nicht per CREATE OR REPLACE: Der Rumpf wird
     * nicht dupliziert und kann deshalb nicht abweichen. Die Logik steht
     * weiterhin ausschliesslich in der Ursprungsmigration.
     */
    expect(sql).not.toMatch(/create or replace function/i);
    expect(sql).not.toContain('request_count');
    expect(sql).not.toContain('on conflict');
    expect(sql).not.toContain('p_short_limit');

    // Sie ist dort unverändert vorhanden.
    expect(base).toMatch(/create or replace function public\.ai_usage_check_and_count/i);
    expect(base).toMatch(/returning request_count into/i);
  });

  it('fasst die Leserechte-Migration nicht an', () => {
    expect(sql).not.toContain('public.profiles');
    expect(sql).not.toContain('public.workspace_members');
  });
});
