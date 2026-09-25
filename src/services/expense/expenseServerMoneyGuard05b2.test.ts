/**
 * FINANZCORE-05B2 — die Clientseite des serverseitigen Geldguards.
 *
 * Der eigentliche Beweis liegt in `supabase/tests/expense_money_integrity_05b2.sql`:
 * Nur eine echte Datenbank kann zeigen, dass ein widersprüchlicher Betrag
 * abgelehnt und ein ungültiger Altbeleg trotzdem löschbar bleibt. Hier steht,
 * was Vitest tatsächlich beweisen kann — und was sonst still auseinanderliefe:
 *
 *   - dass Client und Server **dieselben** Regeln meinen, obwohl sie jetzt
 *     zweimal geschrieben sind (TypeScript und SQL),
 *   - dass der Server überhaupt die Felder zu sehen bekommt, die er prüft,
 *   - dass eine Ablehnung **nicht** wiederholt wird,
 *   - und dass die Migration nichts anfasst, was sie nichts angeht.
 *
 * Bewusst **nicht** wiederholt: die Regeln selbst. Die sind in
 * `expenseMoneyIntegrity05b.test.ts` bewiesen.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExpensePushPayload,
  rpcUpsertWorkspaceExpense,
} from './expenseCloudSyncService';
import { isZeroRateTaxStatus } from './expenseMoneyIntegrity';
import { normalizeExpense } from '../expenseNormalize';
import { WorkspaceCloudError } from '../workspace/workspaceCloudService';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Expense } from '../../types/expense';
import type { TaxStatus } from '../../types/models';

const REPO = path.resolve(__dirname, '../../..');
const MIGRATION_PATH = 'supabase/migrations/20261007120000_workspace_expense_money_integrity.sql';
const MIGRATION = readFileSync(path.join(REPO, MIGRATION_PATH), 'utf8');

/** Nur der Rumpf der Ausgabenfunktion — die Kopfkommentare zählen nicht. */
const FUNKTION = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.upsert_workspace_expense'));

const ALLE_STATUS: readonly TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-1',
    title: '05B2 TEST',
    issueDate: '2026-06-01',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

/* ================================================================== */

describe('A — Client und Server meinen dieselben Regeln', () => {
  /*
   * Die Nullsatz-Liste steht jetzt an zwei Stellen: im Client als Ableitung
   * aus `getTaxRateForStatus`, im SQL als aufgezählte Liste. Läuft sie
   * auseinander, lehnt der Server etwas ab, was der Client erlaubt — oder
   * umgekehrt, und der Guard wäre löchrig.
   *
   * Geprüft wird über **alle** Steuerstatus, nicht über eine Auswahl: Kommt
   * später einer hinzu, fällt dieser Test um, statt still eine Lücke zu lassen.
   */
  it('T1: die Nullsatz-Status im SQL sind genau die des Clients', () => {
    const imSql = ALLE_STATUS.filter((status) =>
      new RegExp(`'${status}'`).test(
        FUNKTION.slice(
          FUNKTION.indexOf("v_tax_status in ("),
          FUNKTION.indexOf('expense_money_tax_on_zero_rate_status'),
        ),
      ),
    );
    const imClient = ALLE_STATUS.filter((status) => isZeroRateTaxStatus(status));

    expect([...imSql].sort()).toEqual([...imClient].sort());
    // Die Erwartung ausgeschrieben, damit ein Wegfall auffällt.
    expect([...imClient].sort()).toEqual(['kleinunternehmer_19', 'reverse_charge_13b', 'tax_free']);
  });

  /*
   * T2 — `unclear` steht bewusst nicht in der Liste. Der Status sagt
   * „unbekannt", nicht „keine Steuer"; aus Unwissen einen Nullbetrag zu
   * erzwingen wäre eine erfundene Steuerbehandlung.
   */
  it('T2: unclear löst auf beiden Seiten keine Nullsatzregel aus', () => {
    expect(isZeroRateTaxStatus('unclear')).toBe(false);
    const zweig = FUNKTION.slice(
      FUNKTION.indexOf("v_tax_status in ("),
      FUNKTION.indexOf('expense_money_tax_on_zero_rate_status'),
    );
    expect(zweig).not.toContain("'unclear'");
  });

  /*
   * T3 — der konkrete Steuersatz wird serverseitig **nicht** erzwungen. Das
   * Modell trägt einen Status und einen Steuerbetrag je Beleg; ein gemischter
   * Beleg (Hotelrechnung 7 % und 19 %) ist darin nicht darstellbar. Eine
   * Satzregel machte echte Belege unbuchbar.
   */
  it('T3: der Server erzwingt keinen 19-%- oder 7-%-Satz', () => {
    expect(FUNKTION).not.toMatch(/0\.19|\b19\b\s*\/\s*100|\* *0,19/);
    expect(FUNKTION).not.toContain('expense_money_tax_rate');
  });

  /*
   * T4 — gerechnet wird in Cent auf NUMERIC, wie im Client (`toCents`).
   * Gleitkomma brächte eine stille Toleranz hinein, die niemand sieht.
   */
  it('T4: der Server rechnet in Cent auf NUMERIC, nicht in Gleitkomma', () => {
    expect(MIGRATION).toContain('round(v_num * 100)::bigint');
    expect(MIGRATION).toMatch(/v_num numeric/);
    expect(MIGRATION).not.toMatch(/\b(float|double precision|real)\b/);
  });
});

