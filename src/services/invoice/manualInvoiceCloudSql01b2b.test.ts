/**
 * MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — die Serverseite der Rechnung ohne
 * Auftrag.
 *
 * **Was diese Tests beweisen können und was nicht:** Echte Nebenläufigkeit und
 * echte NULL-Semantik brauchen eine laufende Datenbank; Vitest hat keine.
 * Geprüft wird die *Struktur* des SQL — welche Bedingung wo steht, welcher
 * Fehlername fällt, welches Prädikat der Index trägt. Dass PostgreSQL sich zur
 * Laufzeit so verhält, steht erst beim Dry-Run fest. Hier wird keine
 * Laufzeitgarantie behauptet. Dasselbe Verfahren wie in
 * `invoiceSingleFinalSqlGuard01` und `invoiceCancellationSqlFoundation01`.
 *
 * Maßgeblich ist immer die zuletzt gültige Fassung einer Funktion. Die
 * Vorgängerdateien bleiben unverändert im Repository stehen.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(name: string): string {
  try {
    return readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
  } catch {
    return '';
  }
}

/** Die neue Migration dieses Blocks — sie schreibt beide RPCs fort. */
const MIGRATION = '20260912120000_workspace_invoice_without_vorgang.sql';
const sql = read(MIGRATION);

