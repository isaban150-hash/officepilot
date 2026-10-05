/**
 * BANKABGLEICH-V1 BLOCK 2B — der serverseitige Sync-Vertrag als Quelltext.
 *
 * Die eigentliche Prüfung der Migration lief gegen eine echte PostgreSQL
 * (Anlage, Retry, Konflikt, fehlendes Konto, occurrence, Pull, Isolation).
 * Diese Datei hält das Ergebnis dort fest, wo es im Alltag auffällt: Sie
 * bricht, sobald jemand einen bestehenden Dispatcher-Zweig entfernt oder die
 * Bank-Zweige wieder herausnimmt.
 *
 * Bewusst eine Prüfung am Dateiinhalt und keine zweite Datenbankanbindung —
 * ein Test, der eine laufende Datenbank braucht, läuft in der Praxis nicht mit.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_ONLY_SYNC_ENTITY_TYPES, isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20261025120000_workspace_bank_sync_contract.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

/**
 * Nur die beiden neuen Zweige.
 *
 * Die Datei enthält bewusst die elf bestehenden Zweige wörtlich mit. Eine
 * Suche über die ganze Datei würde deren Felder — etwa `invoice_id` im
 * Mahnnachweis-Zweig — fälschlich den Bankdaten zuschreiben, und den
 * erläuternden Kopfkommentar gleich mit.
 */
const bankZweige = sql.slice(
  sql.indexOf("elsif p_entity_type = 'bank_account' then"),
  sql.indexOf("raise exception 'Unbekannter Entity-Typ"),
);

/**
 * Die Bank-Zweige **ohne** Kommentare.
 *
 * Die Kommentare nennen die verbotenen Felder ausdrücklich, um zu erklären,
 * warum es sie hier nicht gibt. Eine Suche über den Kommentartext würde also
 * genau die Begründung als Verstoß werten.
 */
const bankCode = bankZweige
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*--.*$/gm, '');

/** Die elf Zweige, die es vor Block 2B schon gab. */
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
];

describe('BANKABGLEICH-02B Sync-Vertrag', () => {
  it('A1 — kein bestehender Dispatcher-Zweig ist verloren gegangen', () => {
    for (const zweig of BESTEHENDE_ZWEIGE) {
      expect(sql, `Zweig fehlt: ${zweig}`).toContain(`p_entity_type = '${zweig}'`);
    }
  });

  it('A2 — beide Bank-Zweige sind vorhanden', () => {
    expect(sql).toContain("elsif p_entity_type = 'bank_account' then");
    expect(sql).toContain("elsif p_entity_type = 'bank_transaction' then");
  });

  it('A3 — der Pull liefert beide Typen im selben Abzug', () => {
    expect(sql).toContain("'bank_accounts', coalesce(");
    expect(sql).toContain("'bank_transactions', coalesce(");
    /* Kein zweiter Pull-Pfad. */
    expect(sql).not.toContain('pull_workspace_bank_');
  });

  it('A4 — die Zeilenform entspricht den übrigen Sync-Entitäten', () => {
    expect(sql).toContain('add column if not exists payload jsonb not null');
    expect(sql).toContain('add column if not exists deleted boolean not null default false');
    expect(sql).toContain('add column if not exists updated_by uuid null');
  });

  it('A5 — das Konto muss vor seiner Bewegung existieren', () => {
    expect(sql).toContain("raise exception 'Bankkonto fehlt: %'");
    /* Und es wird ausdrücklich nicht nebenbei angelegt. */
    expect(sql).not.toMatch(/bank_transaction[\s\S]{0,4000}insert into public\.workspace_bank_accounts/);
  });

  it('A6 — der Versionsvertrag ist derselbe wie bei den übrigen Entitäten', () => {
    expect(sql).toContain("raise exception 'Versionskonflikt bank_account:%'");
    expect(sql).toContain("raise exception 'Versionskonflikt bank_transaction:%'");
    /* CREATE-RETRY-CONFLICT-02: `0` heisst „darf noch nicht existieren". */
    expect(sql).toContain('if v_current_version is not null and p_row_version <= 0 then');
    expect(sql).toContain("'replayed', true");
  });

  it('A7 — Löschen wird abgewiesen statt erfunden', () => {
    expect(sql).toContain("raise exception 'Bankkonten koennen nicht geloescht werden'");
    expect(sql).toContain("raise exception 'Bankbewegungen koennen nicht geloescht werden'");
  });

  it('A8 — die Berechtigung folgt dem bestehenden Muster, kein neuer Guard', () => {
    expect(sql).toContain('public.workspace_user_can_intake(p_workspace_id)');
    /* Keine Zahlungs-RPC angefasst. */
    for (const rpc of [
      'add_workspace_invoice_payment',
      'add_workspace_expense_payment',
      'reverse_workspace_invoice_payment',
      'reverse_workspace_expense_payment',
      'assert_financial_action_allowed',
    ]) {
      expect(bankCode, `Zahlungs-RPC berührt: ${rpc}`).not.toContain(rpc);
    }
  });

  it('A9 — die Bewegung kennt weder Rechnung noch Zahlung', () => {
    for (const feld of ['invoice_id', 'expense_id', 'payment_id', 'match_status', 'payment_status']) {
      expect(bankCode, `verbotenes Feld: ${feld}`).not.toContain(feld);
    }
  });

  it('A10 — nach der Remote-Migration sind beide Typen freigegeben', () => {
    /*
     * Der Gegenpart zu A10 in bankSyncContract02b: Beide Migrationen sind
     * remote angewendet, deshalb ist die Freigabe erteilt.
     */
    expect(isSupabaseSyncAllowed('bank_account')).toBe(true);
    expect(isSupabaseSyncAllowed('bank_transaction')).toBe(true);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('bank_account')).toBe(false);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('bank_transaction')).toBe(false);
  });

  it('A11 — die bereits remote angewendete Migration wurde nicht nachträglich verändert', () => {
    const erste = readFileSync(
      resolve(__dirname, '../../../supabase/migrations/20261024120000_workspace_bank_transactions.sql'),
      'utf8',
    );
    /* Sie darf die neuen Spalten nicht kennen — die kamen erst mit 20261025. */
    expect(erste).not.toContain('payload jsonb');
    expect(erste).not.toContain('updated_by');
  });
});
