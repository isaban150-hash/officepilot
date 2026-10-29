-- EINRICHTUNG-01 / AP4 -- Team, Einladungen, Inhaberuebergabe und Plattform-Verwaltung (Katalog V3 vom 23.10.2026,
-- Vertraege 1.1 Wege A, C und D; 1.3 mit E16; 1.4; 1.5; 1.6; 1.6a (E15); 1.7; 1.9; 1.12).
--
--   * Neue Tabellen ohne direkte Client-Rechte (RLS an, keine Policy, Rechte entzogen): workspace_invitations (Token nur
--     als SHA-256-Hash), workspace_invitation_attempts (Fehlversuche je Konto), workspace_member_events (Team-Pruefspur),
--     workspace_ownership_transfers (Uebergabe 1.6 und Reparatur 1.6a), platform_admin_events (Plattform-Pruefspur),
--     einrichtung_request_log (Idempotenz je Anfrage-ID). Die Pruefspuren sind unveraenderlich.
--   * Team-RPCs mit der zentralen Regel (Stufen 1-6, Vertrag 1.1) und der Rollenmatrix 1.4; Fehler 42501 mit
--     strukturiertem Code (team_forbidden_role, team_owner_protected, team_target_invalid, team_not_member,
--     license_not_effective, ...). Sperren nach 1.9: Betriebszeile, eigene und Zielmitgliedschaft, Inhaberprofil FOR
--     UPDATE. Nur-Lesen-Ausnahmen nach E16: rechtemindernde Aktionen und die normale Uebergabe.
--   * Einladungsweg C: eigene Einladungen anzeigen, per Token ansehen, annehmen, ablehnen -- ohne Freigabe und
--     Mitgliedschaft, mit Sperre, bestaetigter E-Mail, Ratenlimit, Recht der einladenden Person und Betriebslizenz.
--     Fehler kommen als {ok:false, code} zurueck, damit Fehlversuche gezaehlt (festgeschrieben) werden.
--   * ensure_personal_workspace (Weg A): gewaehlter Betrieb zuerst, keine Neuanlage bei offener Einladung
--     (invitation_pending), Sperre gemeinsam mit der Annahme.
--   * Plattform (Weg D): Sitzungspruefung in assert_is_admin; keine Selbstaenderung; nie der letzte Admin gesperrt
--     (alle Adminprofile in fester Reihenfolge FOR UPDATE); Freischalten mit Lizenz in einer Transaktion; Verlaengerung
--     mit gesehenem Ablauf; Pruefspur je Aktion; Reparatur ohne handlungsfaehigen Inhaber nach E15.
--
-- Kein Rumpf einer FINANZ-CORE-01A- oder DOKUMENTE-01-RPC wird geaendert.
-- Nur lokal. Nicht remote anwenden (Gesamtveroeffentlichung RELEASE-01).

/* ======================================================================== */
/* 1. Tabellen                                                              */
/* ======================================================================== */

create table if not exists public.einrichtung_request_log (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (actor_user_id, request_id)
);
alter table public.einrichtung_request_log enable row level security;
revoke all on public.einrichtung_request_log from public, anon, authenticated, service_role;

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member')),
  token_hash bytea not null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'accepted', 'revoked', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_sent_at timestamptz not null default now(),
  resend_count integer not null default 0 check (resend_count between 0 and 5),
  decided_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  constraint workspace_invitations_email_normalized check (email = lower(btrim(email))),
  constraint workspace_invitations_expiry check (expires_at > created_at)
);
create unique index if not exists workspace_invitations_open_per_email
  on public.workspace_invitations (workspace_id, email) where status = 'open';
create unique index if not exists workspace_invitations_token_hash on public.workspace_invitations (token_hash);
create index if not exists workspace_invitations_email on public.workspace_invitations (email) where status = 'open';
alter table public.workspace_invitations enable row level security;
revoke all on public.workspace_invitations from public, anon, authenticated, service_role;

create table if not exists public.workspace_invitation_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists workspace_invitation_attempts_window on public.workspace_invitation_attempts (user_id, attempted_at);
alter table public.workspace_invitation_attempts enable row level security;
revoke all on public.workspace_invitation_attempts from public, anon, authenticated, service_role;

create table if not exists public.workspace_member_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid,
  action text not null check (action in (
    'invitation_created', 'invitation_resent', 'invitation_revoked', 'invitation_accepted', 'invitation_declined',
    'account_approved_by_invitation', 'member_role_changed', 'member_removed', 'member_left',
    'ownership_transfer_requested', 'ownership_transfer_revoked', 'ownership_transfer_declined', 'ownership_transferred',
    'ownership_repair_requested', 'ownership_repair_revoked', 'ownership_repaired', 'workspace_renamed'
  )),
  target_user_id uuid,
  invitation_id uuid,
  transfer_id uuid,
  details jsonb not null default '{}'::jsonb,
  request_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists workspace_member_events_workspace on public.workspace_member_events (workspace_id, created_at desc);
create index if not exists workspace_member_events_actor on public.workspace_member_events (actor_user_id, action, created_at);
alter table public.workspace_member_events enable row level security;
revoke all on public.workspace_member_events from public, anon, authenticated, service_role;

create table if not exists public.workspace_ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('owner', 'platform_repair')),
  from_user_id uuid not null,
  to_user_id uuid not null references auth.users(id) on delete cascade,
  requested_by uuid not null,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  constraint workspace_ownership_transfers_expiry check (expires_at > created_at),
  constraint workspace_ownership_transfers_distinct check (from_user_id <> to_user_id)
);
create unique index if not exists workspace_ownership_transfers_one_open
  on public.workspace_ownership_transfers (workspace_id) where status = 'open';
alter table public.workspace_ownership_transfers enable row level security;
revoke all on public.workspace_ownership_transfers from public, anon, authenticated, service_role;

create table if not exists public.platform_admin_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  action text not null,
  target_user_id uuid,
  workspace_id uuid,
  transfer_id uuid,
  before jsonb,
  after jsonb,
  request_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists platform_admin_events_created on public.platform_admin_events (created_at desc);
alter table public.platform_admin_events enable row level security;
revoke all on public.platform_admin_events from public, anon, authenticated, service_role;

/*
 * M-02.18 -- Mitgliedschaften aendern nur die Serverfunktionen. Bisher verhinderte allein RLS (keine Policy) direkte
 * Schreibwege; UPDATE und DELETE liefen dabei ohne Fehler ins Leere. Jetzt wird der Versuch abgewiesen (42501).
 */
revoke insert, update, delete, truncate on public.workspace_members from anon, authenticated;

-- Der gewaehlte aktive Betrieb (Betriebswahl, M-13): nur ueber select_active_workspace, ohne Client-Schreibrecht.
alter table public.profiles add column if not exists preferred_workspace_id uuid references public.workspaces(id) on delete set null;

/*
 * Pruefspuren sind unveraenderlich (Vertrag 1.9, M-16.3, P-07.3). Kein Client hat Rechte; zusaetzlich verhindert der
 * Trigger jede Aenderung und jedes Loeschen ausser der Kaskade beim Loeschen eines ganzen Betriebs.
 */
create or replace function public.einrichtung01_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'audit_immutable: Pruefspur ist unveraenderlich' using errcode = '42501';
end;
$$;

revoke all on function public.einrichtung01_audit_immutable() from public, anon, authenticated, service_role;

drop trigger if exists einrichtung01_audit_immutable on public.workspace_member_events;
create trigger einrichtung01_audit_immutable before update or delete on public.workspace_member_events
  for each row execute function public.einrichtung01_audit_immutable();
drop trigger if exists einrichtung01_audit_immutable on public.platform_admin_events;
create trigger einrichtung01_audit_immutable before update or delete on public.platform_admin_events
  for each row execute function public.einrichtung01_audit_immutable();

/* ======================================================================== */
/* 2. Bausteine                                                             */
/* ======================================================================== */

create or replace function public.einrichtung01_email_normalize(p_email text)
returns text
language sql
immutable
as $$
  select lower(btrim(coalesce(p_email, '')));
$$;

create or replace function public.einrichtung01_email_valid(p_email text)
returns boolean
language sql
immutable
as $$
  -- Endanker via chr(36): die Zeichenfolge Dollar+Apostroph bricht den CLI-Statement-Splitter.
  select length(p_email) between 3 and 320
    and p_email ~ ('^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}' || chr(36));
$$;

revoke all on function public.einrichtung01_email_normalize(text) from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_email_valid(text) from public, anon, authenticated, service_role;

/* Ist die eigene Lizenz einer Person wirksam (unabhaengig von Freigabe und Sperre)? */
create or replace function public.einrichtung01_personal_license_effective(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.license_status = 'active' and (p.license_expires_at is null or p.license_expires_at > now())
    from public.profiles p
    where p.id = p_user_id
  ), false);
$$;

revoke all on function public.einrichtung01_personal_license_effective(uuid) from public, anon, authenticated, service_role;

/* Anzeigename einer Person; nie die E-Mail. */
create or replace function public.einrichtung01_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
  from public.profiles p
  where p.id = p_user_id;
$$;

revoke all on function public.einrichtung01_display_name(uuid) from public, anon, authenticated, service_role;

/*
 * Idempotenz (Vertrag 1.9): Eine Wiederholung mit derselben Anfrage-ID liefert das urspruengliche Ergebnis ohne zweite
 * Wirkung und ohne zweiten Pruefspureintrag. Gleichzeitige Wiederholungen warten auf die erste (Sperre je Anfrage-ID).
 * Gespeichert wird nur das Ergebnis einer erfolgreichen Aktion, nie ein Token.
 */
create or replace function public.einrichtung01_request_begin(p_operation text, p_request_id uuid, p_required boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.einrichtung_request_log;
begin
  if p_request_id is null then
    if p_required then
      raise exception 'request_id_missing: Anfrage-ID fehlt' using errcode = '22023';
    end if;
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('einrichtung01:request:' || auth.uid()::text || ':' || p_request_id::text, 0));
  select * into v_row
  from public.einrichtung_request_log l
  where l.actor_user_id = auth.uid() and l.request_id = p_request_id;
  if not found then
    return null;
  end if;
  if v_row.operation <> p_operation then
    raise exception 'request_id_reused: Die Anfrage-ID gehoert zu einer anderen Aktion' using errcode = '22023';
  end if;
  return v_row.result || jsonb_build_object('replayed', true);
end;
$$;

