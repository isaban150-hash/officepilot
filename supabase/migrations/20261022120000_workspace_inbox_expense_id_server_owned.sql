-- P2 EXPENSE -> INBOX_ITEM ROW_VERSION — `expense_id` am Eingang ist server-owned.
--
-- Absicht seit 20260917: `workspace_inbox_items.expense_id` wird serverseitig
-- aus `workspace_expenses.linked_inbox_id` abgeleitet — eine Wahrheit, kein
-- zweiter Schreibpfad. Tatsaechlich gab es zwei:
--
--   * `upsert_workspace_expense` setzte bzw. loeste `expense_id` und erhoehte
--     dabei die `row_version` des Eingangs;
--   * `upsert_workspace_intake_entity` uebernahm `expense_id` aus dem Client,
--     der stets `null` sendet.
--
-- Folge: Verknuepfen hob den Eingang auf v2, der naechste Intake-Push loeschte
-- `expense_id`, der naechste Ausgaben-Push setzte sie wieder und hob erneut —
-- ein Hin und Her aus Versionsspruengen, die keine Intake-Fachaenderung
-- darstellen und ungesendete Eingangsaenderungen in falsche Konflikte trieben.
--
-- Neu:
--   * Der Intake-Update-Zweig laesst `expense_id` unangetastet; der Insert
--     leitet sie aus der zuletzt aktualisierten, nicht geloeschten Ausgabe mit
--     `linked_inbox_id = client_inbox_id` ab (dieselbe Regel wie bisher:
--     die zuletzt schreibende Ausgabe gewinnt).
--   * Das Setzen/Loesen von `expense_id` durch `upsert_workspace_expense`
--     erhoeht die `row_version` des Eingangs nicht mehr; `updated_at` laeuft mit.
--
-- Alle uebrigen Zweige, Guards und Rueckgabewerte beider Funktionen sind
-- byte-gleich zu ihren letzten Fassungen (20260916 bzw. 20261007). Keine
-- Datenmigration, keine Tabellenaenderung, Signaturen und Rechte unveraendert.

-- Intake: letzte Fassung aus 20260916120000_workspace_files_intake_cloud.sql.
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

