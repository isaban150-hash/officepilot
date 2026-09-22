-- RECHNUNGSINTEGRITAET-03B — Laufzeit-Regressionstest fuer die serverseitige
-- Pruefung in `finalize_workspace_invoice`.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/invoice_integrity_03b.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000ad03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'invoice-integrity@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000000d01', 'Rechnung-03B', '00000000-0000-0000-0000-00000000ad03');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000000d01', '00000000-0000-0000-0000-00000000ad03', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-000000000d01', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ad03","role":"authenticated"}', true);

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

/* Eine Rechnung, wie der Client sie baut: Positionen, Steuerstatus, Summen. */
create function pg_temp.rechnung(
  p_type text,
  p_positions jsonb,
  p_subtotal numeric,
  p_amount numeric,
  p_tax text default 'standard_19',
  p_extra jsonb default '{}'::jsonb
) returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'type', p_type,
    'positions', p_positions,
    'taxStatus', p_tax,
    'subtotal', p_subtotal,
    'amount', p_amount,
    'issueDate', '2026-10-01',
    'customerSnapshot', jsonb_build_object('name', 'Muster GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld')
  ) || p_extra;
$p$;

create function pg_temp.zeile(p_position_id text, p_qty numeric, p_price numeric, p_unit text default 'Stunden')
returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'id', 'line-' || p_position_id || '-' || p_qty::text,
    'orderPositionId', p_position_id,
    'description', 'Leistung',
    'quantity', p_qty,
    'unit', p_unit,
    'unitPrice', p_price,
    'lineTotal', round(p_qty * p_price * 100) / 100
  );
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-000000000d01';
  auftrag constant jsonb := '{"customerId":"cust-1","customerBilling":{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"},"orderPositions":[{"id":"p1","description":"Monteurstunden","plannedQuantity":10,"unit":"Stunden","unitPrice":100,"billable":true}]}'::jsonb;
  r jsonb;
  n integer;
  v_num text;
  v_payload jsonb;
  v_version bigint;
  v_seq_nachher integer;
  v_summe numeric;