create or replace function public.einrichtung01_request_finish(p_operation text, p_request_id uuid, p_result jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_request_id is not null then
    insert into public.einrichtung_request_log (actor_user_id, request_id, operation, result)
    values (auth.uid(), p_request_id, p_operation, p_result);
  end if;
  return p_result;
end;
$$;

revoke all on function public.einrichtung01_request_begin(text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_request_finish(text, uuid, jsonb) from public, anon, authenticated, service_role;

create or replace function public.einrichtung01_team_event(
  p_workspace_id uuid,
  p_action text,
  p_target_user_id uuid,
  p_invitation_id uuid,
  p_transfer_id uuid,
  p_details jsonb,
  p_request_id uuid
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.workspace_member_events (workspace_id, actor_user_id, action, target_user_id, invitation_id, transfer_id, details, request_id)
  values (p_workspace_id, auth.uid(), p_action, p_target_user_id, p_invitation_id, p_transfer_id, coalesce(p_details, '{}'::jsonb), p_request_id);
$$;

create or replace function public.einrichtung01_platform_event(
  p_action text,
  p_target_user_id uuid,
  p_workspace_id uuid,
  p_transfer_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_request_id uuid
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.platform_admin_events (actor_user_id, action, target_user_id, workspace_id, transfer_id, before, after, request_id)
  values (auth.uid(), p_action, p_target_user_id, p_workspace_id, p_transfer_id, p_before, p_after, p_request_id);
$$;

revoke all on function public.einrichtung01_team_event(uuid, text, uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_platform_event(text, uuid, uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated, service_role;

/*
 * Die zentrale Regel fuer Teamaktionen (Vertrag 1.1, Stufen 1-6) -- liefert die Rolle der handelnden Person.
 *   p_require_license: Stufe 6 (Einladen, Annehmen, Aufstufen, Umbenennen). Rechtemindernde Aktionen und die normale
 *                      Uebergabe laufen auch im Nur-Lesen-Betrieb (E16).
 *   p_lock:            Teamaenderung (Vertrag 1.9): Betriebszeile, eigene Mitgliedschaft und Inhaberprofil FOR UPDATE.
 *                      Ohne Sperre fuer Lesewege.
 */
create or replace function public.einrichtung01_team_actor(p_workspace_id uuid, p_require_license boolean, p_lock boolean)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_owner uuid;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if not exists (select 1 from public.profiles p where p.id = v_user_id) then
    raise exception 'profile_missing: Kein Profil' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(v_user_id) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;
  if p_workspace_id is null then
    raise exception 'team_target_invalid: Betrieb fehlt' using errcode = '42501';
  end if;

  if p_lock then
    select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id for update;
    select wm.role into v_role
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = v_user_id and wm.status = 'active'
    for update;
    perform 1 from public.profiles p where p.id = v_owner for update;
  else
    select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id;
    select wm.role into v_role
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = v_user_id and wm.status = 'active';
  end if;

  if v_role is null then
    raise exception 'team_not_member: Kein Zugriff auf Workspace' using errcode = '42501';
  end if;
  if p_require_license and public.workspace_license_state(p_workspace_id) <> 'effective' then
    raise exception 'license_not_effective: Die Lizenz des Betriebs ist nicht wirksam' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

revoke all on function public.einrichtung01_team_actor(uuid, boolean, boolean) from public, anon, authenticated, service_role;

/* E15 -- kann der bisherige Inhaber nicht handeln (gesperrt, nicht freigegeben, ohne Profil)? */
create or replace function public.einrichtung01_owner_unable(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.id is null or p.status is distinct from 'approved'
    from public.workspaces w
    left join public.profiles p on p.id = w.owner_user_id
    where w.id = p_workspace_id
  ), false);
$$;

revoke all on function public.einrichtung01_owner_unable(uuid) from public, anon, authenticated, service_role;

/* Ziel einer Uebergabe (1.6, 1.6a): aktives Mitglied (admin/member), freigegeben, nicht gesperrt, eigene Lizenz wirksam. */
create or replace function public.einrichtung01_transfer_target_ok(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    join public.profiles p on p.id = wm.user_id
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
      and wm.status = 'active'
      and wm.role in ('admin', 'member')
      and p.status = 'approved'
  )
  and public.einrichtung01_personal_license_effective(p_user_id);
$$;

revoke all on function public.einrichtung01_transfer_target_ok(uuid, uuid) from public, anon, authenticated, service_role;

/* ======================================================================== */
/* 3. Einladungen (Vertrag 1.5)                                             */
/* ======================================================================== */

create or replace function public.einrichtung01_new_invitation_token()
returns text
language sql
volatile
security definer
set search_path = public
as $$
  -- 256 Bit Zufall, URL-sicher; gespeichert wird nur der SHA-256-Hash.
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

revoke all on function public.einrichtung01_new_invitation_token() from public, anon, authenticated, service_role;

create or replace function public.team_invite(p_workspace_id uuid, p_email text, p_role text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_email text := public.einrichtung01_email_normalize(p_email);
  v_replay jsonb;
  v_inv public.workspace_invitations;
  v_token text;
  v_result jsonb;
begin
  v_role := public.einrichtung01_team_actor(p_workspace_id, true, true);
  v_replay := public.einrichtung01_request_begin('team_invite', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;

  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'team_target_invalid: Unbekannte Rolle' using errcode = '42501';
  end if;
  if v_role = 'member' or (p_role = 'admin' and v_role <> 'owner') then
    raise exception 'team_forbidden_role: Diese Einladung ist mit Ihrer Rolle nicht moeglich' using errcode = '42501';
  end if;
  if not public.einrichtung01_email_valid(v_email) then
    raise exception 'team_target_invalid: Ungueltige E-Mail-Adresse' using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.workspace_members wm
    join public.profiles p on p.id = wm.user_id
    where wm.workspace_id = p_workspace_id
      and wm.status = 'active'
      and public.einrichtung01_email_normalize(p.email) = v_email
  ) then
    raise exception 'team_already_member: Diese Person ist bereits Mitglied' using errcode = '42501';
  end if;

  -- M-01.2: dieselbe offene Einladung, kein neues Token. Eine abgelaufene wird abgeschlossen und neu angelegt.
  select * into v_inv
  from public.workspace_invitations i
  where i.workspace_id = p_workspace_id and i.email = v_email and i.status = 'open'
  for update;
  if found then
    if v_inv.expires_at > now() then
      v_result := jsonb_build_object(
        'invitation_id', v_inv.id, 'status', 'already_invited', 'role', v_inv.role, 'email', v_inv.email,
        'expires_at', v_inv.expires_at, 'token', null
      );
      return public.einrichtung01_request_finish('team_invite', p_request_id, v_result);
    end if;
    update public.workspace_invitations set status = 'expired', decided_at = now() where id = v_inv.id;
  end if;

  -- Vertrag 1.12: hoechstens 20 je Person und Stunde, hoechstens 50 offene je Betrieb.
  if (
    select count(*) from public.workspace_member_events e
    where e.actor_user_id = v_user_id and e.action = 'invitation_created' and e.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'invitation_rate_limited: Zu viele Einladungen in kurzer Zeit' using errcode = '42501';
  end if;
  if (
    select count(*) from public.workspace_invitations i
    where i.workspace_id = p_workspace_id and i.status = 'open' and i.expires_at > now()
  ) >= 50 then
    raise exception 'invitation_limit_reached: Zu viele offene Einladungen' using errcode = '42501';
  end if;

  v_token := public.einrichtung01_new_invitation_token();
  insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
  values (p_workspace_id, v_email, p_role, extensions.digest(v_token, 'sha256'), v_user_id, now() + interval '7 days')
  returning * into v_inv;

  perform public.einrichtung01_team_event(
    p_workspace_id, 'invitation_created', null, v_inv.id, null,
    jsonb_build_object('email', v_email, 'role', p_role, 'expires_at', v_inv.expires_at), p_request_id
  );
  v_result := jsonb_build_object(
    'invitation_id', v_inv.id, 'status', 'created', 'role', p_role, 'email', v_email, 'expires_at', v_inv.expires_at
  );
  -- Die Wiederholung kennt das Token nicht (nur der Hash ist gespeichert); dafuer gibt es "Neu senden".
  perform public.einrichtung01_request_finish('team_invite', p_request_id, v_result || jsonb_build_object('token', null));
  return v_result || jsonb_build_object('token', v_token);
end;
$$;

create or replace function public.team_resend_invitation(p_invitation_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_role text;
  v_replay jsonb;
  v_inv public.workspace_invitations;
  v_token text;
  v_result jsonb;
begin
  select i.workspace_id into v_ws from public.workspace_invitations i where i.id = p_invitation_id;
  if v_ws is null then
    raise exception 'team_target_invalid: Einladung nicht gefunden' using errcode = '42501';
  end if;
  v_role := public.einrichtung01_team_actor(v_ws, true, true);
  v_replay := public.einrichtung01_request_begin('team_resend_invitation', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_inv from public.workspace_invitations i where i.id = p_invitation_id for update;
  if v_role = 'member' or (v_inv.role = 'admin' and v_role <> 'owner') then
    raise exception 'team_forbidden_role: Diese Einladung ist mit Ihrer Rolle nicht moeglich' using errcode = '42501';
  end if;
  if v_inv.status <> 'open' then
    raise exception 'invitation_not_open: Die Einladung ist nicht mehr offen' using errcode = '42501';
  end if;
  if v_inv.resend_count >= 5 then
    raise exception 'invitation_resend_limit: Die Einladung wurde schon fuenfmal neu gesendet' using errcode = '42501';
  end if;
  if v_inv.last_sent_at > now() - interval '10 minutes' then
    raise exception 'invitation_resend_too_soon: Bitte fruehestens zehn Minuten nach dem letzten Senden' using errcode = '42501';
  end if;

  v_token := public.einrichtung01_new_invitation_token();
  update public.workspace_invitations
  set token_hash = extensions.digest(v_token, 'sha256'),
      expires_at = now() + interval '7 days',
      last_sent_at = now(),
      resend_count = resend_count + 1
  where id = v_inv.id
  returning * into v_inv;

  perform public.einrichtung01_team_event(
    v_ws, 'invitation_resent', null, v_inv.id, null,
    jsonb_build_object('resend_count', v_inv.resend_count, 'expires_at', v_inv.expires_at), p_request_id
  );
  v_result := jsonb_build_object(
    'invitation_id', v_inv.id, 'status', 'resent', 'role', v_inv.role, 'email', v_inv.email,
    'expires_at', v_inv.expires_at, 'resend_count', v_inv.resend_count
  );
  perform public.einrichtung01_request_finish('team_resend_invitation', p_request_id, v_result || jsonb_build_object('token', null));
  return v_result || jsonb_build_object('token', v_token);
end;
$$;

create or replace function public.team_revoke_invitation(p_invitation_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_role text;
  v_replay jsonb;
  v_inv public.workspace_invitations;
  v_result jsonb;
begin
  select i.workspace_id into v_ws from public.workspace_invitations i where i.id = p_invitation_id;
  if v_ws is null then
    raise exception 'team_target_invalid: Einladung nicht gefunden' using errcode = '42501';
  end if;
  -- E16: Widerrufen mindert Rechte und bleibt im Nur-Lesen-Betrieb erlaubt.
  v_role := public.einrichtung01_team_actor(v_ws, false, true);
  v_replay := public.einrichtung01_request_begin('team_revoke_invitation', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_inv from public.workspace_invitations i where i.id = p_invitation_id for update;
  if v_role = 'member' or (v_inv.role = 'admin' and v_role <> 'owner') then
    raise exception 'team_forbidden_role: Diese Einladung ist mit Ihrer Rolle nicht widerrufbar' using errcode = '42501';
  end if;
  if v_inv.status <> 'open' then
    v_result := jsonb_build_object('invitation_id', v_inv.id, 'status', v_inv.status, 'changed', false);
    return public.einrichtung01_request_finish('team_revoke_invitation', p_request_id, v_result);
  end if;

  update public.workspace_invitations set status = 'revoked', decided_at = now() where id = v_inv.id;
  perform public.einrichtung01_team_event(
    v_ws, 'invitation_revoked', null, v_inv.id, null, jsonb_build_object('email', v_inv.email, 'role', v_inv.role), p_request_id
  );
  v_result := jsonb_build_object('invitation_id', v_inv.id, 'status', 'revoked', 'changed', true);
  return public.einrichtung01_request_finish('team_revoke_invitation', p_request_id, v_result);
end;
$$;

/* M-08.2 -- offene Einladungen mit E-Mail, nur fuer Inhaber und Admins; nie Token oder Hash. */
create or replace function public.team_list_invitations(p_workspace_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, false);
  if v_role not in ('owner', 'admin') then
    raise exception 'team_forbidden_role: Einladungen sehen nur Inhaber und Admins' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'invitation_id', i.id,
      'email', i.email,
      'role', i.role,
      'status', case when i.expires_at <= now() then 'expired' else 'open' end,
      'created_at', i.created_at,
      'expires_at', i.expires_at,
      'invited_by', i.invited_by,
      'invited_by_name', public.einrichtung01_display_name(i.invited_by),
      'resend_count', i.resend_count,
      'last_sent_at', i.last_sent_at,
      'resend_available_at', i.last_sent_at + interval '10 minutes',
      'can_manage', v_role = 'owner' or i.role = 'member'
    ) order by i.created_at desc)
    from public.workspace_invitations i
    where i.workspace_id = p_workspace_id and i.status = 'open'
  ), '[]'::jsonb);
end;
$$;

/*
 * M-17 -- Kontext fuer die Einladungsmail (Edge Function send-team-invitation, mit dem Token der einladenden Person):
 * nur fuer eine offene Einladung mit genau diesem aktuellen Token und nur fuer Inhaber bzw. Admins nach der Matrix.
 */
create or replace function public.team_invitation_mail_context(p_invitation_id uuid, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_role text;
  v_inv public.workspace_invitations;
begin
  select i.workspace_id into v_ws from public.workspace_invitations i where i.id = p_invitation_id;
  if v_ws is null then
    raise exception 'team_target_invalid: Einladung nicht gefunden' using errcode = '42501';
  end if;
  v_role := public.einrichtung01_team_actor(v_ws, true, false);
  select * into v_inv from public.workspace_invitations i where i.id = p_invitation_id;
  if v_role = 'member' or (v_inv.role = 'admin' and v_role <> 'owner') then
    raise exception 'team_forbidden_role: Diese Einladung ist mit Ihrer Rolle nicht moeglich' using errcode = '42501';
  end if;
  if v_inv.status <> 'open' or v_inv.expires_at <= now()
     or p_token is null or v_inv.token_hash <> extensions.digest(p_token, 'sha256') then
    raise exception 'invitation_not_open: Die Einladung ist nicht mehr offen' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'email', v_inv.email,
    'role', v_inv.role,
    'workspace_name', (select w.name from public.workspaces w where w.id = v_ws),
    'inviter_name', public.einrichtung01_display_name(v_inv.invited_by),
    'expires_at', v_inv.expires_at
  );
end;
$$;

/* ---- Einladungsweg C (Vertrag 1.1, Weg C) -------------------------------- */

/* Stufe 1 und 2 fuer Weg C; Freigabe und Mitgliedschaft entstehen erst durch die Annahme. */
create or replace function public.einrichtung01_invitation_gate()
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if not exists (select 1 from public.profiles p where p.id = auth.uid()) then
    raise exception 'profile_missing: Kein Profil' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(auth.uid()) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
end;
$$;

/* M-06.1 -- 10 Fehlversuche je Konto in 60 Minuten (gleitend); danach ohne Tokenpruefung abgewiesen. */
create or replace function public.einrichtung01_invitation_limited()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) >= 10
  from public.workspace_invitation_attempts a
  where a.user_id = auth.uid() and a.attempted_at > now() - interval '60 minutes';
$$;

/* Ein Fehlversuch zaehlt; die Antwort verraet weder Existenz noch Betrieb noch E-Mail. */
create or replace function public.einrichtung01_invitation_failure(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  insert into public.workspace_invitation_attempts (user_id) values (auth.uid());
  return jsonb_build_object('ok', false, 'code', p_code);
end;
$$;

revoke all on function public.einrichtung01_invitation_gate() from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_invitation_limited() from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_invitation_failure(text) from public, anon, authenticated, service_role;

/*
 * Pruefung einer Einladung fuer das angemeldete Konto: null = gueltig und offen; sonst die Antwort.
 * Fehlversuche (unbekannt, fremd, unbestaetigt, fremd verbraucht) zaehlen fuer das Ratenlimit; ein gueltiges eigenes
 * Token erfaehrt "abgelaufen", "widerrufen", "abgelehnt" bzw. "bereits Mitglied".
 */
create or replace function public.einrichtung01_invitation_check(p_inv public.workspace_invitations)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
  v_confirmed boolean;
begin
  if p_inv.id is null then
    return public.einrichtung01_invitation_failure('invitation_invalid');
  end if;
  select public.einrichtung01_email_normalize(u.email), u.email_confirmed_at is not null
  into v_email, v_confirmed
  from auth.users u
  where u.id = auth.uid();
  if v_email is distinct from p_inv.email then
    return public.einrichtung01_invitation_failure('invitation_invalid');
  end if;
  if not coalesce(v_confirmed, false) then
    return public.einrichtung01_invitation_failure('invitation_email_unconfirmed');
  end if;
  if p_inv.status = 'accepted' then
    if p_inv.accepted_by = auth.uid() then
      -- M-04.3: noch Mitglied -> "bereits Mitglied"; ausgeschieden (M-11.2) -> verbraucht, keine Wiederbelebung.
      if exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = p_inv.workspace_id and wm.user_id = auth.uid() and wm.status = 'active'
      ) then
        return jsonb_build_object('ok', true, 'status', 'already_member', 'workspace_id', p_inv.workspace_id, 'role', p_inv.role);
      end if;
      return jsonb_build_object('ok', false, 'code', 'invitation_invalid');
    end if;
    return public.einrichtung01_invitation_failure('invitation_invalid');
  end if;
  if p_inv.status = 'revoked' then
    return jsonb_build_object('ok', false, 'code', 'invitation_revoked');
  end if;
  if p_inv.status = 'declined' then
    return jsonb_build_object('ok', false, 'code', 'invitation_declined');
  end if;
  if p_inv.status = 'expired' or p_inv.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'invitation_expired');
  end if;
  return null;
end;
$$;

revoke all on function public.einrichtung01_invitation_check(public.workspace_invitations) from public, anon, authenticated, service_role;

create or replace function public.einrichtung01_invitation_find(p_invitation_id uuid, p_token text, p_lock boolean)
returns public.workspace_invitations
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_inv public.workspace_invitations;
begin
  if p_token is not null and length(p_token) between 20 and 200 then
    if p_lock then
      select * into v_inv from public.workspace_invitations i where i.token_hash = extensions.digest(p_token, 'sha256') for update;
    else
      select * into v_inv from public.workspace_invitations i where i.token_hash = extensions.digest(p_token, 'sha256');
    end if;
  elsif p_invitation_id is not null and p_token is null then
    if p_lock then
      select * into v_inv from public.workspace_invitations i where i.id = p_invitation_id for update;
    else
      select * into v_inv from public.workspace_invitations i where i.id = p_invitation_id;
    end if;
  end if;
  return v_inv;
end;
$$;

revoke all on function public.einrichtung01_invitation_find(uuid, text, boolean) from public, anon, authenticated, service_role;

/* M-07.1 -- offene Einladungen an die eigene bestaetigte E-Mail (ohne Link). Unbestaetigt bzw. ohne Einladung: leer. */
create or replace function public.list_my_invitations()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  perform public.einrichtung01_invitation_gate();
  select public.einrichtung01_email_normalize(u.email) into v_email
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
  if v_email is null or v_email = '' then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'invitation_id', i.id,
      'workspace_id', i.workspace_id,
      'workspace_name', w.name,
      'role', i.role,
      'inviter_name', public.einrichtung01_display_name(i.invited_by),
      'expires_at', i.expires_at
    ) order by i.created_at)
    from public.workspace_invitations i
    join public.workspaces w on w.id = i.workspace_id
    where i.email = v_email
      and i.status = 'open'
      and i.expires_at > now()
      and not exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = i.workspace_id and wm.user_id = auth.uid() and wm.status = 'active'
      )
  ), '[]'::jsonb);
