-- V1-B2 — Dokument-/Briefversand: normale archivierte Dokumente per E-Mail.
--
-- Erweitert den bestehenden Versandvertrag additiv um die Dokumentarten
-- letter / offer / other. Bezug ist `linked_document_id` =
-- `workspace_documents.client_document_id` (document_kind 'archived_document').
-- Serverseitig gilt:
--   * Dokument existiert im Workspace und ist nicht geloescht
--   * Versandart passt zur erkannten Dokumentart (brief -> letter, angebot -> offer, sonst other)
--   * der Anhang-Hash ist eine an dieses Dokument gebundene PDF-Datei
--     (workspace_document_file_bindings original/archive -> workspace_files)
--   * keine linked_invoice_id fuer normale Dokumente; Rechnungen bleiben unveraendert
-- Idempotenz-Fingerprint und Retry-Regeln (inkl. unknown-Sperre) unveraendert,
-- nur um den Dokumentbezug erweitert.
--
-- Zusaetzlich: eigene Historienabfrage je Dokument und der Absenderkontext
-- (aktuelles Firmenprofil) fuer die Edge Function.

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
  v_document public.workspace_documents;
  v_document_classified text;
  v_expected_kind text;
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
  if v_document_kind is null or v_document_kind not in ('invoice', 'invoice_correction', 'letter', 'offer', 'other') then
    raise exception 'document_kind nicht unterstuetzt';
  end if;

  v_linked_invoice_id := nullif(btrim(coalesce(p_linked_invoice_id, '')), '');
  v_linked_document_id := nullif(btrim(coalesce(p_linked_document_id, '')), '');
  if v_document_kind in ('invoice', 'invoice_correction') then
    if v_linked_invoice_id is null then
      raise exception 'linked_invoice_id fehlt';
    end if;
  else
    -- V1-B2: normales Dokument — Bezug ist das archivierte Dokument, nie eine Rechnung.
    if v_linked_document_id is null then
      raise exception 'linked_document_id fehlt';
    end if;
    if v_linked_invoice_id is not null then
      raise exception 'linked_invoice_id nicht zulaessig';
    end if;
  end if;

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

  if v_document_kind in ('invoice', 'invoice_correction') then
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
  else
    -- V1-B2: archiviertes Dokument dieses Workspaces, nicht geloescht.
    select * into v_document
    from public.workspace_documents
    where workspace_id = p_workspace_id
      and client_document_id = v_linked_document_id
      and document_kind = 'archived_document';
    if v_document.id is null or v_document.deleted or v_document.deleted_at is not null then
      raise exception 'Dokument nicht gefunden';
    end if;
    -- Versandart muss zum Dokument passen: Brief <-> brief, Angebot <-> angebot, sonst other.
    v_document_classified := lower(coalesce(v_document.payload->>'classifiedKind', ''));
    v_expected_kind := case v_document_classified when 'brief' then 'letter' when 'angebot' then 'offer' else 'other' end;
    if v_document_kind <> v_expected_kind then
      raise exception 'Dokumentart passt nicht zum Dokument';
    end if;
    -- Der Anhang muss eine an dieses Dokument gebundene PDF-Datei sein (Original oder Archiv-PDF).
    if not exists (
      select 1
      from public.workspace_document_file_bindings b
      join public.workspace_files f
        on f.workspace_id = b.workspace_id and f.client_file_ref_id = b.client_file_ref_id
      where b.workspace_id = p_workspace_id
        and b.client_document_id = v_linked_document_id
        and b.binding_kind in ('original', 'archive')
        and not b.deleted
        and not f.deleted
        and f.mime_type = 'application/pdf'
        and f.content_sha256 = v_sha
    ) then
      raise exception 'Anhang gehoert nicht zu diesem Dokument';
    end if;
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
       or v_existing.linked_document_id is distinct from v_linked_document_id
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
    if v_retry_of.document_kind <> v_document_kind
       or v_retry_of.linked_invoice_id is distinct from v_linked_invoice_id
       or v_retry_of.linked_document_id is distinct from v_linked_document_id then
      raise exception 'retry_of_delivery_id gehoert zu einem anderen Dokument';
    end if;
    -- V1-B1: Handoff ungewiss -> kein neuer Versand (moegliche Doppelzustellung).
    if v_retry_of.status = 'unknown' then
      raise exception 'Erneuter Versand nicht moeglich: Versandstatus unklar';
    end if;
    if v_retry_of.status not in ('failed', 'rejected', 'bounced') then
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

