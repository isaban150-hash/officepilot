/**
 * BRANDING-01E-0 — Altclient-Schutz fuer `branding` im company_profile.
 *
 * Struktureller Test gegen den Migrationstext. Es gibt auf dieser Maschine
 * keine lokale Supabase-Instanz (kein Docker), deshalb laeuft hier keine echte
 * Datenbank. Der Test sichert die Form der Regel, nicht ihr Laufzeitverhalten.
 *
 * SERVER POLICY RUNTIME TEST NOT EXECUTED — die tatsaechliche Wirkung der
 * Funktion muss am Remote-Projekt geprueft werden.
 */
import { describe, it, expect } from 'vitest';

import preserveSql from '../../../supabase/migrations/20250902120000_company_profile_branding_preserve.sql?raw';
import baselineSql from '../../../supabase/migrations/20250830120000_sync_strict_zero_create_guard.sql?raw';

const FUNCTION_HEAD = 'create or replace function public.upsert_workspace_sync_entity';

/** Nur der Funktionsrumpf, ohne den erklaerenden Kopfkommentar der Migration. */
function functionText(sql: string): string {
  const start = sql.indexOf(FUNCTION_HEAD);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start);
}

/**
 * Zweigtext zwischen zwei `elsif`/`else`-Marken. Bewusst textbasiert: Ziel ist
 * der Nachweis, dass ausserhalb von company_profile nichts angefasst wurde.
 */
function branch(sql: string, marker: string): string {
  const fn = functionText(sql);
  const start = fn.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = fn.slice(start);
  const next = rest.slice(marker.length).search(/\n {2}(elsif p_entity_type|else\n)/);
  return next < 0 ? rest : rest.slice(0, marker.length + next);
}

const MARKERS = {
  vorgang: "if p_entity_type = 'vorgang' then",
  customer: "elsif p_entity_type = 'customer' then",
  workspace: "elsif p_entity_type = 'workspace' then",
  workspaceSettings: "elsif p_entity_type = 'workspace_settings' then",
  companySetup: "elsif p_entity_type = 'company_setup' then",
  companyProfile: "elsif p_entity_type = 'company_profile' then",
} as const;

const preserveFn = functionText(preserveSql);
const profileBranch = branch(preserveSql, MARKERS.companyProfile);
/* Nur der UPDATE-Zweig: alles ab dem Konfliktguard. */
const profileUpdate = profileBranch.slice(profileBranch.indexOf('else\n      if p_row_version > 0'));

