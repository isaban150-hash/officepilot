-- FINANZ-CORE-DURABILITY-01B — Cloud Document Durability + Inbox Sync
--
-- Vier Wahrheiten, vier Orte — nichts davon doppelt:
--
--   Originaldatei          -> storage bucket `workspace-files` + public.workspace_files
--   Datei <-> Dokument     -> public.workspace_document_file_bindings (Rolle lebt NUR hier)
--   Eingang                -> public.workspace_inbox_items
--   KI-Analyse / Nutzer-   -> public.workspace_document_work_results (analysis != overlay)
--     bestaetigung
--   archivierte Fremd-     -> public.workspace_documents, document_kind = 'archived_document'
--     dokumente               (bestehende Tabelle, additiv; generated_invoice bleibt unangetastet)
--
-- Storage-Key ist inhaltsadressiert: {workspace_id}/{sha256} — ohne Dateiendung.
-- Gleiche Bytes im selben Workspace = genau ein Objekt. Kein Dedupe ueber
-- Workspaces hinweg (Isolation). MIME und Originalname sind Metadaten der Zeile.
--
-- Rollen:
--   owner/admin  = can_write_workspace (unveraendert)  -> voller Intake-/Archivzugriff
--   member       = workspace_user_can_intake           -> eigene Uploads/Eingaenge/Ergebnisse
--                  (nur Zeilen mit created_by = auth.uid()); kein Tombstone, kein Archivzugriff
--
-- Loeschen: Tombstones (deleted/deleted_at). Blobs werden nie vom Client
-- geloescht oder ueberschrieben (upsert:false, keine update/delete-Policy).
-- Serverseitiger Blob-Cleanup ist NICHT Teil dieses Blocks.

-- ---------------------------------------------------------------------------
-- 0. Rollenfunktion fuer Intake (member eingeschlossen) — keine Rollenengine
-- ---------------------------------------------------------------------------

create or replace function public.workspace_user_can_intake(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_workspace_member(p_workspace_id);
$$;

revoke all on function public.workspace_user_can_intake(uuid) from public;
grant execute on function public.workspace_user_can_intake(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Technische Datei-Wahrheit
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_file_ref_id text not null,
  content_sha256 text not null,
  size_bytes bigint not null,
  mime_type text not null,
  original_file_name text not null default '',
  storage_path text not null,
  derived_from_client_file_ref_id text null,
  uploaded_by uuid null references auth.users (id) on delete set null,
  created_by uuid null references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  row_version bigint not null default 1,
  constraint workspace_files_client_id_unique unique (workspace_id, client_file_ref_id),
  constraint workspace_files_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint workspace_files_size_check check (size_bytes >= 0),
  -- Der Pfad ist eine Funktion von Workspace und Hash — nichts anderes.
  constraint workspace_files_storage_path_check check (storage_path = workspace_id::text || '/' || content_sha256)
);

create index if not exists workspace_files_workspace_hash_idx
  on public.workspace_files (workspace_id, content_sha256);
create index if not exists workspace_files_updated_idx
  on public.workspace_files (workspace_id, updated_at desc);

drop trigger if exists workspace_files_set_updated_at on public.workspace_files;
create trigger workspace_files_set_updated_at
before update on public.workspace_files
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_files enable row level security;

drop policy if exists workspace_files_select on public.workspace_files;
create policy workspace_files_select
on public.workspace_files for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (public.workspace_user_can_intake(workspace_id) and created_by = auth.uid())
);

revoke all on public.workspace_files from public, anon;
revoke all on public.workspace_files from authenticated;
grant select on public.workspace_files to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Datei <-> Dokument (Cloud-Spiegel von DocumentFileRepresentationBinding)
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_document_file_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_document_id text not null,
  client_file_ref_id text not null,
  binding_kind text not null,
  part text null,
  provenance text not null default 'received',
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  row_version bigint not null default 1,
  constraint workspace_document_file_bindings_kind_check
    check (binding_kind in ('original', 'archive', 'preview', 'thumbnail', 'structured')),
  constraint workspace_document_file_bindings_provenance_check
    check (provenance in ('received', 'extracted', 'derived')),
  -- Extrahiertes (z. B. ZUGFeRD-XML) ist nie ein empfangenes Original.
  constraint workspace_document_file_bindings_extracted_check
    check (not (binding_kind = 'original' and provenance = 'extracted'))
);

-- Ein Binding je (Dokument, Rolle, Teil) — dieselbe Datei darf mehrere Rollen tragen
-- (source_reuse) und mehrere Dokumente duerfen dieselbe Datei referenzieren.
create unique index if not exists workspace_document_file_bindings_natural_unique
  on public.workspace_document_file_bindings (workspace_id, client_document_id, binding_kind, coalesce(part, ''));
