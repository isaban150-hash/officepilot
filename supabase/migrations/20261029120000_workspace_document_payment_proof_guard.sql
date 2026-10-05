/*
 * BARZAHLUNG-V1 NACHTRAG 1 — der Zahlungsnachweis ueberlebt das Aufraeumen.
 *
 * NOCH NICHT REMOTE AUSGEROLLT.
 *
 * DER FEHLER
 *
 * Seit Block 1 kann eine Zahlung ueber `proof_document_id` auf ein
 * Archivdokument zeigen. Der vorhandene Loeschschutz kennt diesen Bezug
 * nicht: `isExpenseReceipt` prueft `archiveDocumentId` und
 * `linkedInboxId`, mehr nicht. Ein Zahlungsnachweis liess sich also
 * loeschen. Die Kennung blieb in der Zahlungszeile stehen, das Dokument war
 * aber nicht mehr aufloesbar — und die Historie behauptete danach "Kein
 * Zahlungsnachweis verknuepft". Es gab einen; er wurde nur geloescht.
 *
 * WARUM DER SCHUTZ AUF DEN SERVER GEHOERT
 *
 * Eine stornierte Zahlung faellt aus der lokalen Projektion heraus — der
 * Client sieht sie nicht. Genau diese Zahlungen tragen aber ihren Nachweis
 * als Pruefspur weiter. Ein Client-Check allein waere also nicht streng,
 * sondern blind.
 *
 * ZWEI LOESCHWEGE, EIN SCHUTZ
 *
 * Ein Dokument kann auf zwei Arten beerdigt werden:
 *   - `upsert_workspace_intake_entity` mit `archived_document` und
 *     `deleted = true` (Fremddokumente, also auch jede Quittung)
 *   - `tombstone_workspace_document` (erzeugte Rechnungsdokumente)
 * Beide bekommen denselben Aufruf. Beide Funktionen werden dafuer woertlich
 * in ihrer geltenden Fassung neu angelegt und um **eine** Anweisung ergaenzt.
 *
 * KEINE AUTOMATISCHE REFERENZLOESUNG
 *
 * Es wird nichts auf `null` gesetzt, keine Zahlung veraendert, kein
 * Grabstein trotzdem geschrieben. Die Loeschung wird abgewiesen. Eine
 * Auditspur still abzuschneiden waere schlimmer als eine Loeschung, die
 * nicht geht.
 *
 * BEIDE ZAHLUNGSWELTEN
 *
 * Block 1 hat `proof_document_id` an beiden Zahlungstabellen eingefuehrt.
 * Der Schutz prueft deshalb beide — auch wenn der Client die
 * Rechnungsseite heute noch nicht nutzt. Halbe Integritaet waere keine.
 *
 * DAS RENNEN
 *
 * Loeschen und Zuordnen koennten sich sonst ueberholen: Der eine prueft
 * "nicht referenziert", der andere setzt gleichzeitig die Referenz. Beide
 * Wege sperren deshalb **dieselbe** Zeile in `workspace_documents` mit
 * `for update` — die Loeschwege taten das bereits, die Nachweis-Funktion
 * wird hier entsprechend ergaenzt. Damit serialisieren sie.
 */

/* ------------------------------------------------------------------------ */
/* Der gemeinsame Guard                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Faellt fehl, sobald irgendeine Zahlung dieses Dokument als Nachweis fuehrt.
 *
 * Bewusst **ohne** Unterscheidung zwischen aktiv und storniert: Eine
 * stornierte Zahlung bleibt als Pruefspur bestehen, und ihr Nachweis gehoert
 * dazu.
 *
 * Die Meldung nennt keine Zahlungskennung und keinen Betrag. Sie sagt nur,
 * dass es eine Verbindung gibt — alles andere waere ein Datenabfluss ueber
 * eine Fehlermeldung.
 *
 * Nur der eigene Workspace wird betrachtet; eine fremde Referenz existiert
 * fuer diese Pruefung nicht.
 */
