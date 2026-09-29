-- E-MAIL-07E — Laufzeittest eingehende E-Mail (Import, Dedup, Lease/Cursor,
-- Zuordnung, manuelle Zuordnung, Rechte, 07D-Abgrenzung). Isoliert:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261012120000_workspace_email_messages.sql; \
--     cat supabase/migrations/20261014120000_workspace_inbound_email.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/inbound_email_07e.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000007e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000007e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'e2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e7001', 'E7', '00000000-0000-0000-0000-0000000007e1'),
       ('00000000-0000-0000-0000-0000000e7002', 'E7-Fremd', '00000000-0000-0000-0000-0000000007e2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000007e1', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000e7002', '00000000-0000-0000-0000-0000000007e2', 'owner', 'active');

insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000e7001', 'kunde-a', '{"email":"Einkauf@Kunde-A.invalid"}'::jsonb),
       ('00000000-0000-0000-0000-0000000e7001', 'kunde-b', '{"email":"dup@kunde.invalid"}'::jsonb),
       ('00000000-0000-0000-0000-0000000e7001', 'kunde-b2', '{"email":"dup@kunde.invalid"}'::jsonb),
       ('00000000-0000-0000-0000-0000000e7001', 'kunde-c', '{"email":"c@kunde-c.invalid"}'::jsonb),
       ('00000000-0000-0000-0000-0000000e7002', 'kunde-fremd', '{"email":"x@fremd.invalid"}'::jsonb);
insert into public.workspace_customers (workspace_id, customer_id, payload, deleted, deleted_at)
values ('00000000-0000-0000-0000-0000000e7001', 'kunde-geloescht', '{"email":"alt@kunde.invalid"}'::jsonb, true, now());

insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload, order_number)
values ('00000000-0000-0000-0000-0000000e7001', 'v-a', '{"customerId":"kunde-a"}'::jsonb, 'AU-2026-0001'),
       ('00000000-0000-0000-0000-0000000e7001', 'v-a2', '{"customerId":"kunde-a"}'::jsonb, 'AU-2026-0002'),
       ('00000000-0000-0000-0000-0000000e7001', 'v-c', '{"customerId":"kunde-c"}'::jsonb, 'AU-2026-0003'),
       ('00000000-0000-0000-0000-0000000e7002', 'v-fremd', '{"customerId":"kunde-fremd"}'::jsonb, 'AU-2026-0009');
