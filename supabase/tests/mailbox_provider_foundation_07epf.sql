-- E-MAIL-07E-PF — Laufzeittest providerneutrale Postfach-Grundlage:
-- Provider-Register, Anmeldeart/Quellart je Provider, gesperrter OAuth-Start
-- für google_gmail/inbound_channel, generischer OAuth-Ablauf für ein Label
-- (Register-Freigabe nur in dieser Transaktion), Kontowechsel unter derselben
-- Adresse, Purge abgelaufener Zustände/vorläufiger Zugänge, Rechte. Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     cat supabase/migrations/20261015120000_workspace_mailbox_oauth.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/mailbox_provider_foundation_07epf.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal. Keine echten Zugangsdaten (Platzhalter). Exit-Code 0 = OK.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000f0a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pf1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000f001', 'PF', '00000000-0000-0000-0000-00000000f0a1');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f0a1', 'owner', 'active');

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

create function pg_temp.verbindung(p_provider text, p_auth text, p_kind text, p_name text, p_from timestamptz, p_address text)
returns void language sql as $p$
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_source_kind, mailbox_source_name, import_from, mailbox_address, status)
  values ('00000000-0000-0000-0000-00000000f001', p_provider, p_auth, p_kind, p_name, p_from, p_address, 'connected');
$p$;

create function pg_temp.start(p_provider text, p_hash_char text, p_kind text, p_name text, p_expected text)
returns uuid language sql as $p$
  select public.create_workspace_mailbox_oauth_state('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f0a1', p_provider,
    repeat(p_hash_char, 64), repeat('v', 64), repeat('n', 32), p_expected, p_kind, p_name, '2026-09-27T00:00:00Z', 600);
$p$;

-- 1. Register: genau die vorgesehenen Anbieter; Microsoft-Start frei, Google/Inbound gesperrt.
do $$
begin
  if (select array_agg(provider_type order by provider_type) from public.mailbox_provider_types)
     <> array['google_gmail', 'imap', 'inbound_channel', 'microsoft_graph', 'stub'] then
    raise exception 'Register: %', (select array_agg(provider_type) from public.mailbox_provider_types);
  end if;
  if not exists (select 1 from public.mailbox_provider_types where provider_type = 'microsoft_graph' and oauth_start_enabled and auth_modes = array['application', 'delegated'] and source_kinds = array['folder']) then raise exception 'Register Microsoft'; end if;
  if not exists (select 1 from public.mailbox_provider_types where provider_type = 'google_gmail' and not oauth_start_enabled and auth_modes = array['delegated'] and source_kinds = array['label'] and channel_kind = 'pull') then raise exception 'Register Gmail'; end if;
  if not exists (select 1 from public.mailbox_provider_types where provider_type = 'inbound_channel' and not oauth_start_enabled and cardinality(auth_modes) = 0 and channel_kind = 'push') then raise exception 'Register Inbound'; end if;
  if has_table_privilege('authenticated', 'public.mailbox_provider_types', 'select') or has_table_privilege('anon', 'public.mailbox_provider_types', 'select') then raise exception 'Register Rechte'; end if;
  -- OAuth-Freigabe ohne delegierte Anmeldung ist unmöglich.
  perform pg_temp.erwarte_fehler($q$update public.mailbox_provider_types set oauth_start_enabled = true where provider_type = 'inbound_channel'$q$, 'mailbox_provider_types_oauth_check');
end;
$$;

