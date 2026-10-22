-- DOKUMENTE-01 Nacharbeit — Probe der lokalen Rücknahme (nur lokal; alles wird zurückgerollt).
--
-- Aufruf aus dem Repo (das Rücknahmeskript wird an der Marke @RUECKNAHME@ eingesetzt):
--
--   g=pruefunterlagen/dokumente-01/belege/nacharbeit-w/gegenproben
--   { echo 'begin;'; sed -n '1,/-- @RUECKNAHME@/p' $g/ruecknahme-probe.sql; \
--     cat pruefunterlagen/dokumente-01/lokal/ruecknahme-20261125-20261126-lokal.sql; \
--     sed -n '/-- @RUECKNAHME@/,$p' $g/ruecknahme-probe.sql; echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Teil 1 baut einen W2-Fall auf: Eintrag vom Inhaber, Dokument danach vom Mitglied → der Eintrag gehört
-- dem Mitglied, die Prüfspur hat den Wechsel. Dann folgt das Rücknahmeskript, dann Teil 2 (Prüfungen).

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from (values
  ('00000000-0000-0000-0000-0000000d0301'::uuid, 'inhaber-dok01r@example.invalid'),
  ('00000000-0000-0000-0000-0000000d0302'::uuid, 'mitglied-dok01r@example.invalid')
) as u(id, email);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000d03a1'::uuid, 'DOK01 Rücknahme', '00000000-0000-0000-0000-0000000d0301'::uuid);
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000d03a1'::uuid, '00000000-0000-0000-0000-0000000d0301'::uuid, 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000d03a1'::uuid, '00000000-0000-0000-0000-0000000d0302'::uuid, 'member', 'active');

insert into public.workspace_paper_register_entries (workspace_id, client_entry_id, client_document_id, payload, row_version, created_by, updated_by)
values ('00000000-0000-0000-0000-0000000d03a1'::uuid, 'paper-reg-doc-r1', 'doc-r1',
        '{"id":"paper-reg-doc-r1","documentId":"doc-r1","physicalFiled":true,"folderId":"f","register":"A"}'::jsonb, 4,
        '00000000-0000-0000-0000-0000000d0301'::uuid, '00000000-0000-0000-0000-0000000d0301'::uuid);
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by)
values ('00000000-0000-0000-0000-0000000d03a1'::uuid, 'doc-r1', 'archived_document', '{"id":"doc-r1","title":"R1"}'::jsonb,
        '00000000-0000-0000-0000-0000000d0302'::uuid);

do $v$
begin
  if (select created_by from public.workspace_paper_register_entries where client_entry_id = 'paper-reg-doc-r1')
     is distinct from '00000000-0000-0000-0000-0000000d0302'::uuid then
    raise exception 'R0 Aufbau: Nachzug hat nicht umgestellt';
  end if;
  raise notice 'OK  R0 vor der Rücknahme: Eintrag gehört dem Mitglied (Nachzug), Prüfspur vorhanden: %',
    (select count(*) from public.workspace_paper_register_owner_changes where client_entry_id = 'paper-reg-doc-r1');
end;
$v$;

-- @RUECKNAHME@

do $n$
begin
  if (select created_by from public.workspace_paper_register_entries where client_entry_id = 'paper-reg-doc-r1')
     is distinct from '00000000-0000-0000-0000-0000000d0301'::uuid then
    raise exception 'R1 früherer Anleger nicht wiederhergestellt';
  end if;
  if (select row_version from public.workspace_paper_register_entries where client_entry_id = 'paper-reg-doc-r1') <> 4
     or not (select (payload->>'physicalFiled')::boolean from public.workspace_paper_register_entries where client_entry_id = 'paper-reg-doc-r1') then
    raise exception 'R2 Version oder Inhalt verändert';
  end if;
  if to_regclass('public.workspace_paper_register_owner_changes') is not null
     or exists (select 1 from pg_trigger where tgname in (
       'workspace_documents_paper_register_owner', 'workspace_paper_register_entries_document_owner',
       'workspace_document_file_bindings_retention_guard', 'workspace_files_retention_guard', 'workspace_documents_retention_guard'))
     or exists (select 1 from pg_proc where proname in (
       'workspace_documents_paper_register_owner', 'workspace_paper_register_entries_document_owner',
       'workspace_paper_register_entries_assign_document_owner', 'workspace_retention_year', 'workspace_retention_rule',
       'workspace_document_retention', 'workspace_documents_retention_guard',
       'workspace_document_file_bindings_retention_guard', 'workspace_files_retention_guard')) then
    raise exception 'R3 Rücknahme unvollständig';
  end if;
  raise notice 'OK  R1 früherer Anleger (Inhaber) wiederhergestellt; R2 Version 4 und Inhalt unverändert; R3 alle Trigger, Funktionen und die Prüfspur entfernt';
end;
$n$;
