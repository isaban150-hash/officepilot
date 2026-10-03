-- R1-SEC-01 — serverseitige Autorisierung finanzwirksamer Aktionen.
--
-- Befund: Die acht finanzwirksamen RPCs pruefen heute uneinheitlich, wer sie
-- ausloesen darf. Rechnungen finalisieren sowie Rechnungszahlungen buchen und
-- stornieren standen jedem aktiven Mitglied offen (`is_active_workspace_member`),
-- waehrend Ausgaben und Kontierung owner/admin verlangten (`can_write_workspace`).
-- Ausgerechnet der verbindlichste Vorgang — eine nummerierte Rechnung in die
-- Welt setzen — war damit schwaecher geschuetzt als das Buchen einer Ausgabe.
--
-- Zweitens: `profiles.status` und `profiles.license_status` wurden serverseitig
-- nirgends gelesen. Ein gesperrtes Konto oder eine abgelaufene Lizenz hielt
-- allein der Client zurueck — und ein Client ist keine Sicherheitsgrenze.
--
-- Diese Migration aendert **keine Fachlogik**. Jede der acht Funktionen wird
-- wortgleich neu angelegt und bekommt als erste Anweisung einen gemeinsamen
-- Guard. Die bisherigen Pruefungen bleiben unberuehrt stehen: Der Guard ist
-- zusaetzlich, nicht an ihrer Stelle. Wer heute durfte und freigeschaltet ist,
-- merkt nichts.
--
-- Der erlaubte Kontozustand ist nicht erfunden, sondern der bereits geltende
-- Vertrag aus `licenseService.isUserAllowedToUseApp`: status = 'approved',
-- license_status = 'active', und `license_expires_at` entweder leer oder in der
-- Zukunft. Wer die App heute produktiv bedienen kann, erfuellt ihn zwingend —
-- andernfalls leitet die Anmeldung auf /waiting-approval, /access-blocked oder
-- /license-expired um. Niemand wird durch diese Migration neu ausgesperrt.

/* -------------------------------------------------------------------------- */
/* Der gemeinsame Guard                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fail-closed. Jede Ablehnung nennt ihren Grund mit stabilem Code, damit die
 * Oberflaeche ihn in Nutzersprache uebersetzen kann, ohne Rohtext zu zeigen.
 *
 * Die beiden Faelle "nicht angemeldet" und "kein Zugriff auf Workspace" behalten
 * bewusst ihren bisherigen Wortlaut: Der Client klassifiziert sie bereits, und
 * eine neue Formulierung haette diese Zuordnung still zerstoert.
 */
