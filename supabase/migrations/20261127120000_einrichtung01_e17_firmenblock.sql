-- EINRICHTUNG-01 / E17 (entschieden 23.10.2026) — Firmenblockpruefung bei der Rechnungsfreigabe.
--
-- Katalog V3 (abgestimmt 23.10.2026), Vertrag 1.2 und S-03.2 bis S-03.9:
--   * ein neuer Pruefhelfer assert_workspace_invoice_company_snapshot(jsonb);
--   * genau EIN zusaetzlicher Aufruf in finalize_workspace_invoice, nach
--     assert_workspace_invoice_integrity(...) und vor der Nummernkreiszeile;
--   * sonst ist die Funktion WOERTLICH die Fassung aus 20261110120000_finanz_core_01a.sql
--     (erzeugt mit pruefunterlagen/einrichtung-01/werkzeug/erzeuge-e17-migration.mjs,
--     Gleichstand mit der laufenden Datenbank geprueft, Diff-Beleg im Pruefordner);
--   * kein Trigger, kein Backfill, keine Aenderung an Fachregeln oder Fehlervertraegen.
--
-- Nur lokal. Nicht remote anwenden (Gesamtveroeffentlichung RELEASE-01).

create or replace function public.assert_workspace_invoice_company_snapshot(p_invoice jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_key text;
begin
  /*
   * EINRICHTUNG-01 (E17) -- nur die Schluesselpruefung des Firmenblocks, keine
   * allgemeine Payload-Pruefung. Fehlt der Firmenblock (oder ist er JSON null),
   * bleibt das bisherige Verhalten. Ist er vorhanden, muss er ein Objekt sein,
   * dessen Schluessel der obersten Ebene in der Positivliste liegen.
   */
  if p_invoice is null
     or not (p_invoice ? 'companySnapshot')
     or jsonb_typeof(p_invoice->'companySnapshot') = 'null' then
    return;
  end if;
  if jsonb_typeof(p_invoice->'companySnapshot') <> 'object' then
    raise exception 'invoice_company_snapshot_invalid:%', 'companySnapshot' using errcode = 'P0001';
  end if;
  select k
  into v_key
  from jsonb_object_keys(p_invoice->'companySnapshot') as k
  where k <> all (array['companyName', 'legalForm', 'logoDataUrl', 'street', 'zip', 'city', 'country', 'countryCode', 'contactPerson', 'phone', 'email', 'website', 'taxNumber', 'vatId', 'registrationAuthority', 'registrationNumber', 'bankName', 'iban', 'bic', 'accountHolder', 'defaultPaymentDays', 'defaultPaymentTerms', 'defaultSkonto', 'skontoEnabled', 'skontoPercent', 'skontoDays', 'managingDirector', 'taxFreeNotice', 'invoiceFooterNotes']::text[])
  order by k
  limit 1;
  if v_key is not null then
    raise exception 'invoice_company_snapshot_invalid:%', v_key using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_workspace_invoice_company_snapshot(jsonb) from public, anon, authenticated, service_role;

create or replace function public.finalize_workspace_invoice(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb,
  /*
   * RECHNUNGSINTEGRITAET-03B -- die bewusste Entscheidung des Nutzers, ueber
   * den dokumentierten Rest hinaus abzurechnen. Sie ersetzt keine Pruefung:
   * Der Server stellt die Ueberschreitung weiterhin selbst fest und laesst sie
   * nur mit diesem Flag zu. Vorgabewert false -- wer nichts sagt, bestaetigt
   * nichts.
   */
  p_overbilling_acknowledged boolean default false,
  /*
   * CLOUD-SYNC S5 -- die Bindung an den Cloud-Entwurf. Beide Angaben gehoeren
   * zusammen: die Kennung des Entwurfs und die Version, auf der die Freigabe
   * vorbereitet wurde. Fehlen beide, bleibt alles wie bisher -- ein Altbestand
   * ohne Cloud-Entwurf.
   */
  p_client_draft_id text default null,
  p_expected_draft_row_version bigint default null
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
  /* FINANZ-CORE-01A (SQL-03) -- der gesperrte Stand der Jahreszeile. */
  v_locked_sequence integer;
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
  /* CLOUD-SYNC S5 -- Entwurfsbindung. */
  v_draft public.workspace_invoice_drafts;
  v_draft_id text;
begin
  /*
   * R1-SEC-01 — Autorisierung vor allem anderen. Die bisherigen Pruefungen
   * darunter bleiben unveraendert stehen; dieser Aufruf ist zusaetzlich.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

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
   * CLOUD-SYNC S5 -- Bindung an den Cloud-Entwurf.
   *
   * Steht bewusst NACH dem Idempotenz-Replay: Eine Wiederholung derselben
   * `client_invoice_id` bekommt ihren bestehenden Erfolg zurueck, auch wenn
   * der Entwurf inzwischen finalisiert ist -- durch eben diese Rechnung.
   *
   * Und VOR jeder Rechnungspruefung, der Nummernvergabe und dem Insert: Der
   * Entwurf wird gesperrt und muss genau in der vorbereiteten Version aktiv
   * sein. Ein zweites Geraet, das denselben Entwurf mit einer eigenen
   * `client_invoice_id` freigeben will, wartet an dieser Sperre und findet
   * danach `finalized` vor -- es entsteht keine zweite Rechnung und keine
   * zweite Nummer. Jede Ablehnung hier rollt die ganze Transaktion zurueck:
   * Es wurde nichts geschrieben und keine Nummer verbraucht.
   */
  v_draft_id := nullif(trim(coalesce(p_client_draft_id, '')), '');
  if (p_client_draft_id is not null and v_draft_id is null)
     or ((v_draft_id is null) <> (p_expected_draft_row_version is null))
     or coalesce(p_expected_draft_row_version, 1) < 1 then
    raise exception 'invoice_draft_binding_invalid';
  end if;

  if v_draft_id is not null then
    select d.*
    into v_draft
    from public.workspace_invoice_drafts d
    where d.workspace_id = p_workspace_id
      and d.client_draft_id = v_draft_id
    for update;

    if not found then
      raise exception 'invoice_draft_not_found';
    end if;

    if v_draft.status = 'finalized' then
      /*
       * Gleichzeitige Wiederholung derselben Kennung: Der Replay oben lief,
       * bevor der erste Aufruf festgeschrieben war; die Sperre hat bis dahin
       * gewartet. Das ist der eigene Erfolg und wird genau wie ein Replay
       * beantwortet -- mit denselben Invarianten.
       */
      if v_draft.finalized_client_invoice_id = trim(p_client_invoice_id) then
        select *
        into v_existing
        from public.workspace_invoices wi
        where wi.workspace_id = p_workspace_id
          and wi.client_invoice_id = trim(p_client_invoice_id);

        if not found then
          raise exception 'invoice_draft_already_finalized:%', v_draft.finalized_client_invoice_id;
        end if;

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

      -- Ein anderes Geraet hat diesen Entwurf bereits zur Rechnung gemacht.
      raise exception 'invoice_draft_already_finalized:%', v_draft.finalized_client_invoice_id;
    end if;

    if v_draft.deleted then
      raise exception 'invoice_draft_discarded';
    end if;

    if v_draft.vorgang_id is distinct from v_vorgang_id or v_draft.invoice_type <> v_invoice_type then
      raise exception 'invoice_draft_slot_mismatch';
    end if;

    if v_draft.row_version <> p_expected_draft_row_version then
      raise exception 'invoice_draft_version_conflict:%', v_draft.row_version;
    end if;
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

  /*
   * FINANZ-CORE-01A (SQL-04) -- nach einer wirksamen Schlussrechnung entsteht
   * fuer diesen Vorgang keine weitere Rechnung. Die Oberflaeche bietet das
   * nicht an; ein Geraet mit veraltetem Stand kennt die Schlussrechnung aber
   * womoeglich noch nicht. Ein weiterer Abschlag wuerde von keiner
   * Schlussrechnung mehr abgezogen, eine weitere Teilrechnung berechnete
   * Leistung neben der Schlussabrechnung.
   *
   * Wie der 01D-Guard nach dem Idempotenz-Replay (eine Wiederholung bekommt
   * ihren Erfolg) und vor jeder Nummernvergabe; der Vorgang ist gesperrt.
   * Nach einem Storno der Schlussrechnung ist wieder alles erlaubt (01C).
   */
  if v_vorgang_id is not null and v_invoice_type <> 'schluss' then
    if exists (
      select 1
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = v_vorgang_id
        and wi.invoice_type = 'schluss'
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
        and wi.client_invoice_id <> trim(p_client_invoice_id)
    ) then
      raise exception 'invoice_after_final_invoice';
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

  /*
   * RECHNUNGSINTEGRITAET-03B -- ab hier entsteht eine **neue** Rechnung.
   *
   * Der Vorgang ist oben bereits mit `for update` gesperrt; die Pruefung liest
   * den Abrechnungsstand in derselben Transaktion und ist damit gegen ein
   * zweites Geraet serialisiert. Ein Replay ist oben schon zurueckgekehrt.
   */
  perform public.assert_workspace_invoice_integrity(
    p_workspace_id,
    v_vorgang_id,
    trim(p_client_invoice_id),
    p_invoice,
    coalesce(p_overbilling_acknowledged, false)
  );

  /*
   * EINRICHTUNG-01 (E17, entschieden 23.10.2026) -- der Firmenblock darf nur
   * Schluessel der unveraenderten Positivliste COMPANY_SNAPSHOT_KEYS tragen.
   * Steht bewusst nach Autorisierung, Idempotenz-Replay und allen bestehenden
   * Vorpruefungen (deren Fehlerreihenfolge bleibt) und vor Nummernkreiszeile,
   * Nummernvergabe und Rechnungs-INSERT: eine Abweisung verbraucht keine Nummer.
   * Kein Bereinigen -- ein unzulaessiger Schluessel wird abgewiesen.
   */
  perform public.assert_workspace_invoice_company_snapshot(p_invoice);

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

  /*
   * FINANZ-CORE-01A (SQL-03) -- ein Format ohne Jahreszahl zaehlt
   * jahresuebergreifend weiter. Bisher begann jedes Jahr bei 1, und "RE-0001"
   * des Folgejahres kollidierte mit "RE-0001" des Vorjahres: Jede Freigabe
   * scheiterte dauerhaft am Unique-Index. Mit Jahreszahl bleibt alles wie
   * bisher.
   */
  v_locked_sequence := v_next_sequence;
  v_next_sequence := public.workspace_invoice_sequence_floor(p_workspace_id, v_year, v_next_sequence);
  v_next_sequence := v_next_sequence + 1;
  /*
   * FIRMENPROFIL-01C -- Format des Nummernkreises: beim ersten Vergeben eines
   * Jahres wird das Workspace-Standardformat auf der (hier bereits gesperrten)
   * Sequenzzeile eingefroren; danach zaehlt nur noch die eingefrorene Kopie.
   */
  v_invoice_number := public.format_workspace_invoice_number(p_workspace_id, v_year, v_next_sequence);

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
    and last_sequence = v_locked_sequence;

  if not found then
    raise exception 'Nummernkreis konnte nicht erhöht werden';
  end if;

  /*
   * CLOUD-SYNC S5 -- der Entwurf wird in derselben Transaktion verbraucht.
   * Es gibt keinen Zwischenstand, in dem die Rechnung existiert und der
   * Entwurf noch aktiv ist. Scheitert das, rollt die ganze Freigabe zurueck.
   */
  if v_draft_id is not null then
    update public.workspace_invoice_drafts
    set
      status = 'finalized',
      finalized_client_invoice_id = trim(p_client_invoice_id),
      row_version = row_version + 1,
      updated_by = v_user_id
    where workspace_id = p_workspace_id
      and client_draft_id = v_draft_id
      and status = 'active'
      and not deleted
      and row_version = p_expected_draft_row_version;

    if not found then
      raise exception 'invoice_draft_consume_failed';
    end if;
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'invoice', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;
