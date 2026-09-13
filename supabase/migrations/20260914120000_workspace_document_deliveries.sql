-- EMAIL-01B1 — Versand-Datenmodell, Attachment-Storage und Server-Vertrag.
--
-- Eine generische Tabelle fuer den Versand von Geschaeftsdokumenten
-- (Rechnung, Rechnungskorrektur, spaeter Brief/Angebot). Sie traegt den Audit
-- eines Versandauftrags: welches historische Dokument, an welche Adresse, mit
-- welchem Betreff/Text und welchem Anhang (nur Referenz + Hash, nie Bytes),
-- ausgeloest von wem, mit welchem Provider-Ergebnis.
--
-- Bewusst NICHT in diesem Block: der Provider-Aufruf (EMAIL-01B2, Edge
-- Function). Die RPCs hier legen den Auftrag nur idempotent an und lesen ihn.
--
-- Statusmodell (monoton, siehe document_delivery_transition_allowed):
--   prepared -> queued -> provider_accepted -> delivered | bounced | complained
--   queued   -> failed | rejected | unknown
--   unknown  -> provider_accepted | failed
-- `provider_accepted` heisst „an den Provider uebergeben" — NICHT „zugestellt".

-- ---------------------------------------------------------------------------
-- 1. Tabelle
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_document_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_delivery_id text not null,
  document_kind text not null,
  linked_invoice_id text null,
  linked_document_id text null,

  recipient_email text not null,
  subject text not null,
  body_text text not null,

  attachment_storage_path text null,
  attachment_sha256 text null,
  attachment_size_bytes bigint null,
  attachment_filename text null,
  attachment_mime_type text null,

  provider text not null,
  provider_message_id text null,

  status text not null default 'queued',
  requested_by uuid not null references auth.users (id) on delete restrict,
  requested_at timestamptz not null default now(),
  provider_accepted_at timestamptz null,
  failed_at timestamptz null,

  error_category text null,
  error_code text null,
  error_message_safe text null,

  retry_of_delivery_id uuid null references public.workspace_document_deliveries (id) on delete restrict,
  attempt_number integer not null default 1,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,

  -- Idempotenz: eine Sendeabsicht je Workspace.
  constraint workspace_document_deliveries_client_id_unique unique (workspace_id, client_delivery_id),

  constraint workspace_document_deliveries_kind_check check (
    document_kind in ('invoice', 'invoice_correction', 'letter', 'offer', 'other')
  ),
  -- Rechnungsdokumente referenzieren immer eine Rechnung — nie einen Vorgang.
  constraint workspace_document_deliveries_invoice_link_check check (
    document_kind not in ('invoice', 'invoice_correction')
    or nullif(btrim(coalesce(linked_invoice_id, '')), '') is not null
  ),
  constraint workspace_document_deliveries_status_check check (
    status in (
      'prepared', 'queued', 'provider_accepted', 'failed', 'unknown',
      'delivered', 'bounced', 'complained', 'rejected'
    )
  ),
  constraint workspace_document_deliveries_provider_check check (provider in ('brevo', 'stub')),
  constraint workspace_document_deliveries_error_category_check check (
    error_category is null
    or error_category in ('auth', 'recipient', 'provider', 'attachment', 'network', 'unknown')
  ),
  constraint workspace_document_deliveries_attempt_check check (attempt_number >= 1),
  constraint workspace_document_deliveries_retry_self_check check (retry_of_delivery_id is distinct from id),
  -- Anhang: entweder vollstaendig oder gar nicht; Pfad immer im eigenen Workspace.
  constraint workspace_document_deliveries_attachment_complete_check check (
    (attachment_storage_path is null and attachment_sha256 is null and attachment_size_bytes is null
      and attachment_filename is null and attachment_mime_type is null)
    or (attachment_storage_path is not null and attachment_sha256 is not null and attachment_size_bytes is not null
      and attachment_filename is not null and attachment_mime_type is not null)
  ),
  constraint workspace_document_deliveries_attachment_path_check check (
    attachment_storage_path is null
    or position(workspace_id::text || '/' in attachment_storage_path) = 1
  ),
  constraint workspace_document_deliveries_attachment_sha_check check (
    attachment_sha256 is null or attachment_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint workspace_document_deliveries_attachment_size_check check (
    attachment_size_bytes is null or (attachment_size_bytes > 0 and attachment_size_bytes <= 10485760)
  ),
  constraint workspace_document_deliveries_attachment_mime_check check (
    attachment_mime_type is null or attachment_mime_type = 'application/pdf'
  ),
  -- Zustandsfelder passen zum Status.
  constraint workspace_document_deliveries_accepted_fields_check check (
    status not in ('provider_accepted', 'delivered', 'bounced', 'complained')
    or (provider_accepted_at is not null and provider_message_id is not null)
  ),
  constraint workspace_document_deliveries_failed_fields_check check (
    status not in ('failed', 'rejected') or (failed_at is not null and error_category is not null)
  )
);

