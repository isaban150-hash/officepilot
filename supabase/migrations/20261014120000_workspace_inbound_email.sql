-- E-MAIL-07E — eingehende Firmen-E-Mails (Postfach, Import, Anhänge, Zuordnung).
--
-- Eine kanonische Mailentität: `workspace_email_messages` (07D) trägt jetzt
-- `direction = 'inbound'` neben `outbound`. Keine zweite Mailwelt. Die
-- 07D-Pfade für ausgehende Mail bleiben fachlich unverändert und werden
-- ausdrücklich auf `direction = 'outbound'` begrenzt (Liste, Versand-Laden,
-- Claim, Neuversuch, Rate-Limit) — eine eingegangene Mail kann nie gesendet,
-- nie als „Gesendet" gelistet und nie ins Versandlimit gezählt werden.
--
-- Neu:
--   * workspace_mailbox_connections — Workspace-gebundenes Postfach (Provider,
--     Adresse, Status, Cursor/Delta-Stand, sichere Fehlerkategorie).
--   * workspace_mailbox_credentials — nur ein Verweis auf ein Supabase-Vault-
--     Secret; für Clients weder les- noch schreibbar (keine Grants, RLS ohne
--     Policy). Zugangsdaten stehen nie im Klartext in Produkttabellen.
--   * workspace_mailbox_import_failures — eine kaputte Mail blockiert den Sync
--     nicht; sie wird dauerhaft vermerkt und der Cursor darf weiter.
--   * workspace_email_assignment_events — Audit jeder Zuordnungsänderung.
--   * privater Bucket inbound-email-attachments (nur der Server schreibt).
--
-- Sync-Protokoll (Edge Function sync-mailbox, service_role):
--   claim_workspace_mailbox_sync (Lease) → je Batch: import_workspace_inbound_email
--   bzw. record_workspace_inbound_import_failure → advance_workspace_mailbox_cursor
--   (erst NACH vollständig verarbeitetem Batch) → finish_workspace_mailbox_sync.
--   Nur der Lease-Inhaber darf Cursor und Import schreiben.
--
-- Deduplizierung (serverseitig, zweifach):
--   * (workspace_id, mailbox_connection_id, provider_message_id) — derselbe
--     Provider-Datensatz wird nie zweimal importiert,
--   * (workspace_id, internet_message_id normalisiert) — dieselbe Nachricht
--     (Message-ID) auch über zwei Postfächer nur einmal.
--
-- Automatische Zuordnung (deterministisch, keine Namensheuristik):
--   * Kunde nur, wenn die Absenderadresse exakt genau EINEM aktiven Kunden
--     gehört,
--   * Vorgang nur, wenn der Betreff genau EINE eindeutige Referenz
--     (Rechnungs-, Auftrags- oder Angebotsnummer) dieses Workspaces enthält
--     und der Vorgang zum erkannten Kunden gehört; ohne erkannten Kunden wird
--     der Vorgang nur vorgeschlagen (Zu prüfen),
--   * sonst „Zu prüfen". Manuell bestätigte Zuordnungen werden nie
--     automatisch überschrieben.
--
-- Setzt 20261012120000 (07D) voraus. Nur lokal; Anwendung auf die Cloud ist ein
-- eigener, freigegebener Schritt.

-- ---------------------------------------------------------------------------
-- 1. Mailbox-Verbindung + Zugangsdaten (Vault)
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider_type text not null,
  mailbox_address text not null,
  display_name text null,
  status text not null default 'disconnected',
  sync_cursor jsonb null,
  last_successful_sync_at timestamptz null,
  last_attempt_at timestamptz null,
  next_attempt_at timestamptz null,
  sync_lease_token uuid null,
  sync_lease_until timestamptz null,
  error_category text null,
  error_code text null,
  safe_error_message text null,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  constraint workspace_mailbox_connections_provider_check check (provider_type in ('microsoft_graph', 'google_gmail', 'inbound_channel', 'imap', 'stub')),
  constraint workspace_mailbox_connections_status_check check (status in ('connected', 'syncing', 'error', 'disconnected')),
  constraint workspace_mailbox_connections_address_check check (
    length(mailbox_address) between 3 and 254 and mailbox_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'
  ),
  constraint workspace_mailbox_connections_error_category_check check (
    error_category is null or error_category in ('auth', 'provider', 'network', 'rate_limited', 'reauthorize', 'unknown')
  ),
  constraint workspace_mailbox_connections_unique unique (workspace_id, provider_type, mailbox_address)
);

