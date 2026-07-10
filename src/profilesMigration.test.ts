import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250710120000_profiles_foundation.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('SUPABASE-AUTH-03 migration', () => {
  it('legt profiles mit Pflichtfeldern und Checks an', () => {
    expect(sql).toContain('create table if not exists public.profiles');
    expect(sql).toContain("status in ('pending', 'approved', 'blocked')");
    expect(sql).toContain("role in ('user', 'admin')");
    expect(sql).toContain("license_status in ('inactive', 'active', 'expired')");
    expect(sql).toContain('constraint profiles_email_unique unique (email)');
  });

  it('enthält Trigger, Backfill und RLS', () => {
    expect(sql).toContain('handle_new_user');
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public');
    expect(sql).toContain('on conflict (id) do nothing');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('profiles_select_own');
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'user'");
    expect(sql).toContain("'inactive'");
  });

  it('schützt sicherheitskritische Felder über RPC statt direktes UPDATE', () => {
    expect(sql).toContain('update_own_profile');
    expect(sql).not.toMatch(/grant\s+update\s+on\s+public\.profiles/i);
    expect(sql).toContain('grant select on public.profiles to authenticated');
  });

  it('definiert Admin-RPCs mit Berechtigungsprüfung', () => {
    expect(sql).toContain('assert_is_admin');
    expect(sql).toContain('admin_list_profiles');
    expect(sql).toContain('admin_approve_user');
    expect(sql).toContain('admin_block_user');
    expect(sql).toContain('admin_activate_license');
    expect(sql).toContain('admin_deactivate_license');
    expect(sql).toContain('admin_set_license_expiry');
    expect(sql).toContain('admin_clear_license_expiry');
    expect(sql).toContain('admin_expire_license');
    expect(sql).toContain("raise exception 'Keine Admin-Berechtigung'");
  });
});
