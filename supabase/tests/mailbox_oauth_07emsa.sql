-- E-MAIL-07E-MSA — Laufzeittest delegiertes Microsoft-OAuth (Startzustand,
-- einmaliger Verbrauch, Ablauf, Rechte, Kontoabgleich, Bestätigen/Verwerfen,
-- Trennen, Wiederverbinden, 07E-Kompatibilität). 07E-PF: auf die
-- providerneutralen Signaturen umgestellt, Zusicherungen unverändert. Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     cat supabase/migrations/20261015120000_workspace_mailbox_oauth.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/mailbox_oauth_07emsa.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Keine echten Zugangsdaten: die
-- „Credentials" sind Platzhalter-Texte. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000a5a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-00000000a5a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-00000000a5a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm3@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000a501', 'MSA', '00000000-0000-0000-0000-00000000a5a1'),
       ('00000000-0000-0000-0000-00000000a502', 'MSA-Fremd', '00000000-0000-0000-0000-00000000a5a2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000a501', '00000000-0000-0000-0000-00000000a5a1', 'owner', 'active'),
       ('00000000-0000-0000-0000-00000000a502', '00000000-0000-0000-0000-00000000a5a2', 'owner', 'active'),
       ('00000000-0000-0000-0000-00000000a501', '00000000-0000-0000-0000-00000000a5a3', 'member', 'active');

-- 07E-Bestand: App-only-Verbindung desselben Providers.
insert into public.workspace_mailbox_connections (id, workspace_id, provider_type, auth_mode, mailbox_address, status)
values ('00000000-0000-0000-0000-00000000c5a1', '00000000-0000-0000-0000-00000000a501', 'microsoft_graph', 'application', 'info@firma.invalid', 'connected');

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

create function pg_temp.start(p_hash_char text, p_user text default '00000000-0000-0000-0000-00000000a5a1', p_ws text default '00000000-0000-0000-0000-00000000a501', p_expected text default 'schabi82@hotmail.de')
returns uuid language sql as $p$
  select public.create_workspace_mailbox_oauth_state(p_ws::uuid, p_user::uuid, 'microsoft_graph', repeat(p_hash_char, 64), repeat('v', 64), repeat('n', 32), p_expected, 'folder', 'OfficeTakt-Test', '2026-09-27T00:00:00Z', 600);
$p$;

do $$
declare
  ws uuid := '00000000-0000-0000-0000-00000000a501';
  s uuid;
  v jsonb;
  c uuid;
