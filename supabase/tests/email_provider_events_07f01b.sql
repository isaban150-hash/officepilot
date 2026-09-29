-- E-MAIL 07F-01B — Laufzeittest Provider-Zustellereignisse: Normalisierung
-- (accepted/delivered/deferred/bounced/rejected/complained), Rang und
-- Reihenfolge, Deduplizierung, unbekannte/mehrdeutige Message-IDs,
-- Workspace-Isolation, nachträgliche Zuordnung, Dokumentversand, Thread und
-- Versandstatus unverändert, kein automatischer Neuversuch, Verlauf, Rechte.
-- Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     cat supabase/migrations/20261015120000_workspace_mailbox_oauth.sql; \
--     cat supabase/migrations/20261016120000_workspace_mailbox_auto_sync.sql; \
--     cat supabase/migrations/20261017120000_workspace_email_threads.sql; \
--     cat supabase/migrations/20261018120000_workspace_email_provider_events.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/email_provider_events_07f01b.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Kein Versand (Status wird direkt gesetzt).
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000f01b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000f01b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000f0b01', 'B1', '00000000-0000-0000-0000-0000000f01b1'),
       ('00000000-0000-0000-0000-0000000f0b02', 'B2', '00000000-0000-0000-0000-0000000f01b2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f01b1', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000f0b02', '00000000-0000-0000-0000-0000000f01b2', 'owner', 'active');
insert into public.workspace_company_profiles (workspace_id, payload)
values ('00000000-0000-0000-0000-0000000f0b01', jsonb_build_object('companyName', 'Muster Bau', 'legalForm', 'GmbH', 'email', 'info@betrieb.invalid'))
on conflict (workspace_id) do update set payload = excluded.payload;
insert into public.workspace_mailbox_connections (id, workspace_id, provider_type, mailbox_address, status)
values ('00000000-0000-0000-0000-0000000fbc01', '00000000-0000-0000-0000-0000000f0b01', 'stub', 'info@betrieb.invalid', 'connected');

create temp table lease as
  select (public.claim_workspace_mailbox_sync('00000000-0000-0000-0000-0000000fbc01', 300)->'connection'->>'sync_lease_token')::uuid as token;

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

create function pg_temp.akzeptiere(p_id uuid, p_provider_id text) returns void language plpgsql as $p$
declare
  v jsonb;
begin
  v := public.claim_workspace_email_message_for_send(p_id, (select row_version from public.workspace_email_messages where id = p_id));
  perform public.update_workspace_email_message_status(p_id, 'provider_accepted', p_provider_id, null, null, null, (v->'message'->>'row_version')::bigint);
end;
$p$;

-- Webhook-Ereignis wie die Edge Function (Dedupe-Schlüssel beliebig, hier aus Text abgeleitet).
create function pg_temp.ev(p_message text, p_type text, p_state text, p_at timestamptz, p_key text default null, p_reason text default null) returns text language sql as $p$
  select public.record_email_provider_event('brevo', encode(sha256(convert_to(coalesce(p_key, p_message || '|' || p_type || '|' || p_at::text), 'UTF8')), 'hex'), p_message, p_type, p_state, p_reason, p_at)->>'outcome';
$p$;

create function pg_temp.msg(p_id uuid) returns public.workspace_email_messages language sql as $p$
  select * from public.workspace_email_messages where id = p_id;
$p$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000f01b1","role":"authenticated"}', true);

do $$
declare
  ws uuid := '00000000-0000-0000-0000-0000000f0b01';
  parent uuid;
  m public.workspace_email_messages;
  before public.workspace_email_messages;
  d uuid;
  v jsonb;
  n integer;
  t0 timestamptz := now() - interval '10 minutes';
begin
  -- Ausgangslage: eingehende Mail + Antwort aus OfficeTakt (Thread aus 07F-01A), übergeben an Brevo.
  v := public.import_workspace_inbound_email('00000000-0000-0000-0000-0000000fbc01', (select token from lease),
    jsonb_build_object('provider_message_id', 'p-1', 'internet_message_id', '<orig@kunde.invalid>', 'from_address', 'kunde@kunde.invalid', 'to', '["info@betrieb.invalid"]'::jsonb, 'cc', '[]'::jsonb, 'subject', 'Frage', 'body_text', 'x', 'received_at', '2026-09-01T08:00:00Z'), '[]'::jsonb);
  parent := (v->>'message_id')::uuid;
  v := public.create_workspace_email_message(ws, 'r-1', array['kunde@kunde.invalid'], '{}', '{}', 'Re: Frage', 'Antwort', '[]'::jsonb, 'brevo', null, null, parent);
  m := pg_temp.msg((v->'message'->>'id')::uuid);
  perform pg_temp.akzeptiere(m.id, '<A1.Brevo@smtp-relay.mailin.fr>');
  before := pg_temp.msg(m.id);
  if before.delivery_state is not null then raise exception 'Startzustand'; end if;
  select count(*) into n from public.workspace_email_messages;

  -- 1. accepted (request) → „übergeben"; 2. delivered.
  if pg_temp.ev('a1.brevo@smtp-relay.mailin.fr', 'request', 'accepted', t0) <> 'applied' or (pg_temp.msg(m.id)).delivery_state <> 'accepted' then raise exception 'accepted'; end if;
  if pg_temp.ev('<A1.Brevo@smtp-relay.mailin.fr>', 'delivered', 'delivered', t0 + interval '1 minute') <> 'applied' or (pg_temp.msg(m.id)).delivery_state <> 'delivered' then raise exception 'delivered'; end if;
  -- 8. Dublette: derselbe Webhook erneut → nichts doppelt.
  if pg_temp.ev('<A1.Brevo@smtp-relay.mailin.fr>', 'delivered', 'delivered', t0 + interval '1 minute') <> 'duplicate' then raise exception 'Dublette'; end if;
  if (select count(*) from public.workspace_email_provider_events where email_message_id = m.id) <> 2 then raise exception 'Historie doppelt'; end if;
  -- 9. Out-of-order: älteres „request" und verspätetes „deferred" stufen „delivered" nicht zurück.
  if pg_temp.ev('a1.brevo@smtp-relay.mailin.fr', 'request', 'accepted', t0 - interval '1 minute', 'anderer-schluessel') <> 'ignored_older' then raise exception 'altes request'; end if;
  if pg_temp.ev('a1.brevo@smtp-relay.mailin.fr', 'deferred', 'deferred', t0 + interval '30 seconds') <> 'ignored_older' or (pg_temp.msg(m.id)).delivery_state <> 'delivered' then raise exception 'deferred nach delivered'; end if;
  -- Späterer Bounce / Beschwerde gelten.
  if pg_temp.ev('a1.brevo@smtp-relay.mailin.fr', 'hard_bounce', 'bounced', t0 + interval '5 minutes', null, 'Mailbox <kunde@kunde.invalid> nicht vorhanden') <> 'applied' or (pg_temp.msg(m.id)).delivery_state <> 'bounced' then raise exception 'bounce nach delivered'; end if;
  if pg_temp.ev('a1.brevo@smtp-relay.mailin.fr', 'spam', 'complained', t0 + interval '6 minutes') <> 'applied' or (pg_temp.msg(m.id)).delivery_state <> 'complained' then raise exception 'complaint'; end if;
  if pg_temp.ev('a1.brevo@smtp-relay.mailin.fr', 'delivered', 'delivered', t0 + interval '7 minutes') <> 'ignored_older' then raise exception 'delivered nach complaint'; end if;
  if (pg_temp.msg(m.id)).delivery_reason <> 'spam' or (pg_temp.msg(m.id)).delivery_state_at <> t0 + interval '6 minutes' then raise exception 'Grund/Zeit'; end if;

  -- 16/17. Thread, Antwortbezug, Message-ID, Versandstatus und row_version unverändert; keine neue Nachricht.
  m := pg_temp.msg(m.id);
  if m.thread_id <> before.thread_id or m.reply_to_message_id is distinct from before.reply_to_message_id or m.rfc_message_id <> before.rfc_message_id
     or m.provider_message_id <> before.provider_message_id or m.status <> 'provider_accepted' or m.row_version <> before.row_version then
    raise exception 'Nachricht veraendert %', to_jsonb(m);
  end if;
  if (select count(*) from public.workspace_email_messages) <> n then raise exception 'neue Nachricht durch Statusupdate'; end if;
  -- 18. Kein automatischer Neuversuch nach Bounce/Beschwerde.
  if exists (select 1 from public.workspace_email_messages where retry_of_message_id = m.id) then raise exception 'automatischer Neuversuch'; end if;
  -- Grund bereinigt (keine Adresse).
  if exists (select 1 from public.workspace_email_provider_events where reason like '%@%') then raise exception 'Adresse im Grund'; end if;

  -- 3./4. deferred und bounce einzeln an einer zweiten Mail; 5. rejected.
  v := public.create_workspace_email_message(ws, 'f-2', array['x@kunde.invalid'], '{}', '{}', 'Frei', 'Text', '[]'::jsonb, 'brevo', null, null);
  perform pg_temp.akzeptiere((v->'message'->>'id')::uuid, '<m2@relay.invalid>');
  if pg_temp.ev('m2@relay.invalid', 'soft_bounce', 'deferred', t0) <> 'applied' or (pg_temp.msg((v->'message'->>'id')::uuid)).delivery_state <> 'deferred' then raise exception 'deferred'; end if;
  if pg_temp.ev('m2@relay.invalid', 'delivered', 'delivered', t0 + interval '2 minutes') <> 'applied' then raise exception 'deferred→delivered'; end if;
  v := public.create_workspace_email_message(ws, 'f-3', array['y@kunde.invalid'], '{}', '{}', 'Frei', 'Text', '[]'::jsonb, 'brevo', null, null);
  perform pg_temp.akzeptiere((v->'message'->>'id')::uuid, '<m3@relay.invalid>');
  if pg_temp.ev('m3@relay.invalid', 'blocked', 'rejected', t0) <> 'applied' or (pg_temp.msg((v->'message'->>'id')::uuid)).delivery_state <> 'rejected' then raise exception 'rejected'; end if;
  if pg_temp.ev('m3@relay.invalid', 'hard_bounce', 'bounced', t0 + interval '1 minute') <> 'ignored_older' then raise exception 'gleicher Rang'; end if;

  -- 10. Unbekannte Message-ID → nur protokolliert, ohne Workspace, nichts geändert.
  if pg_temp.ev('fremd@relay.invalid', 'delivered', 'delivered', t0) <> 'unmatched' then raise exception 'unmatched'; end if;
  if exists (select 1 from public.workspace_email_provider_events where provider_message_id = 'fremd@relay.invalid' and workspace_id is not null) then raise exception 'unmatched mit Workspace'; end if;

  -- 11. Falscher Anbieter, ungültige ID, unplausible Zeit → abgelehnt.
  perform pg_temp.erwarte_fehler($f$select public.record_email_provider_event('stub', repeat('a', 64), 'x@y.invalid', 'delivered', 'delivered', null, now())$f$, 'provider ungueltig');
  perform pg_temp.erwarte_fehler($f$select public.record_email_provider_event('brevo', repeat('b', 64), 'ohne-at', 'delivered', 'delivered', null, now())$f$, 'message_id ungueltig');
  perform pg_temp.erwarte_fehler($f$select public.record_email_provider_event('brevo', repeat('c', 64), 'x@y.invalid', 'delivered', 'delivered', null, now() + interval '3 days')$f$, 'event_at ungueltig');
  perform pg_temp.erwarte_fehler($f$select public.record_email_provider_event('brevo', repeat('d', 64), 'x@y.invalid', 'opened', 'opened', null, now())$f$, 'check');

  -- Ereignis vor der gespeicherten Message-ID → wird beim Speichern nachträglich zugeordnet.
  v := public.create_workspace_email_message(ws, 'f-4', array['z@kunde.invalid'], '{}', '{}', 'Frei', 'Text', '[]'::jsonb, 'brevo', null, null);
  if pg_temp.ev('spaet@relay.invalid', 'delivered', 'delivered', t0) <> 'unmatched' then raise exception 'vor Speicherung'; end if;
  perform pg_temp.akzeptiere((v->'message'->>'id')::uuid, '<Spaet@relay.invalid>');
  if (pg_temp.msg((v->'message'->>'id')::uuid)).delivery_state <> 'delivered' then raise exception 'nachtraegliche Zuordnung'; end if;
  if not exists (select 1 from public.workspace_email_provider_events where provider_message_id = 'spaet@relay.invalid' and outcome = 'applied' and email_message_id = (v->'message'->>'id')::uuid) then raise exception 'nachtraeglich protokolliert'; end if;

  -- 15. Dokumentversand: gleiche Normalisierung, Versandstatus bleibt.
  insert into public.workspace_document_deliveries (workspace_id, client_delivery_id, document_kind, recipient_email, subject, body_text, provider, provider_message_id, status, requested_by, provider_accepted_at)
  values (ws, 'dd-1', 'other', 'kunde@kunde.invalid', 'Rechnung', 'Text', 'brevo', '<DOC-1@smtp-relay.mailin.fr>', 'provider_accepted', '00000000-0000-0000-0000-0000000f01b1', now())
  returning id into d;
  if pg_temp.ev('doc-1@smtp-relay.mailin.fr', 'delivered', 'delivered', t0) <> 'applied' then raise exception 'Dokument delivered'; end if;
  if not exists (select 1 from public.workspace_document_deliveries where id = d and delivery_state = 'delivered' and status = 'provider_accepted' and row_version = 1) then raise exception 'Dokument Zustand'; end if;
  if pg_temp.ev('doc-1@smtp-relay.mailin.fr', 'hard_bounce', 'bounced', t0 + interval '1 minute') <> 'applied' then raise exception 'Dokument bounce'; end if;
  if exists (select 1 from public.workspace_document_deliveries where retry_of_delivery_id = d) then raise exception 'Dokument Neuversuch'; end if;

  -- Mehrdeutig (dieselbe ID an zwei Versandzeilen) → nicht angewendet.
  insert into public.workspace_document_deliveries (workspace_id, client_delivery_id, document_kind, recipient_email, subject, body_text, provider, provider_message_id, status, requested_by, provider_accepted_at)
  values (ws, 'dd-2', 'other', 'a@kunde.invalid', 'A', 'T', 'brevo', '<dup@relay.invalid>', 'provider_accepted', '00000000-0000-0000-0000-0000000f01b1', now()),
         ('00000000-0000-0000-0000-0000000f0b02', 'dd-3', 'other', 'b@kunde.invalid', 'B', 'T', 'brevo', '<dup@relay.invalid>', 'provider_accepted', '00000000-0000-0000-0000-0000000f01b2', now());
  if pg_temp.ev('dup@relay.invalid', 'delivered', 'delivered', t0) <> 'ambiguous' then raise exception 'ambiguous'; end if;
  if exists (select 1 from public.workspace_document_deliveries where provider_message_id = '<dup@relay.invalid>' and delivery_state is not null) then raise exception 'ambiguous angewendet'; end if;

  -- 13. Workspace-Isolation: Ereignis eines anderen Workspaces berührt nur dessen Zeile.
  insert into public.workspace_document_deliveries (workspace_id, client_delivery_id, document_kind, recipient_email, subject, body_text, provider, provider_message_id, status, requested_by, provider_accepted_at)
  values ('00000000-0000-0000-0000-0000000f0b02', 'dd-4', 'other', 'c@kunde.invalid', 'C', 'T', 'brevo', '<b2only@relay.invalid>', 'provider_accepted', '00000000-0000-0000-0000-0000000f01b2', now());
  if pg_temp.ev('b2only@relay.invalid', 'delivered', 'delivered', t0) <> 'applied' then raise exception 'B2'; end if;
  if exists (select 1 from public.workspace_email_provider_events where provider_message_id = 'b2only@relay.invalid' and workspace_id <> '00000000-0000-0000-0000-0000000f0b02') then raise exception 'Isolation'; end if;

  -- Verlauf (älteste zuerst) für Mitglieder.
  v := public.list_workspace_email_delivery_events(ws, m.id, null);
  if (select array_agg(e->>'state' order by ord) from jsonb_array_elements(v) with ordinality as t(e, ord)) <> array['accepted', 'accepted', 'deferred', 'delivered', 'bounced', 'complained', 'delivered'] then raise exception 'Verlauf %', v; end if;
  if (select count(*) from jsonb_array_elements(v) e where (e->>'applied')::boolean) <> 4 then raise exception 'angewendete Schritte'; end if;
  perform pg_temp.erwarte_fehler(format('select public.list_workspace_email_delivery_events(%L, null, null)', ws), 'genau eine Nachricht');
end;
$$;

-- Rechte: fremder Workspace sieht nichts; Webhook-Einstieg nur Server; Tabelle nicht schreibbar.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000f01b2","role":"authenticated"}', true);
do $$
begin
  perform pg_temp.erwarte_fehler(format('select public.list_workspace_email_delivery_events(%L, %L, null)', '00000000-0000-0000-0000-0000000f0b01', gen_random_uuid()), 'Kein Zugriff');
  if has_function_privilege('authenticated', 'public.record_email_provider_event(text, text, text, text, text, text, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.record_email_provider_event(text, text, text, text, text, text, timestamptz)', 'execute') then raise exception 'record fuer Clients'; end if;
  if not has_function_privilege('service_role', 'public.record_email_provider_event(text, text, text, text, text, text, timestamptz)', 'execute') then raise exception 'record service_role'; end if;
  if has_function_privilege('authenticated', 'public.email_provider_apply_event(uuid)', 'execute') then raise exception 'apply fuer Clients'; end if;
  if has_table_privilege('authenticated', 'public.workspace_email_provider_events', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_email_provider_events', 'update')
     or has_table_privilege('anon', 'public.workspace_email_provider_events', 'select') then raise exception 'Tabellenrechte'; end if;
  if not has_function_privilege('authenticated', 'public.list_workspace_email_delivery_events(uuid, uuid, uuid)', 'execute') then raise exception 'Verlauf lesen'; end if;
end;
$$;

-- RLS: Mitglied B sieht nur Ereignisse von B (nie unzugeordnete).
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_email_provider_events where workspace_id is distinct from '00000000-0000-0000-0000-0000000f0b02') then raise exception 'RLS'; end if;
  if (select count(*) from public.workspace_email_provider_events) <> 1 then raise exception 'RLS B sieht eigenes nicht'; end if;
end;
$$;
reset role;

select 'EMAIL-07F-01B SQL OK';

rollback;
