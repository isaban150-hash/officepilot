-- AUFTRAG-02C -- ein Auftrag entsteht auch ohne Angebot.
--
-- Der manuelle Auftrag ist dieselbe Entitaet wie der Auftrag aus einem
-- Angebot: ein Vorgang in `workspace_vorgaenge` mit serverseitig vergebener
-- Nummer `AU-JJJJ-NNNN` aus derselben Jahressequenz, eingefrorenem
-- `contractConfirmation` und Status `beauftragt`. Der einzige Unterschied ist
-- die Herkunft: `source_offer_id` bleibt NULL.
--
-- Daraus folgt die zweite, wichtigere Aenderung dieser Migration: Der
-- Freeze-Guard im generischen Upsert unterschied bisher nach
-- `source_offer_id`. Das war die Herkunftsfrage, nicht die fachliche. Ab hier
-- entscheidet `order_number`:
--
--   order_number is null      -> kein eigener bestaetigter Auftrag
--                                (Werkvertrag, Dokumentvorgang, Altbestand);
--                                Verhalten unveraendert.
--   order_number is not null  -> bestaetigter Auftrag, gleich ob aus Angebot
--                                oder manuell; der kaufmaennische
--                                Ausgangsstand ist festgeschrieben und nur
--                                ueber den Nachtragsweg erweiterbar.
--
-- Ohne diese Umstellung waere ein manueller Auftrag doppelt falsch: sein
-- Snapshot waere ueber den normalen Sync aenderbar, und der Zweig fuer
-- "kein Auftrag" wuerde jeden spaeteren Push mit `orderNumber` abweisen.
--
-- `sourceOfferId`/`sourceOfferNumber` bleiben ausschliesslich der RPC
-- `accept_workspace_offer` vorbehalten; `create_workspace_order` setzt sie nie.

-- Steuersatz wie im Client (`getTaxRateForStatus`): nur 19 und 7 erzeugen
-- Umsatzsteuer, alles andere rechnet mit 0.
create or replace function public.workspace_tax_rate_for_status(p_status text)
returns numeric
language sql
immutable
as $$
  select case p_status
    when 'standard_19' then 19
    when 'standard_7' then 7
    when 'kleinunternehmer_19' then 0
    when 'reverse_charge_13b' then 0
    when 'tax_free' then 0
    when 'unclear' then 0
    else null
  end::numeric;
$$;

/*
 * Summen exakt wie `calculateLineItemTotals` im Client: je Position einmal auf
 * Cent runden, dann summieren, dann die Steuer einmal auf Cent runden. Der
 * Server uebernimmt keine vom Client gerechneten Summen.
 */
