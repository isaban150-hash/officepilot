-- E-MAIL-07C — Laufzeittest Kunden-/Vorgangskontext fuer Versandauftraege.
--
-- Setzt 20261010120000 (07B) und 20261011120000 (07C) voraus. Isoliert, ohne
-- den lokalen Stand zu veraendern (Migrationen + Test in EINER Transaktion,
-- am Ende Rollback):
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261010120000_workspace_document_delivery_send_hardening.sql; \
--     cat supabase/migrations/20261011120000_workspace_document_delivery_context.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/document_delivery_context_07c.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'versand-07c@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000c07c1', 'Kontext-07C', '00000000-0000-0000-0000-0000000007c1'),
       ('00000000-0000-0000-0000-0000000c07c2', 'Fremd-07C', '00000000-0000-0000-0000-0000000007c1');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000c07c1', '00000000-0000-0000-0000-0000000007c1', 'owner', 'active');

insert into public.workspace_company_profiles (workspace_id, payload)
values ('00000000-0000-0000-0000-0000000c07c1', jsonb_build_object('companyName', 'Muster Bau', 'email', 'info@muster-bau.example'))
on conflict (workspace_id) do update set payload = excluded.payload;

-- Kontext im eigenen Workspace, ein geloeschter Kunde, und fremde Kennungen im zweiten Workspace.
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000c07c1', 'kunde-a', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000c07c1', 'kunde-b', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000c07c2', 'kunde-fremd', '{}'::jsonb);
insert into public.workspace_customers (workspace_id, customer_id, payload, deleted, deleted_at)
values ('00000000-0000-0000-0000-0000000c07c1', 'kunde-geloescht', '{}'::jsonb, true, now());
insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-0000000c07c1', 'vorgang-a', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000c07c2', 'vorgang-fremd', '{}'::jsonb);

-- Ein Geschaeftsbrief im Archiv mit gebundener PDF-Datei (wie in 07B).
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
values ('00000000-0000-0000-0000-0000000c07c1', 'doc-brief-07c', 'archived_document',
        jsonb_build_object('title', 'Brief an Kunde', 'classifiedKind', 'schriftverkehr', 'linkedLetterId', 'letter-07c'));
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path)
values ('00000000-0000-0000-0000-0000000c07c1', 'file-brief-07c', repeat('c', 64), 1234, 'application/pdf',
        '00000000-0000-0000-0000-0000000c07c1/' || repeat('c', 64));
insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind)
values ('00000000-0000-0000-0000-0000000c07c1', 'doc-brief-07c', 'file-brief-07c', 'original');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007c1","role":"authenticated"}', true);

create function pg_temp.lege_an(
  p_client_id text,
  p_customer text,
  p_vorgang text,
  p_retry_of uuid default null
) returns public.workspace_document_deliveries language plpgsql as $p$
declare
  v jsonb;
  r public.workspace_document_deliveries;
begin
  v := public.create_workspace_document_delivery_with_context(
    '00000000-0000-0000-0000-0000000c07c1', p_client_id, 'letter', null,
    'kunde@example.invalid', 'Brief', 'Guten Tag',
    '00000000-0000-0000-0000-0000000c07c1/letter-doc-brief-07c/' || repeat('c', 64) || '.pdf',
    repeat('c', 64), 1234, 'Brief an Kunde.pdf', 'application/pdf', 'stub',
    p_retry_of, 'doc-brief-07c', false, p_customer, p_vorgang);
  if (v->'delivery'->>'id') is null then
    raise exception 'Antwort ohne Versandauftrag: %', v;
  end if;
  select * into r from public.workspace_document_deliveries where id = (v->'delivery'->>'id')::uuid;
  -- Die Antwort traegt bereits den Kontext.
  if (v->'delivery'->>'customer_id') is distinct from r.customer_id or (v->'delivery'->>'vorgang_id') is distinct from r.vorgang_id then
    raise exception 'Antwort und Datensatz unterscheiden sich im Kontext';
  end if;
  return r;
end;
$p$;

