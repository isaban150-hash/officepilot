-- E-MAIL-07D — freie Geschaefts-E-Mail mit mehreren Anhaengen.
--
-- Eine freie E-Mail ist KEIN Dokumentversand: eigene Tabellen, eigener
-- privater Bucket, eigene RPCs. `workspace_document_deliveries` und alle
-- 07B/07C-Funktionen bleiben unveraendert.
--
-- Statusmodell (monoton):
--   queued  -> sending | failed | unknown
--   sending -> provider_accepted | failed | unknown
--   unknown -> provider_accepted | failed
-- `provider_accepted` heisst „an den E-Mail-Dienst uebergeben" — nicht „zugestellt".
--
-- Sende-Claim wie 07B: nur wer `queued -> sending` atomar gewinnt, ruft den
-- Provider. Ein haengendes `sending` wird `unknown`, nie automatisch erneut
-- gesendet. Ein bewusster Neuversuch ist eine NEUE Zeile mit
-- `retry_of_message_id`; Empfaenger, Text und Anhaenge werden serverseitig aus
-- dem Vorgaenger kopiert (eingefroren) — der Client kann sie nicht aendern.
--
-- Grenzen (Brevo: 99 Empfaenger je Nachricht, ~20 MB Gesamtgroesse inkl.
-- Base64; OfficeTakt bewusst darunter):
--   Empfaenger: TO 1..20, TO+CC+BCC hoechstens 30
--   Anhaenge:   hoechstens 10, je Datei 4 MiB, zusammen 10 MiB
--               (Base64 ≈ 13,4 MiB + Text/JSON — deutlich unter 20 MB)
--   Betreff 255, Text 20000 Zeichen (wie der Dokumentversand)
-- Missbrauchsschutz: 20 neue Nachrichten je Nutzer / 60 je Workspace in 10
-- Minuten, hoechstens 300 Empfaenger je Workspace in 60 Minuten. Replays
-- derselben client_message_id zaehlen nicht.
--
-- Setzt 20260915120000 (workspace_user_can_write) voraus.
-- Nur lokal; Anwendung auf die Cloud ist ein eigener, freigegebener Schritt.

-- ---------------------------------------------------------------------------
-- 1. Tabellen
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_email_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_message_id text not null,
  direction text not null default 'outbound',

  customer_id text null,
  vorgang_id text null,

  to_recipients text[] not null,
  cc_recipients text[] not null default '{}',
  bcc_recipients text[] not null default '{}',
  subject text not null,
  body_text text not null,

  -- Absender-Snapshot: der Anzeigename und die Antwortadresse zum Zeitpunkt der Anlage.
  sender_name text not null,
  reply_to_email text not null,

  provider text not null,
  provider_message_id text null,
  status text not null default 'queued',

  requested_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sending_started_at timestamptz null,
  provider_accepted_at timestamptz null,
  failed_at timestamptz null,

  error_category text null,
  error_code text null,
  error_message_safe text null,

  retry_of_message_id uuid null references public.workspace_email_messages (id) on delete restrict,
  attempt_number integer not null default 1,
  row_version bigint not null default 1,

  constraint workspace_email_messages_client_id_unique unique (workspace_id, client_message_id),
  constraint workspace_email_messages_client_id_check check (length(client_message_id) between 1 and 128),
  constraint workspace_email_messages_direction_check check (direction = 'outbound'),
  constraint workspace_email_messages_customer_id_check check (customer_id is null or length(btrim(customer_id)) between 1 and 128),
  constraint workspace_email_messages_vorgang_id_check check (vorgang_id is null or length(btrim(vorgang_id)) between 1 and 128),
  constraint workspace_email_messages_to_check check (cardinality(to_recipients) between 1 and 20),
  constraint workspace_email_messages_recipient_total_check check (
    cardinality(to_recipients) + cardinality(cc_recipients) + cardinality(bcc_recipients) <= 30
  ),
  constraint workspace_email_messages_subject_check check (length(btrim(subject)) between 1 and 255),
  constraint workspace_email_messages_body_check check (length(btrim(body_text)) >= 1 and length(body_text) <= 20000),
  constraint workspace_email_messages_provider_check check (provider in ('brevo', 'stub')),
  constraint workspace_email_messages_status_check check (
    status in ('queued', 'sending', 'provider_accepted', 'failed', 'unknown')
  ),
  constraint workspace_email_messages_error_category_check check (
    error_category is null
    or error_category in ('auth', 'recipient', 'provider', 'attachment', 'network', 'unknown')
  ),
  constraint workspace_email_messages_attempt_check check (attempt_number >= 1),
  constraint workspace_email_messages_retry_self_check check (retry_of_message_id is distinct from id),
  constraint workspace_email_messages_sending_fields_check check (status <> 'sending' or sending_started_at is not null),
  constraint workspace_email_messages_accepted_fields_check check (
    status <> 'provider_accepted' or (provider_accepted_at is not null and provider_message_id is not null)
  ),
  constraint workspace_email_messages_failed_fields_check check (
    status <> 'failed' or (failed_at is not null and error_category is not null)
  )
);