create index if not exists workspace_document_deliveries_invoice_idx
  on public.workspace_document_deliveries (workspace_id, linked_invoice_id, requested_at desc);

create index if not exists workspace_document_deliveries_status_idx
  on public.workspace_document_deliveries (workspace_id, status);

create index if not exists workspace_document_deliveries_provider_message_idx
  on public.workspace_document_deliveries (provider, provider_message_id)
  where provider_message_id is not null;

alter table public.workspace_document_deliveries enable row level security;

-- Lesen: aktive Mitglieder des Workspaces. Schreiben nur ueber RPC/Server.
drop policy if exists workspace_document_deliveries_select_member on public.workspace_document_deliveries;
create policy workspace_document_deliveries_select_member
on public.workspace_document_deliveries for select to authenticated
using (public.is_active_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- 2. Statusmaschine
-- ---------------------------------------------------------------------------

create or replace function public.document_delivery_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_from = p_to then true
    when p_from = 'prepared' then p_to in ('queued', 'failed')
    when p_from = 'queued' then p_to in ('provider_accepted', 'failed', 'rejected', 'unknown')
    when p_from = 'unknown' then p_to in ('provider_accepted', 'failed')
    when p_from = 'provider_accepted' then p_to in ('delivered', 'bounced', 'complained')
    else false
  end;
$$;

grant execute on function public.document_delivery_transition_allowed(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Attachment-Storage: privater Bucket, Pfad {workspace}/{dokument}/{sha256}.pdf
-- ---------------------------------------------------------------------------

create or replace function public.document_delivery_attachment_workspace_id(p_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[0-9a-f]{64}\.pdf$'
     and p_name !~ '\.\.'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

grant execute on function public.document_delivery_attachment_workspace_id(text) to authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('document-deliveries', 'document-deliveries', false, 10485760, array['application/pdf'])
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Bruecke wie bei branding-assets (BRANDING-01D): die Membership-Helfer sind
-- der Allgemeinheit entzogen; Storage-Policies laufen ueber security-definer.
create or replace function public.document_delivery_attachment_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.is_active_workspace_member(public.document_delivery_attachment_workspace_id(p_name)),
    false
  );
$$;

create or replace function public.document_delivery_attachment_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.document_delivery_attachment_workspace_id(p_name)),
    false
  );
$$;

revoke all on function public.document_delivery_attachment_can_read(text) from public;
revoke all on function public.document_delivery_attachment_can_write(text) from public;
grant execute on function public.document_delivery_attachment_can_read(text) to authenticated;
grant execute on function public.document_delivery_attachment_can_write(text) to authenticated;

drop policy if exists document_deliveries_select_member on storage.objects;
create policy document_deliveries_select_member
on storage.objects for select to authenticated
using (
  bucket_id = 'document-deliveries'
  and public.document_delivery_attachment_can_read(name)
);

drop policy if exists document_deliveries_insert_writer on storage.objects;
create policy document_deliveries_insert_writer
on storage.objects for insert to authenticated
with check (
  bucket_id = 'document-deliveries'
  and public.document_delivery_attachment_can_write(name)
);

-- Retention (G): keine update-/delete-Policy fuer Clients — ein referenzierter
-- Anhang bleibt bestehen. Bereinigung ist ein spaeterer, bewusster Serverpfad.

-- ---------------------------------------------------------------------------
-- 4. Rechnung: Herkunft der Versandwahrheit (Vorbereitung EMAIL-01B2)
-- ---------------------------------------------------------------------------

