-- MANUAL-INVOICE-CLOUD-MIGRATION-01B2b
-- Die normale Rechnung ohne Auftrag wird cloudfaehig.
--
-- Fortgeschrieben aus den heute wirksamen Endfassungen:
--   * finalize_workspace_invoice            -> 20250905120000 (Cancellation, v5)
--   * workspace_invoices_single_final_invoice -> 20250905120000
--   * upsert_workspace_generated_invoice_document -> 20250827120000
-- Keine aeltere Version wird kopiert, keine bestehende Migration editiert.
--
-- Fachregel dieses Blocks: Ein fehlender Auftragsbezug ist echtes SQL NULL.
-- Kein Sentinel, kein Leerstring, kein erfundener Vorgang. Und NULL ist
-- ausschliesslich fuer invoice_type = 'rechnung' zulaessig — Abschlag und
-- Schlussrechnung bleiben serverseitig auftragsgebunden.

/* -------------------------------------------------------------------------- */
/* 1) Schema                                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Kein Backfill: Jede bestehende Zeile traegt bereits einen Wert. Die
 * Lockerung erweitert nur die zulaessige Wertemenge und ist damit fuer alte
 * Clients folgenlos, solange keine NULL-Zeile entsteht.
 */
alter table public.workspace_invoices
  alter column vorgang_id drop not null;

/* -------------------------------------------------------------------------- */
/* 2) Single-Final-Index — Semantik praezisiert, nicht geaendert              */
/* -------------------------------------------------------------------------- */

/*
 * Die Bedingung `vorgang_id is not null` aendert das heutige Verhalten nicht:
 * Eine Schlussrechnung ohne Vorgang wird unten abgewiesen und erreicht das
 * Praedikat nie, und PostgreSQL behandelt NULLs in Unique-Indexen ohnehin als
 * verschieden. Sie steht hier, damit die Absicht im Index lesbar ist und ein
 * spaeteres `nulls not distinct` die Invariante nicht still umdeutet.
 *
 * Guard und Index muessen dieselbe Fachsemantik tragen — waere nur einer
 * gelockert, uebersetzte der Exception-Handler den Indexfehler unauffaellig in
 * `invoice_final_already_exists`.
 *
 * Bewusst ohne `concurrently`: Migrationen laufen in einer Transaktion, in der
 * `create index concurrently` nicht zulaessig ist.
 */
drop index if exists public.workspace_invoices_single_final_invoice;

create unique index if not exists workspace_invoices_single_final_invoice
  on public.workspace_invoices (workspace_id, vorgang_id)
  where invoice_type = 'schluss'
    and invoice_status in ('vorbereitet', 'versendet')
    and cancelled_at is null
    and vorgang_id is not null;

/* -------------------------------------------------------------------------- */
/* 3a) Der eine Replay-Kandidat                                               */
/* -------------------------------------------------------------------------- */

/*
 * 01B2b-R2 — Laufzeitfund: Ein Request **ohne** `issueDate`/`date` faellt beim
 * ersten Insert auf UTC-heute zurueck. R1 rechnete dieselbe Regel fuer den
 * Replay-Kandidaten — und damit an einem spaeteren Tag ein anderes Datum als
 * das gespeicherte. Derselbe unveraenderte Request galt dann als abweichender
 * Inhalt.
 *
 * Regel, in einer Funktion, damit beide Replay-Ausgaenge sie teilen:
 *   * Bringt der Request ein Datum mit, gilt es — wie beim Insert
 *     (`issueDate` vor `date`). Ein anderes Datum bleibt ein Konflikt.
 *   * Bringt er keines mit, gilt das Datum, das die gespeicherte Zeile beim
 *     ersten Lauf bekommen hat. Derselbe datumslose Request trifft so an jedem
 *     Tag dieselbe Rechnung.
 *   * Nur wenn auch die Zeile kein Datum traegt (gibt es nach 03A nicht, aber
 *     die Funktion darf davon nicht abhaengen), faellt der Kandidat auf
 *     UTC-heute zurueck — dieselbe Regel wie der Insert.
 *
 * `date` bleibt Teil der Idempotenznormalisierung; nichts wird entfernt.
 */