create index if not exists workspace_mailbox_connections_workspace_idx on public.workspace_mailbox_connections (workspace_id);

alter table public.workspace_mailbox_connections enable row level security;
drop policy if exists workspace_mailbox_connections_select_member on public.workspace_mailbox_connections;
create policy workspace_mailbox_connections_select_member
on public.workspace_mailbox_connections for select to authenticated
using (public.is_active_workspace_member(workspace_id));

create table if not exists public.workspace_mailbox_credentials (
  connection_id uuid primary key references public.workspace_mailbox_connections (id) on delete cascade,
  vault_secret_id uuid not null,
  updated_at timestamptz not null default now()
);

-- Nur Server: RLS ohne Policy, keine Grants für Clients.
alter table public.workspace_mailbox_credentials enable row level security;
revoke all on table public.workspace_mailbox_credentials from public, anon, authenticated;

create table if not exists public.workspace_mailbox_import_failures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.workspace_mailbox_connections (id) on delete cascade,
  provider_message_id text not null,
  error_code text not null,
  attempts integer not null default 1,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  constraint workspace_mailbox_import_failures_unique unique (connection_id, provider_message_id)
);

alter table public.workspace_mailbox_import_failures enable row level security;
drop policy if exists workspace_mailbox_import_failures_select_member on public.workspace_mailbox_import_failures;
create policy workspace_mailbox_import_failures_select_member
on public.workspace_mailbox_import_failures for select to authenticated
using (public.is_active_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- 2. Kanonische Mailentität um „eingehend" erweitern
-- ---------------------------------------------------------------------------

alter table public.workspace_email_messages
  add column if not exists mailbox_connection_id uuid null references public.workspace_mailbox_connections (id) on delete set null,
  add column if not exists internet_message_id text null,
  add column if not exists provider_thread_id text null,
  add column if not exists from_address text null,
  add column if not exists from_name text null,
  add column if not exists received_at timestamptz null,
  add column if not exists imported_at timestamptz null,
  add column if not exists has_html boolean not null default false,
  add column if not exists skipped_attachments jsonb not null default '[]'::jsonb,
  add column if not exists assignment_status text null,
  add column if not exists assignment_source text null,
  add column if not exists suggested_vorgang_id text null,
  add column if not exists assigned_by uuid null references auth.users (id) on delete set null,
  add column if not exists assigned_at timestamptz null;

-- Ausgehende Pflichtfelder gelten nur noch für ausgehende Mail.
alter table public.workspace_email_messages alter column sender_name drop not null;
alter table public.workspace_email_messages alter column reply_to_email drop not null;
alter table public.workspace_email_messages alter column requested_by drop not null;

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_direction_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_direction_check
  check (direction in ('outbound', 'inbound'));

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_to_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_to_check check (
  (direction = 'outbound' and cardinality(to_recipients) between 1 and 20)
  or (direction = 'inbound' and cardinality(to_recipients) <= 500)
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_recipient_total_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_recipient_total_check check (
  direction <> 'outbound'
  or cardinality(to_recipients) + cardinality(cc_recipients) + cardinality(bcc_recipients) <= 30
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_subject_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_subject_check check (
  (direction = 'outbound' and length(btrim(subject)) between 1 and 255)
  or (direction = 'inbound' and length(subject) <= 998)
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_body_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_body_check check (
  (direction = 'outbound' and length(btrim(body_text)) >= 1 and length(body_text) <= 20000)
  or (direction = 'inbound' and length(body_text) <= 200000)
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_provider_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_provider_check check (
  (direction = 'outbound' and provider in ('brevo', 'stub'))
  or (direction = 'inbound' and provider in ('microsoft_graph', 'google_gmail', 'inbound_channel', 'imap', 'stub'))
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_status_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_status_check check (
  (direction = 'outbound' and status in ('queued', 'sending', 'provider_accepted', 'failed', 'unknown'))
  or (direction = 'inbound' and status = 'received')
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_outbound_fields_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_outbound_fields_check check (
  direction <> 'outbound' or (sender_name is not null and reply_to_email is not null and requested_by is not null)
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_inbound_fields_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_inbound_fields_check check (
  direction <> 'inbound' or (
    mailbox_connection_id is not null and provider_message_id is not null and received_at is not null
    and imported_at is not null and assignment_status in ('assigned', 'needs_review')
    and retry_of_message_id is null
  )
);

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_assignment_source_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_assignment_source_check check (
  assignment_source is null or assignment_source in ('auto_sender', 'auto_reference', 'manual')
);

-- Deduplizierung eingehender Mail.
create unique index if not exists workspace_email_messages_inbound_provider_unique
  on public.workspace_email_messages (workspace_id, mailbox_connection_id, provider_message_id)
  where direction = 'inbound';
create unique index if not exists workspace_email_messages_inbound_message_id_unique
  on public.workspace_email_messages (workspace_id, lower(internet_message_id))
  where direction = 'inbound' and internet_message_id is not null;
create index if not exists workspace_email_messages_inbound_received_idx
  on public.workspace_email_messages (workspace_id, received_at desc)
  where direction = 'inbound';

-- Anhänge: eingehende Dateien dürfen größer sein (ausgehend bleibt 4 MiB, erzwungen im Anlegen).
alter table public.workspace_email_message_attachments
  add column if not exists original_filename text null,
  add column if not exists storage_bucket text not null default 'email-attachments';
alter table public.workspace_email_message_attachments drop constraint if exists workspace_email_message_attachments_size_check;
alter table public.workspace_email_message_attachments add constraint workspace_email_message_attachments_size_check
  check (size_bytes > 0 and size_bytes <= 26214400);
alter table public.workspace_email_message_attachments drop constraint if exists workspace_email_message_attachments_position_check;
alter table public.workspace_email_message_attachments add constraint workspace_email_message_attachments_position_check
  check (position between 1 and 100);
alter table public.workspace_email_message_attachments drop constraint if exists workspace_email_message_attachments_bucket_check;
alter table public.workspace_email_message_attachments add constraint workspace_email_message_attachments_bucket_check
  check (storage_bucket in ('email-attachments', 'inbound-email-attachments'));

create table if not exists public.workspace_email_assignment_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id uuid not null references public.workspace_email_messages (id) on delete cascade,
  previous_customer_id text null,
  previous_vorgang_id text null,
  customer_id text null,
  vorgang_id text null,
  source text not null,
  actor uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint workspace_email_assignment_events_source_check check (source in ('auto_sender', 'auto_reference', 'manual', 'import'))
);
create index if not exists workspace_email_assignment_events_message_idx on public.workspace_email_assignment_events (message_id, created_at);
alter table public.workspace_email_assignment_events enable row level security;
drop policy if exists workspace_email_assignment_events_select_member on public.workspace_email_assignment_events;
create policy workspace_email_assignment_events_select_member
on public.workspace_email_assignment_events for select to authenticated
using (public.is_active_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- 3. Privater Bucket für eingehende Anhänge (nur der Server schreibt)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inbound-email-attachments', 'inbound-email-attachments', false, 26214400,
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists inbound_email_attachments_select_member on storage.objects;
create policy inbound_email_attachments_select_member
on storage.objects for select to authenticated
using (bucket_id = 'inbound-email-attachments' and public.email_attachment_can_read(name));
-- Keine insert/update/delete-Policy: Uploads nur über den Server (service_role).

-- ---------------------------------------------------------------------------
-- 4. JSON-Form + 07D-Pfade ausdrücklich auf ausgehende Mail begrenzen
-- ---------------------------------------------------------------------------

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
        'original_filename', a.original_filename,
        'mime_type', a.mime_type,
        'size_bytes', a.size_bytes,
        'sha256', a.sha256,
        'storage_path', a.storage_path,
        'storage_bucket', a.storage_bucket
      ) order by a.position)
      from public.workspace_email_message_attachments a
      where a.message_id = p_message.id
    ), '[]'::jsonb)
  );
$$;

create or replace function public.email_message_assert_rate_limit(p_workspace_id uuid, p_user_id uuid, p_new_recipients integer)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- 07E: nur ausgehende Nachrichten zählen; eingegangene Mail nie.
  if (
    select count(*) from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id and m.direction = 'outbound' and m.requested_by = p_user_id
      and m.created_at > now() - interval '10 minutes'
  ) >= 20
  or (
    select count(*) from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id and m.direction = 'outbound'
      and m.created_at > now() - interval '10 minutes'
  ) >= 60
  or (
    select coalesce(sum(cardinality(m.to_recipients) + cardinality(m.cc_recipients) + cardinality(m.bcc_recipients)), 0)
    from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id and m.direction = 'outbound'
      and m.created_at > now() - interval '60 minutes'
  ) + p_new_recipients > 300 then
    raise exception 'Versandlimit erreicht: bitte in einigen Minuten erneut versuchen';
  end if;
end;
$$;

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

  -- 07E: „Gesendet" bleibt ausschließlich ausgehend.
  return coalesce((
    select jsonb_agg(public.email_message_to_jsonb(m) order by m.created_at desc, m.id)
    from (
      select *
      from public.workspace_email_messages m
      where m.workspace_id = p_workspace_id
        and m.direction = 'outbound'
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
    where m.id = p_message_id and m.workspace_id = p_workspace_id and m.direction = 'outbound'
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
    where m.id in (select id from down) and m.direction = 'outbound'
  ), '[]'::jsonb);
end;
$$;

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
  -- 07E: eine eingegangene Mail ist nie ein Versandauftrag.
  select * into v_row
  from public.workspace_email_messages
  where workspace_id = p_workspace_id and client_message_id = btrim(coalesce(p_client_message_id, ''))
    and direction = 'outbound';
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
  where id = p_message_id and direction = 'outbound' and status = 'queued' and row_version = p_expected_row_version
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

-- ---------------------------------------------------------------------------
-- 5. Automatische Zuordnung (deterministisch)
-- ---------------------------------------------------------------------------

create or replace function public.email_inbound_resolve_assignment(
  p_workspace_id uuid,
  p_from_address text,
  p_subject text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from text := lower(btrim(coalesce(p_from_address, '')));
  v_customer_ids text[];
  v_customer_id text;
  v_tokens text[];
  v_vorgang_ids text[];
  v_vorgang_id text;
  v_vorgang_customer text;
begin
  -- Kunde: exakte Absenderadresse, genau ein aktiver Kunde dieses Workspaces.
  if v_from <> '' then
    select coalesce(array_agg(distinct c.customer_id), '{}') into v_customer_ids
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id and not c.deleted
      and lower(btrim(coalesce(c.payload->>'email', ''))) = v_from;
    if cardinality(v_customer_ids) = 1 then
      v_customer_id := v_customer_ids[1];
    end if;
  end if;

  -- Referenzen im Betreff: Wörter mit Ziffer, exakt gegen die Nummern DIESES Workspaces.
  select coalesce(array_agg(distinct t), '{}') into v_tokens
  from regexp_split_to_table(upper(coalesce(p_subject, '')), '[^A-Z0-9/._-]+') as t
  where t ~ '[0-9]' and length(t) between 4 and 40;

  if cardinality(v_tokens) > 0 then
    select coalesce(array_agg(distinct x.vorgang_id), '{}') into v_vorgang_ids
    from (
      select i.vorgang_id
      from public.workspace_invoices i
      where i.workspace_id = p_workspace_id and upper(i.invoice_number) = any (v_tokens)
      union
      select v.vorgang_id
      from public.workspace_vorgaenge v
      where v.workspace_id = p_workspace_id and not v.deleted and v.order_number is not null and upper(v.order_number) = any (v_tokens)
      union
      select v.vorgang_id
      from public.workspace_offers o
      join public.workspace_vorgaenge v
        on v.workspace_id = o.workspace_id and v.source_offer_id = o.client_offer_id and not v.deleted
      where o.workspace_id = p_workspace_id and not o.deleted and o.offer_number is not null and upper(o.offer_number) = any (v_tokens)
    ) x
    where exists (
      select 1 from public.workspace_vorgaenge vv
      where vv.workspace_id = p_workspace_id and vv.vorgang_id = x.vorgang_id and not vv.deleted
    );
    if cardinality(v_vorgang_ids) = 1 then
      v_vorgang_id := v_vorgang_ids[1];
      select nullif(btrim(coalesce(payload->>'customerId', '')), '') into v_vorgang_customer
      from public.workspace_vorgaenge where workspace_id = p_workspace_id and vorgang_id = v_vorgang_id;
    end if;
  end if;

  if v_customer_id is not null then
    if v_vorgang_id is not null and v_vorgang_customer = v_customer_id then
      return jsonb_build_object('status', 'assigned', 'source', 'auto_reference', 'customer_id', v_customer_id, 'vorgang_id', v_vorgang_id, 'suggested_vorgang_id', null);
    end if;
    -- Referenz eines anderen Kunden oder mehrdeutig: Kunde ja, Vorgang nur als Vorschlag.
    return jsonb_build_object('status', 'assigned', 'source', 'auto_sender', 'customer_id', v_customer_id, 'vorgang_id', null,
      'suggested_vorgang_id', case when v_vorgang_id is not null and v_vorgang_customer = v_customer_id then v_vorgang_id else null end);
  end if;
  return jsonb_build_object('status', 'needs_review', 'source', null, 'customer_id', null, 'vorgang_id', null, 'suggested_vorgang_id', v_vorgang_id);
end;
$$;

revoke all on function public.email_inbound_resolve_assignment(uuid, text, text) from public;
grant execute on function public.email_inbound_resolve_assignment(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Server-RPCs: Verbindung, Lease, Cursor, Import (nur service_role)
-- ---------------------------------------------------------------------------

create or replace function public.claim_workspace_mailbox_sync(
  p_connection_id uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_mailbox_connections;
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
begin
  update public.workspace_mailbox_connections
  set status = 'syncing', sync_lease_token = gen_random_uuid(), sync_lease_until = now() + make_interval(secs => v_seconds),
      last_attempt_at = now(), updated_at = now(), row_version = row_version + 1
  where id = p_connection_id
    and status <> 'disconnected'
    and (sync_lease_until is null or sync_lease_until < now())
    and (next_attempt_at is null or next_attempt_at <= now())
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('claimed', true, 'connection', to_jsonb(v_row));
  end if;
  select * into v_row from public.workspace_mailbox_connections where id = p_connection_id;
  if v_row.id is null then
    raise exception 'Postfach nicht gefunden';
  end if;
  return jsonb_build_object('claimed', false, 'connection', to_jsonb(v_row) - 'sync_lease_token');
end;
$$;

create or replace function public.advance_workspace_mailbox_cursor(
  p_connection_id uuid,
  p_lease_token uuid,
  p_cursor jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workspace_mailbox_connections
  set sync_cursor = p_cursor, updated_at = now(), row_version = row_version + 1
  where id = p_connection_id and sync_lease_token = p_lease_token and sync_lease_until > now();
  if not found then
    raise exception 'Sync-Lease ungueltig';
  end if;
end;
$$;

create or replace function public.finish_workspace_mailbox_sync(
  p_connection_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error_category text default null,
  p_error_code text default null,
  p_safe_message text default null,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_mailbox_connections;
begin
  if p_status not in ('connected', 'error', 'disconnected') then
    raise exception 'status ungueltig';
  end if;
  update public.workspace_mailbox_connections
  set status = p_status,
      last_successful_sync_at = case when p_status = 'connected' then now() else last_successful_sync_at end,
      error_category = case when p_status = 'connected' then null else p_error_category end,
      error_code = case when p_status = 'connected' then null else left(p_error_code, 64) end,
      safe_error_message = case when p_status = 'connected' then null else left(p_safe_message, 300) end,
      next_attempt_at = case when p_retry_after_seconds is not null and p_retry_after_seconds > 0 then now() + make_interval(secs => least(p_retry_after_seconds, 86400)) else null end,
      sync_lease_token = null, sync_lease_until = null,
      updated_at = now(), row_version = row_version + 1
  where id = p_connection_id and sync_lease_token = p_lease_token
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Sync-Lease ungueltig';
  end if;
  return to_jsonb(v_row) - 'sync_lease_token';
end;
$$;

create or replace function public.import_workspace_inbound_email(
  p_connection_id uuid,
  p_lease_token uuid,
  p_message jsonb,
  p_attachments jsonb,
  p_skipped_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection public.workspace_mailbox_connections;
  v_provider_message_id text := nullif(btrim(coalesce(p_message->>'provider_message_id', '')), '');
  v_internet_message_id text := nullif(btrim(coalesce(p_message->>'internet_message_id', '')), '');
  v_existing public.workspace_email_messages;
  v_assignment jsonb;
  v_row public.workspace_email_messages;
  v_attachment jsonb;
  v_position integer := 0;
  v_received timestamptz;
begin
  select * into v_connection from public.workspace_mailbox_connections where id = p_connection_id;
  if v_connection.id is null or v_connection.sync_lease_token is distinct from p_lease_token or v_connection.sync_lease_until <= now() then
    raise exception 'Sync-Lease ungueltig';
  end if;
  if v_provider_message_id is null or length(v_provider_message_id) > 512 then
    raise exception 'provider_message_id ungueltig';
  end if;
  if v_internet_message_id is not null and length(v_internet_message_id) > 998 then
    v_internet_message_id := null;
  end if;

  -- Deduplizierung: Provider-Kennung dieses Postfachs, dann Message-ID im Workspace.
  select * into v_existing from public.workspace_email_messages
  where workspace_id = v_connection.workspace_id and direction = 'inbound'
    and mailbox_connection_id = v_connection.id and provider_message_id = v_provider_message_id;
  if v_existing.id is null and v_internet_message_id is not null then
    select * into v_existing from public.workspace_email_messages
    where workspace_id = v_connection.workspace_id and direction = 'inbound'
      and lower(internet_message_id) = lower(v_internet_message_id);
  end if;
  if v_existing.id is not null then
    delete from public.workspace_mailbox_import_failures where connection_id = v_connection.id and provider_message_id = v_provider_message_id;
    return jsonb_build_object('outcome', 'duplicate', 'message_id', v_existing.id);
  end if;

  begin
    v_received := (p_message->>'received_at')::timestamptz;
  exception when others then
    v_received := now();
  end;

  v_assignment := public.email_inbound_resolve_assignment(v_connection.workspace_id, p_message->>'from_address', p_message->>'subject');

  insert into public.workspace_email_messages (
    workspace_id, client_message_id, direction, provider, provider_message_id, mailbox_connection_id,
    internet_message_id, provider_thread_id, from_address, from_name,
    to_recipients, cc_recipients, bcc_recipients, subject, body_text, has_html,
    status, received_at, imported_at, skipped_attachments,
    customer_id, vorgang_id, assignment_status, assignment_source, suggested_vorgang_id
  ) values (
    v_connection.workspace_id,
    'in:' || v_connection.id::text || ':' || md5(v_provider_message_id),
    'inbound', v_connection.provider_type, v_provider_message_id, v_connection.id,
    v_internet_message_id, left(nullif(btrim(coalesce(p_message->>'provider_thread_id', '')), ''), 512),
    left(lower(nullif(btrim(coalesce(p_message->>'from_address', '')), '')), 254), left(nullif(btrim(coalesce(p_message->>'from_name', '')), ''), 200),
    coalesce((select array_agg(left(lower(btrim(x)), 254)) from jsonb_array_elements_text(coalesce(p_message->'to', '[]'::jsonb)) as t(x) where btrim(x) <> ''), '{}'),
    coalesce((select array_agg(left(lower(btrim(x)), 254)) from jsonb_array_elements_text(coalesce(p_message->'cc', '[]'::jsonb)) as t(x) where btrim(x) <> ''), '{}'),
    '{}',
    left(coalesce(p_message->>'subject', ''), 998),
    left(coalesce(p_message->>'body_text', ''), 200000),
    coalesce((p_message->>'has_html')::boolean, false),
    'received', v_received, now(),
    coalesce(p_skipped_attachments, '[]'::jsonb),
    v_assignment->>'customer_id', v_assignment->>'vorgang_id', v_assignment->>'status', v_assignment->>'source', v_assignment->>'suggested_vorgang_id'
  )
  returning * into v_row;

  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    v_position := v_position + 1;
    if public.email_attachment_workspace_id(v_attachment->>'storage_path') is distinct from v_connection.workspace_id then
      raise exception 'Anhang: Speicherpfad ungueltig';
    end if;
    if split_part(split_part(v_attachment->>'storage_path', '/', 2), '.', 1) <> lower(v_attachment->>'sha256') then
      raise exception 'Anhang: Pruefwert passt nicht zum Pfad';
    end if;
    if public.email_attachment_mime_for_extension(split_part(split_part(v_attachment->>'storage_path', '/', 2), '.', 2)) is distinct from v_attachment->>'mime_type' then
      raise exception 'Anhang: Dateityp nicht erlaubt';
    end if;
    insert into public.workspace_email_message_attachments (
      message_id, workspace_id, position, filename, original_filename, mime_type, size_bytes, sha256, storage_path, storage_bucket
    ) values (
      v_row.id, v_connection.workspace_id, v_position,
      left(v_attachment->>'filename', 150), left(v_attachment->>'original_filename', 500), v_attachment->>'mime_type',
      (v_attachment->>'size_bytes')::bigint, lower(v_attachment->>'sha256'), v_attachment->>'storage_path', 'inbound-email-attachments'
    );
  end loop;

  insert into public.workspace_email_assignment_events (workspace_id, message_id, customer_id, vorgang_id, source)
  values (v_connection.workspace_id, v_row.id, v_row.customer_id, v_row.vorgang_id, coalesce(v_row.assignment_source, 'import'));

  delete from public.workspace_mailbox_import_failures where connection_id = v_connection.id and provider_message_id = v_provider_message_id;
  return jsonb_build_object('outcome', 'imported', 'message_id', v_row.id, 'assignment_status', v_row.assignment_status);
end;
$$;

create or replace function public.record_workspace_inbound_import_failure(
  p_connection_id uuid,
  p_lease_token uuid,
  p_provider_message_id text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection public.workspace_mailbox_connections;
  v_attempts integer;
begin
  select * into v_connection from public.workspace_mailbox_connections where id = p_connection_id;
  if v_connection.id is null or v_connection.sync_lease_token is distinct from p_lease_token or v_connection.sync_lease_until <= now() then
    raise exception 'Sync-Lease ungueltig';
  end if;
  insert into public.workspace_mailbox_import_failures (workspace_id, connection_id, provider_message_id, error_code)
  values (v_connection.workspace_id, v_connection.id, left(btrim(p_provider_message_id), 512), left(coalesce(p_error_code, 'unknown'), 64))
  on conflict (connection_id, provider_message_id) do update
  set attempts = workspace_mailbox_import_failures.attempts + 1, error_code = excluded.error_code, last_failed_at = now()
  returning attempts into v_attempts;
  return jsonb_build_object('attempts', v_attempts);
end;
$$;

-- Gehört das Postfach zu diesem Workspace? (Edge Function prüft vor jedem Abruf.)
create or replace function public.mailbox_connection_belongs_to_workspace(p_connection_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_mailbox_connections c
    where c.id = p_connection_id and c.workspace_id = p_workspace_id
  );
$$;

-- Zugangsdaten: nur der Server legt sie im Vault ab bzw. liest sie.
create or replace function public.set_workspace_mailbox_credential(p_connection_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing uuid;
begin
  if p_connection_id is null or coalesce(p_secret, '') = '' then
    raise exception 'Zugangsdaten fehlen';
  end if;
  select vault_secret_id into v_existing from public.workspace_mailbox_credentials where connection_id = p_connection_id;
  if v_existing is null then
    insert into public.workspace_mailbox_credentials (connection_id, vault_secret_id)
    values (p_connection_id, vault.create_secret(p_secret, 'mailbox-' || p_connection_id::text, 'OfficeTakt Postfach-Zugang'));
  else
    perform vault.update_secret(v_existing, p_secret);
    update public.workspace_mailbox_credentials set updated_at = now() where connection_id = p_connection_id;
  end if;
end;
$$;

create or replace function public.get_workspace_mailbox_credential(p_connection_id uuid)
returns text
language sql
stable
security definer
set search_path = public, vault
as $$
  select s.decrypted_secret
  from public.workspace_mailbox_credentials c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.connection_id = p_connection_id;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'claim_workspace_mailbox_sync(uuid, integer)',
    'advance_workspace_mailbox_cursor(uuid, uuid, jsonb)',
    'finish_workspace_mailbox_sync(uuid, uuid, text, text, text, text, integer)',
    'import_workspace_inbound_email(uuid, uuid, jsonb, jsonb, jsonb)',
    'record_workspace_inbound_import_failure(uuid, uuid, text, text)',
    'set_workspace_mailbox_credential(uuid, text)',
    'get_workspace_mailbox_credential(uuid)',
    'mailbox_connection_belongs_to_workspace(uuid, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);
    execute format('revoke all on function public.%s from authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Client-RPCs: Postfächer, Posteingang, Detail, manuelle Zuordnung
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_mailbox_connections(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  -- Kein Cursor, kein Lease, keine Zugangsdaten nach außen.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'provider_type', c.provider_type, 'mailbox_address', c.mailbox_address, 'display_name', c.display_name,
      'status', c.status, 'last_successful_sync_at', c.last_successful_sync_at, 'last_attempt_at', c.last_attempt_at,
      'next_attempt_at', c.next_attempt_at, 'error_category', c.error_category, 'safe_error_message', c.safe_error_message,
      'has_credentials', exists (select 1 from public.workspace_mailbox_credentials k where k.connection_id = c.id)
    ) order by c.created_at)
    from public.workspace_mailbox_connections c
    where c.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.list_workspace_inbound_email_messages(
  p_workspace_id uuid,
  p_customer_id text default null,
  p_vorgang_id text default null,
  p_needs_review_only boolean default false,
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
  if p_workspace_id is null or not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  return coalesce((
    select jsonb_agg(public.email_message_to_jsonb(m) order by m.received_at desc, m.id)
    from (
      select *
      from public.workspace_email_messages m
      where m.workspace_id = p_workspace_id
        and m.direction = 'inbound'
        and (not coalesce(p_needs_review_only, false) or m.assignment_status = 'needs_review')
        and (
          (v_customer_id is null and v_vorgang_id is null)
          or (v_customer_id is not null and m.customer_id = v_customer_id)
          or (v_vorgang_id is not null and m.vorgang_id = v_vorgang_id)
        )
      order by m.received_at desc, m.id
      limit v_limit
    ) m
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_workspace_inbound_email_message(p_workspace_id uuid, p_message_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.workspace_email_messages;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  select * into v_row from public.workspace_email_messages
  where id = p_message_id and workspace_id = p_workspace_id and direction = 'inbound';
  if v_row.id is null then
    return null;
  end if;
  return public.email_message_to_jsonb(v_row);
end;
$$;

create or replace function public.assign_workspace_inbound_email_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_customer_id text,
  p_vorgang_id text,
  p_expected_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
  v_vorgang_customer text;
  v_row public.workspace_email_messages;
  v_previous public.workspace_email_messages;
begin
  if v_user is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  select * into v_previous from public.workspace_email_messages
  where id = p_message_id and workspace_id = p_workspace_id and direction = 'inbound'
  for update;
  if v_previous.id is null then
    raise exception 'Nachricht nicht gefunden';
  end if;
  if p_expected_row_version is not null and v_previous.row_version <> p_expected_row_version then
    raise exception 'row_version veraltet';
  end if;

  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and not c.deleted
  ) then
    raise exception 'customer_id gehoert nicht zum Workspace';
  end if;
  if v_vorgang_id is not null then
    select nullif(btrim(coalesce(v.payload->>'customerId', '')), '') into v_vorgang_customer
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id and not v.deleted;
    if not found then
      raise exception 'vorgang_id gehoert nicht zum Workspace';
    end if;
    -- Ein Vorgang mit Kunde passt nur zu genau diesem Kunden (auch nicht zu „kein Kunde").
    if v_vorgang_customer is not null and v_vorgang_customer is distinct from v_customer_id then
      raise exception 'Kunde passt nicht zum Vorgang';
    end if;
  end if;

  update public.workspace_email_messages
  set customer_id = v_customer_id,
      vorgang_id = v_vorgang_id,
      assignment_status = case when v_customer_id is null and v_vorgang_id is null then 'needs_review' else 'assigned' end,
      assignment_source = 'manual',
      suggested_vorgang_id = null,
      assigned_by = v_user,
      assigned_at = now(),
      row_version = row_version + 1,
      updated_at = now()
  where id = v_previous.id
  returning * into v_row;

  insert into public.workspace_email_assignment_events (workspace_id, message_id, previous_customer_id, previous_vorgang_id, customer_id, vorgang_id, source, actor)
  values (p_workspace_id, v_row.id, v_previous.customer_id, v_previous.vorgang_id, v_row.customer_id, v_row.vorgang_id, 'manual', v_user);

  return public.email_message_to_jsonb(v_row);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'list_workspace_mailbox_connections(uuid)',
    'list_workspace_inbound_email_messages(uuid, text, text, boolean, integer)',
    'get_workspace_inbound_email_message(uuid, uuid)',
    'assign_workspace_inbound_email_message(uuid, uuid, text, text, bigint)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
