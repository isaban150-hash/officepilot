-- E-MAIL-07D — Laufzeittest freie Geschaefts-E-Mail (Tabellen, RPCs, Grenzen,
-- Claim/Unknown/Retry). Isoliert: Migration + Test in EINER Transaktion, am
-- Ende Rollback:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/email_messages_07d.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Gilt auch nach 20261017120000 (07F-01A): Migrationen 12..17 vor dem Test einspielen.
--
-- Nur lokal, niemals --linked oder remote. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'mail-07d@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000007d2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-07d@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000d07d1', 'Mail-07D', '00000000-0000-0000-0000-0000000007d1'),
       ('00000000-0000-0000-0000-0000000d07d2', 'Fremd-07D', '00000000-0000-0000-0000-0000000007d2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000d07d1', '00000000-0000-0000-0000-0000000007d1', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000d07d2', '00000000-0000-0000-0000-0000000007d2', 'owner', 'active');

insert into public.workspace_company_profiles (workspace_id, payload)
values ('00000000-0000-0000-0000-0000000d07d1', jsonb_build_object('companyName', 'Muster Bau', 'legalForm', 'GmbH', 'email', 'Info@Muster-Bau.example'))
on conflict (workspace_id) do update set payload = excluded.payload;

insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000d07d1', 'kunde-a', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d07d1', 'kunde-b', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d07d2', 'kunde-fremd', '{}'::jsonb);
insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-0000000d07d1', 'vorgang-a', '{"customerId":"kunde-a"}'::jsonb),
       ('00000000-0000-0000-0000-0000000d07d1', 'vorgang-ohne', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d07d2', 'vorgang-fremd', '{}'::jsonb);

-- Anhaenge im privaten Bucket (Metadaten wie die Storage-API sie schreibt).
insert into storage.objects (bucket_id, name, metadata)
values ('email-attachments', '00000000-0000-0000-0000-0000000d07d1/' || repeat('a', 64) || '.pdf', '{"size": 1000}'::jsonb),
       ('email-attachments', '00000000-0000-0000-0000-0000000d07d1/' || repeat('b', 64) || '.png', '{"size": 2000}'::jsonb),
       ('email-attachments', '00000000-0000-0000-0000-0000000d07d1/' || repeat('c', 64) || '.pdf', '{"size": 4194304}'::jsonb),
       ('email-attachments', '00000000-0000-0000-0000-0000000d07d1/' || repeat('d', 64) || '.pdf', '{"size": 4194304}'::jsonb),
       ('email-attachments', '00000000-0000-0000-0000-0000000d07d1/' || repeat('e', 64) || '.pdf', '{"size": 4194304}'::jsonb),
       ('email-attachments', '00000000-0000-0000-0000-0000000d07d2/' || repeat('f', 64) || '.pdf', '{"size": 1000}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007d1","role":"authenticated"}', true);

create function pg_temp.att(p_char text, p_ext text, p_size bigint, p_name text default null, p_ws text default '00000000-0000-0000-0000-0000000d07d1')
returns jsonb language sql as $p$
  select jsonb_build_object(
    'storage_path', p_ws || '/' || repeat(p_char, 64) || '.' || p_ext,
    'sha256', repeat(p_char, 64),
    'filename', coalesce(p_name, 'Datei.' || p_ext),
    'mime_type', public.email_attachment_mime_for_extension(p_ext),
    'size_bytes', p_size);
$p$;

create function pg_temp.lege_an(
  p_client text,
  p_to text[] default array['kunde@example.invalid'],
  p_cc text[] default '{}',
  p_bcc text[] default '{}',
  p_attachments jsonb default '[]'::jsonb,
  p_customer text default null,
  p_vorgang text default null,
  p_ws uuid default '00000000-0000-0000-0000-0000000d07d1'
) returns jsonb language sql as $p$
  select public.create_workspace_email_message(p_ws, p_client, p_to, p_cc, p_bcc, 'Betreff', 'Guten Tag', p_attachments, 'stub', p_customer, p_vorgang);
$p$;

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

do $$
declare
  v jsonb;
  v2 jsonb;
  m public.workspace_email_messages;
  n integer;
begin
  -- A: ohne Kontext, Absender-Snapshot aus dem Firmenprofil.
  v := pg_temp.lege_an('msg-a');
  if v->>'outcome' <> 'created' or v->'message'->>'customer_id' is not null or v->'message'->>'vorgang_id' is not null then
    raise exception 'A: %', v;
  end if;
  if v->'message'->>'sender_name' <> 'Muster Bau GmbH' or v->'message'->>'reply_to_email' <> 'info@muster-bau.example' or v->'message'->>'status' <> 'queued' then
    raise exception 'A Absender/Status: %', v;
  end if;

  -- B: nur Kunde.
  v := pg_temp.lege_an('msg-b', p_customer => 'kunde-b');
  if v->'message'->>'customer_id' <> 'kunde-b' then raise exception 'B: %', v; end if;

  -- C: nur Vorgang -> Kunde wird vom Vorgang abgeleitet.
  v := pg_temp.lege_an('msg-c', p_vorgang => 'vorgang-a');
  if v->'message'->>'customer_id' <> 'kunde-a' or v->'message'->>'vorgang_id' <> 'vorgang-a' then raise exception 'C: %', v; end if;

  -- D: Kunde + Vorgang passend; Vorgang ohne Kunde nimmt jeden Kunden.
  v := pg_temp.lege_an('msg-d', p_customer => 'kunde-a', p_vorgang => 'vorgang-a');
  if v->'message'->>'customer_id' <> 'kunde-a' then raise exception 'D: %', v; end if;
  v := pg_temp.lege_an('msg-d2', p_customer => 'kunde-b', p_vorgang => 'vorgang-ohne');
  if v->'message'->>'customer_id' <> 'kunde-b' or v->'message'->>'vorgang_id' <> 'vorgang-ohne' then raise exception 'D2: %', v; end if;

  -- E: Widerspruch Kunde <-> Vorgang.
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-e', p_customer => 'kunde-b', p_vorgang => 'vorgang-a')$q$, 'Kunde passt nicht zum Vorgang');
  -- F: fremde/unbekannte Kennungen.
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-f1', p_customer => 'kunde-fremd')$q$, 'customer_id gehoert nicht zum Workspace');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-f2', p_vorgang => 'vorgang-fremd')$q$, 'vorgang_id gehoert nicht zum Workspace');
  -- Fremder Workspace ueberhaupt.
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-f3', p_ws => '00000000-0000-0000-0000-0000000d07d2')$q$, 'Kein Zugriff');

  -- Empfaenger: normalisiert, Dubletten ueber TO/CC/BCC entfernt.
  v := pg_temp.lege_an('msg-r', array[' A@Example.invalid ', 'a@example.invalid', ''], array['b@example.invalid', 'A@example.invalid'], array['c@example.invalid', 'b@example.invalid', 'a@example.invalid']);
  if v->'message'->'to_recipients' <> '["a@example.invalid"]'::jsonb
     or v->'message'->'cc_recipients' <> '["b@example.invalid"]'::jsonb
     or v->'message'->'bcc_recipients' <> '["c@example.invalid"]'::jsonb then
    raise exception 'Empfaenger: %', v;
  end if;
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-r2', array['kein-at'])$q$, 'An enthaelt eine ungueltige Adresse');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-r3', array['a@example.invalid'], array['x@y'])$q$, 'Cc enthaelt');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-r4', array['a@example.invalid'], '{}', array['x y@example.invalid'])$q$, 'Bcc enthaelt');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-r5', array[]::text[], array['b@example.invalid'])$q$, 'mindestens ein Empfaenger');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-r6', array['a@example.invalid;b@example.invalid'])$q$, 'ungueltige Adresse');
  perform pg_temp.erwarte_fehler(
    $q$select pg_temp.lege_an('msg-r7', (select array_agg('p' || g || '@example.invalid') from generate_series(1, 21) g))$q$, 'Zu viele Empfaenger');

  -- Mehrere Anhaenge, Reihenfolge und Metadaten.
  v := pg_temp.lege_an('msg-att', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 1000, 'Angebot Nr. 1.pdf'), pg_temp.att('b', 'png', 2000, 'Foto.PNG')));
  if jsonb_array_length(v->'message'->'attachments') <> 2
     or v->'message'->'attachments'->0->>'filename' <> 'Angebot Nr. 1.pdf'
     or v->'message'->'attachments'->1->>'mime_type' <> 'image/png' then
    raise exception 'Anhaenge: %', v;
  end if;
  -- Typ, Name, Pfad, Groesse, Summe, fremder Workspace, fehlend.
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t1', p_attachments => jsonb_build_array(jsonb_set(pg_temp.att('a', 'pdf', 1000), '{mime_type}', '"application/x-msdownload"')))$q$, 'Dateityp nicht erlaubt');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t2', p_attachments => jsonb_build_array(jsonb_set(pg_temp.att('a', 'pdf', 1000), '{storage_path}', '"00000000-0000-0000-0000-0000000d07d1/aaaa.exe"')))$q$, 'Speicherpfad ungueltig');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t3', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 1000, 'virus.exe')))$q$, 'Dateiname ungueltig');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t4', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 1000, '../x.pdf')))$q$, 'Dateiname ungueltig');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t5', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 4194305)))$q$, 'Datei zu gross');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t6', p_attachments => jsonb_build_array(pg_temp.att('c', 'pdf', 4194304), pg_temp.att('d', 'pdf', 4194304), pg_temp.att('e', 'pdf', 4194304)))$q$, 'zusammen zu gross');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t7', p_attachments => jsonb_build_array(pg_temp.att('f', 'pdf', 1000, null, '00000000-0000-0000-0000-0000000d07d2')))$q$, 'Speicherpfad ungueltig');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t8', p_attachments => jsonb_build_array(jsonb_set(pg_temp.att('a', 'pdf', 1000), '{sha256}', to_jsonb(repeat('9', 64)))))$q$, 'Pruefwert');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t9', p_attachments => jsonb_build_array(pg_temp.att('0', 'pdf', 1000)))$q$, 'Anhang nicht gefunden');
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-t10', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 999)))$q$, 'Groesse passt nicht');
  perform pg_temp.erwarte_fehler(
    $q$select pg_temp.lege_an('msg-t11', p_attachments => (select jsonb_agg(pg_temp.att('a', 'pdf', 1000)) from generate_series(1, 11)))$q$, 'Zu viele Anhaenge');

  -- Idempotenz: gleiche Absicht -> Replay, abweichend -> Konflikt.
  v := pg_temp.lege_an('msg-att', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 1000, 'Angebot Nr. 1.pdf'), pg_temp.att('b', 'png', 2000, 'Foto.PNG')));
  if v->>'outcome' <> 'replayed' then raise exception 'Replay: %', v; end if;
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('msg-att', p_attachments => jsonb_build_array(pg_temp.att('a', 'pdf', 1000, 'Angebot Nr. 1.pdf')))$q$, 'Idempotenzkonflikt');
  select count(*) into n from public.workspace_email_messages where client_message_id = 'msg-att';
  if n <> 1 then raise exception 'Doppelanlage: %', n; end if;
