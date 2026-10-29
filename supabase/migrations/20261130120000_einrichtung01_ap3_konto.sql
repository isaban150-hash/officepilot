-- EINRICHTUNG-01 (AP3; Katalog V3 K-01 bis K-05, O-03) -- Konto-Bereich und Betriebsname.
--
--   * update_own_profile: unveränderter Rumpf, zusätzlich die Sitzungsprüfung der Stufe 1 (Vertrag 1.1/1.8). Name,
--     Telefon und Branche des eigenen Kontos; nie role, status oder license_* (K-01.3); keine fremde Profil-ID
--     möglich (K-01.2).
--   * profiles.ui_language + set_own_ui_language: die Oberflächensprache gehört der Person und gilt auf jedem Gerät
--     (E6, K-04.3). Kein Firmen-Schreibauftrag; auch im Nur-Lesen-Betrieb und ohne Mitgliedschaft erlaubt (Ausnahme B,
--     K-04.2).
--   * sync_profile_email_from_auth: Nach einem vollständig bestätigten E-Mail-Wechsel (beide Links, auth.users.email
--     ändert sich erst dann) folgt profiles.email (K-02.1, K-02.2). Vorher gilt die alte Adresse in beiden Tabellen.
--   * list_own_memberships: die eigenen aktiven Mitgliedschaften mit Betrieb und Rolle für die Kontoseite (K-05.1).
--   * einrichtung01_workspace_name_follows_company: workspaces.name folgt dem Firmennamen des Firmenprofils, in derselben
--     Transaktion (O-03.1, O-03.2): Wird die Profiländerung abgewiesen, bleibt auch der Name (O-03.3); nur der eigene
--     Betrieb (O-03.4).
--
-- Nur lokal. Nicht remote anwenden (Gesamtveröffentlichung RELEASE-01).

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
  -- EINRICHTUNG-01 (Vertrag 1.8) -- eine widerrufene oder beendete Sitzung ändert nichts (wirft session_not_active).
  perform public.workspace_session_active();

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

alter table public.profiles add column if not exists ui_language text;
alter table public.profiles drop constraint if exists profiles_ui_language_check;
alter table public.profiles add constraint profiles_ui_language_check
  check (ui_language is null or ui_language in ('de', 'tr', 'bg', 'ro', 'ru'));

create or replace function public.set_own_ui_language(p_language text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if p_language is null or p_language not in ('de', 'tr', 'bg', 'ro', 'ru') then
    raise exception 'ui_language_invalid: Diese Sprache gibt es nicht' using errcode = '22023';
  end if;
  update public.profiles set ui_language = p_language where id = v_uid;
  if not found then
    raise exception 'Profil nicht gefunden' using errcode = '42501';
  end if;
  return p_language;
end;
$$;

revoke all on function public.set_own_ui_language(text) from public, anon;
grant execute on function public.set_own_ui_language(text) to authenticated;

create or replace function public.sync_profile_email_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is not null and new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id and email is distinct from new.email;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_profile_email_from_auth() from public, anon, authenticated;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
after update of email on auth.users
for each row
execute function public.sync_profile_email_from_auth();

create or replace function public.list_own_memberships()
returns table (workspace_id uuid, workspace_name text, role text, status text, member_since timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  return query
    select m.workspace_id, w.name, m.role, m.status, m.created_at
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
    where m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at, m.workspace_id;
end;
$$;

revoke all on function public.list_own_memberships() from public, anon;
grant execute on function public.list_own_memberships() to authenticated;

create or replace function public.einrichtung01_workspace_name_follows_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(coalesce(new.payload->>'companyName', '')), '');
begin
  if v_name is null then
    return new;
  end if;
  -- Nur genau dieser Betrieb; in derselben Transaktion wie die Profiländerung (beides oder nichts).
  update public.workspaces set name = v_name where id = new.workspace_id and name is distinct from v_name;
  return new;
end;
$$;

revoke all on function public.einrichtung01_workspace_name_follows_company() from public, anon, authenticated;

drop trigger if exists einrichtung01_workspace_name_follows_company on public.workspace_company_profiles;
create trigger einrichtung01_workspace_name_follows_company
after insert or update of payload on public.workspace_company_profiles
for each row
execute function public.einrichtung01_workspace_name_follows_company();