create index if not exists workspace_document_file_bindings_file_idx
  on public.workspace_document_file_bindings (workspace_id, client_file_ref_id);

drop trigger if exists workspace_document_file_bindings_set_updated_at on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_set_updated_at
before update on public.workspace_document_file_bindings
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_document_file_bindings enable row level security;

drop policy if exists workspace_document_file_bindings_select on public.workspace_document_file_bindings;
create policy workspace_document_file_bindings_select
on public.workspace_document_file_bindings for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (public.workspace_user_can_intake(workspace_id) and created_by = auth.uid())
);

revoke all on public.workspace_document_file_bindings from public, anon;
revoke all on public.workspace_document_file_bindings from authenticated;
grant select on public.workspace_document_file_bindings to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Eingang (CORE)
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_inbox_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_inbox_id text not null,
  status text not null default 'neu',
  vorgang_link_status text not null default 'none',
  client_file_ref_id text null,
  archive_document_id text null,
  vorgang_id text null,
  expense_id text null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  row_version bigint not null default 1,
  constraint workspace_inbox_items_client_id_unique unique (workspace_id, client_inbox_id),
  constraint workspace_inbox_items_status_check
    check (status in ('neu', 'geprueft', 'abgelegt', 'spaeter_klaeren')),
  constraint workspace_inbox_items_link_status_check
    check (vorgang_link_status in ('none', 'linked', 'created'))
);

create index if not exists workspace_inbox_items_workspace_status_idx
  on public.workspace_inbox_items (workspace_id, status);
create index if not exists workspace_inbox_items_updated_idx
  on public.workspace_inbox_items (workspace_id, updated_at desc);

drop trigger if exists workspace_inbox_items_set_updated_at on public.workspace_inbox_items;
create trigger workspace_inbox_items_set_updated_at
before update on public.workspace_inbox_items
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_inbox_items enable row level security;

drop policy if exists workspace_inbox_items_select on public.workspace_inbox_items;
create policy workspace_inbox_items_select
on public.workspace_inbox_items for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (public.workspace_user_can_intake(workspace_id) and created_by = auth.uid())
);

revoke all on public.workspace_inbox_items from public, anon;
revoke all on public.workspace_inbox_items from authenticated;
grant select on public.workspace_inbox_items to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Analyse (rekonstruierbar) getrennt von Nutzer-Overlay (nicht rekonstruierbar)
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_document_work_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_inbox_id text not null,
  source_fingerprint text not null default '',
  analysis_version text not null default '',
  analyzed_at timestamptz null,
  analysis jsonb not null default '{}'::jsonb,
  overlay jsonb not null default '[]'::jsonb,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  row_version bigint not null default 1,
  constraint workspace_document_work_results_client_id_unique unique (workspace_id, client_inbox_id)
);

create index if not exists workspace_document_work_results_updated_idx
  on public.workspace_document_work_results (workspace_id, updated_at desc);

drop trigger if exists workspace_document_work_results_set_updated_at on public.workspace_document_work_results;
create trigger workspace_document_work_results_set_updated_at
before update on public.workspace_document_work_results
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_document_work_results enable row level security;

drop policy if exists workspace_document_work_results_select on public.workspace_document_work_results;
create policy workspace_document_work_results_select
on public.workspace_document_work_results for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (public.workspace_user_can_intake(workspace_id) and created_by = auth.uid())
);

revoke all on public.workspace_document_work_results from public, anon;
revoke all on public.workspace_document_work_results from authenticated;
grant select on public.workspace_document_work_results to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Archivierte Fremddokumente: bestehende Tabelle additiv erweitern
--    (generated_invoice-Semantik, Guards und partieller Unique-Index bleiben)
-- ---------------------------------------------------------------------------

alter table public.workspace_documents
  drop constraint if exists workspace_documents_kind_check;
alter table public.workspace_documents
  add constraint workspace_documents_kind_check
  -- 01D2: 'generated_invoice_correction' (Storno-Korrekturbeleg, Migration 20260913) bleibt zulaessig.
  check (document_kind in ('generated_invoice', 'generated_invoice_correction', 'archived_document'));

alter table public.workspace_documents
  add column if not exists deleted boolean not null default false;

