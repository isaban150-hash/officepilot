-- DOKUMENTE-01 / F9 -- Vertragstest Papierregister folgt dem Dokument (20261126120000).
--
--   P1  Legt der Inhaber den Eintrag zum Dokument eines Mitglieds an, gehört er
--       dem Mitglied (created_by); geschrieben hat ihn der Inhaber (updated_by).
--   P2  Das Mitglied sieht ihn im Abzug und per RLS und hakt ihn ab.
--   P3  Sein Version-0-Versand mit eigenem Inhalt ist ein lösbarer
--       Versionskonflikt, keine endgültige Rollenabweisung (der Befund F9).
--   P4  Unverändert: kein Grabstein durch Mitglieder; Einträge zu fremden
--       Dokumenten weder sichtbar noch änderbar; ohne Dokument in der Cloud
--       gehört der Eintrag dem Schreibenden; geschützte Belege bleiben verborgen.
--   P5  Altbestand wird einmalig umgestellt, Version und Inhalt bleiben.
--   P6  Rechte: neue Funktionen intern.
--
-- Ausführen (nur lokal, niemals --linked oder remote), mit der Migration in
-- derselben Transaktion:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261126120000_dokumente01_papierregister.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/dokumente01_papierregister.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Exit-Code 0 = alle Zusicherungen erfüllt. Alles wird zurückgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from (values
  ('00000000-0000-0000-0000-0000000d0201'::uuid, 'inhaber-dok01p@example.invalid'),
  ('00000000-0000-0000-0000-0000000d0202'::uuid, 'mitglied-dok01p@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-0000000d0201'::uuid, '00000000-0000-0000-0000-0000000d0202'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000d02a1'::uuid, 'DOK01 Papierregister', '00000000-0000-0000-0000-0000000d0201'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000d02a1'::uuid, '00000000-0000-0000-0000-0000000d0201'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000d02a1'::uuid, '00000000-0000-0000-0000-0000000d0202'::uuid, 'member', 'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d02a1'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d0201'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d0202'::uuid $p$;

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by)
values (pg_temp.ws(), 'doc-p-mitglied', 'archived_document', '{"id":"doc-p-mitglied","title":"Bescheid Mitglied"}'::jsonb, pg_temp.mitglied()),
       (pg_temp.ws(), 'doc-p-inhaber', 'archived_document', '{"id":"doc-p-inhaber","title":"Bescheid Inhaber"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'emp-receipt-dok01p', 'archived_document', '{"id":"emp-receipt-dok01p","title":"Quittung"}'::jsonb, pg_temp.mitglied());

/** Als dieser Nutzer -- Rolle authenticated, damit RLS und Funktionsrechte greifen. */
create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

/** Der Push, wie ihn der Client baut. */
create function pg_temp.eintrag(p_doc text, p_filed boolean, p_deleted boolean default false) returns jsonb language sql as $p$
  select jsonb_build_object(
    'entry_id', 'paper-reg-' || p_doc,
    'document_id', p_doc,
    'payload', jsonb_build_object(
      'id', 'paper-reg-' || p_doc, 'documentId', p_doc, 'documentTitle', 'Bescheid ' || p_doc,
      'folderId', 'folder-5', 'register', 'B', 'physicalFiled', p_filed,
      'createdAt', '2026-10-20T08:00:00.000Z', 'updatedAt', '2026-10-20T08:00:00.000Z'),
    'deleted', p_deleted);
$p$;

create function pg_temp.push_sql(p_payload jsonb, p_version bigint) returns text language sql immutable as $p$
  select format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, %s)',
                pg_temp.ws(), 'paper_register_entry', p_payload, p_version);
$p$;

create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    raise notice 'ABGEWIESEN  %  -> %', p_label, p_text;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.zeile(p_doc text) returns public.workspace_paper_register_entries language sql as $p$
  select * from public.workspace_paper_register_entries
  where workspace_id = pg_temp.ws() and client_entry_id = 'paper-reg-' || p_doc;
$p$;

