-- OFFICEPILOT-INVOICE-SENT-CLOUD-DURABILITY-01B
--
-- `update_workspace_invoice_sent` schreibt die Versandwahrheit seit 04B1
-- dauerhaft. Was fehlte, war der Gegenzug: Ein Geraet konnte nie feststellen,
-- ob sein lokaler Versandstand ueberhaupt in der Cloud angekommen ist.
--
-- Scheiterte der Write — offline, Timeout, Workspace nicht aufloesbar —, blieb
-- nur ein fluechtiger Hinweis in der Oberflaeche. Nach dem naechsten Rendern
-- war er weg, und die Abweichung wurde nie wieder erkannt.
--
-- Diese Migration ergaenzt genau einen schmalen Lesezugriff. Bewusste Grenzen:
--   * keine neue Tabelle, keine neue Spalte, keine neue Policy
--   * keine Datenmigration
--   * `update_workspace_invoice_sent` bleibt unveraendert und traegt weiterhin
--     Erstversand, Korrektur und Wiederholung
--   * kein Workspace-weiter Pull: fuer die Frage nach **einer** Rechnung waere
--     `pull_workspace_invoices` ein O(N)-Transfer fuer eine O(1)-Frage
--
-- Zurueck kommt nur, ob die Rechnung existiert und wie ihr Versandzustand ist.
-- Kein Payload, keine Betraege, keine Positionen.

create or replace function public.get_workspace_invoice_sent(
  p_workspace_id uuid,
  p_client_invoice_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_found boolean;
  v_status text;
  v_sent_at text;
  v_sent_via text;
  v_sent_note text;
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

  /*
   * Identitaet ausschliesslich ueber workspace_id + client_invoice_id.
   * Die Rechnungsnummer ist eine Anzeigegroesse und nie ein technischer
   * Schluessel.
   *
   * Gelesen wird die autoritative Spalte `invoice_status` und der Payload nur
   * fuer die drei Versandfelder. Die Bewertung, ob das ein **vollstaendiger**
   * Versandsatz ist, faellt bewusst im Client: Dort steht dieselbe Pruefung,
   * die auch den lokalen Stand bewertet — eine zweite, leicht abweichende
   * Fassung in SQL waere eine Quelle stiller Abweichungen.
   */
  select
    true,
    wi.invoice_status,
    wi.payload->>'sentAt',
    wi.payload->>'sentVia',
    wi.payload->>'sentNote'
  into v_found, v_status, v_sent_at, v_sent_via, v_sent_note
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id);

  return jsonb_build_object(
    'found', coalesce(v_found, false),
    'invoice_status', v_status,
    'sent_at', v_sent_at,
    'sent_via', v_sent_via,
    'sent_note', v_sent_note
  );
end;
$$;

revoke all on function public.get_workspace_invoice_sent(uuid, text) from public;
grant execute on function public.get_workspace_invoice_sent(uuid, text) to authenticated;