-- ---------------------------------------------------------------------------
-- Historie eines normalen Dokuments (neueste zuerst)
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_document_deliveries_for_document(
  p_workspace_id uuid,
  p_client_document_id text
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
  if nullif(btrim(coalesce(p_client_document_id, '')), '') is null then
    raise exception 'client_document_id fehlt';
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and d.linked_document_id = btrim(p_client_document_id)
    and d.document_kind in ('letter', 'offer', 'other')
  order by d.requested_at desc, d.created_at desc;
end;
$$;

revoke all on function public.list_workspace_document_deliveries_for_document(uuid, text) from public;
grant execute on function public.list_workspace_document_deliveries_for_document(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Versandkontext fuer die Edge Function: Rechnung (wie bisher) ODER Dokument
-- + aktuelles Firmenprofil als Absenderkontext (nur service_role).
-- ---------------------------------------------------------------------------

create or replace function public.get_workspace_document_delivery_for_send(
  p_workspace_id uuid,
  p_client_delivery_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.workspace_document_deliveries;
  v_invoice public.workspace_invoices;
  v_document public.workspace_documents;
  v_company jsonb;
  v_attachment_bound boolean := false;
begin
  select * into v_delivery
  from public.workspace_document_deliveries
  where workspace_id = p_workspace_id
    and client_delivery_id = btrim(coalesce(p_client_delivery_id, ''));
  if v_delivery.id is null then
    return null;
  end if;
  if v_delivery.linked_invoice_id is not null then
    select * into v_invoice
    from public.workspace_invoices
    where workspace_id = v_delivery.workspace_id
      and client_invoice_id = v_delivery.linked_invoice_id;
  end if;
  if v_delivery.linked_document_id is not null then
    select * into v_document
    from public.workspace_documents
    where workspace_id = v_delivery.workspace_id
      and client_document_id = v_delivery.linked_document_id
      and document_kind = 'archived_document';
    if v_document.id is not null then
      select exists (
        select 1
        from public.workspace_document_file_bindings b
        join public.workspace_files f
          on f.workspace_id = b.workspace_id and f.client_file_ref_id = b.client_file_ref_id
        where b.workspace_id = v_delivery.workspace_id
          and b.client_document_id = v_delivery.linked_document_id
          and b.binding_kind in ('original', 'archive')
          and not b.deleted
          and not f.deleted
          and f.mime_type = 'application/pdf'
          and f.content_sha256 = v_delivery.attachment_sha256
      ) into v_attachment_bound;
    end if;
  end if;
  select payload into v_company
  from public.workspace_company_profiles
  where workspace_id = v_delivery.workspace_id;

  return jsonb_build_object(
    'delivery', to_jsonb(v_delivery),
    'invoice', case when v_invoice.id is null then null else jsonb_build_object(
      'client_invoice_id', v_invoice.client_invoice_id,
      'invoice_number', v_invoice.invoice_number,
      'invoice_status', v_invoice.invoice_status,
      'cancelled_at', v_invoice.cancelled_at,
      'cancellation_kind', v_invoice.cancellation_kind,
      'correction_document_id', v_invoice.correction_document_id,
      'sent_source', v_invoice.sent_source,
      'sent_delivery_id', v_invoice.sent_delivery_id,
      'company_snapshot', v_invoice.payload->'companySnapshot'
    ) end,
    'document', case when v_document.id is null then null else jsonb_build_object(
      'client_document_id', v_document.client_document_id,
      'deleted', (v_document.deleted or v_document.deleted_at is not null),
      'classified_kind', v_document.payload->>'classifiedKind',
      'title', v_document.payload->>'title',
      'attachment_bound', v_attachment_bound
    ) end,
    'company', case when v_company is null then null else jsonb_build_object(
      'companyName', v_company->>'companyName',
      'legalForm', v_company->>'legalForm',
      'email', v_company->>'email'
    ) end
  );
end;
$$;

revoke all on function public.get_workspace_document_delivery_for_send(uuid, text) from public;
revoke all on function public.get_workspace_document_delivery_for_send(uuid, text) from authenticated;
grant execute on function public.get_workspace_document_delivery_for_send(uuid, text) to service_role;
