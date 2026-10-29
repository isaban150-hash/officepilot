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

/*
 * EINRICHTUNG-01 (AP1, E3) — bewusst geänderte Struktur: Profil- und Mitgliedschaftsabfrage sind ersetzt durch EINEN
 * Aufruf der zentralen Zugriffsregel (`workspace_user_access_denial`, nur service_role), die zusätzlich die
 * Betriebslizenz prüft. Der Befund aus R3 bleibt abgesichert: Ein Datenbankfehler wird ausgewertet, steht vor der
 * fachlichen Bewertung und erscheint nie als Sperre.
 */
describe('R3: Datenbankfehler sind keine Sperre', () => {
  it('wertet den Fehler der Zugriffsabfrage aus', () => {
    expect(code).toContain('error: accessError');
    expect(code).toMatch(/if \(accessError\)[\s\S]{0,160}return fail\('server_misconfigured'\)/);
  });

  it('nutzt die zentrale Zugriffsregel mit der Aktion member statt eigener Lizenzpruefung', () => {
    expect(code).toContain("admin.rpc('workspace_user_access_denial'");
    expect(code).toContain("p_action: 'member'");
    expect(code).not.toMatch(/\.from\('profiles'\)/);
    expect(code).not.toMatch(/license_status/);
  });

  it('meldet bei einem Abfragefehler weder forbidden noch workspace_forbidden', () => {
    /*
     * Die Fehlerbehandlung steht **vor** der fachlichen Bewertung — sonst liefe
     * ein technischer Fehler wieder in die Sperre.
     */
    expect(code.indexOf('if (accessError)')).toBeGreaterThan(-1);
    expect(code.indexOf('if (accessError)')).toBeLessThan(
      // Die Aufrufstelle, nicht der Import am Dateikopf.
      code.indexOf('evaluateWorkspaceAccessDenial(denial'),
    );
  });

  it('reicht keine Supabase-Meldung und keine SQL-Details hinaus', () => {
    // Das Fehlerobjekt wird nur auf Existenz geprüft, nie serialisiert.
    expect(code).not.toMatch(/accessError\.(message|details|hint|code)/);
    expect(code).not.toMatch(/JSON\.stringify\(accessError/);
  });

  it('bewertet fachlich an einer Stelle', () => {
    expect(code).toContain('evaluateWorkspaceAccessDenial(denial)');
    expect(code).toContain('return fail(access.error)');
  });
});