begin
  -- B: Application-Modus bleibt erhalten; Anmeldeart ist Pflicht für Graph.
  perform pg_temp.erwarte_fehler($q$insert into public.workspace_mailbox_connections (workspace_id, provider_type, mailbox_address, status) values ('00000000-0000-0000-0000-00000000a501', 'microsoft_graph', 'x@firma.invalid', 'connected')$q$, 'mailbox_auth_mode_invalid');
  perform pg_temp.erwarte_fehler($q$insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_address, status) values ('00000000-0000-0000-0000-00000000a501', 'stub', 'delegated', 'y@firma.invalid', 'connected')$q$, 'mailbox_auth_mode_invalid');
  -- Delegiert ohne Ordner/Untergrenze (= ganzes Postfach) unmöglich.
  perform pg_temp.erwarte_fehler($q$insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_address, status) values ('00000000-0000-0000-0000-00000000a501', 'microsoft_graph', 'delegated', 'z@hotmail.invalid', 'connected')$q$, 'mailbox_source_required');

  -- H: ohne Schreibrecht kein Start; G: fremder Workspace kein Start.
  perform pg_temp.erwarte_fehler($q$select pg_temp.start('1', '00000000-0000-0000-0000-00000000a5a3')$q$, 'Schreibberechtigung');
  perform pg_temp.erwarte_fehler($q$select pg_temp.start('2', '00000000-0000-0000-0000-00000000a5a2')$q$, 'Schreibberechtigung');
  -- Zu kurzer PKCE-Verifier abgelehnt; Hash-Format erzwungen.
  perform pg_temp.erwarte_fehler(format($q$select public.create_workspace_mailbox_oauth_state(%L, '00000000-0000-0000-0000-00000000a5a1', 'microsoft_graph', repeat('3', 64), 'kurz', repeat('n', 32), 'a@b.de', 'folder', 'OfficeTakt-Test', now())$q$, ws), 'PKCE');
  perform pg_temp.erwarte_fehler(format($q$select public.create_workspace_mailbox_oauth_state(%L, '00000000-0000-0000-0000-00000000a5a1', 'microsoft_graph', 'KEINHASH', repeat('v', 64), repeat('n', 32), 'a@b.de', 'folder', 'OfficeTakt-Test', now())$q$, ws), 'hash_check');

  -- E: korrekter State genau einmal; F: zweiter Verbrauch abgelehnt.
  s := pg_temp.start('a');
  v := public.consume_workspace_mailbox_oauth_state(repeat('a', 64));
  if not (v->>'ok')::boolean or (v->'state'->>'id')::uuid <> s or v->'state' ? 'state_hash' then raise exception 'E: %', v; end if;
  if v->'state'->>'code_verifier' <> repeat('v', 64) or v->'state'->>'expected_address' <> 'schabi82@hotmail.de' then raise exception 'E Inhalt'; end if;
  v := public.consume_workspace_mailbox_oauth_state(repeat('a', 64));
  if (v->>'ok')::boolean or v->>'reason' <> 'consumed' then raise exception 'F: %', v; end if;
  v := public.consume_workspace_mailbox_oauth_state(repeat('9', 64));
  if v->>'reason' <> 'unknown' then raise exception 'unbekannt: %', v; end if;

  -- E: abgelaufener State wird nicht verbraucht.
  perform pg_temp.start('b');
  update public.workspace_mailbox_oauth_states set expires_at = now() - interval '1 second' where state_hash = repeat('b', 64);
  v := public.consume_workspace_mailbox_oauth_state(repeat('b', 64));
  if (v->>'ok')::boolean or v->>'reason' <> 'expired' then raise exception 'E abgelaufen: %', v; end if;
  if (select consumed_at from public.workspace_mailbox_oauth_states where state_hash = repeat('b', 64)) is not null then raise exception 'E abgelaufen verbraucht'; end if;

  -- Abschluss nur nach Verbrauch.
  s := pg_temp.start('c');
  perform pg_temp.erwarte_fehler(format($q$select public.complete_workspace_mailbox_oauth(%L, 'schabi82@hotmail.de', 'ms-sub-1', 'platzhalter')$q$, s), 'ungueltig');

  -- U: erwartete Adresse passt → verbunden, Credential im Vault, nicht in Tabellen.
  perform public.consume_workspace_mailbox_oauth_state(repeat('c', 64));
  v := public.complete_workspace_mailbox_oauth(s, 'Schabi82@Hotmail.de', 'ms-sub-1', '{"refresh_token":"platzhalter-rt-1"}');
  if v->>'outcome' <> 'connected' then raise exception 'U: %', v; end if;
  c := (v->>'connection_id')::uuid;
  if not exists (select 1 from public.workspace_mailbox_connections where id = c and auth_mode = 'delegated' and provider_type = 'microsoft_graph'
      and mailbox_address = 'schabi82@hotmail.de' and mailbox_source_kind = 'folder' and mailbox_source_name = 'OfficeTakt-Test' and provider_account_subject = 'ms-sub-1' and import_from = '2026-09-27T00:00:00Z' and status = 'connected' and account_verified_at is not null) then
    raise exception 'U Verbindung';
  end if;
  if public.get_workspace_mailbox_credential(c) <> '{"refresh_token":"platzhalter-rt-1"}' then raise exception 'K Vault'; end if;
  -- Zweiter Abschluss desselben Zustands abgelehnt.
  perform pg_temp.erwarte_fehler(format($q$select public.complete_workspace_mailbox_oauth(%L, 'schabi82@hotmail.de', 'ms-sub-1', 'x')$q$, s), 'ungueltig');

  -- V: anderes Konto → keine Verbindung, nur ausstehende Bestätigung.
  s := pg_temp.start('d', p_expected => 'erwartet@hotmail.invalid');
  perform public.consume_workspace_mailbox_oauth_state(repeat('d', 64));
  v := public.complete_workspace_mailbox_oauth(s, 'anders@outlook.invalid', 'ms-sub-1', 'platzhalter-pending');
  if v->>'outcome' <> 'confirm_required' then raise exception 'V: %', v; end if;
  if exists (select 1 from public.workspace_mailbox_connections where mailbox_address in ('anders@outlook.invalid', 'erwartet@hotmail.invalid')) then raise exception 'V still verbunden'; end if;
  if (select pending_secret_id from public.workspace_mailbox_oauth_states where id = s) is null then raise exception 'V pending secret'; end if;
  -- Ungültige erkannte Adresse → fehlgeschlagen.
  s := pg_temp.start('e');
  perform public.consume_workspace_mailbox_oauth_state(repeat('e', 64));
  perform pg_temp.erwarte_fehler(format($q$select public.complete_workspace_mailbox_oauth(%L, 'keine-adresse', 'ms-sub-1', 'x')$q$, s), 'Kontoadresse');