create index if not exists workspace_email_messages_created_idx
  on public.workspace_email_messages (workspace_id, created_at desc);
create index if not exists workspace_email_messages_requested_idx
  on public.workspace_email_messages (workspace_id, requested_by, created_at desc);
create index if not exists workspace_email_messages_customer_idx
  on public.workspace_email_messages (workspace_id, customer_id, created_at desc)
  where customer_id is not null;
create index if not exists workspace_email_messages_vorgang_idx
  on public.workspace_email_messages (workspace_id, vorgang_id, created_at desc)
  where vorgang_id is not null;
create index if not exists workspace_email_messages_retry_idx
  on public.workspace_email_messages (retry_of_message_id)
  where retry_of_message_id is not null;

create table if not exists public.workspace_email_message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.workspace_email_messages (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  position integer not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  storage_path text not null,
  created_at timestamptz not null default now(),

  constraint workspace_email_message_attachments_position_unique unique (message_id, position),
  constraint workspace_email_message_attachments_position_check check (position between 1 and 10),
  constraint workspace_email_message_attachments_size_check check (size_bytes > 0 and size_bytes <= 4194304),
  constraint workspace_email_message_attachments_sha_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint workspace_email_message_attachments_path_check check (
    position(workspace_id::text || '/' in storage_path) = 1
  )
);

create index if not exists workspace_email_message_attachments_message_idx
  on public.workspace_email_message_attachments (message_id, position);

alter table public.workspace_email_messages enable row level security;
alter table public.workspace_email_message_attachments enable row level security;

-- Lesen: aktive Mitglieder. Schreiben ausschliesslich ueber RPC/Server.
drop policy if exists workspace_email_messages_select_member on public.workspace_email_messages;
create policy workspace_email_messages_select_member
on public.workspace_email_messages for select to authenticated
using (public.is_active_workspace_member(workspace_id));