create or replace function public.assert_financial_action_allowed(p_workspace_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_status text;
  v_license text;
  v_expires timestamptz;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  -- B: aktives Mitglied. Nicht-Mitglieder bekommen denselben Satz wie bisher.
  v_role := public.workspace_member_role(p_workspace_id);
  if v_role is null then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  -- C: Rolle. Ein 'member' arbeitet mit, entscheidet aber nicht ueber Geld.
  if v_role not in ('owner', 'admin') then
    raise exception 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht'
      using errcode = 'P0001';
  end if;

  select p.status, p.license_status, p.license_expires_at
    into v_status, v_license, v_expires
  from public.profiles p
  where p.id = v_user_id;

  -- D: Freigabe. Ohne Profil gibt es keine Freigabe, die man pruefen koennte.
  if v_status is null then
    raise exception 'finance_account_not_approved: Konto ist nicht freigegeben'
      using errcode = 'P0001';
  end if;
  if v_status = 'blocked' then
    raise exception 'finance_account_blocked: Konto ist gesperrt'
      using errcode = 'P0001';
  end if;
  if v_status <> 'approved' then
    raise exception 'finance_account_not_approved: Konto ist nicht freigegeben'
      using errcode = 'P0001';
  end if;

  -- E: Lizenz. 'expired' und ein abgelaufenes Datum sind derselbe Fall.
  if v_license = 'expired' or (v_expires is not null and v_expires <= now()) then
    raise exception 'finance_license_expired: Lizenz ist abgelaufen'
      using errcode = 'P0001';
  end if;
  if v_license <> 'active' then
    raise exception 'finance_license_inactive: Keine aktive Lizenz'
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_financial_action_allowed(uuid) from public, anon;
grant execute on function public.assert_financial_action_allowed(uuid) to authenticated;

/* -------------------------------------------------------------------------- */
/* Die acht finanzwirksamen RPCs                                               */
/* -------------------------------------------------------------------------- */


-- finalize_workspace_invoice — wortgleich uebernommen aus 20261001120000_workspace_invoice_integrity.sql, nur der Guard kam hinzu.

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
  p_overbilling_acknowledged boolean default false
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



-- add_workspace_invoice_payment — wortgleich uebernommen aus 20261020120000_workspace_payment_method.sql, nur der Guard kam hinzu.

create or replace function public.add_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null
)
returns setof public.workspace_invoice_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice public.workspace_invoices;
  v_existing public.workspace_invoice_payments;
  v_inserted public.workspace_invoice_payments;
  v_invoice_id text;
  v_payment_id text;
  v_paid_on text;
  v_reference text;
  v_note text;
  v_method text;
  v_attempt int;
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

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  -- Kein Formatzwang: `pay-<millis>` und UUID sind beide gueltig.
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null then
    raise exception 'client_payment_id fehlt';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount ungueltig';
  end if;

  v_paid_on := nullif(trim(coalesce(p_paid_on, '')), '');
  if v_paid_on is null or v_paid_on !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'paid_on ungueltig';
  end if;
  -- Der echte Kalender: '2026-02-29' und '2026-04-31' existieren nicht.
  begin
    perform v_paid_on::date;
  exception
    when others then
      raise exception 'paid_on ungueltig';
  end;

  v_reference := nullif(trim(coalesce(p_reference, '')), '');
  v_note := nullif(trim(coalesce(p_note, '')), '');

  -- 02B — optionale Zahlungsart; NULL bleibt NULL.
  v_method := nullif(trim(coalesce(p_method, '')), '');
  if v_method is not null and v_method not in ('bank', 'cash', 'other') then
    raise exception 'method ungueltig';
  end if;

  -- Die Rechnung muss in der Cloud existieren und finalisiert sein.
  -- 01C: `for update` — gemeinsamer Serialisierungspunkt mit dem Storno.
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
  -- 01C: autoritative Spalte statt Payload.
  if v_invoice.cancelled_at is not null then
    raise exception 'Rechnung storniert';
  end if;

  -- Insert zuerst, pruefen danach (PAYMENT-SQL-CONCURRENCY-04B2B3).
  for v_attempt in 1..2 loop
    insert into public.workspace_invoice_payments (
      workspace_id, client_invoice_id, client_payment_id,
      amount, paid_on, reference, note, method, created_by
    )
    values (
      p_workspace_id, v_invoice_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_method, v_user_id
    )
    on conflict (workspace_id, client_invoice_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      if v_inserted.workspace_id is distinct from p_workspace_id
        or v_inserted.client_invoice_id is distinct from v_invoice_id
        or v_inserted.client_payment_id is distinct from v_payment_id
        or v_inserted.amount is distinct from round(p_amount, 2)
        or v_inserted.paid_on is distinct from v_paid_on::date
        or v_inserted.reference is distinct from v_reference
        or v_inserted.note is distinct from v_note
        or v_inserted.method is distinct from v_method
        or v_inserted.reversed_at is not null
      then
        raise exception 'Zahlung Nachbedingung verletzt';
      end if;

      return next v_inserted;
      return;
    end if;

    select * into v_existing
    from public.workspace_invoice_payments
    where workspace_id = p_workspace_id
      and client_invoice_id = v_invoice_id
      and client_payment_id = v_payment_id
    for update;

    if v_existing.id is not null then
      if v_existing.reversed_at is not null then
        raise exception 'Zahlungskonflikt: diese Zahlung wurde storniert';
      end if;

      if v_existing.amount is distinct from round(p_amount, 2)
        or v_existing.paid_on is distinct from v_paid_on::date
        or v_existing.reference is distinct from v_reference
        or v_existing.note is distinct from v_note
        or v_existing.method is distinct from v_method
      then
        raise exception 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten';
      end if;

      return next v_existing;
      return;
    end if;
  end loop;

  raise exception 'Zahlung nicht angelegt';
end;
$$;



-- reverse_workspace_invoice_payment — wortgleich uebernommen aus 20250905120000_workspace_invoice_cancellation.sql, nur der Guard kam hinzu.

create or replace function public.reverse_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text
)
returns setof public.workspace_invoice_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoice_payments;
  v_updated public.workspace_invoice_payments;
  v_invoice_id text;
  v_payment_id text;
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

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_invoice_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  -- 01C: Rechnung vor Zahlung sperren — dieselbe Richtung wie Storno und Zahlung.
  perform 1
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  select * into v_existing
  from public.workspace_invoice_payments
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
    and client_payment_id = v_payment_id
  for update;

  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  -- Idempotent: eine bereits reversierte Zahlung bleibt, wie sie ist.
  if v_existing.reversed_at is not null then
    return next v_existing;
    return;
  end if;

  update public.workspace_invoice_payments
  set reversed_at = now(),
      reversed_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.reversed_at is null then
    raise exception 'Reversal nicht angewendet';
  end if;

  return next v_updated;
end;
$$;



-- add_workspace_expense_payment — wortgleich uebernommen aus 20261020120000_workspace_payment_method.sql, nur der Guard kam hinzu.