/** Sieht der aktuelle Nutzer den Eintrag zu diesem Dokument im Abzug? */
create function pg_temp.im_abzug(p_doc text) returns boolean language sql as $p$
  select exists (
    select 1 from jsonb_array_elements(coalesce(public.pull_workspace_sync_state(pg_temp.ws())->'paper_register_entries', '[]'::jsonb)) e
    where e->>'client_entry_id' = 'paper-reg-' || p_doc);
$p$;

/** Sieht der aktuelle Nutzer den Eintrag per RLS? */
create function pg_temp.per_rls(p_doc text) returns boolean language sql as $p$
  select exists (select 1 from public.workspace_paper_register_entries
                 where workspace_id = pg_temp.ws() and client_entry_id = 'paper-reg-' || p_doc);
$p$;

create function pg_temp.pruefe(p_label text, p_ok boolean) returns void language plpgsql as $p$
begin
  if not coalesce(p_ok, false) then
    raise exception '% -- Zusicherung verletzt', p_label;
  end if;
  raise notice 'OK  %', p_label;
end;
$p$;

/* P1 — der Inhaber legt den Eintrag zum Dokument des Mitglieds an. */
select pg_temp.als(pg_temp.inhaber());
select public.upsert_workspace_sync_entity(pg_temp.ws(), 'paper_register_entry', pg_temp.eintrag('doc-p-mitglied', false), 0);
select pg_temp.zurueck();
select pg_temp.pruefe('P1 Eintrag gehört dem Dokument (created_by Mitglied), geschrieben vom Inhaber',
  (pg_temp.zeile('doc-p-mitglied')).created_by = pg_temp.mitglied()
  and (pg_temp.zeile('doc-p-mitglied')).updated_by = pg_temp.inhaber()
  and (pg_temp.zeile('doc-p-mitglied')).row_version = 1);

/* P2 — das Mitglied sieht und ändert ihn. */
select pg_temp.als(pg_temp.mitglied());
select pg_temp.pruefe('P2a Mitglied sieht den Eintrag im Abzug', pg_temp.im_abzug('doc-p-mitglied'));
select pg_temp.pruefe('P2b Mitglied sieht den Eintrag per RLS', pg_temp.per_rls('doc-p-mitglied'));
select public.upsert_workspace_sync_entity(pg_temp.ws(), 'paper_register_entry', pg_temp.eintrag('doc-p-mitglied', true), 1);
select pg_temp.zurueck();
select pg_temp.pruefe('P2c Mitglied hat abgehakt',
  ((pg_temp.zeile('doc-p-mitglied')).payload->>'physicalFiled')::boolean
  and (pg_temp.zeile('doc-p-mitglied')).row_version = 2
  and (pg_temp.zeile('doc-p-mitglied')).updated_by = pg_temp.mitglied());

/* P3 — der Befund F9: Version 0 mit eigenem Inhalt ist ein Konflikt, keine Rollenabweisung. */
select pg_temp.als(pg_temp.mitglied());
select pg_temp.erwarte_abweisung('P3 Mitgliedsgerät sendet seinen Eintrag mit Version 0',
  pg_temp.push_sql(pg_temp.eintrag('doc-p-mitglied', false), 0), 'Versionskonflikt paper_register_entry');
select pg_temp.zurueck();

/* P4 — unverändert. */
select pg_temp.als(pg_temp.mitglied());
select pg_temp.erwarte_abweisung('P4a kein Grabstein durch ein Mitglied',
  pg_temp.push_sql(pg_temp.eintrag('doc-p-mitglied', true, true), 2), 'Keine Schreibberechtigung');
select pg_temp.zurueck();

select pg_temp.als(pg_temp.inhaber());
select public.upsert_workspace_sync_entity(pg_temp.ws(), 'paper_register_entry', pg_temp.eintrag('doc-p-inhaber', false), 0);
select public.upsert_workspace_sync_entity(pg_temp.ws(), 'paper_register_entry', pg_temp.eintrag('emp-receipt-dok01p', false), 0);
select pg_temp.zurueck();
select pg_temp.als(pg_temp.mitglied());
select pg_temp.pruefe('P4b Eintrag zum Dokument des Inhabers: weder im Abzug noch per RLS',
  not pg_temp.im_abzug('doc-p-inhaber') and not pg_temp.per_rls('doc-p-inhaber'));
