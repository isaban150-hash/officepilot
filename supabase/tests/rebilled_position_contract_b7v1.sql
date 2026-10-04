-- BEREICH-7-V1 — Laufzeittest: Akzeptiert der Server eine weiterberechnete
-- Lieferantenkostenposition?
--
-- Das ist der eigentliche Beweis des Blocks. Die Analyse hatte gezeigt: Bei
-- einer Rechnung **mit** Auftragsbezug prueft `finalize_workspace_invoice`
-- jede Zeile gegen den Auftragsplan — eine frei angehaengte Zeile scheitert an
-- `invoice_position_not_found`, eine mit abweichendem Preis an
-- `invoice_position_mismatch`. Genau deshalb erzeugt die Weiterberechnung
-- keine freie Zeile, sondern eine regulaere Auftragsposition.
--
-- Geprueft wird nicht der Migrationstext, sondern die reale SQL-Semantik
-- gegen eine lokale Datenbank — und zwar mit genau der Positionsform, die
-- `rebillAllocation` erzeugt:
--
--   category sonstiges, unit Pauschal, plannedQuantity 1, billable true,
--   unitPrice = Einkaufsnetto x (1 + Aufschlag), auf den Cent
--
-- Kontrollfall: 400,00 EUR Einkaufsnetto + 10 % = 440,00 EUR, bei 19 %
-- Umsatzsteuer also 83,60 Steuer und 523,60 brutto. Die 19 % stammen dabei
-- ausdruecklich vom Beleg und nicht von der Lieferantenrechnung.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/rebilled_position_contract_b7v1.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000b7001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'rebill-b7v1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

/* R1-SEC-01 — Finanzaktionen verlangen ein freigegebenes Konto mit Lizenz. */
update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like '%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000b7f01', 'Weiterberechnung-B7V1', '00000000-0000-0000-0000-0000000b7001');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000b7f01', '00000000-0000-0000-0000-0000000b7001', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000b7f01', 'cust-b7', '{"id":"cust-b7","name":"Muster GmbH"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000b7001","role":"authenticated"}', true);

create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% — falscher Fehler: % (erwartet: %)', p_label, sqlerrm, p_expected;
    end if;
    raise notice 'OK  %: %', p_label, left(sqlerrm, 120);
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

create function pg_temp.rechnung(p_positions jsonb, p_subtotal numeric, p_amount numeric)
returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'type', 'rechnung',
    'positions', p_positions,
    'taxStatus', 'standard_19',
    'subtotal', p_subtotal,
    'amount', p_amount,
    'issueDate', '2026-10-03',
    'customerSnapshot', jsonb_build_object('name', 'Muster GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld')
  );
$p$;

/* Genau die Zeile, die der Entwurf aus der weiterberechneten Position bildet. */
create function pg_temp.zeile(p_position_id text, p_qty numeric, p_price numeric, p_unit text default 'Pauschal')
returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'id', 'line-' || p_position_id,
    'orderPositionId', p_position_id,
    'description', 'Lieferantenkosten Baustoff Nord GmbH LR-4711',
    'quantity', p_qty,
    'unit', p_unit,
    'unitPrice', p_price,
    'lineTotal', round(p_qty * p_price * 100) / 100
  );
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-0000000b7f01';
  r jsonb;
  n integer;