create or replace function public.add_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null
)
returns setof public.workspace_expense_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_expense public.workspace_expenses;
  v_existing public.workspace_expense_payments;
  v_inserted public.workspace_expense_payments;
  v_expense_id text;
  v_payment_id text;
  v_paid_on text;
  v_reference text;
  v_note text;
  v_method text;
  v_attempt int;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_client_expense_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_expense_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount ungueltig';
  end if;
  v_paid_on := nullif(trim(coalesce(p_paid_on, '')), '');
  if v_paid_on is null or v_paid_on !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'paid_on ungueltig';
  end if;
  begin
    perform v_paid_on::date;
  exception
    when others then
      raise exception 'paid_on ungueltig';
  end;
  v_reference := nullif(trim(coalesce(p_reference, '')), '');
  v_note := nullif(trim(coalesce(p_note, '')), '');

  -- 02B — optionale Zahlungsart; NULL bleibt NULL.
  v_method := nullif(trim(coalesce(p_method, '')), '');
  if v_method is not null and v_method not in ('bank', 'cash', 'other') then
    raise exception 'method ungueltig';
  end if;

  select * into v_expense
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id;
  if v_expense.id is null then
    raise exception 'Ausgabe nicht gefunden';
  end if;
  if v_expense.deleted then
    raise exception 'Ausgabe geloescht';
  end if;
  if v_expense.status = 'storniert' then
    raise exception 'Ausgabe storniert';
  end if;

  -- Insert zuerst, pruefen danach (siehe PAYMENT-SQL-CONCURRENCY-04B2B3).
  for v_attempt in 1..2 loop
    insert into public.workspace_expense_payments (
      workspace_id, client_expense_id, client_payment_id,
      amount, paid_on, reference, note, method, created_by
    ) values (
      p_workspace_id, v_expense_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_method, v_user_id
    )
    on conflict (workspace_id, client_expense_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      return next v_inserted;
      return;
    end if;

    select * into v_existing
    from public.workspace_expense_payments
    where workspace_id = p_workspace_id
      and client_expense_id = v_expense_id
      and client_payment_id = v_payment_id
    for update;

    if v_existing.id is not null then
      if v_existing.reversed_at is not null then
        raise exception 'Zahlungskonflikt: diese Zahlung wurde storniert';
      end if;
      if v_existing.amount is distinct from round(p_amount, 2)
        or v_existing.paid_on is distinct from v_paid_on::date
        or v_existing.reference is distinct from v_reference
        or v_existing.note is distinct from v_note
        or v_existing.method is distinct from v_method
      then
        raise exception 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten';
      end if;
      return next v_existing;
      return;
    end if;
  end loop;

  raise exception 'Zahlung nicht angelegt';
end;
$$;



-- reverse_workspace_expense_payment — wortgleich uebernommen aus 20260917120000_workspace_expenses_cloud.sql, nur der Guard kam hinzu.

create or replace function public.reverse_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text
)
returns setof public.workspace_expense_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_expense_payments;
  v_updated public.workspace_expense_payments;
  v_expense_id text;
  v_payment_id text;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_client_expense_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_expense_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  select * into v_existing
  from public.workspace_expense_payments
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
    and client_payment_id = v_payment_id
  for update;

  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;
  if v_existing.reversed_at is not null then
    return next v_existing;
    return;
  end if;

  update public.workspace_expense_payments
  set reversed_at = now(),
      reversed_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return next v_updated;
end;
$$;



-- upsert_workspace_expense — wortgleich uebernommen aus 20261022120000_workspace_inbox_expense_id_server_owned.sql, nur der Guard kam hinzu.

