-- CLOUD-DATA-01: Workspace, Settings, Setup, Company Profile (cloud-syncable only)

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1
);

create index if not exists workspaces_owner_user_id_idx on public.workspaces (owner_user_id);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_members_role_check check (role in ('owner', 'admin', 'member')),
  constraint workspace_members_status_check check (status in ('active', 'invited', 'removed'))
);

create index if not exists workspace_members_user_id_idx on public.workspace_members (user_id);

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null
);

create table if not exists public.workspace_setup (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  setup_version integer not null default 1,
  row_version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null
);

create table if not exists public.workspace_company_profiles (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null
);

-- updated_at triggers
create or replace function public.set_workspace_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
before update on public.workspaces
for each row
execute function public.set_workspace_updated_at();

drop trigger if exists workspace_members_set_updated_at on public.workspace_members;
create trigger workspace_members_set_updated_at
before update on public.workspace_members
for each row
execute function public.set_workspace_updated_at();

drop trigger if exists workspace_settings_set_updated_at on public.workspace_settings;
create trigger workspace_settings_set_updated_at
before update on public.workspace_settings
for each row
execute function public.set_workspace_updated_at();

drop trigger if exists workspace_setup_set_updated_at on public.workspace_setup;
create trigger workspace_setup_set_updated_at
before update on public.workspace_setup
for each row
execute function public.set_workspace_updated_at();

drop trigger if exists workspace_company_profiles_set_updated_at on public.workspace_company_profiles;
create trigger workspace_company_profiles_set_updated_at
before update on public.workspace_company_profiles
for each row
execute function public.set_workspace_updated_at();

-- Membership helpers (security definer)
create or replace function public.is_active_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.status = 'active'
  );
$$;

create or replace function public.workspace_member_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = auth.uid()
    and wm.status = 'active'
  limit 1;
$$;

create or replace function public.can_write_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.workspace_member_role(p_workspace_id) in ('owner', 'admin'), false);
$$;

-- Provision personal workspace for authenticated user
create or replace function public.ensure_personal_workspace(p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  select wm.*
  into v_member
  from public.workspace_members wm
  where wm.user_id = v_user_id
    and wm.status = 'active'
    and wm.role = 'owner'
  order by wm.created_at asc
  limit 1;

  if found then
    select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;
    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'created', false
    );
  end if;

  v_name := coalesce(nullif(trim(p_name), ''), 'Mein Workspace');

  insert into public.workspaces (name, owner_user_id)
  values (v_name, v_user_id)
  returning * into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values (v_workspace.id, v_user_id, 'owner', 'active')
  returning * into v_member;

  insert into public.workspace_settings (workspace_id, settings)
  values (v_workspace.id, '{}'::jsonb)
  on conflict (workspace_id) do nothing;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member),
    'created', true
  );
end;
$$;

create or replace function public.get_active_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_member public.workspace_members;
  v_workspace public.workspaces;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  select wm.*
  into v_member
  from public.workspace_members wm
  where wm.user_id = v_user_id
    and wm.status = 'active'
  order by case when wm.role = 'owner' then 0 when wm.role = 'admin' then 1 else 2 end,
           wm.created_at asc
  limit 1;

  if not found then
    return null;
  end if;

  select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member)
  );
end;
$$;

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
    'company_profile', to_jsonb(v_profile)
  );
end;
$$;

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
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if p_entity_type = 'workspace' then
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

-- RLS
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.workspace_setup enable row level security;
alter table public.workspace_company_profiles enable row level security;

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
on public.workspaces for select to authenticated
using (public.is_active_workspace_member(id));

drop policy if exists workspace_members_select_member on public.workspace_members;
create policy workspace_members_select_member
on public.workspace_members for select to authenticated
using (public.is_active_workspace_member(workspace_id));

drop policy if exists workspace_settings_select_member on public.workspace_settings;
create policy workspace_settings_select_member
on public.workspace_settings for select to authenticated
using (public.is_active_workspace_member(workspace_id));

drop policy if exists workspace_setup_select_member on public.workspace_setup;
create policy workspace_setup_select_member
on public.workspace_setup for select to authenticated
using (public.is_active_workspace_member(workspace_id));

drop policy if exists workspace_company_profiles_select_member on public.workspace_company_profiles;
create policy workspace_company_profiles_select_member
on public.workspace_company_profiles for select to authenticated
using (public.is_active_workspace_member(workspace_id));

-- Direct writes revoked – use RPCs
revoke all on public.workspaces from public, anon;
revoke all on public.workspace_members from public, anon;
revoke all on public.workspace_settings from public, anon;
revoke all on public.workspace_setup from public, anon;
revoke all on public.workspace_company_profiles from public, anon;

grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant select on public.workspace_settings to authenticated;
grant select on public.workspace_setup to authenticated;
grant select on public.workspace_company_profiles to authenticated;

revoke all on function public.is_active_workspace_member(uuid) from public;
revoke all on function public.workspace_member_role(uuid) from public;
revoke all on function public.can_write_workspace(uuid) from public;
revoke all on function public.ensure_personal_workspace(text) from public;
revoke all on function public.get_active_workspace() from public;
revoke all on function public.pull_workspace_sync_state(uuid) from public;
revoke all on function public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint) from public;

grant execute on function public.ensure_personal_workspace(text) to authenticated;
grant execute on function public.get_active_workspace() to authenticated;
grant execute on function public.pull_workspace_sync_state(uuid) to authenticated;
grant execute on function public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint) to authenticated;
