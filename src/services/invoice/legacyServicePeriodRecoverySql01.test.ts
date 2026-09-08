/**
 * LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B — was die Datenbank selbst garantiert.
 *
 * Zwei schmale RPCs kommen hinzu: eine Bestätigung, die ausschliesslich `true`
 * schreiben kann, und ein Einzelread, der nur den Bestätigungszustand einer
 * einzigen Rechnung liefert.
 *
 * **Was diese Tests beweisen können und was nicht:** Vitest hat keine Datenbank.
 * Geprüft wird die *Struktur* des SQL, das die Invarianten trägt. Dass
 * PostgreSQL sich zur Laufzeit so verhält, steht erst beim Dry-Run fest. Hier
 * wird keine Laufzeitgarantie behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250903120000_workspace_invoice_service_period_confirmation.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

function functionBody(header: string): string {
  const start = sql.indexOf(header);
  expect(start, `${header} fehlt`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$$;', start);
  expect(end, `${header} ist nicht abgeschlossen`).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const confirmFn = functionBody(
  'create or replace function public.confirm_workspace_invoice_service_period',
);
const readFn = functionBody(
  'create or replace function public.get_workspace_invoice_service_period_confirmation',
);

describe('SP-RECOVERY-SQL — gemeinsame Sicherheitsgrenze', () => {
  it('S1: beide RPCs laufen als security definer mit festem search_path', () => {
    for (const [name, body] of [
      ['confirm', confirmFn],
      ['read', readFn],
    ] as const) {
      expect(body, name).toContain('security definer');
      expect(body, name).toContain('set search_path = public');
    }
  });

  it('S2: beide RPCs verlangen eine Anmeldung und aktive Mitgliedschaft', () => {
    for (const [name, body] of [
      ['confirm', confirmFn],
      ['read', readFn],
    ] as const) {
      expect(body, name).toContain('auth.uid()');
      expect(body, name).toContain("raise exception 'Nicht angemeldet'");
      expect(body, name).toContain('public.is_active_workspace_member(p_workspace_id)');
      expect(body, name).toContain("raise exception 'Kein Zugriff auf Workspace'");
    }
  });

  it('S3: die Identität ist workspace_id + client_invoice_id, nie die Rechnungsnummer', () => {
    for (const [name, body] of [
      ['confirm', confirmFn],
      ['read', readFn],
    ] as const) {
      expect(body, name).toContain('workspace_id = p_workspace_id');
      expect(body, name).toContain('client_invoice_id = trim(p_client_invoice_id)');
      expect(body, name).not.toContain('invoice_number =');
    }
  });

  it('S4: die Rechte folgen dem bestehenden Muster', () => {
    for (const signature of [
      'public.confirm_workspace_invoice_service_period(uuid, text)',
      'public.get_workspace_invoice_service_period_confirmation(uuid, text)',
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public`);
      expect(sql).toContain(`grant execute on function ${signature} to authenticated`);
    }
  });
});

describe('SP-RECOVERY-SQL — Confirm ist monoton und schmal', () => {
  it('R22: es gibt keinen Boolean-Parameter — false ist serverseitig unmöglich', () => {
    const header = sql.slice(
      sql.indexOf('create or replace function public.confirm_workspace_invoice_service_period'),
      sql.indexOf(')', sql.indexOf('create or replace function public.confirm_workspace_invoice_service_period')),
    );
    expect(header).toContain('p_workspace_id uuid');
    expect(header).toContain('p_client_invoice_id text');
    expect(header).not.toContain('boolean');
    expect(confirmFn).not.toContain("'servicePeriodConfirmed', false");
    expect(confirmFn).not.toContain("'servicePeriodConfirmed', p_");
  });

  it('R19: der Payload wird gezielt ergänzt, nicht ersetzt', () => {
    expect(confirmFn).toContain('payload = payload');
    expect(confirmFn).toContain("jsonb_build_object('servicePeriodConfirmed', true)");
    // Kein Überschreiben des gesamten Payloads.
    expect(confirmFn).not.toMatch(/payload\s*=\s*p_/);
    expect(confirmFn).not.toMatch(/payload\s*=\s*jsonb_build_object/);
  });

  it('R20: kein anderer Payload-Schlüssel und keine andere Spalte wird geschrieben', () => {
    /*
     * Geprüft wird das UPDATE selbst, nicht die Funktion insgesamt: Der
     * Finalisierungs-Guard *liest* `invoice_status`, und das ist richtig so.
     */
    const updateStart = confirmFn.indexOf('update public.workspace_invoices');
    expect(updateStart).toBeGreaterThan(0);
    const update = confirmFn.slice(
      updateStart,
      confirmFn.indexOf('where id = v_existing.id', updateStart),
    );
    expect(update.length).toBeGreaterThan(0);
    for (const forbidden of [
      'invoice_number =',
      'invoice_sequence_number =',
      'invoice_type =',
      'invoice_status =',
      'vorgang_id =',
      "'status'",
      "'sentAt'",
      "'payments'",
      "'archiveDocumentId'",
    ]) {
      expect(update, forbidden).not.toContain(forbidden);
    }
  });

  it('S5: die Rechnung wird gesperrt, muss existieren und darf kein Entwurf sein', () => {
    expect(confirmFn).toContain('for update');
    expect(confirmFn).toContain("raise exception 'Rechnung nicht gefunden'");
    expect(confirmFn).toContain("invoice_status = 'entwurf'");
    expect(confirmFn).toContain("raise exception 'Rechnung nicht finalisiert'");
  });

  it('S6: row_version, updated_at und updated_by folgen dem Sent-Muster', () => {
    expect(confirmFn).toContain('row_version = row_version + 1');
    expect(confirmFn).toContain('updated_at = now()');
    expect(confirmFn).toContain('updated_by = v_user_id');
  });

  it('R21: ein bereits bestätigter Datensatz wird nicht erneut geschrieben', () => {
    // Der Noop-Zweig gibt die Zeile zurück, ohne row_version zu erhöhen.
    expect(confirmFn).toContain("v_existing.payload->>'servicePeriodConfirmed' = 'true'");
    expect(confirmFn).toContain('return query');
  });

  it('S7: kein Re-Finalize und keine Neuanlage', () => {
    for (const forbidden of [
      'finalize_workspace_invoice',
      'insert into public.workspace_invoices',
      'workspace_invoice_sequences',
      'normalize_workspace_invoice_payload_for_idempotency',
    ]) {
      expect(confirmFn, forbidden).not.toContain(forbidden);
    }
  });
});