end;
$$;

-- Server-Pfad (service_role): Claim, Doppel-Claim, Stale -> unknown, Status.
reset role;
do $$
declare
  v jsonb;
  m public.workspace_email_messages;
begin
  select * into m from public.workspace_email_messages where client_message_id = 'msg-att';
  v := public.claim_workspace_email_message_for_send(m.id, m.row_version);
  if (v->>'claimed')::boolean is not true or v->'message'->>'status' <> 'sending' then raise exception 'Claim: %', v; end if;
  -- Zweiter Tab / Doppelklick mit derselben Version: kein zweiter Claim.
  v := public.claim_workspace_email_message_for_send(m.id, m.row_version);
  if (v->>'claimed')::boolean is not false then raise exception 'Doppel-Claim: %', v; end if;
  -- Frische Sendung haengt nicht.
  v := public.resolve_stale_workspace_email_message_claim(m.id, 0);
  if (v->>'resolved')::boolean is not false then raise exception 'Stale zu frueh: %', v; end if;
  update public.workspace_email_messages set sending_started_at = now() - interval '11 minutes' where id = m.id;
  v := public.resolve_stale_workspace_email_message_claim(m.id, 600);
  if (v->>'resolved')::boolean is not true or v->'message'->>'status' <> 'unknown' then raise exception 'Stale: %', v; end if;

  -- msg-a: failed; msg-b: provider_accepted.
  select * into m from public.workspace_email_messages where client_message_id = 'msg-a';
  v := public.update_workspace_email_message_status(m.id, 'failed', null, 'provider', 'brevo_500', 'Der Versanddienst hat den Auftrag nicht angenommen.', m.row_version);
  if v->>'status' <> 'failed' then raise exception 'failed: %', v; end if;
  select * into m from public.workspace_email_messages where client_message_id = 'msg-b';
  v := public.claim_workspace_email_message_for_send(m.id, m.row_version);
  v := public.update_workspace_email_message_status(m.id, 'provider_accepted', 'brevo-123', null, null, null, (v->'message'->>'row_version')::bigint);
  if v->>'status' <> 'provider_accepted' then raise exception 'accepted: %', v; end if;
  -- Kein Rueckschritt.
  begin
    perform public.update_workspace_email_message_status(m.id, 'failed', null, 'unknown', 'x', 'x', null);
    raise exception 'Rueckschritt erlaubt';
  exception when others then
    if sqlerrm not like 'Statusuebergang%' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007d1","role":"authenticated"}', true);