end;
$$;

/* Einladung per Link ansehen (vor der Annahme). */
create or replace function public.invitation_preview(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_inv public.workspace_invitations;
  v_check jsonb;
begin
  perform public.einrichtung01_invitation_gate();
  if public.einrichtung01_invitation_limited() then
    return jsonb_build_object('ok', false, 'code', 'invitation_rate_limited');
  end if;
  v_inv := public.einrichtung01_invitation_find(null, p_token, false);
  v_check := public.einrichtung01_invitation_check(v_inv);
  if v_check is not null then
    return v_check;
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', 'open',
    'invitation_id', v_inv.id,
    'workspace_name', (select w.name from public.workspaces w where w.id = v_inv.workspace_id),
    'role', v_inv.role,
    'inviter_name', public.einrichtung01_display_name(v_inv.invited_by),
    'expires_at', v_inv.expires_at
  );
end;
$$;

/*
 * Annahme (Vertrag 1.5): genau diese Einladung; Konto nicht gesperrt, bestaetigte E-Mail = Einladungs-E-Mail; erneut
 * geprueft: Recht der einladenden Person und Betriebslizenz. pending wird approved (Pruefspur), blocked nie.
 * Laeuft mit derselben Sperre wie ensure_personal_workspace (N-Z5.3): entweder bindet die Annahme, oder ensure meldet
 * die offene Einladung.
 */
