/**
 * CLOUD-SYNC S5 — der serverseitige Vertrag des Rechnungsentwurfs als Quelltext.
 *
 * Die eigentliche Prüfung läuft gegen eine echte PostgreSQL
 * (`supabase/tests/invoice_drafts_s5.sql`, dazu der echte Parallellauf
 * `supabase/tests/invoice_drafts_parallel_s5.sql`). Diese Datei hält das
 * Ergebnis dort fest, wo es im Alltag auffällt: Sie bricht, sobald jemand einen
 * bestehenden Dispatcher-Zweig verliert, die wörtliche Übernahme der Funktionen
 * aufweicht, die R1-Reihenfolge der Freigabe verändert, den Entwurfsverbrauch
 * aus der Transaktion löst oder ein Wiederbeleben erfindet.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');
const lies = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');

const sql = lies('20261102120000_workspace_invoice_drafts.sql');

function rumpf(quelle: string, funktion: string): string {
  const start = quelle.indexOf(`create or replace function public.${funktion}(`);
  expect(start, `Funktion fehlt: ${funktion}`).toBeGreaterThanOrEqual(0);
  const auf = quelle.indexOf('$$', start) + 2;
  return quelle.slice(auf, quelle.indexOf('$$;', auf));
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** Die geltenden Rümpfe vor S5 — remote wie lokal angewendet. */
const UPSERT_VOR_S5 = '83b6627f542f1a1fd23a2ea61596d99e'; // 20261101120000 (S3)
const PULL_VOR_S5 = 'bc6be1e5cef93e7d5c30af4db956e271'; // 20261101120000 (S3)
const FREIGABE_VOR_S5 = 'd614a73cd933186cc19a8efaf12825ef'; // 20261023120000 (R1)

const upsert = rumpf(sql, 'upsert_workspace_sync_entity');
const pull = rumpf(sql, 'pull_workspace_sync_state');
const freigabe = rumpf(sql, 'finalize_workspace_invoice');

const ZWEIG_START = "  elsif p_entity_type = 'invoice_draft' then\n";
const ZWEIG_ENDE = "  else\n    raise exception 'Unbekannter Entity-Typ";
const zweig = upsert.slice(upsert.indexOf(ZWEIG_START), upsert.indexOf(ZWEIG_ENDE));
const ohneKommentare = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
const zweigCode = ohneKommentare(zweig);

const S5_DEKLARATION = `  /* CLOUD-SYNC S5: nur fuer den invoice_draft-Zweig. */
  v_draft_id text;
  v_draft_payload jsonb;
  v_draft_vorgang_id text;
  v_draft_type text;
  v_draft_slot_owner text;
  v_row_draft public.workspace_invoice_drafts;
`;

describe('S5-V — Dispatcher, Pull und Freigabe sind sonst wörtlich die geltenden Fassungen', () => {
  it('V1 — der Dispatcher ohne den neuen Zweig ist exakt die Fassung aus S3', () => {
    expect(upsert.includes(S5_DEKLARATION)).toBe(true);
    const ohne = upsert.split(S5_DEKLARATION).join('').split(zweig).join('');
    expect(md5(ohne)).toBe(UPSERT_VOR_S5);
  });

  it('V2 — alle sechzehn bisherigen Zweige stehen weiter im Dispatcher', () => {
    for (const typ of [
      'vorgang', 'customer', 'business_letter', 'offer', 'vorgang_note', 'task',
      'dunning_documentation', 'workspace', 'workspace_settings', 'company_setup',
      'company_profile', 'bank_account', 'bank_transaction', 'paper_register_entry',
      'communication_event', 'knowledge_fact',
    ]) {
      expect(upsert, typ).toContain(`p_entity_type = '${typ}' then`);
    }
  });

  it('V3 — der Pull trägt genau einen Schlüssel mehr, sonst unverändert', () => {
    const start = pull.indexOf(",\n    /*\n     * CLOUD-SYNC S5");
    expect(start).toBeGreaterThan(0);
    const ende = pull.indexOf("      '[]'::jsonb\n    )", pull.indexOf("'invoice_drafts'")) + "      '[]'::jsonb\n    )".length;
    const ohne = pull.slice(0, start) + pull.slice(ende);
    expect(md5(ohne)).toBe(PULL_VOR_S5);
  });

  it('V4 — die Freigabe ohne die drei Einschübe ist exakt die R1-Fassung', () => {
    const deklaration = freigabe.slice(
      freigabe.indexOf('  /* CLOUD-SYNC S5 -- Entwurfsbindung. */\n'),
      freigabe.indexOf('begin\n'),
    );
    const bindungStart = freigabe.indexOf('  /*\n   * CLOUD-SYNC S5 -- Bindung an den Cloud-Entwurf.');
    const bindungEnde = freigabe.indexOf('  /*\n   * 01D — Single-Final-Invoice-Guard.');
    const verbrauchStart = freigabe.indexOf('\n  /*\n   * CLOUD-SYNC S5 -- der Entwurf wird in derselben Transaktion verbraucht.');
    const verbrauchEnde = freigabe.indexOf("raise exception 'invoice_draft_consume_failed';\n    end if;\n  end if;\n") +
      "raise exception 'invoice_draft_consume_failed';\n    end if;\n  end if;\n".length;
    expect(bindungStart).toBeGreaterThan(0);
    expect(verbrauchStart).toBeGreaterThan(bindungEnde);
    const ohne = (
      freigabe.slice(0, bindungStart) +
      freigabe.slice(bindungEnde, verbrauchStart) +
      freigabe.slice(verbrauchEnde)
    ).split(deklaration).join('');
    expect(md5(ohne)).toBe(FREIGABE_VOR_S5);
  });
});