create or replace function public.upsert_workspace_expense(
  p_workspace_id uuid,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_expense_id text;
  v_status text;
  v_deleted boolean;
  v_dedupe text;
  v_inbox text;
  v_archive text;
  v_payload jsonb;
  v_existing public.workspace_expenses;
  v_row public.workspace_expenses;
  v_active_payments int;
  v_net_cents bigint;
  v_tax_cents bigint;
  v_gross_cents bigint;
  v_tax_status text;
  v_money_unchanged boolean;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_payload->>'client_expense_id', '')), '');
  if v_expense_id is null then
    raise exception 'client_expense_id fehlt';
  end if;

  v_status := coalesce(nullif(p_payload->>'status', ''), 'gebucht');
  if v_status not in ('entwurf', 'gebucht', 'storniert') then
    raise exception 'Status ungueltig';
  end if;
  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_dedupe := coalesce(p_payload->>'dedupe_key', '');
  v_inbox := nullif(trim(coalesce(p_payload->>'linked_inbox_id', '')), '');
  v_archive := nullif(trim(coalesce(p_payload->>'archive_document_id', '')), '');
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;
  -- Zahlungen reisen nie im Payload — getrennte Wahrheit.
  v_payload := v_payload - 'payments' - 'sync';

  select * into v_existing
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
  for update;

  /* ---------------------------------------------------------------- */
  /* FINANZCORE-05B2 — die Geldpruefung                                */
  /* ---------------------------------------------------------------- */

  /*
   * Ein Grabstein traegt keine Betraege und schreibt keine Nutzlast: Beim
   * Loeschen wird nur `deleted` gesetzt, `payload` bleibt unangetastet.
   *
   * Deshalb wird hier **nicht** geprueft. Genau das erlaubt der Client-Guard
   * ebenfalls ausdruecklich: Ein ungueltiger Altbeleg muss loeschbar bleiben,
   * sonst haenge er fuer immer in der Cloud fest, ohne dass ihn jemand
   * entfernen koennte.
   */
  if not v_deleted then
    /*
     * Aendern sich die Geldfelder gar nicht, ist dies ein Replay derselben
     * Zeile — etwa beim erstmaligen Sync eines Geraets oder nach einem
     * Verbindungsabbruch.
     *
     * Ein solcher Aufruf schreibt nichts Neues an Geld und darf deshalb nicht
     * scheitern: Ein ungueltiger Altbeleg wuerde sonst bei jedem Sync erneut
     * abgelehnt und der Auftrag endlos wiederholt. Der Bestand bleibt lesbar,
     * er wird nur nicht besser.
     *
     * Sobald aber **ein** Geldfeld oder der Steuerstatus abweicht, ist es eine
     * fachliche Aenderung — und die muss gueltig sein.
     *
     * `jsonb`-Vergleich statt Textvergleich: `100.00` und `100` sind derselbe
     * Zahlwert und sollen nicht als Aenderung gelten.
     */
    v_money_unchanged := v_existing.id is not null
      and not v_existing.deleted
      and (v_existing.payload->'netAmount')   is not distinct from (v_payload->'netAmount')
      and (v_existing.payload->'taxAmount')   is not distinct from (v_payload->'taxAmount')
      and (v_existing.payload->'grossAmount') is not distinct from (v_payload->'grossAmount')
      and (v_existing.payload->'taxStatus')   is not distinct from (v_payload->'taxStatus');

    if not coalesce(v_money_unchanged, false) then
      v_net_cents   := public.workspace_expense_money_cents(v_payload->'netAmount');
      v_tax_cents   := public.workspace_expense_money_cents(v_payload->'taxAmount');
      v_gross_cents := public.workspace_expense_money_cents(v_payload->'grossAmount');
      v_tax_status  := nullif(trim(coalesce(v_payload->>'taxStatus', '')), '');

      if v_net_cents is null or v_tax_cents is null or v_gross_cents is null then
        raise exception 'expense_money_invalid_amount: netAmount/taxAmount/grossAmount fehlen oder sind unbrauchbar';
      end if;

      -- Die Gleichung. Gilt fuer jedes Vorzeichen: -100 + -19 = -119.
      if v_net_cents + v_tax_cents <> v_gross_cents then
        raise exception 'expense_money_equation_mismatch: % + % ergibt %, erwartet %',
          v_net_cents, v_tax_cents, v_net_cents + v_tax_cents, v_gross_cents;
      end if;

      /*
       * Sagt der Status, dass keine Umsatzsteuer anfaellt, ist ein
       * Steuerbetrag ein Widerspruch zum Status selbst. `unclear` steht
       * bewusst nicht in dieser Liste.
       */
      if v_tax_cents <> 0
        and v_tax_status in ('reverse_charge_13b', 'tax_free', 'kleinunternehmer_19') then
        raise exception 'expense_money_tax_on_zero_rate_status: % erlaubt keinen Steuerbetrag, erhalten % Cent',
          v_tax_status, v_tax_cents;
      end if;

      -- Ein positiver Steuerbetrag auf negativem Netto ist kein Beleg, sondern ein Tippfehler.
      if (v_net_cents > 0 and v_tax_cents < 0) or (v_net_cents < 0 and v_tax_cents > 0) then
        raise exception 'expense_money_tax_sign_mismatch: netto % Cent, steuer % Cent',
          v_net_cents, v_tax_cents;
      end if;
    end if;
  end if;

  if v_existing.id is null then
    if v_deleted then
      -- Grabstein fuer eine Zeile, die die Cloud nie sah: nichts anzulegen.
      return jsonb_build_object('row_version', 0, 'updated_at', now(), 'deleted', true, 'noop', true);
    end if;
    insert into public.workspace_expenses (
      workspace_id, client_expense_id, status, dedupe_key, linked_inbox_id,
      archive_document_id, payload, deleted, row_version, created_by
    ) values (
      p_workspace_id, v_expense_id, v_status, v_dedupe, v_inbox,
      v_archive, v_payload, false, 1, v_user_id
    )
    returning * into v_row;
  else
    if v_existing.row_version <> coalesce(p_row_version, -1) then
      raise exception 'Versionskonflikt: Ausgabe % hat Version %, erwartet %',
        v_expense_id, v_existing.row_version, p_row_version;
    end if;
    if v_existing.deleted then
      raise exception 'Ausgabe bereits geloescht';
    end if;
    if v_deleted then
      select count(*) into v_active_payments
      from public.workspace_expense_payments
      where workspace_id = p_workspace_id
        and client_expense_id = v_expense_id
        and reversed_at is null;
      if v_active_payments > 0 then
        raise exception 'Ausgabe hat gebuchte Zahlungen';
      end if;
      update public.workspace_expenses
      set deleted = true,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    else
      update public.workspace_expenses
      set status = v_status,
          dedupe_key = v_dedupe,
          linked_inbox_id = v_inbox,
          archive_document_id = v_archive,
          payload = v_payload,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    end if;
  end if;

  /*
   * `expense_id` am Eingang — eine Wahrheit: die Ausgabenzeile. Ein alter
   * Verweis auf diese Ausgabe wird geloest, der aktuelle gesetzt.
   */
  update public.workspace_inbox_items
  set expense_id = null,
      updated_at = now()
  where workspace_id = p_workspace_id
    and expense_id = v_expense_id
    and (v_row.deleted or client_inbox_id is distinct from v_row.linked_inbox_id);
  if not v_row.deleted and v_row.linked_inbox_id is not null then
    update public.workspace_inbox_items
    set expense_id = v_expense_id,
        updated_at = now()
    where workspace_id = p_workspace_id
      and client_inbox_id = v_row.linked_inbox_id
      and expense_id is distinct from v_expense_id;
  end if;

  return jsonb_build_object(
    'row_version', v_row.row_version,
    'updated_at', v_row.updated_at,
    'deleted', v_row.deleted
  );