begin
  /*
   * Der Auftrag traegt eine gewoehnliche Leistungsposition und — als zweite —
   * die weiterberechnete Lieferantenkostenposition, so wie `addOrderPosition`
   * sie anlegt.
   */
  perform public.upsert_workspace_sync_entity(ws, 'vorgang', jsonb_build_object('vorgang_id', 'v-b7', 'payload',
    '{"id":"v-b7","title":"Bad Sanierung","customer":"Muster GmbH","customerId":"cust-b7",
      "customerBilling":{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"},
      "baustelle":"Weg 1","status":"beauftragt","materialSource":"betrieb",
      "orderPositions":[
        {"id":"p1","description":"Monteurstunden","plannedQuantity":10,"unit":"Stunden","unitPrice":100,"category":"arbeit","billable":true},
        {"id":"op-rebill-1","description":"Lieferantenkosten Baustoff Nord GmbH LR-4711","plannedQuantity":1,"unit":"Pauschal","unitPrice":440,"category":"sonstiges","billable":true}
      ]}'::jsonb), 0);

  /* 1: Die weiterberechnete Position wird vom Server angenommen. */
  r := public.finalize_workspace_invoice(ws, 'v-b7', 'inv-b7-1',
    pg_temp.rechnung(jsonb_build_array(pg_temp.zeile('op-rebill-1', 1, 440)), 440, 523.6));
  if (r->>'idempotent_replay')::boolean then raise exception '1: unerwarteter Replay'; end if;
  if r->'row'->>'invoice_number' is null then raise exception '1: keine Rechnungsnummer'; end if;
  raise notice 'OK  1: weiterberechnete Position akzeptiert (%)', r->'row'->>'invoice_number';

  /* 2: Die Steuer kommt vom Beleg — 19 % auf 440,00 sind 523,60 brutto. */
  if (r->'invoice'->>'amount')::numeric <> 523.6 then
    raise exception '2: Brutto % statt 523.60', r->'invoice'->>'amount';
  end if;
  if (r->'invoice'->>'subtotal')::numeric <> 440 then
    raise exception '2: Netto % statt 440.00', r->'invoice'->>'subtotal';
  end if;
  raise notice 'OK  2: 19 %% des Belegs, nicht die Vorsteuer der Lieferantenrechnung';

  /* 3: Planmenge 1 ist verbraucht — kein zweites Mal ohne Bestaetigung. */
  perform pg_temp.erwarte_fehler('3 Position genau einmal abrechenbar',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-0000000b7f01','v-b7','inv-b7-2',
      pg_temp.rechnung(jsonb_build_array(pg_temp.zeile('op-rebill-1', 1, 440)), 440, 523.6))$q$,
    'invoice_quantity_exceeds_available');
  select count(*) into n from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-b7-2';
  if n <> 0 then raise exception '3: abgewiesene Rechnung wurde gespeichert'; end if;

  /*
   * 4: Der Gegenbeweis — genau derselbe Betrag als **freie** Zeile ohne
   * Auftragsbezug. Das ist der Weg, den V1 bewusst nicht geht, und der Server
   * weist ihn ab. Ohne diesen Fall waere Punkt 1 kein Beweis.
   */
  perform pg_temp.erwarte_fehler('4 freie Zeile ohne Auftragsbezug',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-0000000b7f01','v-b7','inv-b7-3',
      pg_temp.rechnung(jsonb_build_array(
        jsonb_build_object('id','line-frei','description','Lieferantenkosten','quantity',1,'unit','Pauschal','unitPrice',440,'lineTotal',440)
      ), 440, 523.6))$q$,
    'invoice_position_not_found');

  /* 5: Ein nachtraeglich abweichender Preis wird ebenfalls abgewiesen. */
  perform pg_temp.erwarte_fehler('5 Preis weicht vom Auftragsplan ab',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-0000000b7f01','v-b7','inv-b7-4',
      pg_temp.rechnung(jsonb_build_array(pg_temp.zeile('op-rebill-1', 1, 500)), 500, 595))$q$,
    'invoice_position_mismatch');

  /* 6: Auch die Einheit ist Teil des Vertrags. */
  perform pg_temp.erwarte_fehler('6 Einheit weicht ab',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-0000000b7f01','v-b7','inv-b7-5',
      pg_temp.rechnung(jsonb_build_array(pg_temp.zeile('op-rebill-1', 1, 440, 'Stunden')), 440, 523.6))$q$,
    'invoice_position_mismatch');

  raise notice 'OK  4/5/6: der Integritaetskern bleibt unangetastet';
end;
$$;

/*
 * 7: Der Marker reist im Expense-Payload mit — ohne Migration, ohne neue
 * Spalte. Der Server prueft die Geldfelder des Belegs (siehe 05B2), nicht aber
 * das Innere der Zuordnungen; genau das macht den Marker migrationsfrei.
 * Geprueft wird, dass er unveraendert zurueckkommt.
 */
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-0000000b7f01';
  v_marker text;
begin
  perform public.upsert_workspace_expense(ws, jsonb_build_object(
    'client_expense_id', 'exp-b7',
    'status', 'gebucht',
    'dedupe_key', 'dk-b7',
    'linked_inbox_id', null,
    'archive_document_id', null,
    'deleted', false,
    'payload', '{"id":"exp-b7","title":"Material","supplierName":"Baustoff Nord GmbH",
      "netAmount":400,"taxAmount":76,"grossAmount":476,"currency":"EUR","taxStatus":"standard_19",
      "issueDate":"2026-09-05","category":"material","positions":[],
      "allocations":[{"vorgangId":"v-b7","vorgangTitle":"Bad Sanierung","amount":400,"rebilledOrderPositionId":"op-rebill-1"}]}'::jsonb
  ), 0);

  select e.payload->'allocations'->0->>'rebilledOrderPositionId' into v_marker
  from public.workspace_expenses e
  where e.workspace_id = ws and e.client_expense_id = 'exp-b7';

  if v_marker is distinct from 'op-rebill-1' then
    raise exception '7: Marker ging verloren (%)', v_marker;
  end if;
  raise notice 'OK  7: Herkunftsmarker ueberlebt den Serverweg unveraendert';
end;
$$;

rollback;
