-- E-MAIL-07C — Kunden- und Vorgangskontext fuer versendete Dokumente.
--
-- Bis hierher kannte ein Versand nur sein Dokument (Rechnung bzw. Archiv-
-- dokument). Fuer die Kommunikationshistorie beim Kunden und beim Vorgang
-- braucht es den Kontext ausdruecklich — ausschliesslich ueber echte
-- Kennungen, nie ueber Namen.
--
-- Bewusst additiv und ohne Eingriff in den Versandkern aus 07B:
--   * zwei nullable Spalten; alte Versandauftraege bleiben unveraendert lesbar,
--   * eine eigene RPC `create_workspace_document_delivery_with_context`, die
--     den Kontext prueft, den bestehenden `create_workspace_document_delivery`
--     unveraendert aufruft und danach nur die beiden Spalten setzt (kein
--     Ueberladen desselben Namens — PostgREST koennte die Aufrufe sonst nicht
--     eindeutig zuordnen),
--   * eine Lese-RPC fuer den Kontext.
--
-- Setzt 20261010120000_workspace_document_delivery_send_hardening voraus.
-- Nur lokal; Anwendung auf die Cloud ist ein eigener, freigegebener Schritt.

alter table public.workspace_document_deliveries
  add column if not exists customer_id text null,
  add column if not exists vorgang_id text null;

alter table public.workspace_document_deliveries
  drop constraint if exists workspace_document_deliveries_customer_id_check;
alter table public.workspace_document_deliveries
  add constraint workspace_document_deliveries_customer_id_check
  check (customer_id is null or (length(btrim(customer_id)) between 1 and 128));

alter table public.workspace_document_deliveries
  drop constraint if exists workspace_document_deliveries_vorgang_id_check;
alter table public.workspace_document_deliveries
  add constraint workspace_document_deliveries_vorgang_id_check
  check (vorgang_id is null or (length(btrim(vorgang_id)) between 1 and 128));

create index if not exists workspace_document_deliveries_customer_idx
  on public.workspace_document_deliveries (workspace_id, customer_id, requested_at desc)
  where customer_id is not null;

create index if not exists workspace_document_deliveries_vorgang_idx
  on public.workspace_document_deliveries (workspace_id, vorgang_id, requested_at desc)
  where vorgang_id is not null;

-- ---------------------------------------------------------------------------
-- Anlage mit Kontext
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace_document_delivery_with_context(
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
  p_linked_document_id text default null,
  p_confirm_uncertain_retry boolean default false,
  p_customer_id text default null,
  p_vorgang_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
  v_invoice_vorgang_id text;
  v_result jsonb;
  v_delivery_id uuid;
  v_row public.workspace_document_deliveries;
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

  -- Kontext nur aus diesem Workspace — keine Verknuepfung ueber Workspace-Grenzen.
  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and not c.deleted
  ) then
    raise exception 'customer_id gehoert nicht zum Workspace';
  end if;
  if v_vorgang_id is not null and not exists (
    select 1 from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id and not v.deleted
  ) then
    raise exception 'vorgang_id gehoert nicht zum Workspace';
  end if;

  -- Eine Rechnung gehoert serverseitig zu genau einem Vorgang: der Kontext muss passen.
  if v_vorgang_id is not null and p_document_kind in ('invoice', 'invoice_correction') then
    select i.vorgang_id into v_invoice_vorgang_id
    from public.workspace_invoices i
    where i.workspace_id = p_workspace_id and i.client_invoice_id = btrim(coalesce(p_linked_invoice_id, ''))
    limit 1;
    if v_invoice_vorgang_id is not null and v_invoice_vorgang_id <> v_vorgang_id then
      raise exception 'vorgang_id passt nicht zur Rechnung';
    end if;
  end if;

  -- Der Versandkern aus 07B bleibt unveraendert zustaendig (Pruefungen, Idempotenz, Retry-Kette).
  v_result := public.create_workspace_document_delivery(
    p_workspace_id,
    p_client_delivery_id,
    p_document_kind,
    p_linked_invoice_id,
    p_recipient_email,
    p_subject,
    p_body_text,
    p_attachment_storage_path,
    p_attachment_sha256,
    p_attachment_size_bytes,
    p_attachment_filename,
    p_attachment_mime_type,
    p_provider,
    p_retry_of_delivery_id,
    p_linked_document_id,
    p_confirm_uncertain_retry
  );

  v_delivery_id := nullif(v_result #>> '{delivery,id}', '')::uuid;
  if v_delivery_id is null then
    return v_result;
  end if;

  -- Nur ergaenzen: ein bereits gesetzter Kontext (Replay) wird nie ueberschrieben.
  update public.workspace_document_deliveries d
  set customer_id = coalesce(d.customer_id, v_customer_id),
      vorgang_id = coalesce(d.vorgang_id, v_vorgang_id)
  where d.id = v_delivery_id
    and d.workspace_id = p_workspace_id
  returning d.* into v_row;

  return jsonb_set(v_result, '{delivery}', to_jsonb(v_row));
end;
$$;

revoke all on function public.create_workspace_document_delivery_with_context(
  uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean, text, text
) from public;
grant execute on function public.create_workspace_document_delivery_with_context(
  uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- Lesen nach Kontext (Kundenakte / Vorgang)
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_document_deliveries_for_context(
  p_workspace_id uuid,
  p_customer_id text default null,
  p_vorgang_id text default null
)
returns setof public.workspace_document_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
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
  if v_customer_id is null and v_vorgang_id is null then
    raise exception 'customer_id oder vorgang_id fehlt';
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and ((v_customer_id is not null and d.customer_id = v_customer_id)
      or (v_vorgang_id is not null and d.vorgang_id = v_vorgang_id))
  order by d.requested_at desc, d.created_at desc;
end;
$$;

revoke all on function public.list_workspace_document_deliveries_for_context(uuid, text, text) from public;
grant execute on function public.list_workspace_document_deliveries_for_context(uuid, text, text) to authenticated;
