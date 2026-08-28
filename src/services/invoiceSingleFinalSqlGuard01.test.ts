/**
 * OFFICEPILOT-SINGLE-FINAL-INVOICE-INVARIANT-01D — die Serverseite.
 *
 * Ein Client-Guard schützt nur, was seine Origin kennt. Gerät B kann die
 * Schlussrechnung von Gerät A schlicht nicht gezogen haben — cross-origin ist
 * allein der Server verlässlich.
 *
 * **Was diese Tests beweisen können und was nicht:** Echte Nebenläufigkeit
 * braucht eine echte Datenbank; Vitest hat keine. Geprüft wird die *Struktur*
 * des SQL — Reihenfolge, Bedingung, Fehlername, Index. Dass PostgreSQL sich
 * zur Laufzeit so verhält, steht erst beim Dry-Run fest. Hier wird keine
 * Laufzeitgarantie behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyInvoiceCloudErrorForTests,
  type WorkspaceInvoiceCloudErrorCode,
} from './invoice/workspaceInvoiceCloudService';
import { mapCloudErrorForTests } from './invoice/invoicePreparedFinalizeService';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250828120000_workspace_single_final_invoice_guard.sql',
);
const sql = (() => {
  try {
    return readFileSync(migrationPath, 'utf8');
  } catch {
    return '';
  }
})();

/** Nur der Rumpf der neu geschriebenen Finalize-Funktion. */
const finalizeFunction = (() => {
  const start = sql.indexOf('create or replace function public.finalize_workspace_invoice');
  return start >= 0 ? sql.slice(start) : '';
})();

describe('OFFICEPILOT-SINGLE-FINAL-INVOICE-SQL-01D', () => {
  it('A: der partielle Unique-Index lässt nur eine Schlussrechnung je Vorgang zu', () => {
    expect(sql).toContain('workspace_invoices_single_final_invoice');
    expect(sql).toContain('on public.workspace_invoices (workspace_id, vorgang_id)');
    expect(sql).toContain("invoice_type = 'schluss'");
    expect(sql).toContain("invoice_status in ('vorbereitet', 'versendet')");
  });

  it('B: der Serverguard meldet einen benennbaren Fehler', () => {
    expect(finalizeFunction).toContain('invoice_final_already_exists');
    expect(finalizeFunction).toContain('client_invoice_id <> trim(p_client_invoice_id)');
  });

  it('C: der Idempotenz-Replay steht vor dem neuen Guard', () => {
    /*
     * Die Reihenfolge ist der Kern: Ein Wiederholungslauf nach verlorener
     * Antwort muss den bestehenden Erfolg zurückbekommen, nicht den neuen
     * Fehler. Dasselbe Muster nutzt `confirm_workspace_order_amendment`
     * bereits — dort steht es sogar als Kommentar.
     */
    const replayAt = finalizeFunction.indexOf("'idempotent_replay', true");
    const guardAt = finalizeFunction.indexOf('invoice_final_already_exists');
    expect(replayAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(replayAt);
  });

  it('D: der bestehende Vorgangs-Lock wird wiederverwendet, nicht ersetzt', () => {
    const lockAt = finalizeFunction.indexOf('from public.workspace_vorgaenge');
    const replayAt = finalizeFunction.indexOf("'idempotent_replay', true");
    expect(lockAt).toBeGreaterThan(-1);
    expect(finalizeFunction).toContain('for update');
    // Sperre vor Replay vor Guard — sonst reiht die Sperre nichts.
    expect(lockAt).toBeLessThan(replayAt);
    // Kein zweiter, erfundener Sperrmechanismus.
    expect(finalizeFunction).not.toContain('pg_advisory');
  });

  it('E: Nachtrags-, Idempotenz- und Nummernkreislogik bleiben unverändert', () => {
    expect(finalizeFunction).toContain("raise exception 'invoice_amendment_state_stale'");
    expect(finalizeFunction).toContain('select coalesce(max(a.sequence_no), 0)');
    expect(finalizeFunction).toContain(
      'public.normalize_workspace_invoice_payload_for_idempotency',
    );
    expect(finalizeFunction).toContain('Nummernkreis konnte nicht gesperrt werden');
    // Die Normalisierungsfunktion selbst wird nicht neu geschrieben.
    expect(sql).not.toContain(
      'create or replace function public.normalize_workspace_invoice_payload_for_idempotency',
    );
  });

  it('F: die Migration repariert keine Altbestände', () => {
    for (const forbidden of ['delete from public.workspace_invoices', 'update public.workspace_invoices set']) {
      expect(sql.toLowerCase()).not.toContain(forbidden);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Fehlerabbildung bis zum Aufrufer                                        */
  /* ---------------------------------------------------------------------- */

  it('G: der Cloud-Dienst erkennt den Serverfehler', () => {
    const classified = classifyInvoiceCloudErrorForTests({
      message: 'invoice_final_already_exists',
    });
    const expected: WorkspaceInvoiceCloudErrorCode = 'final_invoice_exists';
    expect(classified.code).toBe(expected);
    expect(classified.retryable).toBe(false);
  });

  it('G2: auch der Unique-Index als Backstop führt zu demselben Fehler', () => {
    const classified = classifyInvoiceCloudErrorForTests({
      message:
        'duplicate key value violates unique constraint "workspace_invoices_single_final_invoice"',
      code: '23505',
    });
    expect(classified.code).toBe('final_invoice_exists');
  });

  it('G3: ein anderer Unique-Verstoß wird nicht als Schlussrechnungsfehler ausgegeben', () => {
    const classified = classifyInvoiceCloudErrorForTests({
      message: 'duplicate key value violates unique constraint "workspace_invoices_number_unique"',
      code: '23505',
    });
    expect(classified.code).not.toBe('final_invoice_exists');
  });

  it('H: der Aufrufer erhält einen benennbaren Grund ohne ungewissen Cloudzustand', () => {
    const mapped = mapCloudErrorForTests('final_invoice_exists', 'invoice_final_already_exists');
    expect(mapped.reason).toBe('final_invoice_exists');
    /*
     * Der Guard läuft **vor** dem Insert der neuen Kennung — für diese
     * Finalisierung wurde sicher nichts geschrieben. `unknown` würde den
     * Entwurf grundlos sperren.
     */
    expect(mapped.cloudState).toBe('not_committed');
  });

  it('H2: der Nachtragsfehler bleibt unverändert abgebildet', () => {
    const mapped = mapCloudErrorForTests('unknown', 'invoice_amendment_state_stale');
    expect(mapped.reason).toBe('amendment_state_stale');
    expect(mapped.cloudState).toBe('not_committed');
  });
});
