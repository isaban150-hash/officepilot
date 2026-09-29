-- BROWSER-ACCEPTANCE-FIX 01 / A1 — Laufzeittest: Archivdokument einer
-- festgeschriebenen Rechnung ist serverseitig nicht loeschbar.
--
-- Setzt 20261019120000 voraus. Isoliert (Migration + Test in EINER Transaktion,
-- am Ende Rollback):
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261019120000_workspace_document_archive_guard.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/document_archive_guard_baf01.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000baf1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'archiv-baf01@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-00000000baf2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-baf01@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000baf01', 'Archiv-BAF01', '00000000-0000-0000-0000-00000000baf1'),
       ('00000000-0000-0000-0000-0000000baf02', 'Fremd-BAF01', '00000000-0000-0000-0000-00000000baf2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000baf01', '00000000-0000-0000-0000-00000000baf1', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000baf02', '00000000-0000-0000-0000-00000000baf2', 'owner', 'active');

-- Rechnungen: versendet, vorbereitet (beide festgeschrieben), Entwurf.
insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status)
values ('00000000-0000-0000-0000-0000000baf01', 'v-1', 'inv-sent', '2026-9001', 2026, 9001, 'rechnung', 'versendet'),
       ('00000000-0000-0000-0000-0000000baf01', 'v-2', 'inv-prep', '2026-9002', 2026, 9002, 'rechnung', 'vorbereitet'),
       ('00000000-0000-0000-0000-0000000baf01', 'v-3', 'inv-draft', '2026-9003', 2026, 9003, 'rechnung', 'entwurf'),
       -- Gleiche Rechnungskennung im FREMDEN Workspace, festgeschrieben.
       ('00000000-0000-0000-0000-0000000baf02', 'v-f', 'inv-foreign', '2026-9004', 2026, 9004, 'rechnung', 'versendet');

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload)
values ('00000000-0000-0000-0000-0000000baf01', 'doc-sent', 'generated_invoice', 'inv-sent', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000baf01', 'doc-prep', 'generated_invoice', 'inv-prep', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000baf01', 'doc-corr', 'generated_invoice_correction', 'inv-sent', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000baf01', 'doc-draft', 'generated_invoice', 'inv-draft', '{}'::jsonb),
       -- Verweist auf eine Rechnung, die es nur im fremden Workspace gibt → nicht geschuetzt.
       ('00000000-0000-0000-0000-0000000baf01', 'doc-xref', 'generated_invoice', 'inv-foreign', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000baf02', 'doc-foreign', 'archived_document', null, '{}'::jsonb);
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
values ('00000000-0000-0000-0000-0000000baf01', 'doc-normal', 'archived_document', '{"title":"Normal"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000baf1","role":"authenticated"}', true);

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

/* 1 — festgeschriebene Rechnung: direkter RPC-Aufruf wird abgelehnt */
select pg_temp.nein('1a versendete Rechnung',
  $q$select public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-sent')$q$,
  'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden');
select pg_temp.nein('1b vorbereitete Rechnung',
  $q$select public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-prep')$q$,
  'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden');
select pg_temp.nein('1c Korrekturbeleg einer festgeschriebenen Rechnung',
  $q$select public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-corr')$q$,
  'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden');
select pg_temp.nein('1d Leerzeichen um die Kennung umgehen den Schutz nicht',
  $q$select public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', '  doc-sent  ')$q$,
  'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden');

do $$
declare n int;
begin
  select count(*) into n from public.workspace_documents
  where workspace_id = '00000000-0000-0000-0000-0000000baf01'
    and client_document_id in ('doc-sent', 'doc-prep', 'doc-corr')
    and deleted_at is null and row_version = 1;
  if n <> 3 then raise exception '1 -- geschuetzte Dokumente wurden veraendert (% von 3 unveraendert)', n; end if;
  select count(*) into n from public.workspace_invoices
  where workspace_id = '00000000-0000-0000-0000-0000000baf01' and row_version = 1;
  if n <> 3 then raise exception '1 -- Rechnungen wurden veraendert'; end if;
  raise notice 'OK         1 geschuetzte Dokumente und Rechnungen unveraendert';
end;
$$;

/* 2 — fremder Workspace bleibt abgelehnt (Mandantentrennung unveraendert) */
select pg_temp.nein('2a fremder Workspace',
  $q$select public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf02', 'doc-foreign')$q$,
  'Kein Zugriff auf Workspace');
select pg_temp.nein('2b fremdes Dokument ueber den eigenen Workspace',
  $q$select public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-foreign')$q$,
  'Dokument nicht gefunden');

/* 3 — normale Dokumente bleiben loeschbar, idempotent */
do $$
declare r public.workspace_documents;
begin
  select * into r from public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-normal');
  if r.deleted_at is null or r.row_version <> 2 then raise exception '3a -- normales Dokument nicht geloescht'; end if;
  select * into r from public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-normal');
  if r.deleted_at is null or r.row_version <> 2 then raise exception '3b -- Wiederholung nicht idempotent'; end if;
  raise notice 'OK         3 normales Dokument geloescht, Wiederholung idempotent';

  -- Entwurfsrechnung ist nicht festgeschrieben → Dokument loeschbar.
  select * into r from public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-draft');
  if r.deleted_at is null then raise exception '3c -- Dokument einer Entwurfsrechnung nicht geloescht'; end if;
  raise notice 'OK         3c Dokument einer Entwurfsrechnung loeschbar';

  -- Festgeschriebene Rechnung gleicher Kennung nur im FREMDEN Workspace → kein Schutz, keine Auskunft ueber fremde Daten.
  select * into r from public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-xref');
  if r.deleted_at is null then raise exception '3d -- Fremd-Workspace-Rechnung wirkt auf eigenes Dokument'; end if;
  raise notice 'OK         3d Pruefung bleibt im eigenen Workspace';
end;
$$;

/* 4 — Altbestand: bereits geloeschter Beleg bleibt idempotent lesbar */
do $$
declare r public.workspace_documents;
begin
  update public.workspace_documents set deleted_at = now(), row_version = row_version + 1
  where workspace_id = '00000000-0000-0000-0000-0000000baf01' and client_document_id = 'doc-prep';
  select * into r from public.tombstone_workspace_document('00000000-0000-0000-0000-0000000baf01', 'doc-prep');
  if r.deleted_at is null or r.row_version <> 2 then raise exception '4 -- Altbestand-Grabstein nicht idempotent'; end if;
  raise notice 'OK         4 bereits geloeschter Beleg bleibt idempotent';
end;
$$;

/* 5 — Rechte unveraendert: authenticated ja, anon nein */
do $$
begin
  if not has_function_privilege('authenticated', 'public.tombstone_workspace_document(uuid, text)', 'execute') then
    raise exception '5 -- authenticated darf nicht ausfuehren';
  end if;
  if has_function_privilege('anon', 'public.tombstone_workspace_document(uuid, text)', 'execute') then
    raise exception '5 -- anon darf ausfuehren';
  end if;
  raise notice 'OK         5 Rechte unveraendert';
end;
$$;

select 'SQL OK';
rollback;
