/**
 * BRANDING-01D — struktureller Test der Policy-Brücke.
 *
 * ACHTUNG, Reichweite: Dieser Test liest den Migrationstext und prüft, dass
 * die beabsichtigten Regeln darin stehen. Er ist **kein** Laufzeitnachweis —
 * ob PostgreSQL die Rechte so durchsetzt, zeigt erst der Realtest gegen die
 * eingespielte Datenbank.
 *
 * Was er verhindert, ist trotzdem konkret: dass beim Bearbeiten die
 * Einschränkung der Rechte verlorengeht — etwa durch ein bequemes
 * `grant execute` auf die Workspace-Helfer, das jedem angemeldeten Nutzer
 * Auskunft über fremde Mitgliedschaften gäbe.
 */
import { describe, expect, it } from 'vitest';
import bridgeSql from '../../../supabase/migrations/20250831123000_branding_assets_storage_policy_bridge.sql?raw';

/** Nur der Code — die Erläuterungen nennen die Helfer absichtlich beim Namen. */
const sql = bridgeSql
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('BRANDING-01D Policy-Brücke (Struktur, kein Laufzeittest)', () => {
  it('definiert beide Brücken als SECURITY DEFINER mit festem search_path', () => {
    for (const fn of ['branding_asset_can_read', 'branding_asset_can_write']) {
      const definition = sql.slice(
        sql.search(new RegExp(`create or replace function public\\.${fn}`, 'i')),
      );
      const body = definition.slice(0, definition.indexOf('$$;') + 3);

      expect(body).toContain('returns boolean');
      expect(body).toMatch(/language sql/i);
      expect(body).toMatch(/security definer/i);
      expect(body).toMatch(/set search_path = public/i);
      // Der sichere Parser wird wiederverwendet, keine zweite Regex.
      expect(body).toContain('public.branding_asset_workspace_id(p_name)');
      // Ungültiger Pfad ergibt false statt NULL oder Ausnahme.
      expect(body).toContain('coalesce(');
    }
  });

  it('leitet Mitgliedschaft und Schreibrecht an die vorhandenen Helfer weiter', () => {
    const read = sql.slice(
      sql.search(/create or replace function public\.branding_asset_can_read/i),
      sql.search(/create or replace function public\.branding_asset_can_write/i),
    );
    expect(read).toContain('public.is_active_workspace_member');
    expect(read).not.toContain('can_write_workspace');

    const write = sql.slice(sql.search(/create or replace function public\.branding_asset_can_write/i));
    const writeBody = write.slice(0, write.indexOf('$$;') + 3);
    expect(writeBody).toContain('public.can_write_workspace');
    expect(writeBody).not.toContain('is_active_workspace_member');
  });

  it('gibt nur boolean zurück — keine Rolle, keine Kennung, keine Daten', () => {
    expect(sql).not.toMatch(/returns\s+(?!boolean)\w+/i);
    expect(sql).not.toContain('workspace_member_role');
    expect(sql).not.toMatch(/returns table/i);
  });

  it('entzieht beide Brücken der Allgemeinheit und gibt sie nur authenticated frei', () => {
    for (const fn of ['branding_asset_can_read', 'branding_asset_can_write']) {
      expect(sql).toContain(`revoke all on function public.${fn}(text) from public;`);
      expect(sql).toContain(`grant execute on function public.${fn}(text) to authenticated;`);
    }
    // Keine Freigabe für nicht angemeldete Aufrufer.
    expect(sql).not.toMatch(/to anon/i);
  });

  it('weitet die Rechte der bestehenden Workspace-Helfer nicht aus', () => {
    /*
     * Der Kern dieses Fixes: Die drei Helfer bleiben für `authenticated`
     * unaufrufbar. Ein `grant execute` auf sie wäre die bequeme, aber falsche
     * Lösung — sie machte fremde Mitgliedschaften abfragbar.
     */
    const grants = sql.match(/grant execute on function[^;]+;/gi) ?? [];
    expect(grants).toHaveLength(2);

    for (const helper of [
      'is_active_workspace_member',
      'can_write_workspace',
      'workspace_member_role',
    ]) {
      expect(grants.join('\n')).not.toContain(helper);
    }
  });

  it('setzt die Policies auf die Brücken um, ohne den Bucket zu verlassen', () => {
    const select = sql.slice(
      sql.search(/create policy branding_assets_select_member/i),
      sql.search(/drop policy if exists branding_assets_insert_writer/i),
    );
    expect(select).toMatch(/for select to authenticated/i);
    expect(select).toContain("bucket_id = 'branding-assets'");
    expect(select).toContain('public.branding_asset_can_read(name)');

    const insert = sql.slice(sql.search(/create policy branding_assets_insert_writer/i));
    expect(insert).toMatch(/for insert to authenticated/i);
    expect(insert).toContain("bucket_id = 'branding-assets'");
    expect(insert).toContain('public.branding_asset_can_write(name)');
  });

  it('kennt weiterhin weder UPDATE noch DELETE', () => {
    expect(sql).not.toMatch(/for update/i);
    expect(sql).not.toMatch(/for delete/i);

    const policyNames = (sql.match(/create policy (\w+)/gi) ?? []).map((entry) =>
      entry.replace(/create policy /i, ''),
    );
    expect(policyNames.sort()).toEqual([
      'branding_assets_insert_writer',
      'branding_assets_select_member',
    ]);
  });

  it('fasst weder andere Buckets noch die bereits angewendete Migration an', () => {
    const drops = (sql.match(/drop policy if exists (\w+)/gi) ?? []).map((entry) =>
      entry.replace(/drop policy if exists /i, ''),
    );
    expect(drops.sort()).toEqual([
      'branding_assets_insert_writer',
      'branding_assets_select_member',
    ]);
    expect(sql).not.toMatch(/alter table storage\.objects/i);
    expect(sql).not.toMatch(/storage\.buckets/i);
    expect(sql).not.toMatch(/drop function/i);
  });
});