describe('B — der Server bekommt, was er prüft', () => {
  /*
   * Der Guard liest vier Felder aus `p_payload->'payload'`. Nennt der Client
   * sie anders oder lässt er eines weg, prüfte der Server ins Leere und
   * lehnte jede Ausgabe als „unbrauchbar" ab.
   */
  it('T5: die vier Geldfelder stehen unter den Namen im Payload, die das SQL liest', () => {
    const payload = buildExpensePushPayload(ausgabe(), false) as {
      payload: Record<string, unknown>;
    };

    for (const feld of ['netAmount', 'taxAmount', 'grossAmount', 'taxStatus'] as const) {
      expect(payload.payload, `${feld} fehlt im Push`).toHaveProperty(feld);
      expect(FUNKTION, `${feld} wird vom SQL nicht gelesen`).toContain(`'${feld}'`);
    }

    expect(payload.payload.netAmount).toBe(100);
    expect(payload.payload.taxAmount).toBe(19);
    expect(payload.payload.grossAmount).toBe(119);
    expect(payload.payload.taxStatus).toBe('standard_19');
  });

  /*
   * T6 — auch die Gutschrift reist unverfälscht. Ein Vorzeichen, das unterwegs
   * verloren ginge, machte aus einer stimmigen Gutschrift einen Verstoß.
   */
  it('T6: eine Gutschrift behält ihre negativen Beträge im Push', () => {
    const payload = buildExpensePushPayload(
      ausgabe({ netAmount: -100, taxAmount: -19, grossAmount: -119 }),
      false,
    ) as { payload: Record<string, unknown> };

    expect(payload.payload.netAmount).toBe(-100);
    expect(payload.payload.taxAmount).toBe(-19);
    expect(payload.payload.grossAmount).toBe(-119);
  });

  /*
   * T7 — der Grabstein. Der Server prüft beim Löschen bewusst nicht, und der
   * Client schickt dabei auch keine Beträge, auf die er sich verlassen müsste.
   */
  it('T7: ein Löschauftrag ist als solcher erkennbar', () => {
    const payload = buildExpensePushPayload(ausgabe(), true);
    expect(payload.deleted).toBe(true);
    expect(FUNKTION).toContain('if not v_deleted then');
  });
});

