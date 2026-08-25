-- OFFICEPILOT-INVOICE-SENT-CLOUD-DURABILITY-04B1
--
-- Bisher wurde eine Rechnung genau einmal in die Cloud geschrieben: beim
-- Finalisieren, mit hart gesetztem invoice_status = 'vorbereitet'. Alles danach
-- — „Als versendet markieren", sentAt, sentVia — blieb im lokalen Speicher der
-- jeweiligen Browser-Origin. Nach einem Geräte- oder Adresswechsel erschien
-- eine versendete Rechnung deshalb wieder als vorbereitet.
--
-- Diese Migration ergänzt genau eine gezielte Mutation. Bewusste Grenzen:
--   * keine neue Tabelle, keine neue Spalte
--   * keine Zahlungsfelder (payments/paymentStatus bleiben 04B2)
--   * keine archiveDocumentId
--   * keine Änderung an normalize_workspace_invoice_payload_for_idempotency
--     und damit keine Änderung der Finalisierungs-Idempotenz
--
-- Unveränderliche Rechnungsdaten (positions, amount, date, taxStatus, number,
-- type) werden nicht entgegengenommen und können deshalb nicht überschrieben
-- werden: der Client sendet ausschliesslich die drei Versandfelder.

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
  -- Erst die strikte Form: keine Zeitzone, kein Zeitanteil, kein anderes Trennzeichen.
  if v_sent_at !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'sent_at ungueltig';
  end if;
  /*
   * Dann der echte Kalender. Die Formatpruefung allein laesst '2026-02-29' und
   * '2026-04-31' durch — beides existiert nicht. PostgreSQL kennt Schaltjahre
   * und Monatslaengen, deshalb entscheidet hier der Cast und keine eigene
   * Datumsarithmetik.
   */
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

  -- Identitaet ausschliesslich ueber workspace_id + client_invoice_id.
  -- Die Rechnungsnummer ist eine Anzeigegroesse und nie ein technischer Schluessel.
  select * into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = trim(p_client_invoice_id)
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  -- Ein Entwurf ist noch keine finalisierte Rechnung.
  if v_existing.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * Monotonie: 'versendet' ist ein Endzustand. Ein aelterer Client darf eine
   * bereits versendete Rechnung nicht zurueckstufen — er kann aber die
   * Versandangaben korrigieren. Deshalb wird der Status nie gesenkt, sondern
   * nur angehoben.
   */
  update public.workspace_invoices
  set
    invoice_status = 'versendet',
    payload = payload
      || jsonb_build_object(
        'status', 'versendet',
        'sentAt', v_sent_at,
        'sentVia', v_sent_via
      )
      || case
           when v_sent_note is null then jsonb_build_object('sentNote', null)
           else jsonb_build_object('sentNote', v_sent_note)
         end,
    row_version = row_version + 1,
    updated_at = now(),
    updated_by = v_user_id
  where id = v_existing.id;

  return query
  select * from public.workspace_invoices where id = v_existing.id;
end;
$$;

revoke all on function public.update_workspace_invoice_sent(uuid, text, text, text, text) from public;
grant execute on function public.update_workspace_invoice_sent(uuid, text, text, text, text) to authenticated;