do $$
declare
  v jsonb;
  v2 jsonb;
  unknown_id uuid;
  failed_id uuid;
  accepted_id uuid;
begin
  select id into unknown_id from public.workspace_email_messages where client_message_id = 'msg-att';
  select id into failed_id from public.workspace_email_messages where client_message_id = 'msg-a';
  select id into accepted_id from public.workspace_email_messages where client_message_id = 'msg-b';

  -- unknown: nie ohne Bestaetigung.
  perform pg_temp.erwarte_fehler(format($q$select public.retry_workspace_email_message('00000000-0000-0000-0000-0000000d07d1', 'retry-u0', %L)$q$, unknown_id), 'Versandstatus unklar');
  -- angenommen: kein Neuversuch.
  perform pg_temp.erwarte_fehler(format($q$select public.retry_workspace_email_message('00000000-0000-0000-0000-0000000d07d1', 'retry-x', %L)$q$, accepted_id), 'nur nach Fehlschlag');

  -- Bewusster Neuversuch nach unknown: eingefrorene Anhaenge/Empfaenger/Text, neue Zeile.
  v := public.retry_workspace_email_message('00000000-0000-0000-0000-0000000d07d1', 'retry-u1', unknown_id, true);
  if v->>'outcome' <> 'created' or (v->'message'->>'attempt_number')::int <> 2 or (v->'message'->>'retry_of_message_id')::uuid <> unknown_id then
    raise exception 'Retry: %', v;
  end if;
  v2 := public.email_message_to_jsonb((select m from public.workspace_email_messages m where m.id = unknown_id));
  if (select jsonb_agg(a - 'id') from jsonb_array_elements(v->'message'->'attachments') a)
     <> (select jsonb_agg(a - 'id') from jsonb_array_elements(v2->'attachments') a)
     or v->'message'->'to_recipients' <> v2->'to_recipients'
     or v->'message'->>'body_text' <> v2->>'body_text' then
    raise exception 'Retry nicht eingefroren: % / %', v, v2;
  end if;
  if v2->>'status' <> 'unknown' then raise exception 'Vorgaenger veraendert: %', v2; end if;
  -- Replay desselben Neuversuchs, aber kein zweiter Neuversuch (zweiter Tab).
  v := public.retry_workspace_email_message('00000000-0000-0000-0000-0000000d07d1', 'retry-u1', unknown_id, true);
  if v->>'outcome' <> 'replayed' then raise exception 'Retry-Replay: %', v; end if;
  perform pg_temp.erwarte_fehler(format($q$select public.retry_workspace_email_message('00000000-0000-0000-0000-0000000d07d1', 'retry-u2', %L, true)$q$, unknown_id), 'bereits angelegt');

  -- Neuversuch nach failed.
  v := public.retry_workspace_email_message('00000000-0000-0000-0000-0000000d07d1', 'retry-f1', failed_id);
  if (v->'message'->>'attempt_number')::int <> 2 then raise exception 'Retry failed: %', v; end if;

  -- Kette im Detail.
  v := public.get_workspace_email_message_chain('00000000-0000-0000-0000-0000000d07d1', (select id from public.workspace_email_messages where client_message_id = 'retry-u1'));
  if jsonb_array_length(v) <> 2 or (v->0->>'id')::uuid <> unknown_id then raise exception 'Kette: %', v; end if;

  -- Listen: alle / Kunde / Vorgang.
  v := public.list_workspace_email_messages('00000000-0000-0000-0000-0000000d07d1');
  if jsonb_array_length(v) <> 9 then raise exception 'Liste alle: %', jsonb_array_length(v); end if;
  v := public.list_workspace_email_messages('00000000-0000-0000-0000-0000000d07d1', 'kunde-a');
  if jsonb_array_length(v) <> 2 then raise exception 'Liste Kunde: %', v; end if;
  v := public.list_workspace_email_messages('00000000-0000-0000-0000-0000000d07d1', null, 'vorgang-a');
  if jsonb_array_length(v) <> 2 then raise exception 'Liste Vorgang: %', v; end if;
  perform pg_temp.erwarte_fehler($q$select public.list_workspace_email_messages('00000000-0000-0000-0000-0000000d07d2')$q$, 'Kein Zugriff');
