-- BROWSER-ACCEPTANCE-FIX 01 / A1 — Archivdokument einer festgeschriebenen
-- Ausgangsrechnung ist nicht loeschbar.
--
-- Bisher prueft `tombstone_workspace_document` nur Anmeldung, Mitgliedschaft
-- und Existenz. Ein direkter RPC-Aufruf konnte so das Archivdokument einer
-- vorbereiteten oder versendeten Rechnung als geloescht markieren — die
-- Rechnung verloere ihren archivierten Beleg.
--
-- Regel (serverseitig, verbindlich):
--   * `document_kind` in ('generated_invoice', 'generated_invoice_correction')
--   * `linked_invoice_id` verweist im SELBEN Workspace auf eine Rechnung mit
--     `invoice_status in ('vorbereitet', 'versendet')` (= festgeschrieben,
--     dieselbe Definition wie der Single-Final-Guard aus 20250828120000)
--   → Ausnahme, keine Aenderung.
--
-- Unveraendert: alle bisherigen Pruefungen, die Idempotenz fuer bereits
-- geloeschte Zeilen (ein Altbestand-Grabstein bleibt lesbar) und die Rechte.
-- Normale Dokumente und Entwurfsrechnungs-Dokumente bleiben loeschbar.

create or replace function public.tombstone_workspace_document(
  p_workspace_id uuid,
  p_client_document_id text
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_documents;
  v_updated public.workspace_documents;
  v_document_id text;
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

  v_document_id := nullif(trim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;

  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and client_document_id = v_document_id
  for update;

  if v_existing.id is null then
    raise exception 'Dokument nicht gefunden';
  end if;

  -- Idempotent: ein bereits geloeschtes Dokument bleibt, wie es ist.
  if v_existing.deleted_at is not null then
    return next v_existing;
    return;
  end if;

  -- A1: Der archivierte Beleg einer festgeschriebenen Rechnung bleibt.
  if v_existing.document_kind in ('generated_invoice', 'generated_invoice_correction')
     and v_existing.linked_invoice_id is not null
     and exists (
       select 1
       from public.workspace_invoices wi
       where wi.workspace_id = p_workspace_id
         and wi.client_invoice_id = v_existing.linked_invoice_id
         and wi.invoice_status in ('vorbereitet', 'versendet')
     ) then
    raise exception 'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden';
  end if;

  update public.workspace_documents
  set deleted_at = now(),
      deleted_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.deleted_at is null then
    raise exception 'Loeschung nicht angewendet';
  end if;

  return next v_updated;
end;
$$;

revoke all on function public.tombstone_workspace_document(uuid, text) from public, anon;
grant execute on function public.tombstone_workspace_document(uuid, text) to authenticated;
