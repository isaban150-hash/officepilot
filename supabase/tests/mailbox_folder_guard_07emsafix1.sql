-- E-MAIL-07E-MSA-FIX1 — Laufzeittest Systemordner-Schutz (Datenbankseite):
-- delegiertes Microsoft nur mit Quelle „OfficeTakt-Test" (Start + Verbindung),
-- Systemordnernamen und beliebige Ordner abgelehnt, Application-Modus
-- unberührt, Fehlercode in der Postfachliste. Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     cat supabase/migrations/20261015120000_workspace_mailbox_oauth.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/mailbox_folder_guard_07emsafix1.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal. Exit-Code 0 = OK.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000f1a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fix1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000f101', 'FIX1', '00000000-0000-0000-0000-00000000f1a1');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f1a1', 'owner', 'active');

create function pg_temp.erwarte_fehler(p_sql text, p_fragment text) returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_fragment) in lower(sqlerrm)) = 0 then
      raise exception 'Falsche Fehlermeldung: % (erwartet: %)', sqlerrm, p_fragment;
    end if;
    return;
  end;
  raise exception 'Kein Fehler, erwartet: %', p_fragment;
end;
$p$;

create function pg_temp.start(p_hash_char text, p_name text) returns uuid language sql as $p$
  select public.create_workspace_mailbox_oauth_state('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f1a1', 'microsoft_graph',
    repeat(p_hash_char, 64), repeat('v', 64), repeat('n', 32), 'schabi82@hotmail.de', 'folder', p_name, '2026-09-27T00:00:00Z', 600);
$p$;

create function pg_temp.verbindung(p_name text, p_address text) returns void language sql as $p$
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_source_kind, mailbox_source_name, import_from, mailbox_address, status)
  values ('00000000-0000-0000-0000-00000000f101', 'microsoft_graph', 'delegated', 'folder', p_name, now(), p_address, 'connected');
$p$;

do $$
declare
  n text;
  i integer := 0;
begin
  -- Register: Testphase nur „OfficeTakt-Test"; andere Anbieter ohne Einschränkung.
  if (select allowed_source_names from public.mailbox_provider_types where provider_type = 'microsoft_graph') <> array['OfficeTakt-Test'] then raise exception 'Register Microsoft'; end if;
  if (select allowed_source_names from public.mailbox_provider_types where provider_type = 'google_gmail') is not null then raise exception 'Register Gmail'; end if;

  -- A: OfficeTakt-Test erlaubt (Start und Verbindung; Groß-/Kleinschreibung egal).
  perform pg_temp.start('a', 'OfficeTakt-Test');
  perform pg_temp.start('b', 'officetakt-test');
  perform pg_temp.verbindung('OfficeTakt-Test', 'ok@hotmail.invalid');

  -- B–H + beliebige Ordner: Start und Verbindung abgelehnt.
  foreach n in array array['Inbox', 'Posteingang', 'Sent Items', 'Gesendete Elemente', 'Drafts', 'Entwürfe', 'Deleted Items', 'Gelöschte Elemente',
                           'Junk Email', 'Junk-E-Mail', 'Spam', 'Archive', 'Archiv', 'Privat', 'OfficeTakt-Test2'] loop
    i := i + 1;
    perform pg_temp.erwarte_fehler(format($q$select pg_temp.start(%L, %L)$q$, to_hex(i), n), 'mailbox_source_not_allowed');
    perform pg_temp.erwarte_fehler(format($q$select pg_temp.verbindung(%L, %L)$q$, n, 'x' || i || '@hotmail.invalid'), 'mailbox_source_not_allowed');
  end loop;
  if (select count(*) from public.workspace_mailbox_oauth_states) <> 2 then raise exception 'Start trotz Sperre'; end if;

  -- Bestehende Verbindung kann nicht nachträglich auf einen Systemordner umgestellt werden.
  perform pg_temp.erwarte_fehler($q$update public.workspace_mailbox_connections set mailbox_source_name = 'Posteingang' where mailbox_address = 'ok@hotmail.invalid'$q$, 'mailbox_source_not_allowed');

  -- N: Application-Modus (Firmenmandant, ohne Quelle) unverändert möglich.
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_address, status)
  values ('00000000-0000-0000-0000-00000000f101', 'microsoft_graph', 'application', 'info@firma.invalid', 'connected');

  -- Architektur offen: ohne Einschränkung (später Firmenkunden) sind eigene Ordner möglich.
  update public.mailbox_provider_types set allowed_source_names = null where provider_type = 'microsoft_graph';
  perform pg_temp.start('f', 'Kundenpost');
  update public.mailbox_provider_types set allowed_source_names = array['OfficeTakt-Test'] where provider_type = 'microsoft_graph';

  -- Rechte: Prüffunktion nur intern.
  if has_function_privilege('authenticated', 'public.mailbox_source_name_allowed(text, text)', 'execute') then raise exception 'Rechte'; end if;
end;
$$;

-- Fehlercode (z. B. graph_folder_system) erreicht die Oberfläche — ohne Cursor/Lease/Secrets.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f1a1","role":"authenticated"}', true);
do $$
declare
  v jsonb;
begin
  update public.workspace_mailbox_connections set status = 'error', error_category = 'provider', error_code = 'graph_folder_system' where mailbox_address = 'ok@hotmail.invalid';
  v := public.list_workspace_mailbox_connections('00000000-0000-0000-0000-00000000f101');
  if (select count(*) from jsonb_array_elements(v) e where e->>'error_code' = 'graph_folder_system' and e->>'mailbox_source_name' = 'OfficeTakt-Test') <> 1 then raise exception 'Liste: %', v; end if;
  if v::text like '%sync_cursor%' or v::text like '%lease%' then raise exception 'Liste Leck'; end if;
end;
$$;

select 'EMAIL-07E-MSA-FIX1 SQL OK';

rollback;
