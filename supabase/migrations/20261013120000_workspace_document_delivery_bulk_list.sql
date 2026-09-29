-- E-MAIL-HALBZEIT-FIX B6 — Versandhistorie mehrerer Dokumente in EINER Anfrage.
--
-- Die Kommunikationshistorie beim Kunden/Vorgang findet ältere Versandaufträge
-- ohne gespeicherten Kontext (vor 07C, z. B. 01J) nur über ihr Dokument. Bis
-- hierher gab es dafür nur Lese-RPCs für GENAU eine Rechnung bzw. GENAU ein
-- Archivdokument — der Client fragte je Dokument einzeln (N+1). Direktes
-- Lesen der Tabelle ist für Clients bewusst nicht freigegeben (nur RPCs).
--
-- Diese Funktion liefert alle Versandaufträge des Workspaces, deren
-- linked_invoice_id bzw. linked_document_id in den übergebenen Listen steht:
--   * nur angemeldete, aktive Mitglieder des Workspaces,
--   * nur Zeilen dieses Workspaces (keine Cross-Workspace-Treffer, auch nicht
--     bei gleich lautenden Kennungen),
--   * nur die übergebenen Kennungen — keine ungefilterte Workspace-Liste,
--   * höchstens 250 Kennungen je Typ (Missbrauchsgrenze; übliche Kunden und
--     Vorgänge liegen weit darunter, der Client teilt größere Mengen auf),
--   * Dubletten in den Eingaben erzeugen keine doppelten Zeilen,
--   * leere Listen liefern eine leere Menge.
-- Rein lesend: keine Datenänderung, kein Backfill, keine Löschung. Bestehende
-- Funktionen bleiben unverändert.
--
-- Setzt 20260914120000 (Tabelle) voraus; die 07C-Spalten customer_id /
-- vorgang_id werden unverändert mitgeliefert.
-- Nur lokal; Anwendung auf die Cloud ist ein eigener, freigegebener Schritt.

create or replace function public.list_workspace_document_deliveries_for_documents(
  p_workspace_id uuid,
  p_invoice_ids text[],
  p_document_ids text[]
)
returns setof public.workspace_document_deliveries
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_invoice_ids text[];
  v_document_ids text[];
  v_limit constant integer := 250;
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

  -- Bereinigt: getrimmt, ohne Leere, ohne Dubletten.
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_invoice_ids
  from unnest(coalesce(p_invoice_ids, '{}')) as t(x)
  where nullif(btrim(coalesce(x, '')), '') is not null;
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_document_ids
  from unnest(coalesce(p_document_ids, '{}')) as t(x)
  where nullif(btrim(coalesce(x, '')), '') is not null;

  if cardinality(v_invoice_ids) > v_limit or cardinality(v_document_ids) > v_limit then
    raise exception 'Zu viele Kennungen (hoechstens % je Art)', v_limit;
  end if;
  if cardinality(v_invoice_ids) = 0 and cardinality(v_document_ids) = 0 then
    return;
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and (
      (d.linked_invoice_id is not null and d.linked_invoice_id = any (v_invoice_ids))
      or (d.linked_document_id is not null and d.linked_document_id = any (v_document_ids))
    )
  order by d.requested_at desc, d.created_at desc;
end;
$$;

revoke all on function public.list_workspace_document_deliveries_for_documents(uuid, text[], text[]) from public;
revoke all on function public.list_workspace_document_deliveries_for_documents(uuid, text[], text[]) from anon;
grant execute on function public.list_workspace_document_deliveries_for_documents(uuid, text[], text[]) to authenticated;
