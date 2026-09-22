-- RECHNUNGSINTEGRITAET-03B -- der Server prueft die Rechnung selbst.
--
-- Bis hierher war `finalize_workspace_invoice` ein Nummernkreis mit
-- Idempotenz: Vorgangsbezug, Typ, Einmaligkeit der Schlussrechnung und der
-- Nachtragsstand wurden geprueft -- Positionen, Mengen, Preise, Steuer und
-- Summen kamen ungeprueft aus dem Client. Zwei Geraete konnten damit
-- nacheinander je 6 von 10 offenen Stunden abrechnen, und der Server sah
-- keinen Widerspruch.
--
-- Diese Migration ergaenzt genau diese Pruefung, ohne die bestehende
-- Fachlogik zu verschieben:
--
--   * Abrechnungsstand: Der Server summiert die bereits wirksam abgerechnete
--     Menge je Auftragsposition selbst (`workspace_invoice_billed_quantity`);
--     stornierte und nicht finalisierte Belege zaehlen nicht, die eigene
--     Kennung wird ausgenommen (Replay).
--   * Grenze: Wie im Client ist der Massstab der dokumentierte Ist-Rest, wenn
--     eine Ausfuehrungsmenge erfasst ist, sonst der offene Planrest. Eine
--     bewusste Ueberschreitung bleibt moeglich -- aber nur mit ausdruecklicher
--     Bestaetigung, die der Client jetzt als eigenen Parameter mitsendet.
--   * Kaufmaennische Wahrheit: Einheit und Einzelpreis muessen zur
--     autoritativen Auftragsposition passen; Netto, Steuer und Endbetrag
--     rechnet der Server aus den geprueften Positionen nach und weist
--     abweichende Clientwerte ab.
--   * Steuerstatus: Ein bestaetigter eigener Auftrag gibt ihn vor.
--   * Kundenbeleg: Der Name im Rechnungssnapshot muss zum eingefrorenen
--     Auftrag oder zum aktuellen Kundenstamm passen; die Anschrift bleibt
--     bewusst frei (abweichende Rechnungsanschrift ist bestehende Fachregel).
--
-- Alles laeuft in derselben Transaktion wie bisher, hinter dem bestehenden
-- `for update` auf dem Vorgang. Bestehende Rechnungen werden nicht angefasst,
-- es entsteht keine neue Tabelle, und der Replay-Weg bleibt unveraendert: Die
-- Pruefung steht **nach** dem Idempotenz-Replay und laeuft fuer eine bereits
-- finalisierte Rechnung gar nicht erst.

-- Bereits wirksam abgerechnete Menge einer Auftragsposition.
-- Dieselbe Definition wie `isBillingEffective` im Client: nur finalisierte,
-- nicht stornierte Belege zaehlen. Die eigene Rechnung wird ausgenommen.
create or replace function public.workspace_invoice_billed_quantity(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_order_position_id text,
  p_exclude_client_invoice_id text
)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(sum((pos.value->>'quantity')::numeric), 0)
  from public.workspace_invoices wi
  cross join lateral jsonb_array_elements(coalesce(wi.payload->'positions', '[]'::jsonb)) pos
  where wi.workspace_id = p_workspace_id
    and wi.vorgang_id = p_vorgang_id
    and wi.invoice_status in ('vorbereitet', 'versendet')
    and wi.cancelled_at is null
    and coalesce(wi.payload->>'paymentStatus', '') <> 'storniert'
    and wi.client_invoice_id is distinct from p_exclude_client_invoice_id
    and pos.value->>'orderPositionId' = p_order_position_id
    and jsonb_typeof(pos.value->'quantity') = 'number';
$$;

-- Netto-Summe der wirksamen Abschlagsrechnungen (brutto `amount`, wie
-- `getAbschlagDeductionsTotal` im Client) -- die Abzugsbasis der Schlussrechnung.
create or replace function public.workspace_invoice_abschlag_deductions(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_exclude_client_invoice_id text
)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(sum(round((wi.payload->>'amount')::numeric * 100)), 0) / 100
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.vorgang_id = p_vorgang_id
    and wi.invoice_type = 'abschlag'
    and wi.invoice_status in ('vorbereitet', 'versendet')
    and wi.cancelled_at is null
    and coalesce(wi.payload->>'paymentStatus', '') <> 'storniert'
    and wi.client_invoice_id is distinct from p_exclude_client_invoice_id
    and jsonb_typeof(wi.payload->'amount') = 'number';
$$;

/*
 * Die Rechnungsintegritaet in einer Funktion -- sie wirft oder sie schweigt.
 *
 * Bewusst getrennt von `finalize_workspace_invoice`: Der Finalisierer bleibt
 * lesbar, und der Laufzeittest kann genau diese Regeln einzeln pruefen.
 */