create or replace function public.assert_document_not_payment_proof(
  p_workspace_id uuid,
  p_client_document_id text
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document_id text := nullif(trim(coalesce(p_client_document_id, '')), '');
begin
  if v_document_id is null then
    return;
  end if;

  if exists (
    select 1
    from public.workspace_expense_payments p
    where p.workspace_id = p_workspace_id
      and p.proof_document_id = v_document_id
  ) or exists (
    select 1
    from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id
      and p.proof_document_id = v_document_id
  ) then
    raise exception 'Dokument ist als Zahlungsnachweis verknuepft' using errcode = 'P0001';
  end if;
end;
$$;

/**
 * Dieselbe Frage als Lesefunktion — damit die Oberflaeche **vor** dem
 * lokalen Loeschen fragen kann, statt das Dokument verschwinden zu lassen
 * und den Fehler erst beim naechsten Abgleich zu erfahren.
 */
create or replace function public.is_workspace_document_payment_proof(
  p_workspace_id uuid,
  p_client_document_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document_id text := nullif(trim(coalesce(p_client_document_id, '')), '');
begin
  if v_document_id is null then
    return false;
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return exists (
    select 1 from public.workspace_expense_payments p
    where p.workspace_id = p_workspace_id and p.proof_document_id = v_document_id
  ) or exists (
    select 1 from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id and p.proof_document_id = v_document_id
  );
end;
$$;

/* ------------------------------------------------------------------------ */
/* Loeschweg 1 — Fremddokumente ueber den Intake-Dispatcher                  */
/* Woertlich aus 20261022120000, ergaenzt um den Guard.                      */
/* ------------------------------------------------------------------------ */

create or replace function public.upsert_workspace_intake_entity(
  p_workspace_id uuid,
  p_entity_type text,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_can_write boolean;
  v_can_intake boolean;
  v_entity_id text;
  v_deleted boolean;
  v_current_version bigint;
  v_current_created_by uuid;
  v_result jsonb;
  v_payload jsonb;
  v_hash text;
  v_path text;
  v_kind text;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_can_write := public.can_write_workspace(p_workspace_id);
  v_can_intake := public.workspace_user_can_intake(p_workspace_id);
  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);

  -- Tombstones setzen nur owner/admin (member loescht nichts, auch nicht Eigenes).
  if v_deleted and not v_can_write then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if not v_can_intake then
    raise exception 'Keine Schreibberechtigung';
  end if;

  -- ----------------------------------------------------------------- files
  if p_entity_type = 'document_file' then
    v_entity_id := nullif(trim(coalesce(p_payload->>'client_file_ref_id', '')), '');
    if v_entity_id is null then raise exception 'client_file_ref_id fehlt'; end if;
    v_hash := lower(nullif(trim(coalesce(p_payload->>'content_sha256', '')), ''));
    if v_hash is null or length(v_hash) <> 64 or v_hash !~ '^[0-9a-f]{64}' then raise exception 'content_sha256 ungueltig'; end if;
    v_path := p_workspace_id::text || '/' || v_hash;

    select f.row_version, f.created_by into v_current_version, v_current_created_by
    from public.workspace_files f
    where f.workspace_id = p_workspace_id and f.client_file_ref_id = v_entity_id
    for update;

    if v_current_version is null then
      insert into public.workspace_files (
        workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, original_file_name,
        storage_path, derived_from_client_file_ref_id, uploaded_by, created_by, uploaded_at,
        updated_by, deleted, deleted_at, row_version
      ) values (
        p_workspace_id, v_entity_id, v_hash,
        coalesce((p_payload->>'size_bytes')::bigint, 0),
        coalesce(nullif(trim(p_payload->>'mime_type'), ''), 'application/octet-stream'),
        coalesce(p_payload->>'original_file_name', ''),
        v_path,
        nullif(trim(coalesce(p_payload->>'derived_from_client_file_ref_id', '')), ''),
        v_user_id, v_user_id,
        coalesce((p_payload->>'uploaded_at')::timestamptz, now()),
        v_user_id, v_deleted, case when v_deleted then now() else null end, 1
      )
      returning to_jsonb(public.workspace_files.*) into v_result;
    else
      if not v_can_write and v_current_created_by is distinct from v_user_id then
        raise exception 'Keine Schreibberechtigung';
      end if;
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt document_file:%', v_current_version using errcode = 'P0001';
      end if;
      -- Hash/Pfad sind unveraenderlich (Original bleibt Original); nur Metadaten/Tombstone.
      update public.workspace_files
      set original_file_name = coalesce(p_payload->>'original_file_name', original_file_name),
          mime_type = coalesce(nullif(trim(p_payload->>'mime_type'), ''), mime_type),
          derived_from_client_file_ref_id = coalesce(nullif(trim(coalesce(p_payload->>'derived_from_client_file_ref_id', '')), ''), derived_from_client_file_ref_id),
          deleted = v_deleted,
          deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
          row_version = row_version + 1,
          updated_by = v_user_id
      where workspace_id = p_workspace_id and client_file_ref_id = v_entity_id
      returning to_jsonb(public.workspace_files.*) into v_result;
    end if;

  -- -------------------------------------------------------------- bindings
  elsif p_entity_type = 'document_file_binding' then
    v_entity_id := nullif(trim(coalesce(p_payload->>'binding_id', '')), '');
    if v_entity_id is null then raise exception 'binding_id fehlt'; end if;
    v_kind := p_payload->>'binding_kind';

    select b.row_version, b.created_by into v_current_version, v_current_created_by
    from public.workspace_document_file_bindings b
    where b.workspace_id = p_workspace_id
      and b.client_document_id = p_payload->>'client_document_id'
      and b.binding_kind = v_kind
      and coalesce(b.part, '') = coalesce(p_payload->>'part', '')
    for update;

    if v_current_version is null then
      insert into public.workspace_document_file_bindings (
        workspace_id, client_document_id, client_file_ref_id, binding_kind, part, provenance,
        created_by, updated_by, deleted, deleted_at, row_version
      ) values (
        p_workspace_id,
        p_payload->>'client_document_id',
        p_payload->>'client_file_ref_id',
        v_kind,
        nullif(trim(coalesce(p_payload->>'part', '')), ''),
        coalesce(nullif(trim(p_payload->>'provenance'), ''), 'received'),
        v_user_id, v_user_id, v_deleted, case when v_deleted then now() else null end, 1
      )
      returning to_jsonb(public.workspace_document_file_bindings.*) into v_result;
    else
      if not v_can_write and v_current_created_by is distinct from v_user_id then
        raise exception 'Keine Schreibberechtigung';
      end if;
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt document_file_binding:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_document_file_bindings
      set client_file_ref_id = coalesce(nullif(trim(p_payload->>'client_file_ref_id'), ''), client_file_ref_id),
          provenance = coalesce(nullif(trim(p_payload->>'provenance'), ''), provenance),
          deleted = v_deleted,
          deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
          row_version = row_version + 1,
          updated_by = v_user_id
      where workspace_id = p_workspace_id
        and client_document_id = p_payload->>'client_document_id'
        and binding_kind = v_kind
        and coalesce(part, '') = coalesce(p_payload->>'part', '')
      returning to_jsonb(public.workspace_document_file_bindings.*) into v_result;
    end if;

  -- ----------------------------------------------------------------- inbox
  elsif p_entity_type = 'inbox_item' then
    v_entity_id := nullif(trim(coalesce(p_payload->>'client_inbox_id', '')), '');
    if v_entity_id is null then raise exception 'client_inbox_id fehlt'; end if;

    select i.row_version, i.created_by into v_current_version, v_current_created_by
    from public.workspace_inbox_items i
    where i.workspace_id = p_workspace_id and i.client_inbox_id = v_entity_id
    for update;

    if v_current_version is null then
      insert into public.workspace_inbox_items (
        workspace_id, client_inbox_id, status, vorgang_link_status, client_file_ref_id,
        archive_document_id, vorgang_id, expense_id, payload,
        created_by, updated_by, deleted, deleted_at, row_version
      ) values (
        p_workspace_id, v_entity_id,
        coalesce(nullif(p_payload->>'status', ''), 'neu'),
        coalesce(nullif(p_payload->>'vorgang_link_status', ''), 'none'),
        nullif(trim(coalesce(p_payload->>'client_file_ref_id', '')), ''),
        nullif(trim(coalesce(p_payload->>'archive_document_id', '')), ''),
        nullif(trim(coalesce(p_payload->>'vorgang_id', '')), ''),
        -- P2: expense_id ist server-owned — abgeleitet aus der Ausgabenzeile, nie aus dem Client.
        (
          select e.client_expense_id
          from public.workspace_expenses e
          where e.workspace_id = p_workspace_id
            and e.linked_inbox_id = v_entity_id
            and e.deleted = false
          order by e.updated_at desc, e.client_expense_id desc
          limit 1
        ),
        v_payload,
        v_user_id, v_user_id, v_deleted, case when v_deleted then now() else null end, 1
      )
      returning to_jsonb(public.workspace_inbox_items.*) into v_result;
    else
      if not v_can_write and v_current_created_by is distinct from v_user_id then
        raise exception 'Keine Schreibberechtigung';
      end if;
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt inbox_item:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_inbox_items
      set status = case when v_deleted then status else coalesce(nullif(p_payload->>'status', ''), status) end,
          vorgang_link_status = case when v_deleted then vorgang_link_status else coalesce(nullif(p_payload->>'vorgang_link_status', ''), vorgang_link_status) end,
          client_file_ref_id = case when v_deleted then client_file_ref_id else nullif(trim(coalesce(p_payload->>'client_file_ref_id', '')), '') end,
          archive_document_id = case when v_deleted then archive_document_id else nullif(trim(coalesce(p_payload->>'archive_document_id', '')), '') end,
          vorgang_id = case when v_deleted then vorgang_id else nullif(trim(coalesce(p_payload->>'vorgang_id', '')), '') end,
          -- P2: expense_id ist server-owned (upsert_workspace_expense); der Client-Wert wird ignoriert.
          payload = case when v_deleted then payload else v_payload end,
          deleted = v_deleted,
          deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
          row_version = row_version + 1,
          updated_by = v_user_id
      where workspace_id = p_workspace_id and client_inbox_id = v_entity_id
      returning to_jsonb(public.workspace_inbox_items.*) into v_result;
    end if;

  -- ---------------------------------------------------------- work results
  elsif p_entity_type = 'document_work_result' then
    v_entity_id := nullif(trim(coalesce(p_payload->>'client_inbox_id', '')), '');
    if v_entity_id is null then raise exception 'client_inbox_id fehlt'; end if;

    select w.row_version, w.created_by into v_current_version, v_current_created_by
    from public.workspace_document_work_results w
    where w.workspace_id = p_workspace_id and w.client_inbox_id = v_entity_id
    for update;

    if v_current_version is null then
      insert into public.workspace_document_work_results (
        workspace_id, client_inbox_id, source_fingerprint, analysis_version, analyzed_at, analysis, overlay,
        created_by, updated_by, deleted, deleted_at, row_version
      ) values (
        p_workspace_id, v_entity_id,
        coalesce(p_payload->>'source_fingerprint', ''),
        coalesce(p_payload->>'analysis_version', ''),
        (p_payload->>'analyzed_at')::timestamptz,
        coalesce(p_payload->'analysis', '{}'::jsonb),
        coalesce(p_payload->'overlay', '[]'::jsonb),
        v_user_id, v_user_id, v_deleted, case when v_deleted then now() else null end, 1
      )
      returning to_jsonb(public.workspace_document_work_results.*) into v_result;
    else
      if not v_can_write and v_current_created_by is distinct from v_user_id then
        raise exception 'Keine Schreibberechtigung';
      end if;
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt document_work_result:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_document_work_results
      set source_fingerprint = case when v_deleted then source_fingerprint else coalesce(p_payload->>'source_fingerprint', source_fingerprint) end,
          analysis_version = case when v_deleted then analysis_version else coalesce(p_payload->>'analysis_version', analysis_version) end,
          analyzed_at = case when v_deleted then analyzed_at else coalesce((p_payload->>'analyzed_at')::timestamptz, analyzed_at) end,
          analysis = case when v_deleted then analysis else coalesce(p_payload->'analysis', analysis) end,
          overlay = case when v_deleted then overlay else coalesce(p_payload->'overlay', overlay) end,
          deleted = v_deleted,
          deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
          row_version = row_version + 1,
          updated_by = v_user_id
      where workspace_id = p_workspace_id and client_inbox_id = v_entity_id
      returning to_jsonb(public.workspace_document_work_results.*) into v_result;
    end if;

  -- ------------------------------------------------------ archived documents
  elsif p_entity_type = 'archived_document' then
    v_entity_id := nullif(trim(coalesce(p_payload->>'client_document_id', '')), '');
    if v_entity_id is null then raise exception 'client_document_id fehlt'; end if;

    /*
     * BARZAHLUNG-V1 NACHTRAG 1 — ein Zahlungsnachweis wird nicht beerdigt.
     *
     * Hier und nicht nur im Client: Eine stornierte Zahlung faellt aus der
     * lokalen Projektion heraus, der Client sieht sie also gar nicht. Eine
     * Pruefung dort allein waere Scheinsicherheit.
     */
    if v_deleted then
      perform public.assert_document_not_payment_proof(p_workspace_id, v_entity_id);
    end if;

    select d.row_version, d.created_by into v_current_version, v_current_created_by
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id and d.client_document_id = v_entity_id
    for update;

    if v_current_version is null then
      insert into public.workspace_documents (
        workspace_id, client_document_id, document_kind, linked_invoice_id, linked_vorgang_id, payload,
        created_by, updated_by, deleted, deleted_at, deleted_by, row_version
      ) values (
        p_workspace_id, v_entity_id, 'archived_document',
        nullif(trim(coalesce(p_payload->>'linked_invoice_id', '')), ''),
        nullif(trim(coalesce(p_payload->>'linked_vorgang_id', '')), ''),
        v_payload,
        v_user_id, v_user_id, v_deleted,
        case when v_deleted then now() else null end,
        case when v_deleted then v_user_id else null end,
        1
      )
      returning to_jsonb(public.workspace_documents.*) into v_result;
    else
      -- Rechnungsdokumente gehen nie ueber diesen Pfad.
      if exists (
        select 1 from public.workspace_documents d
        where d.workspace_id = p_workspace_id and d.client_document_id = v_entity_id
          and d.document_kind <> 'archived_document'
      ) then
        raise exception 'Dokumentart nicht zulaessig';
      end if;
      if not v_can_write and v_current_created_by is distinct from v_user_id then
        raise exception 'Keine Schreibberechtigung';
      end if;
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt archived_document:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_documents
      set linked_invoice_id = case when v_deleted then linked_invoice_id else nullif(trim(coalesce(p_payload->>'linked_invoice_id', '')), '') end,
          linked_vorgang_id = case when v_deleted then linked_vorgang_id else nullif(trim(coalesce(p_payload->>'linked_vorgang_id', '')), '') end,
          payload = case when v_deleted then payload else v_payload end,
          deleted = v_deleted,
          deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
          deleted_by = case when v_deleted then coalesce(deleted_by, v_user_id) else null end,
          row_version = row_version + 1,
          updated_by = v_user_id
      where workspace_id = p_workspace_id and client_document_id = v_entity_id
      returning to_jsonb(public.workspace_documents.*) into v_result;
    end if;

  else
    raise exception 'Unbekannter Intake-Entity-Typ: %', p_entity_type;
  end if;

  return jsonb_build_object(
    'entity_type', p_entity_type,
    'entity_id', v_entity_id,
    'row_version', (v_result->>'row_version')::bigint,
    'deleted', coalesce((v_result->>'deleted')::boolean, false),
    'payload', v_result
  );
end;
$$;

/* ------------------------------------------------------------------------ */
/* Loeschweg 2 — erzeugte Rechnungsdokumente                                 */
/* Woertlich aus 20261019120000, ergaenzt um den Guard.                      */
/* ------------------------------------------------------------------------ */

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

  /*
   * BARZAHLUNG-V1 NACHTRAG 1 — auch der Rechnungsdokument-Weg kennt den
   * Zahlungsnachweis. Zwei Loeschwege, ein Schutz.
   */
  perform public.assert_document_not_payment_proof(p_workspace_id, p_client_document_id);

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

/* ------------------------------------------------------------------------ */
/* Rechte                                                                     */
/* ------------------------------------------------------------------------ */

revoke all on function public.assert_document_not_payment_proof(uuid, text) from public;
revoke all on function public.is_workspace_document_payment_proof(uuid, text) from public;
grant execute on function public.assert_document_not_payment_proof(uuid, text) to authenticated;
grant execute on function public.is_workspace_document_payment_proof(uuid, text) to authenticated;

/* ------------------------------------------------------------------------ */
/* Die Gegenseite des Rennens — woertlich aus 20261028120000, ergaenzt um    */
/* die Sperre auf derselben Dokumentzeile.                                   */
/* ------------------------------------------------------------------------ */

create or replace function public.set_workspace_expense_payment_proof(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_proof_document_id text default null
)
returns setof public.workspace_expense_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_expense_id text;
  v_payment_id text;
  v_document_id text;
  v_existing public.workspace_expense_payments;
  v_updated public.workspace_expense_payments;
begin
  /* R1-SEC-01 — wie bei jeder Aktion an der Finanzakte, vor allem anderen. */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  /* Dieselbe Mitgliedspruefung wie die uebrigen Ausgabenfunktionen. */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_client_expense_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_expense_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  v_document_id := nullif(trim(coalesce(p_proof_document_id, '')), '');

  /*
   * Workspace-Isolation: Das Dokument muss hier liegen. Ein Verweis auf ein
   * fremdes Dokument wird abgewiesen, nicht stillschweigend gespeichert.
   */
  if v_document_id is not null then
    /*
     * NACHTRAG 1 — dieselbe Zeile sperren, die auch die Loeschwege sperren.
     *
     * Ohne das koennten sich Zuordnen und Loeschen ueberholen: Der eine
     * prueft "nicht referenziert", waehrend der andere die Referenz gerade
     * setzt. Mit `for update` auf derselben Dokumentzeile serialisieren
     * beide, und es bleibt kein Fenster.
     */
    perform 1
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id
      and d.client_document_id = v_document_id
      and coalesce(d.deleted, false) = false
    for update;

    if not found then
      raise exception 'Zahlungsnachweis nicht gefunden';
    end if;
  end if;

  select * into v_existing
  from public.workspace_expense_payments
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
    and client_payment_id = v_payment_id
  for update;

  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  /* Idempotent: derselbe Nachweis ein zweites Mal aendert nichts. */
  if v_existing.proof_document_id is not distinct from v_document_id then
    return next v_existing;
    return;
  end if;

  update public.workspace_expense_payments
  set proof_document_id = v_document_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return next v_updated;
end;
$$;

create or replace function public.set_workspace_invoice_payment_proof(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_proof_document_id text default null
)
returns setof public.workspace_invoice_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_payment_id text;
  v_document_id text;
  v_existing public.workspace_invoice_payments;
  v_updated public.workspace_invoice_payments;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  /* Dieselbe Mitgliedspruefung wie die uebrigen Rechnungszahlungsfunktionen. */
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_invoice_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  v_document_id := nullif(trim(coalesce(p_proof_document_id, '')), '');

  if v_document_id is not null then
    /*
     * NACHTRAG 1 — dieselbe Zeile sperren, die auch die Loeschwege sperren.
     *
     * Ohne das koennten sich Zuordnen und Loeschen ueberholen: Der eine
     * prueft "nicht referenziert", waehrend der andere die Referenz gerade
     * setzt. Mit `for update` auf derselben Dokumentzeile serialisieren
     * beide, und es bleibt kein Fenster.
     */
    perform 1
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id
      and d.client_document_id = v_document_id
      and coalesce(d.deleted, false) = false
    for update;

    if not found then
      raise exception 'Zahlungsnachweis nicht gefunden';
    end if;
  end if;

  select * into v_existing
  from public.workspace_invoice_payments
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
    and client_payment_id = v_payment_id
  for update;

  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  if v_existing.proof_document_id is not distinct from v_document_id then
    return next v_existing;
    return;
  end if;

  update public.workspace_invoice_payments
  set proof_document_id = v_document_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return next v_updated;
end;
$$;