drop policy if exists workspace_email_message_attachments_select_member on public.workspace_email_message_attachments;
create policy workspace_email_message_attachments_select_member
on public.workspace_email_message_attachments for select to authenticated
using (public.is_active_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- 2. Hilfsfunktionen: Empfaenger, Dateitypen, Pfade, Statusmaschine
-- ---------------------------------------------------------------------------

create or replace function public.email_message_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_from = p_to then true
    when p_from = 'queued' then p_to in ('sending', 'failed', 'unknown')
    when p_from = 'sending' then p_to in ('provider_accepted', 'failed', 'unknown')
    when p_from = 'unknown' then p_to in ('provider_accepted', 'failed')
    else false
  end;
$$;

-- Normalisiert eine Adressliste (trim, lower, ohne Leere, ohne Dubletten,
-- Reihenfolge bleibt) und lehnt jede ungueltige Adresse ab.
create or replace function public.email_message_normalize_recipients(p_list text[], p_label text)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_entry text;
  v_clean text;
  v_result text[] := '{}';
begin
  if p_list is null then
    return v_result;
  end if;
  foreach v_entry in array p_list loop
    v_clean := lower(btrim(coalesce(v_entry, '')));
    if v_clean = '' then
      continue;
    end if;
    if length(v_clean) > 254 or v_clean !~ '^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$' then
      raise exception '% enthaelt eine ungueltige Adresse', p_label;
    end if;
    if not (v_clean = any (v_result)) then
      v_result := array_append(v_result, v_clean);
    end if;
  end loop;
  return v_result;
end;
$$;

-- Erlaubte Dateitypen: Endung -> MIME. Alles andere (ausfuehrbar, Skripte,
-- Archive, HTML) ist ausgeschlossen.
create or replace function public.email_attachment_mime_for_extension(p_extension text)
returns text
language sql
immutable
set search_path = public
as $$
  select case lower(coalesce(p_extension, ''))
    when 'pdf' then 'application/pdf'
    when 'png' then 'image/png'
    when 'jpg' then 'image/jpeg'
    when 'jpeg' then 'image/jpeg'
    when 'txt' then 'text/plain'
    when 'csv' then 'text/csv'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    else null
  end;
$$;

-- Privater Bucket, inhaltsadressiert: {workspace}/{sha256}.{endung}
create or replace function public.email_attachment_workspace_id(p_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-f]{64}\.(pdf|png|jpg|jpeg|txt|csv|docx|xlsx)$'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

grant execute on function public.email_message_transition_allowed(text, text) to authenticated, service_role;
grant execute on function public.email_attachment_mime_for_extension(text) to authenticated, service_role;
grant execute on function public.email_attachment_workspace_id(text) to authenticated, service_role;
revoke all on function public.email_message_normalize_recipients(text[], text) from public;
grant execute on function public.email_message_normalize_recipients(text[], text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-attachments', 'email-attachments', false, 4194304,
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.email_attachment_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.is_active_workspace_member(public.email_attachment_workspace_id(p_name)), false);
$$;

create or replace function public.email_attachment_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.can_write_workspace(public.email_attachment_workspace_id(p_name)), false);
$$;

revoke all on function public.email_attachment_can_read(text) from public;
revoke all on function public.email_attachment_can_write(text) from public;
grant execute on function public.email_attachment_can_read(text) to authenticated;
grant execute on function public.email_attachment_can_write(text) to authenticated;

drop policy if exists email_attachments_select_member on storage.objects;
create policy email_attachments_select_member
on storage.objects for select to authenticated
using (bucket_id = 'email-attachments' and public.email_attachment_can_read(name));

drop policy if exists email_attachments_insert_writer on storage.objects;
create policy email_attachments_insert_writer
on storage.objects for insert to authenticated
with check (bucket_id = 'email-attachments' and public.email_attachment_can_write(name));

-- Keine update-/delete-Policy: ein referenzierter Anhang bleibt unveraendert bestehen.

-- JSON-Form einer Nachricht samt Anhaengen (fuer Client und Edge Function).
create or replace function public.email_message_to_jsonb(p_message public.workspace_email_messages)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(p_message) || jsonb_build_object(
    'attachments',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'position', a.position,
        'filename', a.filename,
        'mime_type', a.mime_type,
        'size_bytes', a.size_bytes,
        'sha256', a.sha256,
        'storage_path', a.storage_path
      ) order by a.position)
      from public.workspace_email_message_attachments a
      where a.message_id = p_message.id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.email_message_to_jsonb(public.workspace_email_messages) from public;
grant execute on function public.email_message_to_jsonb(public.workspace_email_messages) to service_role;

-- Missbrauchsschutz (gleitendes Fenster, keine dauerhafte Sperre).
create or replace function public.email_message_assert_rate_limit(p_workspace_id uuid, p_user_id uuid, p_new_recipients integer)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id and m.requested_by = p_user_id
      and m.created_at > now() - interval '10 minutes'
  ) >= 20
  or (
    select count(*) from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id
      and m.created_at > now() - interval '10 minutes'
  ) >= 60
  or (
    select coalesce(sum(cardinality(m.to_recipients) + cardinality(m.cc_recipients) + cardinality(m.bcc_recipients)), 0)
    from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id
      and m.created_at > now() - interval '60 minutes'
  ) + p_new_recipients > 300 then
    raise exception 'Versandlimit erreicht: bitte in einigen Minuten erneut versuchen';
  end if;
end;
$$;

revoke all on function public.email_message_assert_rate_limit(uuid, uuid, integer) from public;

