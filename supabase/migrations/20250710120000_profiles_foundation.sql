-- SUPABASE-AUTH-03: profiles, RLS, admin RPCs, triggers, backfill

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  company_name text not null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text null,
  industry text null,
  status text not null default 'pending',
  role text not null default 'user',
  license_status text not null default 'inactive',
  license_expires_at timestamptz null,
  accepted_terms_version text null,
  accepted_privacy_version text null,
  accepted_license_version text null,
  legal_accepted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_status_check check (status in ('pending', 'approved', 'blocked')),
  constraint profiles_role_check check (role in ('user', 'admin')),
  constraint profiles_license_status_check check (license_status in ('inactive', 'active', 'expired')),
  constraint profiles_email_unique unique (email)
);

create index if not exists profiles_status_idx on public.profiles (status);
create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_license_status_idx on public.profiles (license_status);

create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_profiles_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  legal_at timestamptz;
begin
  legal_at := nullif(coalesce(meta->>'legalAcceptedAt', meta->>'legal_accepted_at', ''), '')::timestamptz;

  insert into public.profiles (
    id,
    company_name,
    first_name,
    last_name,
    email,
    phone,
    industry,
    accepted_terms_version,
    accepted_privacy_version,
    accepted_license_version,
    legal_accepted_at
  )
  values (
    new.id,
    coalesce(nullif(meta->>'companyName', ''), nullif(meta->>'company_name', ''), 'Unbekannt'),
    coalesce(nullif(meta->>'firstName', ''), nullif(meta->>'first_name', ''), 'Unbekannt'),
    coalesce(nullif(meta->>'lastName', ''), nullif(meta->>'last_name', ''), 'Unbekannt'),
    coalesce(new.email, ''),
    nullif(coalesce(meta->>'phone', ''), ''),
    nullif(coalesce(meta->>'industry', ''), ''),
    coalesce(nullif(meta->>'acceptedTermsVersion', ''), nullif(meta->>'accepted_terms_version', '')),
    coalesce(nullif(meta->>'acceptedPrivacyVersion', ''), nullif(meta->>'accepted_privacy_version', '')),
    coalesce(nullif(meta->>'acceptedLicenseVersion', ''), nullif(meta->>'accepted_license_version', '')),
    legal_at
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

insert into public.profiles (
  id,
  company_name,
  first_name,
  last_name,
  email,
  phone,
  industry,
  status,
  role,
  license_status,
  license_expires_at,
  accepted_terms_version,
  accepted_privacy_version,
  accepted_license_version,
  legal_accepted_at,
  created_at,
  updated_at
)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data->>'companyName', ''), nullif(u.raw_user_meta_data->>'company_name', ''), 'Unbekannt'),
  coalesce(nullif(u.raw_user_meta_data->>'firstName', ''), nullif(u.raw_user_meta_data->>'first_name', ''), 'Unbekannt'),
  coalesce(nullif(u.raw_user_meta_data->>'lastName', ''), nullif(u.raw_user_meta_data->>'last_name', ''), 'Unbekannt'),
  coalesce(u.email, ''),
  nullif(coalesce(u.raw_user_meta_data->>'phone', ''), ''),
  nullif(coalesce(u.raw_user_meta_data->>'industry', ''), ''),
  'pending',
  'user',
  'inactive',
  null,
  coalesce(nullif(u.raw_user_meta_data->>'acceptedTermsVersion', ''), u.raw_user_meta_data->>'accepted_terms_version'),
  coalesce(nullif(u.raw_user_meta_data->>'acceptedPrivacyVersion', ''), u.raw_user_meta_data->>'accepted_privacy_version'),
  coalesce(nullif(u.raw_user_meta_data->>'acceptedLicenseVersion', ''), u.raw_user_meta_data->>'accepted_license_version'),
  nullif(coalesce(u.raw_user_meta_data->>'legalAcceptedAt', u.raw_user_meta_data->>'legal_accepted_at', ''), '')::timestamptz,
  coalesce(u.created_at, now()),
  coalesce(u.updated_at, now())
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
to authenticated
using (auth.uid() = id);

revoke all on public.profiles from public;
grant select on public.profiles to authenticated;

create or replace function public.assert_is_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  ) then
    raise exception 'Keine Admin-Berechtigung';
  end if;
end;
$$;

create or replace function public.update_own_profile(
  p_company_name text,
  p_first_name text,
  p_last_name text,
  p_phone text default null,
  p_industry text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  update public.profiles
  set
    company_name = coalesce(nullif(trim(p_company_name), ''), company_name),
    first_name = coalesce(nullif(trim(p_first_name), ''), first_name),
    last_name = coalesce(nullif(trim(p_last_name), ''), last_name),
    phone = nullif(trim(coalesce(p_phone, '')), ''),
    industry = nullif(trim(coalesce(p_industry, '')), '')
  where id = auth.uid()
  returning * into updated;

  if updated.id is null then
    raise exception 'Profil nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_list_profiles()
returns setof public.profiles
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_is_admin();
  return query
  select *
  from public.profiles
  order by created_at desc;
end;
$$;

create or replace function public.admin_approve_user(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set status = 'approved'
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_block_user(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set status = 'blocked'
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_activate_license(
  p_user_id uuid,
  p_expires_at timestamptz default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set
    license_status = 'active',
    license_expires_at = p_expires_at
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_deactivate_license(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set license_status = 'inactive'
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_set_license_expiry(
  p_user_id uuid,
  p_expires_at timestamptz
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set license_expires_at = p_expires_at
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_clear_license_expiry(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set license_expires_at = null
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

create or replace function public.admin_expire_license(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated public.profiles;
begin
  perform public.assert_is_admin();

  update public.profiles
  set
    license_status = 'expired',
    license_expires_at = coalesce(license_expires_at, now())
  where id = p_user_id
  returning * into updated;

  if updated.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;

  return updated;
end;
$$;

revoke all on function public.assert_is_admin() from public;
revoke all on function public.update_own_profile(text, text, text, text, text) from public;
revoke all on function public.admin_list_profiles() from public;
revoke all on function public.admin_approve_user(uuid) from public;
revoke all on function public.admin_block_user(uuid) from public;
revoke all on function public.admin_activate_license(uuid, timestamptz) from public;
revoke all on function public.admin_deactivate_license(uuid) from public;
revoke all on function public.admin_set_license_expiry(uuid, timestamptz) from public;
revoke all on function public.admin_clear_license_expiry(uuid) from public;
revoke all on function public.admin_expire_license(uuid) from public;

grant execute on function public.update_own_profile(text, text, text, text, text) to authenticated;
grant execute on function public.admin_list_profiles() to authenticated;
grant execute on function public.admin_approve_user(uuid) to authenticated;
grant execute on function public.admin_block_user(uuid) to authenticated;
grant execute on function public.admin_activate_license(uuid, timestamptz) to authenticated;
grant execute on function public.admin_deactivate_license(uuid) to authenticated;
grant execute on function public.admin_set_license_expiry(uuid, timestamptz) to authenticated;
grant execute on function public.admin_clear_license_expiry(uuid) to authenticated;
grant execute on function public.admin_expire_license(uuid) to authenticated;
