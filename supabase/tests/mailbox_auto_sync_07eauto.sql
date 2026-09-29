-- E-MAIL 07E-AUTO-SYNC 01A — Laufzeittest Scheduler-Datenbankteil: Kandidaten
-- (nur Steuerdaten, getrennt ausgeschlossen), Fehlerserie in finish, Reset bei
-- Erfolg und Neu-Verbinden, Lease unverändert, Scheduler-Geheimnis, Rechte,
-- Zeitpläne (pg_cron), OAuth-State-Bereinigung. Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     cat supabase/migrations/20261015120000_workspace_mailbox_oauth.sql; \
--     cat supabase/migrations/20261016120000_workspace_mailbox_auto_sync.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/mailbox_auto_sync_07eauto.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Keine echten Zugangsdaten.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000a5ea1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'auto@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000a5e01', 'AUTO', '00000000-0000-0000-0000-0000000a5ea1');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000a5e01', '00000000-0000-0000-0000-0000000a5ea1', 'owner', 'active');

insert into public.workspace_mailbox_connections (id, workspace_id, provider_type, auth_mode, mailbox_address, status, mailbox_source_kind, mailbox_source_name, import_from, account_verified_at)
values ('00000000-0000-0000-0000-0000000a5c01', '00000000-0000-0000-0000-0000000a5e01', 'microsoft_graph', 'delegated', 'aktiv@example.invalid', 'connected', 'folder', 'OfficeTakt-Test', now() - interval '1 day', now()),
       ('00000000-0000-0000-0000-0000000a5c02', '00000000-0000-0000-0000-0000000a5e01', 'microsoft_graph', 'delegated', 'getrennt@example.invalid', 'disconnected', 'folder', 'OfficeTakt-Test', now() - interval '1 day', now()),
       ('00000000-0000-0000-0000-0000000a5c03', '00000000-0000-0000-0000-0000000a5e01', 'microsoft_graph', 'delegated', 'ohne@example.invalid', 'connected', 'folder', 'OfficeTakt-Test', now() - interval '1 day', now());
select public.set_workspace_mailbox_credential('00000000-0000-0000-0000-0000000a5c01', 'platzhalter-auto');
select public.set_workspace_mailbox_credential('00000000-0000-0000-0000-0000000a5c02', 'platzhalter-getrennt');

do $$
declare
  c uuid := '00000000-0000-0000-0000-0000000a5c01';
  list jsonb;
  item jsonb;
  v jsonb;
  lease uuid;
  n integer;