end;
$$;

-- Keine Clientrechte auf Zustände, Zugangsdaten und Server-RPCs.
do $$
begin
  if has_table_privilege('authenticated', 'public.workspace_mailbox_oauth_states', 'select')
     or has_table_privilege('anon', 'public.workspace_mailbox_oauth_states', 'select')
     or has_function_privilege('authenticated', 'public.create_workspace_mailbox_oauth_state(uuid, uuid, text, text, text, text, text, text, text, timestamptz, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.consume_workspace_mailbox_oauth_state(text)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_workspace_mailbox_oauth(uuid, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.set_workspace_mailbox_source_id(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.get_workspace_mailbox_credential(uuid)', 'execute')
     or has_function_privilege('anon', 'public.disconnect_workspace_mailbox_connection(uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.disconnect_workspace_mailbox_connection(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.consume_workspace_mailbox_oauth_state(text)', 'execute') then
    raise exception 'Rechte';
  end if;
end;
$$;

-- Client-Pfad (authenticated) als Nutzer 1.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a5a1","role":"authenticated"}', true);

do $$
declare
  ws uuid := '00000000-0000-0000-0000-00000000a501';
  s uuid := (select id from public.workspace_mailbox_oauth_states where state_hash = repeat('d', 64));
  v jsonb;
  c uuid;
  n integer;
begin
  -- Ausstehende Bestätigung zeigt nur Adressen, nie Secrets/Verifier.
  v := public.get_workspace_mailbox_oauth_pending(ws, s);
  if v->>'detected_address' <> 'anders@outlook.invalid' or v->>'expected_address' <> 'erwartet@hotmail.invalid' then raise exception 'V pending: %', v; end if;
  if v::text like '%platzhalter%' or v ? 'code_verifier' or v ? 'nonce' or v ? 'pending_secret_id' then raise exception 'V Leck: %', v; end if;
  if public.get_workspace_mailbox_oauth_pending('00000000-0000-0000-0000-00000000a502', s) is not null then raise exception 'V fremd'; end if;

  -- Bestätigen → Verbindung mit der erkannten Adresse; ausstehendes Secret gelöscht.
  v := public.confirm_workspace_mailbox_oauth_pending(ws, s);
  c := (v->>'connection_id')::uuid;
  if not exists (select 1 from public.workspace_mailbox_connections where id = c and mailbox_address = 'anders@outlook.invalid' and auth_mode = 'delegated') then raise exception 'V bestaetigt'; end if;
  if (select pending_secret_id from public.workspace_mailbox_oauth_states where id = s) is not null then raise exception 'V pending bleibt'; end if;
  if (select count(*) from vault.secrets where name = 'mailbox-oauth-pending-' || s::text) <> 0 then raise exception 'V vault pending bleibt'; end if;
  perform pg_temp.erwarte_fehler(format($q$select public.confirm_workspace_mailbox_oauth_pending(%L, %L)$q$, ws, s), 'Keine ausstehende');

  -- Postfachliste: Anmeldeart, Ordner, keine Secrets.
  v := public.list_workspace_mailbox_connections(ws);
  if jsonb_array_length(v) <> 3 then raise exception 'Liste: %', v; end if;
  if (select count(*) from jsonb_array_elements(v) e where e->>'auth_mode' = 'delegated' and e->>'mailbox_source_name' = 'OfficeTakt-Test' and e->>'mailbox_source_kind' = 'folder') <> 2 then raise exception 'Liste delegated'; end if;
  if v::text like '%platzhalter%' or v::text like '%sync_cursor%' then raise exception 'Liste Leck'; end if;

  -- Trennen: Credential weg, Status disconnected, Mails bleiben.
  select id into c from public.workspace_mailbox_connections where mailbox_address = 'schabi82@hotmail.de';
  insert into public.workspace_email_messages (workspace_id, client_message_id, direction, provider, provider_message_id, mailbox_connection_id, from_address, status, received_at, imported_at, to_recipients, cc_recipients, bcc_recipients, subject, body_text, assignment_status)
  values (ws, 'in:test:1', 'inbound', 'microsoft_graph', 'p-1', c, 'kunde@kunde.invalid', 'received', now(), now(), '{}', '{}', '{}', 'Hallo', 'Text', 'needs_review');
  v := public.disconnect_workspace_mailbox_connection(ws, c);
  if v->>'status' <> 'disconnected' then raise exception 'Trennen: %', v; end if;
  if exists (select 1 from public.workspace_mailbox_credentials where connection_id = c) then raise exception 'Trennen Credential'; end if;
  if (select count(*) from vault.secrets where name = 'mailbox-' || c::text) <> 0 then raise exception 'Trennen Vault'; end if;
  select count(*) into n from public.workspace_email_messages where mailbox_connection_id = c;
  if n <> 1 then raise exception 'Trennen Mails weg'; end if;
  if (public.claim_workspace_mailbox_sync(c, 300)->>'claimed')::boolean then raise exception 'Trennen: Abruf moeglich'; end if;
  -- Fremder Workspace kann nicht trennen.
  perform pg_temp.erwarte_fehler(format($q$select public.disconnect_workspace_mailbox_connection('00000000-0000-0000-0000-00000000a502', %L)$q$, c), 'Schreibberechtigung');