create or replace function public.workspace_invoice_replay_candidate(
  p_invoice jsonb,
  p_client_invoice_id text,
  p_invoice_type text,
  p_stored_payload jsonb
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_explicit_issue_date text := nullif(trim(coalesce(p_invoice->>'issueDate', '')), '');
  v_explicit_date text := nullif(trim(coalesce(p_invoice->>'date', '')), '');
  v_issue_date text;
begin
  v_issue_date := coalesce(
    v_explicit_issue_date,
    v_explicit_date,
    nullif(trim(coalesce(p_stored_payload->>'date', '')), ''),
    to_char(timezone('utc', now()), 'YYYY-MM-DD')
  );

  return public.normalize_workspace_invoice_payload_for_idempotency(
    coalesce(p_invoice, '{}'::jsonb)
    || jsonb_build_object(
      'id', p_client_invoice_id,
      'type', p_invoice_type,
      'status', 'vorbereitet',
      'date', v_issue_date,
      'issueDate', coalesce(v_explicit_issue_date, v_issue_date)
    )
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* 3) finalize_workspace_invoice                                              */
/* -------------------------------------------------------------------------- */

/*
 * Fortgeschrieben aus 20250905120000. Genau drei fachliche Aenderungen:
 *
 *   a) Ein fehlender Auftragsbezug ist zulaessig — aber nur fuer die normale
 *      Rechnung. Typregel und Auslassung des Vorgangs-Locks stehen deshalb in
 *      **einer** Verzweigung. Der Lock auf `workspace_vorgaenge` ist der
 *      gemeinsame Serialisierungspunkt von finalize,
 *      confirm_workspace_order_amendment und cancel_workspace_invoice; ihn zu
 *      ueberspringen ist nur deshalb sicher, weil ohne Vorgang weder
 *      Single-Final- noch Nachtragspruefung stattfindet. Stuenden beide Regeln
 *      in getrennten `if`s, entstuende bei einer spaeteren Lockerung der
 *      Typregel unbemerkt ein Rennen.
 *
 *   b) Der Leerstring bleibt ungueltig. `nullif(trim(...))` allein wuerde ihn
 *      still in „keine Zuordnung" verwandeln — das waere ein kaputter Wert, der
 *      als fachliche Aussage durchginge.
 *
 *   c) Der Idempotenz-Replay vergleicht zusaetzlich den Auftragsbezug.
 *      `is distinct from` faengt beide Richtungen mit einer Bedingung:
 *      NULL -> Vorgang und Vorgang -> NULL, dazu den Altfall Vorgang A ->
 *      Vorgang B. Ohne diese Pruefung liefert ein Replay die bestehende Zeile
 *      als Erfolg zurueck, und der Aufrufer glaubt an eine Zuordnung, die es
 *      nie gab.
 *
 * Vorgangspruefung bei echtem Bezug, Nummernkreis, Single-Final-Guard,
 * Nachtragspruefung, Fehlernamen und Race-Verhalten bleiben unveraendert.
 */
create or replace function public.finalize_workspace_invoice(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_year integer;
  v_next_sequence integer;
  v_invoice_number text;
  v_invoice_type text;
  v_payload jsonb;
  v_normalized_incoming jsonb;
  v_normalized_existing jsonb;
  v_issue_date text;
  v_vorgang_id text;
  v_vorgang public.workspace_vorgaenge;
  v_current_amendment_sequence integer;
  v_expected_amendment_sequence integer;
  v_expected_camel jsonb;
  v_expected_snake jsonb;
  v_has_expected_camel boolean := false;
  v_has_expected_snake boolean := false;
  v_parsed_camel integer;
  v_parsed_snake integer;
  v_has_other_final boolean;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  -- 01B2b (b): NULL heisst „kein Auftrag", '' heisst „kaputt".
  if p_vorgang_id is not null and nullif(trim(p_vorgang_id), '') is null then
    raise exception 'vorgang_id fehlt';
  end if;
  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  if p_invoice is null or jsonb_typeof(p_invoice) <> 'object' then
    raise exception 'invoice payload fehlt';
  end if;

  if jsonb_typeof(coalesce(p_invoice->'positions', 'null'::jsonb)) <> 'array' then
    raise exception 'invoice positions fehlen';
  end if;

  v_invoice_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  if v_invoice_type is null then
    raise exception 'invoice type fehlt';
  end if;

  /*
   * 01B2b (a) — der eine Zweig. Links die Rechnung ohne Auftrag, rechts der
   * unveraenderte Auftragspfad mit dem gemeinsamen Lock.
   */
  if v_vorgang_id is null then
    if v_invoice_type <> 'rechnung' then
      raise exception 'invoice_requires_vorgang_for_type';
    end if;
  else
    -- Shared lock with confirm_workspace_order_amendment (first).
    select *
    into v_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;

    if not found or v_vorgang.deleted then
      raise exception 'Vorgang gehört nicht zum Workspace oder existiert nicht';
    end if;
  end if;

  /*
   * 01B2b-R1 — Laufzeitfund auf lokaler PostgreSQL: Der erste Lauf speichert
   * den Payload mit serverseitig kanonisiertem `date`/`issueDate`/`type`; der
   * Replay-Kandidat wurde bisher nur um `id`/`status` ergaenzt. Schickt der
   * Client kein `date`, fehlt es im Kandidaten, und ein bytegleicher zweiter
   * Aufruf scheiterte als „abweichender Rechnungsinhalt". Derselbe Fehler
   * steckt in jeder Vorgaengerfassung seit 03A.
   *
   * Der Kandidat wird deshalb mit derselben Ergaenzung gebildet wie der
   * Insert — seit R2 in `workspace_invoice_replay_candidate`, weil er fuer
   * einen datumslosen Request das Datum der gespeicherten Zeile braucht. Die
   * Insert-Regel hier bleibt: `issueDate` vor `date` vor UTC-heute. `date`
   * bleibt Teil der Invariante — ein anderes Rechnungsdatum ist eine andere
   * Rechnung.
   */
  v_issue_date := coalesce(
    nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''),
    nullif(trim(coalesce(p_invoice->>'date', '')), ''),
    to_char(timezone('utc', now()), 'YYYY-MM-DD')
  );
  begin
    v_year := extract(year from v_issue_date::date)::integer;
  exception
    when others then
      v_year := extract(year from timezone('utc', now()))::integer;
  end;

  /*
   * 01B2b-R2 — der Replay-Kandidat entsteht in beiden Replay-Ausgaengen ueber
   * `workspace_invoice_replay_candidate`, weil er die gespeicherte Zeile
   * kennen muss: Ein datumsloser Request bekommt sein Datum von ihr, nicht
   * vom heutigen Tag. Hier steht deshalb keine zweite Definition.
   */

  select *
  into v_existing
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id)
  for update;

  if found then
    /*
     * 01B2b (c) — kein stilles Umhaengen. Die Rechnungsidentitaet bleibt
     * `workspace_id + client_invoice_id`; der Auftragsbezug ist eine
     * zusaetzliche Replay-Invariante und wandert nicht in den Payload.
     */
    if v_existing.vorgang_id is distinct from v_vorgang_id then
      raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
    end if;

    v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
    v_normalized_incoming := public.workspace_invoice_replay_candidate(
      p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
    );
    if v_normalized_existing is distinct from v_normalized_incoming then
      raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'invoice', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  /*
   * 01D — Single-Final-Invoice-Guard.
   *
   * Steht bewusst **nach** dem Idempotenz-Replay: Ein Wiederholungslauf nach
   * verlorener Antwort traegt dieselbe `client_invoice_id` und muss den
   * bestehenden Erfolg zurueckbekommen, nicht diesen Fehler. Die eigene
   * Kennung ist deshalb ausdruecklich ausgenommen.
   *
   * Der Vorgang ist an dieser Stelle bereits gesperrt; die Pruefung ist damit
   * gegen parallele Transaktionen desselben Vorgangs serialisiert. Ohne
   * Vorgang wird dieser Zweig nie betreten — `schluss` ist dort abgewiesen.
   *
   * 01C — `cancelled_at is null`: Eine stornierte Schlussrechnung bleibt
   * historisch stehen, blockiert aber die notwendige Ersatzrechnung nicht
   * mehr. Der partielle Unique-Index traegt dieselbe Bedingung; beide
   * Definitionen von „wirksame Schlussrechnung" duerfen nie auseinanderlaufen.
   */
  if v_invoice_type = 'schluss' then
    select exists (
      select 1
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = v_vorgang_id
        and wi.invoice_type = 'schluss'
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
        and wi.client_invoice_id <> trim(p_client_invoice_id)
    )
    into v_has_other_final;

    if coalesce(v_has_other_final, false) then
      raise exception 'invoice_final_already_exists';
    end if;
  end if;

  -- New Schluss only: amendment revision must match client expectation (default 0).
  -- Meta fields must agree when both are present; invalid values → invoice_amendment_state_stale.
  -- Runs after idempotent replay and before sequence lock / invoice insert.
  if v_invoice_type = 'schluss' then
    select coalesce(max(a.sequence_no), 0)
    into v_current_amendment_sequence
    from public.workspace_order_amendments a
    where a.workspace_id = p_workspace_id
      and a.vorgang_id = v_vorgang_id;

    v_has_expected_camel :=
      (p_invoice ? 'expectedAmendmentSequence')
      and jsonb_typeof(p_invoice->'expectedAmendmentSequence') is distinct from 'null';
    v_has_expected_snake :=
      (p_invoice ? 'expected_amendment_sequence')
      and jsonb_typeof(p_invoice->'expected_amendment_sequence') is distinct from 'null';

    if v_has_expected_camel then
      v_expected_camel := p_invoice->'expectedAmendmentSequence';
      if jsonb_typeof(v_expected_camel) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_camel::text)::numeric < 0
         or (v_expected_camel::text)::numeric <> trunc((v_expected_camel::text)::numeric)
         or (v_expected_camel::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_camel := ((v_expected_camel::text)::numeric)::integer;
    end if;

    if v_has_expected_snake then
      v_expected_snake := p_invoice->'expected_amendment_sequence';
      if jsonb_typeof(v_expected_snake) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_snake::text)::numeric < 0
         or (v_expected_snake::text)::numeric <> trunc((v_expected_snake::text)::numeric)
         or (v_expected_snake::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_snake := ((v_expected_snake::text)::numeric)::integer;
    end if;

    if v_has_expected_camel and v_has_expected_snake then
      if v_parsed_camel is distinct from v_parsed_snake then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_camel then
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_snake then
      v_expected_amendment_sequence := v_parsed_snake;
    else
      v_expected_amendment_sequence := 0;
    end if;

    if v_current_amendment_sequence is distinct from v_expected_amendment_sequence then
      raise exception 'invoice_amendment_state_stale';
    end if;
  end if;

  -- 01B2b-R1: v_issue_date und v_year sind oben, vor dem Replay, abgeleitet.

  /*
   * Ein gemeinsamer Nummernkreis fuer alle Rechnungen eines Workspace-Jahres.
   * Er kennt den Vorgang nicht und darf ihn nie kennenlernen — eine freie
   * Rechnung zaehlt genauso mit wie eine auftragsgebundene.
   */
  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select s.last_sequence
  into v_next_sequence
  from public.workspace_invoice_sequences s
  where s.workspace_id = p_workspace_id
    and s.invoice_year = v_year
  for update;

  if v_next_sequence is null then
    raise exception 'Nummernkreis konnte nicht gesperrt werden';
  end if;

  v_next_sequence := v_next_sequence + 1;
  v_invoice_number := public.format_workspace_invoice_number(v_year, v_next_sequence);

  v_payload := public.normalize_workspace_invoice_payload_for_idempotency(p_invoice)
    || jsonb_build_object(
      'id', trim(p_client_invoice_id),
      'number', v_invoice_number,
      'invoiceSequenceNumber', v_next_sequence,
      'type', v_invoice_type,
      'status', 'vorbereitet',
      'date', v_issue_date,
      'issueDate', coalesce(nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''), v_issue_date)
    );

  begin
    insert into public.workspace_invoices (
      workspace_id,
      vorgang_id,
      client_invoice_id,
      invoice_number,
      invoice_year,
      invoice_sequence_number,
      invoice_type,
      invoice_status,
      payload,
      row_version,
      updated_by
    )
    values (
      p_workspace_id,
      v_vorgang_id,
      trim(p_client_invoice_id),
      v_invoice_number,
      v_year,
      v_next_sequence,
      v_invoice_type,
      'vorbereitet',
      v_payload,
      1,
      v_user_id
    )
    returning * into v_existing;
  exception
    when unique_violation then
      select *
      into v_existing
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.client_invoice_id = trim(p_client_invoice_id);

      if not found then
        /*
         * 01D — Backstop des partiellen Unique-Index.
         *
         * Die eigene Kennung existiert nicht, trotzdem kollidierte der Insert:
         * Bei einer Schlussrechnung kann das nur die Single-Final-Invariante
         * sein. Statt einer rohen Constraint-Meldung derselbe benennbare
         * Fehler wie oben — sonst waere der Race-Ausgang fuer den Aufrufer
         * ununterscheidbar von einem beliebigen Datenbankfehler.
         */
        if v_invoice_type = 'schluss' then
          raise exception 'invoice_final_already_exists';
        end if;
        raise;
      end if;

      -- 01B2b (c) — dieselbe Replay-Invariante auch im Race-Ausgang.
      if v_existing.vorgang_id is distinct from v_vorgang_id then
        raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
      end if;

      -- 01B2b-R2: dieselbe Kandidatenfunktion wie im regulaeren Replay.
      v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
      v_normalized_incoming := public.workspace_invoice_replay_candidate(
        p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
      );
      if v_normalized_existing is distinct from v_normalized_incoming then
        raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
      end if;

      return jsonb_build_object(
        'idempotent_replay', true,
        'invoice', v_existing.payload,
        'row', to_jsonb(v_existing)
      );
  end;

  update public.workspace_invoice_sequences
  set last_sequence = v_next_sequence
  where workspace_id = p_workspace_id
    and invoice_year = v_year
    and last_sequence = v_next_sequence - 1;

  if not found then
    raise exception 'Nummernkreis konnte nicht erhöht werden';
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'invoice', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* 4) upsert_workspace_generated_invoice_document                             */
/* -------------------------------------------------------------------------- */

