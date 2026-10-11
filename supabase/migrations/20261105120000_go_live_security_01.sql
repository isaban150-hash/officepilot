-- GO-LIVE-SECURITY-01 / PHASE 1 — serverseitige Rollen- und Archivsicherheit.
--
-- Befunde der Produktbestandsaufnahme (main @ dd81e5a), hier geschlossen:
--
--   A  Archiv. tombstone_workspace_document liess jedes aktive Mitglied jedes
--      nicht besonders geschuetzte Dokument loeschen und gab die Zeile zurueck,
--      auch Archivdokumente anderer Nutzer, die die Lese-Policy einem Mitglied
--      verbirgt. Ueber den Eingangsweg (upsert_workspace_intake_entity mit
--      deleted = false) liess sich ein geloeschtes Archivdokument ohne
--      Pruefspur wiederbeleben: von Inhaber und Admin jedes, von einem
--      Mitglied das eigene. Einen kontrollierten Wiederherstellungsweg gab es
--      nicht.
--   B  Rollen. Vier Schreibwege an festgeschriebenen Rechnungen und am Versand
--      prueften nur die Mitgliedschaft: Versand vermerken, Leistungszeitraum
--      bestaetigen, Rechnungsdokument sichern, Versandauftrag mit Kontext.
--      Dazu die Produktentscheidung vom 2026-10-09: Mitglieder bereiten
--      Angebote und Nachtraege vor, verbindlich freigeben (finalize_workspace_offer)
--      und bestaetigen (confirm_workspace_order_amendment) duerfen nur Inhaber
--      und Admin. Das Vorbereiten ueber den generischen Schreibweg bleibt
--      unveraendert.
--   C  Postfach/OAuth. Die privilegierten Hilfsfunktionen sind remote richtig
--      begrenzt, verlassen sich dafuer aber auf die Standardrechte des
--      Projekts: Die Migrationen entziehen nur public. Unter den Standardrechten
--      eines neu angelegten Projekts (und lokal) waeren u. a. die Versandhelfer
--      fuer E-Mails und die Zuordnungsfunktion fuer anon ausfuehrbar, obwohl
--      sie keine Anmeldung pruefen.
--   D  Betriebsuebergreifende Auskunft. assert_document_not_payment_proof war
--      fuer jeden angemeldeten Nutzer aufrufbar und verriet fuer jeden Betrieb,
--      ob ein Dokument ein Zahlungsnachweis ist. Vier Datenschutz-Helfer aus
--      P1 MITARBEITERZAHLUNGEN (Dokument, Datei, Eingang, Kommunikation)
--      verrieten ebenso, ob ein Eintrag eines fremden Betriebs ein Personalbeleg
--      ist. is_workspace_document_payment_proof prueft die Mitgliedschaft
--      bereits (seit 20261104120000) und bleibt unveraendert.
--   E  Angebotsstatus. Der generische Schreibweg liess Mitglieder freigegebene
--      Angebote auf versendet, abgelehnt, storniert oder ersetzt setzen und die
--      Ablage zuordnen; Entwuerfe mit Auftragsbezug oder Ablage nahm er an. Ein
--      Waechter an der Tabelle prueft jetzt jeden Schreibweg.
--
-- Grundsaetze:
--   * additiv; keine bereits angewendete Migration wird angefasst,
--   * jede geaenderte Funktion ist woertlich aus ihrer letzten Fassung
--     uebernommen; neu sind nur die mit GO-LIVE-SECURITY-01 markierten Stellen,
--   * Ablehnungen tragen den Fehlercode 42501: jeder Client stuft sie als
--     endgueltig ein und sendet nichts erneut,
--   * alle Rechte ausdruecklich gesetzt, deckungsgleich mit dem Remote-Stand
--     vom 2026-10-09 (Schema-Abzug, nur lesend).
--
-- Nur lokal vorbereitet. Die Anwendung auf die Cloud ist ein eigener,
-- ausdruecklich freizugebender Schritt.

/* ------------------------------------------------------------------------ */
/* A1 — Loeschen: nur Inhaber und Admin                                      */
/* Woertlich aus 20261104120000_workspace_employee_payments.sql.             */
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

  /*
   * GO-LIVE-SECURITY-01 — Loeschen ist Verwaltung: nur Inhaber und Admin
   * (`can_write_workspace`), wie im Eingangsweg ("member loescht nichts").
   * Ein Mitglied bekommt weder eine Loeschung noch eine Zeile zurueck, auch
   * nicht als Wiederholung an einem bereits geloeschten Dokument. Der
   * Zahlungsnachweis-Schutz darueber bleibt der erste Befund.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  /*
   * P1 MITARBEITERZAHLUNGEN — Datenschutz. Den Beleg einer Mitarbeiterzahlung
   * löschen und lesen nur Inhaber und Verwaltung. Ohne diese Prüfung gäbe die
   * Wiederholung an einem bereits gelöschten Beleg die Zeile jedem Mitglied
   * zurück.
   */
  if not public.can_write_workspace(p_workspace_id)
    and public.workspace_document_is_restricted(p_workspace_id, p_client_document_id) then
    raise exception 'Keine Schreibberechtigung';
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
  -- GO-LIVE-SECURITY-01: Ein Archivdokument traegt seinen Grabstein in
  -- `deleted` (Eingangsweg und Abzug lesen dieses Feld). Beide Marker bleiben
  -- deckungsgleich; Rechnungsdokumente behalten ihren bisherigen Stand.
  set deleted = case when document_kind = 'archived_document' then true else deleted end,
      deleted_at = now(),
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

revoke all on function public.tombstone_workspace_document(uuid, text) from public, anon, service_role;
grant execute on function public.tombstone_workspace_document(uuid, text) to authenticated;

/* ------------------------------------------------------------------------ */
/* A2 — Wiederherstellen: eigener Vertrag mit Rolle, Begruendung, Pruefspur  */
/* ------------------------------------------------------------------------ */

/*
 * Jede Wiederherstellung hinterlaesst genau eine unveraenderliche Zeile. Kein
 * Client schreibt hier; es gibt keine Schreibrechte, nur die Funktion unten.
 * Lesen duerfen Inhaber und Admin des Workspaces.
 *
 * restored_by und previous_deleted_by bewusst ohne Fremdschluessel: Die
 * Pruefspur ueberdauert ein geloeschtes Konto und blockiert dessen Loeschung
 * nicht.
 */
create table if not exists public.workspace_document_restorations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_document_id text not null,
  document_kind text not null,
  reason text not null,
  previous_deleted_at timestamptz null,
  previous_deleted_by uuid null,
  restored_by uuid not null,
  restored_at timestamptz not null default now(),
  row_version_after bigint not null,
  constraint workspace_document_restorations_reason_check
    check (char_length(btrim(reason)) between 3 and 500),
  constraint workspace_document_restorations_kind_check
    check (document_kind in ('generated_invoice', 'generated_invoice_correction', 'archived_document'))
);

create index if not exists workspace_document_restorations_document_idx
  on public.workspace_document_restorations (workspace_id, client_document_id, restored_at desc);

alter table public.workspace_document_restorations enable row level security;

revoke all on table public.workspace_document_restorations from public, anon, authenticated, service_role;
grant select on table public.workspace_document_restorations to authenticated;

drop policy if exists workspace_document_restorations_select_writer on public.workspace_document_restorations;
create policy workspace_document_restorations_select_writer
  on public.workspace_document_restorations
  for select
  to authenticated
  using (public.can_write_workspace(workspace_id));

-- Unveraenderlich: keine Aenderung einer geschriebenen Pruefzeile. Loeschen
-- geschieht nur mit dem Workspace (on delete cascade).
create or replace function public.workspace_document_restorations_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Pruefspur ist unveraenderlich' using errcode = '42501';
end;
$$;

revoke all on function public.workspace_document_restorations_immutable() from public, anon, authenticated, service_role;

drop trigger if exists workspace_document_restorations_no_update on public.workspace_document_restorations;
create trigger workspace_document_restorations_no_update
before update on public.workspace_document_restorations
for each row execute function public.workspace_document_restorations_immutable();