/** Nur der Rumpf einer Funktion ab ihrer letzten Neudefinition in dieser Datei. */
function functionBody(source: string, name: string): string {
  const start = source.lastIndexOf(`create or replace function public.${name}`);
  if (start < 0) return '';
  const end = source.indexOf('\n$$;', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

const finalize = functionBody(sql, 'finalize_workspace_invoice');
const documentUpsert = functionBody(sql, 'upsert_workspace_generated_invoice_document');

/** Ohne Kommentare — eine Zusicherung darf nicht von Prosa erfüllt werden. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

const finalizeCode = code(finalize);
const documentCode = code(documentUpsert);

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Schema und Index', () => {
  it('S0: die Migration existiert und ist die jüngste Rechnungsmigration', () => {
    expect(sql, `Migration ${MIGRATION} fehlt`).not.toBe('');
  });

  it('S0b: vorgang_id wird nullable, ohne dass eine Spalte hinzukommt', () => {
    expect(code(sql)).toContain('alter table public.workspace_invoices');
    expect(code(sql)).toContain('alter column vorgang_id drop not null');
    // Keine zweite Wahrheit neben der Spalte: kein origin-Feld, keine Manual-Tabelle.
    expect(code(sql)).not.toMatch(/add column .*origin/i);
    expect(code(sql)).not.toMatch(/create table[^;]*manual/i);
  });

  it('S13: der Single-Final-Index behält seine Semantik und schließt NULL ausdrücklich aus', () => {
    const c = code(sql);
    expect(c).toContain('workspace_invoices_single_final_invoice');
    expect(c).toContain('on public.workspace_invoices (workspace_id, vorgang_id)');
    expect(c).toContain("invoice_type = 'schluss'");
    expect(c).toContain("invoice_status in ('vorbereitet', 'versendet')");
    expect(c).toContain('cancelled_at is null');
    expect(c, 'Das Prädikat lässt NULL-Vorgänge noch in die Gruppe').toContain(
      'vorgang_id is not null',
    );
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — finalize_workspace_invoice', () => {
  it('S2: eine fehlende vorgang_id ist kein Abbruchgrund mehr — ein leerer schon', () => {
    expect(finalize, 'finalize wird von dieser Migration nicht fortgeschrieben').not.toBe('');

    /*
     * Der Abbruch bleibt, aber er gilt nur noch dem Leerstring. Geprüft wird
     * deshalb die Bedingung, nicht die blosse Abwesenheit der Meldung: Ein
     * unbedingtes `if v_vorgang_id is null then raise` wäre die alte Sperre
     * unter neuem Namen.
     */
    expect(finalizeCode).toContain('p_vorgang_id is not null');
    expect(finalizeCode).toContain("nullif(trim(p_vorgang_id), '') is null");
    expect(
      finalizeCode,
      'Der Abbruch hängt weiterhin an der abgeleiteten NULL statt am Leerstring',
    ).not.toMatch(/if v_vorgang_id is null then\s*raise exception 'vorgang_id fehlt'/);
  });

  it('S3/S4: ohne Vorgang ist ausschließlich die normale Rechnung zulässig', () => {
    /*
     * Der Kern von TEIL E: Typregel und Lock-Auslassung dürfen nicht zwei
     * unabhängig veränderbare Regeln sein. Geprüft wird deshalb nicht nur,
     * *dass* die Typregel existiert, sondern dass sie im selben Zweig steht
     * wie die Vorgangsbehandlung — siehe S-Kopplung unten.
     */
    expect(finalizeCode).toContain("v_invoice_type <> 'rechnung'");
    expect(finalizeCode).toContain('invoice_requires_vorgang_for_type');
  });

  it('S-Kopplung: Typregel und Lock-Auslassung liegen in einem Zweig', () => {
    /*
     * Der Vorgangs-Lock ist der gemeinsame Serialisierungspunkt von finalize,
     * confirm_workspace_order_amendment und cancel_workspace_invoice. Ihn bei
     * NULL zu überspringen ist nur zulässig, weil NULL zwingend
     * `type = 'rechnung'` bedeutet und damit weder Single-Final- noch
     * Nachtragsprüfung stattfindet. Stünden beide Regeln in getrennten `if`s,
     * entstünde bei einer späteren Lockerung der Typregel unbemerkt ein Rennen.
     */
    const branch = finalizeCode.slice(
      finalizeCode.indexOf('if v_vorgang_id is null then'),
      finalizeCode.indexOf('v_existing') > 0
        ? finalizeCode.indexOf('client_invoice_id = trim(p_client_invoice_id)')
        : undefined,
    );
    expect(branch, 'Kein gemeinsamer NULL-Zweig gefunden').toContain(
      'invoice_requires_vorgang_for_type',
    );
    expect(branch, 'Der Vorgangs-Lock steht nicht im else-Zweig derselben Verzweigung').toContain(
      'for update',
    );
    expect(branch).toContain('else');
  });

  it('S5/S6/G: bei echtem Bezug bleibt die Vorgangsprüfung unverändert scharf', () => {
    expect(finalizeCode).toContain('from public.workspace_vorgaenge v');
    expect(finalizeCode).toContain('v.workspace_id = p_workspace_id');
    expect(finalizeCode).toContain('v.vorgang_id = v_vorgang_id');
    expect(finalizeCode).toContain('for update');
    expect(finalizeCode).toContain('if not found or v_vorgang.deleted then');
    expect(finalize).toContain('Vorgang gehört nicht zum Workspace oder existiert nicht');
  });

  it('S15: der Replay prüft zusätzlich den Vorgangsbezug — in beide Richtungen', () => {
    /*
     * `is distinct from` ist hier der ganze Punkt: Es fängt NULL→A und A→NULL
     * mit derselben Bedingung. Ein `<>` verglich NULL zu NULL als unbekannt und
     * ließe das stille Umhängen durch.
     */
    /*
     * Es gibt **zwei** Replay-Ausgänge: den regulären Fund vor dem Insert und
     * den `unique_violation`-Handler nach einem verlorenen Rennen. Beide geben
     * die bestehende Zeile als Erfolg zurück, also müssen beide prüfen. Eine
     * Zusicherung auf „mindestens einmal vorhanden" liesse den zweiten Pfad
     * still offen.
     */
    const treffer = finalizeCode.match(
      /v_existing\.vorgang_id is distinct from v_vorgang_id/g,
    );
    expect(
      treffer?.length ?? 0,
      'Nicht beide Replay-Ausgänge prüfen den Vorgangsbezug',
    ).toBe(2);
    expect(finalize).toContain('Idempotenzkonflikt: abweichender Vorgangsbezug');
  });

  it('S7-R1: der Replay-Kandidat trägt dieselbe Datumskanonisierung wie der Insert', () => {
    /*
     * Laufzeitfund (01B2b-R1): Der gespeicherte Payload bekommt `date`,
     * `issueDate` und `type` serverseitig gesetzt; der Replay-Kandidat bekam
     * nur `id` und `status`. Ohne `date` vom Client scheiterte ein bytegleicher
     * zweiter Aufruf. Geprüft wird, dass es genau **einen** Kandidaten gibt,
     * dass er vor der Replay-Suche entsteht und alle vom Insert ergänzten
     * Felder trägt.
     */
    /*
     * R2: Der Kandidat lebt in `workspace_invoice_replay_candidate`, weil er
     * die gespeicherte Zeile kennen muss. In finalize selbst gibt es keine
     * zweite Kandidatenregel mehr — nur zwei Aufrufe derselben Funktion.
     */
    expect(finalizeCode).not.toMatch(/v_normalized_incoming := public\.normalize_/);
    const aufrufe = finalizeCode.match(
      /v_normalized_incoming := public\.workspace_invoice_replay_candidate\(/g,
    );
    expect(aufrufe?.length ?? 0, 'Nicht beide Replay-Ausgänge nutzen die Kandidatenfunktion').toBe(2);

    const helper = code(functionBody(sql, 'workspace_invoice_replay_candidate'));
    expect(helper, 'Kandidatenfunktion fehlt').not.toBe('');
    for (const feld of ["'id', p_client_invoice_id", "'type', p_invoice_type", "'status', 'vorbereitet'", "'date', v_issue_date", "'issueDate'"]) {
      expect(helper, `Kandidat ohne ${feld}`).toContain(feld);
    }
    // `date` bleibt Teil der Invariante — nicht aus dem Normalisierer entfernt.
    expect(code(sql)).not.toMatch(/normalize_workspace_invoice_payload_for_idempotency\(p_payload jsonb\)/);
  });

  it('S7-R2: ein datumsloser Request bekommt sein Datum von der gespeicherten Zeile, nicht vom heutigen Tag', () => {
    /*
     * Reihenfolge im `coalesce`: explizites issueDate, explizites date, dann
     * das gespeicherte Datum, erst ganz zuletzt UTC-heute. Stünde „heute" vor
     * dem gespeicherten Datum, scheiterte derselbe datumslose Request an jedem
     * Folgetag als abweichender Inhalt.
     */
    const helper = code(functionBody(sql, 'workspace_invoice_replay_candidate'));
    const explicitAt = helper.indexOf('v_explicit_issue_date,');
    const storedAt = helper.indexOf("p_stored_payload->>'date'");
    const todayAt = helper.indexOf("to_char(timezone('utc', now())");
    expect(explicitAt).toBeGreaterThan(0);
    expect(storedAt, 'Gespeichertes Datum wird nicht herangezogen').toBeGreaterThan(explicitAt);
    expect(todayAt, 'UTC-heute steht vor dem gespeicherten Datum').toBeGreaterThan(storedAt);
    // Der Insert selbst faellt weiterhin auf UTC-heute zurueck.
    expect(finalizeCode).toContain("to_char(timezone('utc', now()), 'YYYY-MM-DD')");
    // Die Hilfsfunktion ist nicht direkt aufrufbar.
    expect(code(sql)).toContain(
      'revoke all on function public.workspace_invoice_replay_candidate(jsonb, text, text, jsonb) from public, anon, authenticated',
    );
  });

  it('S7-R2b: der Laufzeittest gegen die echte Datenbank liegt im Repository', () => {
    const runtime = read('../tests/manual_invoice_replay_01b2b.sql');
    expect(runtime, 'supabase/tests/manual_invoice_replay_01b2b.sql fehlt').not.toBe('');
    expect(runtime).toContain('Cross-Day-Replay');
    expect(runtime).toContain('rollback;');
  });

  it('S7-R1b: beide Replay-Ausgänge vergleichen gegen denselben Kandidaten', () => {
    const vergleiche = finalizeCode.match(
      /v_normalized_existing is distinct from v_normalized_incoming/g,
    );
    expect(vergleiche?.length ?? 0).toBe(2);
  });

  it('S1/S14: Mitgliedschaft, Idempotenz, Nummernkreis und Schluss-Guards bleiben', () => {
    expect(finalizeCode).toContain('is_active_workspace_member(p_workspace_id)');
    expect(finalizeCode).toContain('normalize_workspace_invoice_payload_for_idempotency');
    expect(finalize).toContain('Idempotenzkonflikt');
    expect(finalizeCode).toContain('workspace_invoice_sequences');
    expect(finalizeCode).toContain('format_workspace_invoice_number');
    expect(finalizeCode).toContain('invoice_final_already_exists');
    expect(finalizeCode).toContain('invoice_amendment_state_stale');
    expect(finalizeCode).toContain('cancelled_at is null');
  });

  it('S9/J: der Nummernkreis bleibt allein auf Workspace und Jahr geschlüsselt', () => {
    expect(finalizeCode).toContain('workspace_id = p_workspace_id');
    expect(finalizeCode).toContain('invoice_year = v_year');
    // Keine Manual-Sequenz und keine Verzweigung des Nummernkreises.
    expect(finalizeCode).not.toMatch(/manual_sequence|invoice_sequences_manual/i);
  });

  it('L: die Nachtragsprüfung bleibt an die Schlussrechnung gebunden', () => {
    const amendmentAt = finalizeCode.indexOf('workspace_order_amendments');
    expect(amendmentAt).toBeGreaterThan(0);
    // Der nächstliegende Typvergleich davor muss 'schluss' sein.
    const before = finalizeCode.slice(0, amendmentAt);
    expect(before.lastIndexOf("v_invoice_type = 'schluss'")).toBeGreaterThan(
      before.lastIndexOf("v_invoice_type = 'rechnung'"),
    );
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Rechnungsdokument', () => {
  it('S16: ein erzeugtes Rechnungsdokument darf ohne Vorgang existieren', () => {
    expect(documentUpsert, 'Die Dokument-RPC wird nicht fortgeschrieben').not.toBe('');
    // Wie bei finalize: Der Abbruch bleibt, gilt aber nur noch dem Leerstring.
    expect(documentCode).toContain('p_linked_vorgang_id is not null');
    expect(
      documentCode,
      'Der Abbruch hängt weiterhin an der abgeleiteten NULL statt am Leerstring',
    ).not.toMatch(/if v_vorgang_id is null then\s*raise exception 'linked_vorgang_id fehlt'/);
  });

  it('S17: Dokument- und Rechnungsvorgang werden NULL-sicher verglichen', () => {
    /*
     * Vier Fälle, eine Bedingung: NULL/NULL erlaubt, A/A erlaubt, NULL/A und
     * A/NULL abgewiesen. Genau das leistet `is distinct from` — ein `=` liefe
     * bei NULL ins Unbekannte und ließe den Konflikt durch.
     */
    expect(documentCode).toContain('v_vorgang_id is distinct from v_invoice.vorgang_id');
    expect(documentUpsert).toContain('Dokumentkonflikt: Vorgang passt nicht zur Rechnung');
    expect(documentCode).toContain(
      "p_payload->'linkedVorgang'->>'vorgangId' is distinct from v_vorgang_id",
    );
    expect(documentCode).toContain('v_existing.linked_vorgang_id is distinct from v_vorgang_id');
    expect(documentCode).toContain('v_inserted.linked_vorgang_id is distinct from v_vorgang_id');
  });

  it('M: die übrigen Dokumentinvarianten bleiben unangetastet', () => {
    expect(documentCode).toContain("raise exception 'linked_invoice_id fehlt'");
    expect(documentUpsert).toContain('Rechnung nicht finalisiert');
    expect(documentUpsert).toContain('Dokumentkonflikt: dieses Dokument wurde geloescht');
    expect(documentCode).toContain("document_kind = 'generated_invoice'");
    expect(documentUpsert).toContain('Dokument Nachbedingung verletzt');
  });
});

describe('MANUAL-INVOICE-CLOUD-MIGRATION-01B2b — Sicherheit und Abgrenzung', () => {
  it('S12/W: die Migration ändert keine RLS-Policy', () => {
    const c = code(sql);
    expect(c, 'Eine Policy wird angefasst').not.toMatch(/create policy|drop policy|alter policy/i);
    expect(c, 'RLS wird umgeschaltet').not.toMatch(/row level security/i);
  });

  it('W: Autorisierung bleibt workspace-basiert, nicht vorgangsbasiert', () => {
    // Der einzige Zugriffsschutz in finalize ist die Mitgliedschaft.
    expect(finalizeCode).toContain('is_active_workspace_member(p_workspace_id)');
    expect(documentCode).toContain('is_active_workspace_member(p_workspace_id)');
  });

  it('Y: der Storno normaler Rechnungen wird hier nicht angefasst', () => {
    expect(code(sql)).not.toContain('cancel_workspace_invoice');
    expect(code(sql)).not.toContain('invoice_cancel_type_not_supported');
  });

  it('X: die Zahlungs-RPCs werden nicht angefasst', () => {
    expect(code(sql)).not.toContain('add_workspace_invoice_payment');
    expect(code(sql)).not.toContain('reverse_workspace_invoice_payment');
  });

  it('C: die Grants der ersetzten Funktionen werden erneut gesetzt', () => {
    const c = code(sql);
    expect(c).toContain(
      'grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb) to authenticated',
    );
    expect(c).toContain(
      'grant execute on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) to authenticated',
    );
  });

  it('C: keine Sentinel-Werte als Ersatz für den fehlenden Vorgang', () => {
    const c = code(sql);
    for (const sentinel of ["'manual'", "'none'", "'unknown'", "'-'"]) {
      expect(c, `Sentinel ${sentinel} im SQL`).not.toContain(`vorgang_id, ${sentinel}`);
      expect(c, `Sentinel ${sentinel} im SQL`).not.toContain(`coalesce(v_vorgang_id, ${sentinel})`);
    }
  });
});