create or replace function public.accept_invitation(p_invitation_id uuid, p_token text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_replay jsonb;
  v_inv public.workspace_invitations;
  v_check jsonb;
  v_inviter_role text;
  v_owner uuid;
  v_status text;
  v_result jsonb;
begin
  perform public.einrichtung01_invitation_gate();
  perform pg_advisory_xact_lock(hashtextextended('einrichtung01:ensure_personal_workspace:' || v_user_id::text, 0));
  v_replay := public.einrichtung01_request_begin('accept_invitation', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if public.einrichtung01_invitation_limited() then
    return jsonb_build_object('ok', false, 'code', 'invitation_rate_limited');
  end if;

  v_inv := public.einrichtung01_invitation_find(p_invitation_id, p_token, true);
  v_check := public.einrichtung01_invitation_check(v_inv);
  if v_check is not null then
    if (v_check->>'ok')::boolean then
      -- M-04.3: bereits angenommen von diesem Konto -- keine zweite Mitgliedschaft, keine zweite Pruefspur.
      return public.einrichtung01_request_finish('accept_invitation', p_request_id, v_check);
    end if;
    return v_check;
  end if;

  -- Vertrag 1.9: Teamaenderung -- Betriebszeile und Inhaberprofil sperren, dann erneut pruefen.
  select w.owner_user_id into v_owner from public.workspaces w where w.id = v_inv.workspace_id for update;
  perform 1 from public.profiles p where p.id = v_owner for update;
  select wm.role into v_inviter_role
  from public.workspace_members wm
  where wm.workspace_id = v_inv.workspace_id and wm.user_id = v_inv.invited_by and wm.status = 'active'
  for share;
  if v_inviter_role is null
     or v_inviter_role not in ('owner', 'admin')
     or (v_inv.role = 'admin' and v_inviter_role <> 'owner')
     or public.workspace_account_blocked(v_inv.invited_by)
     or not public.workspace_account_approved(v_inv.invited_by) then
    -- N-M1.4: Die einladende Person darf diese Rolle nicht mehr vergeben.
    return jsonb_build_object('ok', false, 'code', 'invitation_invalid');
  end if;
  if public.workspace_license_state(v_inv.workspace_id) <> 'effective' then
    return jsonb_build_object('ok', false, 'code', 'license_not_effective');
  end if;

  select p.status into v_status from public.profiles p where p.id = v_user_id for update;
  if v_status = 'blocked' then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if v_status = 'pending' then
    update public.profiles set status = 'approved' where id = v_user_id;
    perform public.einrichtung01_team_event(
      v_inv.workspace_id, 'account_approved_by_invitation', v_user_id, v_inv.id, null,
      jsonb_build_object('before', 'pending', 'after', 'approved'), p_request_id
    );
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values (v_inv.workspace_id, v_user_id, v_inv.role, 'active')
  on conflict (workspace_id, user_id) do update
    set role = case when public.workspace_members.status = 'active' then public.workspace_members.role else excluded.role end,
        status = 'active';

  update public.workspace_invitations
  set status = 'accepted', accepted_by = v_user_id, decided_at = now()
  where id = v_inv.id;
  perform public.einrichtung01_team_event(
    v_inv.workspace_id, 'invitation_accepted', v_user_id, v_inv.id, null, jsonb_build_object('role', v_inv.role), p_request_id
  );

  v_result := jsonb_build_object('ok', true, 'status', 'accepted', 'workspace_id', v_inv.workspace_id, 'role', v_inv.role);
  return public.einrichtung01_request_finish('accept_invitation', p_request_id, v_result);
end;
$$;

create or replace function public.decline_invitation(p_invitation_id uuid, p_token text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_inv public.workspace_invitations;
  v_check jsonb;
  v_result jsonb;
begin
  perform public.einrichtung01_invitation_gate();
  v_replay := public.einrichtung01_request_begin('decline_invitation', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if public.einrichtung01_invitation_limited() then
    return jsonb_build_object('ok', false, 'code', 'invitation_rate_limited');
  end if;

  v_inv := public.einrichtung01_invitation_find(p_invitation_id, p_token, true);
  v_check := public.einrichtung01_invitation_check(v_inv);
  if v_check is not null then
    if v_check->>'code' = 'invitation_declined' then
      return jsonb_build_object('ok', true, 'status', 'declined', 'changed', false);
    end if;
    return v_check;
  end if;

  update public.workspace_invitations set status = 'declined', decided_at = now() where id = v_inv.id;
  perform public.einrichtung01_team_event(
    v_inv.workspace_id, 'invitation_declined', auth.uid(), v_inv.id, null, jsonb_build_object('role', v_inv.role), p_request_id
  );
  v_result := jsonb_build_object('ok', true, 'status', 'declined', 'changed', true);
  return public.einrichtung01_request_finish('decline_invitation', p_request_id, v_result);
end;
$$;

/* ======================================================================== */
/* 4. Mitglieder (Vertrag 1.4)                                              */
/* ======================================================================== */

/* M-08.1/M-08.2 -- Name, Rolle, Status, seit; E-Mail nur fuer Inhaber und Admins; Uebergabeziel nur fuer den Inhaber. */
create or replace function public.team_list_members(p_workspace_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, false);
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'user_id', wm.user_id,
        'name', public.einrichtung01_display_name(wm.user_id),
        'role', wm.role,
        'status', wm.status,
        'member_since', wm.created_at,
        'is_self', wm.user_id = auth.uid()
      )
      || case when v_role in ('owner', 'admin') then jsonb_build_object('email', p.email) else '{}'::jsonb end
      || case when v_role = 'owner' then
           jsonb_build_object('transfer_eligible', wm.role <> 'owner' and public.einrichtung01_transfer_target_ok(p_workspace_id, wm.user_id))
         else '{}'::jsonb end
      order by case wm.role when 'owner' then 0 when 'admin' then 1 else 2 end, wm.created_at, wm.user_id
    )
    from public.workspace_members wm
    left join public.profiles p on p.id = wm.user_id
    where wm.workspace_id = p_workspace_id and wm.status = 'active'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.team_change_role(p_workspace_id uuid, p_target_user_id uuid, p_new_role text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
  v_target_role text;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_new_role is null or p_new_role not in ('owner', 'admin', 'member') then
    raise exception 'team_target_invalid: Unbekannte Rolle' using errcode = '42501';
  end if;
  -- Aufstufen braucht die Betriebslizenz; Herabstufen mindert Rechte und bleibt im Nur-Lesen-Betrieb erlaubt (E16).
  v_role := public.einrichtung01_team_actor(p_workspace_id, p_new_role = 'admin', true);
  v_replay := public.einrichtung01_request_begin('team_change_role', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if v_role <> 'owner' then
    raise exception 'team_forbidden_role: Rollen aendert nur der Inhaber' using errcode = '42501';
  end if;
  select wm.role into v_target_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_target_user_id and wm.status = 'active'
  for update;
  if v_target_role is null then
    raise exception 'team_target_invalid: Ziel ist kein aktives Mitglied' using errcode = '42501';
  end if;
  if v_target_role = 'owner' or p_new_role = 'owner' or p_target_user_id = auth.uid() then
    raise exception 'team_owner_protected: Inhaber wird man nur durch Uebergabe' using errcode = '42501';
  end if;
  if v_target_role = p_new_role then
    v_result := jsonb_build_object('user_id', p_target_user_id, 'role', p_new_role, 'changed', false);
    return public.einrichtung01_request_finish('team_change_role', p_request_id, v_result);
  end if;

  update public.workspace_members set role = p_new_role
  where workspace_id = p_workspace_id and user_id = p_target_user_id;
  perform public.einrichtung01_team_event(
    p_workspace_id, 'member_role_changed', p_target_user_id, null, null,
    jsonb_build_object('before', v_target_role, 'after', p_new_role), p_request_id
  );
  v_result := jsonb_build_object('user_id', p_target_user_id, 'role', p_new_role, 'changed', true);
  return public.einrichtung01_request_finish('team_change_role', p_request_id, v_result);
end;
$$;

/* Offene Uebergaben an eine Person, die ihre Mitgliedschaft verliert, enden mit ihr (N-M2.3). */
create or replace function public.einrichtung01_revoke_transfers_to(p_workspace_id uuid, p_user_id uuid, p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_transfer public.workspace_ownership_transfers;
begin
  for v_transfer in
    select * from public.workspace_ownership_transfers t
    where t.workspace_id = p_workspace_id and t.to_user_id = p_user_id and t.status = 'open'
    for update
  loop
    update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = v_transfer.id;
    perform public.einrichtung01_team_event(
      p_workspace_id,
      case when v_transfer.kind = 'platform_repair' then 'ownership_repair_revoked' else 'ownership_transfer_revoked' end,
      p_user_id, null, v_transfer.id, jsonb_build_object('reason', 'target_left'), p_request_id
    );
  end loop;
end;
$$;

revoke all on function public.einrichtung01_revoke_transfers_to(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.team_remove_member(p_workspace_id uuid, p_target_user_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
  v_target_role text;
  v_replay jsonb;
  v_result jsonb;
begin
  -- E16: Entfernen mindert Rechte und bleibt im Nur-Lesen-Betrieb erlaubt.
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, true);
  v_replay := public.einrichtung01_request_begin('team_remove_member', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if p_target_user_id is null or p_target_user_id = auth.uid() then
    raise exception 'team_target_invalid: Sich selbst entfernen geht nicht; dafuer gibt es Verlassen' using errcode = '42501';
  end if;
  select wm.role into v_target_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_target_user_id and wm.status = 'active'
  for update;
  if v_target_role is null then
    raise exception 'team_target_invalid: Ziel ist kein aktives Mitglied' using errcode = '42501';
  end if;
  if v_target_role = 'owner' then
    raise exception 'team_owner_protected: Den Inhaber kann niemand entfernen' using errcode = '42501';
  end if;
  if v_role = 'member' or (v_role = 'admin' and v_target_role <> 'member') then
    raise exception 'team_forbidden_role: Entfernen ist mit Ihrer Rolle nicht moeglich' using errcode = '42501';
  end if;

  update public.workspace_members set status = 'removed'
  where workspace_id = p_workspace_id and user_id = p_target_user_id;
  perform public.einrichtung01_revoke_transfers_to(p_workspace_id, p_target_user_id, p_request_id);
  perform public.einrichtung01_team_event(
    p_workspace_id, 'member_removed', p_target_user_id, null, null, jsonb_build_object('role', v_target_role), p_request_id
  );
  v_result := jsonb_build_object('user_id', p_target_user_id, 'status', 'removed');
  return public.einrichtung01_request_finish('team_remove_member', p_request_id, v_result);
end;
$$;

create or replace function public.team_leave(p_workspace_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
  v_replay jsonb;
  v_result jsonb;
begin
  -- Vertrag 1.3: Verlassen bleibt im Nur-Lesen-Betrieb erlaubt.
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, true);
  v_replay := public.einrichtung01_request_begin('team_leave', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if v_role = 'owner' then
    raise exception 'team_owner_protected: Der Inhaber verlaesst den Betrieb erst nach einer Uebergabe' using errcode = '42501';
  end if;

  update public.workspace_members set status = 'removed'
  where workspace_id = p_workspace_id and user_id = auth.uid();
  perform public.einrichtung01_revoke_transfers_to(p_workspace_id, auth.uid(), p_request_id);
  update public.profiles set preferred_workspace_id = null
  where id = auth.uid() and preferred_workspace_id = p_workspace_id;
  perform public.einrichtung01_team_event(
    p_workspace_id, 'member_left', auth.uid(), null, null, jsonb_build_object('role', v_role), p_request_id
  );
  v_result := jsonb_build_object('workspace_id', p_workspace_id, 'status', 'left');
  return public.einrichtung01_request_finish('team_leave', p_request_id, v_result);
end;
$$;

/* M-16.5 -- Team-Pruefspur, nur Inhaber und Admins. */
create or replace function public.team_list_events(p_workspace_id uuid, p_limit integer default 100)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, false);
  if v_role not in ('owner', 'admin') then
    raise exception 'team_forbidden_role: Die Pruefspur sehen nur Inhaber und Admins' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id,
      'action', e.action,
      'actor_user_id', e.actor_user_id,
      'actor_name', public.einrichtung01_display_name(e.actor_user_id),
      'target_user_id', e.target_user_id,
      'target_name', public.einrichtung01_display_name(e.target_user_id),
      'details', e.details,
      'created_at', e.created_at
    ) order by e.created_at desc, e.id)
    from (
      select * from public.workspace_member_events x
      where x.workspace_id = p_workspace_id
      order by x.created_at desc, x.id
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) e
  ), '[]'::jsonb);
end;
$$;

/*
 * M-14 -- Betrieb umbenennen (Inhaber, Admin; wirksame Lizenz). Der Betriebsname folgt dem Firmennamen (O-03): Deshalb
 * aendert dieselbe Transaktion den Firmennamen im Firmenprofil und im Setup-Spiegel, wenn es sie gibt (neue
 * Zeilenversion; die Geraete ziehen sie mit dem naechsten Abgleich).
 */
create or replace function public.team_rename_workspace(p_workspace_id uuid, p_name text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
  v_name text := btrim(coalesce(p_name, ''));
  v_before text;
  v_replay jsonb;
  v_result jsonb;
begin
  v_role := public.einrichtung01_team_actor(p_workspace_id, true, true);
  v_replay := public.einrichtung01_request_begin('team_rename_workspace', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'team_forbidden_role: Umbenennen duerfen Inhaber und Admins' using errcode = '42501';
  end if;
  if length(v_name) = 0 or length(v_name) > 200 then
    raise exception 'team_target_invalid: Der Name muss 1 bis 200 Zeichen haben' using errcode = '42501';
  end if;
  select w.name into v_before from public.workspaces w where w.id = p_workspace_id;
  if v_before = v_name then
    v_result := jsonb_build_object('workspace_id', p_workspace_id, 'name', v_name, 'changed', false);
    return public.einrichtung01_request_finish('team_rename_workspace', p_request_id, v_result);
  end if;

  update public.workspaces set name = v_name, version = version + 1 where id = p_workspace_id;
  update public.workspace_company_profiles
  set payload = jsonb_set(payload, '{companyName}', to_jsonb(v_name), true),
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = auth.uid()
  where workspace_id = p_workspace_id
    and payload ? 'companyName'
    and payload->>'companyName' is distinct from v_name;
  update public.workspace_setup
  set payload = jsonb_set(payload, '{companyName}', to_jsonb(v_name), true),
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = auth.uid()
  where workspace_id = p_workspace_id
    and payload ? 'companyName'
    and payload->>'companyName' is distinct from v_name;

  perform public.einrichtung01_team_event(
    p_workspace_id, 'workspace_renamed', null, null, null, jsonb_build_object('before', v_before, 'after', v_name), p_request_id
  );
  v_result := jsonb_build_object('workspace_id', p_workspace_id, 'name', v_name, 'changed', true);
  return public.einrichtung01_request_finish('team_rename_workspace', p_request_id, v_result);
end;
$$;

/* M-13 -- aktiven Betrieb waehlen (eigene aktive Mitgliedschaft); ensure_personal_workspace bindet ihn zuerst. */
create or replace function public.select_active_workspace(p_workspace_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if public.workspace_account_blocked(auth.uid()) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(auth.uid()) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid() and wm.status = 'active'
  ) then
    raise exception 'team_not_member: Kein Zugriff auf Workspace' using errcode = '42501';
  end if;
  update public.profiles set preferred_workspace_id = p_workspace_id where id = auth.uid();
  return jsonb_build_object('workspace_id', p_workspace_id);
end;
$$;

/* ======================================================================== */
/* 5. Inhaberuebergabe (Vertrag 1.6) und Reparatur (1.6a, E15)              */
/* ======================================================================== */

create or replace function public.team_request_transfer(p_workspace_id uuid, p_target_user_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
  v_replay jsonb;
  v_old public.workspace_ownership_transfers;
  v_transfer public.workspace_ownership_transfers;
  v_result jsonb;
begin
  -- E16: Die normale Uebergabe stellt ein regulaer handlungsfaehiger Inhaber auch bei nicht wirksamer Lizenz.
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, true);
  v_replay := public.einrichtung01_request_begin('team_request_transfer', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  if v_role <> 'owner' then
    raise exception 'team_forbidden_role: Die Uebergabe beantragt nur der Inhaber' using errcode = '42501';
  end if;
  if p_target_user_id is null or p_target_user_id = auth.uid() then
    raise exception 'team_target_invalid: Ungueltiges Ziel' using errcode = '42501';
  end if;
  perform 1 from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_target_user_id and wm.status = 'active'
  for update;
  perform 1 from public.profiles p where p.id = p_target_user_id for update;
  if not public.einrichtung01_transfer_target_ok(p_workspace_id, p_target_user_id)
     or public.workspace_account_blocked(p_target_user_id) then
    raise exception 'team_target_invalid: Ziel braucht eine aktive Mitgliedschaft, Freigabe und wirksame eigene Lizenz' using errcode = '42501';
  end if;

  -- N-M2.1: hoechstens ein offener Antrag je Betrieb; ein neuer widerruft den alten.
  for v_old in
    select * from public.workspace_ownership_transfers t
    where t.workspace_id = p_workspace_id and t.status = 'open'
    for update
  loop
    update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = v_old.id;
    perform public.einrichtung01_team_event(
      p_workspace_id,
      case when v_old.kind = 'platform_repair' then 'ownership_repair_revoked' else 'ownership_transfer_revoked' end,
      v_old.to_user_id, null, v_old.id, jsonb_build_object('reason', 'superseded'), p_request_id
    );
  end loop;

  insert into public.workspace_ownership_transfers (workspace_id, kind, from_user_id, to_user_id, requested_by, expires_at)
  values (p_workspace_id, 'owner', auth.uid(), p_target_user_id, auth.uid(), now() + interval '72 hours')
  returning * into v_transfer;
  perform public.einrichtung01_team_event(
    p_workspace_id, 'ownership_transfer_requested', p_target_user_id, null, v_transfer.id,
    jsonb_build_object('expires_at', v_transfer.expires_at), p_request_id
  );
  v_result := jsonb_build_object(
    'transfer_id', v_transfer.id, 'workspace_id', p_workspace_id, 'to_user_id', p_target_user_id,
    'status', 'open', 'expires_at', v_transfer.expires_at
  );
  return public.einrichtung01_request_finish('team_request_transfer', p_request_id, v_result);
end;
$$;

create or replace function public.team_revoke_transfer(p_transfer_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_role text;
  v_replay jsonb;
  v_transfer public.workspace_ownership_transfers;
  v_result jsonb;
begin
  select t.workspace_id into v_ws from public.workspace_ownership_transfers t where t.id = p_transfer_id and t.kind = 'owner';
  if v_ws is null then
    raise exception 'team_target_invalid: Antrag nicht gefunden' using errcode = '42501';
  end if;
  v_role := public.einrichtung01_team_actor(v_ws, false, true);
  v_replay := public.einrichtung01_request_begin('team_revoke_transfer', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_transfer from public.workspace_ownership_transfers t where t.id = p_transfer_id for update;
  /*
   * Schon entschieden: Inhaber und beantragende Person erfahren den Stand. Kam die Annahme dem Widerruf zuvor, ist die
   * beantragende Person nicht mehr Inhaber — sie erhält trotzdem „angenommen“ statt einer Rollenmeldung (N-M2.2).
   */
  if v_transfer.status <> 'open' and (v_role = 'owner' or auth.uid() in (v_transfer.from_user_id, v_transfer.requested_by)) then
    v_result := jsonb_build_object('transfer_id', p_transfer_id, 'status', v_transfer.status, 'changed', false);
    return public.einrichtung01_request_finish('team_revoke_transfer', p_request_id, v_result);
  end if;
  if v_role <> 'owner' then
    raise exception 'team_forbidden_role: Den Antrag widerruft nur der Inhaber' using errcode = '42501';
  end if;
  update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = p_transfer_id;
  perform public.einrichtung01_team_event(
    v_ws, 'ownership_transfer_revoked', v_transfer.to_user_id, null, p_transfer_id, jsonb_build_object('reason', 'revoked'), p_request_id
  );
  v_result := jsonb_build_object('transfer_id', p_transfer_id, 'status', 'revoked', 'changed', true);
  return public.einrichtung01_request_finish('team_revoke_transfer', p_request_id, v_result);
end;
$$;

/* Offene Antraege an das angemeldete Konto (Annehmen bzw. Ablehnen in der Oberflaeche). */
create or replace function public.list_my_transfers()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if public.workspace_account_blocked(auth.uid()) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'transfer_id', t.id,
      'workspace_id', t.workspace_id,
      'workspace_name', w.name,
      'kind', t.kind,
      'from_name', public.einrichtung01_display_name(t.from_user_id),
      'expires_at', t.expires_at
    ) order by t.created_at)
    from public.workspace_ownership_transfers t
    join public.workspaces w on w.id = t.workspace_id
    where t.to_user_id = auth.uid() and t.status = 'open' and t.expires_at > now()
  ), '[]'::jsonb);
end;
$$;

/* Der offene Antrag eines Betriebs (Inhaber und Admins; das Ziel sieht seinen ueber list_my_transfers). */
create or replace function public.team_open_transfer(p_workspace_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.einrichtung01_team_actor(p_workspace_id, false, false);
  if v_role not in ('owner', 'admin') then
    raise exception 'team_forbidden_role: Antraege sehen Inhaber und Admins' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'transfer_id', t.id, 'kind', t.kind, 'to_user_id', t.to_user_id,
      'to_name', public.einrichtung01_display_name(t.to_user_id), 'expires_at', t.expires_at,
      'expired', t.expires_at <= now()
    )
    from public.workspace_ownership_transfers t
    where t.workspace_id = p_workspace_id and t.status = 'open'
    limit 1
  );
end;
$$;

create or replace function public.team_decline_transfer(p_transfer_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_transfer public.workspace_ownership_transfers;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if public.workspace_account_blocked(auth.uid()) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  v_replay := public.einrichtung01_request_begin('team_decline_transfer', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_transfer from public.workspace_ownership_transfers t where t.id = p_transfer_id for update;
  if v_transfer.id is null or v_transfer.to_user_id <> auth.uid() then
    raise exception 'team_target_invalid: Antrag nicht gefunden' using errcode = '42501';
  end if;
  if v_transfer.status <> 'open' then
    v_result := jsonb_build_object('transfer_id', p_transfer_id, 'status', v_transfer.status, 'changed', false);
    return public.einrichtung01_request_finish('team_decline_transfer', p_request_id, v_result);
  end if;
  update public.workspace_ownership_transfers set status = 'declined', decided_at = now() where id = p_transfer_id;
  perform public.einrichtung01_team_event(
    v_transfer.workspace_id, 'ownership_transfer_declined', auth.uid(), null, p_transfer_id,
    jsonb_build_object('kind', v_transfer.kind), p_request_id
  );
  if v_transfer.kind = 'platform_repair' then
    perform public.einrichtung01_platform_event(
      'ownership_repair_declined', auth.uid(), v_transfer.workspace_id, p_transfer_id, null, null, p_request_id
    );
  end if;
  v_result := jsonb_build_object('transfer_id', p_transfer_id, 'status', 'declined', 'changed', true);
  return public.einrichtung01_request_finish('team_decline_transfer', p_request_id, v_result);
end;
$$;

/*
 * Annahme (1.6 bzw. 1.6a): nur das Zielkonto. Unter Sperre der Betriebszeile wird alles erneut geprueft; die Wirkung ist
 * atomar: owner_user_id = Ziel, Ziel owner, bisheriger Inhaber admin -- genau ein owner, keine Zwischenberechtigung.
 * Daten und Dateien wechseln nicht den Besitzer. Eine Wiederholung nach der Annahme ist idempotent (M-12.9, P-09.8).
 */
create or replace function public.team_accept_transfer(p_transfer_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_replay jsonb;
  v_transfer public.workspace_ownership_transfers;
  v_ws uuid;
  v_owner uuid;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  v_replay := public.einrichtung01_request_begin('team_accept_transfer', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;

  select t.workspace_id into v_ws from public.workspace_ownership_transfers t where t.id = p_transfer_id;
  if v_ws is null then
    raise exception 'team_target_invalid: Antrag nicht gefunden' using errcode = '42501';
  end if;
  -- Vertrag 1.9: zuerst die Betriebszeile, dann der Antrag.
  select w.owner_user_id into v_owner from public.workspaces w where w.id = v_ws for update;
  select * into v_transfer from public.workspace_ownership_transfers t where t.id = p_transfer_id for update;
  if v_transfer.to_user_id <> v_user_id then
    raise exception 'team_target_invalid: Diesen Antrag nimmt nur das Zielkonto an' using errcode = '42501';
  end if;
  if v_transfer.status = 'accepted' then
    v_result := jsonb_build_object('transfer_id', p_transfer_id, 'workspace_id', v_transfer.workspace_id, 'status', 'accepted', 'changed', false);
    return public.einrichtung01_request_finish('team_accept_transfer', p_request_id, v_result);
  end if;
  if v_transfer.status <> 'open' then
    raise exception 'transfer_not_open: Der Antrag ist nicht mehr offen' using errcode = '42501';
  end if;
  if v_transfer.expires_at <= now() then
    raise exception 'transfer_expired: Der Antrag ist abgelaufen' using errcode = '42501';
  end if;

  -- Erneute Pruefung unter Sperre (N-M2.2 bis N-M2.4, P-09.5, P-09.7).
  perform 1 from public.profiles p where p.id in (v_transfer.from_user_id, v_user_id) order by p.id for update;
  perform 1 from public.workspace_members wm
  where wm.workspace_id = v_transfer.workspace_id and wm.user_id in (v_transfer.from_user_id, v_user_id)
  order by wm.user_id
  for update;
  if v_owner is distinct from v_transfer.from_user_id then
    raise exception 'transfer_not_open: Der Inhaber hat sich geaendert' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(v_user_id) or not public.einrichtung01_transfer_target_ok(v_transfer.workspace_id, v_user_id) then
    raise exception 'team_target_invalid: Ziel braucht eine aktive Mitgliedschaft, Freigabe und wirksame eigene Lizenz' using errcode = '42501';
  end if;
  if v_transfer.kind = 'owner' then
    if public.workspace_account_blocked(v_transfer.from_user_id) or not public.workspace_account_approved(v_transfer.from_user_id) then
      raise exception 'transfer_not_open: Der Inhaber ist nicht mehr handlungsfaehig; zustaendig ist die Plattform' using errcode = '42501';
    end if;
  else
    if not public.einrichtung01_owner_unable(v_transfer.workspace_id) then
      raise exception 'transfer_not_open: Der Inhaber ist wieder handlungsfaehig' using errcode = '42501';
    end if;
    perform 1 from public.profiles p where p.id = v_transfer.requested_by for update;
    if not exists (
      select 1 from public.profiles p
      where p.id = v_transfer.requested_by and p.role = 'admin' and p.status is distinct from 'blocked'
    ) then
      raise exception 'transfer_not_open: Das Plattformrecht des Antrags besteht nicht mehr' using errcode = '42501';
    end if;
  end if;

  -- Vertrauenswuerdiger Systemweg (AP1, Schreibschutz-Trigger): nur fuer genau diese Transaktion.
  perform set_config('officetakt.einrichtung_systemweg', pg_current_xact_id()::text, true);
  update public.workspaces set owner_user_id = v_user_id, version = version + 1 where id = v_transfer.workspace_id;
  update public.workspace_members set role = 'admin'
  where workspace_id = v_transfer.workspace_id and user_id = v_transfer.from_user_id and status = 'active';
  update public.workspace_members set role = 'owner'
  where workspace_id = v_transfer.workspace_id and user_id = v_user_id;
  perform set_config('officetakt.einrichtung_systemweg', '', true);

  update public.workspace_ownership_transfers set status = 'accepted', decided_at = now() where id = p_transfer_id;
  perform public.einrichtung01_team_event(
    v_transfer.workspace_id,
    case when v_transfer.kind = 'platform_repair' then 'ownership_repaired' else 'ownership_transferred' end,
    v_user_id, null, p_transfer_id,
    jsonb_build_object('from_user_id', v_transfer.from_user_id, 'to_user_id', v_user_id, 'kind', v_transfer.kind), p_request_id
  );
  if v_transfer.kind = 'platform_repair' then
    perform public.einrichtung01_platform_event(
      'ownership_repaired', v_user_id, v_transfer.workspace_id, p_transfer_id,
      jsonb_build_object('owner_user_id', v_transfer.from_user_id), jsonb_build_object('owner_user_id', v_user_id), p_request_id
    );
  end if;
  v_result := jsonb_build_object('transfer_id', p_transfer_id, 'workspace_id', v_transfer.workspace_id, 'status', 'accepted', 'changed', true);
  return public.einrichtung01_request_finish('team_accept_transfer', p_request_id, v_result);
end;
$$;

/* ======================================================================== */
/* 6. Betriebsanlage (Weg A) mit Betriebswahl und Einladungsvorrang          */
/* ======================================================================== */

create or replace function public.ensure_personal_workspace(p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_name text;
  v_status text;
  v_license text;
  v_expires timestamptz;
  v_preferred uuid;
  v_email text;
begin
  if v_user_id is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;

  /*
   * EINRICHTUNG-01 (EIN-03, Z-09) -- Aufrufe desselben Kontos laufen nacheinander, gemeinsam mit der Annahme einer
   * Einladung (N-Z5.3). Ein zweiter, gleichzeitiger Aufruf wartet und findet danach den Betrieb des ersten.
   */
  perform pg_advisory_xact_lock(hashtextextended('einrichtung01:ensure_personal_workspace:' || v_user_id::text, 0));

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;

  -- EINRICHTUNG-01 (Stufe 3, Z-01) -- nur ein freigegebenes Konto; ohne Profil gibt es keine Freigabe.
  select p.status, p.license_status, p.license_expires_at, p.preferred_workspace_id
  into v_status, v_license, v_expires, v_preferred
  from public.profiles p
  where p.id = v_user_id;
  if v_status is distinct from 'approved' then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;

  -- EINRICHTUNG-01 (AP4, M-13) -- der gewaehlte Betrieb zuerst, solange die Mitgliedschaft dort aktiv ist.
  if v_preferred is not null then
    select wm.* into v_member
    from public.workspace_members wm
    where wm.user_id = v_user_id and wm.workspace_id = v_preferred and wm.status = 'active';
    if found then
      select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;
      return jsonb_build_object('workspace', to_jsonb(v_workspace), 'member', to_jsonb(v_member), 'created', false);
    end if;
  end if;

  select wm.*
  into v_member
  from public.workspace_members wm
  where wm.user_id = v_user_id
    and wm.status = 'active'
    and wm.role = 'owner'
  order by wm.created_at asc, wm.workspace_id asc
  limit 1;

  if found then
    select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;
    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'created', false
    );
  end if;

  -- FC01A (P2 T8-02): Ein Mitarbeiterkonto erreicht beim ersten Login den Betrieb seiner
  -- bestehenden aktiven Mitgliedschaft, mit genau dieser Rolle. Nichts wird angelegt oder
  -- veraendert; ein fremder Betrieb ist ausgeschlossen (nur eigene Mitgliedschaften).
  select wm.*
  into v_member
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = v_user_id
    and wm.status = 'active'
    and wm.role in ('admin', 'member')
  order by case when wm.role = 'admin' then 0 else 1 end,
           wm.created_at asc,
           wm.workspace_id asc
  limit 1;

  if found then
    select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;
    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'created', false
    );
  end if;

  /*
   * EINRICHTUNG-01 (AP4; Vertrag 1.5, Z-09.5, M-07.4) -- solange fuer die bestaetigte E-Mail eine offene Einladung
   * besteht, entsteht kein eigener Betrieb. Die Oberflaeche zeigt die Einladung mit Annehmen und Ablehnen.
   */
  select public.einrichtung01_email_normalize(u.email) into v_email
  from auth.users u
  where u.id = v_user_id and u.email_confirmed_at is not null;
  if v_email is not null and exists (
    select 1 from public.workspace_invitations i
    where i.email = v_email and i.status = 'open' and i.expires_at > now()
  ) then
    return jsonb_build_object('workspace', null, 'member', null, 'created', false, 'reason', 'invitation_pending');
  end if;

  /*
   * EINRICHTUNG-01 (Weg A, Z-03.1) -- ein eigener Betrieb entsteht nur mit wirksamer eigener Lizenz (sie wird die
   * Betriebslizenz). Sonst wird nichts angelegt; die Antwort nennt den Grund, damit die Oberflaeche den naechsten
   * Schritt zeigen kann, statt eine Einrichtung anzubieten, deren Eingaben nicht gespeichert werden koennten.
   */
  if not (v_license = 'active' and (v_expires is null or v_expires > now())) then
    return jsonb_build_object('workspace', null, 'member', null, 'created', false, 'reason', 'no_license');
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
$function$;

revoke all on function public.ensure_personal_workspace(text) from public, anon, service_role;
grant execute on function public.ensure_personal_workspace(text) to authenticated;

-- Dieselben Stufen fuer die Betriebsbindung ohne Anlage; der gewaehlte Betrieb zuerst (M-13).
create or replace function public.get_active_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_member public.workspace_members;
  v_workspace public.workspaces;
begin
  if v_user_id is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(v_user_id) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;

  select wm.*
  into v_member
  from public.workspace_members wm
  left join public.profiles p on p.id = v_user_id
  where wm.user_id = v_user_id
    and wm.status = 'active'
  order by case when wm.workspace_id = p.preferred_workspace_id then 0 else 1 end,
           case when wm.role = 'owner' then 0 when wm.role = 'admin' then 1 else 2 end,
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
$function$;

/* ======================================================================== */
/* 7. Plattform-Verwaltung (Weg D)                                          */
/* ======================================================================== */

-- Weg D mit Stufe 1 (Vertrag 1.8): Eine beendete Sitzung verwaltet nichts.
create or replace function public.assert_is_admin()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  perform public.workspace_session_active();
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and status is distinct from 'blocked'
  ) then
    raise exception 'Keine Admin-Berechtigung';
  end if;
end;
$function$;

/*
 * Ziel einer Plattformaktion: vorhanden, nicht die eigene Person (P-02, Produktregel: Selbstaenderungen nur durch einen
 * anderen Admin), unter Sperre (Vertrag 1.9). Liefert den Stand vorher fuer die Pruefspur.
 */
create or replace function public.einrichtung01_admin_target(p_user_id uuid)
returns public.profiles
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if p_user_id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'admin_self_action: Die eigene Person aendert nur ein anderer Admin' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles p where p.id = p_user_id for update;
  if v_profile.id is null then
    raise exception 'Benutzer nicht gefunden';
  end if;
  return v_profile;
end;
$$;

revoke all on function public.einrichtung01_admin_target(uuid) from public, anon, authenticated, service_role;

create or replace function public.einrichtung01_admin_snapshot(p_profile public.profiles)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'status', p_profile.status,
    'license_status', p_profile.license_status,
    'license_expires_at', p_profile.license_expires_at
  );
$$;

revoke all on function public.einrichtung01_admin_snapshot(public.profiles) from public, anon, authenticated, service_role;

drop function if exists public.admin_approve_user(uuid);
create or replace function public.admin_approve_user(p_user_id uuid, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_approve_user', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);

  update public.profiles
  set status = 'approved'
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'approve_user', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_approve_user', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

/*
 * P-03 -- nie der letzte nicht gesperrte Plattform-Admin: Alle Adminprofile werden in fester Reihenfolge FOR UPDATE
 * gesperrt; danach wird die handelnde Person erneut geprueft (P-03.3: zwei Admins sperren sich gegenseitig -- genau
 * eine Sperre gelingt).
 */
drop function if exists public.admin_block_user(uuid);
create or replace function public.admin_block_user(p_user_id uuid, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_block_user', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  if p_user_id = auth.uid() then
    raise exception 'admin_self_action: Die eigene Person aendert nur ein anderer Admin' using errcode = '42501';
  end if;

  perform 1 from public.profiles p where p.role = 'admin' order by p.id for update;
  perform public.assert_is_admin();
  v_before := public.einrichtung01_admin_target(p_user_id);
  if v_before.role = 'admin' and v_before.status is distinct from 'blocked' and not exists (
    select 1 from public.profiles p
    where p.role = 'admin' and p.status is distinct from 'blocked' and p.id <> p_user_id
  ) then
    raise exception 'admin_last_admin: Mindestens ein Plattform-Admin muss bleiben' using errcode = '42501';
  end if;

  update public.profiles
  set status = 'blocked'
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'block_user', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_block_user', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

drop function if exists public.admin_activate_license(uuid, timestamptz);
create or replace function public.admin_activate_license(p_user_id uuid, p_expires_at timestamptz default null, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_activate_license', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);

  update public.profiles
  set
    license_status = 'active',
    license_expires_at = p_expires_at
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'activate_license', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_activate_license', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

drop function if exists public.admin_deactivate_license(uuid);
create or replace function public.admin_deactivate_license(p_user_id uuid, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_deactivate_license', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);

  update public.profiles
  set license_status = 'inactive'
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'deactivate_license', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_deactivate_license', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

drop function if exists public.admin_expire_license(uuid);
create or replace function public.admin_expire_license(p_user_id uuid, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_expire_license', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);

  update public.profiles
  set
    license_status = 'expired',
    license_expires_at = coalesce(license_expires_at, now())
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'expire_license', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_expire_license', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

drop function if exists public.admin_set_license_expiry(uuid, timestamptz);
create or replace function public.admin_set_license_expiry(p_user_id uuid, p_expires_at timestamptz, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_set_license_expiry', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);

  update public.profiles
  set license_expires_at = p_expires_at
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'set_license_expiry', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_set_license_expiry', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

drop function if exists public.admin_clear_license_expiry(uuid);
create or replace function public.admin_clear_license_expiry(p_user_id uuid, p_request_id uuid default null)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_clear_license_expiry', p_request_id, false);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);

  update public.profiles
  set license_expires_at = null
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'clear_license_expiry', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_clear_license_expiry', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

/* P-05 -- Freischalten mit Lizenz bis zu einem Datum in der Zukunft: Status, Lizenz und Ablauf in einer Transaktion. */
create or replace function public.admin_approve_with_license(p_user_id uuid, p_expires_at timestamptz, p_request_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_approve_with_license', p_request_id, true);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'admin_expiry_in_past: Das Ablaufdatum muss in der Zukunft liegen' using errcode = '22023';
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);
  if v_before.status = 'blocked' then
    raise exception 'admin_target_blocked: Ein gesperrtes Konto wird nicht freigeschaltet' using errcode = '42501';
  end if;

  update public.profiles
  set status = 'approved', license_status = 'active', license_expires_at = p_expires_at
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'approve_with_license', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_approve_with_license', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

/* P-06 -- verlaengern mit dem gesehenen Ablauf: neuer Ablauf = max(jetzt, gesehener Ablauf) + 30 Tage; sonst Konflikt. */
create or replace function public.admin_extend_license(p_user_id uuid, p_seen_expires_at timestamptz, p_request_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_before public.profiles;
  updated public.profiles;
  v_replay jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('admin_extend_license', p_request_id, true);
  if v_replay is not null then
    select * into updated from public.profiles p where p.id = p_user_id;
    return updated;
  end if;
  v_before := public.einrichtung01_admin_target(p_user_id);
  if v_before.license_expires_at is distinct from p_seen_expires_at then
    raise exception 'admin_license_conflict: Der Ablauf hat sich inzwischen geaendert' using errcode = '40001';
  end if;
  if p_seen_expires_at is null and v_before.license_status = 'active' then
    raise exception 'admin_license_unlimited: Die Lizenz hat kein Ablaufdatum' using errcode = '22023';
  end if;

  update public.profiles
  set license_status = 'active',
      license_expires_at = greatest(now(), coalesce(p_seen_expires_at, now())) + interval '30 days'
  where id = p_user_id
  returning * into updated;

  perform public.einrichtung01_platform_event(
    'extend_license', p_user_id, null, null, public.einrichtung01_admin_snapshot(v_before), public.einrichtung01_admin_snapshot(updated), p_request_id
  );
  perform public.einrichtung01_request_finish('admin_extend_license', p_request_id, jsonb_build_object('user_id', p_user_id));
  return updated;
end;
$function$;

/* P-07 -- Plattform-Pruefspur lesen (nur Plattform-Admins). */
create or replace function public.admin_list_events(p_limit integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.assert_is_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', e.id,
      'action', e.action,
      'actor_user_id', e.actor_user_id,
      'actor_name', public.einrichtung01_display_name(e.actor_user_id),
      'target_user_id', e.target_user_id,
      'target_name', public.einrichtung01_display_name(e.target_user_id),
      'workspace_id', e.workspace_id,
      'before', e.before,
      'after', e.after,
      'created_at', e.created_at
    ) order by e.created_at desc, e.id)
    from (
      select * from public.platform_admin_events x
      order by x.created_at desc, x.id
      limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    ) e
  ), '[]'::jsonb);
end;
$$;

/*
 * 1.6a (E15) -- Betriebe, deren Inhaber nicht handeln kann (gesperrt, nicht freigegeben, ohne Profil), mit den
 * zulaessigen Zielen. Nur Team- und Kontodaten, keine Geschaeftsdaten (P-01.4).
 */
create or replace function public.admin_list_ownership_repair_cases()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.assert_is_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'workspace_id', w.id,
      'workspace_name', w.name,
      'owner_user_id', w.owner_user_id,
      'owner_name', public.einrichtung01_display_name(w.owner_user_id),
      'owner_state', case when op.id is null then 'profile_missing' when op.status = 'blocked' then 'blocked' else op.status end,
      'candidates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', wm.user_id,
          'name', public.einrichtung01_display_name(wm.user_id),
          'email', cp.email,
          'role', wm.role
        ) order by wm.created_at)
        from public.workspace_members wm
        join public.profiles cp on cp.id = wm.user_id
        where wm.workspace_id = w.id
          and wm.user_id <> w.owner_user_id
          and wm.status = 'active'
          and wm.role in ('admin', 'member')
          and cp.status = 'approved'
          and public.einrichtung01_personal_license_effective(wm.user_id)
      ), '[]'::jsonb),
      'open_transfer', (
        select jsonb_build_object('transfer_id', t.id, 'to_user_id', t.to_user_id, 'kind', t.kind, 'expires_at', t.expires_at)
        from public.workspace_ownership_transfers t
        where t.workspace_id = w.id and t.status = 'open'
        limit 1
      )
    ) order by w.created_at)
    from public.workspaces w
    left join public.profiles op on op.id = w.owner_user_id
    where op.id is null or op.status is distinct from 'approved'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.platform_request_ownership_repair(p_workspace_id uuid, p_target_user_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_replay jsonb;
  v_old public.workspace_ownership_transfers;
  v_transfer public.workspace_ownership_transfers;
  v_result jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('platform_request_ownership_repair', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id for update;
  if v_owner is null then
    raise exception 'team_target_invalid: Betrieb nicht gefunden' using errcode = '42501';
  end if;
  perform 1 from public.profiles p where p.id = v_owner for update;
  -- P-09.6: Ist der Inhaber regulaer handlungsfaehig (auch bei nur inaktiver Lizenz), gilt der normale Weg (E16).
  if not public.einrichtung01_owner_unable(p_workspace_id) then
    raise exception 'repair_not_applicable: Der Inhaber kann selbst uebergeben' using errcode = '42501';
  end if;
  perform 1 from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_target_user_id and wm.status = 'active'
  for update;
  perform 1 from public.profiles p where p.id = p_target_user_id for update;
  if p_target_user_id = v_owner
     or public.workspace_account_blocked(p_target_user_id)
     or not public.einrichtung01_transfer_target_ok(p_workspace_id, p_target_user_id) then
    raise exception 'team_target_invalid: Ziel braucht eine aktive Mitgliedschaft, Freigabe und wirksame eigene Lizenz' using errcode = '42501';
  end if;

  for v_old in
    select * from public.workspace_ownership_transfers t
    where t.workspace_id = p_workspace_id and t.status = 'open'
    for update
  loop
    update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = v_old.id;
    perform public.einrichtung01_platform_event(
      'ownership_repair_revoked', v_old.to_user_id, p_workspace_id, v_old.id, null, jsonb_build_object('reason', 'superseded'), p_request_id
    );
  end loop;

  insert into public.workspace_ownership_transfers (workspace_id, kind, from_user_id, to_user_id, requested_by, expires_at)
  values (p_workspace_id, 'platform_repair', v_owner, p_target_user_id, auth.uid(), now() + interval '72 hours')
  returning * into v_transfer;
  perform public.einrichtung01_platform_event(
    'ownership_repair_requested', p_target_user_id, p_workspace_id, v_transfer.id,
    jsonb_build_object('owner_user_id', v_owner), jsonb_build_object('expires_at', v_transfer.expires_at), p_request_id
  );
  perform public.einrichtung01_team_event(
    p_workspace_id, 'ownership_repair_requested', p_target_user_id, null, v_transfer.id,
    jsonb_build_object('expires_at', v_transfer.expires_at), p_request_id
  );
  v_result := jsonb_build_object(
    'transfer_id', v_transfer.id, 'workspace_id', p_workspace_id, 'to_user_id', p_target_user_id,
    'status', 'open', 'expires_at', v_transfer.expires_at
  );
  return public.einrichtung01_request_finish('platform_request_ownership_repair', p_request_id, v_result);
end;
$$;

create or replace function public.platform_revoke_ownership_repair(p_transfer_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_transfer public.workspace_ownership_transfers;
  v_result jsonb;
begin
  perform public.assert_is_admin();
  v_replay := public.einrichtung01_request_begin('platform_revoke_ownership_repair', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_transfer from public.workspace_ownership_transfers t
  where t.id = p_transfer_id and t.kind = 'platform_repair'
  for update;
  if v_transfer.id is null then
    raise exception 'team_target_invalid: Antrag nicht gefunden' using errcode = '42501';
  end if;
  if v_transfer.status <> 'open' then
    v_result := jsonb_build_object('transfer_id', p_transfer_id, 'status', v_transfer.status, 'changed', false);
    return public.einrichtung01_request_finish('platform_revoke_ownership_repair', p_request_id, v_result);
  end if;
  update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = p_transfer_id;
  perform public.einrichtung01_platform_event(
    'ownership_repair_revoked', v_transfer.to_user_id, v_transfer.workspace_id, p_transfer_id, null, jsonb_build_object('reason', 'revoked'), p_request_id
  );
  perform public.einrichtung01_team_event(
    v_transfer.workspace_id, 'ownership_repair_revoked', v_transfer.to_user_id, null, p_transfer_id, jsonb_build_object('reason', 'revoked'), p_request_id
  );
  v_result := jsonb_build_object('transfer_id', p_transfer_id, 'status', 'revoked', 'changed', true);
  return public.einrichtung01_request_finish('platform_revoke_ownership_repair', p_request_id, v_result);
end;
$$;

/* ======================================================================== */
/* 8. Rechte                                                                */
/* ======================================================================== */

revoke all on function public.team_invite(uuid, text, text, uuid) from public, anon, service_role;
revoke all on function public.team_resend_invitation(uuid, uuid) from public, anon, service_role;
revoke all on function public.team_revoke_invitation(uuid, uuid) from public, anon, service_role;
revoke all on function public.team_list_invitations(uuid) from public, anon, service_role;
revoke all on function public.team_invitation_mail_context(uuid, text) from public, anon, service_role;
revoke all on function public.list_my_invitations() from public, anon, service_role;
revoke all on function public.invitation_preview(text) from public, anon, service_role;
revoke all on function public.accept_invitation(uuid, text, uuid) from public, anon, service_role;
revoke all on function public.decline_invitation(uuid, text, uuid) from public, anon, service_role;
revoke all on function public.team_list_members(uuid) from public, anon, service_role;
revoke all on function public.team_change_role(uuid, uuid, text, uuid) from public, anon, service_role;
revoke all on function public.team_remove_member(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.team_leave(uuid, uuid) from public, anon, service_role;
revoke all on function public.team_list_events(uuid, integer) from public, anon, service_role;
revoke all on function public.team_rename_workspace(uuid, text, uuid) from public, anon, service_role;
revoke all on function public.select_active_workspace(uuid) from public, anon, service_role;
revoke all on function public.team_request_transfer(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.team_revoke_transfer(uuid, uuid) from public, anon, service_role;
revoke all on function public.list_my_transfers() from public, anon, service_role;
revoke all on function public.team_open_transfer(uuid) from public, anon, service_role;
revoke all on function public.team_decline_transfer(uuid, uuid) from public, anon, service_role;
revoke all on function public.team_accept_transfer(uuid, uuid) from public, anon, service_role;
revoke all on function public.get_active_workspace() from public, anon, service_role;
revoke all on function public.assert_is_admin() from public, anon, service_role;
revoke all on function public.admin_approve_user(uuid, uuid) from public, anon, service_role;
revoke all on function public.admin_block_user(uuid, uuid) from public, anon, service_role;
revoke all on function public.admin_activate_license(uuid, timestamptz, uuid) from public, anon, service_role;
revoke all on function public.admin_deactivate_license(uuid, uuid) from public, anon, service_role;
revoke all on function public.admin_expire_license(uuid, uuid) from public, anon, service_role;
revoke all on function public.admin_set_license_expiry(uuid, timestamptz, uuid) from public, anon, service_role;
revoke all on function public.admin_clear_license_expiry(uuid, uuid) from public, anon, service_role;
revoke all on function public.admin_approve_with_license(uuid, timestamptz, uuid) from public, anon, service_role;
revoke all on function public.admin_extend_license(uuid, timestamptz, uuid) from public, anon, service_role;
revoke all on function public.admin_list_events(integer) from public, anon, service_role;
revoke all on function public.admin_list_ownership_repair_cases() from public, anon, service_role;
revoke all on function public.platform_request_ownership_repair(uuid, uuid, uuid) from public, anon, service_role;
revoke all on function public.platform_revoke_ownership_repair(uuid, uuid) from public, anon, service_role;

grant execute on function public.team_invite(uuid, text, text, uuid) to authenticated;
grant execute on function public.team_resend_invitation(uuid, uuid) to authenticated;
grant execute on function public.team_revoke_invitation(uuid, uuid) to authenticated;
grant execute on function public.team_list_invitations(uuid) to authenticated;
grant execute on function public.team_invitation_mail_context(uuid, text) to authenticated;
grant execute on function public.list_my_invitations() to authenticated;
grant execute on function public.invitation_preview(text) to authenticated;
grant execute on function public.accept_invitation(uuid, text, uuid) to authenticated;
grant execute on function public.decline_invitation(uuid, text, uuid) to authenticated;
grant execute on function public.team_list_members(uuid) to authenticated;
grant execute on function public.team_change_role(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.team_remove_member(uuid, uuid, uuid) to authenticated;
grant execute on function public.team_leave(uuid, uuid) to authenticated;
grant execute on function public.team_list_events(uuid, integer) to authenticated;
grant execute on function public.team_rename_workspace(uuid, text, uuid) to authenticated;
grant execute on function public.select_active_workspace(uuid) to authenticated;
grant execute on function public.team_request_transfer(uuid, uuid, uuid) to authenticated;
grant execute on function public.team_revoke_transfer(uuid, uuid) to authenticated;
grant execute on function public.list_my_transfers() to authenticated;
grant execute on function public.team_open_transfer(uuid) to authenticated;
grant execute on function public.team_decline_transfer(uuid, uuid) to authenticated;
grant execute on function public.team_accept_transfer(uuid, uuid) to authenticated;
grant execute on function public.get_active_workspace() to authenticated;
grant execute on function public.assert_is_admin() to authenticated;
grant execute on function public.admin_approve_user(uuid, uuid) to authenticated;
grant execute on function public.admin_block_user(uuid, uuid) to authenticated;
grant execute on function public.admin_activate_license(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.admin_deactivate_license(uuid, uuid) to authenticated;
grant execute on function public.admin_expire_license(uuid, uuid) to authenticated;
grant execute on function public.admin_set_license_expiry(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.admin_clear_license_expiry(uuid, uuid) to authenticated;
grant execute on function public.admin_approve_with_license(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.admin_extend_license(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.admin_list_events(integer) to authenticated;
grant execute on function public.admin_list_ownership_repair_cases() to authenticated;
grant execute on function public.platform_request_ownership_repair(uuid, uuid, uuid) to authenticated;
grant execute on function public.platform_revoke_ownership_repair(uuid, uuid) to authenticated;
