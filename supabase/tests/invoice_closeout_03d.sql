-- RECHNUNGSBEREICH-03D — Abschlagsstorno und Geschaeftstag.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/invoice_closeout_03d.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000af04', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'closeout@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000000f01', 'Closeout-03D', '00000000-0000-0000-0000-00000000af04');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-00000000af04', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-000000000f01', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000af04","role":"authenticated"}', true);

create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% — falscher Fehler: %', p_label, sqlerrm;
    end if;
    raise notice 'OK  %: %', p_label, left(sqlerrm, 120);
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

create function pg_temp.beleg(
  p_type text,
  p_menge numeric,
  p_subtotal numeric,
  p_amount numeric,
  p_extra jsonb default '{}'::jsonb
) returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'type', p_type,
    'taxStatus', 'kleinunternehmer_19',
    'issueDate', '2026-10-04',
    'customerSnapshot', jsonb_build_object('name', 'Muster GmbH'),
    'positions', case when p_menge > 0 then jsonb_build_array(jsonb_build_object(
      'id', 'line-' || p_type || '-' || p_menge::text,
      'orderPositionId', 'cp1',
      'description', 'Montagestunden',
      'quantity', p_menge,
      'unit', 'Stück',
      'unitPrice', 100,
      'lineTotal', p_menge * 100
    )) else '[]'::jsonb end,
    'subtotal', p_subtotal,
    'amount', p_amount
  ) || p_extra;
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-000000000f01';
  kunde constant jsonb := '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb;
  auftrag constant jsonb := jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb,
    'title', 'Closeout', 'baustelle', '', 'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":10,"unit":"Stück","unitPrice":100}]'::jsonb);
  r jsonb;
  n numeric;
  v_tag text;
  v_erwartet text;