describe('C — eine Ablehnung wird nicht wiederholt', () => {
  function clientMitFehler(message: string): SupabaseClient {
    return {
      rpc: async () => ({ data: null, error: { message } }),
    } as unknown as SupabaseClient;
  }

  async function fehlerVon(message: string): Promise<WorkspaceCloudError> {
    try {
      await rpcUpsertWorkspaceExpense('ws-1', {}, 1, clientMitFehler(message));
    } catch (error) {
      return error as WorkspaceCloudError;
    }
    throw new Error('es wurde kein Fehler geworfen');
  }

  /*
   * Der Kern dieses Abschnitts: Der Serverguard urteilt über den **Inhalt**.
   * Derselbe Datensatz wird beim nächsten Versuch genauso abgelehnt. Würde er
   * als wiederholbar eingestuft, liefe der Sync endlos gegen dieselbe Wand —
   * genau das, was der Auftrag ausschließt.
   */
  it.each([
    ['expense_money_equation_mismatch: 10000 + 1900 ergibt 11900, erwartet 20000'],
    ['expense_money_tax_on_zero_rate_status: tax_free erlaubt keinen Steuerbetrag, erhalten 1900 Cent'],
    ['expense_money_tax_sign_mismatch: netto 10000 Cent, steuer -1900 Cent'],
    ['expense_money_invalid_amount: netAmount/taxAmount/grossAmount fehlen oder sind unbrauchbar'],
  ])('T8: %s wird nicht wiederholt', async (message) => {
    const error = await fehlerVon(message);
    expect(error).toBeInstanceOf(WorkspaceCloudError);
    expect(error.retryable, 'eine inhaltliche Ablehnung darf nicht wiederholt werden').toBe(false);
    // Der Grund bleibt im Klartext erhalten, sonst wäre er nicht auffindbar.
    expect(error.message).toBe(message);
  });

  /*
   * T9 — die Gegenprobe: Ein echter Ausfall bleibt wiederholbar. Sonst hätte
   * ich mit dieser Änderung den Sync bei jedem Netzwerkfehler aufgegeben.
   */
  it('T9: ein Netzwerkfehler bleibt wiederholbar', async () => {
    expect((await fehlerVon('Failed to fetch')).retryable).toBe(true);
    expect((await fehlerVon('Irgendein unbekannter Ausfall')).retryable).toBe(true);
  });

  // T10 — und die bekannten endgültigen Fehler bleiben, was sie waren.
  it('T10: Auth-, Zugriffs- und Versionsfehler bleiben unverändert endgültig', async () => {
    expect((await fehlerVon('Nicht angemeldet')).code).toBe('auth');
    expect((await fehlerVon('Nicht angemeldet')).retryable).toBe(false);
    expect((await fehlerVon('Kein Zugriff auf Workspace')).code).toBe('rls');
    expect((await fehlerVon('Versionskonflikt: Ausgabe x')).code).toBe('version_conflict');
  });
});

