/**
 * OFFICEPILOT-PAYMENT-SQL-CONCURRENCY-04B2B3 — zwei Geräte, ein Klick.
 *
 * Der bisherige Add-RPC prüfte erst und fügte dann ein. Zwischen beiden
 * Schritten passt ein zweiter Request: Beide sehen nichts, beide fügen ein,
 * einer bekommt eine Unique-Violation statt des zugesagten idempotenten
 * Erfolgs.
 *
 * **Was dieser Test beweisen kann und was nicht:** Echte Nebenläufigkeit
 * braucht eine echte Datenbank. Vitest hat keine. Geprüft wird deshalb
 * zweierlei — die *Struktur* des SQL, das die Race-Sicherheit trägt, und das
 * *Client-Verhalten* an den Ausgängen, die der RPC dann meldet. Der Beweis,
 * dass zwei gleichzeitige Transaktionen sich tatsächlich so verhalten, steht
 * erst beim Supabase-Test aus. Hier wird keine Concurrency-Garantie behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addInvoicePaymentToCloud } from './invoice/workspaceInvoicePaymentCloudService';
import * as supabaseLib from '../lib/supabase';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250826120000_workspace_invoice_payment_cloud.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

/** Nur der Rumpf des Add-RPC — nicht Reversal, nicht Pull. */
const addFunction = (() => {
  const start = sql.indexOf('create or replace function public.add_workspace_invoice_payment');
  const end = sql.indexOf('create or replace function public.reverse_workspace_invoice_payment');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

const WORKSPACE = '00000000-0000-4000-8000-00000000b2b3';
const INVOICE_ID = 'inv-sql-race';
const PAYMENT_ID = 'pay-123456789';

const request = {
  clientInvoiceId: INVOICE_ID,
  clientPaymentId: PAYMENT_ID,
  amount: 10000,
  paidOn: '2026-08-25',
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    workspace_id: WORKSPACE,
    client_invoice_id: INVOICE_ID,
    client_payment_id: PAYMENT_ID,
    amount: 10000,
    paid_on: '2026-08-25',
    reference: null,
    note: null,
    created_at: '2026-08-25T09:00:00.000Z',
    updated_at: '2026-08-25T09:00:00.000Z',
    row_version: 1,
    reversed_at: null,
    ...overrides,
  };
}

function stubRpc(handler: () => unknown) {
  return { rpc: vi.fn(async () => ({ data: handler(), error: null })) } as never;
}

function stubRpcError(message: string) {
  return { rpc: vi.fn(async () => ({ data: null, error: { message } })) } as never;
}

const override = { workspaceId: WORKSPACE };

describe('OFFICEPILOT-PAYMENT-SQL-CONCURRENCY-04B2B3', () => {
  beforeEach(() => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ---------------------------------------------------------------------- */
  /* SQL-Struktur: der Träger der Race-Sicherheit                            */
  /* ---------------------------------------------------------------------- */

  it('B3-A: der Add-RPC fügt zuerst ein und prüft erst danach', () => {
    // Insert-First mit Konfliktziel auf genau dem Eindeutigkeitsschlüssel.
    expect(addFunction).toContain(
      'on conflict (workspace_id, client_invoice_id, client_payment_id) do nothing',
    );

    const insertAt = addFunction.indexOf('insert into public.workspace_invoice_payments');
    const lockAt = addFunction.indexOf('for update');
    expect(insertAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(-1);
    /*
     * Die Reihenfolge ist der ganze Punkt: Erst der Insert, der den
     * Eindeutigkeitsschlüssel selbst als Sperre benutzt, dann die Sperre auf
     * die fremde Zeile. Ein vorgelagertes `select … for update` kann nichts
     * sperren, was es noch nicht sieht.
     */
    expect(insertAt).toBeLessThan(lockAt);
  });

  it('B3-B: der Konfliktfall lädt die bestehende Zeile und prüft sie fachlich', () => {
    expect(addFunction).toContain('for update');
    // Vergleich genau der vier fachlichen Felder — keine Dedup über Betrag/Datum.
    expect(addFunction).toContain('v_existing.amount is distinct from round(p_amount, 2)');
    expect(addFunction).toContain('v_existing.paid_on is distinct from v_paid_on::date');
    expect(addFunction).toContain('v_existing.reference is distinct from v_reference');
    expect(addFunction).toContain('v_existing.note is distinct from v_note');
    expect(addFunction).toContain('Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten');
    // Und der Schlüssel selbst begrenzt die Suche.
    expect(addFunction).toContain('where workspace_id = p_workspace_id');
    expect(addFunction).toContain('and client_invoice_id = v_invoice_id');
    expect(addFunction).toContain('and client_payment_id = v_payment_id');
  });

  it('B3-D: eine stornierte Zahlung wird nicht wiederbelebt', () => {
    expect(addFunction).toContain('v_existing.reversed_at is not null');
    expect(addFunction).toContain('Zahlungskonflikt: diese Zahlung wurde storniert');
    /*
     * Der Grabsteinvorrang muss **vor** dem Inhaltsvergleich greifen: Sonst
     * würde eine inhaltlich identische Wiederholung die Stornierung als
     * stillen Erfolg überspielen.
     */
    const tombstoneAt = addFunction.indexOf('v_existing.reversed_at is not null');
    const compareAt = addFunction.indexOf('v_existing.amount is distinct from');
    expect(tombstoneAt).toBeLessThan(compareAt);
    // Die bestehende Zeile bleibt unberührt — kein Update im Add-Pfad.
    expect(addFunction).not.toContain('update public.workspace_invoice_payments');
  });

  it('B3-F: die Insert-Nachbedingung bildet den vollständigen Request ab', () => {
    for (const clause of [
      'v_inserted.workspace_id is distinct from p_workspace_id',
      'v_inserted.client_invoice_id is distinct from v_invoice_id',
      'v_inserted.client_payment_id is distinct from v_payment_id',
      'v_inserted.amount is distinct from round(p_amount, 2)',
      'v_inserted.paid_on is distinct from v_paid_on::date',
      'v_inserted.reference is distinct from v_reference',
      'v_inserted.note is distinct from v_note',
      'v_inserted.reversed_at is not null',
    ]) {
      expect(addFunction).toContain(clause);
    }
    expect(addFunction).toContain('Zahlung Nachbedingung verletzt');
  });

  it('B3-G: ein leeres Insert-Ergebnis gilt nicht als Erfolg', () => {
    /*
     * `do nothing` liefert keine Zeile. Genau dann darf der RPC nicht
     * zurückkehren, sondern muss die bestehende Zeile laden und bewerten.
     */
    expect(addFunction).toContain('if v_inserted.id is not null then');
    expect(addFunction).toContain('Zahlung nicht angelegt');
  });

  /* ---------------------------------------------------------------------- */
  /* Client-Verhalten an den Ausgängen, die der RPC meldet                   */
  /* ---------------------------------------------------------------------- */

  it('B3-C: eine Wiederholung mit identischen Daten ist ein idempotenter Erfolg', async () => {
    const client = stubRpc(() => [row()]);
    const first = await addInvoicePaymentToCloud(request, { ...override, client });
    const second = await addInvoicePaymentToCloud(request, { ...override, client });

    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('synced');
    expect(second.row?.clientPaymentId).toBe(PAYMENT_ID);
    expect(second.row?.reversedAt).toBeUndefined();
  });

  it('B3-E: identische reference und note bleiben ein Erfolg', async () => {
    const client = stubRpc(() => [row({ reference: 'Überweisung', note: 'Restzahlung' })]);
    const result = await addInvoicePaymentToCloud(
      { ...request, reference: 'Überweisung', note: 'Restzahlung' },
      { ...override, client },
    );

    expect(result.outcome).toBe('synced');
    expect(result.row?.reference).toBe('Überweisung');
    expect(result.row?.note).toBe('Restzahlung');
  });

  it('B3-F2: eine abweichende reference meldet der RPC als Konflikt', async () => {
    const result = await addInvoicePaymentToCloud(
      { ...request, reference: 'Bar' },
      {
        ...override,
        client: stubRpcError('Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten'),
      },
    );

    expect(result.outcome).toBe('conflict');
    expect(result.row).toBeUndefined();
  });

  it('B3-D2: der Add nach einem Reversal ist kein stiller Erfolg', async () => {
    const result = await addInvoicePaymentToCloud(request, {
      ...override,
      client: stubRpcError('Zahlungskonflikt: diese Zahlung wurde storniert'),
    });

    expect(result.outcome).toBe('conflict');
    expect(result.row).toBeUndefined();
  });

  it('B3-H: eine reversierte Zeile als Antwort ist niemals ein Add-Erfolg', async () => {
    const result = await addInvoicePaymentToCloud(request, {
      ...override,
      client: stubRpc(() => [row({ reversed_at: '2026-08-26T10:00:00.000Z' })]),
    });

    // Selbst wenn die Datenbank so etwas zurückgäbe: Der Client glaubt es nicht.
    expect(result.outcome).toBe('failed');
  });
});