-- ---------------------------------------------------------------------------
-- 3. RPC: freie E-Mail idempotent anlegen (kein Provider-Aufruf)
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace_email_message(
  p_workspace_id uuid,
  p_client_message_id text,
  p_to text[],
  p_cc text[],
  p_bcc text[],
  p_subject text,
  p_body_text text,
  p_attachments jsonb,
  p_provider text,
  p_customer_id text default null,
  p_vorgang_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_id text := nullif(btrim(coalesce(p_client_message_id, '')), '');
  v_to text[];
  v_cc text[];
  v_bcc text[];
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := coalesce(p_body_text, '');
  v_provider text := nullif(btrim(coalesce(p_provider, '')), '');
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
  v_vorgang_customer_id text;
  v_company jsonb;
  v_sender_name text;
  v_reply_to text;
  v_existing public.workspace_email_messages;
  v_row public.workspace_email_messages;
  v_attachment jsonb;
  v_count integer := 0;
  v_total bigint := 0;
  v_path text;
  v_sha text;
  v_ext text;
  v_mime text;
  v_filename text;
  v_size bigint;
  v_object_size text;
  v_shas text[] := '{}';
  v_existing_shas text[];
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if v_client_id is null or length(v_client_id) > 128 then
    raise exception 'client_message_id ungueltig';
  end if;

  -- Empfaenger: normalisiert, gueltig, ohne Dubletten ueber TO/CC/BCC hinweg.
  v_to := public.email_message_normalize_recipients(p_to, 'An');
  v_cc := public.email_message_normalize_recipients(p_cc, 'Cc');
  v_bcc := public.email_message_normalize_recipients(p_bcc, 'Bcc');
  v_cc := coalesce((select array_agg(x order by o) from unnest(v_cc) with ordinality as t(x, o) where not (x = any (v_to))), '{}');
  v_bcc := coalesce((select array_agg(x order by o) from unnest(v_bcc) with ordinality as t(x, o) where not (x = any (v_to)) and not (x = any (v_cc))), '{}');
  if cardinality(v_to) < 1 then
    raise exception 'An: mindestens ein Empfaenger erforderlich';
  end if;
  if cardinality(v_to) > 20 or cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) > 30 then
    raise exception 'Zu viele Empfaenger';
  end if;

  if v_subject = '' or length(v_subject) > 255 then
    raise exception 'subject ungueltig';
  end if;
  if btrim(v_body) = '' or length(v_body) > 20000 then
    raise exception 'body_text ungueltig';
  end if;
  if v_provider is null or v_provider not in ('brevo', 'stub') then
    raise exception 'provider ungueltig';
  end if;

  -- Kontext: nur echte Kennungen dieses Workspaces; Kunde und Vorgang muessen zusammenpassen.
  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and not c.deleted
  ) then
    raise exception 'customer_id gehoert nicht zum Workspace';
  end if;
  if v_vorgang_id is not null then
    select nullif(btrim(coalesce(v.payload->>'customerId', '')), '') into v_vorgang_customer_id
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id and not v.deleted;
    if not found then
      raise exception 'vorgang_id gehoert nicht zum Workspace';
    end if;
    if v_vorgang_customer_id is not null then
      if v_customer_id is not null and v_customer_id <> v_vorgang_customer_id then
        raise exception 'Kunde passt nicht zum Vorgang';
      end if;
      if v_customer_id is null and exists (
        select 1 from public.workspace_customers c
        where c.workspace_id = p_workspace_id and c.customer_id = v_vorgang_customer_id and not c.deleted
      ) then
        -- Der Vorgang bestimmt den Kunden.
        v_customer_id := v_vorgang_customer_id;
      end if;
    end if;
  end if;

  -- Anhaenge: Metadaten pruefen und Existenz/Groesse im privaten Bucket bestaetigen.
  if p_attachments is not null and jsonb_typeof(p_attachments) <> 'array' then
    raise exception 'attachments ungueltig';
  end if;
  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    v_count := v_count + 1;
    if v_count > 10 then
      raise exception 'Zu viele Anhaenge';
    end if;
    v_path := btrim(coalesce(v_attachment->>'storage_path', ''));
    v_sha := lower(btrim(coalesce(v_attachment->>'sha256', '')));
    v_filename := btrim(coalesce(v_attachment->>'filename', ''));
    v_mime := btrim(coalesce(v_attachment->>'mime_type', ''));
    begin
      v_size := (v_attachment->>'size_bytes')::bigint;
    exception when others then
      raise exception 'Anhang: Groesse ungueltig';
    end;
    if public.email_attachment_workspace_id(v_path) is distinct from p_workspace_id then
      raise exception 'Anhang: Speicherpfad ungueltig';
    end if;
    if v_sha !~ '^[0-9a-f]{64}$' or split_part(split_part(v_path, '/', 2), '.', 1) <> v_sha then
      raise exception 'Anhang: Pruefwert passt nicht zum Pfad';
    end if;
    v_ext := split_part(split_part(v_path, '/', 2), '.', 2);
    if public.email_attachment_mime_for_extension(v_ext) is distinct from v_mime then
      raise exception 'Anhang: Dateityp nicht erlaubt';
    end if;
    if v_filename = '' or length(v_filename) > 150 or v_filename ~ '[/\\:*?"<>|[:cntrl:]]' or left(v_filename, 1) = '.'
       or lower(v_filename) !~ ('\.' || v_ext || '$') then
      raise exception 'Anhang: Dateiname ungueltig';
    end if;
    if v_size is null or v_size <= 0 or v_size > 4194304 then
      raise exception 'Anhang: Datei zu gross';
    end if;
    v_total := v_total + v_size;
    if v_total > 10485760 then
      raise exception 'Anhaenge zusammen zu gross';
    end if;
    select o.metadata->>'size' into v_object_size
    from storage.objects o
    where o.bucket_id = 'email-attachments' and o.name = v_path;
    if not found then
      raise exception 'Anhang nicht gefunden';
    end if;
    if v_object_size is not null and v_object_size::bigint <> v_size then
      raise exception 'Anhang: Groesse passt nicht';
    end if;
    v_shas := array_append(v_shas, v_sha);
  end loop;

  -- Idempotenz: dieselbe Absicht -> dieselbe Nachricht; abweichende Absicht -> Konflikt.
  select * into v_existing
  from public.workspace_email_messages
  where workspace_id = p_workspace_id and client_message_id = v_client_id
  for update;
  if v_existing.id is not null then
    select coalesce(array_agg(a.sha256 order by a.position), '{}') into v_existing_shas
    from public.workspace_email_message_attachments a where a.message_id = v_existing.id;
    if v_existing.retry_of_message_id is not null
       or v_existing.to_recipients <> v_to
       or v_existing.cc_recipients <> v_cc
       or v_existing.bcc_recipients <> v_bcc
       or v_existing.subject <> v_subject
       or v_existing.body_text <> v_body
       or v_existing_shas <> v_shas
       or v_existing.customer_id is distinct from v_customer_id
       or v_existing.vorgang_id is distinct from v_vorgang_id then
      raise exception 'Idempotenzkonflikt: client_message_id mit abweichendem Inhalt';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'message', public.email_message_to_jsonb(v_existing));
  end if;

  -- Absender-Snapshot aus den Kommunikations-Einstellungen bzw. dem Firmenprofil.
  select payload into v_company from public.workspace_company_profiles where workspace_id = p_workspace_id;
  v_sender_name := nullif(btrim(coalesce(v_company->>'senderDisplayName', '')), '');
  if v_sender_name is null then
    v_sender_name := nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(v_company->>'companyName', '')), ''), nullif(btrim(coalesce(v_company->>'legalForm', '')), ''))), '');
  end if;
  v_reply_to := lower(nullif(btrim(coalesce(v_company->>'replyToEmail', '')), ''));
  if v_reply_to is not null and (length(v_reply_to) > 254 or v_reply_to !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') then
    raise exception 'Absender: Antwortadresse ungueltig';
  end if;
  if v_reply_to is null then
    v_reply_to := lower(nullif(btrim(coalesce(v_company->>'email', '')), ''));
  end if;
  if v_sender_name is null or v_reply_to is null or v_reply_to !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Absenderdaten unvollstaendig';
  end if;

  perform public.email_message_assert_rate_limit(p_workspace_id, v_user_id, cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc));

  insert into public.workspace_email_messages (
    workspace_id, client_message_id, customer_id, vorgang_id,
    to_recipients, cc_recipients, bcc_recipients, subject, body_text,
    sender_name, reply_to_email, provider, status, requested_by
  ) values (
    p_workspace_id, v_client_id, v_customer_id, v_vorgang_id,
    v_to, v_cc, v_bcc, v_subject, v_body,
    left(v_sender_name, 120), v_reply_to, v_provider, 'queued', v_user_id
  )
  returning * into v_row;

  v_count := 0;
  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    v_count := v_count + 1;
    insert into public.workspace_email_message_attachments (
      message_id, workspace_id, position, filename, mime_type, size_bytes, sha256, storage_path
    ) values (
      v_row.id, p_workspace_id, v_count,
      btrim(v_attachment->>'filename'), btrim(v_attachment->>'mime_type'),
      (v_attachment->>'size_bytes')::bigint, lower(btrim(v_attachment->>'sha256')), btrim(v_attachment->>'storage_path')
    );
  end loop;

  return jsonb_build_object('outcome', 'created', 'message', public.email_message_to_jsonb(v_row));
