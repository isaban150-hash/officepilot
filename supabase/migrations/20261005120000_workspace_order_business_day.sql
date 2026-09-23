-- RECHNUNGSBEREICH-03D -- das Auftragsdatum ist der Geschaeftstag, nicht der UTC-Tag.
--
-- Realbefund aus der unabhaengigen Abnahme: Ein am 23.09.2026 um 00:30
-- Ortszeit angelegter Auftrag trug den 22.09.2026. Beide Auftrags-RPCs bilden
-- das Datum aus `now() at time zone 'utc'`; zwischen lokaler Mitternacht und
-- UTC-Mitternacht liegt dieser Tag zurueck.
--
-- Der Client ist in derselben Migration nicht betroffen -- er bildet seine
-- Datumswerte seit 03D selbst aus dem lokalen Kalendertag. Hier geht es allein
-- um die beiden serverseitig vergebenen Auftragsdaten.
--
-- Zone: 'Europe/Berlin'. OfficeTakt ist ein deutsches Handwerksprodukt; eine
-- Zeitzone je Betrieb gibt es im Profil nicht, und sie zu erfinden waere mehr
-- Annahme als Loesung. Alle uebrigen Zeitstempel bleiben UTC.
--
-- Bestehende Auftraege werden nicht angefasst; nur neu entstehende Auftraege
-- bekommen den richtigen Tag.