select pg_temp.erwarte_abweisung('P4c und nicht änderbar',
  pg_temp.push_sql(pg_temp.eintrag('doc-p-inhaber', true), 0), 'Keine Schreibberechtigung');
select pg_temp.pruefe('P4d geschützter Beleg bleibt verborgen, obwohl das Dokument dem Mitglied gehört',
  not pg_temp.im_abzug('emp-receipt-dok01p') and not pg_temp.per_rls('emp-receipt-dok01p'));
select pg_temp.erwarte_abweisung('P4e und nicht änderbar',
  pg_temp.push_sql(pg_temp.eintrag('emp-receipt-dok01p', true), 1), 'Keine Schreibberechtigung');
select public.upsert_workspace_sync_entity(pg_temp.ws(), 'paper_register_entry', pg_temp.eintrag('doc-p-offline', true), 0);
select pg_temp.pruefe('P4f ohne Dokument in der Cloud gehört der Eintrag dem Schreibenden',
  pg_temp.im_abzug('doc-p-offline'));
select pg_temp.zurueck();
select pg_temp.pruefe('P4g Anleger: Inhaber, Mitglied, Schreibender',
  (pg_temp.zeile('doc-p-inhaber')).created_by = pg_temp.inhaber()
  and (pg_temp.zeile('emp-receipt-dok01p')).created_by = pg_temp.mitglied()
  and (pg_temp.zeile('doc-p-offline')).created_by = pg_temp.mitglied());

/*
 * P5 — Altbestand: vom Inhaber angelegt, bevor das Dokument des Mitglieds in der
 * Cloud war (so entstand er auch vor dieser Migration). Danach kommt das Dokument.
 */
insert into public.workspace_paper_register_entries (workspace_id, client_entry_id, client_document_id, payload, row_version, created_by, updated_by)
values (pg_temp.ws(), 'paper-reg-doc-p-mitglied2', 'doc-p-mitglied2',
        (pg_temp.eintrag('doc-p-mitglied2', true))->'payload', 3, pg_temp.inhaber(), pg_temp.inhaber());
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by)
values (pg_temp.ws(), 'doc-p-mitglied2', 'archived_document', '{"id":"doc-p-mitglied2","title":"Altbestand"}'::jsonb, pg_temp.mitglied());
select pg_temp.pruefe('P5a vor der Umstellung: Inhaber',
  (pg_temp.zeile('doc-p-mitglied2')).created_by = pg_temp.inhaber());
select pg_temp.pruefe('P5b genau eine Zeile umgestellt',
  public.workspace_paper_register_entries_assign_document_owner() = 1);
select pg_temp.pruefe('P5c gehört dem Dokument; Version, Inhalt und Schreiber bleiben',
  (pg_temp.zeile('doc-p-mitglied2')).created_by = pg_temp.mitglied()
  and (pg_temp.zeile('doc-p-mitglied2')).row_version = 3
  and (pg_temp.zeile('doc-p-mitglied2')).updated_by = pg_temp.inhaber()
  and ((pg_temp.zeile('doc-p-mitglied2')).payload->>'physicalFiled')::boolean);
select pg_temp.pruefe('P5d Wiederholung ohne Wirkung',
  public.workspace_paper_register_entries_assign_document_owner() = 0);
select pg_temp.als(pg_temp.mitglied());
select pg_temp.pruefe('P5e Mitglied sieht den Altbestand zu seinem Dokument', pg_temp.im_abzug('doc-p-mitglied2'));
select pg_temp.zurueck();

/* P6 — Rechte. */
do $g$
declare
  v_funktion text;
  v_rolle text;
begin
  foreach v_funktion in array array[
    'public.workspace_paper_register_entries_document_owner()',
    'public.workspace_paper_register_entries_assign_document_owner()'
  ] loop
    foreach v_rolle in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_rolle, v_funktion, 'execute') then
        raise exception 'P6 % -- EXECUTE für %', v_funktion, v_rolle;
      end if;
    end loop;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = v_funktion::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'P6 % -- EXECUTE für public', v_funktion;
    end if;
  end loop;
  raise notice 'OK  P6 neue Funktionen nur intern';
end;
$g$;

rollback;
