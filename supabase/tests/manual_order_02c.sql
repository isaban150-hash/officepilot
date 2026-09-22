-- AUFTRAG-02C — Laufzeit-Regressionstest fuer create_workspace_order und den
-- auf `order_number` umgestellten Freeze-Guard im generischen Upsert.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/manual_order_02c.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000ac02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'manual-order-test@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000000c01', 'Auftrag-02C', '00000000-0000-0000-0000-00000000ac02'),
       ('00000000-0000-0000-0000-000000000c02', 'Fremd', '00000000-0000-0000-0000-00000000ac02');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-00000000ac02', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-000000000c01', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb),
       ('00000000-0000-0000-0000-000000000c02', 'cust-fremd', '{"id":"cust-fremd","name":"Fremd GmbH"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ac02","role":"authenticated"}', true);

create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% — falscher Fehler: %', p_label, sqlerrm;
    end if;
    raise notice 'OK  %: %', p_label, sqlerrm;
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-000000000c01';
  kunde constant jsonb := '{"name":"Muster GmbH","contactPerson":"Frau Muster","street":"Weg 1","zip":"33602","city":"Bielefeld","email":"k@example.invalid","phone":""}'::jsonb;
  auftrag constant jsonb := jsonb_build_object(
    'customerId', 'cust-1',
    'customerBilling', '{"name":"Muster GmbH","contactPerson":"Frau Muster","street":"Weg 1","zip":"33602","city":"Bielefeld","email":"k@example.invalid","phone":""}'::jsonb,
    'title', 'Heizung Erdgeschoss',
    'baustelle', 'Weg 1, Bielefeld',
    'taxStatus', 'standard_19',
    'paymentTermsText', 'Zahlbar innerhalb von 14 Tagen.',
    'introText', 'Wie besprochen.',
    'closingText', 'Vielen Dank.',
    'positions', '[{"id":"p1","description":"Demontage","plannedQuantity":4,"unit":"Stunden","unitPrice":55},
                   {"id":"p2","description":"Fliesen","plannedQuantity":12.5,"unit":"m²","unitPrice":48.9}]'::jsonb
  );
  angebot constant jsonb := '{"customer":{"name":"Muster GmbH","contactPerson":"","street":"Weg 1","zip":"33602","city":"Bielefeld","email":"k@example.invalid","phone":""},"customerId":"cust-1","title":"Aus Angebot","baustelle":"Weg 1","offerDate":"2026-09-22","validUntil":"2026-10-22","positions":[{"id":"q1","description":"Leistung","quantity":2,"unit":"Stunden","unitPrice":50}],"taxStatus":"standard_19","totals":{"subtotal":100,"taxRate":19,"tax":19,"total":119},"createdAt":"2026-09-22T10:00:00.000Z"}'::jsonb;
  r jsonb;
  r2 jsonb;
  v jsonb;
  v_row public.workspace_vorgaenge;
  n integer;
  t jsonb;
