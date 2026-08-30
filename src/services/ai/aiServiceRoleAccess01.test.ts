/**
 * SECURITY-GEMINI-KEY-01B-R3 — Leserechte und Fehlertrennung.
 *
 * Realbefund: Ein freigeschalteter Nutzer mit aktiver Lizenz erhielt
 * `forbidden`. Ursache waren zwei Dinge zugleich — der service-role-Rolle
 * fehlte `SELECT` auf `profiles` und `workspace_members`, und die Function
 * verwarf den Fehler der Abfrage. Ein Berechtigungsproblem sah damit aus wie
 * ein fehlendes Profil.
 *
 * Geprüft wird beides: dass die Folgemigration genau die nötigen Rechte
 * vergibt, und dass ein Datenbankfehler nicht mehr als Nutzer- oder
 * Workspace-Sperre erscheint.
 *
 * Strukturprüfung, kein Laufzeitnachweis — die tatsächliche Rechtevergabe
 * zeigt erst der Remote-Lauf.
 */
import { describe, expect, it } from 'vitest';
import migrationSql from '../../../supabase/migrations/20250901123000_ai_service_role_read_access.sql?raw';
import functionSource from '../../../supabase/functions/ai/index.ts?raw';

const sql = migrationSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const code = functionSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
  .join('\n');

describe('R3: Leserechte der Edge Function (Struktur)', () => {
  it('erteilt service_role SELECT auf profiles und workspace_members', () => {
    expect(sql).toMatch(/grant select on public\.profiles to service_role;/i);
    expect(sql).toMatch(/grant select on public\.workspace_members to service_role;/i);
  });

  it('erteilt niemandem sonst neue Rechte', () => {
    const grants = sql.match(/grant[^;]+;/gi) ?? [];
    expect(grants).toHaveLength(2);

    for (const grant of grants) {
      expect(grant).toMatch(/to service_role;/i);
      for (const role of ['authenticated', 'anon', 'public']) {
        expect(grant, role).not.toMatch(new RegExp(`to\\s+${role}\\b`, 'i'));
      }
    }
  });

  it('vergibt nur Leserechte und ändert keine Regeln', () => {
    expect(sql).not.toMatch(/\b(insert|update|delete|all)\b\s+on/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter table/i);
    expect(sql).not.toMatch(/row level security/i);
    // Die internen Membership-Helfer bleiben gesperrt.
    expect(sql).not.toMatch(/is_active_workspace_member|can_write_workspace/i);
  });

  it('fasst die bereits angewendete Migration nicht an', () => {
    expect(sql).not.toContain('ai_usage_counters');
    expect(sql).not.toContain('ai_usage_check_and_count');
  });
});

describe('R3: Datenbankfehler sind keine Sperre', () => {
  it('wertet den Fehler der profiles-Abfrage aus', () => {
    expect(code).toContain('error: profileError');
    expect(code).toMatch(/if \(profileError\)[\s\S]{0,160}return fail\('server_misconfigured'\)/);
  });

  it('wertet den Fehler der workspace_members-Abfrage aus', () => {
    expect(code).toContain('error: membershipError');
    expect(code).toMatch(/if \(membershipError\)[\s\S]{0,160}return fail\('server_misconfigured'\)/);
  });

  it('meldet bei einem Abfragefehler weder forbidden noch workspace_forbidden', () => {
    /*
     * Die Fehlerbehandlung steht jeweils **vor** der fachlichen Bewertung —
     * sonst liefe ein technischer Fehler wieder in die Sperre.
     */
    expect(code.indexOf('if (profileError)')).toBeLessThan(
      // Die Aufrufstelle, nicht der Import am Dateikopf.
      code.indexOf('evaluateProfileAccess(profile'),
    );
    expect(code.indexOf('if (membershipError)')).toBeLessThan(
      code.indexOf("fail('workspace_forbidden')"),
    );
  });

  it('reicht keine Supabase-Meldung und keine SQL-Details hinaus', () => {
    // Die Fehlerobjekte werden nur auf Existenz geprüft, nie serialisiert.
    expect(code).not.toMatch(/profileError\.(message|details|hint|code)/);
    expect(code).not.toMatch(/membershipError\.(message|details|hint|code)/);
    expect(code).not.toMatch(/JSON\.stringify\((profileError|membershipError)/);
  });

  it('lässt die fachliche Bewertung unverändert', () => {
    // Die Semantik selbst liegt weiterhin in evaluateProfileAccess.
    expect(code).toContain('evaluateProfileAccess(profile, new Date())');
    expect(code).toContain("return fail('workspace_forbidden')");
  });
});