/*
 * Ein geloeschtes Dokument zurueckholen: nur Inhaber und Admin, nur mit
 * Begruendung, nur mit Pruefspur.
 *
 *  * Die Zeile wird gesperrt. Ein aktives Dokument ist eine Wiederholung und
 *    kommt unveraendert zurueck, ohne zweite Pruefzeile.
 *  * Beide Grabstein-Marker werden zurueckgenommen (deleted, deleted_at).
 *    row_version steigt, damit jedes Geraet die Rueckkehr im naechsten Abzug
 *    uebernimmt: Rechnungsdokumente ueber den Dokument-Abzug, Archivdokumente
 *    ueber den Eingangs-Abzug.
 *  * Je Rechnung gibt es genau eine Dokumentzeile, Grabsteine eingeschlossen
 *    (Business-Key-Index). Eine Wiederherstellung kann deshalb kein zweites
 *    aktives Rechnungsdokument erzeugen.
 *  * Zahlungsnachweise und Personalbelege bleiben geschuetzt: Loeschen,
 *    Lesen und Wiederherstellen liegen ohnehin nur bei Inhaber und Admin.
 *  * Dateien und Zuordnungen bleiben, wie sie sind: Der Loeschweg nimmt sie
 *    in der Cloud nicht weg.
 */
