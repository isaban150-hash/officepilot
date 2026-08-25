-- OFFICEPILOT-INVOICE-SENT-CLOUD-DURABILITY-04B1U
--
-- Folgemigration zu 20250825120000_workspace_invoice_sent_durability.sql.
-- Jene ist bereits remote angewendet und bleibt unveraendert; korrigiert wird
-- ausschliesslich der Funktionsrumpf per CREATE OR REPLACE.
--
-- Zwei belegte Fehler der ersten Fassung:
--
--   1. `jsonb_build_object('sentNote', null)` schreibt "sentNote": null in den
--      Payload. Der Client-Validator akzeptiert bei sentNote nur einen String
--      oder ein fehlendes Feld — eine so geschriebene Zeile waere fuer den
--      eigenen Pull ungueltig geworden und die Rechnung waere auf anderen
--      Geraeten verschwunden. Jetzt wird der Schluessel entfernt statt genullt.
--
--   2. Auf das UPDATE folgte ein unabhaengiges SELECT. Traf das UPDATE keine
--      Zeile, gab die Funktion still die alte zurueck — der Client sah eine
--      gueltige Antwort und meldete Erfolg. Jetzt beweist UPDATE ... RETURNING
--      den Schreibvorgang, und eine Nachbedingung prueft das Ergebnis.
--
-- Unveraendert: Signatur, Guards, Kalenderpruefung, sentVia-Whitelist,
-- Status-Monotonie, row_version, updated_at/by, SECURITY DEFINER, Rechte.
-- Keine neue Tabelle, keine neue Spalte, kein Eingriff in Finalize.

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
  v_updated public.workspace_invoices;
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
  -- Dann der echte Kalender: '2026-02-29' und '2026-04-31' existieren nicht.
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

  /*
   * Monotonie unveraendert: 'versendet' ist ein Endzustand. Der Status wird nie
   * gesenkt, nur gesetzt; Versandangaben duerfen korrigiert werden.
   *
   * RETURNING statt eines zweiten SELECT: Trifft das UPDATE keine Zeile, bleibt
   * v_updated leer und die Funktion bricht ab, statt einen alten Stand als
   * Erfolg auszugeben.
   */
  update public.workspace_invoices
  set
    invoice_status = 'versendet',
    payload = case
      when v_sent_note is null then
        (payload - 'sentNote')
          || jsonb_build_object('status', 'versendet', 'sentAt', v_sent_at, 'sentVia', v_sent_via)
      else
        payload
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_sent_at,
            'sentVia', v_sent_via,
            'sentNote', v_sent_note
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

  -- Nachbedingung: die zurueckgegebene Zeile muss den gewuenschten Zustand tragen.
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