end;
$$;

-- Verwerfen (Nutzer 1) und fremder Nutzer sieht nichts.
reset role;
do $$
declare
  s uuid;
begin
  s := pg_temp.start('f', p_expected => 'soll@hotmail.invalid');
  perform public.consume_workspace_mailbox_oauth_state(repeat('f', 64));
  perform public.complete_workspace_mailbox_oauth(s, 'ist@hotmail.invalid', 'ms-sub-1', 'platzhalter-verwerfen');
end;
$$;

do $$
declare
  ws uuid := '00000000-0000-0000-0000-00000000a501';
  s uuid := (select id from public.workspace_mailbox_oauth_states where state_hash = repeat('f', 64));
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a5a3","role":"authenticated"}', true);
  if public.get_workspace_mailbox_oauth_pending(ws, s) is not null then raise exception 'fremder Nutzer sieht pending'; end if;
  perform pg_temp.erwarte_fehler(format($q$select public.confirm_workspace_mailbox_oauth_pending(%L, %L)$q$, ws, s), 'Schreibberechtigung');
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000a5a1","role":"authenticated"}', true);
  perform public.cancel_workspace_mailbox_oauth_pending(ws, s);
  if (select outcome from public.workspace_mailbox_oauth_states where id = s) <> 'cancelled' then raise exception 'Verwerfen'; end if;
  if (select count(*) from vault.secrets where name = 'mailbox-oauth-pending-' || s::text) <> 0 then raise exception 'Verwerfen Vault'; end if;
  if exists (select 1 from public.workspace_mailbox_connections where mailbox_address in ('ist@hotmail.invalid', 'soll@hotmail.invalid')) then raise exception 'Verwerfen verbunden'; end if;
end;
$$;

-- Wiederverbinden nach Trennen: dieselbe Verbindung, neuer Zugang, Mails weiter da.
reset role;
do $$
declare
  s uuid;
  v jsonb;
  c uuid := (select id from public.workspace_mailbox_connections where mailbox_address = 'schabi82@hotmail.de');