create or replace function public.restore_workspace_document(
  p_workspace_id uuid,
  p_client_document_id text,
  p_reason text
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_documents;
  v_restored public.workspace_documents;
  v_document_id text;
  v_reason text;
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
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  v_document_id := nullif(btrim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 then
    raise exception 'Begruendung fehlt';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'Begruendung zu lang';
  end if;

  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and client_document_id = v_document_id
  for update;

  if v_existing.id is null then
    raise exception 'Dokument nicht gefunden';
  end if;

  -- Wiederholung: Ein aktives Dokument bleibt, wie es ist.
  if v_existing.deleted_at is null and not v_existing.deleted then
    return next v_existing;
    return;
  end if;

  update public.workspace_documents
  set deleted = false,
      deleted_at = null,
      deleted_by = null,
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_restored;

  if v_restored.id is null or v_restored.deleted or v_restored.deleted_at is not null then
    raise exception 'Wiederherstellung nicht angewendet';
  end if;

  insert into public.workspace_document_restorations (
    workspace_id, client_document_id, document_kind, reason,
    previous_deleted_at, previous_deleted_by, restored_by, row_version_after
  ) values (
    p_workspace_id, v_document_id, v_existing.document_kind, v_reason,
    v_existing.deleted_at, v_existing.deleted_by, v_user_id, v_restored.row_version
  );

  return next v_restored;
end;
$$;

revoke all on function public.restore_workspace_document(uuid, text, text) from public, anon, service_role;
grant execute on function public.restore_workspace_document(uuid, text, text) to authenticated;

/* ------------------------------------------------------------------------ */
/* A3 — Eingangsweg: kein Wiederbeleben geloeschter Archivdokumente          */
/* Woertlich aus 20261029120000_workspace_document_payment_proof_guard.sql.  */
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
      /*
       * GO-LIVE-SECURITY-01 — kein Wiederbeleben ueber den Eingangsweg. Ein
       * geloeschtes Archivdokument kommt nur ueber restore_workspace_document
       * zurueck: mit Rolle, Begruendung und Pruefspur. Der Client sendet so
       * etwas nie von selbst (archivedDocumentConflictService: "dafuer gibt es
       * diesen Weg nicht"); ein direkter Aufruf wird abgewiesen, fuer jede Rolle.
       */
      if not v_deleted and exists (
        select 1 from public.workspace_documents d
        where d.workspace_id = p_workspace_id and d.client_document_id = v_entity_id
          and (d.deleted or d.deleted_at is not null)
      ) then
        raise exception 'Keine Schreibberechtigung: geloeschtes Dokument nur ueber die Wiederherstellung'
          using errcode = '42501';
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

revoke all on function public.upsert_workspace_intake_entity(uuid, text, jsonb, bigint) from public, anon, service_role;
grant execute on function public.upsert_workspace_intake_entity(uuid, text, jsonb, bigint) to authenticated;

/* ------------------------------------------------------------------------ */
/* B1 — Versand vermerken: nur Inhaber und Admin                             */
/* Woertlich aus 20260914120000_workspace_document_deliveries.sql.           */
/* ------------------------------------------------------------------------ */
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
  v_sent_source text;
  v_updated public.workspace_invoices;
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
   * GO-LIVE-SECURITY-01 — Der Versandvermerk setzt eine festgeschriebene
   * Rechnung auf "versendet" und bewegt damit Fristen und Archivschutz. Das ist
   * Verwaltung wie Finalisieren (R1-SEC-01) und der Versand selbst
   * (send-document): Inhaber oder Admin, nicht jedes Mitglied.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_sent_at := nullif(trim(coalesce(p_sent_at, '')), '');
  if v_sent_at is null then
    raise exception 'sent_at fehlt';
  end if;
  if v_sent_at !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'sent_at ungueltig';
  end if;
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

  -- Herkunft: bleibt officepilot, wenn ein OfficePilot-Versand die Wahrheit gesetzt hat.
  v_sent_source := coalesce(v_existing.sent_source, 'manual');

  /*
   * Monotonie unveraendert (04B1-Hardening): 'versendet' ist ein Endzustand,
   * Versandangaben duerfen korrigiert werden; RETURNING + Nachbedingungen wie
   * bisher. Neu ist ausschliesslich die Herkunft (sent_source / sentSource).
   */
  update public.workspace_invoices
  set
    invoice_status = 'versendet',
    sent_source = v_sent_source,
    payload = case
      when v_sent_note is null then
        (payload - 'sentNote')
          || jsonb_build_object('status', 'versendet', 'sentAt', v_sent_at, 'sentVia', v_sent_via, 'sentSource', v_sent_source)
      else
        payload
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_sent_at,
            'sentVia', v_sent_via,
            'sentNote', v_sent_note,
            'sentSource', v_sent_source
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

revoke all on function public.update_workspace_invoice_sent(uuid, text, text, text, text) from public, anon, service_role;
grant execute on function public.update_workspace_invoice_sent(uuid, text, text, text, text) to authenticated;

/* ------------------------------------------------------------------------ */
/* B2 — Leistungszeitraum bestaetigen: nur Inhaber und Admin                 */
/* Woertlich aus 20250903120000_workspace_invoice_service_period_confirmation.sql. */
/* ------------------------------------------------------------------------ */
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

  /*
   * GO-LIVE-SECURITY-01 — Die Bestaetigung des Leistungszeitraums ist eine
   * dauerhafte Aussage ueber eine festgeschriebene Rechnung und gibt deren
   * PDF-Weg frei. Inhaber oder Admin, wie das Finalisieren (R1-SEC-01).
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
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

revoke all on function public.confirm_workspace_invoice_service_period(uuid, text) from public, anon, service_role;
grant execute on function public.confirm_workspace_invoice_service_period(uuid, text) to authenticated;

/* ------------------------------------------------------------------------ */
/* B3 — Rechnungsdokument sichern: nur Inhaber und Admin                     */
/* Woertlich aus 20260912120000_workspace_invoice_without_vorgang.sql.       */
/* ------------------------------------------------------------------------ */
create or replace function public.upsert_workspace_generated_invoice_document(
  p_workspace_id uuid,
  p_client_document_id text,
  p_linked_invoice_id text,
  p_linked_vorgang_id text,
  p_payload jsonb
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice public.workspace_invoices;
  v_existing public.workspace_documents;
  v_inserted public.workspace_documents;
  v_document_id text;
  v_invoice_id text;
  v_vorgang_id text;
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
   * GO-LIVE-SECURITY-01 — Das Archivdokument einer Rechnung entsteht direkt
   * nach dem Finalisieren, und finalisieren duerfen nur Inhaber und Admin
   * (R1-SEC-01). Ein Mitglied legt kein Rechnungsarchiv an.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  v_document_id := nullif(trim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_linked_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'linked_invoice_id fehlt';
  end if;

  -- 01B2b: NULL heisst „kein Auftrag", '' heisst „kaputt".
  if p_linked_vorgang_id is not null and nullif(trim(p_linked_vorgang_id), '') is null then
    raise exception 'linked_vorgang_id fehlt';
  end if;
  v_vorgang_id := nullif(trim(coalesce(p_linked_vorgang_id, '')), '');

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;

  /*
   * Der Serialisierungspunkt.
   *
   * Ein `select … for update` auf die Dokumentzeile koennte nichts sperren,
   * solange es sie nicht gibt — genau der Fehler, den 04B2B3 fuer Zahlungen
   * korrigiert hat. Hier existiert aber bereits eine stabile Zeile fuer
   * dieselbe fachliche Einheit: die Rechnung. Zwei Geraete, die dieselbe
   * Rechnung archivieren, laufen zwangslaeufig durch dieselbe Zeile und werden
   * dort hintereinander gereiht. Der zweite sieht dann garantiert das Dokument
   * des ersten. Das gilt fuer die freie Rechnung genauso — sie hat eine Zeile.
   */
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;
  if v_invoice.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * 05C1C — der Vorgang kommt aus der Rechnung, nicht vom Client.
   *
   * Ohne diese Pruefung koennte ein Client fuer eine Rechnung einen beliebigen
   * fremden Vorgang behaupten — oder umgekehrt eine auftragsgebundene Rechnung
   * als frei ablegen. Abgeglichen wird die Spalte, nicht ein Titel oder ein
   * anderes Merkmal.
   */
  if v_vorgang_id is distinct from v_invoice.vorgang_id then
    raise exception 'Dokumentkonflikt: Vorgang passt nicht zur Rechnung';
  end if;

  /*
   * 05C1C — Payload und Spalten duerfen nicht zwei verschiedene Identitaeten
   * behaupten. Das ist bewusst keine vollstaendige Fachlogik in SQL: Die
   * semantische Vergleichsprojektion bleibt im Client (05C1B). Hier geht es
   * nur um die innere Widerspruchsfreiheit **einer** Zeile.
   *
   * Bei einer freien Rechnung fehlt `linkedVorgang` im Payload; der Ausdruck
   * liefert dann NULL und ist von `v_vorgang_id` NULL nicht verschieden.
   */
  if p_payload->>'linkedInvoiceId' is distinct from v_invoice_id
    or p_payload->'linkedVorgang'->>'vorgangId' is distinct from v_vorgang_id
  then
    raise exception 'Dokumentkonflikt: Payload widerspricht der Rechnungsidentitaet';
  end if;

  if p_payload->>'category' is distinct from 'ausgangsrechnung'
    or p_payload->>'classifiedKind' is distinct from 'ausgangsrechnung'
    or p_payload->>'archived' is distinct from 'true'
  then
    raise exception 'Dokumentkonflikt: Payload ist kein archiviertes Ausgangsrechnungs-Dokument';
  end if;

  /*
   * Fachliche Identitaet zuerst: Gibt es fuer diese Rechnung bereits ein
   * Dokument, ist das die kanonische Zeile — unabhaengig davon, welche lokale
   * Kennung das anfragende Geraet mitbringt.
   *
   * 05C1C — bewusst **ohne** `deleted_at is null`. Wuerde hier nur nach
   * aktiven Zeilen gesucht, saehe der RPC den Grabstein nicht und liefe in
   * einen Insert, den der Business-Key-Index hart abweist — mit einer
   * technischen Fehlermeldung statt einer verstaendlichen Aussage.
   */
  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and document_kind = 'generated_invoice'
    and linked_invoice_id = v_invoice_id;

  if v_existing.id is not null then
    /*
     * Grabsteinvorrang — vor allem anderen. Ein geloeschtes Dokument wird
     * weder wiederbelebt noch als Erfolg zurueckgegeben, und der Business Key
     * bleibt bei ihm. Ein echtes Wiederherstellen waere ein eigener Vertrag.
     */
    if v_existing.deleted_at is not null then
      raise exception 'Dokumentkonflikt: dieses Dokument wurde geloescht';
    end if;

    /*
     * Kein zweites Dokument, aber auch keine stille Uebernahme. Verglichen wird
     * die fachliche Substanz, nicht die lokale Kennung: Zwei Geraete duerfen
     * verschiedene `doc-`IDs haben, aber nicht verschiedene Inhalte behaupten.
     */
    if v_existing.linked_vorgang_id is distinct from v_vorgang_id then
      raise exception 'Dokumentkonflikt: abweichender Vorgang fuer dieselbe Rechnung';
    end if;

    return next v_existing;
    return;
  end if;

  /*
   * 05C1C — die Kennungspruefung gilt **nur** hier, beim Anlegen der neuen
   * kanonischen Zeile.
   *
   * Beim Replay eines zweiten Geraets traegt die kanonische Zeile die Kennung
   * des ersten; dort waere dieselbe Pruefung schlicht falsch und wuerde den
   * zulaessigen Zwei-Geraete-Fall unmoeglich machen. Deshalb steht sie hinter
   * der Rueckgabe der bestehenden Zeile.
   */
  if p_payload ? 'id' and p_payload->>'id' is distinct from v_document_id then
    raise exception 'Dokumentkonflikt: Payload-ID passt nicht zur Dokumentkennung';
  end if;

  insert into public.workspace_documents (
    workspace_id, client_document_id, document_kind,
    linked_invoice_id, linked_vorgang_id, payload, created_by, updated_by
  )
  values (
    p_workspace_id, v_document_id, 'generated_invoice',
    v_invoice_id, v_vorgang_id, p_payload, v_user_id, v_user_id
  )
  on conflict (workspace_id, client_document_id) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    /*
     * Dieselbe lokale Kennung existiert bereits — und zwar fuer eine **andere**
     * Rechnung, denn jede Zeile zu dieser Rechnung haette die fachliche Suche
     * oben gefunden, Grabsteine eingeschlossen. Eine Kennung darf nicht zwei
     * Rechnungen bezeichnen.
     */
    raise exception 'Dokumentkonflikt: diese Kennung gehoert zu einer anderen Rechnung';
  end if;

  -- Nachbedingung: Die zurueckgegebene Zeile bildet den Request vollstaendig ab.
  if v_inserted.workspace_id is distinct from p_workspace_id
    or v_inserted.client_document_id is distinct from v_document_id
    or v_inserted.document_kind is distinct from 'generated_invoice'
    or v_inserted.linked_invoice_id is distinct from v_invoice_id
    or v_inserted.linked_vorgang_id is distinct from v_vorgang_id
    or v_inserted.payload is distinct from p_payload
    or v_inserted.deleted_at is not null
  then
    raise exception 'Dokument Nachbedingung verletzt';
  end if;

  return next v_inserted;
end;
$$;

revoke all on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) from public, anon, service_role;
grant execute on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) to authenticated;

/* ------------------------------------------------------------------------ */
/* B4 — Versandauftrag mit Kontext: Pruefung vor dem Kontext                 */
/* Woertlich aus 20261011120000_workspace_document_delivery_context.sql.     */
/* ------------------------------------------------------------------------ */
create or replace function public.create_workspace_document_delivery_with_context(
  p_workspace_id uuid,
  p_client_delivery_id text,
  p_document_kind text,
  p_linked_invoice_id text,
  p_recipient_email text,
  p_subject text,
  p_body_text text,
  p_attachment_storage_path text,
  p_attachment_sha256 text,
  p_attachment_size_bytes bigint,
  p_attachment_filename text,
  p_attachment_mime_type text,
  p_provider text,
  p_retry_of_delivery_id uuid default null,
  p_linked_document_id text default null,
  p_confirm_uncertain_retry boolean default false,
  p_customer_id text default null,
  p_vorgang_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
  v_invoice_vorgang_id text;
  v_result jsonb;
  v_delivery_id uuid;
  v_row public.workspace_document_deliveries;
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

  /*
   * GO-LIVE-SECURITY-01 — Der Versandkern prueft das bereits. Hier steht die
   * Pruefung ausdruecklich vor der Kontextpruefung, damit der Schutz nicht vom
   * inneren Aufruf abhaengt: Versand ist Inhaber oder Admin.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  -- Kontext nur aus diesem Workspace — keine Verknuepfung ueber Workspace-Grenzen.
  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and not c.deleted
  ) then
    raise exception 'customer_id gehoert nicht zum Workspace';
  end if;
  if v_vorgang_id is not null and not exists (
    select 1 from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id and not v.deleted
  ) then
    raise exception 'vorgang_id gehoert nicht zum Workspace';
  end if;

  -- Eine Rechnung gehoert serverseitig zu genau einem Vorgang: der Kontext muss passen.
  if v_vorgang_id is not null and p_document_kind in ('invoice', 'invoice_correction') then
    select i.vorgang_id into v_invoice_vorgang_id
    from public.workspace_invoices i
    where i.workspace_id = p_workspace_id and i.client_invoice_id = btrim(coalesce(p_linked_invoice_id, ''))
    limit 1;
    if v_invoice_vorgang_id is not null and v_invoice_vorgang_id <> v_vorgang_id then
      raise exception 'vorgang_id passt nicht zur Rechnung';
    end if;
  end if;

  -- Der Versandkern aus 07B bleibt unveraendert zustaendig (Pruefungen, Idempotenz, Retry-Kette).
  v_result := public.create_workspace_document_delivery(
    p_workspace_id,
    p_client_delivery_id,
    p_document_kind,
    p_linked_invoice_id,
    p_recipient_email,
    p_subject,
    p_body_text,
    p_attachment_storage_path,
    p_attachment_sha256,
    p_attachment_size_bytes,
    p_attachment_filename,
    p_attachment_mime_type,
    p_provider,
    p_retry_of_delivery_id,
    p_linked_document_id,
    p_confirm_uncertain_retry
  );

  v_delivery_id := nullif(v_result #>> '{delivery,id}', '')::uuid;
  if v_delivery_id is null then
    return v_result;
  end if;

  -- Nur ergaenzen: ein bereits gesetzter Kontext (Replay) wird nie ueberschrieben.
  update public.workspace_document_deliveries d
  set customer_id = coalesce(d.customer_id, v_customer_id),
      vorgang_id = coalesce(d.vorgang_id, v_vorgang_id)
  where d.id = v_delivery_id
    and d.workspace_id = p_workspace_id
  returning d.* into v_row;

  return jsonb_set(v_result, '{delivery}', to_jsonb(v_row));
end;
$$;

revoke all on function public.create_workspace_document_delivery_with_context(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean, text, text) from public, anon, service_role;
grant execute on function public.create_workspace_document_delivery_with_context(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean, text, text) to authenticated;

-- Der Versandkern selbst bleibt unveraendert; nur seine Rechte stehen jetzt
-- ausdruecklich hier (Client-Aufruf als authenticated).
revoke all on function public.create_workspace_document_delivery(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean) from public, anon, service_role;
grant execute on function public.create_workspace_document_delivery(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean) to authenticated;

/* ------------------------------------------------------------------------ */
/* B5 — Angebot verbindlich freigeben: nur Inhaber und Admin                 */
/* Woertlich aus 20260928120000_workspace_offers.sql.                        */
/* ------------------------------------------------------------------------ */
create or replace function public.finalize_workspace_offer(
  p_workspace_id uuid,
  p_offer_id text,
  p_payload jsonb,
  p_fingerprint text,
  p_row_version bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_offers;
  v_year integer;
  v_seq integer;
  v_number text;
  v_customer_id text;
  v_payload jsonb;
  v_positions jsonb;
  v_has_position boolean := false;
  v_pos jsonb;
  v_now timestamptz := now();
begin
  p_row_version := coalesce(p_row_version, 0);

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if not public.workspace_user_can_intake(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  /*
   * GO-LIVE-SECURITY-01 — Produktentscheidung vom 2026-10-09: Mitglieder
   * bereiten Angebote vor (Entwurf über den generischen Schreibweg,
   * unverändert). Die verbindliche Freigabe mit Nummernvergabe geben nur
   * Inhaber und Admin. Die Prüfung steht vor dem Anlegen der Zeile.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;
  if p_offer_id is null or length(trim(p_offer_id)) = 0 then
    raise exception 'offer_id fehlt';
  end if;
  if p_fingerprint is null or length(trim(p_fingerprint)) = 0 then
    raise exception 'fingerprint fehlt';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Angebot ungueltig: payload';
  end if;

  -- Zeile anlegen, falls der Entwurf nie gesendet wurde; dann sperren.
  insert into public.workspace_offers (workspace_id, client_offer_id, client_customer_id, status, payload, row_version, created_by, updated_by)
  values (p_workspace_id, p_offer_id, nullif(trim(p_payload->>'customerId'), ''), 'entwurf', p_payload, 1, auth.uid(), auth.uid())
  on conflict (workspace_id, client_offer_id) do nothing;

  select o.* into v_row
  from public.workspace_offers o
  where o.workspace_id = p_workspace_id and o.client_offer_id = p_offer_id
  for update;

  if v_row.deleted then
    raise exception 'Angebot ist geloescht' using errcode = 'P0001';
  end if;

  if v_row.status <> 'entwurf' then
    if v_row.content_fingerprint = p_fingerprint then
      return jsonb_build_object('row', to_jsonb(v_row), 'row_version', v_row.row_version, 'replayed', true);
    end if;
    raise exception 'Angebot ist bereits freigegeben (%)', v_row.offer_number using errcode = 'P0001';
  end if;

  -- Versionsvertrag wie in der generischen Schreibfunktion: bestaetigt muss passen.
  if p_row_version > 0 and p_row_version <> v_row.row_version then
    raise exception 'Versionskonflikt offer:%', v_row.row_version using errcode = 'P0001';
  end if;

  -- Fachliche Pflichten.
  if length(trim(coalesce(p_payload->'customer'->>'name', ''))) = 0 then
    raise exception 'Angebot ungueltig: Kunde fehlt' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(p_payload->>'title', ''))) = 0 then
    raise exception 'Angebot ungueltig: Betreff fehlt' using errcode = 'P0001';
  end if;
  if coalesce(p_payload->>'validUntil', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Angebot ungueltig: Gueltigkeit fehlt' using errcode = 'P0001';
  end if;
  v_positions := p_payload->'positions';
  if v_positions is null or jsonb_typeof(v_positions) <> 'array' then
    raise exception 'Angebot ungueltig: Positionen fehlen' using errcode = 'P0001';
  end if;
  for v_pos in select * from jsonb_array_elements(v_positions) loop
    if jsonb_typeof(v_pos->'quantity') = 'number' and (v_pos->>'quantity')::numeric > 0 then
      v_has_position := true;
    end if;
    if jsonb_typeof(v_pos->'unitPrice') = 'number' and (v_pos->>'unitPrice')::numeric < 0 then
      raise exception 'Angebot ungueltig: negativer Preis' using errcode = 'P0001';
    end if;
  end loop;
  if not v_has_position then
    raise exception 'Angebot ungueltig: keine Position mit Menge' using errcode = 'P0001';
  end if;
  if p_payload->'totals' is null or jsonb_typeof(p_payload->'totals') <> 'object' then
    raise exception 'Angebot ungueltig: Summen fehlen' using errcode = 'P0001';
  end if;

  -- Fremdworkspace-Kunde: Ist ein Kunde referenziert, muss er zu diesem Workspace gehoeren.
  v_customer_id := nullif(trim(coalesce(p_payload->>'customerId', '')), '');
  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
  ) then
    -- Der Kunde kann lokal angelegt und noch nicht synchronisiert sein; das
    -- Angebot traegt seinen Schnappschuss ohnehin selbst. Deshalb kein Abbruch,
    -- aber der Bezug wird nicht als Serverwahrheit uebernommen.
    v_customer_id := null;
  end if;

  -- Nummer: Jahr aus dem Angebotsdatum, sonst heute.
  v_year := coalesce(nullif(substr(coalesce(p_payload->>'offerDate', ''), 1, 4), '')::integer, extract(year from v_now)::integer);
  insert into public.workspace_offer_sequences (workspace_id, offer_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, offer_year) do nothing;

  select s.last_sequence + 1 into v_seq
  from public.workspace_offer_sequences s
  where s.workspace_id = p_workspace_id and s.offer_year = v_year
  for update;

  update public.workspace_offer_sequences
  set last_sequence = v_seq
  where workspace_id = p_workspace_id and offer_year = v_year;

  v_number := public.format_workspace_offer_number(v_year, v_seq);

  v_payload := p_payload
    || jsonb_build_object(
      'status', 'freigegeben',
      'offerNumber', v_number,
      'offerSequenceNumber', v_seq,
      'contentFingerprint', p_fingerprint,
      'finalizedAt', to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );

  update public.workspace_offers
  set
    status = 'freigegeben',
    offer_number = v_number,
    offer_sequence_number = v_seq,
    offer_year = v_year,
    content_fingerprint = p_fingerprint,
    client_customer_id = coalesce(nullif(trim(coalesce(p_payload->>'customerId', '')), ''), client_customer_id),
    payload = v_payload,
    row_version = row_version + 1,
    updated_by = auth.uid()
  where workspace_id = p_workspace_id and client_offer_id = p_offer_id
  returning * into v_row;

  return jsonb_build_object('row', to_jsonb(v_row), 'row_version', v_row.row_version, 'replayed', false);
end;
$$;

revoke all on function public.finalize_workspace_offer(uuid, text, jsonb, text, bigint) from public, anon, service_role;
grant execute on function public.finalize_workspace_offer(uuid, text, jsonb, text, bigint) to authenticated;

/* ------------------------------------------------------------------------ */
/* B6 — Nachtrag verbindlich bestaetigen: nur Inhaber und Admin              */
/* Woertlich aus 20261103120000_workspace_order_drafts.sql.                  */
/* ------------------------------------------------------------------------ */
create or replace function public.confirm_workspace_order_amendment(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_amendment_id text,
  p_amendment jsonb,
  p_source_draft_id text default null,
  p_expected_draft_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_vorgang public.workspace_vorgaenge;
  v_existing public.workspace_order_amendments;
  v_vorgang_id text;
  v_client_id text;
  v_title text;
  v_reason text;
  v_positions jsonb;
  v_normalized_positions jsonb := '[]'::jsonb;
  v_canonical jsonb;
  v_fingerprint text;
  v_contract jsonb;
  v_snapshot_positions jsonb;
  v_snapshot_ids text[] := array[]::text[];
  v_existing_ids text[] := array[]::text[];
  v_seen_ids text[] := array[]::text[];
  v_pos jsonb;
  v_pos_id text;
  v_change_type text;
  v_parent_id text;
  v_description text;
  v_unit text;
  v_unit_label text;
  v_category text;
  v_planned_quantity numeric;
  v_unit_price numeric;
  v_billable boolean;
  v_normalized_pos jsonb;
  v_next_sequence integer;
  v_has_final_schluss boolean;
  v_has_existing boolean := false;
  v_allowed_units text[] := array['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
  i integer;
  -- CLOUD-SYNC S6: nur fuer die Entwurfsbindung.
  v_source_draft_id text;
  v_amend_draft public.workspace_order_amendment_drafts;
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
   * GO-LIVE-SECURITY-01 — Produktentscheidung vom 2026-10-09: Mitglieder
   * bereiten Nachträge vor (order_amendment_draft, unverändert). Die
   * verbindliche Bestätigung geben nur Inhaber und Admin, wie die
   * Auftragsanlage (create_workspace_order). Fehlercode 42501: Der Client
   * stuft das als endgültig ein und sperrt keinen Entwurf.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');
  if v_vorgang_id is null then
    raise exception 'order_amendment_vorgang_not_found';
  end if;

  v_client_id := nullif(trim(coalesce(p_client_amendment_id, '')), '');
  if v_client_id is null then
    raise exception 'order_amendment_invalid_position';
  end if;

  if p_amendment is null or jsonb_typeof(p_amendment) <> 'object' then
    raise exception 'order_amendment_invalid_position';
  end if;

  -- Lock order: workspace_vorgaenge first (shared with finalize_workspace_invoice).
  select *
  into v_vorgang
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id
    and v.vorgang_id = v_vorgang_id
  for update;

  if not found or v_vorgang.deleted then
    raise exception 'order_amendment_vorgang_not_found';
  end if;

  v_contract := v_vorgang.payload->'contractConfirmation';
  if v_contract is null or jsonb_typeof(v_contract) <> 'object' then
    raise exception 'order_amendment_contract_confirmation_missing';
  end if;

  v_snapshot_positions := coalesce(v_contract->'positions', '[]'::jsonb);
  if jsonb_typeof(v_snapshot_positions) <> 'array' then
    raise exception 'order_amendment_contract_confirmation_missing';
  end if;

  select coalesce(array_agg(nullif(trim(p->>'id'), '')), array[]::text[])
  into v_snapshot_ids
  from jsonb_array_elements(v_snapshot_positions) as p
  where nullif(trim(p->>'id'), '') is not null;

  /*
   * CLOUD-SYNC S6 -- die Bindung an den Cloud-Nachtragsentwurf.
   *
   * Sperrreihenfolge wie bisher, nur verlaengert: zuerst der Vorgang (oben,
   * gemeinsam mit finalize_workspace_invoice), dann der Entwurf, dann die
   * Nachtragszeile. finalize_workspace_invoice beruehrt keinen
   * Nachtragsentwurf; das Speichern eines Nachtragsentwurfs sperrt nur dessen
   * eigene Zeile und liest den Vorgang ohne Sperre. Es entsteht keine
   * Sperrkette.
   */
  v_source_draft_id := nullif(trim(coalesce(p_source_draft_id, '')), '');
  if (p_source_draft_id is not null and v_source_draft_id is null)
     or ((v_source_draft_id is null) <> (p_expected_draft_row_version is null))
     or coalesce(p_expected_draft_row_version, 1) < 1 then
    raise exception 'order_amendment_draft_binding_invalid';
  end if;

  if v_source_draft_id is not null then
    select d.* into v_amend_draft
    from public.workspace_order_amendment_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_source_draft_id
    for update;
    if not found then
      raise exception 'order_amendment_draft_not_found';
    end if;
    if v_amend_draft.vorgang_id is distinct from v_vorgang_id then
      raise exception 'order_amendment_draft_binding_invalid';
    end if;
    if v_amend_draft.deleted then
      raise exception 'order_amendment_draft_discarded';
    end if;
    if v_amend_draft.status = 'consumed' then
      /*
       * Nur der eigene Verbrauch ist eine Wiederholung: derselbe Nachtrag und
       * genau die gebundene Version (+ 1). Alles andere -- ein anderes Geraet
       * mit eigener Kennung, eine andere Version -- ist kein Erfolg.
       */
      if v_amend_draft.consumed_client_amendment_id is distinct from v_client_id
         or v_amend_draft.row_version <> p_expected_draft_row_version + 1 then
        raise exception 'order_amendment_draft_already_consumed';
      end if;
    elsif v_amend_draft.row_version <> p_expected_draft_row_version then
      raise exception 'order_amendment_draft_version_conflict:%', v_amend_draft.row_version;
    end if;
  end if;

  -- Lock existing row early (idempotency before schluss guard).
  select *
  into v_existing
  from public.workspace_order_amendments a
  where a.workspace_id = p_workspace_id
    and a.client_amendment_id = v_client_id
  for update;
  v_has_existing := found;

  v_title := nullif(trim(coalesce(p_amendment->>'title', '')), '');
  v_reason := nullif(trim(coalesce(p_amendment->>'reason', '')), '');
  v_positions := p_amendment->'positions';

  if v_title is null then
    raise exception 'order_amendment_invalid_position';
  end if;
  if v_positions is null or jsonb_typeof(v_positions) <> 'array' or jsonb_array_length(v_positions) < 1 then
    raise exception 'order_amendment_invalid_position';
  end if;

  for i in 0 .. jsonb_array_length(v_positions) - 1 loop
    v_pos := v_positions->i;
    if v_pos is null or jsonb_typeof(v_pos) <> 'object' then
      raise exception 'order_amendment_invalid_position';
    end if;

    v_pos_id := nullif(trim(coalesce(v_pos->>'id', '')), '');
    v_change_type := nullif(trim(coalesce(v_pos->>'changeType', '')), '');
    v_parent_id := nullif(trim(coalesce(v_pos->>'parentPositionId', '')), '');
    v_description := nullif(trim(coalesce(v_pos->>'description', '')), '');
    v_unit := nullif(trim(coalesce(v_pos->>'unit', '')), '');
    v_unit_label := nullif(trim(coalesce(v_pos->>'unitLabel', '')), '');
    v_category := nullif(trim(coalesce(v_pos->>'category', '')), '');

    if v_pos_id is null or v_change_type is null or v_description is null or v_unit is null then
      raise exception 'order_amendment_invalid_position';
    end if;

    if v_change_type not in ('add', 'quantity_increase') then
      raise exception 'order_amendment_invalid_position';
    end if;

    if not (v_unit = any (v_allowed_units)) then
      raise exception 'order_amendment_invalid_position';
    end if;

    begin
      v_planned_quantity := (v_pos->>'plannedQuantity')::numeric;
    exception
      when others then
        raise exception 'order_amendment_invalid_position';
    end;
    if v_planned_quantity is null
       or v_planned_quantity <= 0
       or v_planned_quantity = 'NaN'::numeric
       or v_planned_quantity = 'Infinity'::numeric
       or v_planned_quantity = '-Infinity'::numeric then
      raise exception 'order_amendment_invalid_position';
    end if;

    begin
      v_unit_price := (v_pos->>'unitPrice')::numeric;
    exception
      when others then
        raise exception 'order_amendment_invalid_position';
    end;
    if v_unit_price is null
       or v_unit_price < 0
       or v_unit_price = 'NaN'::numeric
       or v_unit_price = 'Infinity'::numeric
       or v_unit_price = '-Infinity'::numeric then
      raise exception 'order_amendment_invalid_position';
    end if;

    if v_pos ? 'billable' and jsonb_typeof(v_pos->'billable') = 'boolean' then
      v_billable := (v_pos->>'billable')::boolean;
    else
      v_billable := null;
    end if;

    -- 01A rules: add forbids parentPositionId; quantity_increase requires parent in Hauptsnapshot.
    -- unit/category/billable are NOT required to match parent (01A only prefills, does not enforce).
    if v_change_type = 'add' then
      if v_parent_id is not null then
        raise exception 'order_amendment_invalid_position';
      end if;
    elsif v_change_type = 'quantity_increase' then
      if v_parent_id is null then
        raise exception 'order_amendment_parent_position_not_found';
      end if;
      if not (v_parent_id = any (v_snapshot_ids)) then
        raise exception 'order_amendment_parent_position_not_found';
      end if;
    end if;

    if v_pos_id = any (v_seen_ids) then
      raise exception 'order_amendment_position_id_conflict';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_pos_id);

    v_normalized_pos := jsonb_build_object(
      'id', v_pos_id,
      'changeType', v_change_type,
      'parentPositionId', to_jsonb(v_parent_id),
      'description', v_description,
      'plannedQuantity', v_planned_quantity,
      'unit', v_unit,
      'unitLabel', to_jsonb(v_unit_label),
      'unitPrice', v_unit_price,
      'category', to_jsonb(v_category),
      'billable', to_jsonb(v_billable)
    );
    v_normalized_positions := v_normalized_positions || jsonb_build_array(v_normalized_pos);
  end loop;

  v_canonical := public.build_workspace_order_amendment_canonical_content(
    v_vorgang_id,
    v_title,
    v_reason,
    v_normalized_positions
  );
  v_fingerprint := public.fingerprint_workspace_order_amendment_canonical(v_canonical);

  -- Idempotency before schluss guard (retry after lost response + later schluss).
  if v_has_existing then
    if v_existing.vorgang_id is distinct from v_vorgang_id
       or v_existing.content_fingerprint is distinct from v_fingerprint then
      raise exception 'order_amendment_idempotency_conflict';
    end if;

    /*
     * CLOUD-SYNC S6 -- gebundene Wiederholung. Ist der Entwurf noch aktiv,
     * lief die erste Bestaetigung ohne Bindung; der Verbrauch wird jetzt in
     * genau der gebundenen Version nachgeholt. Inhalt (Fingerprint, oben
     * geprueft) und Entwurfsversion stimmen dann nachweislich ueberein.
     */
    if v_source_draft_id is not null and v_amend_draft.status = 'active' then
      update public.workspace_order_amendment_drafts
      set
        status = 'consumed',
        consumed_client_amendment_id = v_client_id,
        payload = '{}'::jsonb,
        row_version = row_version + 1,
        updated_by = v_user_id
      where workspace_id = p_workspace_id and client_draft_id = v_source_draft_id
        and status = 'active' and not deleted
        and row_version = p_expected_draft_row_version;
      if not found then
        raise exception 'order_amendment_draft_consume_failed';
      end if;
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'amendment', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  -- Final Schlussrechnung blocks NEW confirms only (after idempotency).
  select exists (
    select 1
    from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id
      and wi.vorgang_id = v_vorgang_id
      and wi.invoice_type = 'schluss'
      and wi.invoice_status in ('vorbereitet', 'versendet')
  )
  into v_has_final_schluss;

  if coalesce(v_has_final_schluss, false) then
    raise exception 'order_amendment_final_invoice_exists';
  end if;

  -- Position id collisions against snapshot + previously confirmed amendments.
  select coalesce(array_agg(distinct nullif(trim(pos->>'id'), '')), array[]::text[])
  into v_existing_ids
  from public.workspace_order_amendments a
  cross join lateral jsonb_array_elements(coalesce(a.payload->'positions', '[]'::jsonb)) as pos
  where a.workspace_id = p_workspace_id
    and a.vorgang_id = v_vorgang_id
    and nullif(trim(pos->>'id'), '') is not null;

  for i in 1 .. coalesce(array_length(v_seen_ids, 1), 0) loop
    if v_seen_ids[i] = any (v_snapshot_ids) or v_seen_ids[i] = any (v_existing_ids) then
      raise exception 'order_amendment_position_id_conflict';
    end if;
  end loop;

  select coalesce(max(a.sequence_no), 0) + 1
  into v_next_sequence
  from public.workspace_order_amendments a
  where a.workspace_id = p_workspace_id
    and a.vorgang_id = v_vorgang_id;

  insert into public.workspace_order_amendments (
    workspace_id,
    vorgang_id,
    client_amendment_id,
    sequence_no,
    status,
    content_fingerprint,
    payload,
    confirmed_at,
    confirmed_by,
    row_version
  )
  values (
    p_workspace_id,
    v_vorgang_id,
    v_client_id,
    v_next_sequence,
    'bestaetigt',
    v_fingerprint,
    jsonb_build_object(
      'title', v_title,
      'reason', to_jsonb(v_reason),
      'positions', v_normalized_positions,
      'clientAmendmentId', v_client_id,
      'vorgangId', v_vorgang_id,
      'sequenceNo', v_next_sequence
    ) || case when v_source_draft_id is not null
           then jsonb_build_object('sourceDraftId', v_source_draft_id)
           else '{}'::jsonb end,
    timezone('utc', now()),
    v_user_id,
    1
  )
  returning * into v_existing;

  /*
   * CLOUD-SYNC S6 -- der Entwurf wird in derselben Transaktion verbraucht: Es
   * gibt keinen Zwischenstand, in dem der Nachtrag bestaetigt ist und sein
   * Entwurf noch aktiv. Der Bezug auf den Nachtrag ist ein Fremdschluessel;
   * der verbrauchte Entwurf traegt keinen Inhalt mehr. Scheitert das, rollt
   * die ganze Bestaetigung zurueck, die Sequenz eingeschlossen.
   */
  if v_source_draft_id is not null then
    update public.workspace_order_amendment_drafts
    set
      status = 'consumed',
      consumed_client_amendment_id = v_client_id,
      payload = '{}'::jsonb,
      row_version = row_version + 1,
      updated_by = v_user_id
    where workspace_id = p_workspace_id and client_draft_id = v_source_draft_id
      and status = 'active' and not deleted
      and row_version = p_expected_draft_row_version;
    if not found then
      raise exception 'order_amendment_draft_consume_failed';
    end if;
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'amendment', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

revoke all on function public.confirm_workspace_order_amendment(uuid, text, text, jsonb, text, bigint) from public, anon, service_role;
grant execute on function public.confirm_workspace_order_amendment(uuid, text, text, jsonb, text, bigint) to authenticated;

/* ------------------------------------------------------------------------ */
/* D — keine Auskunft ueber fremde Betriebe                                  */
/* ------------------------------------------------------------------------ */

-- D1 Die Zahlungsnachweis-Pruefung ist ein interner Waechter: Aufrufer sind
--    ausschliesslich tombstone_workspace_document und
--    upsert_workspace_intake_entity (beide Security Definer, beide pruefen
--    vorher die Mitgliedschaft). Kein Client und keine Edge Function ruft sie.
revoke all on function public.assert_document_not_payment_proof(uuid, text) from public, anon, authenticated, service_role;

-- D2 Die Abfrage fuer den Client prueft die Mitgliedschaft schon selbst; ihre
--    Rechte stehen jetzt ausdruecklich hier.
revoke all on function public.is_workspace_document_payment_proof(uuid, text) from public, anon, service_role;
grant execute on function public.is_workspace_document_payment_proof(uuid, text) to authenticated;

/*
 * D3 Die vier Datenschutz-Helfer stecken in den Lese-Policies (als aufrufende
 * Rolle ausgewertet) und brauchen deshalb EXECUTE fuer authenticated. Sie
 * antworten einem angemeldeten Nichtmitglied jetzt immer mit false, ohne zu
 * suchen. Mitglieder, Policies, Pull-Funktionen, Speicher-Bruecken und der
 * Schreibschutz-Trigger (alle im Kontext eines Mitglieds) sowie interne
 * Aufrufe ohne Nutzer erhalten den bisherigen Wert. Woertlich aus
 * 20261104120000_workspace_employee_payments.sql.
 */
create or replace function public.workspace_document_is_restricted(
  p_workspace_id uuid,
  p_client_document_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- GO-LIVE-SECURITY-01: Fremde Betriebe erfahren nichts, auch nicht, ob es den
  -- Eintrag gibt. Mitglieder und interne Aufrufe ohne Nutzer wie bisher.
  select (auth.uid() is null or public.is_active_workspace_member(p_workspace_id))
    and coalesce(nullif(btrim(coalesce(p_client_document_id, '')), '') is not null and (
    p_client_document_id like 'emp-receipt-%'
    or exists (
      select 1 from public.workspace_restricted_documents r
      where r.workspace_id = p_workspace_id and r.client_document_id = p_client_document_id
    )
    or exists (
      select 1 from public.workspace_employee_payments p
      where p.workspace_id = p_workspace_id
        and (p.receipt_document_id = p_client_document_id or p.proof_document_id = p_client_document_id)
    )
    or exists (
      select 1 from public.workspace_documents d
      where d.workspace_id = p_workspace_id
        and d.client_document_id = p_client_document_id
        and d.document_kind = 'archived_document'
        and public.workspace_employee_payment_folder_path(d.payload)
    )
  ), false);
$$;

revoke all on function public.workspace_document_is_restricted(uuid, text) from public, anon, service_role;
grant execute on function public.workspace_document_is_restricted(uuid, text) to authenticated;

create or replace function public.workspace_file_is_restricted(
  p_workspace_id uuid,
  p_client_file_ref_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive herkunft(ref, tiefe) as (
    select nullif(btrim(coalesce(p_client_file_ref_id, '')), ''), 0
    union all
    select f.derived_from_client_file_ref_id, h.tiefe + 1
    from herkunft h
    join public.workspace_files f
      on f.workspace_id = p_workspace_id and f.client_file_ref_id = h.ref
    where f.derived_from_client_file_ref_id is not null
      and h.tiefe < 8
  )
  -- GO-LIVE-SECURITY-01: Fremde Betriebe erfahren nichts, auch nicht, ob es den
  -- Eintrag gibt. Mitglieder und interne Aufrufe ohne Nutzer wie bisher.
  select (auth.uid() is null or public.is_active_workspace_member(p_workspace_id)) and exists (
    select 1
    from herkunft h
    where h.ref is not null
      and (
        exists (
          select 1 from public.workspace_document_file_bindings b
          where b.workspace_id = p_workspace_id
            and b.client_file_ref_id = h.ref
            and public.workspace_document_is_restricted(p_workspace_id, b.client_document_id)
        )
        or exists (
          select 1 from public.workspace_inbox_items i
          where i.workspace_id = p_workspace_id
            and i.client_file_ref_id = h.ref
            and (
              public.workspace_document_is_restricted(p_workspace_id, i.archive_document_id)
              or public.workspace_employee_payment_folder_path(i.payload)
            )
        )
      )
  );
$$;

revoke all on function public.workspace_file_is_restricted(uuid, text) from public, anon, service_role;
grant execute on function public.workspace_file_is_restricted(uuid, text) to authenticated;

create or replace function public.workspace_inbox_item_is_restricted(
  p_workspace_id uuid,
  p_client_inbox_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- GO-LIVE-SECURITY-01: Fremde Betriebe erfahren nichts, auch nicht, ob es den
  -- Eintrag gibt. Mitglieder und interne Aufrufe ohne Nutzer wie bisher.
  select (auth.uid() is null or public.is_active_workspace_member(p_workspace_id)) and exists (
    select 1
    from public.workspace_inbox_items i
    where i.workspace_id = p_workspace_id
      and i.client_inbox_id = p_client_inbox_id
      and (
        public.workspace_document_is_restricted(p_workspace_id, i.archive_document_id)
        or public.workspace_employee_payment_folder_path(i.payload)
        or (i.client_file_ref_id is not null and public.workspace_file_is_restricted(p_workspace_id, i.client_file_ref_id))
      )
  );
$$;

revoke all on function public.workspace_inbox_item_is_restricted(uuid, text) from public, anon, service_role;
grant execute on function public.workspace_inbox_item_is_restricted(uuid, text) to authenticated;

create or replace function public.workspace_communication_context_is_restricted(
  p_workspace_id uuid,
  p_context_type text,
  p_context_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- GO-LIVE-SECURITY-01: Fremde Betriebe erfahren nichts, auch nicht, ob es den
  -- Eintrag gibt. Mitglieder und interne Aufrufe ohne Nutzer wie bisher.
  select (auth.uid() is null or public.is_active_workspace_member(p_workspace_id)) and case
    when p_context_type = 'document' then public.workspace_document_is_restricted(p_workspace_id, p_context_id)
    when p_context_type = 'inbox' then public.workspace_inbox_item_is_restricted(p_workspace_id, p_context_id)
    else false
  end;
$$;

revoke all on function public.workspace_communication_context_is_restricted(uuid, text, text) from public, anon, service_role;
grant execute on function public.workspace_communication_context_is_restricted(uuid, text, text) to authenticated;

/* ------------------------------------------------------------------------ */
/* E — Angebotsstatus: auf jedem Schreibweg geprüft                          */
/* ------------------------------------------------------------------------ */

/*
 * Befund: Der generische Schreibweg (upsert_workspace_sync_entity, Zweig
 * 'offer') prüfte nur workspace_user_can_intake. Ein Mitglied konnte damit ein
 * freigegebenes Angebot auf versendet, abgelehnt, storniert oder ersetzt setzen
 * und die Ablage zuordnen. Zweitens überspringt der Zweig bei einem gelöschten
 * Entwurf alle Statusprüfungen; einen Beleg ohne Nummer verhinderte dann nur die
 * Check-Constraint workspace_offers_number_status_check, mit technischer Meldung.
 * Drittens nimmt der Zweig Entwürfe mit Auftragsbezug oder Ablage an, und die
 * Freigabe übernimmt die Nutzlast ungeprüft: Beides konnte so in einen Beleg
 * gelangen.
 *
 * Der Wächter sitzt deshalb an der Tabelle und erfasst jeden Schreibweg. Er ändert
 * keine bestehende Funktion.
 *
 * Rollenregeln (Produktentscheidung vom 2026-10-09), für angemeldete Nutzer ohne
 * can_write_workspace:
 *   R1 Ein Beleg (Status ungleich entwurf) ist unveränderlich: kein Statuswechsel,
 *      keine Zustandsfelder (sentAt, decidedAt, archiveDocumentId, ...), kein
 *      Löschen. Eine inhaltsgleiche Wiederholung bleibt erlaubt.
 *   R2 Kein Weg aus dem Entwurf heraus und keine Neuanlage außer als Entwurf.
 *   Entwürfe anlegen, bearbeiten und löschen bleibt unverändert erlaubt.
 *
 * Fachregeln für jede Rolle und jeden Weg:
 *   F1 Ein Entwurf trägt weder Nummer noch Ablage noch Auftragsbezug.
 *   F2 Aus einem Entwurf wird ein Beleg nur durch die Freigabe: Status freigegeben
 *      mit Nummer und Fingerabdruck, ohne Ablage und ohne Auftragsbezug.
 *   F3 Neu angelegt wird nur ein Entwurf.
 *
 * Interne Aufrufe ohne Nutzer unterliegen nur den Fachregeln. Die Annahme
 * (accept_workspace_offer) und die Freigabe (finalize_workspace_offer) verlangen
 * selbst Inhaber oder Admin und erfüllen die Fachregeln.
 */
create or replace function public.workspace_offers_status_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.can_write_workspace(new.workspace_id) then
    -- R1
    if tg_op = 'UPDATE' and old.status <> 'entwurf' and (
         new.status is distinct from old.status
      or new.payload is distinct from old.payload
      or new.deleted is distinct from old.deleted
      or new.client_customer_id is distinct from old.client_customer_id
    ) then
      raise exception 'Keine Schreibberechtigung' using errcode = '42501';
    end if;
    -- R2
    if new.status <> 'entwurf' and (tg_op = 'INSERT' or old.status = 'entwurf') then
      raise exception 'Keine Schreibberechtigung' using errcode = '42501';
    end if;
  end if;

  -- F3
  if tg_op = 'INSERT' and new.status <> 'entwurf' then
    raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
  end if;

  -- F2
  if tg_op = 'UPDATE' and old.status = 'entwurf' and new.status <> 'entwurf' then
    if new.status <> 'freigegeben' or new.offer_number is null or new.content_fingerprint is null then
      raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(new.payload->>'archiveDocumentId', '')), '') is not null then
      raise exception 'Ein Entwurf hat keine Archivablage' using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(new.payload->>'resultingVorgangId', '')), '') is not null then
      raise exception 'Auftragsbezug eines Angebots nur ueber accept_workspace_offer' using errcode = 'P0001';
    end if;
  end if;

  -- F1
  if new.status = 'entwurf' and not new.deleted then
    if new.offer_number is not null or new.payload ? 'offerNumber' then
      raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(new.payload->>'archiveDocumentId', '')), '') is not null then
      raise exception 'Ein Entwurf hat keine Archivablage' using errcode = 'P0001';
    end if;
    if nullif(btrim(coalesce(new.payload->>'resultingVorgangId', '')), '') is not null then
      raise exception 'Auftragsbezug eines Angebots nur ueber accept_workspace_offer' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.workspace_offers_status_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_offers_status_guard on public.workspace_offers;
create trigger workspace_offers_status_guard
before insert or update on public.workspace_offers
for each row execute function public.workspace_offers_status_guard();

-- Der generische Schreibweg selbst bleibt unveraendert; seine Rechte stehen jetzt
-- ausdruecklich hier, deckungsgleich mit dem Remote-Stand (Client-Aufruf als
-- authenticated, keine Edge Function ruft ihn).
revoke all on function public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint) from public, anon, service_role;
grant execute on function public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint) to authenticated;

/* ------------------------------------------------------------------------ */
/* C — Postfach, OAuth und E-Mail-Versand: Rechte ausdruecklich              */
/* Deckungsgleich mit dem Remote-Stand; lokal und in neu angelegten Projekten */
/* entfallen damit die Standardrechte fuer anon und authenticated.            */
/* ------------------------------------------------------------------------ */
-- C1 — nur die Service-Rolle (Edge Functions: OAuth-Start/-Callback,
--      Postfach-Abruf, Auto-Sync, Versand). Keine Anmeldepruefung im Rumpf
--      noetig, weil kein Client sie erreicht.
revoke all on function public.advance_workspace_mailbox_cursor(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.advance_workspace_mailbox_cursor(uuid, uuid, jsonb) to service_role;
revoke all on function public.claim_workspace_email_message_for_send(uuid, bigint) from public, anon, authenticated;
grant execute on function public.claim_workspace_email_message_for_send(uuid, bigint) to service_role;
revoke all on function public.claim_workspace_mailbox_sync(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_workspace_mailbox_sync(uuid, integer) to service_role;
revoke all on function public.complete_workspace_mailbox_oauth(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_workspace_mailbox_oauth(uuid, text, text, text) to service_role;
revoke all on function public.consume_workspace_mailbox_oauth_state(text) from public, anon, authenticated;
grant execute on function public.consume_workspace_mailbox_oauth_state(text) to service_role;
revoke all on function public.create_workspace_mailbox_oauth_state(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone, integer) from public, anon, authenticated;
grant execute on function public.create_workspace_mailbox_oauth_state(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone, integer) to service_role;
revoke all on function public.email_inbound_resolve_assignment(uuid, text, text) from public, anon, authenticated;
grant execute on function public.email_inbound_resolve_assignment(uuid, text, text) to service_role;
revoke all on function public.email_message_to_jsonb(public.workspace_email_messages) from public, anon, authenticated;
grant execute on function public.email_message_to_jsonb(public.workspace_email_messages) to service_role;
revoke all on function public.email_resolve_thread(uuid, text, text[], uuid, text, text) from public, anon, authenticated;
grant execute on function public.email_resolve_thread(uuid, text, text[], uuid, text, text) to service_role;
revoke all on function public.fail_workspace_mailbox_oauth(uuid) from public, anon, authenticated;
grant execute on function public.fail_workspace_mailbox_oauth(uuid) to service_role;
revoke all on function public.finish_workspace_mailbox_sync(uuid, uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.finish_workspace_mailbox_sync(uuid, uuid, text, text, text, text, integer) to service_role;
revoke all on function public.get_workspace_email_message_for_send(uuid, text) from public, anon, authenticated;
grant execute on function public.get_workspace_email_message_for_send(uuid, text) to service_role;
revoke all on function public.get_workspace_mailbox_credential(uuid) from public, anon, authenticated;
grant execute on function public.get_workspace_mailbox_credential(uuid) to service_role;
revoke all on function public.import_workspace_inbound_email(uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_workspace_inbound_email(uuid, uuid, jsonb, jsonb, jsonb) to service_role;
revoke all on function public.list_workspace_mailbox_auto_sync_candidates(integer) from public, anon, authenticated;
grant execute on function public.list_workspace_mailbox_auto_sync_candidates(integer) to service_role;
revoke all on function public.mailbox_auto_sync_secret_valid(text) from public, anon, authenticated;
grant execute on function public.mailbox_auto_sync_secret_valid(text) to service_role;
revoke all on function public.mailbox_connection_belongs_to_workspace(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mailbox_connection_belongs_to_workspace(uuid, uuid) to service_role;
revoke all on function public.purge_expired_workspace_mailbox_oauth_states(interval) from public, anon, authenticated;
grant execute on function public.purge_expired_workspace_mailbox_oauth_states(interval) to service_role;
revoke all on function public.record_email_provider_event(text, text, text, text, text, text, timestamp with time zone) from public, anon, authenticated;
grant execute on function public.record_email_provider_event(text, text, text, text, text, text, timestamp with time zone) to service_role;
revoke all on function public.record_workspace_inbound_import_failure(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_workspace_inbound_import_failure(uuid, uuid, text, text) to service_role;
revoke all on function public.resolve_stale_workspace_email_message_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.resolve_stale_workspace_email_message_claim(uuid, integer) to service_role;
revoke all on function public.rotate_workspace_mailbox_credential(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rotate_workspace_mailbox_credential(uuid, uuid, text) to service_role;
revoke all on function public.set_workspace_mailbox_credential(uuid, text) from public, anon, authenticated;
grant execute on function public.set_workspace_mailbox_credential(uuid, text) to service_role;
revoke all on function public.set_workspace_mailbox_source_id(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_workspace_mailbox_source_id(uuid, uuid, text) to service_role;
revoke all on function public.update_workspace_email_message_status(uuid, text, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.update_workspace_email_message_status(uuid, text, text, text, text, text, bigint) to service_role;
revoke all on function public.workspace_user_can_write(uuid, uuid) from public, anon, authenticated;
grant execute on function public.workspace_user_can_write(uuid, uuid) to service_role;

-- C2 — nur intern (Aufruf aus anderen Security-Definer-Funktionen oder
--      pg_cron als postgres): niemand sonst.
revoke all on function public.email_message_assert_rate_limit(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.email_provider_apply_event(uuid) from public, anon, authenticated, service_role;
revoke all on function public.email_provider_rematch_after_accept() from public, anon, authenticated, service_role;
revoke all on function public.mailbox_auto_sync_dispatch() from public, anon, authenticated, service_role;
revoke all on function public.mailbox_delete_vault_secret(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mailbox_source_name_allowed(text, text) from public, anon, authenticated, service_role;
revoke all on function public.mailbox_upsert_delegated_connection(public.workspace_mailbox_oauth_states, text, text, text, uuid) from public, anon, authenticated, service_role;

-- C3 — Client-RPCs: angemeldete Nutzer; Rolle und Mitgliedschaft prueft
--      jede Funktion selbst (unveraendert).
revoke all on function public.assign_workspace_inbound_email_message(uuid, uuid, text, text, bigint) from public, anon, service_role;
grant execute on function public.assign_workspace_inbound_email_message(uuid, uuid, text, text, bigint) to authenticated;
revoke all on function public.cancel_workspace_mailbox_oauth_pending(uuid, uuid) from public, anon, service_role;
grant execute on function public.cancel_workspace_mailbox_oauth_pending(uuid, uuid) to authenticated;
revoke all on function public.confirm_workspace_mailbox_oauth_pending(uuid, uuid) from public, anon, service_role;
grant execute on function public.confirm_workspace_mailbox_oauth_pending(uuid, uuid) to authenticated;
revoke all on function public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text, uuid) from public, anon, service_role;
grant execute on function public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text, uuid) to authenticated;
revoke all on function public.disconnect_workspace_mailbox_connection(uuid, uuid) from public, anon, service_role;
grant execute on function public.disconnect_workspace_mailbox_connection(uuid, uuid) to authenticated;
revoke all on function public.email_attachment_can_read(text) from public, anon, service_role;
grant execute on function public.email_attachment_can_read(text) to authenticated;
revoke all on function public.email_attachment_can_write(text) from public, anon, service_role;
grant execute on function public.email_attachment_can_write(text) to authenticated;
revoke all on function public.get_workspace_email_message_chain(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_workspace_email_message_chain(uuid, uuid) to authenticated;
revoke all on function public.get_workspace_email_thread(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_workspace_email_thread(uuid, uuid) to authenticated;
revoke all on function public.get_workspace_inbound_email_message(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_workspace_inbound_email_message(uuid, uuid) to authenticated;
revoke all on function public.get_workspace_mailbox_oauth_pending(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_workspace_mailbox_oauth_pending(uuid, uuid) to authenticated;
revoke all on function public.list_workspace_email_delivery_events(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.list_workspace_email_delivery_events(uuid, uuid, uuid) to authenticated;
revoke all on function public.list_workspace_email_messages(uuid, text, text, integer) from public, anon, service_role;
grant execute on function public.list_workspace_email_messages(uuid, text, text, integer) to authenticated;
revoke all on function public.list_workspace_inbound_email_messages(uuid, text, text, boolean, integer) from public, anon, service_role;
grant execute on function public.list_workspace_inbound_email_messages(uuid, text, text, boolean, integer) to authenticated;
revoke all on function public.list_workspace_mailbox_connections(uuid) from public, anon, service_role;
grant execute on function public.list_workspace_mailbox_connections(uuid) to authenticated;
revoke all on function public.retry_workspace_email_message(uuid, text, uuid, boolean) from public, anon, service_role;
grant execute on function public.retry_workspace_email_message(uuid, text, uuid, boolean) to authenticated;
