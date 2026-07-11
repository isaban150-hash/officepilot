-- CLOUD-DATA-02: Workspace-Vorgänge (Aufträge) cloud-syncable

create table if not exists public.workspace_vorgaenge (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  vorgang_id text not null,
  payload jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  primary key (workspace_id, vorgang_id)
);

create index if not exists workspace_vorgaenge_workspace_id_idx
  on public.workspace_vorgaenge (workspace_id);

create index if not exists workspace_vorgaenge_workspace_active_idx
  on public.workspace_vorgaenge (workspace_id)
  where deleted = false;

drop trigger if exists workspace_vorgaenge_set_updated_at on public.workspace_vorgaenge;
create trigger workspace_vorgaenge_set_updated_at
before update on public.workspace_vorgaenge
for each row
execute function public.set_workspace_updated_at();

-- Extend pull to include vorgaenge
create or replace function public.pull_workspace_sync_state(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.workspace_settings;
  v_setup public.workspace_setup;
  v_profile public.workspace_company_profiles;
  v_workspace public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  select * into v_workspace from public.workspaces w where w.id = p_workspace_id;
  select * into v_settings from public.workspace_settings ws where ws.workspace_id = p_workspace_id;
  select * into v_setup from public.workspace_setup s where s.workspace_id = p_workspace_id;
  select * into v_profile from public.workspace_company_profiles cp where cp.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'members', coalesce(
      (select jsonb_agg(to_jsonb(wm)) from public.workspace_members wm where wm.workspace_id = p_workspace_id and wm.status = 'active'),
      '[]'::jsonb
    ),
    'settings', to_jsonb(v_settings),
    'setup', to_jsonb(v_setup),
    'company_profile', to_jsonb(v_profile),
    'vorgaenge', coalesce(
      (select jsonb_agg(to_jsonb(v)) from public.workspace_vorgaenge v where v.workspace_id = p_workspace_id),
      '[]'::jsonb
    )
  );
end;
$$;

-- Extend upsert for vorgang entity type
create or replace function public.upsert_workspace_sync_entity(
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
  v_current_version bigint;
  v_result jsonb;
  v_vorgang_id text;
  v_deleted boolean;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if p_entity_type = 'vorgang' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_vorgang_id := coalesce(nullif(trim(p_payload->>'vorgang_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_vorgang_id is null then
      raise exception 'vorgang_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    select v.row_version into v_current_version
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id
    for update;

    if v_current_version is null then
      insert into public.workspace_vorgaenge (
        workspace_id,
        vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_vorgang_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_vorgaenge
      set
        payload = case when v_deleted then payload else coalesce(p_payload->'payload', p_payload, payload) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and vorgang_id = v_vorgang_id
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_vorgang_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'workspace' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select w.version into v_current_version from public.workspaces w where w.id = p_workspace_id for update;
    if v_current_version is null then
      raise exception 'Workspace nicht gefunden';
    end if;
    if p_row_version > 0 and p_row_version <> v_current_version then
      raise exception 'Versionskonflikt workspace:%', v_current_version using errcode = 'P0001';
    end if;

    update public.workspaces
    set
      name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
      version = version + 1
    where id = p_workspace_id
    returning to_jsonb(public.workspaces.*) into v_result;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'workspace_settings' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select ws.version into v_current_version from public.workspace_settings ws where ws.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_settings (workspace_id, settings, version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'settings', '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_settings.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt workspace_settings:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_settings
      set
        settings = coalesce(p_payload->'settings', settings),
        version = version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_settings.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_setup' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select s.row_version into v_current_version from public.workspace_setup s where s.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_setup (workspace_id, payload, setup_version, row_version, updated_by)
      values (
        p_workspace_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        coalesce((p_payload->>'setup_version')::integer, 1),
        1,
        auth.uid()
      )
      returning to_jsonb(public.workspace_setup.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_setup:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_setup
      set
        payload = coalesce(p_payload->'payload', p_payload, payload),
        setup_version = coalesce((p_payload->>'setup_version')::integer, setup_version),
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_setup.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_profile' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select cp.row_version into v_current_version from public.workspace_company_profiles cp where cp.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'payload', p_payload, '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_profile:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_company_profiles
      set
        payload = coalesce(p_payload->'payload', p_payload, payload),
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  else
    raise exception 'Unbekannter Entity-Typ: %', p_entity_type;
  end if;
end;
$$;

alter table public.workspace_vorgaenge enable row level security;

drop policy if exists workspace_vorgaenge_select_member on public.workspace_vorgaenge;
create policy workspace_vorgaenge_select_member
on public.workspace_vorgaenge for select to authenticated
using (public.is_active_workspace_member(workspace_id));

revoke all on public.workspace_vorgaenge from public, anon;
grant select on public.workspace_vorgaenge to authenticated;
