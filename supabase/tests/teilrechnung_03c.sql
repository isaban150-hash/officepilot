-- TEILRECHNUNG-03C — Laufzeit-Regressionstest fuer die sichtbare Teilrechnung.
--
-- Die Teilrechnung ist kein neues Rechenmodell: Sie verbraucht Menge wie jede
-- Rechnung, laeuft im gemeinsamen Nummernkreis, unterliegt denselben
-- 03B-Guards, wird nie als Abschlag abgezogen und ist stornierbar.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/teilrechnung_03c.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000ae03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'teilrechnung@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000000e01', 'Teilrechnung-03C', '00000000-0000-0000-0000-00000000ae03');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-00000000ae03', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-000000000e01', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ae03","role":"authenticated"}', true);

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

/* Eine Rechnung, wie der Client sie baut. */
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
    'issueDate', '2026-10-03',
    'customerSnapshot', jsonb_build_object('name', 'Muster GmbH'),
    'positions', case when p_menge > 0 then jsonb_build_array(jsonb_build_object(
      'id', 'line-' || p_type || '-' || p_menge::text,
      'orderPositionId', 'tp1',
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
  ws constant uuid := '00000000-0000-0000-0000-000000000e01';
  kunde constant jsonb := '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb;
  r jsonb;
  n numeric;
  v_nummer_teil text;
  v_nummer_rest text;
  v_nummern text[];
begin
  /* Auftrag: 10 x 100 = 1.000 (Kleinunternehmer, damit die Zahlen des Auftrags gelten). */
  perform public.create_workspace_order(ws, 'v-teil', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', kunde, 'title', 'Teilrechnungsprobe', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"tp1","description":"Montagestunden","plannedQuantity":10,"unit":"Stück","unitPrice":100}]'::jsonb));

  /* 1/2: Teilrechnung ueber 4 von 10 — gemeinsamer Nummernkreis, Menge verbraucht. */
  r := public.finalize_workspace_invoice(ws, 'v-teil', 'inv-teil-1', pg_temp.beleg('teilrechnung', 4, 400, 400));
  v_nummer_teil := r->'row'->>'invoice_number';
  if (r->>'idempotent_replay')::boolean or v_nummer_teil is null then raise exception '1: %', r; end if;
  if r->'row'->>'invoice_type' <> 'teilrechnung' then raise exception '1: Typ % nicht gespeichert', r->'row'->>'invoice_type'; end if;
  n := public.workspace_invoice_billed_quantity(ws, 'v-teil', 'tp1', null);
  if n <> 4 then raise exception '2: billedQuantity % statt 4', n; end if;
  raise notice 'OK  1/2: Teilrechnung % verbraucht 4 von 10', v_nummer_teil;

  /* 3: Die Teilrechnung ist kein Abschlagsabzug. */
  if public.workspace_invoice_abschlag_deductions(ws, 'v-teil', null) <> 0 then
    raise exception '3: Teilrechnung als Abzug gezaehlt (%)', public.workspace_invoice_abschlag_deductions(ws, 'v-teil', null);
  end if;
  perform pg_temp.erwarte_fehler('3b Schlussrechnung mit erfundenem Teilrechnungsabzug',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000e01','v-teil','inv-schluss-falsch', pg_temp.beleg('schluss', 6, 600, 200, '{"previousAbschlagDeductions":[{"invoiceId":"inv-teil-1","amount":400}]}'::jsonb))$q$,
    'invoice_deductions_mismatch');
  raise notice 'OK  3: Teilrechnung wirkt ueber die Menge, nie als Geldabzug';

  /* 4/5: 03B-Guards gelten unveraendert — auch fuer die Teilrechnung. */
  perform pg_temp.erwarte_fehler('4 zweite Teilrechnung ueber den Rest hinaus',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000e01','v-teil','inv-teil-zuviel', pg_temp.beleg('teilrechnung', 7, 700, 700))$q$,
    'invoice_quantity_exceeds_available');
  perform pg_temp.erwarte_fehler('5a manipulierter Einzelpreis',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000e01','v-teil','inv-teil-preis', jsonb_set(pg_temp.beleg('teilrechnung', 2, 10, 10), '{positions,0,unitPrice}', '5'))$q$,
    'invoice_position_mismatch');
  perform pg_temp.erwarte_fehler('5b manipulierte Summe',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000e01','v-teil','inv-teil-summe', pg_temp.beleg('teilrechnung', 2, 1, 1))$q$,
    'invoice_totals_mismatch');
  perform pg_temp.erwarte_fehler('5c abweichender Steuerstatus',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000e01','v-teil','inv-teil-steuer', pg_temp.beleg('teilrechnung', 2, 200, 238) || '{"taxStatus":"standard_19"}'::jsonb)$q$,
    'invoice_tax_status_mismatch');
  -- Mit ausdruecklicher Bestaetigung bleibt die bewusste Ueberschreitung moeglich (03B-Regel).
  r := public.finalize_workspace_invoice(ws, 'v-teil', 'inv-teil-bewusst', pg_temp.beleg('teilrechnung', 7, 700, 700), true);
  if (r->>'idempotent_replay')::boolean then raise exception '5d: %', r; end if;
  -- und wird sofort wieder zurueckgenommen, damit die folgenden Faelle vom Rest 6 ausgehen.
  perform public.cancel_workspace_invoice(ws, 'inv-teil-bewusst', 'Nur zur Pruefung der 03B-Regel');
  n := public.workspace_invoice_billed_quantity(ws, 'v-teil', 'tp1', null);
  if n <> 4 then raise exception '5e: nach Storno % statt 4 abgerechnet', n; end if;
  raise notice 'OK  4/5: 03B-Guards greifen bei der Teilrechnung unveraendert';

  /* 6: Die Folgerechnung sieht nur den Rest — Szenario 1 aus dem Auftrag. */
  r := public.finalize_workspace_invoice(ws, 'v-teil', 'inv-schluss', pg_temp.beleg('schluss', 6, 600, 600));
  v_nummer_rest := r->'row'->>'invoice_number';
  if (r->'invoice'->>'amount')::numeric <> 600 then raise exception '6: Schlussbetrag %', r->'invoice'->>'amount'; end if;
  select coalesce(sum((payload->>'amount')::numeric), 0) into n
  from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-teil' and cancelled_at is null;
  if n <> 1000 then raise exception '6: Gesamt % statt 1000', n; end if;
  raise notice 'OK  6: 400 + 600 = 1000, kein zweiter Abzug';

  /* 7: Nummern sind eindeutig und stammen aus demselben Kreis. */
  select array_agg(invoice_number order by invoice_number) into v_nummern
  from public.workspace_invoices where workspace_id = ws;
  if array_length(v_nummern, 1) <> (select count(distinct invoice_number) from public.workspace_invoices where workspace_id = ws) then
    raise exception '7: doppelte Rechnungsnummer in %', v_nummern;
  end if;
  if v_nummer_teil = v_nummer_rest then raise exception '7: Teil- und Schlussrechnung teilen eine Nummer'; end if;
  raise notice 'OK  7: gemeinsamer Nummernkreis, eindeutige Nummern (%)', array_to_string(v_nummern, ', ');

  /* 8/9: Storno der Teilrechnung gibt die Menge frei und wirkt nicht als Abzug. */
  perform public.cancel_workspace_invoice(ws, 'inv-schluss', 'Ersatz notwendig');
  perform public.cancel_workspace_invoice(ws, 'inv-teil-1', 'Falsche Menge');
  n := public.workspace_invoice_billed_quantity(ws, 'v-teil', 'tp1', null);
  if n <> 0 then raise exception '8: nach Storno % statt 0 abgerechnet', n; end if;
  if public.workspace_invoice_abschlag_deductions(ws, 'v-teil', null) <> 0 then
    raise exception '9: stornierte Teilrechnung wirkt als Abzug';
  end if;
  raise notice 'OK  8/9: Storno der Teilrechnung gibt alle 10 wieder frei';

  /* 10: Die freigegebene Menge ist erneut abrechenbar. */
  r := public.finalize_workspace_invoice(ws, 'v-teil', 'inv-teil-neu', pg_temp.beleg('teilrechnung', 4, 400, 400));
  if (r->>'idempotent_replay')::boolean then raise exception '10: %', r; end if;
  n := public.workspace_invoice_billed_quantity(ws, 'v-teil', 'tp1', null);
  if n <> 4 then raise exception '10: % statt 4', n; end if;
  raise notice 'OK  10: nach dem Storno wieder 4 von 10 abrechenbar';

  /* 11: Szenario 4 — Teilrechnung neben einem Pauschalabschlag. */
  perform public.create_workspace_order(ws, 'v-mix', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', kunde, 'title', 'Gemischt', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"tp1","description":"Montagestunden","plannedQuantity":10,"unit":"Stück","unitPrice":100}]'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-mix', 'inv-mix-teil', pg_temp.beleg('teilrechnung', 4, 400, 400));
  perform public.finalize_workspace_invoice(ws, 'v-mix', 'inv-mix-pauschal',
    pg_temp.beleg('abschlag', 0, 200, 200, '{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb));
  if public.workspace_invoice_abschlag_deductions(ws, 'v-mix', null) <> 200 then
    raise exception '11: Abzug % statt 200', public.workspace_invoice_abschlag_deductions(ws, 'v-mix', null);
  end if;
  r := public.finalize_workspace_invoice(ws, 'v-mix', 'inv-mix-schluss',
    pg_temp.beleg('schluss', 6, 600, 400, '{"previousAbschlagDeductions":[{"invoiceId":"inv-mix-pauschal","amount":200}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric <> 400 then raise exception '11: Schlussbetrag %', r->'invoice'->>'amount'; end if;
  select coalesce(sum((payload->>'amount')::numeric), 0) into n
  from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-mix' and cancelled_at is null;
  if n <> 1000 then raise exception '11: Gesamt % statt 1000', n; end if;
  raise notice 'OK  11: 400 Teilrechnung + 200 Pauschalabschlag + 400 Schluss = 1000';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