-- Mitglieder lesen Rechnungsdokumente wie bisher; archivierte Fremddokumente
-- nur owner/admin oder der eigene Uploader.
drop policy if exists workspace_documents_select_member on public.workspace_documents;
create policy workspace_documents_select_member
on public.workspace_documents for select to authenticated
using (
  public.is_active_workspace_member(workspace_id)
  and (
    document_kind <> 'archived_document'
    or public.can_write_workspace(workspace_id)
    or created_by = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- 6. Privater Bucket: Objekt = {workspace_id}/{sha256}
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('workspace-files', 'workspace-files', false, 26214400)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

-- Lesen nur, wenn eine fuer den Nutzer lesbare workspace_files-Zeile auf den Pfad zeigt.
create or replace function public.workspace_file_object_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_files f
    where f.storage_path = p_name
      and f.deleted = false
      and (
        public.can_write_workspace(f.workspace_id)
        or (public.workspace_user_can_intake(f.workspace_id) and f.created_by = auth.uid())
      )
  );
$$;

-- Schreiben nur in den eigenen Workspace-Ordner, Name = <uuid>/<sha256>.
create or replace function public.workspace_file_object_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when length(p_name) = 101 and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}'
      then public.workspace_user_can_intake(split_part(p_name, '/', 1)::uuid)
    else false
  end;
$$;

revoke all on function public.workspace_file_object_can_read(text) from public;
revoke all on function public.workspace_file_object_can_write(text) from public;
grant execute on function public.workspace_file_object_can_read(text) to authenticated;
grant execute on function public.workspace_file_object_can_write(text) to authenticated;

drop policy if exists workspace_files_objects_select on storage.objects;
create policy workspace_files_objects_select
on storage.objects for select to authenticated
using (bucket_id = 'workspace-files' and public.workspace_file_object_can_read(name));

drop policy if exists workspace_files_objects_insert on storage.objects;
create policy workspace_files_objects_insert
on storage.objects for insert to authenticated
with check (bucket_id = 'workspace-files' and public.workspace_file_object_can_write(name));

-- Keine update-/delete-Policy: kein Client-Overwrite, kein Client-Delete.

-- ---------------------------------------------------------------------------
-- 7. Ein Intake-RPC fuer alle fuenf Entitaeten (Muster upsert_workspace_sync_entity)
--
-- Versionsregel: fehlt die Zeile, wird eingefuegt (es gibt nichts zu
-- ueberschreiben — lokale Entitaeten tragen bereits eine lokale Sync-Version);
-- existiert sie, muss p_row_version exakt passen. Ein Replay mit veralteter
-- Version bleibt damit ein Versionskonflikt, nie ein stilles Ueberschreiben.
-- ---------------------------------------------------------------------------

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
        nullif(trim(coalesce(p_payload->>'expense_id', '')), ''),
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
          expense_id = case when v_deleted then expense_id else nullif(trim(coalesce(p_payload->>'expense_id', '')), '') end,
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

revoke all on function public.upsert_workspace_intake_entity(uuid, text, jsonb, bigint) from public, anon;
grant execute on function public.upsert_workspace_intake_entity(uuid, text, jsonb, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Pull: alles, was der Nutzer lesen darf (owner/admin alles; member Eigenes)
-- ---------------------------------------------------------------------------

create or replace function public.pull_workspace_intake_state(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_all boolean;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  v_all := public.can_write_workspace(p_workspace_id);

  return jsonb_build_object(
    'files', coalesce((
      select jsonb_agg(to_jsonb(f)) from public.workspace_files f
      where f.workspace_id = p_workspace_id and (v_all or f.created_by = v_user_id)
    ), '[]'::jsonb),
    'bindings', coalesce((
      select jsonb_agg(to_jsonb(b)) from public.workspace_document_file_bindings b
      where b.workspace_id = p_workspace_id and (v_all or b.created_by = v_user_id)
    ), '[]'::jsonb),
    'inbox_items', coalesce((
      select jsonb_agg(to_jsonb(i)) from public.workspace_inbox_items i
      where i.workspace_id = p_workspace_id and (v_all or i.created_by = v_user_id)
    ), '[]'::jsonb),
    'work_results', coalesce((
      select jsonb_agg(to_jsonb(w)) from public.workspace_document_work_results w
      where w.workspace_id = p_workspace_id and (v_all or w.created_by = v_user_id)
    ), '[]'::jsonb),
    'archived_documents', coalesce((
      select jsonb_agg(to_jsonb(d)) from public.workspace_documents d
      where d.workspace_id = p_workspace_id and d.document_kind = 'archived_document'
        and (v_all or d.created_by = v_user_id)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.pull_workspace_intake_state(uuid) from public, anon;
grant execute on function public.pull_workspace_intake_state(uuid) to authenticated;
