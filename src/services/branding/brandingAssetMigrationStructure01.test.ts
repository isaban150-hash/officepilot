/**
 * BRANDING-01D — struktureller Test der Storage-Migration.
 *
 * ACHTUNG, Reichweite dieses Tests:
 *
 * Er liest den Migrationstext und prüft, dass die beabsichtigten Regeln darin
 * stehen. Er ist **kein** Policy-Laufzeittest. Ob PostgreSQL die Policies so
 * durchsetzt, wie sie gemeint sind, kann hier nicht festgestellt werden —
 * Docker fehlt auf dieser Maschine, eine lokale Supabase-Instanz lässt sich
 * nicht starten.
 *
 * Was er verhindert, ist trotzdem real: dass eine Regel beim Bearbeiten
 * unbemerkt verschwindet — etwa die fehlende UPDATE-Policy, die allein die
 * Unveränderlichkeit trägt, oder die Einschränkung auf den eigenen Bucket.
 */
import { describe, expect, it } from 'vitest';
import migrationSql from '../../../supabase/migrations/20250831120000_branding_assets_storage.sql?raw';

/** Nur der Code, ohne Kommentare — sonst prüfte man die Erläuterungen mit. */
const sql = migrationSql
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('BRANDING-01D Migrationsstruktur (kein Laufzeittest)', () => {
  it('legt den Bucket privat und begrenzt an', () => {
    expect(sql).toContain("'branding-assets'");
    expect(sql).toMatch(/insert into storage\.buckets/i);
    // public = false steht als vierter Wert vor der Grössengrenze.
    expect(sql).toMatch(/false,\s*\n?\s*2097152/);
    expect(sql).toContain('2097152');
    expect(sql).toMatch(/array\[\s*'image\/png',\s*'image\/jpeg',\s*'image\/webp'\s*\]/);
    // Idempotent: ein zweiter Lauf darf nicht scheitern.
    expect(sql).toMatch(/on conflict \(id\) do update/i);
  });

  it('nimmt kein anderes Bildformat auf', () => {
    for (const forbidden of ['image/svg', 'image/gif', 'image/heic', 'application/pdf']) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it('führt einen sicheren Pfad-Helfer statt eines nackten Casts', () => {
    expect(sql).toMatch(/create or replace function public\.branding_asset_workspace_id/i);
    expect(sql).toContain('returns uuid');

    /*
     * Der Kern: `text::uuid` wirft bei ungültiger Eingabe, statt NULL zu
     * liefern. In den Policies darf deshalb kein Cast direkt am Pfad stehen.
     */
    const policySection = sql.slice(sql.search(/create policy/i));
    expect(policySection).not.toMatch(/storage\.foldername\([^)]*\)[^;]*::uuid/i);
    expect(policySection).not.toMatch(/split_part\([^)]*\)::uuid/i);
    expect(policySection).not.toContain('::uuid');
  });

  it('erlaubt Lesen nur aktiven Mitgliedern des Workspace', () => {
    const select = sql.slice(
      sql.search(/create policy branding_assets_select_member/i),
      sql.search(/create policy branding_assets_insert_writer/i),
    );

    expect(select).toMatch(/for select to authenticated/i);
    expect(select).toContain("bucket_id = 'branding-assets'");
    expect(select).toContain('public.is_active_workspace_member');
    expect(select).toContain('public.branding_asset_workspace_id(name)');
  });

  it('erlaubt Anlegen nur mit Schreibberechtigung', () => {
    const insert = sql.slice(sql.search(/create policy branding_assets_insert_writer/i));

    expect(insert).toMatch(/for insert to authenticated/i);
    expect(insert).toContain("bucket_id = 'branding-assets'");
    // Nicht bloss Mitgliedschaft — eine Leserolle darf kein unlöschbares Objekt anlegen.
    expect(insert).toContain('public.can_write_workspace');
    expect(insert).not.toContain('is_active_workspace_member');
  });

  it('jede Policy ist auf den eigenen Bucket beschränkt', () => {
    const policies = sql.match(/create policy[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(policy).toContain("bucket_id = 'branding-assets'");
    }
  });

  it('kennt weder UPDATE noch DELETE — darauf beruht die Unveränderlichkeit', () => {
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

  it('fasst keine bestehenden Storage-Regeln an', () => {
    // Nur die eigenen Policies werden vorsorglich entfernt.
    const drops = (sql.match(/drop policy if exists (\w+)/gi) ?? []).map((entry) =>
      entry.replace(/drop policy if exists /i, ''),
    );
    expect(drops.sort()).toEqual([
      'branding_assets_insert_writer',
      'branding_assets_select_member',
    ]);
    expect(sql).not.toMatch(/alter table storage\.objects/i);
    expect(sql).not.toMatch(/drop table/i);
  });
});