begin
  /* 1: Das Auftragsdatum ist der Geschaeftstag (Europe/Berlin), nicht der UTC-Tag. */
  perform public.create_workspace_order(ws, 'v-tag', auftrag);
  select payload->>'orderDate' into v_tag from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-tag';
  v_erwartet := to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM-DD');
  if v_tag <> v_erwartet then raise exception '1: Auftragsdatum % statt % (Geschaeftstag)', v_tag, v_erwartet; end if;
  raise notice 'OK  1: Auftragsdatum folgt dem Geschaeftstag (%)', v_tag;

  /* 2/3: mengenbasierter Abschlag verbraucht Menge und ist stornierbar. */
  perform public.create_workspace_order(ws, 'v-menge', auftrag);
  perform public.finalize_workspace_invoice(ws, 'v-menge', 'inv-ab-menge',
    pg_temp.beleg('abschlag', 3, 300, 300, '{"calculationMode":"quantity_based","abschlagNumber":1}'::jsonb));
  n := public.workspace_invoice_billed_quantity(ws, 'v-menge', 'cp1', null);
  if n <> 3 then raise exception '2: billed % statt 3', n; end if;
  if public.workspace_invoice_abschlag_deductions(ws, 'v-menge', null) <> 0 then raise exception '2: mengenbasiert als Abzug'; end if;

  perform public.cancel_workspace_invoice(ws, 'inv-ab-menge', 'Falsche Menge');
  n := public.workspace_invoice_billed_quantity(ws, 'v-menge', 'cp1', null);
  if n <> 0 then raise exception '3: nach Storno % statt 0', n; end if;
  if public.workspace_invoice_abschlag_deductions(ws, 'v-menge', null) <> 0 then raise exception '3: stornierter Abschlag zaehlt als Abzug'; end if;
  raise notice 'OK  2/3: mengenbasierter Abschlag stornierbar, Menge wieder frei';

  /* 4: Nach dem Storno ist die volle Menge erneut abrechenbar, ohne Abzug. */
  r := public.finalize_workspace_invoice(ws, 'v-menge', 'inv-menge-schluss', pg_temp.beleg('schluss', 10, 1000, 1000));
  if (r->'invoice'->>'amount')::numeric <> 1000 then raise exception '4: Schlussbetrag %', r->'invoice'->>'amount'; end if;
  raise notice 'OK  4: erneute Abrechnung nach Storno, kein Geldabzug';

  /* 5/6: Pauschalabschlag — Abzug vorhanden, nach Storno verschwunden. */
  perform public.create_workspace_order(ws, 'v-pausch', auftrag);
  perform public.finalize_workspace_invoice(ws, 'v-pausch', 'inv-ab-pausch',
    pg_temp.beleg('abschlag', 0, 200, 200, '{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb));
  if public.workspace_invoice_abschlag_deductions(ws, 'v-pausch', null) <> 200 then raise exception '5: Abzug fehlt'; end if;
  if public.workspace_invoice_billed_quantity(ws, 'v-pausch', 'cp1', null) <> 0 then raise exception '5: Pauschalabschlag verbraucht Menge'; end if;

  perform public.cancel_workspace_invoice(ws, 'inv-ab-pausch', 'Doppelt erfasst');
  if public.workspace_invoice_abschlag_deductions(ws, 'v-pausch', null) <> 0 then raise exception '6: Abzug ueberlebt das Storno'; end if;
  -- Die Schlussrechnung rechnet danach ohne Abzug: 10 x 100 = 1.000.
  r := public.finalize_workspace_invoice(ws, 'v-pausch', 'inv-pausch-schluss', pg_temp.beleg('schluss', 10, 1000, 1000));
  if (r->'invoice'->>'amount')::numeric <> 1000 then raise exception '6: Schlussbetrag %', r->'invoice'->>'amount'; end if;
  raise notice 'OK  5/6: Pauschalabschlag stornierbar, Abzug verschwindet aus der Schlussrechnung';

  /* 7: Das Storno selbst verbraucht keine Menge und ist wiederholbar (idempotent). */
  perform public.create_workspace_order(ws, 'v-idem', auftrag);
  perform public.finalize_workspace_invoice(ws, 'v-idem', 'inv-idem',
    pg_temp.beleg('abschlag', 2, 200, 200, '{"calculationMode":"quantity_based","abschlagNumber":1}'::jsonb));
  perform public.cancel_workspace_invoice(ws, 'inv-idem', 'Erster Storno');
  perform public.cancel_workspace_invoice(ws, 'inv-idem', 'Erster Storno');
  select count(*) into n from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-idem';
  if n <> 1 then raise exception '7: % Belege statt 1', n; end if;
  if public.workspace_invoice_billed_quantity(ws, 'v-idem', 'cp1', null) <> 0 then raise exception '7: Storno verbraucht Menge'; end if;
  raise notice 'OK  7: Storno bleibt idempotent und verbraucht keine Menge';

  /* 8: Die bestehenden Stornowege bleiben unveraendert erlaubt bzw. gesperrt. */
  perform public.create_workspace_order(ws, 'v-rest', auftrag);
  perform public.finalize_workspace_invoice(ws, 'v-rest', 'inv-normal', pg_temp.beleg('rechnung', 1, 100, 100));
  perform public.finalize_workspace_invoice(ws, 'v-rest', 'inv-teil', pg_temp.beleg('teilrechnung', 1, 100, 100));
  perform public.cancel_workspace_invoice(ws, 'inv-normal', 'Test');
  perform public.cancel_workspace_invoice(ws, 'inv-teil', 'Test');
  if public.workspace_invoice_billed_quantity(ws, 'v-rest', 'cp1', null) <> 0 then raise exception '8: Mengen nicht freigegeben'; end if;
  perform pg_temp.erwarte_fehler('8b unbekannte Rechnung',
    $q$select public.cancel_workspace_invoice('00000000-0000-0000-0000-000000000f01','inv-gibt-es-nicht','Test')$q$,
    'Rechnung nicht gefunden');
  raise notice 'OK  8: Rechnung und Teilrechnung weiterhin stornierbar';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