create function pg_temp.nein(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% -- falscher Fehler: % (erwartet: %)', p_label, sqlerrm, p_expected;
    end if;
    raise notice 'ABGELEHNT  %  -> %', p_label, p_expected;
    return;
  end;
  raise exception '% -- kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

/* A/B — Kunde und Vorgang werden gespeichert */
do $$
declare r public.workspace_document_deliveries;
begin
  r := pg_temp.lege_an('cd-07c-a', 'kunde-a', null);
  if r.customer_id is distinct from 'kunde-a' or r.vorgang_id is not null then
    raise exception 'A -- Kundenkontext nicht gespeichert: % %', r.customer_id, r.vorgang_id;
  end if;
  raise notice 'OK         A Versand mit customer_id';

  r := pg_temp.lege_an('cd-07c-b', null, 'vorgang-a');
  if r.vorgang_id is distinct from 'vorgang-a' or r.customer_id is not null then
    raise exception 'B -- Vorgangskontext nicht gespeichert: % %', r.customer_id, r.vorgang_id;
  end if;
  raise notice 'OK         B Versand mit vorgang_id';

  r := pg_temp.lege_an('cd-07c-ab', 'kunde-b', 'vorgang-a');
  if r.customer_id is distinct from 'kunde-b' or r.vorgang_id is distinct from 'vorgang-a' then
    raise exception 'AB -- beide Kennungen nicht gespeichert';
  end if;
  raise notice 'OK         AB Versand mit Kunde und Vorgang';
end;
$$;

/* C — fremde oder geloeschte Kennungen werden abgelehnt, ohne Versandauftrag */
select pg_temp.nein('C1 Kunde aus fremdem Workspace',
  $q$select pg_temp.lege_an('cd-07c-c1', 'kunde-fremd', null)$q$, 'customer_id gehoert nicht zum Workspace');
select pg_temp.nein('C2 Vorgang aus fremdem Workspace',
  $q$select pg_temp.lege_an('cd-07c-c2', null, 'vorgang-fremd')$q$, 'vorgang_id gehoert nicht zum Workspace');
select pg_temp.nein('C3 geloeschter Kunde',
  $q$select pg_temp.lege_an('cd-07c-c3', 'kunde-geloescht', null)$q$, 'customer_id gehoert nicht zum Workspace');
select pg_temp.nein('C4 unbekannter Vorgang',
  $q$select pg_temp.lege_an('cd-07c-c4', null, 'vorgang-gibt-es-nicht')$q$, 'vorgang_id gehoert nicht zum Workspace');
do $$
begin
  if exists (select 1 from public.workspace_document_deliveries where client_delivery_id like 'cd-07c-c%') then
    raise exception 'C -- abgelehnter Kontext hat trotzdem einen Versandauftrag hinterlassen';
  end if;
  raise notice 'OK         C keine Versandauftraege aus abgelehnten Aufrufen';
end;
$$;

/* D — alter Weg ohne Kontext bleibt gueltig und lesbar */
do $$
declare
  v jsonb;
  n integer;
begin
  v := public.create_workspace_document_delivery(
    '00000000-0000-0000-0000-0000000c07c1', 'cd-07c-d', 'letter', null,
    'kunde@example.invalid', 'Brief', 'Guten Tag',
    '00000000-0000-0000-0000-0000000c07c1/letter-doc-brief-07c/' || repeat('c', 64) || '.pdf',
    repeat('c', 64), 1234, 'Brief an Kunde.pdf', 'application/pdf', 'stub', null, 'doc-brief-07c', false);
  if (v->'delivery'->>'customer_id') is not null or (v->'delivery'->>'vorgang_id') is not null then
    raise exception 'D -- Altweg hat Kontext erfunden';
  end if;
  select count(*) into n from public.list_workspace_document_deliveries_for_document('00000000-0000-0000-0000-0000000c07c1', 'doc-brief-07c');
  if n <> 4 then
    raise exception 'D -- Dokumentliste unvollstaendig: %', n;
  end if;
  raise notice 'OK         D Versand ohne Kontext bleibt anlegbar und lesbar';
end;
$$;

/* E/F — Kontextliste zeigt nur passende Auftraege */
do $$
declare
  ids text[];
begin
  select array_agg(client_delivery_id order by client_delivery_id) into ids
  from public.list_workspace_document_deliveries_for_context('00000000-0000-0000-0000-0000000c07c1', 'kunde-a', null);
  if ids is distinct from array['cd-07c-a'] then
    raise exception 'E -- Kundenliste falsch: %', ids;
  end if;
  select array_agg(client_delivery_id order by client_delivery_id) into ids
  from public.list_workspace_document_deliveries_for_context('00000000-0000-0000-0000-0000000c07c1', null, 'vorgang-a');
  if ids is distinct from array['cd-07c-ab', 'cd-07c-b'] then
    raise exception 'F -- Vorgangsliste falsch: %', ids;
  end if;
  raise notice 'OK         E/F Kontextliste nur mit passenden Versandauftraegen';
end;
$$;
select pg_temp.nein('E2 Kontextliste ohne Kennung',
  $q$select * from public.list_workspace_document_deliveries_for_context('00000000-0000-0000-0000-0000000c07c1', null, null)$q$,
  'customer_id oder vorgang_id fehlt');
select pg_temp.nein('E3 Kontextliste eines fremden Workspace',
  $q$select * from public.list_workspace_document_deliveries_for_context('00000000-0000-0000-0000-0000000c07c2', 'kunde-fremd', null)$q$,
  'Kein Zugriff auf Workspace');

/* Replay — derselbe Auftrag mit anderem Kontext ueberschreibt nichts */
do $$
declare r public.workspace_document_deliveries;
begin
  r := pg_temp.lege_an('cd-07c-a', 'kunde-b', 'vorgang-a');
  if r.customer_id is distinct from 'kunde-a' or r.vorgang_id is distinct from 'vorgang-a' then
    raise exception 'R -- Replay hat den Kontext veraendert: % %', r.customer_id, r.vorgang_id;
  end if;
  raise notice 'OK         R Replay ergaenzt nur, ueberschreibt nie';
end;
$$;

/* G — Neuversuch nach Fehlschlag behaelt Kette und bekommt Kontext */
do $$
declare
  first_row public.workspace_document_deliveries;
  retry_row public.workspace_document_deliveries;
begin
  select * into first_row from public.workspace_document_deliveries where client_delivery_id = 'cd-07c-b';
  update public.workspace_document_deliveries
  set status = 'failed', failed_at = now(), error_category = 'provider', error_code = 'test', error_message_safe = 'Test'
  where id = first_row.id;
  retry_row := pg_temp.lege_an('cd-07c-g', null, 'vorgang-a', first_row.id);
  if retry_row.retry_of_delivery_id is distinct from first_row.id or retry_row.attempt_number <> 2 or retry_row.vorgang_id is distinct from 'vorgang-a' then
    raise exception 'G -- Retry-Kette/Kontext falsch: % % %', retry_row.retry_of_delivery_id, retry_row.attempt_number, retry_row.vorgang_id;
  end if;
  raise notice 'OK         G Neuversuch: Kette (Versuch 2) und Kontext erhalten';
end;
$$;

rollback;