describe('S5-W — Freigabe: R1 zuerst, Entwurf atomar verbraucht', () => {
  const code = ohneKommentare(freigabe);

  it('W1 — R1 bleibt die erste Anweisung', () => {
    const begin = code.indexOf('begin\n');
    const ersteAnweisung = code.slice(begin + 'begin\n'.length).trimStart();
    expect(ersteAnweisung.startsWith('perform public.assert_financial_action_allowed(p_workspace_id);')).toBe(true);
  });

  it('W2 — Reihenfolge: Replay → Entwurfssperre → Prüfungen → Nummer → Insert → Verbrauch', () => {
    const replay = code.indexOf("and wi.client_invoice_id = trim(p_client_invoice_id)\n  for update;");
    const sperre = code.indexOf('from public.workspace_invoice_drafts d');
    const schluss = code.indexOf("raise exception 'invoice_final_already_exists';");
    const integritaet = code.indexOf('perform public.assert_workspace_invoice_integrity(');
    const nummer = code.indexOf('v_invoice_number := public.format_workspace_invoice_number(');
    const insert = code.indexOf('insert into public.workspace_invoices (');
    const verbrauch = code.indexOf("status = 'finalized',");
    for (const [name, pos] of Object.entries({ replay, sperre, schluss, integritaet, nummer, insert, verbrauch })) {
      expect(pos, name).toBeGreaterThan(0);
    }
    expect(replay).toBeLessThan(sperre);
    expect(sperre).toBeLessThan(schluss);
    expect(schluss).toBeLessThan(integritaet);
    expect(integritaet).toBeLessThan(nummer);
    expect(nummer).toBeLessThan(insert);
    expect(insert).toBeLessThan(verbrauch);
  });

  it('W3 — der Entwurf wird gesperrt und nur in genau der vorbereiteten Version verbraucht', () => {
    expect(code).toMatch(/where d\.workspace_id = p_workspace_id\s+and d\.client_draft_id = v_draft_id\s+for update;/);
    expect(code).toContain("raise exception 'invoice_draft_already_finalized:%', v_draft.finalized_client_invoice_id;");
    expect(code).toContain("raise exception 'invoice_draft_version_conflict:%', v_draft.row_version;");
    expect(code).toContain("raise exception 'invoice_draft_discarded';");
    expect(code).toContain('and row_version = p_expected_draft_row_version;');
    expect(code).toContain('finalized_client_invoice_id = trim(p_client_invoice_id),');
  });

  it('W4 — die alte Fünfparameter-Fassung weicht, die neue ist nur für angemeldete Nutzer ausführbar', () => {
    expect(sql).toContain('drop function if exists public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean);');
    expect(sql).toContain(
      'grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean, text, bigint) to authenticated;',
    );
    expect(sql).toContain(
      'revoke all on function public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean, text, bigint) from public, anon;',
    );
  });
});

describe('S5-X — Zweig und Tabelle', () => {
  it('X1 — Rechte wie beim Vorbereiten einer Rechnung: jedes aktive Mitglied', () => {
    expect(zweigCode).toContain('if not public.workspace_user_can_intake(p_workspace_id) then');
    expect(sql).toMatch(/workspace_invoice_drafts_select_member[\s\S]*?using \(public\.is_active_workspace_member\(workspace_id\)\);/);
    expect(sql).toContain('revoke all on public.workspace_invoice_drafts from authenticated;');
    expect(sql).toContain('grant select on public.workspace_invoice_drafts to authenticated;');
  });

  it('X2 — kein physisches Löschen, kein Finalisieren im Dispatcher', () => {
    expect(zweigCode).not.toMatch(/delete\s+from/i);
    expect(zweigCode).not.toContain("status = 'finalized'");
    expect(zweigCode).not.toContain('finalized_client_invoice_id =');
  });

  it('X3 — kein Wiederbeleben: ein verworfener oder finalisierter Entwurf ist ein Konflikt', () => {
    expect(zweigCode).toContain("if v_row_draft.deleted or v_row_draft.status <> 'active' then");
  });

  it('X4 — keine Nummer, nichts Abgeleitetes, nichts Gerätelokales', () => {
    expect(zweigCode).toContain("array['number', 'invoiceNumber', 'invoiceSequenceNumber', 'invoiceNumberPreview']");
    expect(zweigCode).toContain("array['plannedQuantity', 'executedQuantity', 'billedQuantity', 'openQuantity']");
    expect(zweigCode).toContain("'previousAbschlagDeductions'");
    expect(zweigCode).toContain("? 'logoDataUrl'");
  });

  it('X5 — Slot-Vertrag als partieller Unique-Index; eine Kollision ist ein Konflikt', () => {
    expect(sql).toMatch(
      /create unique index if not exists workspace_invoice_drafts_active_slot\s+on public\.workspace_invoice_drafts \(workspace_id, coalesce\(vorgang_id, ''\), invoice_type\)\s+where status = 'active' and not deleted;/,
    );
    expect(zweigCode).toContain("raise exception 'Versionskonflikt invoice_draft_slot:%', v_draft_slot_owner");
  });

  it('X6 — der Pull liefert Grabsteine ohne Inhalt', () => {
    expect(pull).toContain("case when d.deleted or d.status <> 'active' then to_jsonb(d) - 'payload' else to_jsonb(d) end");
    expect(pull).not.toMatch(/workspace_invoice_drafts d\s+where d\.workspace_id = p_workspace_id\s+and/);
  });
});