-- 2. Verbindung: Anmeldeart/Quellart je Provider, unbekannter Provider abgelehnt.
do $$
begin
  perform pg_temp.verbindung('microsoft_graph', 'application', null, null, null, 'app@firma.invalid');
  perform pg_temp.verbindung('microsoft_graph', 'delegated', 'folder', 'OfficeTakt-Test', now(), 'ms@hotmail.invalid');
  perform pg_temp.verbindung('google_gmail', 'delegated', 'label', 'OfficeTakt', now(), 'x@gmail.invalid');
  perform pg_temp.verbindung('inbound_channel', null, null, null, null, 'eingang@betrieb.invalid');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('google_gmail', 'application', 'label', 'L', now(), 'a@gmail.invalid')$q$, 'mailbox_auth_mode_invalid');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('google_gmail', 'delegated', 'folder', 'F', now(), 'b@gmail.invalid')$q$, 'mailbox_source_kind_invalid');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('google_gmail', 'delegated', null, null, null, 'c@gmail.invalid')$q$, 'mailbox_source_required');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('google_gmail', 'delegated', 'label', 'L', null, 'd@gmail.invalid')$q$, 'mailbox_source_required');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('microsoft_graph', 'delegated', 'label', 'L', now(), 'e@hotmail.invalid')$q$, 'mailbox_source_kind_invalid');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('inbound_channel', 'delegated', null, null, null, 'f@betrieb.invalid')$q$, 'mailbox_auth_mode_invalid');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('gmail', null, null, null, null, 'g@gmail.invalid')$q$, 'provider_fk');
  perform pg_temp.erwarte_fehler($q$select pg_temp.verbindung('outlook_fake', null, null, null, null, 'h@x.invalid')$q$, 'provider_fk');
  -- Nachträgliche Änderung wird ebenso geprüft.
  perform pg_temp.erwarte_fehler($q$update public.workspace_mailbox_connections set mailbox_source_kind = 'folder' where mailbox_address = 'x@gmail.invalid'$q$, 'mailbox_source_kind_invalid');
  perform pg_temp.erwarte_fehler($q$update public.workspace_mailbox_connections set auth_mode = null where mailbox_address = 'app@firma.invalid'$q$, 'mailbox_auth_mode_invalid');
  -- Eingehende Mail: Provider-Format statt zweiter Liste; Ausgang unverändert.
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'workspace_email_messages_provider_check')
     !~ 'outbound.*brevo.*stub.*inbound.*provider ~' then
    raise exception 'Provider-Pruefung Nachrichten: %', (select pg_get_constraintdef(oid) from pg_constraint where conname = 'workspace_email_messages_provider_check');
  end if;
end;
$$;

-- 3. OAuth-Start: Google/Inbound gesperrt, falsche Quellart abgelehnt.
do $$
begin
  perform pg_temp.erwarte_fehler($q$select pg_temp.start('google_gmail', '1', 'label', 'OfficeTakt', 'x@gmail.invalid')$q$, 'provider_not_available');
  perform pg_temp.erwarte_fehler($q$select pg_temp.start('inbound_channel', '2', 'label', 'X', 'x@betrieb.invalid')$q$, 'provider_not_available');
  perform pg_temp.erwarte_fehler($q$select pg_temp.start('unbekannt', '3', 'folder', 'X', 'x@betrieb.invalid')$q$, 'provider_not_available');
  perform pg_temp.erwarte_fehler($q$select pg_temp.start('microsoft_graph', '4', 'label', 'X', 'x@hotmail.invalid')$q$, 'mailbox_source_kind_invalid');
  if exists (select 1 from public.workspace_mailbox_oauth_states) then raise exception 'Start trotz Sperre'; end if;
end;
$$;

-- 4. Generischer Ablauf für einen zweiten Provider (Freigabe NUR in dieser Test-Transaktion):
--    Label-Quelle, Konto-Kennung, Kontowechsel unter derselben Adresse → Bestätigung.
update public.mailbox_provider_types set oauth_start_enabled = true where provider_type = 'google_gmail';
do $$
declare
  s uuid;
  v jsonb;
  c uuid;