describe('D — die Migration fasst nur an, was sie soll', () => {
  /*
   * T11 — die Funktion wird ersetzt, nicht neben eine zweite gestellt. Eine
   * abweichende Signatur erzeugte eine Überladung, und welche der beiden der
   * Client träfe, wäre Zufall.
   */
  it('T11: dieselbe Signatur, dieselbe Funktion', () => {
    expect(MIGRATION).toContain('create or replace function public.upsert_workspace_expense(\n  p_workspace_id uuid,\n  p_payload jsonb,\n  p_row_version bigint\n)');
    expect(MIGRATION).toContain('returns jsonb');
  });

  // T12 — Rechte, Ausführungskontext und Suchpfad bleiben, wie sie waren.
  it('T12: SECURITY DEFINER, search_path und Grants bleiben erhalten', () => {
    expect(FUNKTION).toContain('security definer');
    expect(FUNKTION).toContain('set search_path = public');
    expect(MIGRATION).toContain(
      'revoke all on function public.upsert_workspace_expense(uuid, jsonb, bigint) from public;',
    );
    expect(MIGRATION).toContain(
      'grant execute on function public.upsert_workspace_expense(uuid, jsonb, bigint) to authenticated;',
    );
  });

  /*
   * T13 — keine Tabelle, keine Spalte, kein Index, kein Drop. Der Auftrag
   * verlangt ausdrücklich keine unrelated Schemaänderung, und ein `drop
   * function` würde zudem die Rechte mitnehmen.
   */
  it('T13: keine Schemaänderung und kein Drop', () => {
    for (const verboten of [
      /create\s+table/i,
      /alter\s+table/i,
      /drop\s+(table|function|column|policy|index)/i,
      /create\s+policy/i,
      /create\s+(unique\s+)?index/i,
      /create\s+trigger/i,
    ]) {
      expect(MIGRATION, `${verboten} gehört nicht in diese Migration`).not.toMatch(verboten);
    }
  });

  /*
   * T14 — kein Backfill, keine Reparatur. Historische Ausgaben werden erkannt
   * und angezeigt, aber niemals stillschweigend umgeschrieben: Wer eine
   * fremde Buchung nachträglich ändert, fälscht sie.
   */
  it('T14: die Migration verändert keine Bestandsdaten', () => {
    const rumpfFrei = MIGRATION.slice(0, MIGRATION.indexOf('create or replace function public.upsert_workspace_expense'));
    for (const verboten of [/\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\binsert\s+into\b/i]) {
      expect(rumpfFrei, 'ausserhalb der Funktion wird nichts geschrieben').not.toMatch(verboten);
    }
  });

  /*
   * T15 — das Löschen und der unveränderte Replay bleiben offen. Beides steht
   * im Auftrag: Ein ungültiger Altbeleg darf weder unlöschbar werden noch den
   * Sync in eine Retry-Schleife treiben.
   */
  it('T15: Grabstein und unveränderter Replay umgehen die Prüfung', () => {
    const pruefung = FUNKTION.slice(
      FUNKTION.indexOf('if not v_deleted then'),
      FUNKTION.indexOf('if v_existing.id is null then'),
    );
    expect(pruefung).toContain('v_money_unchanged');
    for (const feld of ['netAmount', 'taxAmount', 'grossAmount', 'taxStatus']) {
      expect(pruefung, `${feld} zählt nicht zum Vergleich`).toContain(
        `(v_existing.payload->'${feld}')`,
      );
    }
    // Geprüft wird nur, wenn sich am Geld etwas ändert.
    expect(pruefung).toContain('if not coalesce(v_money_unchanged, false) then');
  });

  /*
   * T16 — der Zeitstempel reiht sich korrekt ein. Eine Migration, die vor
   * einer bereits angewendeten einsortiert, wird auf einer eingerichteten
   * Datenbank nie ausgeführt.
   *
   * Geprüft wird die **Einordnung**, nicht die letzte Position: Spätere
   * Blöcke legen weitere Migrationen an, und dieser Test soll davon nicht
   * umfallen — er soll umfallen, wenn diese hier falsch einsortiert oder
   * doppelt vergeben ist.
   */
  it('T16: der Zeitstempel ist eindeutig und liegt hinter seinem Vorgänger', async () => {
    const { readdirSync } = await import('node:fs');
    const namen = readdirSync(path.join(REPO, 'supabase/migrations'))
      .filter((n) => n.endsWith('.sql'))
      .sort();

    const index = namen.indexOf('20261007120000_workspace_expense_money_integrity.sql');
    expect(index, 'die Migration fehlt').toBeGreaterThanOrEqual(0);
    expect(namen[index - 1]).toBe('20261006120000_workspace_manual_invoice_integrity.sql');
    // Nur einmal vergeben.
    expect(namen.filter((n) => n.startsWith('20261007120000'))).toHaveLength(1);
  });
});