create or replace function public.build_workspace_order_totals(p_positions jsonb, p_tax_status text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_rate numeric;
  v_subtotal_cents numeric := 0;
  v_tax_cents numeric;
begin
  v_rate := public.workspace_tax_rate_for_status(p_tax_status);
  if v_rate is null then
    raise exception 'Auftrag: unbekannter Steuerstatus %', p_tax_status using errcode = 'P0001';
  end if;
  select coalesce(sum(round((p->>'plannedQuantity')::numeric * (p->>'unitPrice')::numeric * 100)), 0)
  into v_subtotal_cents
  from jsonb_array_elements(p_positions) p
  where (p->>'plannedQuantity')::numeric > 0;

  v_tax_cents := case when v_rate > 0 then round(v_subtotal_cents * v_rate / 100) else 0 end;

  return jsonb_build_object(
    'subtotal', v_subtotal_cents / 100,
    'taxRate', v_rate,
    'tax', v_tax_cents / 100,
    'total', (v_subtotal_cents + v_tax_cents) / 100
  );
end;
$$;

create or replace function public.create_workspace_order(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_order jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vorgang public.workspace_vorgaenge;
  v_existing public.workspace_vorgaenge;
  v_year integer;
  v_seq integer;
  v_number text;
  v_now timestamptz := now();
  v_now_iso text;
  v_today text;
  v_customer_id text;
  v_customer_name text;
  v_title text;
  v_baustelle text;
  v_tax_status text;
  v_positions jsonb := '[]'::jsonb;
  v_pos jsonb;
  v_norm jsonb;
  v_ids text[] := '{}';
  v_id text;
  v_qty numeric;
  v_price numeric;
  v_unit text;
  v_allowed_units text[] := array['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
  v_totals jsonb;
  v_conf jsonb;
  v_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  -- Ein Auftrag ist ein Vorgang: dieselbe Rolle wie fuer jeden Vorgangs-Write.
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if p_vorgang_id is null or length(trim(p_vorgang_id)) = 0 then
    raise exception 'vorgang_id fehlt' using errcode = 'P0001';
  end if;
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'Auftragsdaten fehlen' using errcode = 'P0001';
  end if;

  /*
   * Wiederholung: Dieselbe Entwurfskennung darf nie einen zweiten Auftrag
   * erzeugen -- aber auch nie einen fremden Vorgang als "meinen Auftrag"
   * ausgeben. Replay gilt nur fuer eine Zeile, die selbst ein manueller,
   * bestaetigter Auftrag ist.
   */
  select * into v_existing
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id and v.vorgang_id = p_vorgang_id
  for update;
  if found then
    if v_existing.deleted
       or v_existing.order_number is null
       or v_existing.source_offer_id is not null
       or v_existing.payload->'contractConfirmation' is null then
      raise exception 'Vorgangskennung bereits vergeben' using errcode = 'P0001';
    end if;
    return jsonb_build_object('vorgang', to_jsonb(v_existing), 'replayed', true);
  end if;

  v_now_iso := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_today := to_char(v_now at time zone 'utc', 'YYYY-MM-DD');

  v_customer_id := nullif(trim(coalesce(p_order->>'customerId', '')), '');
  v_customer_name := nullif(trim(coalesce(p_order->'customerBilling'->>'name', '')), '');
  v_title := nullif(trim(coalesce(p_order->>'title', '')), '');
  v_baustelle := coalesce(p_order->>'baustelle', '');
  v_tax_status := nullif(trim(coalesce(p_order->>'taxStatus', '')), '');

  if v_customer_name is null then
    raise exception 'Auftrag ohne Kunden kann nicht angelegt werden' using errcode = 'P0001';
  end if;
  if v_title is null then
    raise exception 'Auftrag ohne Bezeichnung kann nicht angelegt werden' using errcode = 'P0001';
  end if;
  if v_tax_status is null or public.workspace_tax_rate_for_status(v_tax_status) is null then
    raise exception 'Auftrag: unbekannter Steuerstatus %', coalesce(v_tax_status, '') using errcode = 'P0001';
  end if;
  -- Der Kunde muss ein Kunde dieses Arbeitsbereichs sein; eine fremde Kennung
  -- wuerde die Kundenakte still falsch verknuepfen.
  if v_customer_id is not null then
    if not exists (
      select 1 from public.workspace_customers c
      where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and c.deleted = false
    ) then
      raise exception 'Kunde gehoert nicht zu diesem Arbeitsbereich' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_typeof(coalesce(p_order->'positions', 'null'::jsonb)) <> 'array'
     or jsonb_array_length(p_order->'positions') < 1 then
    raise exception 'Auftrag ohne Positionen kann nicht angelegt werden' using errcode = 'P0001';
  end if;

  for v_pos in select value from jsonb_array_elements(p_order->'positions') loop
    if jsonb_typeof(v_pos) <> 'object' then
      raise exception 'Auftragsposition ist ungueltig' using errcode = 'P0001';
    end if;
    v_id := nullif(trim(coalesce(v_pos->>'id', '')), '');
    v_unit := nullif(trim(coalesce(v_pos->>'unit', '')), '');
    if v_id is null or nullif(trim(coalesce(v_pos->>'description', '')), '') is null or v_unit is null then
      raise exception 'Auftragsposition ist unvollstaendig' using errcode = 'P0001';
    end if;
    if v_id = any (v_ids) then
      raise exception 'Doppelte Positionskennung %', v_id using errcode = 'P0001';
    end if;
    v_ids := array_append(v_ids, v_id);
    if not (v_unit = any (v_allowed_units)) then
      raise exception 'Unbekannte Einheit %', v_unit using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_pos->>'plannedQuantity')::numeric;
      v_price := (v_pos->>'unitPrice')::numeric;
    exception when others then
      raise exception 'Auftragsposition hat ungueltige Zahlen' using errcode = 'P0001';
    end;
    if v_qty is null or v_qty <= 0 or v_qty = 'NaN'::numeric or v_price is null or v_price < 0 or v_price = 'NaN'::numeric then
      raise exception 'Auftragsposition hat ungueltige Mengen oder Preise' using errcode = 'P0001';
    end if;
    v_norm := jsonb_strip_nulls(jsonb_build_object(
      'id', v_id,
      'description', trim(v_pos->>'description'),
      'plannedQuantity', v_qty,
      'unit', v_unit,
      'unitLabel', v_pos->'unitLabel',
      'unitPrice', v_price,
      'category', v_pos->'category',
      'billable', true
    ));
    v_positions := v_positions || jsonb_build_array(v_norm);
  end loop;

  v_totals := public.build_workspace_order_totals(v_positions, v_tax_status);

  -- Auftragsnummer aus derselben Jahressequenz wie Auftraege aus Angeboten.
  v_year := extract(year from v_now)::integer;
  insert into public.workspace_order_sequences (workspace_id, order_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, order_year) do nothing;

  select s.last_sequence + 1 into v_seq
  from public.workspace_order_sequences s
  where s.workspace_id = p_workspace_id and s.order_year = v_year
  for update;

  update public.workspace_order_sequences
  set last_sequence = v_seq
  where workspace_id = p_workspace_id and order_year = v_year;

  v_number := public.format_workspace_order_number(v_year, v_seq);

  -- Derselbe eingefrorene Stand wie beim Auftrag aus Angebot.
  v_conf := jsonb_build_object(
    'id', 'conf-' || p_vorgang_id,
    'confirmedAt', v_now_iso,
    'customer', v_customer_name,
    'auftraggeber', v_customer_name,
    'baustelle', v_baustelle,
    'title', v_title,
    'positions', v_positions,
    'negotiation', jsonb_build_object(
      'conducted', false,
      'notes', '[]'::jsonb,
      'generalHints', '[]'::jsonb,
      'priceProposals', '[]'::jsonb,
      'positionProposals', '[]'::jsonb,
      'drafts', '[]'::jsonb
    ),
    'immutable', true
  );

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'id', p_vorgang_id,
    'title', v_title,
    'customer', v_customer_name,
    'baustelle', v_baustelle,
    'status', 'beauftragt',
    'materialSource', 'unclear',
    'customerBilling', p_order->'customerBilling',
    'customerId', to_jsonb(v_customer_id),
    'orderPositions', v_positions,
    'contractConfirmation', v_conf,
    'orderNumber', v_number,
    'orderDate', v_today,
    'taxStatus', v_tax_status,
    'paymentTermsText', p_order->'paymentTermsText',
    'introText', p_order->'introText',
    'closingText', p_order->'closingText',
    'contractTotals', v_totals
  ));

  insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload, row_version, deleted, updated_by, source_offer_id, order_number)
  values (p_workspace_id, p_vorgang_id, v_payload, 1, false, auth.uid(), null, v_number)
  returning * into v_vorgang;

  return jsonb_build_object('vorgang', to_jsonb(v_vorgang), 'replayed', false);
end;
$$;

revoke all on function public.create_workspace_order(uuid, text, jsonb) from public, anon;
grant execute on function public.create_workspace_order(uuid, text, jsonb) to authenticated;