begin
  s := pg_temp.start('google_gmail', 'a', 'label', 'OfficeTakt', 'pilot@gmail.invalid');
  v := public.consume_workspace_mailbox_oauth_state(repeat('a', 64));
  if v->'state'->>'provider_type' <> 'google_gmail' or v->'state'->>'source_kind' <> 'label' then raise exception 'Zustand: %', v; end if;
  v := public.complete_workspace_mailbox_oauth(s, 'Pilot@Gmail.invalid', 'google-sub-1', 'platzhalter-g1');
  c := (v->>'connection_id')::uuid;
  if v->>'outcome' <> 'connected' or not exists (select 1 from public.workspace_mailbox_connections where id = c and provider_type = 'google_gmail'
      and auth_mode = 'delegated' and mailbox_source_kind = 'label' and mailbox_source_name = 'OfficeTakt' and provider_account_subject = 'google-sub-1') then
    raise exception 'Gmail verbunden: %', v;
  end if;

  -- Gleiche Adresse, gleiches Konto → direkt verbunden (Neuverbinden).
  s := pg_temp.start('google_gmail', 'b', 'label', 'OfficeTakt', 'pilot@gmail.invalid');
  perform public.consume_workspace_mailbox_oauth_state(repeat('b', 64));
  if public.complete_workspace_mailbox_oauth(s, 'pilot@gmail.invalid', 'google-sub-1', 'platzhalter-g2')->>'outcome' <> 'connected' then raise exception 'Neuverbinden'; end if;
  if public.get_workspace_mailbox_credential(c) <> 'platzhalter-g2' then raise exception 'Neuverbinden Vault'; end if;

  -- Gleiche Adresse, ANDERES Konto → nicht still überschreiben.
  s := pg_temp.start('google_gmail', 'c', 'label', 'OfficeTakt', 'pilot@gmail.invalid');
  perform public.consume_workspace_mailbox_oauth_state(repeat('c', 64));
  v := public.complete_workspace_mailbox_oauth(s, 'pilot@gmail.invalid', 'google-sub-ANDERS', 'platzhalter-g3');
  if v->>'outcome' <> 'confirm_required' or v->>'reason' <> 'account_changed' then raise exception 'Kontowechsel: %', v; end if;
  if public.get_workspace_mailbox_credential(c) <> 'platzhalter-g2' then raise exception 'Kontowechsel hat Zugang ersetzt'; end if;
  if (select provider_account_subject from public.workspace_mailbox_connections where id = c) <> 'google-sub-1' then raise exception 'Kontowechsel hat Kennung ersetzt'; end if;
end;
$$;

-- Bestätigung durch den Nutzer übernimmt das neue Konto.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f0a1","role":"authenticated"}', true);
do $$
declare
  ws uuid := '00000000-0000-0000-0000-00000000f001';
  s uuid := (select id from public.workspace_mailbox_oauth_states where state_hash = repeat('c', 64));
  v jsonb;
  c uuid := (select id from public.workspace_mailbox_connections where mailbox_address = 'pilot@gmail.invalid');
begin
  v := public.get_workspace_mailbox_oauth_pending(ws, s);
  if v->>'reason' <> 'account_changed' or v->>'provider_type' <> 'google_gmail' or v->>'source_kind' <> 'label' or v->>'source_name' <> 'OfficeTakt' then raise exception 'Pending: %', v; end if;
  if v::text like '%google-sub%' or v::text like '%platzhalter%' then raise exception 'Pending Leck: %', v; end if;
  perform public.confirm_workspace_mailbox_oauth_pending(ws, s);
  if (select provider_account_subject from public.workspace_mailbox_connections where id = c) <> 'google-sub-ANDERS' then raise exception 'Bestaetigt: Kennung'; end if;
  if public.get_workspace_mailbox_credential(c) <> 'platzhalter-g3' then raise exception 'Bestaetigt: Vault'; end if;
  -- Postfachliste: neutrale Quelle, keine Konto-Kennung nach außen.
  v := public.list_workspace_mailbox_connections(ws);
  if v::text like '%google-sub%' or v::text like '%provider_account_subject%' then raise exception 'Liste Leck'; end if;
  if (select count(*) from jsonb_array_elements(v) e where e->>'provider_type' = 'google_gmail' and e->>'mailbox_source_kind' = 'label') <> 2 then raise exception 'Liste Gmail: %', v; end if;
