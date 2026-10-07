-- CLOUD-SYNC S5 -- echte Doppelfreigabe desselben Cloud-Entwurfs (zwei Sessions).
--
-- Nur lokal. Ablauf (zwei psql-Prozesse gegen supabase_db_officepilot):
--   1. Dieses Skript mit -v phase=setup   : legt Testdaten committed an
--      (Workspace, Kunde, ein freier Rechnungsentwurf in Version 1).
--   2. Session A: -v phase=a  (begin; Freigabe mit Bindung; pg_sleep(3); commit)
--      Session B: -v phase=b  (Freigabe desselben Entwurfs mit eigener
--      clientInvoiceId; wartet an der Entwurfssperre)   — gleichzeitig starten
--   3. -v phase=verify : genau eine Rechnung, genau eine Nummer, Entwurf auf A
--   4. -v phase=cleanup: Testdaten entfernen
--
-- Erwartet fuer B: `invoice_draft_already_finalized:inv-par-a`.
\set ON_ERROR_STOP on
\pset tuples_only on

\if :{?phase}
\else
  \echo 'phase fehlt'
  \quit 1
\endif

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000d5509","role":"authenticated"}', false);

select case when :'phase' = 'setup' then 1 else 0 end as is_setup \gset
select case when :'phase' = 'a' then 1 else 0 end as is_a \gset
select case when :'phase' = 'b' then 1 else 0 end as is_b \gset
select case when :'phase' = 'verify' then 1 else 0 end as is_verify \gset
select case when :'phase' = 'cleanup' then 1 else 0 end as is_cleanup \gset

\if :is_setup
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000d5509', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'draft-parallel-s5@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

-- R1-SEC-01: freigegebenes Konto mit aktiver Lizenz.
update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email = 'draft-parallel-s5@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000d509', 'S5 Parallel', '00000000-0000-0000-0000-0000000d5509');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000d509', '00000000-0000-0000-0000-0000000d5509', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000d509', 'cust-par', '{"name":"Parallel Kunde GmbH"}'::jsonb);

select (public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000d509', 'invoice_draft', jsonb_build_object(
  'draft_id', 'draft-par', 'vorgang_id', 'null'::jsonb, 'invoice_type', 'rechnung',
  'payload', jsonb_build_object('id', 'draft-par', 'vorgangId', 'null'::jsonb, 'type', 'rechnung',
    'positions', jsonb_build_array(), 'introText', 'Paralleltest'),
  'deleted', false), 0)->>'row_version') = '1';
\echo 'SETUP OK'
\endif

\if :is_a
begin;
select r->'row'->>'invoice_number' from (select public.finalize_workspace_invoice(
  '00000000-0000-0000-0000-00000000d509', null, 'inv-par-a',
  '{"type":"rechnung","taxStatus":"kleinunternehmer_19","customerId":"cust-par","customerSnapshot":{"name":"Parallel Kunde GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"},"positions":[{"id":"p1","description":"Leistung","quantity":1,"unit":"Pauschal","unitPrice":100,"lineTotal":100}],"subtotal":100,"amount":100,"issueDate":"2026-10-06"}'::jsonb,
  false, 'draft-par', 1) r) x;
select pg_sleep(3);
commit;
\echo 'A COMMITTED'
\endif

\if :is_b
select public.finalize_workspace_invoice(
  '00000000-0000-0000-0000-00000000d509', null, 'inv-par-b',
  '{"type":"rechnung","taxStatus":"kleinunternehmer_19","customerId":"cust-par","customerSnapshot":{"name":"Parallel Kunde GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"},"positions":[{"id":"p1","description":"Leistung","quantity":1,"unit":"Pauschal","unitPrice":100,"lineTotal":100}],"subtotal":100,"amount":100,"issueDate":"2026-10-06"}'::jsonb,
  false, 'draft-par', 1) is not null;
\echo 'B UNERWARTET ERFOLGREICH'
\endif

\if :is_verify
do $$
declare
  n integer;
  seq integer;
  d public.workspace_invoice_drafts;
begin
  select count(*) into n from public.workspace_invoices
  where workspace_id = '00000000-0000-0000-0000-00000000d509';
  select last_sequence into seq from public.workspace_invoice_sequences
  where workspace_id = '00000000-0000-0000-0000-00000000d509' and invoice_year = 2026;
  select * into d from public.workspace_invoice_drafts
  where workspace_id = '00000000-0000-0000-0000-00000000d509' and client_draft_id = 'draft-par';
  if n <> 1 then raise exception 'VERIFY -- % Rechnungen statt genau einer', n; end if;
  if seq <> 1 then raise exception 'VERIFY -- Nummernstand % statt 1', seq; end if;
  if d.status <> 'finalized' or d.finalized_client_invoice_id <> 'inv-par-a' or d.row_version <> 2 then
    raise exception 'VERIFY -- Entwurf falsch: %', to_jsonb(d);
  end if;
  raise notice 'OK  PARALLEL -- genau eine Rechnung, genau eine Nummer, Entwurf finalisiert auf inv-par-a';
end $$;
\endif

\if :is_cleanup
delete from public.workspace_invoice_drafts where workspace_id = '00000000-0000-0000-0000-00000000d509';
delete from public.workspace_invoices where workspace_id = '00000000-0000-0000-0000-00000000d509';
delete from public.workspaces where id = '00000000-0000-0000-0000-00000000d509';
delete from auth.users where id = '00000000-0000-0000-0000-0000000d5509';
\echo 'CLEANUP OK'
\endif
