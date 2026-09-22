-- ANGEBOT->AUFTRAG-02B — Laufzeit-Regressionstest fuer accept_workspace_offer
-- und die Auftrags-Guards im generischen Upsert.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/order_from_offer_02b.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000ab02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'order-test@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000000b01', 'Auftrag-Test', '00000000-0000-0000-0000-00000000ab02'),
       ('00000000-0000-0000-0000-000000000b02', 'Fremd', '00000000-0000-0000-0000-00000000ab02');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-00000000ab02', 'owner', 'active');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000ab02","role":"authenticated"}', true);

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
  ws constant uuid := '00000000-0000-0000-0000-000000000b01';
  basis constant jsonb := '{"customer":{"name":"Muster GmbH","contactPerson":"","street":"Weg 1","zip":"33602","city":"Bielefeld","email":"k@example.invalid","phone":""},"customerId":"cust-1","title":"Bad EG","baustelle":"Weg 1","offerDate":"2026-09-21","validUntil":"2026-10-21","positions":[{"id":"p1","description":"Demontage","quantity":4,"unit":"Stunden","unitPrice":55},{"id":"p2","description":"Fliesen","quantity":12.5,"unit":"m²","unitPrice":48.9},{"id":"p0","description":"leer","quantity":0,"unit":"Stück","unitPrice":9}],"taxStatus":"reverse_charge_13b","introText":"Hallo","closingText":"Danke","paymentTermsText":"14 Tage","totals":{"subtotal":866.25,"taxRate":0,"tax":0,"total":866.25},"createdAt":"2026-09-21T10:00:00.000Z"}'::jsonb;
  r jsonb;
  r2 jsonb;
  o jsonb;
  v jsonb;
  v_row public.workspace_vorgaenge;
  v_ver bigint;
  n integer;