end;
$$;

revoke all on function public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text) from public;
grant execute on function public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. RPC: bewusster Neuversuch — alles eingefroren aus dem Vorgaenger kopiert
-- ---------------------------------------------------------------------------

create or replace function public.retry_workspace_email_message(
  p_workspace_id uuid,
  p_client_message_id text,
  p_retry_of_message_id uuid,
  p_confirm_uncertain_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_id text := nullif(btrim(coalesce(p_client_message_id, '')), '');
  v_existing public.workspace_email_messages;
  v_previous public.workspace_email_messages;
  v_row public.workspace_email_messages;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if v_client_id is null or length(v_client_id) > 128 then
    raise exception 'client_message_id ungueltig';
  end if;
  if p_retry_of_message_id is null then
    raise exception 'retry_of_message_id fehlt';
  end if;

  select * into v_existing
  from public.workspace_email_messages
  where workspace_id = p_workspace_id and client_message_id = v_client_id;
  if v_existing.id is not null then
    if v_existing.retry_of_message_id is distinct from p_retry_of_message_id then
      raise exception 'Idempotenzkonflikt: client_message_id mit abweichendem Inhalt';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'message', public.email_message_to_jsonb(v_existing));
  end if;

  -- Sperre auf dem Vorgaenger: zwei Tabs koennen nicht gleichzeitig je einen Neuversuch anlegen.
  select * into v_previous
  from public.workspace_email_messages
  where id = p_retry_of_message_id and workspace_id = p_workspace_id
  for update;
  if v_previous.id is null then
    raise exception 'retry_of_message_id nicht gefunden';
  end if;
  if v_previous.status = 'unknown' then
    if not coalesce(p_confirm_uncertain_retry, false) then
      raise exception 'Erneuter Versand nicht moeglich: Versandstatus unklar';
    end if;
  elsif v_previous.status <> 'failed' then
    raise exception 'Erneuter Versand nur nach Fehlschlag';
  end if;
  if exists (select 1 from public.workspace_email_messages c where c.retry_of_message_id = v_previous.id) then
    raise exception 'Neuversuch zu diesem Versuch wurde bereits angelegt';
  end if;

  perform public.email_message_assert_rate_limit(
    p_workspace_id, v_user_id,
    cardinality(v_previous.to_recipients) + cardinality(v_previous.cc_recipients) + cardinality(v_previous.bcc_recipients)
  );

  insert into public.workspace_email_messages (
    workspace_id, client_message_id, customer_id, vorgang_id,
    to_recipients, cc_recipients, bcc_recipients, subject, body_text,
    sender_name, reply_to_email, provider, status, requested_by,
    retry_of_message_id, attempt_number
  ) values (
    p_workspace_id, v_client_id, v_previous.customer_id, v_previous.vorgang_id,
    v_previous.to_recipients, v_previous.cc_recipients, v_previous.bcc_recipients, v_previous.subject, v_previous.body_text,
    v_previous.sender_name, v_previous.reply_to_email, v_previous.provider, 'queued', v_user_id,
    v_previous.id, v_previous.attempt_number + 1
  )
  returning * into v_row;

  insert into public.workspace_email_message_attachments (
    message_id, workspace_id, position, filename, mime_type, size_bytes, sha256, storage_path
  )
  select v_row.id, a.workspace_id, a.position, a.filename, a.mime_type, a.size_bytes, a.sha256, a.storage_path
  from public.workspace_email_message_attachments a
  where a.message_id = v_previous.id
  order by a.position;

  return jsonb_build_object('outcome', 'created', 'message', public.email_message_to_jsonb(v_row));
