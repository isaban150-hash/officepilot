/**
 * CLOUD-SYNC S1 — der serverseitige Sync-Vertrag als Quelltext.
 *
 * Die eigentliche Prüfung der Migration läuft gegen eine echte PostgreSQL
 * (`supabase/tests/paper_register_entries_s1.sql`: Anlage, Wiederholung,
 * Konflikt, Grabstein, Isolation, Rollen, RLS). Diese Datei hält das Ergebnis
 * dort fest, wo es im Alltag auffällt: Sie bricht, sobald jemand einen
 * bestehenden Dispatcher-Zweig verliert, die wörtliche Übernahme der beiden
 * Funktionen aufweicht oder die Sichtbarkeit des Abzugs lockert.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_ONLY_SYNC_ENTITY_TYPES, isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');
const lies = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');

const sql = lies('20261030120000_workspace_paper_register_entries.sql');

/** Der Rumpf einer Funktion: genau der Text zwischen den Dollar-Quotes. */
function rumpf(quelle: string, funktion: string): string {
  const start = quelle.indexOf(`create or replace function public.${funktion}(`);
  expect(start, `Funktion fehlt: ${funktion}`).toBeGreaterThanOrEqual(0);
  const auf = quelle.indexOf('$$', start) + 2;
  return quelle.slice(auf, quelle.indexOf('$$;', auf));
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** Die geltenden, remote wie lokal angewendeten Rümpfe (vor S1 gemessen). */
const UPSERT_VOR_S1 = '11c5033d7a2223bc8a1426953a875a39';
const PULL_VOR_S1 = '225a049f71383ee397625e2af93477e5';

const upsert = rumpf(sql, 'upsert_workspace_sync_entity');
const pull = rumpf(sql, 'pull_workspace_sync_state');

const ZWEIG_START = "  elsif p_entity_type = 'paper_register_entry' then\n";
const ZWEIG_ENDE = "  else\n    raise exception 'Unbekannter Entity-Typ";
const zweig = upsert.slice(upsert.indexOf(ZWEIG_START), upsert.indexOf(ZWEIG_ENDE));
/** Der neue Zweig ohne Kommentare — die Kommentare nennen Verbotenes, um es zu begründen. */
const zweigCode = zweig.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

const BESTEHENDE_ZWEIGE = [
  'vorgang',
  'customer',
  'business_letter',
  'offer',
  'vorgang_note',
  'task',
  'dunning_documentation',
  'workspace',
  'workspace_settings',
  'company_setup',
  'company_profile',
  'bank_account',
  'bank_transaction',
];

describe('CLOUD-SYNC S1 — Sync-Vertrag des Papierablage-Hakens', () => {
  it('V1 — kein bestehender Dispatcher-Zweig ist verloren gegangen', () => {
    for (const name of BESTEHENDE_ZWEIGE) {
      expect(upsert, `Zweig fehlt: ${name}`).toContain(`p_entity_type = '${name}'`);
    }
    expect(upsert).toContain("raise exception 'Unbekannter Entity-Typ: %', p_entity_type;");
  });

  it('V2 — beide Funktionen sind wörtlich übernommen, nur um S1 ergänzt', () => {
    const deklaration = upsert.indexOf('  /* CLOUD-SYNC S1: nur fuer den paper_register_entry-Zweig. */\n');
    expect(deklaration).toBeGreaterThan(0);
    const ohneS1 =
      upsert.slice(0, deklaration) +
      upsert.slice(upsert.indexOf('begin\n', deklaration), upsert.indexOf(ZWEIG_START)) +
      upsert.slice(upsert.indexOf(ZWEIG_ENDE));
    expect(md5(ohneS1), 'Dispatcher weicht von 20261025120000 ab').toBe(UPSERT_VOR_S1);

    const schluessel = pull.indexOf(',\n    /*\n     * CLOUD-SYNC S1 -- Papierablage-Haken.');
    expect(schluessel).toBeGreaterThan(0);
    const pullOhneS1 = pull.slice(0, schluessel) + pull.slice(pull.indexOf('\n  );', schluessel));
    expect(md5(pullOhneS1), 'Abzug weicht von 20261026120000 ab').toBe(PULL_VOR_S1);
  });

  it('V3 — die Vorgänger-Migrationen sind unverändert', () => {
    expect(md5(rumpf(lies('20261025120000_workspace_bank_sync_contract.sql'), 'upsert_workspace_sync_entity'))).toBe(
      UPSERT_VOR_S1,
    );
    expect(md5(rumpf(lies('20261026120000_workspace_bank_reconciliation.sql'), 'pull_workspace_sync_state'))).toBe(
      PULL_VOR_S1,
    );
  });

  it('V4 — der Abzug liefert Grabsteine mit und hält die Sichtbarkeit des Dokuments', () => {
    expect(pull).toContain("'paper_register_entries', coalesce(");
    const abschnitt = pull.slice(pull.indexOf("'paper_register_entries'"));
    expect(abschnitt).toContain(
      'and (public.can_write_workspace(p_workspace_id) or pr.created_by = auth.uid())',
    );
    // Kein Grabsteinfilter — sonst bliebe der Haken eines gelöschten Dokuments stehen.
    expect(abschnitt).not.toContain('deleted = false');
    // Kein zweiter Pull-Pfad.
    expect(sql).not.toMatch(/create or replace function public\.pull_workspace_paper/);
  });

  it('V5 — dieselbe Zeilenform wie die übrigen Sync-Entitäten, Schreiben nur über die RPC', () => {
    for (const spalte of [
      'client_entry_id text not null',
      'client_document_id text null',
      "payload jsonb not null default '{}'::jsonb",
      'row_version bigint not null default 1',
      'deleted boolean not null default false',
      'deleted_at timestamptz null',
      'created_by uuid null references auth.users (id) on delete set null',
      'updated_by uuid null references auth.users (id) on delete set null',
      'unique (workspace_id, client_entry_id)',
    ]) {
      expect(sql, `Spalte/Regel fehlt: ${spalte}`).toContain(spalte);
    }
    expect(sql).toContain('alter table public.workspace_paper_register_entries enable row level security;');
    expect(sql).toContain('revoke all on public.workspace_paper_register_entries from authenticated;');
    expect(sql).toContain('grant select on public.workspace_paper_register_entries to authenticated;');
  });

  it('V6 — derselbe Versionsvertrag, kein Wiederbeleben, kein physisches Löschen', () => {
    expect(zweigCode).toContain('if v_current_version is not null and p_row_version <= 0 then');
    expect(zweigCode).toContain("'replayed', true");
    expect(zweigCode).toContain("raise exception 'Versionskonflikt paper_register_entry:%'");
    expect(zweigCode).toContain('if v_row_paper.deleted and not v_deleted then');
    expect(sql).not.toMatch(/delete\s+from\s+public\.workspace_paper_register_entries/i);
  });

  it('V7 — Rechte wie am Dokument: anlegen jedes Mitglied, fremde Zeilen und Grabsteine nur Inhaber/Admin', () => {
    expect(zweigCode).toContain('if not public.workspace_user_can_intake(p_workspace_id) then');
    expect(zweigCode).toContain('if v_deleted and not public.can_write_workspace(p_workspace_id) then');
    expect(zweigCode).toContain('and v_row_paper.created_by is distinct from auth.uid() then');
    // Kein neuer Guard, keine Finanzlogik.
    expect(zweigCode).not.toContain('assert_financial_action_allowed');
  });

  it('V8 — nach der Remote-Migration ist der Typ freigegeben und nicht mehr nur-lokal', () => {
    /*
     * Dieselbe Reihenfolge wie bei Bank Block 2B: Freigabe erst, nachdem die
     * Migration remote angewendet war. Vorher wäre jeder Versand ein
     * „Unbekannter Entity-Typ" gewesen — ein Dauerfehler in jeder offenen App.
     */
    expect(isSupabaseSyncAllowed('paper_register_entry')).toBe(true);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('paper_register_entry')).toBe(false);
  });
});
