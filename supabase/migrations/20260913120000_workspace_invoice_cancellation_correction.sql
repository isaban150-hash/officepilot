-- NORMAL-INVOICE-CANCELLATION-01B
--
-- Storno fuer normale Rechnungen (mit und ohne Auftrag) und Korrekturbeleg
-- fuer bereits versendete Rechnungen. Fortgeschrieben aus 20250905120000.
--
-- Fachliche Regeln (D1/D2/A+/D4, bestaetigt):
--
--   * Aktive Zahlungen blockieren das Storno. Nichts wird zurueckgebucht.
--   * `invoice_status = 'vorbereitet'`  -> internes Storno: Markierung des
--     Originals, `cancellation_kind = 'internal'`, kein Beleg.
--   * `invoice_status = 'versendet'`    -> Korrektur: dieselbe Markierung und
--     **in derselben Transaktion** ein eigener Korrekturbeleg als
--     `workspace_documents`-Zeile (`generated_invoice_correction`) mit
--     dauerhafter Relation. `cancellation_kind = 'correction'`.
--   * Das Original bleibt die einzige `workspace_invoices`-Zeile. Nummer,
--     Positionen, Snapshots, Payload bleiben byteidentisch. Der Nummernkreis
--     wird nicht beruehrt; `correction_number` ist nur Vorbereitung (null).
--
-- KEINE zweite Rechnungsberechnung in SQL: Der Korrekturbeleg traegt den
-- unveraenderten finalen Original-Payload als Snapshot plus Storno-Metadaten.
-- Netto/Steuer/Brutto/Gegenbuchung entstehen deterministisch im Client aus
-- genau diesem Snapshot (`buildInvoiceCorrectionModel`).
--
-- Idempotenz: Replay gibt Stornierung **und** Korrekturbeleg unveraendert
-- zurueck; die Dokumentkennung ist deterministisch (`corr-<client_invoice_id>`),
-- und ein partieller Unique-Index erlaubt genau einen Korrekturbeleg je
-- Rechnung — neben dem Original-Dokument, nicht gegen es.

/* -------------------------------------------------------------------------- */
/* 1) workspace_invoices — Art des Stornos und Relation zum Korrekturbeleg    */
/* -------------------------------------------------------------------------- */

alter table public.workspace_invoices
  add column if not exists cancellation_kind text null,
  add column if not exists correction_document_id text null,
  add column if not exists correction_number text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_invoices_cancellation_kind_check'
  ) then
    alter table public.workspace_invoices
      add constraint workspace_invoices_cancellation_kind_check
      check (cancellation_kind is null or cancellation_kind in ('internal', 'correction'));
  end if;

  /*
   * `correction` ohne Beleg und `internal` mit Beleg sind beide widerspruechlich.
   * Bestehende Stornos aus 01C tragen keine Art (null) — sie bleiben gueltig.
   */
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_invoices_correction_document_check'
  ) then
    alter table public.workspace_invoices
      add constraint workspace_invoices_correction_document_check
      check (
        (cancellation_kind = 'correction' and correction_document_id is not null)
        or (cancellation_kind is distinct from 'correction' and correction_document_id is null)
      );
  end if;

  -- Eine Art gibt es nur zusammen mit einem Storno.
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_invoices_cancellation_kind_requires_cancel_check'
  ) then
    alter table public.workspace_invoices
      add constraint workspace_invoices_cancellation_kind_requires_cancel_check
      check (cancellation_kind is null or cancelled_at is not null);
  end if;
end;
$$;

/* -------------------------------------------------------------------------- */
/* 2) workspace_documents — zweite Dokumentart                                 */
/* -------------------------------------------------------------------------- */

alter table public.workspace_documents
  drop constraint if exists workspace_documents_kind_check;
alter table public.workspace_documents
  add constraint workspace_documents_kind_check
  check (document_kind in ('generated_invoice', 'generated_invoice_correction'));

alter table public.workspace_documents
  drop constraint if exists workspace_documents_generated_invoice_link_check;
alter table public.workspace_documents
  add constraint workspace_documents_generated_invoice_link_check
  check (
    document_kind not in ('generated_invoice', 'generated_invoice_correction')
    or linked_invoice_id is not null
  );

-- Genau ein Korrekturbeleg je Rechnung; das Original-Dokument steht daneben.
create unique index if not exists workspace_documents_generated_invoice_correction_unique
  on public.workspace_documents (workspace_id, linked_invoice_id)
  where document_kind = 'generated_invoice_correction'
    and linked_invoice_id is not null;

/* -------------------------------------------------------------------------- */
/* 3) cancel_workspace_invoice v2                                               */
/* -------------------------------------------------------------------------- */

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

  if v_existing.invoice_type not in ('rechnung', 'schluss') then
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

/* -------------------------------------------------------------------------- */
/* 4) pull_workspace_invoices — die neuen Spalten reisen mit                   */
/* -------------------------------------------------------------------------- */

create or replace function public.pull_workspace_invoices(
  p_workspace_id uuid,
  p_since timestamptz default null
)
returns jsonb
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

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', wi.id,
          'workspace_id', wi.workspace_id,
          'vorgang_id', wi.vorgang_id,
          'client_invoice_id', wi.client_invoice_id,
          'invoice_number', wi.invoice_number,
          'invoice_year', wi.invoice_year,
          'invoice_sequence_number', wi.invoice_sequence_number,
          'invoice_type', wi.invoice_type,
          'invoice_status', wi.invoice_status,
          'payload', wi.payload,
          'row_version', wi.row_version,
          'created_at', wi.created_at,
          'updated_at', wi.updated_at,
          'cancelled_at', wi.cancelled_at,
          'cancelled_by', wi.cancelled_by,
          'cancel_reason', wi.cancel_reason,
          'cancellation_kind', wi.cancellation_kind,
          'correction_document_id', wi.correction_document_id,
          'correction_number', wi.correction_number
        )
        order by wi.created_at asc, wi.id asc
      )
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and (p_since is null or wi.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* 5) pull_workspace_documents — beide Dokumentarten                           */
/* -------------------------------------------------------------------------- */

create or replace function public.pull_workspace_documents(
  p_workspace_id uuid,
  p_since timestamptz default null
)
returns jsonb
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

  -- Grabsteine werden weiterhin mitgeliefert (siehe 05C1).
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'workspace_id', d.workspace_id,
          'client_document_id', d.client_document_id,
          'document_kind', d.document_kind,
          'linked_invoice_id', d.linked_invoice_id,
          'linked_vorgang_id', d.linked_vorgang_id,
          'payload', d.payload,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'row_version', d.row_version,
          'deleted_at', d.deleted_at
        )
        order by d.created_at asc
      )
      from public.workspace_documents d
      where d.workspace_id = p_workspace_id
        and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
        and (p_since is null or d.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;