begin
  /* Zwei Auftraege: ein eigener Auftrag (AU-Nummer, §13b) und ein Bestandsvorgang. */
  perform public.create_workspace_order(ws, 'v-auftrag', jsonb_build_object(
    'customerId', 'cust-1',
    'customerBilling', auftrag->'customerBilling',
    'title', 'Montage',
    'baustelle', 'Weg 1',
    'taxStatus', 'standard_19',
    'paymentTermsText', '14 Tage',
    'positions', '[{"id":"p1","description":"Monteurstunden","plannedQuantity":10,"unit":"Stunden","unitPrice":100}]'::jsonb
  ));
  perform public.upsert_workspace_sync_entity(ws, 'vorgang', jsonb_build_object('vorgang_id','v-legacy','payload',
    '{"id":"v-legacy","title":"Werkvertrag","customer":"Muster GmbH","baustelle":"","status":"beauftragt","materialSource":"unclear","orderPositions":[{"id":"w1","description":"Leistung","plannedQuantity":5,"unit":"Stunden","unitPrice":80,"billable":true}]}'::jsonb), 0);

  /* 1/4/16: gueltige normale Rechnung ueber 4 von 10 Stunden (19 %). */
  r := public.finalize_workspace_invoice(ws, 'v-auftrag', 'inv-1',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 4, 100)), 400, 476));
  v_num := r->'row'->>'invoice_number';
  if (r->>'idempotent_replay')::boolean or v_num is null then raise exception '1: %', r; end if;
  if (r->'invoice'->>'amount')::numeric <> 476 then raise exception '16: Brutto %', r->'invoice'->>'amount'; end if;
  raise notice 'OK  1/4/16: normale Teilmenge 4/10, 19 %% korrekt (%)', v_num;

  /* 5: 6 + 6 auf 10 — die zweite Finalisierung sieht den neuen Stand. */
  r := public.finalize_workspace_invoice(ws, 'v-auftrag', 'inv-race-a',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 6, 100)), 600, 714));
  perform pg_temp.erwarte_fehler('5 zweites Geraet ueber denselben Rest',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-auftrag','inv-race-b', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 6, 100)), 600, 714))$q$,
    'invoice_quantity_exceeds_available');
  select count(*) into n from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-race-b';
  if n <> 0 then raise exception '5: abgewiesene Rechnung wurde gespeichert'; end if;
  raise notice 'OK  5: 4+6 verbraucht, zweite 6 abgewiesen — kein 12/10';

  /* 6: Rest 0 — eine weitere Menge ist nur mit Bestaetigung moeglich (E). */
  perform pg_temp.erwarte_fehler('6a Rest erschoepft',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-auftrag','inv-rest', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 1, 100)), 100, 119))$q$,
    'invoice_quantity_exceeds_available');
  r := public.finalize_workspace_invoice(ws, 'v-auftrag', 'inv-over',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 1, 100)), 100, 119), true);
  if (r->>'idempotent_replay')::boolean then raise exception '6b: %', r; end if;
  raise notice 'OK  6/E: Ueberschreitung nur mit ausdruecklicher Bestaetigung';

  /* 21/22: Idempotenz unveraendert. */
  r := public.finalize_workspace_invoice(ws, 'v-auftrag', 'inv-1',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 4, 100)), 400, 476));
  if not (r->>'idempotent_replay')::boolean or r->'row'->>'invoice_number' <> v_num then raise exception '21: Replay %', r; end if;
  perform pg_temp.erwarte_fehler('22 Replay mit anderem Inhalt',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-auftrag','inv-1', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 5, 100)), 500, 595))$q$,
    'Idempotenzkonflikt');
  raise notice 'OK  21/22: Replay gleich, Konflikt bei abweichendem Inhalt';

  /* 7: Storno gibt die Menge wieder frei. */
  update public.workspace_invoices set cancelled_at = now(), cancel_reason = 'Test'
  where workspace_id = ws and client_invoice_id in ('inv-race-a', 'inv-over');
  r := public.finalize_workspace_invoice(ws, 'v-auftrag', 'inv-nach-storno',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 6, 100)), 600, 714));
  if (r->>'idempotent_replay')::boolean then raise exception '7: %', r; end if;
  raise notice 'OK  7: stornierte Belege geben ihre Menge frei';

  /* 8/9: unbekannte und fremde Position. */
  perform pg_temp.erwarte_fehler('8 unbekannte Position',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-auftrag','inv-unknown', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p-gibt-es-nicht', 1, 100)), 100, 119))$q$,
    'invoice_position_not_found');
  perform pg_temp.erwarte_fehler('9 Position eines fremden Vorgangs',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-auftrag','inv-fremd', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('w1', 1, 80)), 80, 95.2))$q$,
    'invoice_position_not_found');

  /* 12/13: manipulierter Einzelpreis und manipulierte Summen. */
  perform pg_temp.erwarte_fehler('12 manipulierter Einzelpreis',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-legacy','inv-preis', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('w1', 1, 5)), 5, 5.95))$q$,
    'invoice_position_mismatch');
  perform pg_temp.erwarte_fehler('13 manipulierte Summe',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-legacy','inv-summe', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('w1', 1, 80)), 1, 1.19))$q$,
    'invoice_totals_mismatch');

  /* 14/15: Steuerstatus des Auftrags ist bindend; §13b rechnet ohne Steuer. */
  perform pg_temp.erwarte_fehler('14 abweichender Steuerstatus',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-auftrag','inv-steuer', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('p1', 1, 100)), 100, 100, 'reverse_charge_13b'))$q$,
    'invoice_tax_status_mismatch');
  perform public.create_workspace_order(ws, 'v-13b', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', '13b', 'baustelle', '',
    'taxStatus', 'reverse_charge_13b',
    'positions', '[{"id":"q1","description":"Leistung","plannedQuantity":10,"unit":"Stunden","unitPrice":100}]'::jsonb));
  r := public.finalize_workspace_invoice(ws, 'v-13b', 'inv-13b',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('q1', 3, 100)), 300, 300, 'reverse_charge_13b'));
  if (r->'invoice'->>'amount')::numeric <> 300 then raise exception '15: %', r->'invoice'->>'amount'; end if;
  perform pg_temp.erwarte_fehler('15b §13b mit Steuer gerechnet',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-13b','inv-13b-falsch', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('q1', 1, 100)), 100, 119, 'reverse_charge_13b'))$q$,
    'invoice_totals_mismatch');
  raise notice 'OK  12-15: Preis, Summen, Steuerstatus und §13b serverseitig geprueft';

  /* 17: Kleinunternehmer — keine Steuer. */
  perform public.create_workspace_order(ws, 'v-klein', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'klein', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"k1","description":"Leistung","plannedQuantity":4,"unit":"Stunden","unitPrice":50}]'::jsonb));
  r := public.finalize_workspace_invoice(ws, 'v-klein', 'inv-klein',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('k1', 2, 50)), 100, 100, 'kleinunternehmer_19'));
  if (r->'invoice'->>'amount')::numeric <> 100 then raise exception '17: %', r; end if;
  raise notice 'OK  17: Kleinunternehmer ohne Umsatzsteuer';

  /* 2/18: Abschlag mengenbasiert und pauschal. */
  perform public.create_workspace_order(ws, 'v-abschlag', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Abschlag', 'baustelle', '',
    'taxStatus', 'standard_19',
    'positions', '[{"id":"a1","description":"Leistung","plannedQuantity":10,"unit":"Stunden","unitPrice":100}]'::jsonb));
  r := public.finalize_workspace_invoice(ws, 'v-abschlag', 'inv-abschlag-menge',
    pg_temp.rechnung('abschlag', jsonb_build_array(pg_temp.zeile('a1', 2, 100)), 200, 238, 'standard_19',
      '{"calculationMode":"quantity_based","abschlagNumber":1}'::jsonb));
  if (r->>'idempotent_replay')::boolean then raise exception '2: %', r; end if;
  r := public.finalize_workspace_invoice(ws, 'v-abschlag', 'inv-abschlag-pauschal',
    pg_temp.rechnung('abschlag', '[]'::jsonb, 300, 357, 'standard_19',
      '{"calculationMode":"fixed_amount","fixedAmountNet":300,"abschlagNumber":2}'::jsonb));
  if (r->'invoice'->>'amount')::numeric <> 357 then raise exception '18: %', r; end if;
  perform pg_temp.erwarte_fehler('18b Pauschalabschlag mit falscher Summe',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-abschlag','inv-abschlag-falsch', pg_temp.rechnung('abschlag', '[]'::jsonb, 300, 100, 'standard_19', '{"calculationMode":"fixed_amount","fixedAmountNet":300,"abschlagNumber":3}'::jsonb))$q$,
    'invoice_totals_mismatch');
  perform pg_temp.erwarte_fehler('18c Pauschalabschlag ohne Betrag',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-abschlag','inv-abschlag-leer', pg_temp.rechnung('abschlag', '[]'::jsonb, 0, 0, 'standard_19', '{"calculationMode":"fixed_amount","fixedAmountNet":0,"abschlagNumber":3}'::jsonb))$q$,
    'invoice_fixed_amount_invalid');
  raise notice 'OK  2/18: Abschlag mengenbasiert und pauschal, Betrag geprueft';

  /* 3/19: Schlussrechnung mit Abschlagsabzug, weiterhin nur eine wirksame. */
  perform pg_temp.erwarte_fehler('3a Schlussrechnung ohne Abschlagsabzug',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-abschlag','inv-schluss-ohne', pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('a1', 8, 100)), 800, 952))$q$,
    'invoice_deductions_mismatch');
  -- 03B2: Nur der Pauschalabschlag wird monetaer abgezogen; der mengenbasierte
  -- Abschlag hat seine Leistung bereits ueber die Menge verbraucht.
  -- 8 x 100 = 800 netto, 952 brutto, abzueglich 357 -> 595 offen
  r := public.finalize_workspace_invoice(ws, 'v-abschlag', 'inv-schluss',
    pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('a1', 8, 100)), 800, 595, 'standard_19',
      '{"previousAbschlagDeductions":[{"invoiceId":"inv-abschlag-pauschal","amount":357}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric <> 595 then raise exception '3: %', r->'invoice'->>'amount'; end if;
  perform pg_temp.erwarte_fehler('19 zweite Schlussrechnung',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-abschlag','inv-schluss-2', pg_temp.rechnung('schluss', '[]'::jsonb, 0, 0, 'standard_19', '{"previousAbschlagDeductions":[{"invoiceId":"inv-abschlag-pauschal","amount":357}]}'::jsonb))$q$,
    'invoice_final_already_exists');
  raise notice 'OK  3/19: Schlussrechnung mit geprueften Abzuegen, weiterhin nur eine';

  /* 23/24: Bestandsvorgang ohne Auftragsnummer bleibt fakturierbar. */
  r := public.finalize_workspace_invoice(ws, 'v-legacy', 'inv-legacy',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('w1', 5, 80)), 400, 476));
  if (r->>'idempotent_replay')::boolean or r->'row'->>'invoice_number' is null then raise exception '23: %', r; end if;
  raise notice 'OK  23/24: Bestandsvorgang unveraendert fakturierbar';

  /* P: fremder Kundenname im Rechnungssnapshot. */
  perform pg_temp.erwarte_fehler('P fremder Kunde auf der Rechnung',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-13b','inv-fremdkunde', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('q1', 1, 100)), 100, 100, 'reverse_charge_13b') || '{"customerSnapshot":{"name":"Ganz anderer Kunde"}}'::jsonb)$q$,
    'invoice_customer_mismatch');

  /* R: ungueltige Menge. */
  perform pg_temp.erwarte_fehler('R negative Menge',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-13b','inv-negativ', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('q1', -1, 100)), -100, -100, 'reverse_charge_13b'))$q$,
    'invoice_quantity_invalid');
  raise notice 'OK  P/R: Kundenbeleg und ungueltige Mengen abgewiesen';

  /* 10/11: Nachtragspositionen — erst nach Bestaetigung und Uebernahme in den Plan. */
  perform public.create_workspace_order(ws, 'v-nachtrag', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Nachtrag', 'baustelle', '',
    'taxStatus', 'standard_19',
    'positions', '[{"id":"n1","description":"Leistung","plannedQuantity":2,"unit":"Stunden","unitPrice":100}]'::jsonb));
  -- 10: eine Zusatzposition, die im autoritativen Plan nicht steht
  perform pg_temp.erwarte_fehler('10 unbestaetigte Zusatzposition',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-nachtrag','inv-nachtrag-frueh', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('nX', 1, 150)), 150, 178.5))$q$,
    'invoice_position_not_found');
  -- 11: bestaetigter Nachtrag, in den Plan uebernommen -> abrechenbar
  perform public.confirm_workspace_order_amendment(ws, 'v-nachtrag', 'am-1',
    '{"title":"Nachtrag 1","positions":[{"id":"nX","changeType":"add","description":"Zusatz","plannedQuantity":1,"unit":"Stunden","unitPrice":150}]}'::jsonb);
  select v.payload, v.row_version into v_payload, v_version
  from public.workspace_vorgaenge v where v.workspace_id = ws and v.vorgang_id = 'v-nachtrag';
  perform public.upsert_workspace_sync_entity(ws, 'vorgang', jsonb_build_object('vorgang_id','v-nachtrag','payload',
    jsonb_set(v_payload, '{orderPositions}', (v_payload->'orderPositions') ||
      '[{"id":"nX","description":"Zusatz","plannedQuantity":1,"unit":"Stunden","unitPrice":150,"sourceAmendmentId":"am-1","sourceAmendmentSequence":1,"amendmentChangeType":"add"}]'::jsonb)), v_version);
  r := public.finalize_workspace_invoice(ws, 'v-nachtrag', 'inv-nachtrag',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('nX', 1, 150)), 150, 178.5));
  if (r->>'idempotent_replay')::boolean then raise exception '11: %', r; end if;
  raise notice 'OK  10/11: nur bestaetigte Nachtragspositionen sind abrechenbar';

  /* 20: Schlussrechnung mit veraltetem Nachtragsstand. */
  perform pg_temp.erwarte_fehler('20 veralteter Nachtragsstand',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-nachtrag','inv-nachtrag-schluss', pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('n1', 2, 100)), 200, 238, 'standard_19', '{"expectedAmendmentSequence":0}'::jsonb))$q$,
    'invoice_amendment_state_stale');
  raise notice 'OK  20: amendment-state-stale weiterhin wirksam';

  /* 25-28: Abwaertskompatibilitaet, Nummernkreis und korrigierter Retry. */
  perform public.create_workspace_order(ws, 'v-alt-client', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Alter Client', 'baustelle', '',
    'taxStatus', 'standard_19',
    'positions', '[{"id":"c1","description":"Leistung","plannedQuantity":10,"unit":"Stunden","unitPrice":100}]'::jsonb));
  select last_sequence into n from public.workspace_invoice_sequences where workspace_id = ws and invoice_year = 2026;

  -- 25: Aufruf im alten Vierargumentformat (ohne p_overbilling_acknowledged).
  r := public.finalize_workspace_invoice(ws, 'v-alt-client', 'inv-alt-1',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('c1', 6, 100)), 600, 714));
  if (r->>'idempotent_replay')::boolean or r->'row'->>'invoice_number' is null then raise exception '25: %', r; end if;

  -- 26: derselbe alte Aufruf mit Uebermenge -> fail closed, ohne Bestaetigung geht nichts.
  perform pg_temp.erwarte_fehler('26 alter Client mit Uebermenge',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-000000000d01','v-alt-client','inv-alt-2', pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('c1', 6, 100)), 600, 714))$q$,
    'invoice_quantity_exceeds_available');

  -- 27: Die Ablehnung hat keine Rechnungsnummer verbraucht.
  select last_sequence into v_seq_nachher from public.workspace_invoice_sequences where workspace_id = ws and invoice_year = 2026;
  if v_seq_nachher <> n + 1 then raise exception '27: Sequenz % -> % (eine gueltige Rechnung, eine Ablehnung)', n, v_seq_nachher; end if;
  select count(*) into n from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-alt-2';
  if n <> 0 then raise exception '27: abgewiesene Rechnung wurde gespeichert'; end if;

  -- 28: Der Nutzer korrigiert die Menge und nutzt dieselbe Kennung erneut — kein Idempotenzkonflikt.
  r := public.finalize_workspace_invoice(ws, 'v-alt-client', 'inv-alt-2',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('c1', 4, 100)), 400, 476));
  if (r->>'idempotent_replay')::boolean or (r->'invoice'->>'amount')::numeric <> 476 then raise exception '28: %', r; end if;
  -- und der Wiederholungslauf derselben korrigierten Rechnung bleibt ein Replay.
  r := public.finalize_workspace_invoice(ws, 'v-alt-client', 'inv-alt-2',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('c1', 4, 100)), 400, 476));
  if not (r->>'idempotent_replay')::boolean then raise exception '28b: %', r; end if;
  raise notice 'OK  25-28: alter Vierargumentaufruf, fail-closed, keine Nummer verbraucht, korrigierter Retry';

  /*
   * 29-33 (03B2): Ein Abschlag verbraucht entweder Menge oder Geld.
   * Alle Betraege ohne Umsatzsteuer (Kleinunternehmer), damit die Zahlen der
   * unabhaengigen Abnahme eins zu eins nachvollziehbar bleiben.
   */
  -- Fall A: Auftrag 2 x 5; mengenbasierter Abschlag 1 x 5; Schluss 1 x 5, kein Abzug.
  perform public.create_workspace_order(ws, 'v-fallA', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Fall A', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"fa1","description":"Leistung","plannedQuantity":2,"unit":"Stück","unitPrice":5}]'::jsonb));
  r := public.finalize_workspace_invoice(ws, 'v-fallA', 'inv-fa-ab',
    pg_temp.rechnung('abschlag', jsonb_build_array(pg_temp.zeile('fa1', 1, 5, 'Stück')), 5, 5, 'kleinunternehmer_19',
      '{"calculationMode":"quantity_based","abschlagNumber":1}'::jsonb));
  if public.workspace_invoice_abschlag_deductions(ws, 'v-fallA', null) <> 0 then
    raise exception '29: mengenbasierter Abschlag wurde als Abzug gezaehlt (%)', public.workspace_invoice_abschlag_deductions(ws, 'v-fallA', null);
  end if;
  r := public.finalize_workspace_invoice(ws, 'v-fallA', 'inv-fa-schluss',
    pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('fa1', 1, 5, 'Stück')), 5, 5, 'kleinunternehmer_19'));
  if (r->'invoice'->>'amount')::numeric <> 5 then raise exception '29: Restbetrag % statt 5', r->'invoice'->>'amount'; end if;
  raise notice 'OK  29 (Fall A): mengenbasierter Abschlag ohne zweiten Geldabzug — 5 + 5 = 10';

  -- Fall B: Pauschalabschlag 20 bleibt monetaerer Abzug.
  perform public.create_workspace_order(ws, 'v-fallB', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Fall B', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"fb1","description":"Leistung","plannedQuantity":10,"unit":"Stück","unitPrice":10}]'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-fallB', 'inv-fb-ab',
    pg_temp.rechnung('abschlag', '[]'::jsonb, 20, 20, 'kleinunternehmer_19',
      '{"calculationMode":"fixed_amount","fixedAmountNet":20,"abschlagNumber":1}'::jsonb));
  if public.workspace_invoice_abschlag_deductions(ws, 'v-fallB', null) <> 20 then
    raise exception '30: Abzug %', public.workspace_invoice_abschlag_deductions(ws, 'v-fallB', null);
  end if;
  r := public.finalize_workspace_invoice(ws, 'v-fallB', 'inv-fb-schluss',
    pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('fb1', 10, 10, 'Stück')), 100, 80, 'kleinunternehmer_19',
      '{"previousAbschlagDeductions":[{"invoiceId":"inv-fb-ab","amount":20}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric <> 80 then raise exception '30: %', r->'invoice'->>'amount'; end if;
  raise notice 'OK  30 (Fall B): Pauschalabschlag weiterhin monetaer — 100 - 20 = 80';

  -- Fall C: gemischt — 110 Auftragswert, 5 mengenbasiert, 20 pauschal, Schluss 105 - 20 = 85.
  perform public.create_workspace_order(ws, 'v-fallC', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Fall C', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"fc1","description":"Leistung","plannedQuantity":22,"unit":"Stück","unitPrice":5}]'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-fallC', 'inv-fc-menge',
    pg_temp.rechnung('abschlag', jsonb_build_array(pg_temp.zeile('fc1', 1, 5, 'Stück')), 5, 5, 'kleinunternehmer_19',
      '{"calculationMode":"quantity_based","abschlagNumber":1}'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-fallC', 'inv-fc-pauschal',
    pg_temp.rechnung('abschlag', '[]'::jsonb, 20, 20, 'kleinunternehmer_19',
      '{"calculationMode":"fixed_amount","fixedAmountNet":20,"abschlagNumber":2}'::jsonb));
  if public.workspace_invoice_abschlag_deductions(ws, 'v-fallC', null) <> 20 then
    raise exception '31: Abzug %', public.workspace_invoice_abschlag_deductions(ws, 'v-fallC', null);
  end if;
  r := public.finalize_workspace_invoice(ws, 'v-fallC', 'inv-fc-schluss',
    pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('fc1', 21, 5, 'Stück')), 105, 85, 'kleinunternehmer_19',
      '{"previousAbschlagDeductions":[{"invoiceId":"inv-fc-pauschal","amount":20}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric <> 85 then raise exception '31: %', r->'invoice'->>'amount'; end if;
  raise notice 'OK  31 (Fall C): gemischt — 5 + 20 + 85 = 110';

  -- 32: Storno. Ein stornierter Abschlag wirkt weder mengen- noch geldseitig.
  update public.workspace_invoices set cancelled_at = now(), cancel_reason = 'Test'
  where workspace_id = ws and client_invoice_id in ('inv-fc-menge', 'inv-fc-pauschal');
  if public.workspace_invoice_abschlag_deductions(ws, 'v-fallC', null) <> 0 then
    raise exception '32: stornierter Pauschalabschlag zaehlt noch';
  end if;
  if public.workspace_invoice_billed_quantity(ws, 'v-fallC', 'fc1', 'inv-fc-schluss') <> 0 then
    raise exception '32: stornierter mengenbasierter Abschlag verbraucht noch Menge (%)',
      public.workspace_invoice_billed_quantity(ws, 'v-fallC', 'fc1', 'inv-fc-schluss');
  end if;
  raise notice 'OK  32: Storno nimmt beiden Abschlagsarten ihre Wirkung';

  -- Fall D: normale Rechnung 100 + mengenbasierter Abschlag 5 + Schluss 5 = 110.
  perform public.create_workspace_order(ws, 'v-fallD', jsonb_build_object(
    'customerId', 'cust-1', 'customerBilling', auftrag->'customerBilling', 'title', 'Fall D', 'baustelle', '',
    'taxStatus', 'kleinunternehmer_19',
    'positions', '[{"id":"fd1","description":"Leistung","plannedQuantity":22,"unit":"Stück","unitPrice":5}]'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-fallD', 'inv-fd-normal',
    pg_temp.rechnung('rechnung', jsonb_build_array(pg_temp.zeile('fd1', 20, 5, 'Stück')), 100, 100, 'kleinunternehmer_19'));
  perform public.finalize_workspace_invoice(ws, 'v-fallD', 'inv-fd-ab',
    pg_temp.rechnung('abschlag', jsonb_build_array(pg_temp.zeile('fd1', 1, 5, 'Stück')), 5, 5, 'kleinunternehmer_19',
      '{"calculationMode":"quantity_based","abschlagNumber":1}'::jsonb));
  r := public.finalize_workspace_invoice(ws, 'v-fallD', 'inv-fd-schluss',
    pg_temp.rechnung('schluss', jsonb_build_array(pg_temp.zeile('fd1', 1, 5, 'Stück')), 5, 5, 'kleinunternehmer_19'));
  if (r->'invoice'->>'amount')::numeric <> 5 then raise exception '33: %', r->'invoice'->>'amount'; end if;
  select coalesce(sum((payload->>'amount')::numeric), 0) into v_summe
  from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-fallD' and cancelled_at is null;
  if v_summe <> 110 then raise exception '33: Gesamtsumme % statt 110 (Auftragswert)', v_summe; end if;
  raise notice 'OK  33 (Fall D): 100 + 5 + 5 = 110 — genau der Auftragswert';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