describe('BRANDING-01E-0 — company_profile bewahrt `branding`', () => {
  // 1
  it('liegt zeitlich nach der letzten angewendeten Migration', () => {
    expect('20250902120000' > '20250901130000').toBe(true);
  });

  // 2
  it('ersetzt dieselbe Funktion mit unveraenderter Signatur', () => {
    expect(preserveFn).toContain(FUNCTION_HEAD);
    for (const param of [
      'p_workspace_id uuid',
      'p_entity_type text',
      'p_payload jsonb',
      'p_row_version bigint',
    ]) {
      expect(preserveFn).toContain(param);
    }
    expect(preserveFn).toContain('returns jsonb');
  });

  // 3
  it('bleibt security definer mit festem search_path', () => {
    expect(preserveFn).toContain('security definer');
    expect(preserveFn).toContain('set search_path = public');
  });

  // 4
  it('liest den bestehenden Payload mit, um ihn ueberhaupt bewahren zu koennen', () => {
    expect(profileBranch).toContain('cp.row_version, cp.payload into v_current_version, v_existing_profile');
    expect(profileBranch).toContain('for update');
  });

  // 5
  it('entscheidet ueber den Typ des eingehenden Felds, nicht ueber dessen Wahrheitswert', () => {
    expect(profileUpdate).toContain("jsonb_typeof(v_incoming_profile->'branding') is distinct from 'object'");
  });

  // 6 — `{}` gilt als 'object' und wird deshalb regulaer uebernommen.
  it('uebernimmt ein leeres Branding-Objekt, statt es als "fehlend" zu deuten', () => {
    expect(profileUpdate).not.toContain("v_incoming_profile->'branding' = '{}'");
    expect(profileUpdate).not.toContain("coalesce(v_incoming_profile->'branding'");
  });

  // 7 — `null` liefert jsonb_typeof 'null', also nicht 'object' -> bewahren.
  it('behandelt JSON-null nicht als Loeschsignal', () => {
    expect(profileUpdate).not.toContain("is not null and jsonb_typeof");
    expect(profileUpdate).toMatch(/is distinct from 'object'/);
  });

  // 8
  it('bewahrt nur, wenn serverseitig wirklich ein Branding-Objekt liegt', () => {
    expect(profileUpdate).toContain("jsonb_typeof(v_existing_profile->'branding') = 'object'");
  });

  // 9
  it('schreibt das bewahrte Branding gezielt in genau diesen einen Schluessel', () => {
    expect(profileUpdate).toContain("jsonb_set(");
    expect(profileUpdate).toContain("'{branding}'");
    expect(profileUpdate).toContain("v_existing_profile->'branding'");
  });

  // 10
  it('laesst den Versionskonflikt-Guard unveraendert', () => {
    expect(profileUpdate).toContain('if p_row_version > 0 and p_row_version <> v_current_version then');
    expect(profileUpdate).toContain("raise exception 'Versionskonflikt company_profile:%'");
    expect(profileUpdate).toContain("errcode = 'P0001'");
  });

  // 11
  it('laesst Versionsinkrement und Schreiberkennung unveraendert', () => {
    expect(profileUpdate).toContain('row_version = row_version + 1');
    expect(profileUpdate).toContain('updated_by = auth.uid()');
  });

  // 12
  it('laesst den Rueckgabevertrag unveraendert', () => {
    expect(profileBranch).toContain(
      "jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result)",
    );
  });

  // 13 — Beim INSERT gibt es nichts zu bewahren.
  it('laesst den INSERT-Zweig unveraendert', () => {
    const baselineProfile = branch(baselineSql, MARKERS.companyProfile);
    const insertOf = (text: string) =>
      text.slice(text.indexOf('insert into public.workspace_company_profiles'), text.indexOf('else\n      if p_row_version'));
    expect(insertOf(profileBranch)).toBe(insertOf(baselineProfile));
  });

  // 14
  it('fuehrt kein allgemeines Deep-Merge und keine Regel fuer unbekannte Felder ein', () => {
    const stripped = preserveFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
    expect(stripped).not.toContain('jsonb_object_keys');
    expect(stripped).not.toMatch(/payload\s*\|\|/);
    expect(stripped).not.toMatch(/v_existing_profile\s*\|\|/);
    /* Genau ein bewahrter Schluessel. */
    expect(stripped.match(/jsonb_set\(/g)).toHaveLength(1);
    expect(stripped.match(/'\{branding\}'/g)).toHaveLength(1);
  });

  // 15
  it('legt keine Tabelle, Spalte, Policy oder zusaetzliche Berechtigung an', () => {
    const lower = preserveSql.toLowerCase();
    for (const forbidden of [
      'create table',
      'alter table',
      'create policy',
      'alter policy',
      'grant ',
      'revoke ',
      'create index',
      'insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)\nselect',
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  // 16 — Alle uebrigen Zweige exakt unveraendert.
  it('laesst alle anderen Entity-Zweige zeichengleich', () => {
    for (const key of ['vorgang', 'customer', 'workspace', 'workspaceSettings', 'companySetup'] as const) {
      expect(branch(preserveSql, MARKERS[key])).toBe(branch(baselineSql, MARKERS[key]));
    }
  });

  // 16b — Ausserhalb der Zweige: nur die zwei neuen declare-Variablen.
  it('ergaenzt im Kopf nur die beiden benoetigten Variablen', () => {
    const headOf = (sql: string) => functionText(sql).slice(0, functionText(sql).indexOf(MARKERS.vorgang));
    const removed = headOf(preserveFn)
      .split('\n')
      .filter((line) => !/v_existing_profile jsonb|v_incoming_profile jsonb|BRANDING-01E-0/.test(line))
      .join('\n');
    expect(removed).toBe(headOf(baselineSql));
  });
});