insert into public.workspace_invoices (workspace_id, client_invoice_id, vorgang_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values ('00000000-0000-0000-0000-0000000e7001', 'inv-a', 'v-a', 'RE-2026-0007', 2026, 7, 'schluss', 'versendet', '{}'::jsonb);

insert into public.workspace_mailbox_connections (id, workspace_id, provider_type, mailbox_address, status)
values ('00000000-0000-0000-0000-0000000c7001', '00000000-0000-0000-0000-0000000e7001', 'stub', 'info@betrieb.invalid', 'connected'),
       ('00000000-0000-0000-0000-0000000c7002', '00000000-0000-0000-0000-0000000e7001', 'stub', 'buero@betrieb.invalid', 'connected'),
       ('00000000-0000-0000-0000-0000000c7009', '00000000-0000-0000-0000-0000000e7002', 'stub', 'info@fremd.invalid', 'connected');

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

create function pg_temp.mail(p_id text, p_from text, p_subject text, p_message_id text default null)
returns jsonb language sql as $p$
  select jsonb_build_object(
    'provider_message_id', p_id, 'internet_message_id', p_message_id, 'provider_thread_id', 'thread-1',
    'from_address', p_from, 'from_name', 'Absender', 'to', jsonb_build_array('info@betrieb.invalid'), 'cc', '[]'::jsonb,
    'subject', p_subject, 'body_text', 'Guten Tag, anbei die Unterlagen.', 'has_html', true, 'received_at', '2026-09-27T08:00:00Z');
$p$;

create function pg_temp.att(p_char text, p_ext text, p_name text, p_ws text default '00000000-0000-0000-0000-0000000e7001')
returns jsonb language sql as $p$
  select jsonb_build_object('storage_path', p_ws || '/' || repeat(p_char, 64) || '.' || p_ext, 'sha256', repeat(p_char, 64),
    'filename', p_name, 'original_filename', p_name, 'mime_type', public.email_attachment_mime_for_extension(p_ext), 'size_bytes', 12345);
$p$;

-- Lease holen (service_role-Pfad; hier als postgres).
create temp table lease as
  select (public.claim_workspace_mailbox_sync('00000000-0000-0000-0000-0000000c7001', 300)->'connection'->>'sync_lease_token')::uuid as token;

do $$
declare
  t uuid := (select token from lease);
  c uuid := '00000000-0000-0000-0000-0000000c7001';
  v jsonb;
  m public.workspace_email_messages;
  n integer;
begin
  if t is null then raise exception 'kein Lease'; end if;
  -- Zweiter Claim während der Lease: nicht möglich.
  if (public.claim_workspace_mailbox_sync(c, 300)->>'claimed')::boolean then raise exception 'doppelter Claim'; end if;

  -- A/H: ohne Anhang, unbekannter Absender → Zu prüfen.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-1', 'fremd@unbekannt.invalid', 'Anfrage Badsanierung', '<a1@mail.invalid>'), '[]'::jsonb);
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if v->>'outcome' <> 'imported' or m.assignment_status <> 'needs_review' or m.customer_id is not null or m.direction <> 'inbound' or m.status <> 'received' then
    raise exception 'A/H: % %', v, to_jsonb(m);
  end if;

  -- B/I/K: eindeutiger Kunde (Groß-/Kleinschreibung egal) + eindeutige Auftragsnummer → Kunde + Vorgang, mit PDF.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-2', 'einkauf@kunde-a.invalid', 'Rückfrage zu AU-2026-0001', '<b2@mail.invalid>'),
    jsonb_build_array(pg_temp.att('a', 'pdf', 'Aufmass.pdf')));
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if m.customer_id <> 'kunde-a' or m.vorgang_id <> 'v-a' or m.assignment_source <> 'auto_reference' or m.assignment_status <> 'assigned' then raise exception 'B/I/K: %', to_jsonb(m); end if;
  select count(*) into n from public.workspace_email_message_attachments where message_id = m.id and storage_bucket = 'inbound-email-attachments';
  if n <> 1 then raise exception 'B Anhang: %', n; end if;

  -- K über Rechnungsnummer, C mehrere Anhänge.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-3', 'einkauf@kunde-a.invalid', 'Zahlung RE-2026-0007', '<c3@mail.invalid>'),
    jsonb_build_array(pg_temp.att('b', 'pdf', 'Beleg.pdf'), pg_temp.att('c', 'png', 'Foto.png'), pg_temp.att('d', 'xlsx', 'Liste.xlsx')));
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if m.vorgang_id <> 'v-a' then raise exception 'K Rechnung: %', to_jsonb(m); end if;
  if jsonb_array_length(public.email_message_to_jsonb(m)->'attachments') <> 3 then raise exception 'C'; end if;

  -- L: mehrdeutige Referenz (zwei Vorgänge) → Kunde ja, Vorgang nein.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-4', 'einkauf@kunde-a.invalid', 'AU-2026-0001 und AU-2026-0002'), '[]'::jsonb);
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if m.customer_id <> 'kunde-a' or m.vorgang_id is not null or m.assignment_source <> 'auto_sender' then raise exception 'L: %', to_jsonb(m); end if;
  -- Referenz eines ANDEREN Kunden: kein Vorgang.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-5', 'einkauf@kunde-a.invalid', 'Frage zu AU-2026-0003'), '[]'::jsonb);
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if m.vorgang_id is not null then raise exception 'fremder Kunde: %', to_jsonb(m); end if;

  -- J: doppelte Kunden-E-Mail → nicht automatisch; gelöschter Kunde zählt nicht.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-6', 'dup@kunde.invalid', 'Hallo'), '[]'::jsonb);
  if (select assignment_status from public.workspace_email_messages where id = (v->>'message_id')::uuid) <> 'needs_review' then raise exception 'J'; end if;
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-7', 'alt@kunde.invalid', 'Hallo'), '[]'::jsonb);
  if (select customer_id from public.workspace_email_messages where id = (v->>'message_id')::uuid) is not null then raise exception 'geloescht'; end if;

  -- M: Referenz aus fremdem Workspace wird nicht gefunden, auch nicht vorgeschlagen.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-8', 'x@fremd.invalid', 'Auftrag AU-2026-0009'), '[]'::jsonb);
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if m.customer_id is not null or m.vorgang_id is not null or m.suggested_vorgang_id is not null then raise exception 'M: %', to_jsonb(m); end if;
  -- Unbekannter Absender, eindeutige Referenz → nur Vorschlag, Zu prüfen.
  v := public.import_workspace_inbound_email(c, t, pg_temp.mail('p-9', 'neu@unbekannt.invalid', 'Termin AU-2026-0003'), '[]'::jsonb);
  select * into m from public.workspace_email_messages where id = (v->>'message_id')::uuid;
  if m.assignment_status <> 'needs_review' or m.vorgang_id is not null or m.suggested_vorgang_id <> 'v-c' then raise exception 'Vorschlag: %', to_jsonb(m); end if;

  -- E: Provider-ID-Dedup; D: Message-ID-Dedup (auch über ein anderes Postfach, andere Provider-ID).
  if public.import_workspace_inbound_email(c, t, pg_temp.mail('p-1', 'fremd@unbekannt.invalid', 'Anfrage Badsanierung'), '[]'::jsonb)->>'outcome' <> 'duplicate' then raise exception 'E'; end if;
  if public.import_workspace_inbound_email(c, t, pg_temp.mail('p-anders', 'x@y.invalid', 'egal', '<A1@MAIL.INVALID>'), '[]'::jsonb)->>'outcome' <> 'duplicate' then raise exception 'D'; end if;
  select count(*) into n from public.workspace_email_messages where direction = 'inbound';
  if n <> 9 then raise exception 'Anzahl: %', n; end if;

  -- Anhänge: fremder Workspace-Pfad, falscher Typ.
  perform pg_temp.erwarte_fehler(format($q$select public.import_workspace_inbound_email(%L, %L, pg_temp.mail('p-x1', 'a@b.invalid', 's'), jsonb_build_array(pg_temp.att('e', 'pdf', 'x.pdf', '00000000-0000-0000-0000-0000000e7002')))$q$, c, t), 'Speicherpfad');
  perform pg_temp.erwarte_fehler(format($q$select public.import_workspace_inbound_email(%L, %L, pg_temp.mail('p-x2', 'a@b.invalid', 's'), jsonb_build_array(jsonb_set(pg_temp.att('e', 'pdf', 'x.pdf'), '{mime_type}', '"application/x-msdownload"')))$q$, c, t), 'Dateityp');
  -- Falscher Lease.
  perform pg_temp.erwarte_fehler(format($q$select public.import_workspace_inbound_email(%L, gen_random_uuid(), pg_temp.mail('p-x3', 'a@b.invalid', 's'), '[]'::jsonb)$q$, c), 'Lease');

  -- G/F: Cursor nur mit Lease; Fehler einer Mail wird vermerkt und blockiert nicht.
  perform pg_temp.erwarte_fehler(format($q$select public.advance_workspace_mailbox_cursor(%L, gen_random_uuid(), '{"delta":"x"}')$q$, c), 'Lease');
  perform public.record_workspace_inbound_import_failure(c, t, 'p-kaputt', 'mime_parse_failed');
  if (public.record_workspace_inbound_import_failure(c, t, 'p-kaputt', 'mime_parse_failed')->>'attempts')::int <> 2 then raise exception 'Fehlerzaehler'; end if;
  perform public.advance_workspace_mailbox_cursor(c, t, '{"delta":"token-2"}');
  if (select sync_cursor->>'delta' from public.workspace_mailbox_connections where id = c) <> 'token-2' then raise exception 'Cursor'; end if;
  -- Späterer erfolgreicher Import der kaputten Mail räumt den Fehlervermerk.
  perform public.import_workspace_inbound_email(c, t, pg_temp.mail('p-kaputt', 'a@b.invalid', 'jetzt lesbar'), '[]'::jsonb);
  if exists (select 1 from public.workspace_mailbox_import_failures where provider_message_id = 'p-kaputt') then raise exception 'Fehlervermerk bleibt'; end if;
  v := public.finish_workspace_mailbox_sync(c, t, 'connected');
  if v->>'status' <> 'connected' or v ? 'sync_lease_token' then raise exception 'finish: %', v; end if;
  -- Nach Abschluss ist der alte Lease ungültig (F: Wiederaufnahme nur mit neuem Claim).
  perform pg_temp.erwarte_fehler(format($q$select public.advance_workspace_mailbox_cursor(%L, %L, '{}')$q$, c, t), 'Lease');
  -- Rate-Limit-Backoff: nach Fehler mit Wartezeit kein sofortiger Claim.
  perform public.finish_workspace_mailbox_sync(c, (public.claim_workspace_mailbox_sync(c, 300)->'connection'->>'sync_lease_token')::uuid, 'error', 'rate_limited', 'graph_429', 'Der Anbieter bittet um eine Pause.', 600);
  if (public.claim_workspace_mailbox_sync(c, 300)->>'claimed')::boolean then raise exception 'Backoff ignoriert'; end if;