begin
  /* 1-8: manueller Auftrag, Nummer, Herkunft, Status, Snapshot, Summen */
  r := public.create_workspace_order(ws, 'v-m1', auftrag);
  v := r->'vorgang';
  if (r->>'replayed')::boolean then raise exception '1: unerwartet Replay'; end if;
  if v->>'order_number' <> 'AU-2026-0001' then raise exception '2: Nummer %', v->>'order_number'; end if;
  if v->>'source_offer_id' is not null or v->'payload' ? 'sourceOfferId' or v->'payload' ? 'sourceOfferNumber' then raise exception '4: Herkunft gesetzt %', v; end if;
  if v->'payload'->>'status' <> 'beauftragt' then raise exception '5: Status %', v->'payload'->>'status'; end if;
  if (v->'payload'->'contractConfirmation'->>'immutable')::boolean is not true
     or (v->'payload'->'contractConfirmation'->'negotiation'->>'conducted')::boolean is not false
     or jsonb_array_length(v->'payload'->'contractConfirmation'->'positions') <> 2 then raise exception '6: Snapshot %', v->'payload'->'contractConfirmation'; end if;
  if v->'payload'->>'orderNumber' <> 'AU-2026-0001' or v->'payload'->>'orderDate' is null
     or v->'payload'->>'taxStatus' <> 'standard_19'
     or v->'payload'->>'paymentTermsText' <> 'Zahlbar innerhalb von 14 Tagen.'
     or v->'payload'->'customerBilling'->>'street' <> 'Weg 1'
     or v->'payload'->>'customerId' <> 'cust-1' then raise exception '5b: Payload %', v->'payload'; end if;
  -- 7/8: 4×55 + 12,5×48,9 = 831,25 netto; 19 % = 157,94; brutto 989,19 (wie der Client rechnet)
  t := v->'payload'->'contractTotals';
  if (t->>'subtotal')::numeric <> 831.25 or (t->>'taxRate')::numeric <> 19 or (t->>'tax')::numeric <> 157.94 or (t->>'total')::numeric <> 989.19 then
    raise exception '7/8: Summen %', t;
  end if;
  raise notice 'OK  1-8: manueller Auftrag AU-2026-0001, beauftragt, Snapshot, Summen serverseitig';

  /* 9: §13b — keine Steuer, brutto = netto */
  r := public.create_workspace_order(ws, 'v-m2', auftrag || '{"taxStatus":"reverse_charge_13b","title":"13b-Auftrag"}'::jsonb);
  t := r->'vorgang'->'payload'->'contractTotals';
  if (t->>'taxRate')::numeric <> 0 or (t->>'tax')::numeric <> 0 or (t->>'total')::numeric <> 831.25
     or r->'vorgang'->'payload'->>'taxStatus' <> 'reverse_charge_13b' then raise exception '9: 13b %', t; end if;
  /* 25: zwei manuelle Auftraege, zwei Nummern */
  if r->'vorgang'->>'order_number' <> 'AU-2026-0002' then raise exception '25: %', r->'vorgang'->>'order_number'; end if;
  raise notice 'OK  9/25: §13b ohne Steuer, zweiter Auftrag AU-2026-0002';

  /* 3: gemeinsame Sequenz mit Auftraegen aus Angebot */
  perform public.finalize_workspace_offer(ws, 'o-1', angebot || '{"id":"o-1"}', 'fp-c1', 0);
  r := public.accept_workspace_offer(ws, 'o-1', 'v-ausangebot', 0);
  if r->'vorgang'->>'order_number' <> 'AU-2026-0003' then raise exception '3: Sequenz %', r->'vorgang'->>'order_number'; end if;
  raise notice 'OK  3: Angebotsauftrag setzt dieselbe Sequenz fort (AU-2026-0003)';

  /* 10-12: Replay */
  r2 := public.create_workspace_order(ws, 'v-m1', auftrag);
  if not (r2->>'replayed')::boolean or r2->'vorgang'->>'order_number' <> 'AU-2026-0001' then raise exception '10: Replay %', r2; end if;
  select last_sequence into n from public.workspace_order_sequences where workspace_id = ws;
  if n <> 3 then raise exception '11: Sequenz %', n; end if;
  -- 12: veraenderter Entwurf darf den bestaetigten Auftrag nicht ueberschreiben
  r2 := public.create_workspace_order(ws, 'v-m1', auftrag || '{"title":"Nachtraeglich geaendert","taxStatus":"tax_free"}'::jsonb);
  if r2->'vorgang'->'payload'->>'title' <> 'Heizung Erdgeschoss' or r2->'vorgang'->'payload'->>'taxStatus' <> 'standard_19'
     or (r2->'vorgang'->>'row_version')::bigint <> 1 then raise exception '12: Replay hat ueberschrieben %', r2->'vorgang'->'payload'; end if;
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws;
  if n <> 3 then raise exception '10-12: % Vorgaenge', n; end if;
  raise notice 'OK  10-12: Replay ohne zweite Nummer, ohne Ueberschreiben';

  /* 13/14: Kennungskollision ist kein Replay */
  perform public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag","customer":"k","baustelle":"","status":"eingegangen","materialSource":"unclear","orderPositions":[]}}'::jsonb,0);
  perform pg_temp.erwarte_fehler('13 Kollision mit Bestandsvorgang',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-alt', %L::jsonb)$q$, auftrag::text),
    'Vorgangskennung bereits vergeben');
  perform pg_temp.erwarte_fehler('14 Kollision mit Auftrag aus Angebot',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-ausangebot', %L::jsonb)$q$, auftrag::text),
    'Vorgangskennung bereits vergeben');

  /* 15/16: fremder Workspace, fremder Kunde */
  perform pg_temp.erwarte_fehler('15 Fremdworkspace',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c02','v-fremd', %L::jsonb)$q$, auftrag::text),
    'Kein Zugriff');
  perform pg_temp.erwarte_fehler('16 fremde customerId',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-m9', %L::jsonb)$q$, (auftrag || '{"customerId":"cust-fremd"}'::jsonb)::text),
    'gehoert nicht zu diesem Arbeitsbereich');
  -- Eingaben, die der Server nicht annimmt
  perform pg_temp.erwarte_fehler('16b ohne Positionen',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-m9', %L::jsonb)$q$, (auftrag || '{"positions":[]}'::jsonb)::text),
    'ohne Positionen');
  perform pg_temp.erwarte_fehler('16c Menge 0',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-m9', %L::jsonb)$q$, (auftrag || '{"positions":[{"id":"p1","description":"x","plannedQuantity":0,"unit":"Stunden","unitPrice":5}]}'::jsonb)::text),
    'ungueltige Mengen');
  perform pg_temp.erwarte_fehler('16d doppelte Positionskennung',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-m9', %L::jsonb)$q$, (auftrag || '{"positions":[{"id":"p1","description":"x","plannedQuantity":1,"unit":"Stunden","unitPrice":5},{"id":"p1","description":"y","plannedQuantity":1,"unit":"Stunden","unitPrice":5}]}'::jsonb)::text),
    'Doppelte Positionskennung');
  perform pg_temp.erwarte_fehler('16e unbekannter Steuerstatus',
    format($q$select public.create_workspace_order('00000000-0000-0000-0000-000000000c01','v-m9', %L::jsonb)$q$, (auftrag || '{"taxStatus":"phantasie"}'::jsonb)::text),
    'unbekannter Steuerstatus');
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws;
  if n <> 4 then raise exception '13-16: abgewiesene Aufrufe haben Zeilen erzeugt (%)', n; end if;

  /* 17: Auftragsnummer nicht ueber den generischen Upsert */
  perform pg_temp.erwarte_fehler('17 orderNumber per Upsert',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag","customer":"k","baustelle":"","status":"eingegangen","materialSource":"unclear","orderPositions":[],"orderNumber":"AU-2026-0777"}}'::jsonb,1)$q$,
    'nur ueber accept_workspace_offer oder create_workspace_order');
  perform pg_temp.erwarte_fehler('17b neuer Vorgang mit orderNumber',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang','{"vorgang_id":"v-neu","payload":{"id":"v-neu","title":"x","customer":"k","baustelle":"","status":"eingegangen","materialSource":"unclear","orderPositions":[],"orderNumber":"AU-2026-0778"}}'::jsonb,0)$q$,
    'nur ueber accept_workspace_offer oder create_workspace_order');

  /* 18: Snapshot-Felder des manuellen Auftrags write-once */
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-m1';
  perform pg_temp.erwarte_fehler('18 taxStatus aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', %L::jsonb || '{"taxStatus":"reverse_charge_13b"}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('18 customerBilling aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', %L::jsonb || '{"customerBilling":{"name":"Anderer Kunde"}}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('18 contractTotals aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', %L::jsonb || '{"contractTotals":{"subtotal":1,"taxRate":19,"tax":0,"total":1}}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('18 orderNumber aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', %L::jsonb || '{"orderNumber":"AU-2026-0555"}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'koennen nicht geaendert werden');
  perform pg_temp.erwarte_fehler('18 sourceOfferId nachtraeglich setzen',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', %L::jsonb || '{"sourceOfferId":"o-1"}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'koennen nicht geaendert werden');

  /* 19/20: Positionen festgeschrieben, executedQuantity frei */
  perform pg_temp.erwarte_fehler('19 unitPrice aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', jsonb_set(%L::jsonb, '{orderPositions,0,unitPrice}', '99'::jsonb)), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('19 Position entfernen',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', jsonb_set(%L::jsonb, '{orderPositions}', (%L::jsonb->'orderPositions') - 0)), %s)$q$, v_row.payload::text, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('22 fremde Zusatzposition ohne Nachtrag',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', jsonb_set(%L::jsonb, '{orderPositions}', (%L::jsonb->'orderPositions') || '[{"id":"p-fremd","description":"Extra","plannedQuantity":1,"unit":"Pauschal","unitPrice":500,"billable":true}]'::jsonb)), %s)$q$, v_row.payload::text, v_row.payload::text, v_row.row_version),
    'nur ueber bestaetigten Nachtrag');
  r := public.upsert_workspace_sync_entity(ws,'vorgang', jsonb_build_object('vorgang_id','v-m1','payload', jsonb_set(v_row.payload, '{orderPositions,0,executedQuantity}', '3'::jsonb) || '{"status":"in_bearbeitung"}'::jsonb), v_row.row_version);
  if (r->'payload'->'payload'->'orderPositions'->0->>'executedQuantity')::numeric <> 3
     or r->'payload'->'payload'->>'status' <> 'in_bearbeitung'
     or r->'payload'->'payload'->>'orderNumber' <> 'AU-2026-0001' then raise exception '20: %', r; end if;
  raise notice 'OK  17-20/22: manueller Auftrag serverseitig festgeschrieben, Ausfuehrung und Status frei';

  /* 21: bestehender Nachtragsweg funktioniert beim manuellen Auftrag */
  r := public.confirm_workspace_order_amendment(ws, 'v-m1', 'am-c1',
    '{"title":"Nachtrag 1","positions":[{"id":"pN","changeType":"add","description":"Zusatzleistung","plannedQuantity":2,"unit":"Stunden","unitPrice":60}]}'::jsonb);
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-m1';
  r := public.upsert_workspace_sync_entity(ws,'vorgang', jsonb_build_object('vorgang_id','v-m1','payload',
    jsonb_set(v_row.payload, '{orderPositions}', (v_row.payload->'orderPositions') ||
      '[{"id":"pN","description":"Zusatzleistung","plannedQuantity":2,"unit":"Stunden","unitPrice":60,"sourceAmendmentId":"am-c1","sourceAmendmentSequence":1,"amendmentChangeType":"add"}]'::jsonb)), v_row.row_version);
  if jsonb_array_length(r->'payload'->'payload'->'orderPositions') <> 3 then raise exception '21: %', r; end if;
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-m1';
  perform pg_temp.erwarte_fehler('21b Nachtragsposition mit anderem Preis',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000c01','vorgang', jsonb_build_object('vorgang_id','v-m1','payload', jsonb_set(%L::jsonb, '{orderPositions,2,unitPrice}', '1'::jsonb)), %s)$q$, v_row.payload::text, v_row.row_version),
    'weicht vom bestaetigten Nachtrag ab');
  raise notice 'OK  21/22: bestehender Nachtragsweg erweitert den manuellen Auftrag, nur mit bestaetigten Werten';

  /* 23/24: Bestandsvorgaenge unveraendert */
  r := public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag geaendert","customer":"k2","baustelle":"","status":"in_pruefung","materialSource":"unclear","orderPositions":[{"id":"w1","description":"frei","plannedQuantity":1,"unit":"Pauschal","unitPrice":10}]}}'::jsonb,1);
  if r->'payload'->'payload'->>'title' <> 'Werkvertrag geaendert' or jsonb_array_length(r->'payload'->'payload'->'orderPositions') <> 1 then raise exception '23: %', r; end if;
  -- 24: Werkvertrag MIT eingefrorenem contractConfirmation, aber ohne Auftragsnummer: Plan bleibt frei
  perform public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-werk","payload":{"id":"v-werk","title":"Werkvertrag","customer":"k","baustelle":"","status":"beauftragt","materialSource":"unclear","orderPositions":[{"id":"x1","description":"Leistung","plannedQuantity":1,"unit":"Pauschal","unitPrice":100}],"contractConfirmation":{"id":"conf-werk","confirmedAt":"2026-09-22T10:00:00.000Z","customer":"k","auftraggeber":"k","baustelle":"","title":"Werkvertrag","positions":[{"id":"x1","description":"Leistung","plannedQuantity":1,"unit":"Pauschal","unitPrice":100}],"negotiation":{"conducted":true,"notes":[],"generalHints":[],"priceProposals":[],"positionProposals":[],"drafts":[]},"immutable":true}}}'::jsonb,0);
  r := public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-werk","payload":{"id":"v-werk","title":"Werkvertrag","customer":"k","baustelle":"","status":"beauftragt","materialSource":"unclear","orderPositions":[{"id":"x1","description":"Leistung","plannedQuantity":2,"unit":"Pauschal","unitPrice":120}],"contractConfirmation":{"id":"conf-werk","confirmedAt":"2026-09-22T10:00:00.000Z","customer":"k","auftraggeber":"k","baustelle":"","title":"Werkvertrag","positions":[{"id":"x1","description":"Leistung","plannedQuantity":1,"unit":"Pauschal","unitPrice":100}],"negotiation":{"conducted":true,"notes":[],"generalHints":[],"priceProposals":[],"positionProposals":[],"drafts":[]},"immutable":true}}}'::jsonb,1);
  if (r->'payload'->'payload'->'orderPositions'->0->>'unitPrice')::numeric <> 120 then raise exception '24: Werkvertragsflow regressiert %', r; end if;
  raise notice 'OK  23/24: Bestandsvorgaenge ohne Auftragsnummer unveraendert (auch mit Snapshot)';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
