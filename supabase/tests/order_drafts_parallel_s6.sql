-- CLOUD-SYNC S6 -- echte Gleichzeitigkeit (zwei Sessions): Doppelanlage,
-- Doppelbestaetigung und Sperrreihenfolge.
--
-- Nur lokal. Ablauf (zwei psql-Prozesse gegen supabase_db_officepilot):
--   1. -v phase=setup    : Testdaten committed anlegen.
--   2. je Szenario k = 1..7 gleichzeitig starten -- A zuerst; B erst, wenn A
--      in pg_sleep steht und damit seine Sperren haelt (pg_stat_activity
--      abfragen, nicht blind warten: unter Last startet docker exec traege):
--        -v phase=a<k>   : begin; Aktion; pg_sleep(3); commit
--        -v phase=b<k>   : dieselbe Zeile -- wartet an der Sperre
--   3. -v phase=verify   : Endzustand
--   4. -v phase=cleanup  : Testdaten entfernen
--
--   1  zwei Auftragsanlagen desselben Entwurfs, gleiche Bindung
--        -> genau ein Auftrag, genau eine Nummer; B ist die Wiederholung
--   2  zwei Nachtragsbestaetigungen desselben Entwurfs, eigene Kennungen
--        -> genau ein Nachtrag; B: order_amendment_draft_already_consumed
--   3  Nachtragsbestaetigung (A) gegen Schlussrechnung mit altem Stand (B)
--        -> B wartet am Vorgang, dann invoice_amendment_state_stale; keine Sperrkette
--   4  Nachtragsbestaetigung (A) gegen Speichern desselben Entwurfs (B)
--        -> B: Versionskonflikt; keine Sperrkette
--   5  Auftragsanlage (A) gegen Speichern desselben Entwurfs (B)
--        -> B: Versionskonflikt
--   6  Speichern (A) gegen Auftragsanlage mit alter Bindung (B)
--        -> B: order_draft_version_conflict, kein Auftrag, keine Nummer
--   7  Speichern (A) gegen Nachtragsbestaetigung mit alter Bindung (B)
--        -> B wartet mit gehaltenem Vorgang am Entwurf, dann Versionskonflikt
--
-- Ein Deadlock wuerde Postgres mit `deadlock detected` abbrechen; jede
-- B-Phase prueft deshalb den erwarteten Befund woertlich.
\set ON_ERROR_STOP on
\pset tuples_only on

\if :{?phase}
\else
  \echo 'phase fehlt'
  \quit 1
\endif

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000d6609","role":"authenticated"}', false);

select case when :'phase' = 'setup' then 1 else 0 end as is_setup \gset
select case when :'phase' = 'verify' then 1 else 0 end as is_verify \gset
select case when :'phase' = 'cleanup' then 1 else 0 end as is_cleanup \gset
select case when :'phase' = 'a1' then 1 else 0 end as is_a1 \gset
select case when :'phase' = 'b1' then 1 else 0 end as is_b1 \gset
select case when :'phase' = 'a2' then 1 else 0 end as is_a2 \gset
select case when :'phase' = 'b2' then 1 else 0 end as is_b2 \gset
select case when :'phase' = 'a3' then 1 else 0 end as is_a3 \gset
select case when :'phase' = 'b3' then 1 else 0 end as is_b3 \gset
select case when :'phase' = 'a4' then 1 else 0 end as is_a4 \gset
select case when :'phase' = 'b4' then 1 else 0 end as is_b4 \gset
select case when :'phase' = 'a5' then 1 else 0 end as is_a5 \gset
select case when :'phase' = 'b5' then 1 else 0 end as is_b5 \gset
select case when :'phase' = 'a6' then 1 else 0 end as is_a6 \gset
select case when :'phase' = 'b6' then 1 else 0 end as is_b6 \gset
select case when :'phase' = 'a7' then 1 else 0 end as is_a7 \gset
select case when :'phase' = 'b7' then 1 else 0 end as is_b7 \gset

create function pg_temp.auftragsentwurf(p_id text, p_titel text default 'Parallel') returns jsonb language sql as $p$
  select jsonb_build_object('draft_id', p_id, 'deleted', false, 'payload', jsonb_build_object(
    'id', p_id, 'customerId', 'cust-par6',
    'customerBilling', jsonb_build_object('name', 'Parallel Kunde GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld'),
    'title', p_titel, 'baustelle', 'Weg 1',
    'positions', jsonb_build_array(jsonb_build_object('id', 'p1', 'description', 'Montage', 'plannedQuantity', 2, 'unit', 'Stunden', 'unitPrice', 100)),
    'taxStatus', 'standard_19', 'paymentTermsText', '14 Tage',
    'createdAt', '2026-10-07T08:00:00.000Z', 'updatedAt', '2026-10-07T08:00:00.000Z'));
