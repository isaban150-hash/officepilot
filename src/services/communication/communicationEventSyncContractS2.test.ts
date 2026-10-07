/**
 * CLOUD-SYNC S2 — der serverseitige Sync-Vertrag des Kommunikationsverlaufs
 * als Quelltext.
 *
 * Die eigentliche Prüfung läuft gegen eine echte PostgreSQL
 * (`supabase/tests/communication_events_s2.sql`). Diese Datei hält das
 * Ergebnis dort fest, wo es im Alltag auffällt: Sie bricht, sobald jemand
 * einen bestehenden Dispatcher-Zweig verliert, die wörtliche Übernahme der
 * beiden Funktionen aufweicht, ein Löschen erfindet oder die Sichtbarkeit des
 * Abzugs lockert.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');
const lies = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');

const sql = lies('20261031120000_workspace_communication_events.sql');

function rumpf(quelle: string, funktion: string): string {
  const start = quelle.indexOf(`create or replace function public.${funktion}(`);
  expect(start, `Funktion fehlt: ${funktion}`).toBeGreaterThanOrEqual(0);
  const auf = quelle.indexOf('$$', start) + 2;
  return quelle.slice(auf, quelle.indexOf('$$;', auf));
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** Die geltenden, remote wie lokal angewendeten Rümpfe nach S1 (20261030120000). */
const UPSERT_VOR_S2 = 'c297da102e961a13fc85d21a07f72fd1';
const PULL_VOR_S2 = '17580d8b7c792cf8ccdec965e67eabf5';

const upsert = rumpf(sql, 'upsert_workspace_sync_entity');
const pull = rumpf(sql, 'pull_workspace_sync_state');

const ZWEIG_START = "  elsif p_entity_type = 'communication_event' then\n";
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
];

describe('CLOUD-SYNC S2 — Sync-Vertrag des Kommunikationsverlaufs', () => {
  it('V1 — kein bestehender Dispatcher-Zweig ist verloren gegangen, S1 eingeschlossen', () => {
    for (const name of BESTEHENDE_ZWEIGE) {
      expect(upsert, `Zweig fehlt: ${name}`).toContain(`p_entity_type = '${name}'`);
    }
    expect(upsert).toContain(ZWEIG_START);
  });

  it('V2 — beide Funktionen sind wörtlich übernommen, nur um S2 ergänzt', () => {
    const deklaration = upsert.indexOf('  /* CLOUD-SYNC S2: nur fuer den communication_event-Zweig. */\n');
    expect(deklaration).toBeGreaterThan(0);
    const ohneS2 =
      upsert.slice(0, deklaration) +
      upsert.slice(upsert.indexOf('begin\n', deklaration), upsert.indexOf(ZWEIG_START)) +
      upsert.slice(upsert.indexOf(ZWEIG_ENDE));
    expect(md5(ohneS2), 'Dispatcher weicht von 20261030120000 ab').toBe(UPSERT_VOR_S2);

    const schluessel = pull.indexOf(',\n    /*\n     * CLOUD-SYNC S2 -- Kommunikationsverlauf');
    expect(schluessel).toBeGreaterThan(0);
    const pullOhneS2 = pull.slice(0, schluessel) + pull.slice(pull.indexOf('\n  );', schluessel));
    expect(md5(pullOhneS2), 'Abzug weicht von 20261030120000 ab').toBe(PULL_VOR_S2);
  });

  it('V3 — die Vorgänger-Migration (S1) ist unverändert', () => {
    const s1 = lies('20261030120000_workspace_paper_register_entries.sql');
    expect(md5(rumpf(s1, 'upsert_workspace_sync_entity'))).toBe(UPSERT_VOR_S2);
    expect(md5(rumpf(s1, 'pull_workspace_sync_state'))).toBe(PULL_VOR_S2);
  });

  it('V4 — der Abzug ordnet nach Ereigniszeit und hält die Sichtbarkeit der Intake-Daten', () => {
    const abschnitt = pull.slice(pull.indexOf("'communication_events'"));
    expect(abschnitt).toContain('order by ce.event_at, ce.client_event_id');
    expect(abschnitt).toContain(
      'and (public.can_write_workspace(p_workspace_id) or ce.created_by = auth.uid())',
    );
    expect(sql).not.toMatch(/create or replace function public\.pull_workspace_communication/);
  });

  it('V5 — append-only: kein Update-Pfad, kein Grabstein, kein physisches Löschen', () => {
    expect(zweigCode).not.toMatch(/update\s+public\.workspace_communication_events/i);
    expect(zweigCode).toContain("raise exception 'Kommunikationsereignisse koennen nicht geloescht werden'");
    expect(zweigCode).toContain("'replayed', true");
    expect(sql).not.toMatch(/delete\s+from\s+public\.workspace_communication_events/i);
    // Die Tabelle trägt bewusst keine Grabsteinspalten.
    const tabelle = sql.slice(
      sql.indexOf('create table if not exists public.workspace_communication_events'),
      sql.indexOf('drop trigger if exists workspace_communication_events_set_updated_at'),
    );
    expect(tabelle).not.toMatch(/\bdeleted\b/);
    expect(tabelle).toContain('unique (workspace_id, client_event_id)');
  });

  it('V6 — Rechte wie bei den Intake-Daten, Schreiben nur über die RPC', () => {
    expect(zweigCode).toContain('if not public.workspace_user_can_intake(p_workspace_id) then');
    expect(zweigCode).toContain('and v_row_comm.created_by is distinct from auth.uid() then');
    expect(sql).toContain('alter table public.workspace_communication_events enable row level security;');
    expect(sql).toContain('revoke all on public.workspace_communication_events from authenticated;');
    expect(sql).toContain('grant select on public.workspace_communication_events to authenticated;');
    expect(zweigCode).not.toContain('assert_financial_action_allowed');
  });

  it('V7 — keine Berührung der E-Mail- und Versandwahrheit', () => {
    for (const fremd of ['workspace_email_', 'workspace_document_deliveries', 'workspace_mailbox']) {
      expect(zweigCode, `berührt: ${fremd}`).not.toContain(fremd);
    }
  });
});
