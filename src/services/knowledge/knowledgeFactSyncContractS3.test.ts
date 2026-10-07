/**
 * CLOUD-SYNC S3 — der serverseitige Sync-Vertrag des bestätigten Wissens als
 * Quelltext.
 *
 * Die eigentliche Prüfung läuft gegen eine echte PostgreSQL
 * (`supabase/tests/knowledge_facts_s3.sql`). Diese Datei hält das Ergebnis
 * dort fest, wo es im Alltag auffällt: Sie bricht, sobald jemand einen
 * bestehenden Dispatcher-Zweig verliert, die wörtliche Übernahme der beiden
 * Funktionen aufweicht, ein physisches Löschen oder ein Wiederbeleben erfindet
 * oder die Sichtbarkeit des Abzugs verändert.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');
const lies = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');

const sql = lies('20261101120000_workspace_knowledge_facts.sql');

function rumpf(quelle: string, funktion: string): string {
  const start = quelle.indexOf(`create or replace function public.${funktion}(`);
  expect(start, `Funktion fehlt: ${funktion}`).toBeGreaterThanOrEqual(0);
  const auf = quelle.indexOf('$$', start) + 2;
  return quelle.slice(auf, quelle.indexOf('$$;', auf));
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** Die geltenden, remote wie lokal angewendeten Rümpfe nach S2 (20261031120000). */
const UPSERT_VOR_S3 = '77b5cc0ccd5973f998a29fca2e63b896';
const PULL_VOR_S3 = '1982ea0fd4ab3cdf20960dce35eedd31';

const upsert = rumpf(sql, 'upsert_workspace_sync_entity');
const pull = rumpf(sql, 'pull_workspace_sync_state');

const ZWEIG_START = "  elsif p_entity_type = 'knowledge_fact' then\n";
const ZWEIG_ENDE = "  else\n    raise exception 'Unbekannter Entity-Typ";
const zweig = upsert.slice(upsert.indexOf(ZWEIG_START), upsert.indexOf(ZWEIG_ENDE));
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
  'paper_register_entry',
  'communication_event',
];

describe('CLOUD-SYNC S3 — Sync-Vertrag des bestätigten Wissens', () => {
  it('V1 — kein bestehender Dispatcher-Zweig ist verloren gegangen, S1 und S2 eingeschlossen', () => {
    for (const name of BESTEHENDE_ZWEIGE) {
      expect(upsert, `Zweig fehlt: ${name}`).toContain(`p_entity_type = '${name}'`);
    }
    expect(upsert).toContain(ZWEIG_START);
  });

  it('V2 — beide Funktionen sind wörtlich übernommen, nur um S3 ergänzt', () => {
    const deklaration = upsert.indexOf('  /* CLOUD-SYNC S3: nur fuer den knowledge_fact-Zweig. */\n');
    expect(deklaration).toBeGreaterThan(0);
    const ohneS3 =
      upsert.slice(0, deklaration) +
      upsert.slice(upsert.indexOf('begin\n', deklaration), upsert.indexOf(ZWEIG_START)) +
      upsert.slice(upsert.indexOf(ZWEIG_ENDE));
    expect(md5(ohneS3), 'Dispatcher weicht von 20261031120000 ab').toBe(UPSERT_VOR_S3);

    const schluessel = pull.indexOf(',\n    /*\n     * CLOUD-SYNC S3 -- bestaetigtes Wissen');
    expect(schluessel).toBeGreaterThan(0);
    const pullOhneS3 = pull.slice(0, schluessel) + pull.slice(pull.indexOf('\n  );', schluessel));
    expect(md5(pullOhneS3), 'Abzug weicht von 20261031120000 ab').toBe(PULL_VOR_S3);
  });

  it('V3 — die Vorgänger-Migration (S2) ist unverändert', () => {
    const s2 = lies('20261031120000_workspace_communication_events.sql');
    expect(md5(rumpf(s2, 'upsert_workspace_sync_entity'))).toBe(UPSERT_VOR_S3);
    expect(md5(rumpf(s2, 'pull_workspace_sync_state'))).toBe(PULL_VOR_S3);
  });

  it('V4 — der Abzug trägt Grabsteine mit und zeigt das Wissen jedem aktiven Mitglied', () => {
    const abschnitt = pull.slice(pull.indexOf("'knowledge_facts'"));
    expect(abschnitt).toContain('from public.workspace_knowledge_facts kf');
    expect(abschnitt).toContain('where kf.workspace_id = p_workspace_id),');
    // Kein Filter auf Grabsteine, keine Einschränkung auf selbst Angelegtes.
    expect(abschnitt).not.toMatch(/kf\.deleted/);
    expect(abschnitt).not.toContain('created_by');
    expect(sql).not.toMatch(/create or replace function public\.pull_workspace_knowledge/);
  });

  it('V5 — Versionsvertrag wie bei den Notizen: Replay, Konflikt, kein Wiederbeleben, kein physisches Löschen', () => {
    expect(zweigCode).toContain('if v_current_version is not null and p_row_version <= 0 then');
    expect(zweigCode).toContain("'replayed', true");
    expect(zweigCode).toContain('if p_row_version > 0 and p_row_version <> v_current_version then');
    expect(zweigCode).toContain('if v_row_fact.deleted and not v_deleted then');
    expect(zweigCode).toContain("raise exception 'Versionskonflikt knowledge_fact:%'");
    expect(zweigCode).toContain('row_version = row_version + 1');
    expect(sql).not.toMatch(/delete\s+from\s+public\.workspace_knowledge_facts/i);
    const tabelle = sql.slice(
      sql.indexOf('create table if not exists public.workspace_knowledge_facts'),
      sql.indexOf('drop trigger if exists workspace_knowledge_facts_set_updated_at'),
    );
    expect(tabelle).toContain('deleted boolean not null default false');
    expect(tabelle).toContain('deleted_at timestamptz null');
    expect(tabelle).toContain('unique (workspace_id, client_fact_id)');
  });

  it('V6 — Rechte wie bei den Vorgangsnotizen, Schreiben nur über die RPC', () => {
    expect(zweigCode).toContain('if not public.workspace_user_can_intake(p_workspace_id) then');
    // Jedes aktive Mitglied darf Wissen ändern — keine Einschränkung auf den Anleger.
    expect(zweigCode).not.toContain('created_by is distinct from auth.uid()');
    expect(zweigCode).not.toContain('assert_financial_action_allowed');
    expect(sql).toContain('alter table public.workspace_knowledge_facts enable row level security;');
    expect(sql).toContain('using (public.is_active_workspace_member(workspace_id));');
    expect(sql).toContain('revoke all on public.workspace_knowledge_facts from public, anon;');
    expect(sql).toContain('revoke all on public.workspace_knowledge_facts from authenticated;');
    expect(sql).toContain('grant select on public.workspace_knowledge_facts to authenticated;');
  });

  it('V7 — nur eine neue Tabelle; Gedächtnis, Nachweise und Beziehungen bleiben unberührt', () => {
    expect(sql.match(/create table/gi)).toHaveLength(1);
    for (const fremd of ['document_memor', 'proof_memor', 'memory_relation', 'mail_import']) {
      expect(zweigCode, `berührt: ${fremd}`).not.toContain(fremd);
    }
  });
});