$p$;

create function pg_temp.auftragsdaten() returns jsonb language sql as $p$
  select jsonb_build_object('customerId', 'cust-par6',
    'customerBilling', jsonb_build_object('name', 'Parallel Kunde GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld'),
    'title', 'Parallel', 'baustelle', 'Weg 1', 'taxStatus', 'standard_19', 'paymentTermsText', '14 Tage',
    'positions', jsonb_build_array(jsonb_build_object('id', 'p1', 'description', 'Montage', 'plannedQuantity', 2, 'unit', 'Stunden', 'unitPrice', 100)));
$p$;

create function pg_temp.nachtragsentwurf(p_id text, p_titel text default 'Nachtrag') returns jsonb language sql as $p$
  select jsonb_build_object('draft_id', p_id, 'vorgang_id', 'v-par-order', 'deleted', false, 'payload', jsonb_build_object(
    'id', p_id, 'vorgangId', 'v-par-order', 'title', p_titel,
    'positions', jsonb_build_array(jsonb_build_object('id', 'oad-' || p_id, 'changeType', 'add', 'description', 'Zusatz',
      'quantity', 1, 'unit', 'Stunden', 'unitPrice', 50)),
    'createdAt', '2026-10-07T08:00:00.000Z', 'updatedAt', '2026-10-07T08:00:00.000Z'));
$p$;

create function pg_temp.nachtragsdaten(p_draft text) returns jsonb language sql as $p$
  select jsonb_build_object('title', 'Nachtrag', 'positions', jsonb_build_array(jsonb_build_object(
    'id', 'oad-' || p_draft, 'changeType', 'add', 'description', 'Zusatz', 'plannedQuantity', 1, 'unit', 'Stunden', 'unitPrice', 50)));
$p$;

create function pg_temp.befund(p_label text, p_sql text, p_expected text) returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% -- falscher Befund: %', p_label, sqlerrm;
    end if;
    raise notice 'OK  % -- %', p_label, left(sqlerrm, 100);
    return;
  end;
  raise exception '% -- kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

\if :is_setup
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000d6609', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'order-parallel-s6@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
-- R1-SEC-01: nur fuer die Schlussrechnung in Szenario 3.
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where email = 'order-parallel-s6@example.invalid';
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000d609', 'S6 Parallel', '00000000-0000-0000-0000-0000000d6609');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000d609', '00000000-0000-0000-0000-0000000d6609', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000d609', 'cust-par6', '{"id":"cust-par6","name":"Parallel Kunde GmbH"}'::jsonb);