alter table public.workspace_invoices
  add column if not exists sent_source text null,
  add column if not exists sent_delivery_id uuid null references public.workspace_document_deliveries (id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_invoices_sent_source_check'
  ) then
    alter table public.workspace_invoices
      add constraint workspace_invoices_sent_source_check
      check (sent_source is null or sent_source in ('manual', 'officepilot'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. RPC: Delivery idempotent anlegen (kein Provider-Aufruf)
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace_document_delivery(
  p_workspace_id uuid,
  p_client_delivery_id text,
  p_document_kind text,
  p_linked_invoice_id text,
  p_recipient_email text,
  p_subject text,
  p_body_text text,
  p_attachment_storage_path text,
  p_attachment_sha256 text,
  p_attachment_size_bytes bigint,
  p_attachment_filename text,
  p_attachment_mime_type text,
  p_provider text,
  p_retry_of_delivery_id uuid default null,
  p_linked_document_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_delivery_id text;
  v_document_kind text;
  v_linked_invoice_id text;
  v_linked_document_id text;
  v_recipient text;
  v_subject text;
  v_body text;
  v_path text;
  v_sha text;
  v_filename text;
  v_mime text;
  v_provider text;
  v_invoice public.workspace_invoices;
  v_existing public.workspace_document_deliveries;
  v_retry_of public.workspace_document_deliveries;
  v_attempt integer := 1;
  v_row public.workspace_document_deliveries;
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
  -- Versand ist Aussenkommunikation im Namen des Betriebs: Schreibrecht (owner/admin).
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_client_delivery_id := nullif(btrim(coalesce(p_client_delivery_id, '')), '');
  if v_client_delivery_id is null or length(v_client_delivery_id) > 128 then
    raise exception 'client_delivery_id ungueltig';
  end if;

  v_document_kind := nullif(btrim(coalesce(p_document_kind, '')), '');
  if v_document_kind is null or v_document_kind not in ('invoice', 'invoice_correction') then
    -- Brief/Angebot: Modell traegt es, der Versandvertrag folgt spaeter.
    raise exception 'document_kind nicht unterstuetzt';
  end if;

  v_linked_invoice_id := nullif(btrim(coalesce(p_linked_invoice_id, '')), '');
  if v_linked_invoice_id is null then
    raise exception 'linked_invoice_id fehlt';
  end if;
  v_linked_document_id := nullif(btrim(coalesce(p_linked_document_id, '')), '');

  v_recipient := lower(btrim(coalesce(p_recipient_email, '')));
  if v_recipient = '' or length(v_recipient) > 254
     or v_recipient !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'recipient_email ungueltig';
  end if;

  v_subject := nullif(btrim(coalesce(p_subject, '')), '');
  if v_subject is null or length(v_subject) > 255 then
    raise exception 'subject ungueltig';
  end if;
  v_body := coalesce(p_body_text, '');
  if btrim(v_body) = '' or length(v_body) > 20000 then
    raise exception 'body_text ungueltig';
  end if;

  v_provider := nullif(btrim(coalesce(p_provider, '')), '');
  if v_provider is null or v_provider not in ('brevo', 'stub') then
    raise exception 'provider ungueltig';
  end if;

  -- Anhang: Pflicht fuer Rechnungsdokumente, Pfad im eigenen Workspace, Hash + Groesse + PDF.
  v_path := nullif(btrim(coalesce(p_attachment_storage_path, '')), '');
  v_sha := lower(nullif(btrim(coalesce(p_attachment_sha256, '')), ''));
  v_filename := nullif(btrim(coalesce(p_attachment_filename, '')), '');
  v_mime := nullif(btrim(coalesce(p_attachment_mime_type, '')), '');
  if v_path is null or v_sha is null or v_filename is null or v_mime is null or p_attachment_size_bytes is null then
    raise exception 'attachment unvollstaendig';
  end if;
  if public.document_delivery_attachment_workspace_id(v_path) is distinct from p_workspace_id then
    raise exception 'attachment_storage_path ungueltig';
  end if;
  if split_part(v_path, '/', 3) <> v_sha || '.pdf' then
    raise exception 'attachment_sha256 passt nicht zum Pfad';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'attachment_sha256 ungueltig';
  end if;
  if p_attachment_size_bytes <= 0 or p_attachment_size_bytes > 10485760 then
    raise exception 'attachment_size_bytes ungueltig';
  end if;
  if v_mime <> 'application/pdf' or v_filename !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.pdf$' then
    raise exception 'attachment_filename/mime ungueltig';
  end if;

  -- Dokument: Rechnung dieses Workspaces, finalisiert; frei oder mit Vorgang gleich.
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_linked_invoice_id;
  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;
  if v_invoice.invoice_status not in ('vorbereitet', 'versendet') then
    raise exception 'Rechnung nicht finalisiert';
  end if;
  if v_document_kind = 'invoice' and v_invoice.cancelled_at is not null then
    raise exception 'Rechnung storniert';
  end if;
  if v_document_kind = 'invoice_correction'
     and (v_invoice.cancellation_kind is distinct from 'correction'
          or nullif(btrim(coalesce(v_invoice.correction_document_id, '')), '') is null) then
    raise exception 'Kein Korrekturbeleg vorhanden';
  end if;

  -- Idempotenz: dieselbe Absicht -> dieselbe Delivery; abweichende Absicht -> Konflikt.
  select * into v_existing
  from public.workspace_document_deliveries
  where workspace_id = p_workspace_id
    and client_delivery_id = v_client_delivery_id
  for update;
  if v_existing.id is not null then
    if v_existing.document_kind <> v_document_kind
       or v_existing.linked_invoice_id is distinct from v_linked_invoice_id
       or v_existing.recipient_email <> v_recipient
       or v_existing.subject <> v_subject
       or v_existing.body_text <> v_body
       or v_existing.attachment_sha256 is distinct from v_sha then
      raise exception 'Idempotenzkonflikt: client_delivery_id mit abweichendem Inhalt';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'delivery', to_jsonb(v_existing));
  end if;

  -- Bewusster Retry: nur nach serverseitig bestaetigtem Fehlschlag, gleiche Rechnung, gleicher Workspace.
  if p_retry_of_delivery_id is not null then
    select * into v_retry_of
    from public.workspace_document_deliveries
    where id = p_retry_of_delivery_id
      and workspace_id = p_workspace_id;
    if v_retry_of.id is null then
      raise exception 'retry_of_delivery_id nicht gefunden';
    end if;
    if v_retry_of.document_kind <> v_document_kind or v_retry_of.linked_invoice_id is distinct from v_linked_invoice_id then
      raise exception 'retry_of_delivery_id gehoert zu einem anderen Dokument';
    end if;
    if v_retry_of.status not in ('failed', 'rejected', 'unknown', 'bounced') then
      raise exception 'Erneuter Versand nur nach Fehlschlag';
    end if;
    v_attempt := v_retry_of.attempt_number + 1;
  end if;

  insert into public.workspace_document_deliveries (
    workspace_id, client_delivery_id, document_kind, linked_invoice_id, linked_document_id,
    recipient_email, subject, body_text,
    attachment_storage_path, attachment_sha256, attachment_size_bytes, attachment_filename, attachment_mime_type,
    provider, status, requested_by, requested_at, retry_of_delivery_id, attempt_number
  ) values (
    p_workspace_id, v_client_delivery_id, v_document_kind, v_linked_invoice_id, v_linked_document_id,
    v_recipient, v_subject, v_body,
    v_path, v_sha, p_attachment_size_bytes, v_filename, v_mime,
    v_provider, 'queued', v_user_id, now(), p_retry_of_delivery_id, v_attempt
  )
  returning * into v_row;

  return jsonb_build_object('outcome', 'created', 'delivery', to_jsonb(v_row));
end;
$$;

revoke all on function public.create_workspace_document_delivery(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text) from public;
grant execute on function public.create_workspace_document_delivery(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC: Versandhistorie eines Dokuments (neueste zuerst)
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_document_deliveries(
  p_workspace_id uuid,
  p_document_kind text,
  p_linked_invoice_id text
)
returns setof public.workspace_document_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
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
  if nullif(btrim(coalesce(p_linked_invoice_id, '')), '') is null then
    raise exception 'linked_invoice_id fehlt';
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and d.linked_invoice_id = btrim(p_linked_invoice_id)
    and (nullif(btrim(coalesce(p_document_kind, '')), '') is null or d.document_kind = btrim(p_document_kind))
  order by d.requested_at desc, d.created_at desc;
end;
$$;

revoke all on function public.list_workspace_document_deliveries(uuid, text, text) from public;
grant execute on function public.list_workspace_document_deliveries(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RPC: Statusfortschreibung — nur Server (EMAIL-01B2 Edge Function, service_role)
-- ---------------------------------------------------------------------------

create or replace function public.update_workspace_document_delivery_status(
  p_delivery_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_category text default null,
  p_error_code text default null,
  p_error_message_safe text default null,
  p_expected_row_version bigint default null
)
returns public.workspace_document_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_document_deliveries;
begin
  if p_delivery_id is null then
    raise exception 'delivery_id fehlt';
  end if;
  select * into v_row from public.workspace_document_deliveries where id = p_delivery_id for update;
  if v_row.id is null then
    raise exception 'Delivery nicht gefunden';
  end if;
  if p_expected_row_version is not null and v_row.row_version <> p_expected_row_version then
    raise exception 'row_version veraltet';
  end if;
  if not public.document_delivery_transition_allowed(v_row.status, p_status) then
    raise exception 'Statusuebergang % -> % nicht erlaubt', v_row.status, p_status;
  end if;
  if v_row.status = p_status then
    return v_row;
  end if;

  update public.workspace_document_deliveries
  set
    status = p_status,
    provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
    provider_accepted_at = case
      when p_status = 'provider_accepted' then now()
      else provider_accepted_at
    end,
    failed_at = case when p_status in ('failed', 'rejected') then now() else failed_at end,
    error_category = case
      when p_status in ('failed', 'rejected', 'bounced', 'unknown') then coalesce(p_error_category, 'unknown')
      else error_category
    end,
    error_code = case when p_status in ('failed', 'rejected', 'bounced', 'unknown') then left(p_error_code, 64) else error_code end,
    error_message_safe = case when p_status in ('failed', 'rejected', 'bounced', 'unknown') then left(p_error_message_safe, 500) else error_message_safe end,
    row_version = row_version + 1,
    updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.update_workspace_document_delivery_status(uuid, text, text, text, text, text, bigint) from public;
revoke all on function public.update_workspace_document_delivery_status(uuid, text, text, text, text, text, bigint) from authenticated;
grant execute on function public.update_workspace_document_delivery_status(uuid, text, text, text, text, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Manuelles „als versendet markieren" traegt ab jetzt seine Herkunft
--    (sent_source = manual). Signatur und Verhalten sonst unveraendert;
--    ein OfficePilot-Versand (officepilot) wird nicht zu manual zurueckgestuft.
-- ---------------------------------------------------------------------------

create or replace function public.update_workspace_invoice_sent(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_sent_at text,
  p_sent_via text,
  p_sent_note text default null
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_sent_at text;
  v_sent_via text;
  v_sent_note text;
  v_sent_source text;
  v_updated public.workspace_invoices;
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

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_sent_at := nullif(trim(coalesce(p_sent_at, '')), '');
  if v_sent_at is null then
    raise exception 'sent_at fehlt';
  end if;
  if v_sent_at !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'sent_at ungueltig';
  end if;
  begin
    perform v_sent_at::date;
  exception
    when others then
      raise exception 'sent_at ungueltig';
  end;

  v_sent_via := nullif(trim(coalesce(p_sent_via, '')), '');
  if v_sent_via is null or v_sent_via not in ('email', 'post', 'persoenlich', 'portal', 'sonstige') then
    raise exception 'sent_via ungueltig';
  end if;

  v_sent_note := nullif(trim(coalesce(p_sent_note, '')), '');

  select * into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = trim(p_client_invoice_id)
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  if v_existing.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  -- Herkunft: bleibt officepilot, wenn ein OfficePilot-Versand die Wahrheit gesetzt hat.
  v_sent_source := coalesce(v_existing.sent_source, 'manual');

  /*
   * Monotonie unveraendert (04B1-Hardening): 'versendet' ist ein Endzustand,
   * Versandangaben duerfen korrigiert werden; RETURNING + Nachbedingungen wie
   * bisher. Neu ist ausschliesslich die Herkunft (sent_source / sentSource).
   */
  update public.workspace_invoices
  set
    invoice_status = 'versendet',
    sent_source = v_sent_source,
    payload = case
      when v_sent_note is null then
        (payload - 'sentNote')
          || jsonb_build_object('status', 'versendet', 'sentAt', v_sent_at, 'sentVia', v_sent_via, 'sentSource', v_sent_source)
      else
        payload
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_sent_at,
            'sentVia', v_sent_via,
            'sentNote', v_sent_note,
            'sentSource', v_sent_source
          )
    end,
    row_version = row_version + 1,
    updated_at = now(),
    updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null then
    raise exception 'Sent-Update nicht angewendet';
  end if;

  if v_updated.invoice_status is distinct from 'versendet' then
    raise exception 'Sent-Update Nachbedingung verletzt: invoice_status';
  end if;
  if v_updated.payload->>'status' is distinct from 'versendet' then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.status';
  end if;
  if v_updated.payload->>'sentAt' is distinct from v_sent_at then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.sentAt';
  end if;
  if v_updated.payload->>'sentVia' is distinct from v_sent_via then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.sentVia';
  end if;
  if v_sent_note is null then
    if v_updated.payload ? 'sentNote' then
      raise exception 'Sent-Update Nachbedingung verletzt: sentNote vorhanden';
    end if;
  else
    if v_updated.payload->>'sentNote' is distinct from v_sent_note then
      raise exception 'Sent-Update Nachbedingung verletzt: payload.sentNote';
    end if;
  end if;

  return next v_updated;
end;
$$;

revoke all on function public.update_workspace_invoice_sent(uuid, text, text, text, text) from public;
grant execute on function public.update_workspace_invoice_sent(uuid, text, text, text, text) to authenticated;