end;
$$;

-- Rechte: Server-RPCs sind fuer Clients gesperrt; keine direkten Schreibrechte.
do $$
begin
  if has_function_privilege('authenticated', 'public.claim_workspace_email_message_for_send(uuid, bigint)', 'execute')
     or has_function_privilege('authenticated', 'public.update_workspace_email_message_status(uuid, text, text, text, text, text, bigint)', 'execute')
     or has_function_privilege('authenticated', 'public.resolve_stale_workspace_email_message_claim(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.get_workspace_email_message_for_send(uuid, text)', 'execute') then
    raise exception 'Server-RPC fuer Clients ausfuehrbar';
  end if;
  -- 07F-01A (20261017) ersetzt die 11-Parameter-Signatur durch eine mit optionalem
  -- p_reply_to_message_id. Geprüft wird die jeweils gültige Signatur: es gibt genau
  -- EINE (keine liegengebliebene Überladung), und genau sie ist für Clients ausführbar.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_workspace_email_message') <> 1 then
    raise exception 'create_workspace_email_message: nicht genau eine Signatur';
  end if;
  if not has_function_privilege('authenticated', (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_workspace_email_message'), 'execute')
     or not has_function_privilege('authenticated', 'public.retry_workspace_email_message(uuid, text, uuid, boolean)', 'execute') then
    raise exception 'Client-RPC nicht ausfuehrbar';
  end if;
  if exists (select 1 from pg_policies where tablename in ('workspace_email_messages', 'workspace_email_message_attachments') and cmd <> 'SELECT') then
    raise exception 'Schreib-Policy vorhanden';
  end if;
  if (select public from storage.buckets where id = 'email-attachments') then
    raise exception 'Bucket oeffentlich';
  end if;
end;
$$;

-- Missbrauchsschutz: 20 neue Nachrichten je Nutzer in 10 Minuten.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007d1","role":"authenticated"}', true);
do $$
declare
  i integer;
  existing integer;
begin
  select count(*) into existing from public.workspace_email_messages where workspace_id = '00000000-0000-0000-0000-0000000d07d1';
  for i in 1..(20 - existing) loop
    perform pg_temp.lege_an('rate-' || i);
  end loop;
  perform pg_temp.erwarte_fehler($q$select pg_temp.lege_an('rate-over')$q$, 'Versandlimit');
  -- Replay zaehlt nicht.
  perform pg_temp.lege_an('rate-1');
end;
$$;

select 'EMAIL-07D SQL OK';

rollback;
