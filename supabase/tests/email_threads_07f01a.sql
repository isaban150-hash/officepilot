-- E-MAIL 07F-01A — Laufzeittest Antworten + Gesprächsverläufe: eigene
-- Thread-ID, In-Reply-To, References, conversationId nur mit Teilnehmer,
-- kein Betreff-Merging, Antwort aus OfficeTakt (Thread, In-Reply-To,
-- References, Idempotenz), eingehende Antwort auf OfficeTakt-Mail inkl.
-- Zuordnung über den Verlauf, spätes Original, Dubletten, Neuversuch,
-- Verlauf lesen, Rechte, Normalisierung. Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     cat supabase/migrations/20261015120000_workspace_mailbox_oauth.sql; \
--     cat supabase/migrations/20261016120000_workspace_mailbox_auto_sync.sql; \
--     cat supabase/migrations/20261017120000_workspace_email_threads.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/email_threads_07f01a.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Kein Versand (Status wird direkt gesetzt).
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000f01a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000f01a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'f2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000f0a01', 'F1', '00000000-0000-0000-0000-0000000f01a1'),
       ('00000000-0000-0000-0000-0000000f0a02', 'F1-Fremd', '00000000-0000-0000-0000-0000000f01a2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f01a1', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000f0a02', '00000000-0000-0000-0000-0000000f01a2', 'owner', 'active');
insert into public.workspace_company_profiles (workspace_id, payload)
values ('00000000-0000-0000-0000-0000000f0a01', jsonb_build_object('companyName', 'Muster Bau', 'legalForm', 'GmbH', 'email', 'info@betrieb.invalid'))
on conflict (workspace_id) do update set payload = excluded.payload;
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000f0a01', 'kunde-a', '{"email":"einkauf@kunde-a.invalid"}'::jsonb);
insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-0000000f0a01', 'v-a', '{"customerId":"kunde-a"}'::jsonb);
insert into public.workspace_mailbox_connections (id, workspace_id, provider_type, mailbox_address, status)
values ('00000000-0000-0000-0000-0000000fc001', '00000000-0000-0000-0000-0000000f0a01', 'stub', 'info@betrieb.invalid', 'connected');

create temp table lease as
  select (public.claim_workspace_mailbox_sync('00000000-0000-0000-0000-0000000fc001', 300)->'connection'->>'sync_lease_token')::uuid as token;

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

create function pg_temp.mail(p_id text, p_from text, p_subject text, p_message_id text, p_conv text default null,
  p_in_reply_to text default null, p_references jsonb default '[]'::jsonb, p_reply_to jsonb default '[]'::jsonb, p_received text default null)
returns jsonb language sql as $p$
  select jsonb_build_object(
    'provider_message_id', p_id, 'internet_message_id', p_message_id, 'provider_thread_id', p_conv,
    'in_reply_to', p_in_reply_to, 'references', p_references, 'reply_to', p_reply_to,
    'from_address', p_from, 'from_name', 'Absender', 'to', jsonb_build_array('info@betrieb.invalid'), 'cc', '[]'::jsonb,
    'subject', p_subject, 'body_text', 'Guten Tag.', 'has_html', false, 'received_at', coalesce(p_received, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
$p$;

create function pg_temp.imp(p_mail jsonb) returns jsonb language sql as $p$
  select public.import_workspace_inbound_email('00000000-0000-0000-0000-0000000fc001', (select token from lease), p_mail, '[]'::jsonb);
$p$;

create function pg_temp.msg(p_id uuid) returns public.workspace_email_messages language sql as $p$
  select * from public.workspace_email_messages where id = p_id;
$p$;

-- Versand simulieren (kein Provider): queued → sending → provider_accepted mit Brevo-ID.
create function pg_temp.akzeptiere(p_id uuid, p_provider_id text) returns void language plpgsql as $p$
declare
  v jsonb;
begin
  v := public.claim_workspace_email_message_for_send(p_id, (select row_version from public.workspace_email_messages where id = p_id));
  perform public.update_workspace_email_message_status(p_id, 'provider_accepted', p_provider_id, null, null, null, (v->'message'->>'row_version')::bigint);
end;
$p$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000f01a1","role":"authenticated"}', true);

do $$
declare
  ws uuid := '00000000-0000-0000-0000-0000000f0a01';
  a public.workspace_email_messages;
  b public.workspace_email_messages;
  x public.workspace_email_messages;
  r public.workspace_email_messages;
  v jsonb;
  n integer;
begin
  -- Normalisierung (identisch zu emailThreadRules.ts)
  if public.email_normalize_message_id('  <AbC.1@Mail.X.de> ') <> 'abc.1@mail.x.de' then raise exception 'Normalisierung'; end if;
  if public.email_normalize_message_id('kein-at') is not null or public.email_normalize_message_id('<a b@x>') is not null or public.email_normalize_message_id(null) is not null then raise exception 'Normalisierung ungueltig'; end if;
  if public.email_normalize_message_id_list(array['<a@x>', 'b@x', '<A@X>', 'kaputt', '<c@x>'], 2) <> array['b@x', 'c@x'] then raise exception 'Liste %', public.email_normalize_message_id_list(array['<a@x>', 'b@x', '<A@X>', 'kaputt', '<c@x>'], 2); end if;

  -- 1. Neue eingehende Mail → eigener Verlauf; Message-ID + Reply-To gespeichert.
  v := pg_temp.imp(pg_temp.mail('p-a', 'fremd@unbekannt.invalid', 'Anfrage Bad', '<A1@Mail.invalid>', 'conv-1', null, '[]', '["Antwort@Unbekannt.invalid", "kaputt"]', '2026-01-01T08:00:00Z'));
  a := pg_temp.msg((v->>'message_id')::uuid);
  if v->>'thread_source' <> 'new' or a.thread_id is null or a.rfc_message_id <> 'a1@mail.invalid' then raise exception 'Import A %', v; end if;
  if a.reply_to_addresses <> array['antwort@unbekannt.invalid'] then raise exception 'Reply-To %', a.reply_to_addresses; end if;
  if a.assignment_status <> 'needs_review' then raise exception 'A Zuordnung'; end if;

  -- 2. Gleicher Betreff, anderer Absender, keine Bezüge → getrennt (kein Betreff-Merging).
  v := pg_temp.imp(pg_temp.mail('p-b', 'jemand@anders.invalid', 'Anfrage Bad', '<b1@mail.invalid>', 'conv-2'));
  b := pg_temp.msg((v->>'message_id')::uuid);
  if b.thread_id = a.thread_id then raise exception 'Betreff-Merging'; end if;
  -- Gleicher Betreff UND gleicher Absender, anderes Gespräch → ebenfalls getrennt.
  v := pg_temp.imp(pg_temp.mail('p-b2', 'fremd@unbekannt.invalid', 'Anfrage Bad', '<b2@mail.invalid>', 'conv-3'));
  if (pg_temp.msg((v->>'message_id')::uuid)).thread_id = a.thread_id then raise exception 'Betreff+Absender-Merging'; end if;

  -- 3. Antwort aus OfficeTakt auf A: gleicher Verlauf, In-Reply-To, References; keine erfundene Zuordnung.
  v := public.create_workspace_email_message(ws, 'reply-1', array['fremd@unbekannt.invalid'], '{}', '{}', 'Re: Anfrage Bad', 'Danke!', '[]'::jsonb, 'stub', null, null, a.id);
  r := pg_temp.msg((v->'message'->>'id')::uuid);
  if v->>'outcome' <> 'created' or r.thread_id <> a.thread_id or r.reply_to_message_id <> a.id or r.in_reply_to <> 'a1@mail.invalid'
     or r.references_ids <> array['a1@mail.invalid'] or r.customer_id is not null or r.vorgang_id is not null or r.direction <> 'outbound' or r.status <> 'queued' then
    raise exception 'Antwort %', v;
  end if;
  if r.rfc_message_id is not null then raise exception 'Message-ID erfunden'; end if;
  -- Idempotenz: gleiche Absicht → replayed; anderer Antwortbezug → Konflikt.
  v := public.create_workspace_email_message(ws, 'reply-1', array['fremd@unbekannt.invalid'], '{}', '{}', 'Re: Anfrage Bad', 'Danke!', '[]'::jsonb, 'stub', null, null, a.id);
  if v->>'outcome' <> 'replayed' then raise exception 'Replay'; end if;
  perform pg_temp.erwarte_fehler(format($f$select public.create_workspace_email_message(%L, 'reply-1', array['fremd@unbekannt.invalid'], '{}', '{}', 'Re: Anfrage Bad', 'Danke!', '[]'::jsonb, 'stub', null, null, %L)$f$, ws, b.id), 'Idempotenzkonflikt');
  -- Ohne Antwortbezug (07D-Aufruf mit 11 Parametern) unverändert: eigener Verlauf.
  v := public.create_workspace_email_message(ws, 'frei-1', array['kunde@example.invalid'], '{}', '{}', 'Frei', 'Text', '[]'::jsonb, 'stub', null, null);
  x := pg_temp.msg((v->'message'->>'id')::uuid);
  if x.reply_to_message_id is not null or x.thread_id = a.thread_id or x.in_reply_to is not null or x.references_ids <> '{}' then raise exception 'freie Mail'; end if;

  -- 4. Versand angenommen: RFC-Message-ID ist die vom Versanddienst gelieferte ID.
  perform pg_temp.akzeptiere(r.id, '<Brevo-1@Smtp-Relay.Mailin.fr>');
  r := pg_temp.msg(r.id);
  if r.rfc_message_id <> 'brevo-1@smtp-relay.mailin.fr' or r.provider_message_id <> '<Brevo-1@Smtp-Relay.Mailin.fr>' then raise exception 'RFC-ID ausgehend %', r.rfc_message_id; end if;
  -- rfc_message_id ist nicht direkt setzbar.
  update public.workspace_email_messages set rfc_message_id = 'gefaelscht@x.invalid' where id = r.id;
  if (pg_temp.msg(r.id)).rfc_message_id <> 'brevo-1@smtp-relay.mailin.fr' then raise exception 'rfc_message_id manipulierbar'; end if;

  -- 5. Kundenantwort auf die OfficeTakt-Mail: In-Reply-To → gleicher Verlauf, Eltern = Antwort.
  v := pg_temp.imp(pg_temp.mail('p-c', 'fremd@unbekannt.invalid', 'AW: Re: Anfrage Bad', '<c1@mail.invalid>', 'conv-x', '<brevo-1@smtp-relay.mailin.fr>', '["<a1@mail.invalid>", "<brevo-1@smtp-relay.mailin.fr>"]'));
  x := pg_temp.msg((v->>'message_id')::uuid);
  if v->>'thread_source' <> 'in_reply_to' or x.thread_id <> a.thread_id or x.reply_to_message_id <> r.id then raise exception 'In-Reply-To %', v; end if;

  -- 6. Nur References (unbekannte + bekannte) → Verlauf über die bekannte.
  v := pg_temp.imp(pg_temp.mail('p-d', 'fremd@unbekannt.invalid', 'Nachtrag', '<d1@mail.invalid>', null, '<unbekannt@nirgends.invalid>', '["<a1@mail.invalid>", "<unbekannt2@nirgends.invalid>"]'));
  if v->>'thread_source' <> 'references' or (pg_temp.msg((v->>'message_id')::uuid)).thread_id <> a.thread_id then raise exception 'References %', v; end if;

  -- 7. conversationId: nur, wenn der Absender Teilnehmer des Verlaufs ist.
  v := pg_temp.imp(pg_temp.mail('p-e', 'fremd@unbekannt.invalid', 'ohne Bezug', '<e1@mail.invalid>', 'conv-1'));
  if v->>'thread_source' <> 'provider_thread' or (pg_temp.msg((v->>'message_id')::uuid)).thread_id <> a.thread_id then raise exception 'conversationId Teilnehmer %', v; end if;
  v := pg_temp.imp(pg_temp.mail('p-f', 'fremder@dritter.invalid', 'Anfrage Bad', '<f1@mail.invalid>', 'conv-1'));
  if v->>'thread_source' <> 'new' or (pg_temp.msg((v->>'message_id')::uuid)).thread_id = a.thread_id then raise exception 'conversationId ohne Teilnehmer %', v; end if;

  -- 8. Dublette: derselbe Datensatz nur einmal, Verlauf unverändert.
  select count(*) into n from public.workspace_email_messages where workspace_id = ws;
  v := pg_temp.imp(pg_temp.mail('p-a', 'fremd@unbekannt.invalid', 'Anfrage Bad', '<A1@Mail.invalid>', 'conv-1'));
  if v->>'outcome' <> 'duplicate' or (select count(*) from public.workspace_email_messages where workspace_id = ws) <> n then raise exception 'Dublette'; end if;
  -- Gleiche Message-ID über andere Provider-Kennung → ebenfalls Dublette.
  v := pg_temp.imp(pg_temp.mail('p-a-kopie', 'fremd@unbekannt.invalid', 'Anfrage Bad', '<a1@mail.invalid>', 'conv-1'));
  if v->>'outcome' <> 'duplicate' then raise exception 'Dublette Message-ID'; end if;

  -- 9. Antwort mit Kontext → eingehende Kundenantwort übernimmt Kunde/Vorgang über den Verlauf.
  v := public.create_workspace_email_message(ws, 'kontext-1', array['x@partner.invalid'], '{}', '{}', 'Angebot', 'Anbei', '[]'::jsonb, 'stub', 'kunde-a', 'v-a');
  x := pg_temp.msg((v->'message'->>'id')::uuid);
  perform pg_temp.akzeptiere(x.id, '<brevo-2@relay.invalid>');
  v := pg_temp.imp(pg_temp.mail('p-g', 'x@partner.invalid', 'Re: Angebot', '<g1@mail.invalid>', null, '<brevo-2@relay.invalid>'));
  r := pg_temp.msg((v->>'message_id')::uuid);
  if r.thread_id <> x.thread_id or r.customer_id <> 'kunde-a' or r.vorgang_id <> 'v-a' or r.assignment_status <> 'assigned' or r.assignment_source <> 'auto_thread' then raise exception 'Zuordnung ueber Verlauf %', to_jsonb(r); end if;
  if not exists (select 1 from public.workspace_email_assignment_events e where e.message_id = r.id and e.source = 'auto_thread') then raise exception 'Audit auto_thread'; end if;
  -- Antwort auf eine unzugeordnete Mail erfindet keine Zuordnung (siehe Schritt 5).
  if (pg_temp.msg((select id from public.workspace_email_messages where provider_message_id = 'p-c'))).customer_id is not null then raise exception 'erfundene Zuordnung'; end if;

  -- 10. Spätes Original: Antwort kommt zuerst, das Original führt die Verläufe zusammen.
  v := pg_temp.imp(pg_temp.mail('p-h', 'spaet@kunde.invalid', 'Re: Frage', '<h1@mail.invalid>', null, '<spaet-original@mail.invalid>'));
  x := pg_temp.msg((v->>'message_id')::uuid);
  if v->>'thread_source' <> 'new' then raise exception 'H neu'; end if;
  v := pg_temp.imp(pg_temp.mail('p-o', 'info@betrieb.invalid', 'Frage', '<Spaet-Original@mail.invalid>'));
  r := pg_temp.msg((v->>'message_id')::uuid);
  if (pg_temp.msg(x.id)).thread_id <> r.thread_id or (pg_temp.msg(x.id)).reply_to_message_id <> r.id then raise exception 'spaetes Original'; end if;
  if (pg_temp.msg(x.id)).row_version <> x.row_version then raise exception 'row_version beim Zusammenfuehren veraendert'; end if;

  -- 11. Neuversuch bleibt im Verlauf und behält den Antwortbezug.
  v := public.create_workspace_email_message(ws, 'reply-2', array['fremd@unbekannt.invalid'], '{}', '{}', 'Re: Anfrage Bad', 'Nochmal', '[]'::jsonb, 'stub', null, null, a.id);
  x := pg_temp.msg((v->'message'->>'id')::uuid);
  v := public.claim_workspace_email_message_for_send(x.id, x.row_version);
  perform public.update_workspace_email_message_status(x.id, 'failed', null, 'provider', 'brevo_500', 'Fehler', (v->'message'->>'row_version')::bigint);
  v := public.retry_workspace_email_message(ws, 'reply-2-retry', x.id, false);
  r := pg_temp.msg((v->'message'->>'id')::uuid);
  if r.thread_id <> a.thread_id or r.reply_to_message_id <> a.id or r.in_reply_to <> 'a1@mail.invalid' or r.retry_of_message_id <> x.id then raise exception 'Neuversuch Verlauf'; end if;

  -- 12. Verlauf lesen: alle Nachrichten des Threads (ein- und ausgehend), älteste zuerst.
  v := public.get_workspace_email_thread(ws, a.id);
  if jsonb_array_length(v) < 6 then raise exception 'Verlauf Laenge %', jsonb_array_length(v); end if;
  if exists (select 1 from jsonb_array_elements(v) e where (e->>'thread_id')::uuid <> a.thread_id) then raise exception 'fremde Nachricht im Verlauf'; end if;
  if (v->0->>'id')::uuid <> a.id then raise exception 'Reihenfolge'; end if;
  if not exists (select 1 from jsonb_array_elements(v) e where e->>'direction' = 'outbound') or not exists (select 1 from jsonb_array_elements(v) e where e->>'direction' = 'inbound') then raise exception 'Richtungen'; end if;
  if public.get_workspace_email_thread(ws, gen_random_uuid()) <> '[]'::jsonb then raise exception 'unbekannte Nachricht'; end if;

  -- 13. Antwort auf Nachricht eines fremden Workspaces → abgelehnt.
  perform pg_temp.erwarte_fehler(format($f$select public.create_workspace_email_message(%L, 'reply-x', array['a@b.invalid'], '{}', '{}', 'Re: x', 'y', '[]'::jsonb, 'stub', null, null, %L)$f$, ws, gen_random_uuid()), 'Beantwortete Nachricht nicht gefunden');

  -- 14. Versandlimit zählt Antworten wie jede ausgehende Mail (unverändert).
  select count(*) into n from public.workspace_email_messages where workspace_id = ws and direction = 'outbound';
  if n < 5 then raise exception 'ausgehend %', n; end if;
end;
$$;

-- Rechte: fremder Nutzer sieht den Verlauf nicht; Thread-Auflösung nur Server.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000f01a2","role":"authenticated"}', true);
do $$
begin
  perform pg_temp.erwarte_fehler(
    format('select public.get_workspace_email_thread(%L, %L)', '00000000-0000-0000-0000-0000000f0a01', (select id from public.workspace_email_messages where provider_message_id = 'p-a')),
    'Kein Zugriff');
  if has_function_privilege('authenticated', 'public.email_resolve_thread(uuid, text, text[], uuid, text, text)', 'execute') then raise exception 'resolve fuer Clients'; end if;
  if not has_function_privilege('authenticated', 'public.get_workspace_email_thread(uuid, uuid)', 'execute') then raise exception 'thread lesen'; end if;
  if not has_function_privilege('authenticated', 'public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text, uuid)', 'execute') then raise exception 'create Rechte'; end if;
  if has_function_privilege('anon', 'public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text, uuid)', 'execute') then raise exception 'create anon'; end if;
  -- Jede Zeile hat einen Verlauf.
  if exists (select 1 from public.workspace_email_messages where thread_id is null) then raise exception 'thread_id fehlt'; end if;
end;
$$;

select 'EMAIL-07F-01A SQL OK';

rollback;