end;
$$;



-- upsert_workspace_accounting_assignment — wortgleich uebernommen aus 20261008120000_workspace_accounting_assignments.sql, nur der Guard kam hinzu.

create or replace function public.upsert_workspace_accounting_assignment(
  p_workspace_id uuid,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_assignment_id text;
  v_source_type text;
  v_source_id text;
  v_deleted boolean;
  v_payload jsonb;
  v_existing public.workspace_accounting_assignments;
  v_row public.workspace_accounting_assignments;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_assignment_id := nullif(trim(coalesce(p_payload->>'client_assignment_id', '')), '');
  if v_assignment_id is null then
    raise exception 'client_assignment_id fehlt';
  end if;

  v_source_type := nullif(trim(coalesce(p_payload->>'source_type', '')), '');
  if v_source_type is null or v_source_type not in ('expense', 'invoice') then
    raise exception 'source_type ungueltig';
  end if;

  v_source_id := nullif(trim(coalesce(p_payload->>'source_id', '')), '');
  if v_source_id is null then
    raise exception 'source_id fehlt';
  end if;

  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;
  v_payload := v_payload - 'sync';

  select * into v_existing
  from public.workspace_accounting_assignments
  where workspace_id = p_workspace_id
    and client_assignment_id = v_assignment_id
  for update;

  /*
   * Ein Grabstein traegt keine Kontierung und wird deshalb nicht geprueft —
   * sonst liesse sich eine fehlerhafte Altzeile nicht mehr entfernen.
   */
  if not v_deleted then
    perform public.validate_workspace_accounting_payload(v_payload);
  end if;

  if v_existing.id is null then
    if v_deleted then
      -- Grabstein fuer eine Zeile, die die Cloud nie sah: nichts anzulegen.
      return jsonb_build_object('row_version', 0, 'updated_at', now(), 'deleted', true, 'noop', true);
    end if;
    insert into public.workspace_accounting_assignments (
      workspace_id, client_assignment_id, source_type, source_id,
      payload, deleted, row_version, created_by
    ) values (
      p_workspace_id, v_assignment_id, v_source_type, v_source_id,
      v_payload, false, 1, v_user_id
    )
    returning * into v_row;
  else
    if v_existing.row_version <> coalesce(p_row_version, -1) then
      raise exception 'Versionskonflikt: Kontierung % hat Version %, erwartet %',
        v_assignment_id, v_existing.row_version, p_row_version;
    end if;
    if v_existing.deleted then
      raise exception 'Kontierung bereits geloescht';
    end if;
    /*
     * Der Beleg einer Kontierung wechselt nicht. Waere das erlaubt, koennte
     * eine bestaetigte Zuordnung stillschweigend auf einen anderen Beleg
     * zeigen — und niemand saehe es.
     */
    if not v_deleted
       and (v_existing.source_type <> v_source_type or v_existing.source_id <> v_source_id) then
      raise exception 'accounting_source_immutable: Beleg einer Kontierung ist unveraenderlich'
        using errcode = 'P0001';
    end if;

    if v_deleted then
      update public.workspace_accounting_assignments
      set deleted = true,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    else
      update public.workspace_accounting_assignments
      set payload = v_payload,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    end if;
  end if;

  return jsonb_build_object(
    'row_version', v_row.row_version,
    'updated_at', v_row.updated_at,
    'deleted', v_row.deleted
  );
end;
$$;



-- close_workspace_accounting_period — wortgleich uebernommen aus 20261009120000_workspace_accounting_period_closures.sql, nur der Guard kam hinzu.

create or replace function public.close_workspace_accounting_period(
  p_workspace_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_closure_id text;
  v_year integer;
  v_month integer;
  v_fingerprint text;
  v_manifest jsonb;
  v_active public.workspace_accounting_period_closures;
  v_next_revision integer;
  v_row public.workspace_accounting_period_closures;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_closure_id := nullif(trim(coalesce(p_payload->>'client_closure_id', '')), '');
  if v_closure_id is null then
    raise exception 'client_closure_id fehlt';
  end if;

  begin
    v_year := (p_payload->>'period_year')::integer;
    v_month := (p_payload->>'period_month')::integer;
  exception when others then
    raise exception 'period_invalid: Jahr oder Monat unlesbar' using errcode = 'P0001';
  end;
  if v_year is null or v_month is null
     or v_year < 2000 or v_year > 2999
     or v_month < 1 or v_month > 12 then
    raise exception 'period_invalid: % / %', coalesce(v_year, -1), coalesce(v_month, -1)
      using errcode = 'P0001';
  end if;

  /*
   * Der Fingerprint ist der Kern des Abschlusses. Ohne ihn liesse sich spaeter
   * nicht sagen, worauf er sich bezog — dann waere es doch nur ein Boolean.
   */
  v_fingerprint := nullif(trim(coalesce(p_payload->>'fingerprint', '')), '');
  if v_fingerprint is null then
    raise exception 'closure_without_fingerprint: fingerprint fehlt' using errcode = 'P0001';
  end if;

  v_manifest := coalesce(p_payload->'manifest', '{}'::jsonb);
  if jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'closure_manifest_invalid: kein Objekt' using errcode = 'P0001';
  end if;
  if not (v_manifest ? 'entries') or jsonb_typeof(v_manifest->'entries') <> 'array' then
    raise exception 'closure_manifest_invalid: entries fehlen' using errcode = 'P0001';
  end if;
  /*
   * Das Manifest muss zu dem Monat gehoeren, der abgeschlossen wird. Ohne
   * diese Pruefung liesse sich der Stand eines fremden Monats als Nachweis
   * hinterlegen.
   */
  if nullif(v_manifest->>'monthKey', '') is distinct from
     (lpad(v_year::text, 4, '0') || '-' || lpad(v_month::text, 2, '0')) then
    raise exception 'closure_manifest_period_mismatch: % gehoert nicht zu %-%',
      coalesce(v_manifest->>'monthKey', '(fehlt)'), v_year, v_month
      using errcode = 'P0001';
  end if;

  select * into v_active
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = v_year
    and period_month = v_month
    and reopened_at is null
  for update;

  if v_active.id is not null then
    /*
     * Es gibt bereits einen offenen Abschluss.
     *
     * Derselbe Stand noch einmal geschickt ist ein Replay — etwa nach einem
     * Verbindungsabbruch — und darf keine zweite Revision erzeugen. Ein
     * **anderer** Stand dagegen waere ein stilles Ueberschreiben der aktiven
     * Revision: Dafuer muss der Monat erst bewusst wieder geoeffnet werden.
     */
    if v_active.fingerprint = v_fingerprint then
      return jsonb_build_object(
        'revision', v_active.revision,
        'closed_at', v_active.closed_at,
        'row_version', v_active.row_version,
        'noop', true
      );
    end if;
    raise exception 'period_already_closed: Revision % ist offen; bitte zuerst wieder oeffnen',
      v_active.revision using errcode = 'P0001';
  end if;

  select coalesce(max(revision), 0) + 1 into v_next_revision
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = v_year
    and period_month = v_month;

  insert into public.workspace_accounting_period_closures (
    workspace_id, client_closure_id, period_year, period_month, revision,
    fingerprint, manifest, closed_at, closed_by
  ) values (
    p_workspace_id, v_closure_id, v_year, v_month, v_next_revision,
    v_fingerprint, v_manifest, now(), v_user_id
  )
  returning * into v_row;

  return jsonb_build_object(
    'revision', v_row.revision,
    'closed_at', v_row.closed_at,
    'row_version', v_row.row_version,
    'noop', false
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* Nacharbeit 1 — die beiden unmittelbaren Nachbarn                            */
/* -------------------------------------------------------------------------- */

-- Der Recheck hat zwei Aufrufe nachgewiesen, die dieselbe Wirkung haben wie
-- bereits geschuetzte, aber noch ohne Kontopruefung dastanden:
--
--   * `cancel_workspace_invoice` — eine finalisierte Rechnung zu stornieren ist
--     mindestens so finanzwirksam wie eine Zahlung zu buchen. Die Rolle war
--     geprueft, der Kontozustand nicht: Ein gesperrtes oder lizenzabgelaufenes
--     Konto stornierte weiterhin.
--   * `reopen_workspace_accounting_period` — das direkte Gegenstueck zum
--     geschuetzten Abschliessen. Schliessen war abgesichert, Wiedereroeffnen
--     nicht — und gerade das Wiedereroeffnen hebt den Abschluss auf.
--
-- Beide bekommen denselben Guard an derselben Stelle. Fachlogik unberuehrt.


-- cancel_workspace_invoice — wortgleich uebernommen aus 20261004120000_workspace_invoice_cancel_abschlag.sql, nur der Guard kam hinzu.

create or replace function public.cancel_workspace_invoice(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_reason text
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_reason text;
  v_vorgang_id text;
  v_existing public.workspace_invoices;
  v_updated public.workspace_invoices;
  v_active_payments integer;
  v_now timestamptz := now();
  v_kind text;
  v_document_id text;
  v_document public.workspace_documents;
  v_payload jsonb;
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

  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'invoice_cancel_reason_required';
  end if;

  /*
   * Lock-Reihenfolge Vorgang -> Rechnung -> Zahlungen, wie in allen
   * rechnungsschreibenden Funktionen. Der Auftragsbezug einer Rechnung ist
   * unveraenderlich; er darf deshalb ohne Sperre gelesen werden, bevor der
   * Vorgang gesperrt wird.
   *
   * 01B — ausdruecklich gekoppelt statt eines Joins, der bei NULL still keine
   * Zeile sperrt: Ohne Auftrag ist nur die normale Rechnung zulaessig, und es
   * gibt keinen Vorgang, an dem eine Serialisierung haengen koennte.
   */
  select wi.vorgang_id
  into v_vorgang_id
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = v_invoice_id;

  if not found then
    raise exception 'Rechnung nicht gefunden';
  end if;

  if v_vorgang_id is not null then
    perform 1
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;
  end if;

  select *
  into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  /*
   * Idempotenz vor jeder Pruefung: Ein zweiter Aufruf ist kein Ereignis.
   * Grund, Zeitpunkt, Art und Korrekturbeleg bleiben, wie sie waren — auch
   * bei abweichender zweiter Begruendung.
   */
  if v_existing.cancelled_at is not null then
    return next v_existing;
    return;
  end if;

  if v_existing.vorgang_id is null and v_existing.invoice_type is distinct from 'rechnung' then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  /*
   * TEILRECHNUNG-03C -- eine Teilrechnung ist eine echte Forderung ueber einen
   * abgegrenzten Teil der Auftragsleistung. Sie verbraucht Menge wie jede
   * Rechnung, also muss sie sich auch wie jede Rechnung zurueckholen lassen --
   * sonst bliebe ein Fehlbeleg dauerhaft stehen und seine Menge verbraucht.
   * Alles andere bleibt: Abschlaege sind hier weiterhin nicht vorgesehen, und
   * eine Rechnung ohne Auftrag (oben) bleibt auf 'rechnung' beschraenkt.
   */
  /*
   * RECHNUNGSBEREICH-03D -- auch die Abschlagsrechnung ist stornierbar.
   *
   * Sie ist eine echte Forderung: Der mengenbasierte Abschlag verbraucht
   * Auftragsmenge, der pauschale nimmt Geld vorweg, das die Schlussrechnung
   * abzieht. Bleibt ein Fehlbeleg stehen, bleibt beides verbraucht. Die
   * Wirkung des Stornos steht bereits: `isBillingEffective` (Client) und die
   * 03B/03B2-Funktionen lesen `cancelled_at`, also faellt ein stornierter
   * Abschlag ohne weiteres Zutun aus Menge **und** Abzug heraus. Hier fehlt
   * nur die Erlaubnis.
   *
   * Die Abschlagsnummer bleibt vergeben -- vergeben ist vergeben
   * (`getNextAbschlagNumber`); zwei Belege mit derselben Nummer darf es nie
   * geben.
   */
  if v_existing.invoice_type not in ('rechnung', 'teilrechnung', 'abschlag', 'schluss') then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  if v_existing.invoice_status not in ('vorbereitet', 'versendet') then
    raise exception 'invoice_cancel_not_finalized';
  end if;

  -- D1: aktive Zahlung -> keine Stornierung, nichts wird zurueckgebucht.
  select count(*)
  into v_active_payments
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = v_invoice_id
    and p.reversed_at is null;

  if coalesce(v_active_payments, 0) > 0 then
    raise exception 'invoice_cancel_has_active_payments';
  end if;

  v_kind := case when v_existing.invoice_status = 'versendet' then 'correction' else 'internal' end;

  if v_kind = 'correction' then
    /*
     * D2/B — der Korrekturbeleg entsteht hier, in derselben Transaktion.
     * Deterministische Kennung: derselbe Retry trifft dieselbe Zeile.
     *
     * Der Payload ist ein selbstbeschreibender Datensatz. Er traegt den
     * finalen Original-Payload unveraendert als Snapshot; nichts wird hier
     * gerechnet. Ordner, Tags und Suchtext bildet der Client deterministisch.
     */
    v_document_id := 'corr-' || v_invoice_id;

    select *
    into v_document
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id
      and d.client_document_id = v_document_id
    for update;

    if v_document.id is not null then
      if v_document.document_kind is distinct from 'generated_invoice_correction'
         or v_document.linked_invoice_id is distinct from v_invoice_id then
        raise exception 'Dokumentkonflikt: Kennung gehoert zu einem anderen Dokument';
      end if;
      if v_document.deleted_at is not null then
        raise exception 'Dokumentkonflikt: Korrekturbeleg wurde geloescht';
      end if;
    else
      v_payload := jsonb_build_object(
        'id', v_document_id,
        'documentType', 'rechnungskorrektur',
        'correctionKind', 'storno',
        'category', 'ausgangsrechnung',
        'classifiedKind', 'rechnungskorrektur',
        'archived', true,
        'title', 'Rechnungskorrektur zu Rechnung ' || v_existing.invoice_number,
        'issuer', coalesce(v_existing.payload->'companySnapshot'->>'companyName', ''),
        'linkedInvoiceId', v_invoice_id,
        'linkedVorgangId', v_existing.vorgang_id,
        'originalClientInvoiceId', v_invoice_id,
        'originalInvoiceNumber', v_existing.invoice_number,
        'originalInvoiceType', v_existing.invoice_type,
        'originalIssueDate', coalesce(v_existing.payload->>'issueDate', v_existing.payload->>'date'),
        'cancelledAt', to_char(timezone('utc', v_now), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'correctionIssueDate', to_char(timezone('utc', v_now), 'YYYY-MM-DD'),
        'cancelReason', v_reason,
        'customerId', v_existing.payload->>'customerId',
        'companySnapshot', v_existing.payload->'companySnapshot',
        'customerSnapshot', v_existing.payload->'customerSnapshot',
        'servicePeriodFrom', v_existing.payload->>'servicePeriodFrom',
        'servicePeriodTo', v_existing.payload->>'servicePeriodTo',
        'taxStatus', v_existing.payload->>'taxStatus',
        'originalInvoiceSnapshot', v_existing.payload
      );

      insert into public.workspace_documents (
        workspace_id, client_document_id, document_kind,
        linked_invoice_id, linked_vorgang_id, payload, created_by, updated_by
      )
      values (
        p_workspace_id, v_document_id, 'generated_invoice_correction',
        v_invoice_id, v_existing.vorgang_id, v_payload, v_user_id, v_user_id
      )
      returning * into v_document;

      if v_document.id is null then
        raise exception 'Korrekturbeleg nicht angelegt';
      end if;
    end if;
  end if;

  /*
   * `invoice_status`, Nummer, Positionen, Betraege, Snapshots, Versandangaben,
   * Zahlungsdatensaetze und Archivhistorie bleiben unangetastet. Der
   * Payload-Spiegel dient aelteren Clients.
   */
  update public.workspace_invoices
  set cancelled_at = v_now,
      cancelled_by = v_user_id,
      cancel_reason = v_reason,
      cancellation_kind = v_kind,
      correction_document_id = v_document_id,
      payload = payload || jsonb_build_object(
        'cancelledAt', to_char(timezone('utc', v_now), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'cancelReason', v_reason
      ),
      row_version = row_version + 1,
      updated_at = v_now,
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.cancelled_at is null then
    raise exception 'Stornierung nicht angewendet';
  end if;

  if v_kind = 'correction' and v_updated.correction_document_id is null then
    raise exception 'Stornierung ohne Korrekturbeleg';
  end if;

  return next v_updated;
end;
$$;


-- reopen_workspace_accounting_period — wortgleich uebernommen aus 20261009120000_workspace_accounting_period_closures.sql, nur der Guard kam hinzu.

create or replace function public.reopen_workspace_accounting_period(
  p_workspace_id uuid,
  p_period_year integer,
  p_period_month integer,
  p_reason text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_active public.workspace_accounting_period_closures;
  v_row public.workspace_accounting_period_closures;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  select * into v_active
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = p_period_year
    and period_month = p_period_month
    and reopened_at is null
  for update;

  if v_active.id is null then
    raise exception 'period_not_closed: kein offener Abschluss fuer %-%',
      p_period_year, p_period_month using errcode = 'P0001';
  end if;

  /*
   * Der Aufrufer nennt die Revision, die er wieder oeffnen will. Hat inzwischen
   * jemand anders geoeffnet und neu abgeschlossen, trifft er eine andere — und
   * soll das erfahren, statt still die falsche zu oeffnen.
   */
  if p_expected_revision is not null and v_active.revision <> p_expected_revision then
    raise exception 'Versionskonflikt: offene Revision ist %, erwartet %',
      v_active.revision, p_expected_revision;
  end if;

  update public.workspace_accounting_period_closures
  set reopened_at = now(),
      reopened_by = v_user_id,
      reopen_reason = nullif(trim(coalesce(p_reason, '')), ''),
      row_version = row_version + 1,
      updated_at = now()
  where id = v_active.id
  returning * into v_row;

  return jsonb_build_object(
    'revision', v_row.revision,
    'reopened_at', v_row.reopened_at,
    'row_version', v_row.row_version
  );
end;
$$;