-- Positions-Guard unveraendert aus 02B; er gilt jetzt fuer jeden Auftrag mit Nummer.
create or replace function public.assert_workspace_order_positions_frozen(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_snapshot jsonb,
  p_positions jsonb
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_snap jsonb;
  v_pos jsonb;
  v_amend_pos jsonb;
  v_amend_seq integer;
  v_id text;
  v_snap_ids text[] := '{}';
  v_seen text[] := '{}';
  n integer;
begin
  if p_positions is null or jsonb_typeof(p_positions) <> 'array' then
    raise exception 'Auftrag: orderPositions fehlen' using errcode = 'P0001';
  end if;

  -- 1) Hauptsnapshot: jede Position genau einmal und kaufmaennisch unveraendert.
  for v_snap in select value from jsonb_array_elements(coalesce(p_snapshot->'positions', '[]'::jsonb)) loop
    v_id := v_snap->>'id';
    v_snap_ids := array_append(v_snap_ids, v_id);
    select count(*) into n from jsonb_array_elements(p_positions) p where p->>'id' = v_id;
    if n <> 1 then
      raise exception 'Auftrag: Position % ist festgeschrieben', v_id using errcode = 'P0001';
    end if;
    select p into v_pos from jsonb_array_elements(p_positions) p where p->>'id' = v_id;
    if not (
      (v_pos->>'description') is not distinct from (v_snap->>'description')
      and (v_pos->>'plannedQuantity')::numeric = (v_snap->>'plannedQuantity')::numeric
      and (v_pos->>'unit') is not distinct from (v_snap->>'unit')
      and (v_pos->>'unitLabel') is not distinct from (v_snap->>'unitLabel')
      and (v_pos->>'unitPrice')::numeric = (v_snap->>'unitPrice')::numeric
      and (v_pos->>'category') is not distinct from (v_snap->>'category')
      and (v_pos->>'billable') is not distinct from (v_snap->>'billable')
    ) then
      raise exception 'Auftrag: Position % ist festgeschrieben', v_id using errcode = 'P0001';
    end if;
  end loop;

  -- 2) Alle weiteren Positionen: nur aus bestaetigten Nachtraegen, mit deren Werten.
  for v_pos in select value from jsonb_array_elements(p_positions) loop
    v_id := v_pos->>'id';
    if v_id is null or v_id = any (v_seen) then
      raise exception 'Auftrag: doppelte oder leere Positionskennung' using errcode = 'P0001';
    end if;
    v_seen := array_append(v_seen, v_id);
    if v_id = any (v_snap_ids) then
      continue;
    end if;
    select ap.value, a.sequence_no into v_amend_pos, v_amend_seq
    from public.workspace_order_amendments a
    cross join lateral jsonb_array_elements(coalesce(a.payload->'positions', '[]'::jsonb)) ap
    where a.workspace_id = p_workspace_id
      and a.vorgang_id = p_vorgang_id
      and a.client_amendment_id = v_pos->>'sourceAmendmentId'
      and ap.value->>'id' = v_id
    limit 1;
    if not found then
      raise exception 'Auftrag: Position % nur ueber bestaetigten Nachtrag', v_id using errcode = 'P0001';
    end if;
    if not (
      (v_pos->>'description') is not distinct from (v_amend_pos->>'description')
      and (v_pos->>'plannedQuantity')::numeric = (v_amend_pos->>'plannedQuantity')::numeric
      and (v_pos->>'unit') is not distinct from (v_amend_pos->>'unit')
      and (v_pos->>'unitLabel') is not distinct from (v_amend_pos->>'unitLabel')
      and (v_pos->>'unitPrice')::numeric = (v_amend_pos->>'unitPrice')::numeric
      and (v_pos->>'category') is not distinct from (v_amend_pos->>'category')
      and (v_pos->>'billable') is not distinct from (v_amend_pos->>'billable')
      and (v_pos->>'parentPositionId') is not distinct from (v_amend_pos->>'parentPositionId')
      and (v_pos->>'amendmentChangeType') is not distinct from (v_amend_pos->>'changeType')
      and (v_pos->>'sourceAmendmentSequence')::integer = v_amend_seq
    ) then
      raise exception 'Auftrag: Nachtragsposition % weicht vom bestaetigten Nachtrag ab', v_id using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

revoke all on function public.assert_workspace_order_positions_frozen(uuid, text, jsonb, jsonb) from public, anon;