end;
$$;
reset role;

-- 5. Purge: abgelaufene vorläufige Zugänge sofort, alte Zustände nach Frist; laufende bleiben.
do $$
declare
  s_pending uuid;
  s_live uuid;
  s_old uuid;
  v_secret uuid;
  v jsonb;
begin
  -- Offene Bestätigung mit abgelaufener Frist.
  s_pending := pg_temp.start('microsoft_graph', 'd', 'folder', 'OfficeTakt-Test', 'soll@hotmail.invalid');
  perform public.consume_workspace_mailbox_oauth_state(repeat('d', 64));
  perform public.complete_workspace_mailbox_oauth(s_pending, 'ist@hotmail.invalid', 'ms-x', 'platzhalter-pending');
  v_secret := (select pending_secret_id from public.workspace_mailbox_oauth_states where id = s_pending);
  -- Laufender Start (noch nicht abgelaufen).
  s_live := pg_temp.start('microsoft_graph', 'e', 'folder', 'OfficeTakt-Test', 'live@hotmail.invalid');
  -- Uralter Zustand.
  s_old := pg_temp.start('microsoft_graph', 'f', 'folder', 'OfficeTakt-Test', 'alt@hotmail.invalid');
  -- Fristen erst jetzt ablaufen lassen (jeder Start räumt bereits nebenbei auf).
  if not exists (select 1 from vault.secrets where id = v_secret) then raise exception 'Purge-Vorbedingung: offener Zugang fehlt'; end if;
  update public.workspace_mailbox_oauth_states set pending_until = now() - interval '1 minute' where id = s_pending;
  update public.workspace_mailbox_oauth_states set expires_at = now() - interval '3 hours' where id = s_old;

  v := public.purge_expired_workspace_mailbox_oauth_states();
  if (v->>'pending_secrets_deleted')::int < 1 or (v->>'states_deleted')::int < 1 then raise exception 'Purge: %', v; end if;
  if exists (select 1 from vault.secrets where id = v_secret) then raise exception 'Purge: vorlaeufiger Zugang bleibt'; end if;
  if (select outcome from public.workspace_mailbox_oauth_states where id = s_pending) <> 'failed' then raise exception 'Purge: pending nicht failed'; end if;
  if not exists (select 1 from public.workspace_mailbox_oauth_states where id = s_live) then raise exception 'Purge: laufender Zustand geloescht'; end if;
  if exists (select 1 from public.workspace_mailbox_oauth_states where id = s_old) then raise exception 'Purge: alter Zustand bleibt'; end if;
  -- Nach Ablauf der Frist wird auch der fehlgeschlagene Zustand entfernt; zweiter Lauf ist idempotent.
  update public.workspace_mailbox_oauth_states set expires_at = now() - interval '3 hours', pending_until = now() - interval '3 hours' where id = s_pending;
  perform public.purge_expired_workspace_mailbox_oauth_states();
  if exists (select 1 from public.workspace_mailbox_oauth_states where id = s_pending) then raise exception 'Purge: pending-Zustand bleibt'; end if;
  v := public.purge_expired_workspace_mailbox_oauth_states();
  if (v->>'states_deleted')::int <> 0 or (v->>'pending_secrets_deleted')::int <> 0 then raise exception 'Purge nicht idempotent: %', v; end if;
  -- Nur der Server darf aufräumen.
  if has_function_privilege('authenticated', 'public.purge_expired_workspace_mailbox_oauth_states(interval)', 'execute')
     or has_function_privilege('anon', 'public.purge_expired_workspace_mailbox_oauth_states(interval)', 'execute')
     or not has_function_privilege('service_role', 'public.purge_expired_workspace_mailbox_oauth_states(interval)', 'execute') then
    raise exception 'Purge Rechte';
  end if;
end;
$$;

select 'EMAIL-07E-PF SQL OK';

rollback;