end;
$$;

-- Client-Pfad (authenticated).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007e1","role":"authenticated"}', true);

do $$
declare
  ws uuid := '00000000-0000-0000-0000-0000000e7001';
  v jsonb;
  mid uuid;
  n integer;
begin
  -- U: Posteingang neueste zuerst; Filter „Zu prüfen"; Kundenfilter.
  v := public.list_workspace_inbound_email_messages(ws);
  if jsonb_array_length(v) <> 10 then raise exception 'U alle: %', jsonb_array_length(v); end if;
  if (select count(*) from jsonb_array_elements(public.list_workspace_inbound_email_messages(ws, null, null, true)) e where e->>'assignment_status' <> 'needs_review') > 0 then raise exception 'U review'; end if;
  if jsonb_array_length(public.list_workspace_inbound_email_messages(ws, 'kunde-a')) <> 4 then raise exception 'U Kunde'; end if;
  if jsonb_array_length(public.list_workspace_inbound_email_messages(ws, null, 'v-a')) <> 2 then raise exception 'U Vorgang'; end if;

  -- Y: „Gesendet"-Liste (07D) enthält keine eingegangene Mail.
  if jsonb_array_length(public.list_workspace_email_messages(ws)) <> 0 then raise exception 'Y outbound-Liste'; end if;

  -- V: Detail.
  select id into mid from public.workspace_email_messages where provider_message_id = 'p-6';
  v := public.get_workspace_inbound_email_message(ws, mid);
  if v->>'subject' <> 'Hallo' then raise exception 'V: %', v; end if;
  if public.get_workspace_inbound_email_message('00000000-0000-0000-0000-0000000e7001', gen_random_uuid()) is not null then raise exception 'V leer'; end if;

  -- N: manuelle Zuordnung; O: bleibt erhalten; P: Widersprüche abgelehnt.
  v := public.assign_workspace_inbound_email_message(ws, mid, 'kunde-b', null, null);
  if v->>'customer_id' <> 'kunde-b' or v->>'assignment_source' <> 'manual' or v->>'assignment_status' <> 'assigned' or v->>'assigned_by' is null then raise exception 'N: %', v; end if;
  perform pg_temp.erwarte_fehler(format($q$select public.assign_workspace_inbound_email_message(%L, %L, 'kunde-b', 'v-a', null)$q$, ws, mid), 'Kunde passt nicht zum Vorgang');
  perform pg_temp.erwarte_fehler(format($q$select public.assign_workspace_inbound_email_message(%L, %L, null, 'v-a', null)$q$, ws, mid), 'Kunde passt nicht zum Vorgang');
  perform pg_temp.erwarte_fehler(format($q$select public.assign_workspace_inbound_email_message(%L, %L, 'kunde-fremd', null, null)$q$, ws, mid), 'customer_id gehoert nicht');
  perform pg_temp.erwarte_fehler(format($q$select public.assign_workspace_inbound_email_message(%L, %L, 'kunde-a', 'v-fremd', null)$q$, ws, mid), 'vorgang_id gehoert nicht');
  perform pg_temp.erwarte_fehler(format($q$select public.assign_workspace_inbound_email_message(%L, %L, 'kunde-a', null, 1)$q$, ws, mid), 'row_version');
  v := public.assign_workspace_inbound_email_message(ws, mid, 'kunde-a', 'v-a2', null);
  if v->>'vorgang_id' <> 'v-a2' then raise exception 'N Vorgang'; end if;
  -- Kunde entfernen: Vorgang muss mit (sonst Widerspruch) → beide leer = Zu prüfen.
  v := public.assign_workspace_inbound_email_message(ws, mid, null, null, null);
  if v->>'assignment_status' <> 'needs_review' or v->>'vorgang_id' is not null then raise exception 'P: %', v; end if;
  v := public.assign_workspace_inbound_email_message(ws, mid, 'kunde-c', 'v-c', null);
  select count(*) into n from public.workspace_email_assignment_events where message_id = mid and source = 'manual';
  if n <> 4 then raise exception 'Audit: %', n; end if;

  -- Fremder Workspace.
  perform pg_temp.erwarte_fehler($q$select public.list_workspace_inbound_email_messages('00000000-0000-0000-0000-0000000e7002')$q$, 'Kein Zugriff');
  perform pg_temp.erwarte_fehler(format($q$select public.assign_workspace_inbound_email_message('00000000-0000-0000-0000-0000000e7002', %L, null, null, null)$q$, mid), 'Kein Zugriff');

  -- Postfächer: keine Cursor/Lease/Credentials nach außen.
  v := public.list_workspace_mailbox_connections(ws);
  if jsonb_array_length(v) <> 2 or v->0 ? 'sync_cursor' or v->0 ? 'sync_lease_token' then raise exception 'Postfaecher: %', v; end if;