/*
 * Fortgeschrieben aus 20250827120000. Genau eine fachliche Aenderung: Die
 * Pflichtprueflung auf `linked_vorgang_id` entfaellt, weil eine Rechnung ohne
 * Auftrag auch ihr erzeugtes Dokument ohne Auftrag ablegt.
 *
 * Die Wahrheitsregel bleibt unveraendert und traegt den neuen Fall bereits:
 * Dokument- und Rechnungsvorgang muessen identisch sein, verglichen mit
 * `is distinct from`. Damit gilt NULL/NULL als korrekt, A/A als korrekt,
 * NULL/A und A/NULL als Konflikt — ohne eine einzige zusaetzliche Bedingung.
 * Der Leerstring bleibt ungueltig, aus demselben Grund wie oben.
 */
create or replace function public.upsert_workspace_generated_invoice_document(
  p_workspace_id uuid,
  p_client_document_id text,
  p_linked_invoice_id text,
  p_linked_vorgang_id text,
  p_payload jsonb
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice public.workspace_invoices;
  v_existing public.workspace_documents;
  v_inserted public.workspace_documents;
  v_document_id text;
  v_invoice_id text;
  v_vorgang_id text;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_document_id := nullif(trim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_linked_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'linked_invoice_id fehlt';
  end if;

  -- 01B2b: NULL heisst „kein Auftrag", '' heisst „kaputt".
  if p_linked_vorgang_id is not null and nullif(trim(p_linked_vorgang_id), '') is null then
    raise exception 'linked_vorgang_id fehlt';
  end if;
  v_vorgang_id := nullif(trim(coalesce(p_linked_vorgang_id, '')), '');

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;

  /*
   * Der Serialisierungspunkt.
   *
   * Ein `select … for update` auf die Dokumentzeile koennte nichts sperren,
   * solange es sie nicht gibt — genau der Fehler, den 04B2B3 fuer Zahlungen
   * korrigiert hat. Hier existiert aber bereits eine stabile Zeile fuer
   * dieselbe fachliche Einheit: die Rechnung. Zwei Geraete, die dieselbe
   * Rechnung archivieren, laufen zwangslaeufig durch dieselbe Zeile und werden
   * dort hintereinander gereiht. Der zweite sieht dann garantiert das Dokument
   * des ersten. Das gilt fuer die freie Rechnung genauso — sie hat eine Zeile.
   */
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;
  if v_invoice.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * 05C1C — der Vorgang kommt aus der Rechnung, nicht vom Client.
   *
   * Ohne diese Pruefung koennte ein Client fuer eine Rechnung einen beliebigen
   * fremden Vorgang behaupten — oder umgekehrt eine auftragsgebundene Rechnung
   * als frei ablegen. Abgeglichen wird die Spalte, nicht ein Titel oder ein
   * anderes Merkmal.
   */
  if v_vorgang_id is distinct from v_invoice.vorgang_id then
    raise exception 'Dokumentkonflikt: Vorgang passt nicht zur Rechnung';
  end if;

  /*
   * 05C1C — Payload und Spalten duerfen nicht zwei verschiedene Identitaeten
   * behaupten. Das ist bewusst keine vollstaendige Fachlogik in SQL: Die
   * semantische Vergleichsprojektion bleibt im Client (05C1B). Hier geht es
   * nur um die innere Widerspruchsfreiheit **einer** Zeile.
   *
   * Bei einer freien Rechnung fehlt `linkedVorgang` im Payload; der Ausdruck
   * liefert dann NULL und ist von `v_vorgang_id` NULL nicht verschieden.
   */
  if p_payload->>'linkedInvoiceId' is distinct from v_invoice_id
    or p_payload->'linkedVorgang'->>'vorgangId' is distinct from v_vorgang_id
  then
    raise exception 'Dokumentkonflikt: Payload widerspricht der Rechnungsidentitaet';
  end if;

  if p_payload->>'category' is distinct from 'ausgangsrechnung'
    or p_payload->>'classifiedKind' is distinct from 'ausgangsrechnung'
    or p_payload->>'archived' is distinct from 'true'
  then
    raise exception 'Dokumentkonflikt: Payload ist kein archiviertes Ausgangsrechnungs-Dokument';
  end if;

  /*
   * Fachliche Identitaet zuerst: Gibt es fuer diese Rechnung bereits ein
   * Dokument, ist das die kanonische Zeile — unabhaengig davon, welche lokale
   * Kennung das anfragende Geraet mitbringt.
   *
   * 05C1C — bewusst **ohne** `deleted_at is null`. Wuerde hier nur nach
   * aktiven Zeilen gesucht, saehe der RPC den Grabstein nicht und liefe in
   * einen Insert, den der Business-Key-Index hart abweist — mit einer
   * technischen Fehlermeldung statt einer verstaendlichen Aussage.
   */
  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and document_kind = 'generated_invoice'
    and linked_invoice_id = v_invoice_id;

  if v_existing.id is not null then
    /*
     * Grabsteinvorrang — vor allem anderen. Ein geloeschtes Dokument wird
     * weder wiederbelebt noch als Erfolg zurueckgegeben, und der Business Key
     * bleibt bei ihm. Ein echtes Wiederherstellen waere ein eigener Vertrag.
     */
    if v_existing.deleted_at is not null then
      raise exception 'Dokumentkonflikt: dieses Dokument wurde geloescht';
    end if;

    /*
     * Kein zweites Dokument, aber auch keine stille Uebernahme. Verglichen wird
     * die fachliche Substanz, nicht die lokale Kennung: Zwei Geraete duerfen
     * verschiedene `doc-`IDs haben, aber nicht verschiedene Inhalte behaupten.
     */
    if v_existing.linked_vorgang_id is distinct from v_vorgang_id then
      raise exception 'Dokumentkonflikt: abweichender Vorgang fuer dieselbe Rechnung';
    end if;

    return next v_existing;
    return;
  end if;

  /*
   * 05C1C — die Kennungspruefung gilt **nur** hier, beim Anlegen der neuen
   * kanonischen Zeile.
   *
   * Beim Replay eines zweiten Geraets traegt die kanonische Zeile die Kennung
   * des ersten; dort waere dieselbe Pruefung schlicht falsch und wuerde den
   * zulaessigen Zwei-Geraete-Fall unmoeglich machen. Deshalb steht sie hinter
   * der Rueckgabe der bestehenden Zeile.
   */
  if p_payload ? 'id' and p_payload->>'id' is distinct from v_document_id then
    raise exception 'Dokumentkonflikt: Payload-ID passt nicht zur Dokumentkennung';
  end if;

  insert into public.workspace_documents (
    workspace_id, client_document_id, document_kind,
    linked_invoice_id, linked_vorgang_id, payload, created_by, updated_by
  )
  values (
    p_workspace_id, v_document_id, 'generated_invoice',
    v_invoice_id, v_vorgang_id, p_payload, v_user_id, v_user_id
  )
  on conflict (workspace_id, client_document_id) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    /*
     * Dieselbe lokale Kennung existiert bereits — und zwar fuer eine **andere**
     * Rechnung, denn jede Zeile zu dieser Rechnung haette die fachliche Suche
     * oben gefunden, Grabsteine eingeschlossen. Eine Kennung darf nicht zwei
     * Rechnungen bezeichnen.
     */
    raise exception 'Dokumentkonflikt: diese Kennung gehoert zu einer anderen Rechnung';
  end if;

  -- Nachbedingung: Die zurueckgegebene Zeile bildet den Request vollstaendig ab.
  if v_inserted.workspace_id is distinct from p_workspace_id
    or v_inserted.client_document_id is distinct from v_document_id
    or v_inserted.document_kind is distinct from 'generated_invoice'
    or v_inserted.linked_invoice_id is distinct from v_invoice_id
    or v_inserted.linked_vorgang_id is distinct from v_vorgang_id
    or v_inserted.payload is distinct from p_payload
    or v_inserted.deleted_at is not null
  then
    raise exception 'Dokument Nachbedingung verletzt';
  end if;

  return next v_inserted;
end;
$$;

/* -------------------------------------------------------------------------- */
/* 5) Grants — unveraendert erneut gesetzt                                    */
/* -------------------------------------------------------------------------- */

-- Interne Hilfsfunktion: nur ueber finalize_workspace_invoice erreichbar.
revoke all on function public.workspace_invoice_replay_candidate(jsonb, text, text, jsonb) from public, anon, authenticated;

revoke all on function public.finalize_workspace_invoice(uuid, text, text, jsonb) from public, anon;
revoke all on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) from public, anon;

grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb) to authenticated;
grant execute on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) to authenticated;