begin
  /* Angebote freigeben */
  perform public.finalize_workspace_offer(ws, 'o-1', basis || '{"id":"o-1"}', 'fp-1', 0);
  perform public.finalize_workspace_offer(ws, 'o-2', basis || '{"id":"o-2","title":"Zweites"}', 'fp-2', 0);
  perform public.finalize_workspace_offer(ws, 'o-3', basis || '{"id":"o-3","title":"Abgelehnt"}', 'fp-3', 0);
  perform public.finalize_workspace_offer(ws, 'o-4', basis || '{"id":"o-4","title":"Storniert"}', 'fp-4', 0);
  -- o-3 abgelehnt, o-4 storniert (ueber den generischen Upsert, erlaubte Uebergaenge)
  perform public.upsert_workspace_sync_entity(ws, 'offer', jsonb_build_object('offer_id','o-3','status','abgelehnt','payload',(select payload || '{"status":"abgelehnt"}'::jsonb from public.workspace_offers where client_offer_id='o-3')), 2);
  perform public.upsert_workspace_sync_entity(ws, 'offer', jsonb_build_object('offer_id','o-4','status','storniert','payload',(select payload || '{"status":"storniert"}'::jsonb from public.workspace_offers where client_offer_id='o-4')), 2);
  -- ein Entwurf
  perform public.upsert_workspace_sync_entity(ws, 'offer', '{"offer_id":"o-5","status":"entwurf","payload":{"id":"o-5","status":"entwurf"}}'::jsonb, 0);

  /* 1-5: Annahme */
  r := public.accept_workspace_offer(ws, 'o-1', 'v-1', 0);
  o := r->'offer'; v := r->'vorgang';
  if (r->>'replayed')::boolean then raise exception '1: unerwartet Replay'; end if;
  if v->>'order_number' <> 'AU-2026-0001' then raise exception '2: Nummer %', v->>'order_number'; end if;
  if o->>'status' <> 'angenommen' then raise exception '3: Status %', o->>'status'; end if;
  if o->'payload'->>'resultingVorgangId' <> 'v-1' then raise exception '4: resultingVorgangId %', o->'payload'->>'resultingVorgangId'; end if;
  if v->>'source_offer_id' <> 'o-1' or v->'payload'->>'sourceOfferId' <> 'o-1' or v->'payload'->>'sourceOfferNumber' <> 'AN-2026-0001' then raise exception '5: sourceOffer %', v; end if;
  if v->'payload'->>'status' <> 'beauftragt' or v->'payload'->>'taxStatus' <> 'reverse_charge_13b' or v->'payload'->>'orderNumber' <> 'AU-2026-0001' then raise exception '5b: Payload %', v->'payload'; end if;
  if jsonb_array_length(v->'payload'->'orderPositions') <> 2 or jsonb_array_length(v->'payload'->'contractConfirmation'->'positions') <> 2 then raise exception '5c: Positionen (Menge 0 ausgeschlossen)'; end if;
  if (v->'payload'->'contractConfirmation'->>'immutable')::boolean is not true or (v->'payload'->'contractConfirmation'->'negotiation'->>'conducted')::boolean is not false then raise exception '5d: Snapshot'; end if;
  raise notice 'OK  1-5: Annahme, AU-2026-0001, angenommen, Referenzen, Snapshot';

  /* 6: bidirektionale Invariante */
  select count(*) into n from public.workspace_offers oo join public.workspace_vorgaenge vv
    on vv.workspace_id = oo.workspace_id and vv.vorgang_id = oo.payload->>'resultingVorgangId' and vv.source_offer_id = oo.client_offer_id
    where oo.workspace_id = ws and oo.status = 'angenommen';
  if n <> 1 then raise exception '6: Invariante verletzt (%)', n; end if;
  raise notice 'OK  6: Offer<->Vorgang beidseitig konsistent';

  /* 7-9: Replay, auch mit anderer Client-Vorgangskennung */
  r2 := public.accept_workspace_offer(ws, 'o-1', 'v-1', 0);
  if not (r2->>'replayed')::boolean or r2->'vorgang'->>'vorgang_id' <> 'v-1' then raise exception '7: Replay'; end if;
  r2 := public.accept_workspace_offer(ws, 'o-1', 'v-anders', 0);
  if not (r2->>'replayed')::boolean or r2->'vorgang'->>'vorgang_id' <> 'v-1' or r2->'vorgang'->>'order_number' <> 'AU-2026-0001' then raise exception '9: Retry mit anderer Kennung'; end if;
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws; if n <> 1 then raise exception '8: % Vorgaenge', n; end if;
  select last_sequence into n from public.workspace_order_sequences where workspace_id = ws; if n <> 1 then raise exception '8: Sequenz %', n; end if;
  raise notice 'OK  7-9: Replay ohne zweiten Auftrag / zweite Nummer, auch bei anderer Vorgangskennung';

  /* 10: zwei Annahmen desselben Offers (Unique-Index als zweite Verteidigung) */
  perform pg_temp.erwarte_fehler('10 direkter Insert mit gleicher Herkunft',
    $q$insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload, source_offer_id, order_number) values ('00000000-0000-0000-0000-000000000b01','v-dup','{}'::jsonb,'o-1','AU-2026-0099')$q$,
    'duplicate key');

  /* 11: anderes Angebot bekommt eigenen Auftrag */
  r := public.accept_workspace_offer(ws, 'o-2', 'v-2', 0);
  if r->'vorgang'->>'order_number' <> 'AU-2026-0002' then raise exception '11: %', r->'vorgang'->>'order_number'; end if;
  raise notice 'OK  11: zweites Angebot -> AU-2026-0002';

  /* 12: sourceOfferId nicht ueber generischen Upsert setzbar (neu und bestehend) */
  perform pg_temp.erwarte_fehler('12a neu mit sourceOfferId',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang','{"vorgang_id":"v-x","payload":{"id":"v-x","title":"x","customer":"k","baustelle":"","status":"eingegangen","materialSource":"unclear","orderPositions":[],"sourceOfferId":"o-2"}}'::jsonb,0)$q$,
    'nur ueber accept_workspace_offer');
  perform public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag","customer":"k","baustelle":"","status":"eingegangen","materialSource":"unclear","orderPositions":[]}}'::jsonb,0);
  perform pg_temp.erwarte_fehler('12b bestehend ohne Auftrag bekommt orderNumber',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag","customer":"k","baustelle":"","status":"eingegangen","materialSource":"unclear","orderPositions":[],"orderNumber":"AU-2026-0777"}}'::jsonb,1)$q$,
    'nur ueber accept_workspace_offer');

  /* 13: sourceOfferId / orderNumber nicht wechselbar */
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-1';
  perform pg_temp.erwarte_fehler('13 Herkunft wechseln',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', %L::jsonb || '{"sourceOfferId":"o-2"}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'koennen nicht geaendert werden');
  perform pg_temp.erwarte_fehler('13 Nummer wechseln',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', %L::jsonb || '{"orderNumber":"AU-2026-0555"}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'koennen nicht geaendert werden');

  /* 14: Snapshot-Felder write-once; erlaubte Aenderung (Status/Ausfuehrungsstart) bleibt moeglich */
  perform pg_temp.erwarte_fehler('14 taxStatus aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', %L::jsonb || '{"taxStatus":"standard_19"}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'festgeschrieben');
  perform pg_temp.erwarte_fehler('14 contractConfirmation aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', %L::jsonb || '{"contractConfirmation":{"id":"x","immutable":true}}'::jsonb), %s)$q$, v_row.payload::text, v_row.row_version),
    'festgeschrieben');
  r := public.upsert_workspace_sync_entity(ws,'vorgang', jsonb_build_object('vorgang_id','v-1','payload', v_row.payload || '{"status":"in_bearbeitung","executionStartedAt":"2026-09-22T08:00:00.000Z"}'::jsonb), v_row.row_version);
  if r->'payload'->'payload'->>'orderNumber' <> 'AU-2026-0001' or r->'payload'->'payload'->>'status' <> 'in_bearbeitung' then raise exception '14: erlaubter Statuswechsel %', r; end if;
  raise notice 'OK  12-14: Herkunft/Nummer/Snapshot serverseitig geschuetzt, normaler Statuswechsel moeglich';

  /* 15: abgelehnt/storniert/Entwurf nicht annehmbar; Annahme/resultingVorgangId nicht ueber Upsert */
  perform pg_temp.erwarte_fehler('15 abgelehnt', $q$select public.accept_workspace_offer('00000000-0000-0000-0000-000000000b01','o-3','v-3',0)$q$, 'nicht angenommen werden');
  perform pg_temp.erwarte_fehler('15 storniert', $q$select public.accept_workspace_offer('00000000-0000-0000-0000-000000000b01','o-4','v-4',0)$q$, 'nicht angenommen werden');
  perform pg_temp.erwarte_fehler('15 entwurf',   $q$select public.accept_workspace_offer('00000000-0000-0000-0000-000000000b01','o-5','v-5',0)$q$, 'nicht angenommen werden');
  select row_version into v_ver from public.workspace_offers where workspace_id = ws and client_offer_id = 'o-2';
  perform pg_temp.erwarte_fehler('15 angenommen per Upsert (o-3 abgelehnt -> angenommen)',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','offer', jsonb_build_object('offer_id','o-3','status','angenommen','payload', (select payload || '{"status":"angenommen"}'::jsonb from public.workspace_offers where client_offer_id='o-3')), (select row_version from public.workspace_offers where client_offer_id='o-3'))$q$),
    'Annahme nur ueber accept_workspace_offer');
  perform pg_temp.erwarte_fehler('15 resultingVorgangId per Upsert',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','offer', jsonb_build_object('offer_id','o-2','status','angenommen','payload', (select payload || '{"resultingVorgangId":"v-fremd"}'::jsonb from public.workspace_offers where client_offer_id='o-2')), %s)$q$, v_ver),
    'nur ueber accept_workspace_offer');

  /* 16: Fremdworkspace */
  perform pg_temp.erwarte_fehler('16 Fremdworkspace', $q$select public.accept_workspace_offer('00000000-0000-0000-0000-000000000b02','o-1','v-9',0)$q$, 'Kein Zugriff');

  /* 17: bestehender normaler Vorgang weiterhin upsertbar */
  r := public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag geaendert","customer":"k","baustelle":"","status":"in_pruefung","materialSource":"unclear","orderPositions":[]}}'::jsonb,1);
  if r->'payload'->'payload'->>'title' <> 'Werkvertrag geaendert' then raise exception '17: %', r; end if;
  raise notice 'OK  15-17: Zustaende, Fremdworkspace, Bestandsvorgang';

  /* 18-21: operativer Plan (orderPositions) eines Auftrags aus Angebot ist an den Snapshot gebunden */
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-1';
  perform pg_temp.erwarte_fehler('18 unitPrice einer Snapshot-Position aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(%L::jsonb, '{orderPositions,0,unitPrice}', '99'::jsonb)), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('18 plannedQuantity einer Snapshot-Position aendern',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(%L::jsonb, '{orderPositions,1,plannedQuantity}', '20'::jsonb)), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('19 Snapshot-Position entfernen',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(%L::jsonb, '{orderPositions}', (%L::jsonb->'orderPositions') - 0)), %s)$q$, v_row.payload::text, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  perform pg_temp.erwarte_fehler('20 fremde Position ohne Nachtrag',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(%L::jsonb, '{orderPositions}', (%L::jsonb->'orderPositions') || '[{"id":"p-fremd","description":"Extra","plannedQuantity":1,"unit":"Pauschal","unitPrice":500,"billable":true}]'::jsonb)), %s)$q$, v_row.payload::text, v_row.payload::text, v_row.row_version),
    'nur ueber bestaetigten Nachtrag');
  -- 21: operative Ausfuehrungsmenge bleibt frei
  r := public.upsert_workspace_sync_entity(ws,'vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(v_row.payload, '{orderPositions,0,executedQuantity}', '2.5'::jsonb)), v_row.row_version);
  if (r->'payload'->'payload'->'orderPositions'->0->>'executedQuantity')::numeric <> 2.5 then raise exception '21: executedQuantity %', r; end if;
  raise notice 'OK  18-21: Snapshot-Positionen serverseitig festgeschrieben, executedQuantity frei';

  /* 22: kontrollierter Nachtragsweg -- bestaetigter Nachtrag darf den Plan erweitern, aber nur mit seinen Werten */
  r := public.confirm_workspace_order_amendment(ws, 'v-1', 'am-1',
    '{"title":"Nachtrag 1","positions":[{"id":"pA","changeType":"add","description":"Zusatz","plannedQuantity":3,"unit":"Stück","unitPrice":120},{"id":"pB","changeType":"quantity_increase","parentPositionId":"p1","description":"Demontage mehr","plannedQuantity":2,"unit":"Stunden","unitPrice":55}]}'::jsonb);
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-1';
  r := public.upsert_workspace_sync_entity(ws,'vorgang', jsonb_build_object('vorgang_id','v-1','payload',
    jsonb_set(v_row.payload, '{orderPositions}', (v_row.payload->'orderPositions') ||
      '[{"id":"pA","description":"Zusatz","plannedQuantity":3,"unit":"Stück","unitPrice":120,"sourceAmendmentId":"am-1","sourceAmendmentSequence":1,"amendmentChangeType":"add"},
        {"id":"pB","description":"Demontage mehr","plannedQuantity":2,"unit":"Stunden","unitPrice":55,"sourceAmendmentId":"am-1","sourceAmendmentSequence":1,"parentPositionId":"p1","amendmentChangeType":"quantity_increase"}]'::jsonb)), v_row.row_version);
  if jsonb_array_length(r->'payload'->'payload'->'orderPositions') <> 4 then raise exception '22: komponierter Plan %', r; end if;
  select * into v_row from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-1';
  perform pg_temp.erwarte_fehler('22 Nachtragsposition mit anderem Preis',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(%L::jsonb, '{orderPositions,2,unitPrice}', '1'::jsonb)), %s)$q$, v_row.payload::text, v_row.row_version),
    'weicht vom bestaetigten Nachtrag ab');
  perform pg_temp.erwarte_fehler('22 Snapshot-Position nach Nachtrag weiterhin festgeschrieben',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000b01','vorgang', jsonb_build_object('vorgang_id','v-1','payload', jsonb_set(%L::jsonb, '{orderPositions,0,description}', '"anders"'::jsonb)), %s)$q$, v_row.payload::text, v_row.row_version),
    'ist festgeschrieben');
  raise notice 'OK  22: Nachtragsweg erweitert den Plan, generischer Upsert nur mit den bestaetigten Werten';

  /* 23: Werkvertrags-Vorgang ohne Auftragsherkunft: Plan weiterhin frei (unveraendertes Verhalten) */
  r := public.upsert_workspace_sync_entity(ws,'vorgang','{"vorgang_id":"v-alt","payload":{"id":"v-alt","title":"Werkvertrag geaendert","customer":"k","baustelle":"","status":"in_pruefung","materialSource":"unclear","orderPositions":[{"id":"w1","description":"frei","plannedQuantity":1,"unit":"Pauschal","unitPrice":10}]}}'::jsonb,2);
  if jsonb_array_length(r->'payload'->'payload'->'orderPositions') <> 1 then raise exception '23: %', r; end if;
  raise notice 'OK  23: Bestandsvorgang ohne Auftrag unveraendert frei';

  /* 24: kein zweites Angebot kann denselben Vorgang uebernehmen */
  perform public.finalize_workspace_offer(ws, 'o-6', basis || '{"id":"o-6","title":"Sechstes"}', 'fp-6', 0);
  perform pg_temp.erwarte_fehler('24 zweites Angebot auf bestehenden Vorgang',
    $q$select public.accept_workspace_offer('00000000-0000-0000-0000-000000000b01','o-6','v-1',0)$q$,
    'Vorgangskennung bereits vergeben');
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws and source_offer_id is not null; if n <> 2 then raise exception '24: % Auftraege', n; end if;
  raise notice 'OK  24: ein Vorgang gehoert genau einem Angebot';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