end;
$$;

revoke all on function public.retry_workspace_email_message(uuid, text, uuid, boolean) from public;
grant execute on function public.retry_workspace_email_message(uuid, text, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RPC: Lesen (Gesendet-Liste, Kunden-/Vorgangshistorie, Detail mit Kette)
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_email_messages(
  p_workspace_id uuid,
  p_customer_id text default null,
  p_vorgang_id text default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return coalesce((
    select jsonb_agg(public.email_message_to_jsonb(m) order by m.created_at desc, m.id)
    from (
      select *
      from public.workspace_email_messages m
      where m.workspace_id = p_workspace_id
        and (
          (v_customer_id is null and v_vorgang_id is null)
          or (v_customer_id is not null and m.customer_id = v_customer_id)
          or (v_vorgang_id is not null and m.vorgang_id = v_vorgang_id)
        )
      order by m.created_at desc, m.id
      limit v_limit
    ) m
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_workspace_email_messages(uuid, text, text, integer) from public;
grant execute on function public.list_workspace_email_messages(uuid, text, text, integer) to authenticated;

create or replace function public.get_workspace_email_message_chain(
  p_workspace_id uuid,
  p_message_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_root uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or p_message_id is null then
    raise exception 'workspace_id/message_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  with recursive up as (
    select m.id, m.retry_of_message_id, 0 as depth
    from public.workspace_email_messages m
    where m.id = p_message_id and m.workspace_id = p_workspace_id
    union all
    select p.id, p.retry_of_message_id, up.depth + 1
    from public.workspace_email_messages p
    join up on p.id = up.retry_of_message_id
    where p.workspace_id = p_workspace_id and up.depth < 50
  )
  select id into v_root from up order by depth desc limit 1;

  if v_root is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    with recursive down as (
      select m.id, 0 as depth
      from public.workspace_email_messages m
      where m.id = v_root
      union all
      select c.id, down.depth + 1
      from public.workspace_email_messages c
      join down on c.retry_of_message_id = down.id
      where c.workspace_id = p_workspace_id and down.depth < 50
    )
    select jsonb_agg(public.email_message_to_jsonb(m) order by m.attempt_number, m.created_at)
    from public.workspace_email_messages m
    where m.id in (select id from down)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_workspace_email_message_chain(uuid, uuid) from public;
grant execute on function public.get_workspace_email_message_chain(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Server-RPCs (nur Edge Function `send-email`, service_role)
-- ---------------------------------------------------------------------------

create or replace function public.get_workspace_email_message_for_send(
  p_workspace_id uuid,
  p_client_message_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.workspace_email_messages;
begin
  select * into v_row
  from public.workspace_email_messages
  where workspace_id = p_workspace_id and client_message_id = btrim(coalesce(p_client_message_id, ''));
  if v_row.id is null then
    return null;
  end if;
  return public.email_message_to_jsonb(v_row);
end;
$$;

create or replace function public.claim_workspace_email_message_for_send(
  p_message_id uuid,
  p_expected_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_email_messages;
begin
  if p_message_id is null or p_expected_row_version is null then
    raise exception 'message_id/row_version fehlt';
  end if;
  update public.workspace_email_messages
  set status = 'sending', sending_started_at = now(), row_version = row_version + 1, updated_at = now()
  where id = p_message_id and status = 'queued' and row_version = p_expected_row_version
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('claimed', true, 'message', public.email_message_to_jsonb(v_row));
  end if;
  select * into v_row from public.workspace_email_messages where id = p_message_id;
  if v_row.id is null then
    raise exception 'Nachricht nicht gefunden';
  end if;
  return jsonb_build_object('claimed', false, 'message', public.email_message_to_jsonb(v_row));
end;
$$;

create or replace function public.resolve_stale_workspace_email_message_claim(
  p_message_id uuid,
  p_stale_after_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_email_messages;
  v_seconds integer := greatest(coalesce(p_stale_after_seconds, 600), 120);
begin
  if p_message_id is null then
    raise exception 'message_id fehlt';
  end if;
  update public.workspace_email_messages
  set
    status = 'unknown',
    error_category = 'unknown',
    error_code = 'send_interrupted',
    error_message_safe = 'Der Versand wurde unterbrochen. Ob der E-Mail-Dienst die Nachricht angenommen hat, ist nicht sicher.',
    row_version = row_version + 1,
    updated_at = now()
  where id = p_message_id
    and status = 'sending'
    and sending_started_at < now() - make_interval(secs => v_seconds)
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('resolved', true, 'message', public.email_message_to_jsonb(v_row));
  end if;
  select * into v_row from public.workspace_email_messages where id = p_message_id;
  if v_row.id is null then
    raise exception 'Nachricht nicht gefunden';
  end if;
  return jsonb_build_object('resolved', false, 'message', public.email_message_to_jsonb(v_row));
end;
$$;

create or replace function public.update_workspace_email_message_status(
  p_message_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_category text default null,
  p_error_code text default null,
  p_error_message_safe text default null,
  p_expected_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_email_messages;
begin
  if p_message_id is null then
    raise exception 'message_id fehlt';
  end if;
  select * into v_row from public.workspace_email_messages where id = p_message_id for update;
  if v_row.id is null then
    raise exception 'Nachricht nicht gefunden';
  end if;
  if p_expected_row_version is not null and v_row.row_version <> p_expected_row_version then
    raise exception 'row_version veraltet';
  end if;
  if not public.email_message_transition_allowed(v_row.status, p_status) then
    raise exception 'Statusuebergang % -> % nicht erlaubt', v_row.status, p_status;
  end if;
  if p_status = 'provider_accepted' and nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
    raise exception 'provider_message_id fehlt';
  end if;
  if v_row.status = p_status then
    return public.email_message_to_jsonb(v_row);
  end if;

  update public.workspace_email_messages
  set
    status = p_status,
    provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
    provider_accepted_at = case when p_status = 'provider_accepted' then now() else provider_accepted_at end,
    failed_at = case when p_status = 'failed' then now() else failed_at end,
    error_category = case
      when p_status in ('failed', 'unknown') then coalesce(p_error_category, 'unknown')
      when p_status = 'provider_accepted' then null
      else error_category
    end,
    error_code = case when p_status in ('failed', 'unknown') then left(p_error_code, 64) when p_status = 'provider_accepted' then null else error_code end,
    error_message_safe = case when p_status in ('failed', 'unknown') then left(p_error_message_safe, 500) when p_status = 'provider_accepted' then null else error_message_safe end,
    row_version = row_version + 1,
    updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return public.email_message_to_jsonb(v_row);
end;
$$;

revoke all on function public.get_workspace_email_message_for_send(uuid, text) from public;
revoke all on function public.get_workspace_email_message_for_send(uuid, text) from authenticated;
grant execute on function public.get_workspace_email_message_for_send(uuid, text) to service_role;

revoke all on function public.claim_workspace_email_message_for_send(uuid, bigint) from public;
revoke all on function public.claim_workspace_email_message_for_send(uuid, bigint) from authenticated;
grant execute on function public.claim_workspace_email_message_for_send(uuid, bigint) to service_role;

revoke all on function public.resolve_stale_workspace_email_message_claim(uuid, integer) from public;
revoke all on function public.resolve_stale_workspace_email_message_claim(uuid, integer) from authenticated;
grant execute on function public.resolve_stale_workspace_email_message_claim(uuid, integer) to service_role;

revoke all on function public.update_workspace_email_message_status(uuid, text, text, text, text, text, bigint) from public;
revoke all on function public.update_workspace_email_message_status(uuid, text, text, text, text, text, bigint) from authenticated;
grant execute on function public.update_workspace_email_message_status(uuid, text, text, text, text, text, bigint) to service_role;