-- Ausgaben: letzte Fassung aus 20261007120000_workspace_expense_money_integrity.sql.
create or replace function public.upsert_workspace_expense(
  p_workspace_id uuid,
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
  v_expense_id text;
  v_status text;
  v_deleted boolean;
  v_dedupe text;
  v_inbox text;
  v_archive text;
  v_payload jsonb;
  v_existing public.workspace_expenses;
  v_row public.workspace_expenses;
  v_active_payments int;
  v_net_cents bigint;
  v_tax_cents bigint;
  v_gross_cents bigint;
  v_tax_status text;
  v_money_unchanged boolean;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_payload->>'client_expense_id', '')), '');
  if v_expense_id is null then
    raise exception 'client_expense_id fehlt';
  end if;

  v_status := coalesce(nullif(p_payload->>'status', ''), 'gebucht');
  if v_status not in ('entwurf', 'gebucht', 'storniert') then
    raise exception 'Status ungueltig';
  end if;
  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_dedupe := coalesce(p_payload->>'dedupe_key', '');
  v_inbox := nullif(trim(coalesce(p_payload->>'linked_inbox_id', '')), '');
  v_archive := nullif(trim(coalesce(p_payload->>'archive_document_id', '')), '');
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;
  -- Zahlungen reisen nie im Payload — getrennte Wahrheit.
  v_payload := v_payload - 'payments' - 'sync';

  select * into v_existing
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
  for update;

  /* ---------------------------------------------------------------- */
  /* FINANZCORE-05B2 — die Geldpruefung                                */
  /* ---------------------------------------------------------------- */

  /*
   * Ein Grabstein traegt keine Betraege und schreibt keine Nutzlast: Beim
   * Loeschen wird nur `deleted` gesetzt, `payload` bleibt unangetastet.
   *
   * Deshalb wird hier **nicht** geprueft. Genau das erlaubt der Client-Guard
   * ebenfalls ausdruecklich: Ein ungueltiger Altbeleg muss loeschbar bleiben,
   * sonst haenge er fuer immer in der Cloud fest, ohne dass ihn jemand
   * entfernen koennte.
   */
  if not v_deleted then
    /*
     * Aendern sich die Geldfelder gar nicht, ist dies ein Replay derselben
     * Zeile — etwa beim erstmaligen Sync eines Geraets oder nach einem
     * Verbindungsabbruch.
     *
     * Ein solcher Aufruf schreibt nichts Neues an Geld und darf deshalb nicht
     * scheitern: Ein ungueltiger Altbeleg wuerde sonst bei jedem Sync erneut
     * abgelehnt und der Auftrag endlos wiederholt. Der Bestand bleibt lesbar,
     * er wird nur nicht besser.
     *
     * Sobald aber **ein** Geldfeld oder der Steuerstatus abweicht, ist es eine
     * fachliche Aenderung — und die muss gueltig sein.
     *
     * `jsonb`-Vergleich statt Textvergleich: `100.00` und `100` sind derselbe
     * Zahlwert und sollen nicht als Aenderung gelten.
     */
    v_money_unchanged := v_existing.id is not null
      and not v_existing.deleted
      and (v_existing.payload->'netAmount')   is not distinct from (v_payload->'netAmount')
      and (v_existing.payload->'taxAmount')   is not distinct from (v_payload->'taxAmount')
      and (v_existing.payload->'grossAmount') is not distinct from (v_payload->'grossAmount')
      and (v_existing.payload->'taxStatus')   is not distinct from (v_payload->'taxStatus');

    if not coalesce(v_money_unchanged, false) then
      v_net_cents   := public.workspace_expense_money_cents(v_payload->'netAmount');
      v_tax_cents   := public.workspace_expense_money_cents(v_payload->'taxAmount');
      v_gross_cents := public.workspace_expense_money_cents(v_payload->'grossAmount');
      v_tax_status  := nullif(trim(coalesce(v_payload->>'taxStatus', '')), '');

      if v_net_cents is null or v_tax_cents is null or v_gross_cents is null then
        raise exception 'expense_money_invalid_amount: netAmount/taxAmount/grossAmount fehlen oder sind unbrauchbar';
      end if;

      -- Die Gleichung. Gilt fuer jedes Vorzeichen: -100 + -19 = -119.
      if v_net_cents + v_tax_cents <> v_gross_cents then
        raise exception 'expense_money_equation_mismatch: % + % ergibt %, erwartet %',
          v_net_cents, v_tax_cents, v_net_cents + v_tax_cents, v_gross_cents;
      end if;

      /*
       * Sagt der Status, dass keine Umsatzsteuer anfaellt, ist ein
       * Steuerbetrag ein Widerspruch zum Status selbst. `unclear` steht
       * bewusst nicht in dieser Liste.
       */
      if v_tax_cents <> 0
        and v_tax_status in ('reverse_charge_13b', 'tax_free', 'kleinunternehmer_19') then
        raise exception 'expense_money_tax_on_zero_rate_status: % erlaubt keinen Steuerbetrag, erhalten % Cent',
          v_tax_status, v_tax_cents;
      end if;

      -- Ein positiver Steuerbetrag auf negativem Netto ist kein Beleg, sondern ein Tippfehler.
      if (v_net_cents > 0 and v_tax_cents < 0) or (v_net_cents < 0 and v_tax_cents > 0) then
        raise exception 'expense_money_tax_sign_mismatch: netto % Cent, steuer % Cent',
          v_net_cents, v_tax_cents;
      end if;
    end if;
  end if;

  if v_existing.id is null then
    if v_deleted then
      -- Grabstein fuer eine Zeile, die die Cloud nie sah: nichts anzulegen.
      return jsonb_build_object('row_version', 0, 'updated_at', now(), 'deleted', true, 'noop', true);
    end if;
    insert into public.workspace_expenses (
      workspace_id, client_expense_id, status, dedupe_key, linked_inbox_id,
      archive_document_id, payload, deleted, row_version, created_by
    ) values (
      p_workspace_id, v_expense_id, v_status, v_dedupe, v_inbox,
      v_archive, v_payload, false, 1, v_user_id
    )
    returning * into v_row;
  else
    if v_existing.row_version <> coalesce(p_row_version, -1) then
      raise exception 'Versionskonflikt: Ausgabe % hat Version %, erwartet %',
        v_expense_id, v_existing.row_version, p_row_version;
    end if;
    if v_existing.deleted then
      raise exception 'Ausgabe bereits geloescht';
    end if;
    if v_deleted then
      select count(*) into v_active_payments
      from public.workspace_expense_payments
      where workspace_id = p_workspace_id
        and client_expense_id = v_expense_id
        and reversed_at is null;
      if v_active_payments > 0 then
        raise exception 'Ausgabe hat gebuchte Zahlungen';
      end if;
      update public.workspace_expenses
      set deleted = true,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    else
      update public.workspace_expenses
      set status = v_status,
          dedupe_key = v_dedupe,
          linked_inbox_id = v_inbox,
          archive_document_id = v_archive,
          payload = v_payload,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    end if;
  end if;

  /*
   * `expense_id` am Eingang — eine Wahrheit: die Ausgabenzeile. Ein alter
   * Verweis auf diese Ausgabe wird geloest, der aktuelle gesetzt.
   */
  update public.workspace_inbox_items
  set expense_id = null,
      updated_at = now()
  where workspace_id = p_workspace_id
    and expense_id = v_expense_id
    and (v_row.deleted or client_inbox_id is distinct from v_row.linked_inbox_id);
  if not v_row.deleted and v_row.linked_inbox_id is not null then
    update public.workspace_inbox_items
    set expense_id = v_expense_id,
        updated_at = now()
    where workspace_id = p_workspace_id
      and client_inbox_id = v_row.linked_inbox_id
      and expense_id is distinct from v_expense_id;
  end if;

  return jsonb_build_object(
    'row_version', v_row.row_version,
    'updated_at', v_row.updated_at,
    'deleted', v_row.deleted
  );
end;
$$;