create or replace function public.accept_workspace_offer(
  p_workspace_id uuid,
  p_offer_id text,
  p_vorgang_id text,
  p_row_version bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer public.workspace_offers;
  v_vorgang public.workspace_vorgaenge;
  v_existing_vid text;
  v_year integer;
  v_seq integer;
  v_number text;
  v_now timestamptz := now();
  v_now_iso text;
  v_today text;
  v_pl jsonb;
  v_positions jsonb;
  v_conf jsonb;
  v_vorgang_payload jsonb;
begin
  p_row_version := coalesce(p_row_version, 0);
  v_now_iso := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- RECHNUNGSBEREICH-03D: das Auftragsdatum ist der Geschaeftstag des Betriebs.
  v_today := to_char(v_now at time zone 'Europe/Berlin', 'YYYY-MM-DD');

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  -- Auftraege sind Vorgaenge: dieselbe Rolle wie fuer jeden Vorgangs-Write.
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if p_offer_id is null or length(trim(p_offer_id)) = 0 then
    raise exception 'offer_id fehlt';
  end if;
  if p_vorgang_id is null or length(trim(p_vorgang_id)) = 0 then
    raise exception 'vorgang_id fehlt';
  end if;

  select o.* into v_offer
  from public.workspace_offers o
  where o.workspace_id = p_workspace_id and o.client_offer_id = p_offer_id
  for update;
  if not found then
    raise exception 'Angebot nicht gefunden' using errcode = 'P0001';
  end if;
  if v_offer.deleted then
    raise exception 'Angebot ist geloescht' using errcode = 'P0001';
  end if;

  -- Wiederholung: bereits angenommen -> denselben Auftrag zurueckgeben.
  if v_offer.status = 'angenommen' then
    v_existing_vid := nullif(trim(coalesce(v_offer.payload->>'resultingVorgangId', '')), '');
    select v.* into v_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_existing_vid and v.deleted = false;
    if not found then
      raise exception 'Angebot ist angenommen, aber der Auftrag fehlt' using errcode = 'P0001';
    end if;
    return jsonb_build_object('offer', to_jsonb(v_offer), 'vorgang', to_jsonb(v_vorgang), 'replayed', true);
  end if;

  if v_offer.status not in ('freigegeben', 'versendet') then
    raise exception 'Angebot kann im Zustand % nicht angenommen werden', v_offer.status using errcode = 'P0001';
  end if;
  if p_row_version > 0 and p_row_version <> v_offer.row_version then
    raise exception 'Versionskonflikt offer:%', v_offer.row_version using errcode = 'P0001';
  end if;
  if v_offer.offer_number is null then
    raise exception 'Angebot ohne Nummer kann nicht angenommen werden' using errcode = 'P0001';
  end if;
  -- Die Vorgangskennung kommt vom Client; sie darf noch nicht vergeben sein.
  if exists (select 1 from public.workspace_vorgaenge v where v.workspace_id = p_workspace_id and v.vorgang_id = p_vorgang_id) then
    raise exception 'Vorgangskennung bereits vergeben' using errcode = 'P0001';
  end if;

  v_pl := v_offer.payload;
  if length(trim(coalesce(v_pl->'customer'->>'name', ''))) = 0 then
    raise exception 'Angebot ohne Kunden kann nicht angenommen werden' using errcode = 'P0001';
  end if;

  -- Auftragsnummer, unter Sperre der Jahressequenz.
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

  -- Positionen: Angebotsposition -> Auftragsposition (Plan = angebotene Menge).
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', p->>'id',
    'description', p->>'description',
    'plannedQuantity', (p->>'quantity')::numeric,
    'unit', p->>'unit',
    'unitLabel', p->'unitLabel',
    'unitPrice', (p->>'unitPrice')::numeric,
    'category', p->'category',
    'billable', true
  ))), '[]'::jsonb)
  into v_positions
  from jsonb_array_elements(coalesce(v_pl->'positions', '[]'::jsonb)) p
  where jsonb_typeof(p->'quantity') = 'number' and (p->>'quantity')::numeric > 0;

  if jsonb_array_length(v_positions) = 0 then
    raise exception 'Angebot ohne Positionen kann nicht angenommen werden' using errcode = 'P0001';
  end if;

  -- Der eingefrorene kaufmaennische Stand -- dieselbe Struktur wie beim Werkvertrag.
  v_conf := jsonb_build_object(
    'id', 'conf-' || p_vorgang_id,
    'confirmedAt', v_now_iso,
    'customer', v_pl->'customer'->>'name',
    'auftraggeber', v_pl->'customer'->>'name',
    'baustelle', coalesce(v_pl->>'baustelle', ''),
    'title', coalesce(v_pl->>'title', ''),
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

  v_vorgang_payload := jsonb_strip_nulls(jsonb_build_object(
    'id', p_vorgang_id,
    'title', coalesce(v_pl->>'title', ''),
    'customer', v_pl->'customer'->>'name',
    'baustelle', coalesce(v_pl->>'baustelle', ''),
    'status', 'beauftragt',
    'materialSource', 'unclear',
    'customerBilling', v_pl->'customer',
    'customerId', v_pl->'customerId',
    'orderPositions', v_positions,
    'contractConfirmation', v_conf,
    'sourceOfferId', p_offer_id,
    'sourceOfferNumber', v_offer.offer_number,
    'orderNumber', v_number,
    'orderDate', v_today,
    'taxStatus', v_pl->'taxStatus',
    'paymentTermsText', v_pl->'paymentTermsText',
    'introText', v_pl->'introText',
    'closingText', v_pl->'closingText',
    'contractTotals', v_pl->'totals'
  ));

  insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload, row_version, deleted, updated_by, source_offer_id, order_number)
  values (p_workspace_id, p_vorgang_id, v_vorgang_payload, 1, false, auth.uid(), p_offer_id, v_number)
  returning * into v_vorgang;

  update public.workspace_offers
  set
    status = 'angenommen',
    payload = payload || jsonb_build_object('status', 'angenommen', 'resultingVorgangId', p_vorgang_id, 'decidedAt', v_now_iso),
    row_version = row_version + 1,
    updated_by = auth.uid()
  where workspace_id = p_workspace_id and client_offer_id = p_offer_id
  returning * into v_offer;

  return jsonb_build_object('offer', to_jsonb(v_offer), 'vorgang', to_jsonb(v_vorgang), 'replayed', false);
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
  -- RECHNUNGSBEREICH-03D: das Auftragsdatum ist der Geschaeftstag des Betriebs.
  v_today := to_char(v_now at time zone 'Europe/Berlin', 'YYYY-MM-DD');

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