-- Schreibfunktion: Freeze-Guard an `order_number` statt an `source_offer_id`.
create or replace function public.upsert_workspace_sync_entity(
  p_workspace_id uuid,
  p_entity_type text,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version bigint;
  v_result jsonb;
  v_vorgang_id text;
  v_customer_id text;
  -- BRIEFE-01B: nur fuer den business_letter-Zweig.
  v_letter_id text;
  v_letter_customer_id text;
  v_letter_vorgang_id text;
  v_letter_status text;
  v_letter_payload jsonb;
  v_row_letter public.workspace_business_letters;
  -- ANGEBOT->AUFTRAG-02B: nur fuer den vorgang-Zweig.
  v_incoming_vorgang jsonb;
  v_key text;
  v_offer_result_vid text;
  -- ANGEBOT-01B: nur fuer den offer-Zweig.
  v_offer_id text;
  v_offer_customer_id text;
  v_offer_status text;
  v_offer_payload jsonb;
  v_row_offer public.workspace_offers;
  v_offer_archive text;
  -- CLOUD-DURABILITY-01B: nur fuer den vorgang_note-Zweig.
  v_note_id text;
  v_note_vorgang_id text;
  v_note_payload jsonb;
  -- CLOUD-DURABILITY-01C: nur fuer den task-Zweig.
  v_task_id text;
  v_task_payload jsonb;
  v_task_status text;
  v_task_dedupe text;
  v_task_auto boolean;
  v_canonical public.workspace_tasks;
  -- SYNC-DURABILITY-HARDENING-01G: der gespeicherte Stand fuer den Version-0-Vertrag.
  v_row_vorgang public.workspace_vorgaenge;
  v_row_customer public.workspace_customers;
  v_row_note public.workspace_vorgang_notes;
  v_row_task public.workspace_tasks;
  v_incoming jsonb;
  -- CLOUD-DURABILITY-01D: nur fuer den dunning_documentation-Zweig.
  v_dun_id text;
  v_dun_invoice_id text;
  v_dun_vorgang_id text;
  v_dun_kind text;
  v_dun_documented_at date;
  v_dun_delivery text;
  v_dun_payload jsonb;
  v_dun_existing public.workspace_invoice_dunning_documentations;
  v_deleted boolean;
  -- BRANDING-01E-0 / FIRMENPROFIL-01B: nur fuer den company_profile-Zweig.
  v_existing_profile jsonb;
  v_incoming_profile jsonb;
  v_incoming_schema integer;
  v_field record;
begin
  /*
   * SYNC-DURABILITY-HARDENING-01G4 -- kein dritter Zustand.
   *
   * Alle folgenden Zweige vergleichen `p_row_version`. Waere der Wert `NULL`,
   * ergaebe jeder dieser Vergleiche `NULL` und damit nicht wahr -- die Zeile
   * wuerde ungeprueft ueberschrieben. Eine fehlende Angabe ist keine bestaetigte
   * Serverversion, also gilt sie hier als unbestaetigt.
   */
  p_row_version := coalesce(p_row_version, 0);

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if p_entity_type = 'vorgang' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_vorgang_id := coalesce(nullif(trim(p_payload->>'vorgang_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_vorgang_id is null then
      raise exception 'vorgang_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    select v.* into v_row_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id
    for update;
    v_current_version := v_row_vorgang.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — Version 0 bei vorhandener Zeile.
     *
     * `p_row_version = 0` heisst ausschliesslich: Dieser Client hat **keine**
     * bestaetigte Serverversion. Bisher umging dieser Wert die Versionspruefung
     * vollstaendig und durfte deshalb eine neuere Fassung oder einen Grabstein
     * ueberschreiben. Zulaessig ist er jetzt nur noch in zwei Faellen: Es gibt
     * keine Zeile (CREATE), oder der Inhalt ist identisch — dann ist es die
     * Wiederholung eines Schreibvorgangs, dessen Bestaetigung verloren ging, und
     * die Zeile wird unveraendert zurueckgegeben.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_vorgang.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_vorgang.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_vorgang.payload = v_incoming and v_row_vorgang.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', v_row_vorgang.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- ANGEBOT->AUFTRAG-02B: Auftragsherkunft und -nummer vergibt nur accept_workspace_offer.
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if (not v_deleted) and (v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber') then
        raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
      end if;

      insert into public.workspace_vorgaenge (
        workspace_id,
        vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_vorgang_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * ANGEBOT->AUFTRAG-02B / AUFTRAG-02C -- Serverwahrheit fuer Auftraege.
       *
       * Ohne Auftragsnummer: Der Payload darf weder Herkunft noch Nummer
       * tragen (die setzen nur accept_workspace_offer und
       * create_workspace_order). Mit Auftragsnummer -- aus Angebot oder
       * manuell -- gilt fuer beide dasselbe Regelwerk: Die
       * kaufmaennischen Snapshot-Felder sind write-once, und Herkunft, Nummer,
       * Datum werden aus den Spalten bzw. dem gespeicherten Payload erzwungen --
       * ein abweichender Client-Wert erreicht die Zeile nie.
       */
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, v_row_vorgang.payload);
      if not v_deleted then
        -- AUFTRAG-02C: Die Frage ist "bestaetigter eigener Auftrag?", nicht "aus Angebot?".
        if v_row_vorgang.order_number is null then
          if v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber' then
            raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
          end if;
        else
          foreach v_key in array array['contractConfirmation', 'taxStatus', 'paymentTermsText', 'introText', 'closingText', 'contractTotals', 'customerId', 'customerBilling'] loop
            if v_row_vorgang.payload ? v_key and (v_row_vorgang.payload -> v_key) is distinct from (v_incoming_vorgang -> v_key) then
              raise exception 'Auftrag: % ist festgeschrieben', v_key using errcode = 'P0001';
            end if;
          end loop;
          -- Operativer Plan: nur Hauptsnapshot + bestaetigte Nachtraege (executedQuantity bleibt frei).
          perform public.assert_workspace_order_positions_frozen(
            p_workspace_id, v_vorgang_id, v_row_vorgang.payload->'contractConfirmation', v_incoming_vorgang->'orderPositions');
          if (v_incoming_vorgang ? 'sourceOfferId' and v_incoming_vorgang->>'sourceOfferId' is distinct from v_row_vorgang.source_offer_id)
             or (v_incoming_vorgang ? 'orderNumber' and v_incoming_vorgang->>'orderNumber' is distinct from v_row_vorgang.order_number) then
            raise exception 'Auftragsherkunft und Auftragsnummer koennen nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_strip_nulls(jsonb_build_object(
            'sourceOfferId', v_row_vorgang.source_offer_id,
            'orderNumber', v_row_vorgang.order_number,
            'sourceOfferNumber', v_row_vorgang.payload->'sourceOfferNumber',
            'orderDate', v_row_vorgang.payload->'orderDate'
          ));
        end if;
      end if;

      update public.workspace_vorgaenge
      set
        payload = case when v_deleted then payload else v_incoming_vorgang end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and vorgang_id = v_vorgang_id
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_vorgang_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'customer' then
    /*
     * PRODUCT-FOUNDATION-03A-S1 -- strukturgleich zum Vorgangs-Zweig.
     *
     * Der Server prueft Berechtigung und Sync-Struktur, NICHT die
     * Customer-Fachlogik. Eigenfirmen-Guard, Namensvergleich und
     * Dublettenerkennung bleiben ausschliesslich im Client: der Guard braucht
     * das lokale Firmenprofil, das serverseitig gar nicht auswertbar ist.
     *
     * `deleted`/`deleted_at` werden bereits nach dem Vorgangs-Protokoll
     * behandelt, obwohl es noch keine Loeschfunktion gibt. Kein Client erzeugt
     * in diesem Stand `deleted = true`; die Semantik steht aber bereit, ohne
     * dass spaeter eine zweite Migration dieselbe RPC erneut anfassen muss.
     */
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_customer_id := coalesce(nullif(trim(p_payload->>'customer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_customer_id is null then
      raise exception 'customer_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    select c.* into v_row_customer
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
    for update;
    v_current_version := v_row_customer.row_version;

    -- 01G — siehe Vorgangs-Zweig: Version 0 ueberschreibt keine vorhandene Zeile.
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_customer.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_customer.deleted and not v_deleted then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_customer.payload = v_incoming and v_row_customer.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', v_row_customer.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_customers (
        workspace_id,
        customer_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_customer_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_customers.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_customers
      set
        payload = case when v_deleted then payload else coalesce(p_payload->'payload', p_payload, payload) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and customer_id = v_customer_id
      returning to_jsonb(public.workspace_customers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_customer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'business_letter' then
    /*
     * BRIEFE-01B — ausgehendes Geschaeftsschreiben.
     *
     * Schreibrecht wie bei Notizen und Aufgaben: Ein Brief ist normale
     * Bueroarbeit, keine Eigentuemerhandlung. Der Versionsvertrag ist
     * unveraendert der aus 01G -- einschliesslich der Regel, dass eine
     * unbestaetigte Version (<= 0) nur anlegen oder eine inhaltsgleiche
     * Wiederholung sein darf.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_letter_id := coalesce(nullif(trim(p_payload->>'letter_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_letter_id is null then
      raise exception 'letter_id fehlt';
    end if;

    v_letter_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_letter_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_letter_payload->>'customerId')), '');
    v_letter_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_letter_payload->>'vorgangId')), '');
    v_letter_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_letter_payload->>'status'), ''), 'draft');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_letter_status not in ('draft', 'finalized') then
      raise exception 'Brief ungueltig: status' using errcode = 'P0001';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_letter_payload->'subject') <> 'string' or length(trim(v_letter_payload->>'subject')) = 0 then
        raise exception 'Brief ungueltig: subject' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'subject') > 300 then
        raise exception 'Brief ungueltig: subject zu lang' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_letter_payload->'body') <> 'string' or length(trim(v_letter_payload->>'body')) = 0 then
        raise exception 'Brief ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'body') > 50000 then
        raise exception 'Brief ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select l.* into v_row_letter
    from public.workspace_business_letters l
    where l.workspace_id = p_workspace_id and l.client_letter_id = v_letter_id
    for update;
    v_current_version := v_row_letter.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — unbestaetigte Version bei vorhandener
     * Zeile. Wortgleich zu den uebrigen Zweigen: Anlegen ist erlaubt, eine
     * inhaltsgleiche Wiederholung wird unveraendert zurueckgegeben, alles
     * andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_letter.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_letter.deleted) and v_row_letter.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_business_letters (
        workspace_id,
        client_letter_id,
        client_customer_id,
        client_vorgang_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_letter_id,
        v_letter_customer_id,
        v_letter_vorgang_id,
        v_letter_status,
        case when v_deleted then '{}'::jsonb else v_letter_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * BRIEFE-01B -- ein fertiggestellter Brief ist ein Beleg.
       *
       * Die Unveraenderlichkeit darf nicht am Client haengen: Wer den Aufruf
       * nachbaut, koennte sonst Betreff, Text, Datum, Empfaenger oder den
       * eingefrorenen Absender-Schnappschuss nachtraeglich umschreiben -- und
       * das Dokument hiesse morgen etwas anderes als das, was der Empfaenger
       * bekommen hat. Deshalb steht der Guard hier, nicht nur im Fachdienst.
       *
       * Erlaubt bleiben ausdruecklich:
       *   * der Uebergang draft -> finalized (die Zeile ist dann noch draft),
       *   * die wortgleiche Wiederholung eines Schreibvorgangs, dessen
       *     Bestaetigung verloren ging -- sie aendert nichts,
       *   * der Grabstein: Loeschen ist kein Umschreiben, und der Loeschweg
       *     muss dem uebrigen Sync-Vertrag folgen.
       *
       * `documentId` bleibt vom Vergleich ausgenommen: Es benennt die spaeter
       * erzeugte Archivdatei, gehoert aber nicht zum fachlichen Inhalt des
       * Schreibens.
       */
      if v_row_letter.status = 'finalized' and not v_row_letter.deleted and not v_deleted then
        if v_letter_status <> 'finalized' then
          raise exception 'Brief ist fertiggestellt und kann nicht zurueckgesetzt werden'
            using errcode = 'P0001';
        end if;
        if (v_row_letter.payload - 'documentId') is distinct from (v_letter_payload - 'documentId') then
          raise exception 'Brief ist fertiggestellt und kann nicht mehr geaendert werden'
            using errcode = 'P0001';
        end if;
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso die Bezuege zu Kunde
       * und Auftrag -- sie sind die Ordnung, ueber die ein zweites Geraet den
       * Grabstein zuordnet.
       */
      update public.workspace_business_letters
      set
        payload = case when v_deleted then payload else coalesce(v_letter_payload, payload) end,
        client_customer_id = coalesce(v_letter_customer_id, client_customer_id),
        client_vorgang_id = coalesce(v_letter_vorgang_id, client_vorgang_id),
        status = case when v_deleted then status else v_letter_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_letter_id = v_letter_id
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_letter_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'offer' then
    /*
     * ANGEBOT-01B -- eigenes Angebot.
     *
     * Schreibrecht wie bei Briefen: normale Bueroarbeit, `workspace_user_can_intake`.
     * Versionsvertrag unveraendert aus 01G. Zusaetzlich:
     *   * Die Freigabe (Entwurf -> Nummer) laeuft NICHT hier, sondern nur ueber
     *     `finalize_workspace_offer`. Ein Client, der einen Entwurf mit einem
     *     anderen Status oder einer Nummer schreibt, wird abgewiesen.
     *   * Ein freigegebenes Angebot ist ein Beleg: Der eingefrorene Inhalt darf
     *     sich nicht aendern. Erlaubt sind nur die Zustandsfelder (status,
     *     sentAt, decidedAt, archiveDocumentId, resultingVorgangId, updatedAt)
     *     -- und nur entlang der erlaubten Uebergaenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_offer_id := coalesce(nullif(trim(p_payload->>'offer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_offer_id is null then
      raise exception 'offer_id fehlt';
    end if;

    v_offer_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_offer_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_offer_payload->>'customerId')), '');
    v_offer_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_offer_payload->>'status'), ''), 'entwurf');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_offer_status not in ('entwurf', 'freigegeben', 'versendet', 'angenommen', 'abgelehnt', 'storniert', 'ersetzt') then
      raise exception 'Angebot ungueltig: status' using errcode = 'P0001';
    end if;

    select o.* into v_row_offer
    from public.workspace_offers o
    where o.workspace_id = p_workspace_id and o.client_offer_id = v_offer_id
    for update;
    v_current_version := v_row_offer.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_offer.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) and v_row_offer.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- Neu anlegen darf nur ein Entwurf ohne Nummer: Nummern vergibt die Freigabe.
      if (not v_deleted) and (v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber') then
        raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
      end if;

      insert into public.workspace_offers (
        workspace_id,
        client_offer_id,
        client_customer_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_offer_id,
        v_offer_customer_id,
        case when v_deleted then 'entwurf' else v_offer_status end,
        case when v_deleted then '{}'::jsonb else v_offer_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_offers.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) then
        if v_row_offer.status = 'entwurf' then
          -- Ein Entwurf bleibt Entwurf: Freigabe und Nummer nur ueber die RPC.
          if v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber' then
            raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
          end if;
        else
          -- Beleg: nur Zustandsfelder duerfen sich aendern, und nur vorwaerts.
          if (v_row_offer.payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt')
             is distinct from
             (v_offer_payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt') then
            raise exception 'Angebot ist freigegeben und kann nicht mehr geaendert werden' using errcode = 'P0001';
          end if;
          if v_offer_status <> v_row_offer.status then
            -- ANGEBOT->AUFTRAG-02B: Annahme nur atomar mit dem Auftrag.
            if v_offer_status = 'angenommen' then
              raise exception 'Annahme nur ueber accept_workspace_offer' using errcode = 'P0001';
            end if;
            if not (
              (v_row_offer.status = 'freigegeben' and v_offer_status in ('versendet', 'abgelehnt', 'storniert', 'ersetzt'))
              or (v_row_offer.status = 'versendet' and v_offer_status in ('abgelehnt', 'storniert', 'ersetzt'))
            ) then
              raise exception 'Statuswechsel % -> % ist nicht erlaubt', v_row_offer.status, v_offer_status using errcode = 'P0001';
            end if;
          end if;
          -- ANGEBOT->AUFTRAG-02B: resultingVorgangId ist Serverwahrheit (write-once, nur ueber die RPC).
          v_offer_result_vid := nullif(trim(coalesce(v_offer_payload->>'resultingVorgangId', '')), '');
          if v_offer_result_vid is distinct from nullif(trim(coalesce(v_row_offer.payload->>'resultingVorgangId', '')), '') then
            raise exception 'Auftragsbezug eines Angebots nur ueber accept_workspace_offer' using errcode = 'P0001';
          end if;
          -- Die Serverwahrheit ueber Nummer und Fingerabdruck bleibt, was sie ist.
          v_offer_payload := v_offer_payload || jsonb_build_object(
            'offerNumber', v_row_offer.offer_number,
            'offerSequenceNumber', v_row_offer.offer_sequence_number,
            'contentFingerprint', v_row_offer.content_fingerprint
          );
        end if;
      end if;

      /*
       * ANGEBOT-01B (Pre-Acceptance) -- Archiv-Invariante, serverseitig.
       * Die Ablage ist write-once und darf nur auf ein Dokument desselben
       * Workspaces zeigen, das als eigenes Angebot (classifiedKind = angebot)
       * genau dieses Angebot referenziert (linkedOfferId). Ein Entwurf hat
       * keine Ablage; ein Fremddokument oder das Dokument eines anderen
       * Angebots wird abgewiesen.
       */
      if not v_deleted then
        v_offer_archive := nullif(trim(coalesce(v_offer_payload->>'archiveDocumentId', '')), '');
        if v_offer_archive is distinct from nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') then
          if v_row_offer.status = 'entwurf' then
            raise exception 'Ein Entwurf hat keine Archivablage' using errcode = 'P0001';
          end if;
          if nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') is not null then
            raise exception 'Archivdokument eines Angebots kann nicht gewechselt werden' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and not exists (
            select 1 from public.workspace_documents d
            where d.workspace_id = p_workspace_id
              and d.client_document_id = v_offer_archive
              and d.deleted = false
              and d.payload->>'classifiedKind' = 'angebot'
              and d.payload->>'linkedOfferId' = v_offer_id
          ) then
            raise exception 'Archivdokument gehoert nicht zu diesem Angebot' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and exists (
            select 1 from public.workspace_offers o2
            where o2.workspace_id = p_workspace_id
              and o2.client_offer_id <> v_offer_id
              and o2.payload->>'archiveDocumentId' = v_offer_archive
          ) then
            raise exception 'Archivdokument ist bereits einem anderen Angebot zugeordnet' using errcode = 'P0001';
          end if;
        end if;
      end if;

      -- Loeschen: nur Entwuerfe. Ein Beleg wird storniert, nicht entfernt.
      if v_deleted and v_row_offer.status <> 'entwurf' then
        raise exception 'Ein freigegebenes Angebot kann nicht geloescht werden' using errcode = 'P0001';
      end if;

      update public.workspace_offers
      set
        payload = case when v_deleted then payload else coalesce(v_offer_payload, payload) end,
        client_customer_id = coalesce(v_offer_customer_id, client_customer_id),
        status = case when v_deleted then status else v_offer_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_offer_id = v_offer_id
      returning to_jsonb(public.workspace_offers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_offer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'vorgang_note' then
    /*
     * CLOUD-DURABILITY-CORE-01B -- Vorgangsnotizen.
     *
     * Berechtigung bewusst NICHT `can_write_workspace` (Inhaber/Admin):
     * Die Notiz entsteht heute in `VorgangDetailPage` ueber `addVorgangNote`
     * ohne jede Rollenpruefung -- jedes aktive Mitglied darf sie lokal
     * schreiben. `can_write_workspace` wuerde genau diese Mitglieder beim
     * ersten Push aussperren und ihre Notizen dauerhaft in der Outbox
     * haengen lassen. Verwendet wird deshalb die vorhandene Funktion
     * `workspace_user_can_intake` -- dieselbe Berechtigung, die schon fuer
     * Eingang und Dokumente den Satz "aktives Mitglied" ausdrueckt.
     *
     * SELECT: jedes aktive Mitglied (`is_active_workspace_member`, Policy
     * unten) -- lokal sieht jedes Mitglied alle Notizen eines Vorgangs, die
     * Cloud darf daran nichts verengen.
     * INSERT/UPDATE/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese
     * Security-Definer-RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Notiz-ID, Vorgangsbezug und ein Textkoerper in vertretbarer Laenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_note_id := coalesce(nullif(trim(p_payload->>'note_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_note_id is null then
      raise exception 'note_id fehlt';
    end if;

    v_note_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_note_vorgang_id := coalesce(
      nullif(trim(p_payload->>'vorgang_id'), ''),
      nullif(trim(v_note_payload->>'vorgangId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Guard: der Vorgangsbezug ist die Ordnung dieser Tabelle und darf nur am
    -- Grabstein fehlen -- dort wird kein Fachinhalt mitgeschickt.
    if v_note_vorgang_id is null and not v_deleted then
      raise exception 'vorgang_id fehlt';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_note_payload->'body') <> 'string' or length(trim(v_note_payload->>'body')) = 0 then
        raise exception 'Notiz ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_note_payload->>'body') > 20000 then
        raise exception 'Notiz ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select n.* into v_row_note
    from public.workspace_vorgang_notes n
    where n.workspace_id = p_workspace_id and n.client_note_id = v_note_id
    for update;
    v_current_version := v_row_note.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Notiz.
     *
     * Der Grabsteinfall ist hier der wichtigste: Eine geloeschte Notiz durfte
     * bisher von einem unbestaetigten Schreibvorgang wiederbelebt werden. Jetzt
     * gilt auch fuer sie: identischer Inhalt = Wiederholung, alles andere =
     * Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_note.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * 01G2 -- derselbe Loeschvorgang, im Produkt beobachtet.
       *
       * Wird eine nie bestaetigte Notiz geloescht und geht die Antwort
       * verloren, schickt der Wiederanlauf den **vollen** Fachinhalt mit
       * `deleted = true`; die Serverzeile traegt aber `payload = {}`, weil ein
       * Grabstein beim Einfuegen keinen Inhalt speichert. Ein reiner
       * Inhaltsvergleich hielt das faelschlich fuer einen Konflikt -- der
       * Sendeauftrag blieb dauerhaft blockiert (im Browser reproduziert).
       *
       * Beide Seiten wollen dasselbe: geloescht. Das ist ein sicherer Replay.
       */
      if v_row_note.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_note.payload = v_note_payload and v_row_note.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', v_row_note.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_vorgang_notes (
        workspace_id,
        client_note_id,
        client_vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_note_id,
        v_note_vorgang_id,
        case when v_deleted then '{}'::jsonb else v_note_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: der Fachinhalt bleibt unveraendert stehen (wie im
       * Vorgangs-Zweig), der Vorgangsbezug ebenso -- er ist die einzige
       * Ordnung, ueber die ein zweites Geraet den Grabstein zuordnet.
       */
      update public.workspace_vorgang_notes
      set
        payload = case when v_deleted then payload else coalesce(v_note_payload, payload) end,
        client_vorgang_id = coalesce(v_note_vorgang_id, client_vorgang_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_note_id = v_note_id
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_note_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'task' then
    /*
     * CLOUD-DURABILITY-CORE-01C -- Aufgaben.
     *
     * Berechtigung wie bei den Vorgangsnotizen und aus demselben Grund:
     * Aufgaben entstehen heute ohne jede Rollenpruefung -- die Engine legt sie
     * beim blossen Oeffnen der Aufgabenseite an, und jedes aktive Mitglied darf
     * sie erledigen. `can_write_workspace` (Inhaber/Admin) wuerde genau diese
     * Mitglieder aussperren und ihre Aufgaben dauerhaft in der Outbox halten.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE/UPDATE/Statuswechsel/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_task_id := coalesce(nullif(trim(p_payload->>'task_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_task_id is null then
      raise exception 'task_id fehlt';
    end if;

    v_task_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    v_task_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_task_payload->>'status'), ''), 'open');
    v_task_dedupe := coalesce(p_payload->>'dedupe_key', '');
    v_task_auto := coalesce((p_payload->>'auto_created')::boolean, false);

    -- Guards: nur Sync-Struktur, keine Fachlogik.
    if v_task_status not in ('open', 'in_progress', 'done', 'archived') then
      raise exception 'Aufgabe ungueltig: status' using errcode = 'P0001';
    end if;
    if not v_deleted then
      if jsonb_typeof(v_task_payload->'title') <> 'string' or length(trim(v_task_payload->>'title')) = 0 then
        raise exception 'Aufgabe ungueltig: title' using errcode = 'P0001';
      end if;
      if length(v_task_payload->>'title') > 500 then
        raise exception 'Aufgabe ungueltig: title zu lang' using errcode = 'P0001';
      end if;
    end if;

    /*
     * Idempotenz fuer konkurrierende automatische Aufgaben.
     *
     * Zwei Geraete, die offline dieselbe automatische Aufgabe erzeugen, senden
     * zwei verschiedene `client_task_id` mit demselben `dedupe_key`. Der zweite
     * Push darf weder eine zweite Zeile anlegen noch an der Eindeutigkeit
     * sterben: Er ist fachlich ein Replay. Der Server gibt dann die bereits
     * vorhandene kanonische Zeile zurueck und markiert die Antwort mit
     * `deduped`; der Client uebernimmt sie und verwirft seine eigene Kennung.
     *
     * Die Pruefung gilt fuer jeden Write, der in einer aktiven automatischen
     * Aufgabe endet -- auch fuer ein Wiederoeffnen, das sonst am Index
     * scheitern wuerde. Manuelle Aufgaben (`auto_created = false`) und Aufgaben
     * ohne Dedupe-Identitaet (leerer Schluessel) sind ausgenommen.
     */
    if v_task_auto and v_task_dedupe <> '' and not v_deleted and v_task_status in ('open', 'in_progress') then
      select t.* into v_canonical
      from public.workspace_tasks t
      where t.workspace_id = p_workspace_id
        and t.dedupe_key = v_task_dedupe
        and t.auto_created
        and not t.deleted
        and t.status in ('open', 'in_progress')
        and t.client_task_id <> v_task_id
      order by t.created_at, t.client_task_id
      limit 1
      for update;

      if found then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_canonical.client_task_id,
          'requested_entity_id', v_task_id,
          'row_version', v_canonical.row_version,
          'payload', to_jsonb(v_canonical),
          'deleted', false,
          -- Zusatzfeld, rueckwaertskompatibel: aeltere Clients lesen es nicht.
          'deduped', true
        );
      end if;
    end if;

    select t.* into v_row_task
    from public.workspace_tasks t
    where t.workspace_id = p_workspace_id and t.client_task_id = v_task_id
    for update;
    v_current_version := v_row_task.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Aufgabe. Der Dedupe-Zweig oben ist
     * davon unberuehrt: Er beantwortet den fachlichen Wiederholungsfall zweier
     * Geraete und kommt vor dieser Pruefung.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_task.deleted and not v_deleted then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;
      -- 01G2 -- derselbe Loeschvorgang, siehe Notiz-Zweig.
      if v_row_task.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_task.payload = v_task_payload
         and v_row_task.deleted = v_deleted
         and v_row_task.status = v_task_status then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', v_row_task.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_tasks (
        workspace_id,
        client_task_id,
        status,
        dedupe_key,
        auto_created,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_task_id,
        v_task_status,
        v_task_dedupe,
        v_task_auto,
        case when v_deleted then '{}'::jsonb else v_task_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_tasks
      set
        payload = case when v_deleted then payload else coalesce(v_task_payload, payload) end,
        status = v_task_status,
        dedupe_key = v_task_dedupe,
        auto_created = v_task_auto,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_task_id = v_task_id
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_task_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'dunning_documentation' then
    /*
     * CLOUD-DURABILITY-CORE-01D -- Nachweis einer uebergebenen
     * Zahlungserinnerung oder Mahnung.
     *
     * Berechtigung wie bei Notizen und Aufgaben und aus demselben Grund: Das
     * Produkt kennt fuer das Dokumentieren keinerlei Rollenpruefung -- weder in
     * `DunningDocumentationPanel` noch in `dunningDocumentationService`. Jedes
     * aktive Mitglied darf es heute, und `can_write_workspace` (Inhaber/Admin)
     * wuerde genau diese Mitglieder beim ersten Push aussperren.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE und Wiederholung: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     *
     * **Append-only.** Es gibt kein Bearbeiten und kein Loeschen; entsprechend
     * kennt dieser Zweig keinen Update-Pfad und die Tabelle keine
     * Grabsteinspalten. Ein erneuter Push derselben Kennung ist ein Replay und
     * gibt die vorhandene Zeile unveraendert zurueck -- der Nachweis bleibt
     * genau so stehen, wie er festgehalten wurde.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_dun_id := coalesce(nullif(trim(p_payload->>'documentation_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_dun_id is null then
      raise exception 'documentation_id fehlt';
    end if;

    v_dun_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_dun_invoice_id := coalesce(nullif(trim(p_payload->>'invoice_id'), ''), nullif(trim(v_dun_payload->>'invoiceId'), ''));
    v_dun_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_dun_payload->>'vorgangId', '')), '');
    v_dun_kind := coalesce(nullif(trim(p_payload->>'kind'), ''), nullif(trim(v_dun_payload->>'kind'), ''));
    v_dun_delivery := coalesce(nullif(trim(p_payload->>'delivery_method'), ''), nullif(trim(v_dun_payload->>'deliveryMethod'), ''));

    -- Guards: nur Sync-Struktur und die Identitaetsfelder, keine Fachlogik.
    if v_dun_invoice_id is null then
      raise exception 'invoice_id fehlt';
    end if;
    if v_dun_kind is null or v_dun_kind not in ('payment_reminder', 'dunning_notice') then
      raise exception 'Mahnnachweis ungueltig: kind' using errcode = 'P0001';
    end if;
    if v_dun_delivery is null then
      raise exception 'Mahnnachweis ungueltig: delivery_method' using errcode = 'P0001';
    end if;
    begin
      v_dun_documented_at := (coalesce(nullif(trim(p_payload->>'documented_at'), ''), v_dun_payload->>'documentedAt'))::date;
    exception when others then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end;
    if v_dun_documented_at is null then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end if;

    /*
     * Wiederholung derselben Kennung: unveraendert zurueckgeben.
     *
     * Ein Nachweis wird nicht fortgeschrieben. Ein zweiter Push entsteht durch
     * einen wiederholten Sendeversuch oder einen Backfill, nicht durch eine
     * Aenderung -- und darf den festgehaltenen Inhalt niemals ueberschreiben.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id and d.client_documentation_id = v_dun_id
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false
      );
    end if;

    /*
     * Fachliche Identitaet aus dem Produkt: `documentDunningDelivery` weist
     * eine zweite Bestaetigung derselben Uebergabe ab -- gleiche Rechnung,
     * gleicher Auftragsbezug, gleiche Art, gleiches Datum, gleicher Weg -- und
     * meldet `alreadyDocumented`. Zwei Geraete, die offline dasselbe
     * festhalten, senden zwei Kennungen fuer denselben Vorgang; der zweite
     * Push ist deshalb ein fachliches Replay und bekommt die vorhandene Zeile
     * zurueck. Die Notiz gehoert bewusst nicht zur Identitaet -- lokal war sie
     * es nie.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id
      and d.client_invoice_id = v_dun_invoice_id
      and coalesce(d.client_vorgang_id, '') = coalesce(v_dun_vorgang_id, '')
      and d.kind = v_dun_kind
      and d.documented_at = v_dun_documented_at
      and d.delivery_method = v_dun_delivery
    order by d.created_at, d.client_documentation_id
    limit 1
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'requested_entity_id', v_dun_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false,
        'deduped', true
      );
    end if;

    insert into public.workspace_invoice_dunning_documentations (
      workspace_id,
      client_documentation_id,
      client_invoice_id,
      client_vorgang_id,
      kind,
      documented_at,
      delivery_method,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_dun_id,
      v_dun_invoice_id,
      v_dun_vorgang_id,
      v_dun_kind,
      v_dun_documented_at,
      v_dun_delivery,
      v_dun_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_invoice_dunning_documentations.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_dun_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'workspace' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select w.version into v_current_version from public.workspaces w where w.id = p_workspace_id for update;
    if v_current_version is null then
      raise exception 'Workspace nicht gefunden';
    end if;
    if p_row_version > 0 and p_row_version <> v_current_version then
      raise exception 'Versionskonflikt workspace:%', v_current_version using errcode = 'P0001';
    end if;

    update public.workspaces
    set
      name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
      version = version + 1
    where id = p_workspace_id
    returning to_jsonb(public.workspaces.*) into v_result;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'workspace_settings' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select ws.version into v_current_version from public.workspace_settings ws where ws.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_settings (workspace_id, settings, version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'settings', '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_settings.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt workspace_settings:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_settings
      set
        settings = coalesce(p_payload->'settings', settings),
        version = version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_settings.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_setup' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select s.row_version into v_current_version from public.workspace_setup s where s.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_setup (workspace_id, payload, setup_version, row_version, updated_by)
      values (
        p_workspace_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        coalesce((p_payload->>'setup_version')::integer, 1),
        1,
        auth.uid()
      )
      returning to_jsonb(public.workspace_setup.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_setup:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_setup
      set
        payload = coalesce(p_payload->'payload', p_payload, payload),
        setup_version = coalesce((p_payload->>'setup_version')::integer, setup_version),
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_setup.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_profile' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select cp.row_version, cp.payload into v_current_version, v_existing_profile
    from public.workspace_company_profiles cp
    where cp.workspace_id = p_workspace_id
    for update;

    /*
     * 01B3 -- profile_schema_version: fehlend = 0 (Altclient); sonst nur
     * plausible, bekannte Werte 0..2. Ein hoeherer oder negativer Wert koennte
     * die Preserve-/Loeschsemantik aushebeln und wird abgewiesen.
     */
    if p_payload ? 'profile_schema_version'
       and (jsonb_typeof(p_payload->'profile_schema_version') <> 'number'
            or (p_payload->>'profile_schema_version') !~ ('^[0-9]{1,3}' || chr(36))
            or (p_payload->>'profile_schema_version')::integer > 2) then
      raise exception 'Firmenprofil ungueltig: profile_schema_version' using errcode = 'P0001';
    end if;
    v_incoming_schema := coalesce(nullif(p_payload->>'profile_schema_version', '')::integer, 0);

    if v_current_version is null then
      v_incoming_profile := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if jsonb_typeof(v_incoming_profile) = 'object' and v_incoming_schema >= 2 then
        -- explizites null eines wissenden Clients = nicht gesetzt
        for v_field in select * from (values ('defaultTaxStatus'), ('currency'), ('replyToEmail'), ('senderDisplayName')) as catalog(key) loop
          if jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;
      end if;
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);
      insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
      values (p_workspace_id, v_incoming_profile, 1, auth.uid())
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_profile:%', v_current_version using errcode = 'P0001';
      end if;

      v_incoming_profile := coalesce(p_payload->'payload', p_payload, v_existing_profile);

      if jsonb_typeof(v_incoming_profile) = 'object' then
        /*
         * PRODUCT-BASIS-FIRMENPROFIL-01B -- schema-versionierter Altclient-Schutz.
         *
         * Der Katalog nennt jedes Profilfeld, das nach der ersten Ganzdokument-
         * Fassung eingefuehrt wurde, mit der Schema-Version seiner Einfuehrung.
         * Ein Client sendet seine Schema-Version mit (fehlend = 0, alle Clients
         * vor 01B). Regel je Feld:
         *
         *   Client-Version <  Einfuehrungsversion und Feld fehlt im Payload
         *     -> der Client kennt das Feld nachweislich nicht: bestehenden Wert bewahren
         *   Client-Version >= Einfuehrungsversion
         *     -> der Client kennt das Feld: fehlend oder null = bewusstes Loeschen
         *
         * Kein Deep-Merge, kein pauschales Konservieren: Alles, was nicht im
         * Katalog steht, wird weiterhin vollstaendig ersetzt. Ein neues Feld
         * braucht genau einen Eintrag hier und eine erhoehte Version im Client.
         */
        for v_field in
          select * from (values
            ('defaultTaxStatus', 2),
            ('currency', 2),
            ('replyToEmail', 2),
            ('senderDisplayName', 2)
          ) as catalog(key, introduced_in)
        loop
          if v_incoming_schema < v_field.introduced_in
             and not (v_incoming_profile ? v_field.key)
             and (v_existing_profile ? v_field.key) then
            v_incoming_profile := jsonb_set(
              v_incoming_profile,
              array[v_field.key],
              v_existing_profile -> v_field.key,
              true
            );
          elsif v_incoming_schema >= v_field.introduced_in
             and jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            -- explizites null eines wissenden Clients = Loeschen: Schluessel entfernen
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;

        /*
         * BRANDING-01E-0 -- Altclient-Schutz fuer `branding` bleibt unveraendert
         * (Asset-Referenz ist unveraenderlich; null ist kein Loeschsignal):
         * uebernommen wird nur ein echtes JSON-Objekt, sonst wird ein
         * vorhandenes Branding bewahrt. Kein Deep-Merge.
         */
        if jsonb_typeof(v_incoming_profile->'branding') is distinct from 'object'
           and jsonb_typeof(v_existing_profile->'branding') = 'object' then
          v_incoming_profile := jsonb_set(
            v_incoming_profile,
            '{branding}',
            v_existing_profile->'branding',
            true
          );
        end if;
      end if;

      /*
       * 01B3 -- Validierung des **endgueltigen** Dokuments (nach Preserve und
       * Loeschsemantik): Ein ungueltiger Wert bricht den Write atomar ab, der
       * bestehende Stand bleibt unveraendert (kein Teilupdate).
       */
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);

      update public.workspace_company_profiles
      set
        payload = v_incoming_profile,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  else
    raise exception 'Unbekannter Entity-Typ: %', p_entity_type;
  end if;
end;
$$;
