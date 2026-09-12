-- NORMAL-INVOICE-CANCELLATION-01B — T16 paralleler Storno (zwei Sessions).
--
-- Nur lokal. Ablauf (zwei psql-Prozesse gegen supabase_db_officepilot):
--   1. Dieses Skript mit -v phase=setup   : legt Testdaten committed an.
--   2. Session A: -v phase=a  (begin; cancel; pg_sleep(3); commit)
--      Session B: -v phase=b  (cancel, blockiert auf der Zeilensperre)   — gleichzeitig starten
--   3. -v phase=verify : genau eine Stornierung, genau ein Korrekturbeleg, ein Grund
--   4. -v phase=cleanup: Testdaten entfernen
\set ON_ERROR_STOP on
\pset tuples_only on

\if :{?phase}
\else
  \echo 'phase fehlt'
  \quit 1
\endif

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000dddd","role":"authenticated"}', false);

select case when :'phase' = 'setup' then 1 else 0 end as is_setup \gset
select case when :'phase' = 'a' then 1 else 0 end as is_a \gset
select case when :'phase' = 'b' then 1 else 0 end as is_b \gset
select case when :'phase' = 'verify' then 1 else 0 end as is_verify \gset
select case when :'phase' = 'cleanup' then 1 else 0 end as is_cleanup \gset

\if :is_setup
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000dddd', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'cancel-parallel@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000000dd', 'Cancel-Parallel', '00000000-0000-0000-0000-00000000dddd');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000000dd', '00000000-0000-0000-0000-00000000dddd', 'owner', 'active');
select public.finalize_workspace_invoice('00000000-0000-0000-0000-0000000000dd', null, 'inv-par',
  '{"type":"rechnung","issueDate":"2026-09-01","positions":[],"companySnapshot":{"companyName":"M"},"customerSnapshot":{"name":"K"}}') is not null;
select public.update_workspace_invoice_sent('00000000-0000-0000-0000-0000000000dd', 'inv-par', '2026-09-02', 'email', null) is not null;
\echo 'SETUP OK'
\endif

\if :is_a
begin;
select cancel_reason, cancellation_kind from public.cancel_workspace_invoice('00000000-0000-0000-0000-0000000000dd', 'inv-par', 'Grund A');
select pg_sleep(3);
commit;
\echo 'A COMMITTED'
\endif

\if :is_b
select cancel_reason, cancellation_kind, correction_document_id from public.cancel_workspace_invoice('00000000-0000-0000-0000-0000000000dd', 'inv-par', 'Grund B');
\echo 'B DONE'
\endif

\if :is_verify
select 'cancellations=' || count(*) from public.workspace_invoices where workspace_id = '00000000-0000-0000-0000-0000000000dd' and cancelled_at is not null;
select 'reason=' || cancel_reason || ' kind=' || cancellation_kind || ' rv=' || row_version from public.workspace_invoices where workspace_id = '00000000-0000-0000-0000-0000000000dd' and client_invoice_id = 'inv-par';
select 'correction_docs=' || count(*) from public.workspace_documents where workspace_id = '00000000-0000-0000-0000-0000000000dd' and document_kind = 'generated_invoice_correction';
\endif

\if :is_cleanup
delete from public.workspace_documents where workspace_id = '00000000-0000-0000-0000-0000000000dd';
delete from public.workspace_invoice_payments where workspace_id = '00000000-0000-0000-0000-0000000000dd';
delete from public.workspace_invoices where workspace_id = '00000000-0000-0000-0000-0000000000dd';
delete from public.workspace_members where workspace_id = '00000000-0000-0000-0000-0000000000dd';
delete from public.workspaces where id = '00000000-0000-0000-0000-0000000000dd';
delete from auth.users where id = '00000000-0000-0000-0000-00000000dddd';
\echo 'CLEANUP OK'
\endif
