-- TEILRECHNUNG-03C -- die Teilrechnung wird stornierbar.
--
-- Folgemigration zu 20260913120000 (dort steht die Stornofunktion; sie ist
-- remote angewendet und wird hier ausdruecklich **nicht** umgeschrieben).
--
-- Bis hierher liess `cancel_workspace_invoice` nur 'rechnung' und 'schluss' zu.
-- Mit 03C wird die Teilrechnung ein sichtbarer, bewusst waehlbarer
-- Rechnungsweg: eine echte Forderung mit Positionen, Mengen und Nummer aus dem
-- gemeinsamen Kreis. Sie verbraucht abgerechnete Menge wie jede Rechnung --
-- und muss deshalb auch wie jede Rechnung stornierbar sein, damit ein
-- Fehlbeleg die Menge wieder freigibt.
--
-- Unveraendert bleiben: Stornoart (intern vor Versand, Korrekturbeleg danach),
-- Zahlungssperre, Idempotenz, Korrekturdokument, Rueckgabewert und das
-- Verhalten fuer 'rechnung' und 'schluss'. Keine Datenmigration, kein neues
-- Schema, keine Nummernlogik.

create or replace function public.cancel_workspace_invoice(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_reason text
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_reason text;
  v_vorgang_id text;
  v_existing public.workspace_invoices;
  v_updated public.workspace_invoices;
  v_active_payments integer;
  v_now timestamptz := now();
  v_kind text;
  v_document_id text;
  v_document public.workspace_documents;
  v_payload jsonb;
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

  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'invoice_cancel_reason_required';
  end if;

  /*
   * Lock-Reihenfolge Vorgang -> Rechnung -> Zahlungen, wie in allen
   * rechnungsschreibenden Funktionen. Der Auftragsbezug einer Rechnung ist
   * unveraenderlich; er darf deshalb ohne Sperre gelesen werden, bevor der
   * Vorgang gesperrt wird.
   *
   * 01B — ausdruecklich gekoppelt statt eines Joins, der bei NULL still keine
   * Zeile sperrt: Ohne Auftrag ist nur die normale Rechnung zulaessig, und es
   * gibt keinen Vorgang, an dem eine Serialisierung haengen koennte.
   */
  select wi.vorgang_id
  into v_vorgang_id
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = v_invoice_id;

  if not found then
    raise exception 'Rechnung nicht gefunden';
  end if;

  if v_vorgang_id is not null then
    perform 1
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;
  end if;

  select *
  into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  /*
   * Idempotenz vor jeder Pruefung: Ein zweiter Aufruf ist kein Ereignis.
   * Grund, Zeitpunkt, Art und Korrekturbeleg bleiben, wie sie waren — auch
   * bei abweichender zweiter Begruendung.
   */
  if v_existing.cancelled_at is not null then
    return next v_existing;
    return;
  end if;

  if v_existing.vorgang_id is null and v_existing.invoice_type is distinct from 'rechnung' then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  /*
   * TEILRECHNUNG-03C -- eine Teilrechnung ist eine echte Forderung ueber einen
   * abgegrenzten Teil der Auftragsleistung. Sie verbraucht Menge wie jede
   * Rechnung, also muss sie sich auch wie jede Rechnung zurueckholen lassen --
   * sonst bliebe ein Fehlbeleg dauerhaft stehen und seine Menge verbraucht.
   * Alles andere bleibt: Abschlaege sind hier weiterhin nicht vorgesehen, und
   * eine Rechnung ohne Auftrag (oben) bleibt auf 'rechnung' beschraenkt.
   */
  if v_existing.invoice_type not in ('rechnung', 'teilrechnung', 'schluss') then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  if v_existing.invoice_status not in ('vorbereitet', 'versendet') then
    raise exception 'invoice_cancel_not_finalized';
  end if;

  -- D1: aktive Zahlung -> keine Stornierung, nichts wird zurueckgebucht.
  select count(*)
  into v_active_payments
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = v_invoice_id
    and p.reversed_at is null;

  if coalesce(v_active_payments, 0) > 0 then
    raise exception 'invoice_cancel_has_active_payments';
  end if;

  v_kind := case when v_existing.invoice_status = 'versendet' then 'correction' else 'internal' end;

  if v_kind = 'correction' then
    /*
     * D2/B — der Korrekturbeleg entsteht hier, in derselben Transaktion.
     * Deterministische Kennung: derselbe Retry trifft dieselbe Zeile.
     *
     * Der Payload ist ein selbstbeschreibender Datensatz. Er traegt den
     * finalen Original-Payload unveraendert als Snapshot; nichts wird hier
     * gerechnet. Ordner, Tags und Suchtext bildet der Client deterministisch.
     */
    v_document_id := 'corr-' || v_invoice_id;

    select *
    into v_document
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id
      and d.client_document_id = v_document_id
    for update;

    if v_document.id is not null then
      if v_document.document_kind is distinct from 'generated_invoice_correction'
         or v_document.linked_invoice_id is distinct from v_invoice_id then
        raise exception 'Dokumentkonflikt: Kennung gehoert zu einem anderen Dokument';
      end if;
      if v_document.deleted_at is not null then
        raise exception 'Dokumentkonflikt: Korrekturbeleg wurde geloescht';
      end if;
    else
      v_payload := jsonb_build_object(
        'id', v_document_id,
        'documentType', 'rechnungskorrektur',
        'correctionKind', 'storno',
        'category', 'ausgangsrechnung',
        'classifiedKind', 'rechnungskorrektur',
        'archived', true,
        'title', 'Rechnungskorrektur zu Rechnung ' || v_existing.invoice_number,
        'issuer', coalesce(v_existing.payload->'companySnapshot'->>'companyName', ''),
        'linkedInvoiceId', v_invoice_id,
        'linkedVorgangId', v_existing.vorgang_id,
        'originalClientInvoiceId', v_invoice_id,
        'originalInvoiceNumber', v_existing.invoice_number,
        'originalInvoiceType', v_existing.invoice_type,
        'originalIssueDate', coalesce(v_existing.payload->>'issueDate', v_existing.payload->>'date'),
        'cancelledAt', to_char(timezone('utc', v_now), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'correctionIssueDate', to_char(timezone('utc', v_now), 'YYYY-MM-DD'),
        'cancelReason', v_reason,
        'customerId', v_existing.payload->>'customerId',
        'companySnapshot', v_existing.payload->'companySnapshot',
        'customerSnapshot', v_existing.payload->'customerSnapshot',
        'servicePeriodFrom', v_existing.payload->>'servicePeriodFrom',
        'servicePeriodTo', v_existing.payload->>'servicePeriodTo',
        'taxStatus', v_existing.payload->>'taxStatus',
        'originalInvoiceSnapshot', v_existing.payload
      );

      insert into public.workspace_documents (
        workspace_id, client_document_id, document_kind,
        linked_invoice_id, linked_vorgang_id, payload, created_by, updated_by
      )
      values (
        p_workspace_id, v_document_id, 'generated_invoice_correction',
        v_invoice_id, v_existing.vorgang_id, v_payload, v_user_id, v_user_id
      )
      returning * into v_document;

      if v_document.id is null then
        raise exception 'Korrekturbeleg nicht angelegt';
      end if;
    end if;
  end if;

  /*
   * `invoice_status`, Nummer, Positionen, Betraege, Snapshots, Versandangaben,
   * Zahlungsdatensaetze und Archivhistorie bleiben unangetastet. Der
   * Payload-Spiegel dient aelteren Clients.
   */
  update public.workspace_invoices
  set cancelled_at = v_now,
      cancelled_by = v_user_id,
      cancel_reason = v_reason,
      cancellation_kind = v_kind,
      correction_document_id = v_document_id,
      payload = payload || jsonb_build_object(
        'cancelledAt', to_char(timezone('utc', v_now), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'cancelReason', v_reason
      ),
      row_version = row_version + 1,
      updated_at = v_now,
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.cancelled_at is null then
    raise exception 'Stornierung nicht angewendet';
  end if;

  if v_kind = 'correction' and v_updated.correction_document_id is null then
    raise exception 'Stornierung ohne Korrekturbeleg';
  end if;

  return next v_updated;
end;
$$;

revoke all on function public.cancel_workspace_invoice(uuid, text, text) from public, anon;
grant execute on function public.cancel_workspace_invoice(uuid, text, text) to authenticated;