describe('SP-RECOVERY-SQL — Read ist eng begrenzt', () => {
  it('R23/R38: der Read liefert nur den Bestätigungszustand, nicht den Payload', () => {
    expect(readFn).toContain("'found'");
    expect(readFn).toContain("'service_period_confirmed'");
    // Kein vollständiger Rechnungsinhalt verlässt den Server auf diesem Weg.
    expect(readFn).not.toContain("'payload', ");
    expect(readFn).not.toContain('jsonb_agg');
  });

  it('R36: genau eine Rechnung, keine Liste', () => {
    expect(readFn).toContain('p_client_invoice_id');
    expect(readFn).not.toContain('order by');
    expect(readFn).not.toContain('limit ');
  });

  it('S8: der Read schreibt nicht', () => {
    for (const forbidden of ['update ', 'insert ', 'delete ']) {
      expect(readFn, forbidden).not.toContain(forbidden);
    }
  });
});

describe('SP-RECOVERY-SQL — keine Massenänderung', () => {
  it('R51: keine Datenmigration bestätigt Bestandsrechnungen', () => {
    // Jedes UPDATE trifft genau eine, zuvor gesperrte Zeile.
    const updates = sql.match(/update public\.workspace_invoices[\s\S]*?;/g) ?? [];
    expect(updates.length).toBe(1);
    for (const statement of updates) {
      expect(statement).toContain('where id = v_existing.id');
    }
  });

  it('S9: keine neue Tabelle, Spalte oder Policy', () => {
    for (const forbidden of ['create table', 'add column', 'create policy', 'alter table']) {
      expect(sql.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});