do $$
declare ws constant uuid := '00000000-0000-0000-0000-00000000d609';
begin
  perform public.upsert_workspace_sync_entity(ws, 'order_draft', pg_temp.auftragsentwurf('v-par-1'), 0);
  perform public.upsert_workspace_sync_entity(ws, 'order_draft', pg_temp.auftragsentwurf('v-par-5'), 0);
  perform public.upsert_workspace_sync_entity(ws, 'order_draft', pg_temp.auftragsentwurf('v-par-6'), 0);
  perform public.upsert_workspace_sync_entity(ws, 'order_draft', pg_temp.auftragsentwurf('v-par-order'), 0);
  perform public.create_workspace_order(ws, 'v-par-order', pg_temp.auftragsdaten(), 'v-par-order', 1);
  perform public.upsert_workspace_sync_entity(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-par-2'), 0);
  perform public.upsert_workspace_sync_entity(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-par-3'), 0);
  perform public.upsert_workspace_sync_entity(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-par-4'), 0);
  perform public.upsert_workspace_sync_entity(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-par-7'), 0);
end $$;
\echo 'SETUP OK'
\endif

/* 1 -- zwei Auftragsanlagen desselben Entwurfs */
\if :is_a1
begin;
select (public.create_workspace_order('00000000-0000-0000-0000-00000000d609', 'v-par-1', pg_temp.auftragsdaten(), 'v-par-1', 1))->'vorgang'->>'order_number';
select pg_sleep(3);
commit;
\echo 'A1 COMMITTED'
\endif
\if :is_b1
do $$
declare r jsonb;
begin
  r := public.create_workspace_order('00000000-0000-0000-0000-00000000d609', 'v-par-1', pg_temp.auftragsdaten(), 'v-par-1', 1);
  if not coalesce((r->>'replayed')::boolean, false) then raise exception 'B1 -- keine Wiederholung: %', r; end if;
  raise notice 'OK  B1 -- Wiederholung desselben Auftrags (%)', r->'vorgang'->>'order_number';
end $$;
\endif

/* 2 -- zwei Nachtragsbestaetigungen desselben Entwurfs */
\if :is_a2
begin;
select (public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d609', 'v-par-order', 'oam-par-a2', pg_temp.nachtragsdaten('oa-par-2'), 'oa-par-2', 1))->'row'->>'sequence_no';
select pg_sleep(3);
commit;
\echo 'A2 COMMITTED'
\endif
\if :is_b2
select pg_temp.befund('B2 Doppelbestaetigung',
  $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d609', 'v-par-order', 'oam-par-b2', pg_temp.nachtragsdaten('oa-par-2'), 'oa-par-2', 1)$q$,
  'order_amendment_draft_already_consumed');
\endif

/* 3 -- Nachtragsbestaetigung gegen Schlussrechnung mit altem Nachtragsstand */
\if :is_a3
begin;
select (public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d609', 'v-par-order', 'oam-par-a3', pg_temp.nachtragsdaten('oa-par-3'), 'oa-par-3', 1))->'row'->>'sequence_no';
select pg_sleep(3);
commit;
\echo 'A3 COMMITTED'
\endif
\if :is_b3
select pg_temp.befund('B3 Schlussrechnung mit altem Stand',
  $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000d609', 'v-par-order', 'inv-par6-schluss',
    '{"type":"schluss","taxStatus":"standard_19","subtotal":200,"amount":238,"issueDate":"2026-10-07","expectedAmendmentSequence":1,
      "customerSnapshot":{"name":"Parallel Kunde GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"},
      "positions":[{"id":"line-p1","orderPositionId":"p1","description":"Montage","quantity":2,"unit":"Stunden","unitPrice":100,"lineTotal":200}]}'::jsonb)$q$,
  'invoice_amendment_state_stale');
\endif

/* 4 -- Nachtragsbestaetigung gegen Speichern desselben Entwurfs */
\if :is_a4
begin;
select (public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d609', 'v-par-order', 'oam-par-a4', pg_temp.nachtragsdaten('oa-par-4'), 'oa-par-4', 1))->'row'->>'sequence_no';
select pg_sleep(3);
commit;
\echo 'A4 COMMITTED'
\endif
\if :is_b4
select pg_temp.befund('B4 Speichern waehrend Bestaetigung',
  $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000d609', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-par-4', 'Spaeter'), 1)$q$,
  'Versionskonflikt order_amendment_draft:2');
\endif

/* 5 -- Auftragsanlage gegen Speichern desselben Entwurfs */
\if :is_a5
begin;
select (public.create_workspace_order('00000000-0000-0000-0000-00000000d609', 'v-par-5', pg_temp.auftragsdaten(), 'v-par-5', 1))->'vorgang'->>'order_number';
select pg_sleep(3);
commit;
\echo 'A5 COMMITTED'
\endif
\if :is_b5
select pg_temp.befund('B5 Speichern waehrend Anlage',
  $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000d609', 'order_draft', pg_temp.auftragsentwurf('v-par-5', 'Spaeter'), 1)$q$,
  'Versionskonflikt order_draft:2');
\endif

/* 6 -- Speichern gegen Auftragsanlage mit alter Bindung */
\if :is_a6
begin;
select (public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000d609', 'order_draft', pg_temp.auftragsentwurf('v-par-6', 'Neuer'), 1))->>'row_version';
select pg_sleep(3);
commit;
\echo 'A6 COMMITTED'
\endif
\if :is_b6
select pg_temp.befund('B6 Anlage mit alter Bindung',
  $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d609', 'v-par-6', pg_temp.auftragsdaten(), 'v-par-6', 1)$q$,
  'order_draft_version_conflict:2');
\endif

/* 7 -- Speichern gegen Nachtragsbestaetigung mit alter Bindung */
\if :is_a7
begin;
select (public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000d609', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-par-7', 'Neuer'), 1))->>'row_version';
select pg_sleep(3);
commit;
\echo 'A7 COMMITTED'
\endif
\if :is_b7
select pg_temp.befund('B7 Bestaetigung mit alter Bindung',
  $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d609', 'v-par-order', 'oam-par-b7', pg_temp.nachtragsdaten('oa-par-7'), 'oa-par-7', 1)$q$,
  'order_amendment_draft_version_conflict:2');
\endif

\if :is_verify
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d609';
  n integer;
  seq integer;
begin
  -- 1/5: genau je ein Auftrag; 6: keiner. Nummernkreis: v-par-order, v-par-1, v-par-5 -> 3.
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-par-1';
  if n <> 1 then raise exception 'VERIFY 1 -- % Auftraege', n; end if;
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-par-6';
  if n <> 0 then raise exception 'VERIFY 6 -- Auftrag trotz alter Bindung'; end if;
  select s.last_sequence into seq from public.workspace_order_sequences s
  where s.workspace_id = ws and s.order_year = extract(year from now())::integer;
  if seq <> 3 then raise exception 'VERIFY -- Auftragsnummernstand % statt 3', seq; end if;
  if (select status from public.workspace_order_drafts where workspace_id = ws and client_draft_id = 'v-par-1') <> 'consumed'
     or (select row_version from public.workspace_order_drafts where workspace_id = ws and client_draft_id = 'v-par-1') <> 2 then
    raise exception 'VERIFY 1 -- Entwurf nicht genau einmal verbraucht';
  end if;
  if (select row_version from public.workspace_order_drafts where workspace_id = ws and client_draft_id = 'v-par-6') <> 2
     or (select status from public.workspace_order_drafts where workspace_id = ws and client_draft_id = 'v-par-6') <> 'active' then
    raise exception 'VERIFY 6 -- Speichern nicht erhalten';
  end if;
  -- 2/3/4: genau ein Nachtrag je Entwurf; 7: keiner. Sequenzen 1..3 ohne Luecke.
  select count(*) into n from public.workspace_order_amendments where workspace_id = ws and payload->>'sourceDraftId' = 'oa-par-2';
  if n <> 1 then raise exception 'VERIFY 2 -- % Nachtraege', n; end if;
  select count(*) into n from public.workspace_order_amendments where workspace_id = ws and payload->>'sourceDraftId' = 'oa-par-7';
  if n <> 0 then raise exception 'VERIFY 7 -- Nachtrag trotz alter Bindung'; end if;
  select max(sequence_no) into seq from public.workspace_order_amendments where workspace_id = ws and vorgang_id = 'v-par-order';
  select count(*) into n from public.workspace_order_amendments where workspace_id = ws and vorgang_id = 'v-par-order';
  if seq <> 3 or n <> 3 then raise exception 'VERIFY -- Nachtragssequenz % bei % Nachtraegen', seq, n; end if;
  -- 3: keine Schlussrechnung entstanden.
  select count(*) into n from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-par6-schluss';
  if n <> 0 then raise exception 'VERIFY 3 -- Schlussrechnung trotz veraltetem Stand'; end if;
  if (select status from public.workspace_order_amendment_drafts where workspace_id = ws and client_draft_id = 'oa-par-7') <> 'active'
     or (select row_version from public.workspace_order_amendment_drafts where workspace_id = ws and client_draft_id = 'oa-par-7') <> 2 then
    raise exception 'VERIFY 7 -- Speichern nicht erhalten';
  end if;
  raise notice 'OK  VERIFY -- je ein Auftrag und eine Nummer, je ein Nachtrag, Sequenz ohne Luecke, keine Schlussrechnung, Speichern erhalten';
end $$;
\endif

\if :is_cleanup
begin;
-- Bestaetigte Nachtraege sind write-once; nur fuer das Entfernen der eigenen Testdaten kurz aus.
alter table public.workspace_order_amendments disable trigger workspace_order_amendments_write_once;
delete from public.workspace_order_amendment_drafts where workspace_id = '00000000-0000-0000-0000-00000000d609';
delete from public.workspace_order_drafts where workspace_id = '00000000-0000-0000-0000-00000000d609';
delete from public.workspace_order_amendments where workspace_id = '00000000-0000-0000-0000-00000000d609';
delete from public.workspace_invoices where workspace_id = '00000000-0000-0000-0000-00000000d609';
delete from public.workspaces where id = '00000000-0000-0000-0000-00000000d609';
delete from auth.users where id = '00000000-0000-0000-0000-0000000d6609';
alter table public.workspace_order_amendments enable trigger workspace_order_amendments_write_once;
commit;
\echo 'CLEANUP OK'
\endif