end;
$$;

-- O: erneuter Import derselben Mail ändert die manuelle Zuordnung nicht.
reset role;
do $$
declare
  t uuid;
  c uuid := '00000000-0000-0000-0000-0000000c7002';
begin
  t := (public.claim_workspace_mailbox_sync(c, 300)->'connection'->>'sync_lease_token')::uuid;
  if public.import_workspace_inbound_email(c, t, pg_temp.mail('anders-p-6', 'dup@kunde.invalid', 'Hallo', null), '[]'::jsonb)->>'outcome' <> 'imported' then raise exception 'neu'; end if;
  if (select customer_id from public.workspace_email_messages where provider_message_id = 'p-6') <> 'kunde-c' then raise exception 'O'; end if;
end;
$$;

-- 07D-Abgrenzung + Sicherheit.
do $$
declare
  inbound_id uuid;
  inbound_client text;
begin
  select id, client_message_id into inbound_id, inbound_client from public.workspace_email_messages where provider_message_id = 'p-2';
  -- AB: eine eingegangene Mail ist nie ein Versandauftrag.
  if public.get_workspace_email_message_for_send('00000000-0000-0000-0000-0000000e7001', inbound_client) is not null then raise exception 'AB laden'; end if;
  if (public.claim_workspace_email_message_for_send(inbound_id, 1)->>'claimed')::boolean then raise exception 'AB claim'; end if;
  -- Rechte.
  if has_function_privilege('authenticated', 'public.import_workspace_inbound_email(uuid, uuid, jsonb, jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_workspace_mailbox_sync(uuid, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.get_workspace_mailbox_credential(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.set_workspace_mailbox_credential(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.list_workspace_inbound_email_messages(uuid, text, text, boolean, integer)', 'execute')
     or has_table_privilege('authenticated', 'public.workspace_mailbox_credentials', 'select') then
    raise exception 'Rechte zu weit';
  end if;
  if not has_function_privilege('authenticated', 'public.assign_workspace_inbound_email_message(uuid, uuid, text, text, bigint)', 'execute') then
    raise exception 'assign nicht freigegeben';
  end if;
  if (select public from storage.buckets where id = 'inbound-email-attachments') then raise exception 'Bucket oeffentlich'; end if;
  if exists (select 1 from pg_policies where tablename = 'objects' and policyname like 'inbound_email_attachments%' and cmd <> 'SELECT') then raise exception 'Schreib-Policy'; end if;
  -- Vault: Zugangsdaten verschlüsselt ablegen und nur serverseitig lesen.
  perform public.set_workspace_mailbox_credential('00000000-0000-0000-0000-0000000c7001', '{"refresh_token":"geheim-test"}');
  if public.get_workspace_mailbox_credential('00000000-0000-0000-0000-0000000c7001') <> '{"refresh_token":"geheim-test"}' then raise exception 'Vault'; end if;
  if exists (select 1 from vault.secrets where secret = '{"refresh_token":"geheim-test"}') then raise exception 'Klartext im Vault'; end if;
end;
$$;

-- Postfach-Zugehörigkeit (Edge Function prüft vor jedem Abruf).
do $$
begin
  if not public.mailbox_connection_belongs_to_workspace('00000000-0000-0000-0000-0000000c7001', '00000000-0000-0000-0000-0000000e7001')
     or public.mailbox_connection_belongs_to_workspace('00000000-0000-0000-0000-0000000c7001', '00000000-0000-0000-0000-0000000e7002')
     or has_function_privilege('authenticated', 'public.mailbox_connection_belongs_to_workspace(uuid, uuid)', 'execute') then
    raise exception 'Postfach-Zugehoerigkeit';
  end if;
end;
$$;

select 'EMAIL-07E SQL OK';

rollback;