create or replace function public.assert_workspace_invoice_integrity(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb,
  p_overbilling_acknowledged boolean
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_vorgang public.workspace_vorgaenge;
  v_type text;
  v_tax_status text;
  v_rate numeric;
  v_mode text;
  v_line jsonb;
  v_order_position jsonb;
  v_position_id text;
  v_quantity numeric;
  v_unit_price numeric;
  v_billed numeric;
  v_reference numeric;
  v_executed numeric;
  v_planned numeric;
  v_material_source text;
  v_billable boolean;
  v_subtotal_cents numeric := 0;
  v_tax_cents numeric;
  v_gross_cents numeric;
  v_deduction_cents numeric := 0;
  v_client_deduction_cents numeric := 0;
  v_amount_cents numeric;
  v_client_subtotal_cents numeric;
  v_client_amount_cents numeric;
  v_fixed_net numeric;
  v_customer_name text;
  v_order_customer text;
  v_master_customer text;
begin
  v_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  v_tax_status := nullif(trim(coalesce(p_invoice->>'taxStatus', '')), '');
  v_rate := public.workspace_tax_rate_for_status(coalesce(v_tax_status, ''));
  if v_rate is null then
    raise exception 'invoice_tax_status_invalid' using errcode = 'P0001';
  end if;

  -- Ohne Auftrag (freie Rechnung) bleibt es bei der bisherigen Pruefung:
  -- Es gibt keine Auftragsposition, gegen die geprueft werden koennte.
  if p_vorgang_id is null then
    return;
  end if;

  select * into v_vorgang
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id and v.vorgang_id = p_vorgang_id;
  if not found then
    raise exception 'Vorgang gehört nicht zum Workspace oder existiert nicht' using errcode = 'P0001';
  end if;

  v_material_source := coalesce(v_vorgang.payload->>'materialSource', 'unclear');
  v_mode := coalesce(p_invoice->>'calculationMode', 'quantity_based');

  /* Steuerstatus: Ein bestaetigter eigener Auftrag gibt ihn vor. */
  if v_vorgang.payload ? 'taxStatus'
     and nullif(trim(coalesce(v_vorgang.payload->>'taxStatus', '')), '') is not null
     and v_tax_status is distinct from v_vorgang.payload->>'taxStatus' then
    raise exception 'invoice_tax_status_mismatch' using errcode = 'P0001';
  end if;

  /* Kundenbeleg: Name muss zum Auftrag oder zum Kundenstamm passen. */
  v_order_customer := nullif(trim(coalesce(v_vorgang.payload->'customerBilling'->>'name', v_vorgang.payload->>'customer', '')), '');
  if v_order_customer is not null then
    v_customer_name := nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'name', '')), '');
    select nullif(trim(coalesce(c.payload->>'name', '')), '') into v_master_customer
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id
      and c.customer_id = nullif(trim(coalesce(v_vorgang.payload->>'customerId', '')), '')
      and c.deleted = false;
    if v_customer_name is null
       or (v_customer_name is distinct from v_order_customer
           and (v_master_customer is null or v_customer_name is distinct from v_master_customer)) then
      raise exception 'invoice_customer_mismatch' using errcode = 'P0001';
    end if;
  end if;

  /* Pauschaler Abschlag: keine Menge, nur ein gueltiger Betrag. */
  if v_type = 'abschlag' and v_mode = 'fixed_amount' then
    if jsonb_array_length(coalesce(p_invoice->'positions', '[]'::jsonb)) <> 0 then
      raise exception 'invoice_fixed_amount_with_positions' using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_invoice->'fixedAmountNet') <> 'number' then
      raise exception 'invoice_fixed_amount_invalid' using errcode = 'P0001';
    end if;
    v_fixed_net := (p_invoice->>'fixedAmountNet')::numeric;
    if v_fixed_net is null or v_fixed_net <= 0 or v_fixed_net = 'NaN'::numeric then
      raise exception 'invoice_fixed_amount_invalid' using errcode = 'P0001';
    end if;
    v_subtotal_cents := round(v_fixed_net * 100);
  else
    /* Jede Rechnungszeile gegen den autoritativen Auftragsplan. */
    for v_line in select value from jsonb_array_elements(coalesce(p_invoice->'positions', '[]'::jsonb)) loop
      v_position_id := nullif(trim(coalesce(v_line->>'orderPositionId', '')), '');
      if v_position_id is null then
        raise exception 'invoice_position_not_found' using errcode = 'P0001';
      end if;

      select pos.value into v_order_position
      from jsonb_array_elements(coalesce(v_vorgang.payload->'orderPositions', '[]'::jsonb)) pos
      where pos.value->>'id' = v_position_id
      limit 1;
      if v_order_position is null then
        raise exception 'invoice_position_not_found' using errcode = 'P0001';
      end if;

      if jsonb_typeof(v_line->'quantity') <> 'number' then
        raise exception 'invoice_quantity_invalid' using errcode = 'P0001';
      end if;
      v_quantity := (v_line->>'quantity')::numeric;
      if v_quantity is null or v_quantity < 0 or v_quantity = 'NaN'::numeric then
        raise exception 'invoice_quantity_invalid' using errcode = 'P0001';
      end if;

      /* Abrechenbarkeit wie `isPositionBillable` im Client. */
      v_billable := case
        when coalesce(v_order_position->>'category', '') <> 'material' then true
        when v_material_source = 'auftraggeber' then false
        when v_material_source = 'betrieb' then true
        when v_material_source = 'gemischt' then coalesce((v_order_position->>'billable')::boolean, true)
        else coalesce((v_order_position->>'billable')::boolean, true)
      end;
      if not v_billable and v_quantity > 0 then
        raise exception 'invoice_position_not_billable' using errcode = 'P0001';
      end if;

      /* Einheit und Einzelpreis sind kaufmaennische Wahrheit des Auftrags. */
      if (v_line->>'unit') is distinct from (v_order_position->>'unit') then
        raise exception 'invoice_position_mismatch' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_line->'unitPrice') <> 'number' then
        raise exception 'invoice_position_mismatch' using errcode = 'P0001';
      end if;
      v_unit_price := (v_line->>'unitPrice')::numeric;
      if round(v_unit_price * 100) is distinct from round((v_order_position->>'unitPrice')::numeric * 100) then
        raise exception 'invoice_position_mismatch' using errcode = 'P0001';
      end if;

      /*
       * Grenze wie im Client (`getOverbillingReference`): Ist ein Aufmass
       * erfasst, gilt der dokumentierte Ist-Rest, sonst der offene Planrest.
       */
      v_billed := public.workspace_invoice_billed_quantity(p_workspace_id, p_vorgang_id, v_position_id, p_client_invoice_id);
      v_planned := coalesce((v_order_position->>'plannedQuantity')::numeric, 0);
      if jsonb_typeof(v_order_position->'executedQuantity') = 'number' then
        v_executed := (v_order_position->>'executedQuantity')::numeric;
        v_reference := greatest(0, v_executed - v_billed);
      else
        v_reference := greatest(0, v_planned - v_billed);
      end if;

      if v_quantity > v_reference and not coalesce(p_overbilling_acknowledged, false) then
        raise exception 'invoice_quantity_exceeds_available: % (%, offen %)', v_position_id, v_quantity, v_reference using errcode = 'P0001';
      end if;

      v_subtotal_cents := v_subtotal_cents + round(v_quantity * v_unit_price * 100);
    end loop;
  end if;

  /*
   * Summen: dieselbe Reihenfolge wie `calculateInvoiceTotals` -- je Zeile auf
   * Cent runden, summieren, Steuer einmal runden, Abschlaege abziehen; nur die
   * Schlussrechnung klemmt bei 0.
   */
  v_tax_cents := case when v_rate > 0 then round(v_subtotal_cents * v_rate / 100) else 0 end;
  v_gross_cents := v_subtotal_cents + v_tax_cents;

  if v_type = 'schluss' then
    v_deduction_cents := round(public.workspace_invoice_abschlag_deductions(p_workspace_id, p_vorgang_id, p_client_invoice_id) * 100);
    select coalesce(sum(round((d.value->>'amount')::numeric * 100)), 0)
    into v_client_deduction_cents
    from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb)) d
    where jsonb_typeof(d.value->'amount') = 'number';
    if v_client_deduction_cents is distinct from v_deduction_cents then
      raise exception 'invoice_deductions_mismatch' using errcode = 'P0001';
    end if;
    v_amount_cents := greatest(0, v_gross_cents - v_deduction_cents);
  else
    v_amount_cents := v_gross_cents;
  end if;

  if jsonb_typeof(p_invoice->'subtotal') <> 'number' or jsonb_typeof(p_invoice->'amount') <> 'number' then
    raise exception 'invoice_totals_mismatch' using errcode = 'P0001';
  end if;
  v_client_subtotal_cents := round((p_invoice->>'subtotal')::numeric * 100);
  v_client_amount_cents := round((p_invoice->>'amount')::numeric * 100);
  if v_client_subtotal_cents is distinct from v_subtotal_cents
     or v_client_amount_cents is distinct from v_amount_cents then
    raise exception 'invoice_totals_mismatch: netto % / % , brutto % / %',
      v_client_subtotal_cents, v_subtotal_cents, v_client_amount_cents, v_amount_cents using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.workspace_invoice_billed_quantity(uuid, text, text, text) from public, anon;
revoke all on function public.workspace_invoice_abschlag_deductions(uuid, text, text) from public, anon;
revoke all on function public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean) from public, anon;

-- Der bisherige Vierparameter-Finalisierer weicht der geprueften Fassung.
-- Ein Overload waere gefaehrlich: Ein Aufruf mit vier Argumenten wuerde
-- weiterhin die ungeprueften Fassung treffen.
drop function if exists public.finalize_workspace_invoice(uuid, text, text, jsonb);

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

revoke all on function public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean) from public, anon;
grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean) to authenticated;