begin
  update public.workspace_mailbox_connections set sync_cursor = '{"deltaLink":"https://graph.microsoft.com/v1.0/x"}' where id = c;
  s := pg_temp.start('4');
  perform public.consume_workspace_mailbox_oauth_state(repeat('4', 64));
  v := public.complete_workspace_mailbox_oauth(s, 'schabi82@hotmail.de', 'ms-sub-1', 'platzhalter-rt-2');
  if (v->>'connection_id')::uuid <> c then raise exception 'Wiederverbinden: neue Zeile'; end if;
  if (select status from public.workspace_mailbox_connections where id = c) <> 'connected' then raise exception 'Wiederverbinden Status'; end if;
  if public.get_workspace_mailbox_credential(c) <> 'platzhalter-rt-2' then raise exception 'Wiederverbinden Vault'; end if;
  if (select count(*) from public.workspace_email_messages where mailbox_connection_id = c) <> 1 then raise exception 'Wiederverbinden Mails'; end if;
  -- Gleicher Ordner/Zeitraum: gespeicherter Delta-Stand bleibt.
  if (select sync_cursor from public.workspace_mailbox_connections where id = c) is null then raise exception 'Cursor verloren'; end if;
  -- 07E-MSA-FIX1: In der Testphase ist ein anderer Ordner gar nicht startbar.
  perform pg_temp.erwarte_fehler($q$select public.create_workspace_mailbox_oauth_state('00000000-0000-0000-0000-00000000a501', '00000000-0000-0000-0000-00000000a5a1', 'microsoft_graph', repeat('6', 64), repeat('v', 64), repeat('n', 32), 'schabi82@hotmail.de', 'folder', 'Anderer-Ordner', '2026-09-27T00:00:00Z')$q$, 'mailbox_source_not_allowed');
  -- Architektur offen: Freigabe beliebiger Ordner (später Firmenkunden) NUR in dieser Test-Transaktion.
  update public.mailbox_provider_types set allowed_source_names = null where provider_type = 'microsoft_graph';
  -- Anderer Ordner → Delta-Stand zurückgesetzt.
  s := public.create_workspace_mailbox_oauth_state('00000000-0000-0000-0000-00000000a501', '00000000-0000-0000-0000-00000000a5a1', 'microsoft_graph', repeat('5', 64), repeat('v', 64), repeat('n', 32), 'schabi82@hotmail.de', 'folder', 'Anderer-Ordner', '2026-09-27T00:00:00Z');
  perform public.consume_workspace_mailbox_oauth_state(repeat('5', 64));
  perform public.complete_workspace_mailbox_oauth(s, 'schabi82@hotmail.de', 'ms-sub-1', 'platzhalter-rt-3');
  if (select sync_cursor from public.workspace_mailbox_connections where id = c) is not null then raise exception 'Cursor nicht zurueckgesetzt'; end if;

  -- Ordnerkennung nur mit gültigem Lease.
  v := public.claim_workspace_mailbox_sync(c, 300);
  perform public.set_workspace_mailbox_source_id(c, gen_random_uuid(), 'falsch');
  if (select mailbox_source_id from public.workspace_mailbox_connections where id = c) is not null then raise exception 'Ordner ohne Lease'; end if;
  perform public.set_workspace_mailbox_source_id(c, (v->'connection'->>'sync_lease_token')::uuid, 'AQMk-ordner');
  if (select mailbox_source_id from public.workspace_mailbox_connections where id = c) <> 'AQMk-ordner' then raise exception 'Ordner mit Lease'; end if;
  if v->'connection'->>'auth_mode' <> 'delegated' or v->'connection'->>'import_from' is null then raise exception 'Claim liefert Modus nicht: %', v; end if;

  -- O: rotiertes Refresh-Token nur mit gültigem Lease; nach Trennen kein neuer Zugang.
  if public.rotate_workspace_mailbox_credential(c, gen_random_uuid(), 'platzhalter-falsch') then raise exception 'Rotation ohne Lease'; end if;
  if not public.rotate_workspace_mailbox_credential(c, (v->'connection'->>'sync_lease_token')::uuid, 'platzhalter-rt-rotiert') then raise exception 'Rotation'; end if;
  if public.get_workspace_mailbox_credential(c) <> 'platzhalter-rt-rotiert' then raise exception 'Rotation Vault'; end if;
  delete from public.workspace_mailbox_credentials where connection_id = c;
  if public.rotate_workspace_mailbox_credential(c, (v->'connection'->>'sync_lease_token')::uuid, 'platzhalter-neu') then raise exception 'Rotation nach Trennen'; end if;
  if exists (select 1 from public.workspace_mailbox_credentials where connection_id = c) then raise exception 'Rotation legt Zugang an'; end if;
  if has_function_privilege('authenticated', 'public.rotate_workspace_mailbox_credential(uuid, uuid, text)', 'execute') then raise exception 'Rotation Rechte'; end if;

  -- Application-Verbindung unverändert.
  if not exists (select 1 from public.workspace_mailbox_connections where id = '00000000-0000-0000-0000-00000000c5a1' and auth_mode = 'application' and status = 'connected') then raise exception 'Application veraendert'; end if;
end;
$$;

select 'EMAIL-07E-MSA SQL OK';

rollback;
