/**
 * OFFICEPILOT-GENERATED-DOCUMENT-SQL-INVARIANTS-05C1C — was die Datenbank selbst garantiert.
 *
 * Die SQL-Gegenprüfung hat vier Invarianten gefunden, die bisher nur der
 * Client trug:
 *
 *   1. Der fachliche Unique-Index nahm Grabsteine aus. Damit hätte ein
 *      späterer Archivierungslauf mit neuer Kennung ein gelöschtes Dokument
 *      faktisch wiederbelebt — genau das, was der 05C1-Vertrag ausschliesst.
 *   2. Der Vorgang kam ungeprüft vom Client, obwohl die Rechnung ihn trägt.
 *   3. Payload und Spalten konnten sich widersprechen.
 *   4. Die Rechte hingen an Supabase-Standardwerten.
 *
 * **Was diese Tests beweisen können und was nicht:** Vitest hat keine
 * Datenbank. Geprüft wird die *Struktur* des SQL, das die Invarianten trägt.
 * Dass PostgreSQL sich zur Laufzeit so verhält, steht erst beim Dry-Run fest.
 * Hier wird keine Laufzeitgarantie behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250827120000_workspace_generated_invoice_document_cloud.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

const foundationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250711140000_workspace_cloud_data.sql',
);
const foundationSql = readFileSync(foundationPath, 'utf8');

const invoiceFoundationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250723120000_workspace_invoice_cloud_foundation.sql',
);
const invoiceFoundationSql = readFileSync(invoiceFoundationPath, 'utf8');

/** Nur der Rumpf des Upsert-RPC. */
const upsertFunction = (() => {
  const start = sql.indexOf(
    'create or replace function public.upsert_workspace_generated_invoice_document',
  );
  const end = sql.indexOf('create or replace function public.tombstone_workspace_document');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

/** Nur der Rumpf des Tombstone-RPC. */
const tombstoneFunction = (() => {
  const start = sql.indexOf('create or replace function public.tombstone_workspace_document');
  const end = sql.indexOf('create or replace function public.pull_workspace_documents');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
})();

/** Der Index-Block. */
const businessKeyIndex = (() => {
  const start = sql.indexOf('create unique index if not exists workspace_documents_generated_invoice_unique');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(';', start) + 1);
})();

describe('OFFICEPILOT-GENERATED-DOCUMENT-SQL-INVARIANTS-05C1C', () => {
  /* ---------------------------------------------------------------------- */
  /* 1 — Der Grabstein bleibt Besitzer des Business Key                      */
  /* ---------------------------------------------------------------------- */

  it('A: der fachliche Unique-Index nimmt Grabsteine nicht aus', () => {
    expect(businessKeyIndex).toContain('on public.workspace_documents (workspace_id, linked_invoice_id)');
    expect(businessKeyIndex).toContain("document_kind = 'generated_invoice'");
    expect(businessKeyIndex).toContain('linked_invoice_id is not null');

    /*
     * Der Kern der Korrektur. Mit `deleted_at is null` im Index hätte ein
     * Grabstein den Schlüssel freigegeben — und ein späterer
     * Archivierungslauf mit neuer Kennung hätte für dieselbe Rechnung ein
     * zweites, aktives Dokument angelegt. Genau das ist Wiederbelebung.
     */
    expect(businessKeyIndex).not.toContain('deleted_at is null');
  });

  it('B: der Upsert liest die bestehende Zeile unabhängig vom Grabstein', () => {
    /*
     * Die fachliche Suche darf nicht mehr auf aktive Zeilen filtern — sonst
     * sähe sie den Grabstein nicht und liefe in den Insert, den der Index
     * dann hart abweist.
     */
    const lookup = upsertFunction.slice(
      upsertFunction.indexOf('select * into v_existing'),
      upsertFunction.indexOf('if v_existing.id is not null then'),
    );
    expect(lookup).toContain("document_kind = 'generated_invoice'");
    expect(lookup).toContain('linked_invoice_id = v_invoice_id');
    expect(lookup).not.toContain('deleted_at is null');
  });

  it('B2: eine tombstonierte Zeile wird nicht wiederbelebt, sondern gemeldet', () => {
    expect(upsertFunction).toContain('v_existing.deleted_at is not null');
    expect(upsertFunction).toContain('Dokumentkonflikt: dieses Dokument wurde geloescht');

    /*
     * Der Grabsteinvorrang muss **vor** der Rückgabe der kanonischen Zeile
     * greifen — sonst käme ein gelöschtes Dokument als Erfolg zurück.
     */
    const tombstoneCheck = upsertFunction.indexOf('v_existing.deleted_at is not null');
    const canonicalReturn = upsertFunction.indexOf('return next v_existing;');
    expect(tombstoneCheck).toBeLessThan(canonicalReturn);

    // Und im Upsert-Pfad wird nichts aktualisiert — kein Undelete durch die Hintertür.
    expect(upsertFunction).not.toContain('update public.workspace_documents');
  });

  /* ---------------------------------------------------------------------- */
  /* 2 — Der Vorgang kommt aus der Rechnung, nicht vom Client                */
  /* ---------------------------------------------------------------------- */

  it('D: der Vorgang wird gegen die Rechnungszeile geprüft', () => {
    // Das Schema trägt ihn direkt auf der Rechnung.
    expect(invoiceFoundationSql).toContain('vorgang_id text not null');

    expect(upsertFunction).toContain('v_invoice.vorgang_id');
    expect(upsertFunction).toContain('Vorgang passt nicht zur Rechnung');
    // Für ein erzeugtes Rechnungsdokument ist der Vorgang zwingend.
    expect(upsertFunction).toContain('linked_vorgang_id fehlt');
  });

  it('D2: der Vorgang wird nicht aus Titel oder anderen Merkmalen erraten', () => {
    for (const heuristic of ['title', 'invoice_number', 'ilike', 'similar to']) {
      expect(upsertFunction.toLowerCase()).not.toContain(heuristic);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 3 — Payload und Spalten dürfen sich nicht widersprechen                 */
  /* ---------------------------------------------------------------------- */

  it('E/F: Payload-Rechnung und Payload-Vorgang müssen zu den Spalten passen', () => {
    expect(upsertFunction).toContain("p_payload->>'linkedInvoiceId'");
    expect(upsertFunction).toContain("p_payload->'linkedVorgang'->>'vorgangId'");
    expect(upsertFunction).toContain('Payload widerspricht der Rechnungsidentitaet');
  });

  it('G: Kategorie und Dokumenttyp müssen die einer Ausgangsrechnung sein', () => {
    expect(upsertFunction).toContain("p_payload->>'category'");
    expect(upsertFunction).toContain("p_payload->>'classifiedKind'");
    expect(upsertFunction).toContain("'ausgangsrechnung'");
    expect(upsertFunction).toContain("p_payload->>'archived'");
  });

  it('H: die Payload-ID muss beim ersten Insert zur Kennung passen', () => {
    expect(upsertFunction).toContain("p_payload->>'id'");
    expect(upsertFunction).toContain('Payload-ID passt nicht zur Dokumentkennung');
  });

  it('I: die ID-Prüfung gilt nur für den Insert, nicht für den Replay', () => {
    /*
     * Beim zweiten Gerät trägt die kanonische Cloud-Zeile die Kennung des
     * ersten. Würde die ID-Prüfung auch dort greifen, wäre der zulässige
     * Zwei-Geräte-Fall aus 05C1B unmöglich.
     */
    const idCheckAt = upsertFunction.indexOf("p_payload->>'id'");
    const canonicalReturnAt = upsertFunction.indexOf('return next v_existing;');
    expect(canonicalReturnAt).toBeGreaterThan(-1);
    expect(idCheckAt).toBeGreaterThan(canonicalReturnAt);
  });

  /* ---------------------------------------------------------------------- */
  /* 4 — Rechte                                                              */
  /* ---------------------------------------------------------------------- */

  it('J: die Tabelle erlaubt authenticated nur SELECT', () => {
    expect(sql).toContain('revoke all on public.workspace_documents from public, anon');
    // Nicht auf Supabase-Standardwerte verlassen.
    expect(sql).toContain('revoke all on public.workspace_documents from authenticated');
    expect(sql).toContain('grant select on public.workspace_documents to authenticated');

    // Kein direkter Schreibzugriff — Schreiben ausschliesslich über die RPCs.
    for (const forbidden of [
      'grant insert on public.workspace_documents',
      'grant update on public.workspace_documents',
      'grant delete on public.workspace_documents',
      'grant all on public.workspace_documents',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it('J2: die RPCs sind public und anon entzogen und authenticated erlaubt', () => {
    for (const fn of [
      'public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb)',
      'public.tombstone_workspace_document(uuid, text)',
      'public.pull_workspace_documents(uuid, timestamptz)',
    ]) {
      expect(sql).toContain(`revoke all on function ${fn} from public, anon`);
      expect(sql).toContain(`grant execute on function ${fn} to authenticated`);
    }
  });

  it('J3: RLS bleibt aktiv und erlaubt nur lesenden Mitgliederzugriff', () => {
    expect(sql).toContain('alter table public.workspace_documents enable row level security');
    expect(sql).toContain('for select to authenticated');
    expect(sql).toContain('using (public.is_active_workspace_member(workspace_id))');
    // Keine schreibende Policy.
    expect(sql).not.toContain('for insert to authenticated');
    expect(sql).not.toContain('for update to authenticated');
    expect(sql).not.toContain('for delete to authenticated');
  });

  /* ---------------------------------------------------------------------- */
  /* 5 — Belegte Abhängigkeit                                                */
  /* ---------------------------------------------------------------------- */

  it('K: set_workspace_updated_at existiert nachweislich vor dieser Migration', () => {
    // Erzeugt in 20250711140000 — lexikografisch und zeitlich davor.
    expect(foundationSql).toContain('create or replace function public.set_workspace_updated_at()');
    expect(foundationSql).toContain('new.updated_at = now()');
    expect('20250711140000' < '20250827120000').toBe(true);

    // Und diese Migration erfindet keine zweite, konkurrierende Variante.
    expect(sql).toContain('execute function public.set_workspace_updated_at()');
    expect(sql).not.toContain('create or replace function public.set_workspace_updated_at');
  });

  /* ---------------------------------------------------------------------- */
  /* 6/7 — Serialisierung und Tombstone-Vertrag                              */
  /* ---------------------------------------------------------------------- */

  it('C: die Rechnungszeile bleibt der Serialisierungspunkt', () => {
    const invoiceLock = upsertFunction.slice(
      upsertFunction.indexOf('select * into v_invoice'),
      upsertFunction.indexOf('if v_invoice.id is null then'),
    );
    expect(invoiceLock).toContain('from public.workspace_invoices');
    expect(invoiceLock).toContain('for update');

    // Die Sperre steht vor der fachlichen Suche — sonst reiht sie nichts.
    expect(upsertFunction.indexOf('select * into v_invoice')).toBeLessThan(
      upsertFunction.indexOf('select * into v_existing'),
    );
  });

  it('L: der Tombstone-RPC bleibt idempotent und gibt den Schlüssel nicht frei', () => {
    expect(tombstoneFunction).toContain('if v_existing.deleted_at is not null then');
    expect(tombstoneFunction).toContain('return next v_existing;');
    expect(tombstoneFunction).toContain('row_version = row_version + 1');
    // Die Zeile bleibt bestehen — kein DELETE gibt den Business Key frei.
    expect(tombstoneFunction).not.toContain('delete from public.workspace_documents');
  });
});
