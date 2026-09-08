-- OFFICEPILOT-LEGACY-INVOICE-SERVICE-PERIOD-RECOVERY-01B
--
-- Seit der Einfuehrung von `payload.servicePeriodConfirmed` traegt jede neu
-- finalisierte Rechnung die Bestaetigung ihres Leistungszeitraums dauerhaft.
-- Rechnungen von davor tragen sie nicht — und koennen es auch nicht
-- nachtraeglich beweisen. Der PDF-Pfad blockiert sie deshalb zu Recht.
--
-- Diese Migration ergaenzt genau den fehlenden Weg: eine ausdrueckliche
-- Bestaetigung durch einen Menschen, und einen schmalen Lesezugriff, mit dem
-- ein Geraet feststellen kann, ob seine lokale Bestaetigung bereits in der
-- Cloud liegt.
--
-- Bewusste Grenzen:
--   * keine neue Tabelle, keine neue Spalte, keine neue Policy
--   * kein Re-Finalize, keine Neuanlage, keine Nummernvergabe
--   * keine Aenderung an normalize_workspace_invoice_payload_for_idempotency
--     und damit keine Aenderung der Finalisierungs-Idempotenz
--   * keine Datenmigration: kein Bestandsdatensatz wird automatisch bestaetigt
--
-- Die Bestaetigung ist ein monotones Faktum. Deshalb nimmt die Mutation
-- ausdruecklich **keinen** Boolean entgegen: Die Aktion selbst bedeutet
-- „bestaetigen". Serverseitig ist damit unmoeglich, ueber diesen Weg `false`
-- oder `null` zu schreiben oder eine bestehende Bestaetigung zurueckzunehmen.

create or replace function public.confirm_workspace_invoice_service_period(
  p_workspace_id uuid,
  p_client_invoice_id text
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
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
   * Idempotenz: Steht die Bestaetigung bereits, wird nichts geschrieben.
   * Anders als beim Sent-Update, das Korrekturen der Versandangaben zulaesst,
   * gibt es hier nichts zu korrigieren — `true` ist ein Endzustand. Ein
   * wiederholter Aufruf soll deshalb weder `row_version` noch `updated_at`
   * bewegen: Ein zweiter Klick ist kein Ereignis.
   */
  if v_existing.payload->>'servicePeriodConfirmed' = 'true' then
    return query
    select * from public.workspace_invoices where id = v_existing.id;
    return;
  end if;

  /*
   * Gezieltes Merge: Genau ein Schluessel kommt hinzu. Der uebrige Payload —
   * Positionen, Betraege, Nummer, Typ, Datum, Snapshots, Versand, Storno —
   * wird nicht entgegengenommen und kann deshalb nicht ueberschrieben werden.
   */
  update public.workspace_invoices
  set
    payload = payload || jsonb_build_object('servicePeriodConfirmed', true),
    row_version = row_version + 1,
    updated_at = now(),
    updated_by = v_user_id
  where id = v_existing.id;

  return query
  select * from public.workspace_invoices where id = v_existing.id;
end;
$$;

revoke all on function public.confirm_workspace_invoice_service_period(uuid, text) from public;
grant execute on function public.confirm_workspace_invoice_service_period(uuid, text) to authenticated;

/*
 * Der schmale Gegenzug: Ein Geraet, das lokal bereits bestaetigt hat, muss
 * feststellen koennen, ob die Cloud es weiss — ohne dafuer den gesamten
 * Rechnungsbestand des Workspace zu uebertragen. Zurueck kommt deshalb nur,
 * ob die Rechnung existiert und ob sie bestaetigt ist. Kein Payload, keine
 * Betraege, keine Liste.
 */
create or replace function public.get_workspace_invoice_service_period_confirmation(
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
  v_confirmed boolean;
  v_found boolean;
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
   * `= 'true'` statt eines Casts: Ein fehlender Schluessel, ein JSON-`null`
   * und jeder Nicht-Boolean ergeben `false`. Nur eine echte Bestaetigung
   * zaehlt als Bestaetigung.
   */
  select
    true,
    coalesce(wi.payload->>'servicePeriodConfirmed' = 'true', false)
  into v_found, v_confirmed
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id);

  return jsonb_build_object(
    'found', coalesce(v_found, false),
    'service_period_confirmed', coalesce(v_confirmed, false)
  );
end;
$$;

revoke all on function public.get_workspace_invoice_service_period_confirmation(uuid, text) from public;
grant execute on function public.get_workspace_invoice_service_period_confirmation(uuid, text) to authenticated;