begin
  -- Kandidaten: nur nicht getrennte Postfächer, nur Steuerdaten.
  list := public.list_workspace_mailbox_auto_sync_candidates(200);
  if jsonb_array_length(list) <> 2 then raise exception 'Kandidaten Anzahl %', jsonb_array_length(list); end if;
  if exists (select 1 from jsonb_array_elements(list) e where e->>'id' = '00000000-0000-0000-0000-0000000a5c02') then raise exception 'getrennt gelistet'; end if;
  select e into item from jsonb_array_elements(list) e where e->>'id' = c::text;
  if (item->>'has_credential')::boolean is not true or (item->>'lease_active')::boolean is not false or (item->>'consecutive_failures')::int <> 0 then raise exception 'Kandidat aktiv %', item; end if;
  select e into item from jsonb_array_elements(list) e where e->>'id' = '00000000-0000-0000-0000-0000000a5c03';
  if (item->>'has_credential')::boolean is not false then raise exception 'ohne Zugang'; end if;
  if list::text ~ '(example\.invalid|OfficeTakt-Test|sync_cursor|lease_token|platzhalter)' then raise exception 'Kandidaten enthalten Inhalte'; end if;

  -- Lease wie bisher: zweiter Claim scheitert, Kandidat zeigt aktiven Lease.
  v := public.claim_workspace_mailbox_sync(c, 300);
  lease := (v->'connection'->>'sync_lease_token')::uuid;
  if (v->>'claimed')::boolean is not true then raise exception 'Claim 1'; end if;
  if (public.claim_workspace_mailbox_sync(c, 300)->>'claimed')::boolean then raise exception 'Doppelter Claim'; end if;
  select e into item from jsonb_array_elements(public.list_workspace_mailbox_auto_sync_candidates(200)) e where e->>'id' = c::text;
  if (item->>'lease_active')::boolean is not true then raise exception 'Lease nicht sichtbar'; end if;

  -- Fehlerserie zählt; Retry-After setzt next_attempt_at; kein Disconnect.
  perform public.finish_workspace_mailbox_sync(c, lease, 'error', 'rate_limited', 'graph_429', 'Pause', 900);
  select consecutive_failures into n from public.workspace_mailbox_connections where id = c;
  if n <> 1 then raise exception 'Fehler 1: %', n; end if;
  if not exists (select 1 from public.workspace_mailbox_connections where id = c and status = 'error' and next_attempt_at > now() + interval '14 minutes') then raise exception 'Retry-After'; end if;
  if (public.claim_workspace_mailbox_sync(c, 300)->>'claimed')::boolean then raise exception 'Claim trotz Retry-After'; end if;
  update public.workspace_mailbox_connections set next_attempt_at = null where id = c;
  v := public.claim_workspace_mailbox_sync(c, 300);
  perform public.finish_workspace_mailbox_sync(c, (v->'connection'->>'sync_lease_token')::uuid, 'error', 'network', 'graph_network', 'Netz', null);
  select consecutive_failures into n from public.workspace_mailbox_connections where id = c;
  if n <> 2 then raise exception 'Fehler 2: %', n; end if;

  -- Erfolg setzt zurück.
  v := public.claim_workspace_mailbox_sync(c, 300);
  perform public.finish_workspace_mailbox_sync(c, (v->'connection'->>'sync_lease_token')::uuid, 'connected');
  if not exists (select 1 from public.workspace_mailbox_connections where id = c and consecutive_failures = 0 and status = 'connected' and error_category is null) then raise exception 'Reset Erfolg'; end if;

  -- „Neu verbinden" (invalid_grant) bleibt verbunden-mit-Fehler, nicht getrennt; Neu-Verbinden setzt zurück.
  v := public.claim_workspace_mailbox_sync(c, 300);
  perform public.finish_workspace_mailbox_sync(c, (v->'connection'->>'sync_lease_token')::uuid, 'error', 'reauthorize', 'oauth_invalid_grant', 'Neu verbinden', null);
  if not exists (select 1 from public.workspace_mailbox_connections where id = c and status = 'error' and error_category = 'reauthorize' and consecutive_failures = 1) then raise exception 'Reauthorize'; end if;
  if not exists (select 1 from public.workspace_mailbox_credentials where connection_id = c) then raise exception 'Zugang geloescht'; end if;
  update public.workspace_mailbox_connections set account_verified_at = now() + interval '1 second', status = 'connected', error_category = null where id = c;
  if not exists (select 1 from public.workspace_mailbox_connections where id = c and consecutive_failures = 0) then raise exception 'Reset Neu-Verbinden'; end if;

  -- Geheimnis: nur Vault, Prüfung korrekt.
  if not exists (select 1 from vault.secrets where name = 'officetakt_mailbox_auto_sync_secret') then raise exception 'Geheimnis fehlt'; end if;
  if not public.mailbox_auto_sync_secret_valid((select decrypted_secret from vault.decrypted_secrets where name = 'officetakt_mailbox_auto_sync_secret')) then raise exception 'Geheimnis gueltig'; end if;
  if public.mailbox_auto_sync_secret_valid(repeat('0', 64)) or public.mailbox_auto_sync_secret_valid(null) or public.mailbox_auto_sync_secret_valid('kurz') then raise exception 'Geheimnis falsch akzeptiert'; end if;

  -- Rechte.
  if has_function_privilege('authenticated', 'public.list_workspace_mailbox_auto_sync_candidates(integer)', 'execute') then raise exception 'Kandidaten fuer Clients'; end if;
  if has_function_privilege('anon', 'public.mailbox_auto_sync_secret_valid(text)', 'execute') then raise exception 'Geheimnis fuer anon'; end if;
  if not has_function_privilege('service_role', 'public.mailbox_auto_sync_secret_valid(text)', 'execute') then raise exception 'service_role Geheimnis'; end if;
  if has_function_privilege('service_role', 'public.mailbox_auto_sync_dispatch()', 'execute') or has_function_privilege('authenticated', 'public.mailbox_auto_sync_dispatch()', 'execute') then raise exception 'Dispatch Rechte'; end if;

  -- Zeitpläne.
  if not exists (select 1 from cron.job where jobname = 'officetakt-mailbox-auto-sync' and schedule = '*/10 * * * *' and command = 'select public.mailbox_auto_sync_dispatch()') then raise exception 'Cron Abruf'; end if;
  if not exists (select 1 from cron.job where jobname = 'officetakt-mailbox-oauth-state-purge' and schedule = '17 * * * *') then raise exception 'Cron Purge'; end if;
  if (select count(*) from cron.job where jobname like 'officetakt-mailbox-%') <> 2 then raise exception 'Cron doppelt'; end if;
end;
$$;

-- OAuth-State-Bereinigung: nur abgelaufene States; laufende bleiben.
do $$
declare
  ws uuid := '00000000-0000-0000-0000-0000000a5e01';
  u uuid := '00000000-0000-0000-0000-0000000a5ea1';
  aktiv uuid;
  alt uuid;
  r jsonb;
begin
  aktiv := public.create_workspace_mailbox_oauth_state(ws, u, 'microsoft_graph', repeat('a', 64), repeat('v', 64), repeat('n', 32), 'aktiv@example.invalid', 'folder', 'OfficeTakt-Test', now() - interval '1 day', 600);
  alt := public.create_workspace_mailbox_oauth_state(ws, u, 'microsoft_graph', repeat('b', 64), repeat('v', 64), repeat('n', 32), 'aktiv@example.invalid', 'folder', 'OfficeTakt-Test', now() - interval '1 day', 600);
  update public.workspace_mailbox_oauth_states set expires_at = now() - interval '2 hours' where id = alt;
  r := public.purge_expired_workspace_mailbox_oauth_states();
  if exists (select 1 from public.workspace_mailbox_oauth_states where id = alt) then raise exception 'abgelaufen nicht bereinigt'; end if;
  if not exists (select 1 from public.workspace_mailbox_oauth_states where id = aktiv) then raise exception 'laufender State geloescht'; end if;
end;
$$;

select 'EMAIL-07E-AUTO-SYNC SQL OK';

rollback;
