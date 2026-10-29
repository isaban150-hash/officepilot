-- EINRICHTUNG-01 / AP7 -- Daten: Bestaetigungsnachweis, Kontoloeschung und Betriebsloeschung (Katalog Teil 2 Fassung 2
-- vom 24.10.2026, Vertraege 1.25, 1.25a, 1.26; Entscheidungen E11, E19, E20; Korrekturgruppen K1, K2, K3, K7).
--
--   * Bestaetigungsnachweis (1.25a): nur als Token-Hash, 5 Minuten, einmal, gebunden an Konto, Aktion, Ziel und
--     Anfrage-ID; verbraucht in der Transaktion der Aktion; Versuchslimit 5 je 15 Minuten.
--   * Kontoloeschung (1.25): dauerhafter Auftrag account_deletion_jobs (requested -> sql_done -> auth_done ->
--     completed); Schritt 1 als eine Transaktion unter Sperre; Auth-Teilschritte einzeln idempotent; Pruefspur genau
--     einmal; Wiederanlauf ueber den Dienstweg.
--   * Betriebsloeschung (1.26): Antrag (open, 30 Tage) -> revoked bzw. deleting -> completed; Sperre (Lease) fuer genau
--     einen Lauf; Arbeitsliste nur aus storage.objects; Ausfuehrung in einer Transaktion ueber den Loeschweg; Protokoll
--     ohne Geschaeftsdaten; D-017-Loeschschutz auch bei DELETE und Kaskade.
--   * Waehrend eines Loeschantrags (deletion_pending): Nur-Lesen mit eigenem Grund; erlaubt bleiben Export, Sicherung,
--     Verlassen, rechtemindernde Teamaktionen (E16) und der Widerruf. 16 Bestandsfunktionen erhalten genau die
--     dafuer noetigen Pruefungen (woertlich aus den juengsten Migrationen; erzeugt mit
--     pruefunterlagen/einrichtung-01/werkzeug/ap7/erzeuge-ap7-migration.mjs; Gleichstand und Zeilendiff im Beleg).
--   * Planer officetakt-workspace-deletion und officetakt-account-deletion-resume: angelegt und INAKTIV (Aktivierung
--     mit RELEASE-01). Jobs 1 und 2 bleiben unveraendert.
--   * Kein Rumpf einer FINANZ-CORE-01A- oder DOKUMENTE-01-RPC wird geaendert (Ausnahme: der Write-Once-Waechter der
--     Nachtraege und die neuen DELETE-Waechter erkennen den Loeschweg). Kein Backfill.
--
-- NUR VORBEREITET (Z-F2): Anwendung auf bestehende Datenbanken erst nach gesonderter Freigabe. Setzt die AP6-Migration
-- 20261202120000 voraus. Nicht remote anwenden (Gesamtveroeffentlichung RELEASE-01).

/* ======================================================================== */
/* 1. Bestaetigungsnachweis fuer zerstoerende Aktionen (1.25a, K1)          */
/* ======================================================================== */

/*
 * Ausgestellt von der Edge Function `confirm-destructive-action` (Dienstrolle), nachdem sie das aktuelle Passwort ueber
 * Supabase Auth gegen die Anmelde-E-Mail aus der Datenbank geprueft und die dabei entstandene Sitzung sofort widerrufen
 * hat. Gespeichert wird nur der SHA-256 des Tokens (256 Bit Zufall). Gebunden an Konto, Aktion, Zielbetrieb (bei der
 * Kontoloeschung leer) und Anfrage-ID; 5 Minuten gueltig; genau einmal verwendbar, verbraucht in derselben Transaktion
 * wie die Aktion.
 */
create table if not exists public.destructive_action_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('account_delete', 'workspace_delete_request')),
  workspace_id uuid,
  request_id uuid not null,
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint destructive_action_confirmations_hash check (token_hash ~ ('^[0-9a-f]{64}' || chr(36))),
  constraint destructive_action_confirmations_target check ((action = 'account_delete') = (workspace_id is null)),
  constraint destructive_action_confirmations_expiry check (expires_at > created_at)
);
create unique index if not exists destructive_action_confirmations_hash_idx on public.destructive_action_confirmations (token_hash);
create index if not exists destructive_action_confirmations_user on public.destructive_action_confirmations (user_id, created_at desc);
alter table public.destructive_action_confirmations enable row level security;
revoke all on public.destructive_action_confirmations from public, anon, authenticated, service_role;

-- Fehlversuche je Konto (gleitend 15 Minuten); danach confirmation_rate_limited ohne Passwortpruefung.
create table if not exists public.destructive_action_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  attempted_at timestamptz not null default now()
);
create index if not exists destructive_action_attempts_window on public.destructive_action_attempts (user_id, attempted_at);
alter table public.destructive_action_attempts enable row level security;
revoke all on public.destructive_action_attempts from public, anon, authenticated, service_role;

/*
 * Vorpruefung (Token der Person; Weg B, 1.1): angemeldet, Sitzung besteht (1.8), Profil vorhanden, nicht gesperrt — auch
 * wartende Konten (L-01.6). Liefert die Anmelde-E-Mail aus der Datenbank (nie aus der Anfrage) und den Stand des
 * Versuchslimits. Gewaehrt keinen Geschaefts-, Datei- oder Datenzugang.
 */
create or replace function public.destructive_action_precheck(p_action text, p_workspace_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_fehlversuche integer;
begin
  if v_user is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if not exists (select 1 from public.profiles p where p.id = v_user) then
    raise exception 'profile_missing: Kein Profil' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(v_user) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('account_delete', 'workspace_delete_request')
     or ((p_action = 'account_delete') <> (p_workspace_id is null)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  select count(*) into v_fehlversuche
    from public.destructive_action_attempts a
   where a.user_id = v_user and a.attempted_at > now() - interval '15 minutes';
  if v_fehlversuche >= 5 then
    return jsonb_build_object('ok', false, 'code', 'confirmation_rate_limited');
  end if;
  select u.email into v_email from auth.users u where u.id = v_user;
  if v_email is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  return jsonb_build_object('ok', true, 'user_id', v_user, 'email', v_email);
end;
$$;

-- Fehlversuch festhalten (Dienstrolle; nach falschem Passwort).
create or replace function public.destructive_action_record_failure(p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.destructive_action_attempts (user_id)
  select p_user_id where p_user_id is not null;
$$;

-- Nachweis ausstellen (Dienstrolle; nach erfolgreicher Passwortpruefung und Widerruf der Pruefsitzung).
create or replace function public.destructive_action_issue(p_user_id uuid, p_action text, p_workspace_id uuid, p_request_id uuid, p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_expires timestamptz := now() + interval '5 minutes';
begin
  if p_user_id is null or p_request_id is null or p_token_hash is null or p_token_hash !~ ('^[0-9a-f]{64}' || chr(36))
     or p_action is null or p_action not in ('account_delete', 'workspace_delete_request')
     or ((p_action = 'account_delete') <> (p_workspace_id is null)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if public.workspace_account_blocked(p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'account_blocked');
  end if;
  insert into public.destructive_action_confirmations (user_id, action, workspace_id, request_id, token_hash, expires_at)
  values (p_user_id, p_action, p_workspace_id, p_request_id, p_token_hash, v_expires);
  return jsonb_build_object('ok', true, 'expires_at', v_expires);
end;
$$;

/*
 * Verbrauch in der Transaktion der Aktion. Ohne Nachweis, abgelaufen, verbraucht, von einem anderen Konto, fuer eine
 * andere Aktion, ein anderes Ziel oder eine andere Anfrage-ID: einheitlich confirmation_invalid (42501), keine Aenderung.
 * Scheitert die Aktion danach, nimmt der Abbruch der Transaktion auch den Verbrauch zurueck.
 */
create or replace function public.einrichtung01_consume_confirmation(p_user_id uuid, p_action text, p_workspace_id uuid, p_request_id uuid, p_token text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row public.destructive_action_confirmations;
begin
  if p_token is not null and p_token ~ ('^[A-Za-z0-9_-]{43}' || chr(36)) then
    select * into v_row
      from public.destructive_action_confirmations c
     where c.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     for update;
  end if;
  if v_row.id is null
     or v_row.user_id is distinct from p_user_id
     or v_row.action is distinct from p_action
     or v_row.workspace_id is distinct from p_workspace_id
     or v_row.request_id is distinct from p_request_id
     or v_row.consumed_at is not null
     or v_row.expires_at <= now() then
    raise exception 'confirmation_invalid: Bestaetigung ungueltig' using errcode = '42501';
  end if;
  update public.destructive_action_confirmations set consumed_at = now() where id = v_row.id;
end;
$$;

/* ======================================================================== */
/* 2. Kontoloeschung als dauerhafter Auftrag (1.25, E11 a, K1, K2)          */
/* ======================================================================== */

alter table public.profiles add column if not exists deleted_at timestamptz;

create table if not exists public.account_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  request_id uuid not null,
  state text not null check (state in ('requested', 'sql_done', 'auth_done', 'completed')),
  pseudonym_email text not null,
  created_at timestamptz not null default now(),
  sql_done_at timestamptz,
  auth_email_done_at timestamptz,
  auth_sessions_done_at timestamptz,
  auth_identities_done_at timestamptz,
  auth_done_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  last_error_code text,
  updated_at timestamptz not null default now()
);
create unique index if not exists account_deletion_jobs_user on public.account_deletion_jobs (user_id);
create unique index if not exists account_deletion_jobs_request on public.account_deletion_jobs (user_id, request_id);
alter table public.account_deletion_jobs enable row level security;
revoke all on public.account_deletion_jobs from public, anon, authenticated, service_role;

create or replace function public.einrichtung01_account_job_json(p_job public.account_deletion_jobs)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('job_id', p_job.id, 'request_id', p_job.request_id, 'state', p_job.state,
    'pseudonym_email', p_job.pseudonym_email, 'last_error_code', p_job.last_error_code);
$$;

/*
 * Schritt 1 (Token der Person, eine Transaktion): Voraussetzungen unter Sperre, Nachweis verbraucht, Mitgliedschaften
 * beendet, Einladungen und Uebergaben beendet, Profil pseudonymisiert und gesperrt, Plattform-Pruefspur genau einmal.
 * Wiederholung mit derselben Anfrage-ID: Stand des Auftrags ohne neuen Nachweis (Idempotenz, eigener Wiederanlauf).
 * Sperren: Betriebszeilen der Mitgliedschaften und Inhaberschaften (id-Reihenfolge), Plattform-Admins (wie die
 * Admin-Sperre), eigenes Profil — dieselben Zeilen wie Uebergabe, Einladungsannahme und Plattform-Adminsperre.
 */
create or replace function public.account_deletion_begin(p_request_id uuid, p_confirmation_token text, p_typed_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_job public.account_deletion_jobs;
  v_profile public.profiles;
  v_email text;
  v_owned jsonb;
  v_member record;
  v_inv record;
  v_tr record;
  v_pseudo text;
begin
  if v_user is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if p_request_id is null then
    raise exception 'request_id_missing: Anfrage-ID fehlt' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('einrichtung01:account_deletion:' || v_user::text, 0));

  -- Bestehender Auftrag: nur derselbe Auftrag ueber dieselbe Anfrage-ID (Stufe 1, Auftragsbesitz).
  select * into v_job from public.account_deletion_jobs j where j.user_id = v_user;
  if v_job.id is not null then
    if v_job.request_id <> p_request_id then
      return jsonb_build_object('ok', false, 'code', 'deletion_request_mismatch');
    end if;
    return public.einrichtung01_account_job_json(v_job) || jsonb_build_object('ok', true, 'replayed', true);
  end if;

  -- Weg B: gesperrte Konten haben keinen Selbstloeschweg.
  if public.workspace_account_blocked(v_user) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;

  perform 1 from public.workspaces w
   where w.owner_user_id = v_user
      or w.id in (select wm.workspace_id from public.workspace_members wm where wm.user_id = v_user and wm.status = 'active')
   order by w.id
   for update;
  if exists (select 1 from public.profiles p where p.id = v_user and p.role = 'admin') then
    perform 1 from public.profiles p where p.role = 'admin' order by p.id for update;
  end if;
  select * into v_profile from public.profiles p where p.id = v_user for update;
  if v_profile.id is null then
    raise exception 'profile_missing: Kein Profil' using errcode = '42501';
  end if;
  if v_profile.status = 'blocked' then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;

  -- E20: kein Betrieb, in dem das Konto Inhaber ist (auch ohne Mitglieder, auch bei nicht wirksamer Lizenz).
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name) order by w.name), '[]'::jsonb)
    into v_owned
    from public.workspaces w where w.owner_user_id = v_user;
  if jsonb_array_length(v_owned) > 0 then
    return jsonb_build_object('ok', false, 'code', 'account_owner', 'workspaces', v_owned,
      'ways', jsonb_build_array('ownership_transfer', 'workspace_delete'));
  end if;
  -- Nicht der letzte nicht gesperrte Plattform-Admin.
  if v_profile.role = 'admin' and not exists (
    select 1 from public.profiles p where p.role = 'admin' and p.status is distinct from 'blocked' and p.id <> v_user
  ) then
    return jsonb_build_object('ok', false, 'code', 'last_platform_admin');
  end if;
  -- Die eingegebene E-Mail vergleicht der Server normalisiert mit der Anmelde-E-Mail.
  select u.email into v_email from auth.users u where u.id = v_user;
  if public.einrichtung01_email_normalize(p_typed_email) is distinct from public.einrichtung01_email_normalize(v_email) then
    return jsonb_build_object('ok', false, 'code', 'email_mismatch');
  end if;

  perform public.einrichtung01_consume_confirmation(v_user, 'account_delete', null, p_request_id, p_confirmation_token);

  v_pseudo := 'geloescht-' || v_user::text || '@invalid.officetakt';
  insert into public.account_deletion_jobs (user_id, request_id, state, pseudonym_email)
  values (v_user, p_request_id, 'requested', v_pseudo)
  returning * into v_job;

  for v_member in
    select wm.workspace_id from public.workspace_members wm where wm.user_id = v_user and wm.status = 'active' order by wm.workspace_id
  loop
    update public.workspace_members set status = 'removed' where workspace_id = v_member.workspace_id and user_id = v_user;
    perform public.einrichtung01_team_event(v_member.workspace_id, 'member_left', v_user, null, null,
      jsonb_build_object('reason', 'account_deleted'), p_request_id);
  end loop;

  for v_inv in
    select i.id, i.workspace_id from public.workspace_invitations i
     where i.status = 'open' and i.email = public.einrichtung01_email_normalize(v_email)
  loop
    update public.workspace_invitations set status = 'revoked', decided_at = now() where id = v_inv.id;
    perform public.einrichtung01_team_event(v_inv.workspace_id, 'invitation_revoked', null, v_inv.id, null,
      jsonb_build_object('reason', 'account_deleted'), p_request_id);
  end loop;

  for v_tr in
    select t.id, t.workspace_id, t.kind from public.workspace_ownership_transfers t
     where t.status = 'open' and (t.to_user_id = v_user or t.from_user_id = v_user)
  loop
    update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = v_tr.id;
    perform public.einrichtung01_team_event(v_tr.workspace_id,
      case when v_tr.kind = 'platform_repair' then 'ownership_repair_revoked' else 'ownership_transfer_revoked' end,
      null, null, v_tr.id, jsonb_build_object('reason', 'account_deleted'), p_request_id);
  end loop;

  update public.profiles
     set first_name = 'Gelöschtes', last_name = 'Konto', company_name = '', phone = null, email = v_pseudo,
         deleted_at = now(), status = 'blocked', preferred_workspace_id = null
   where id = v_user;

  perform public.einrichtung01_platform_event('account_deletion_started', v_user, null, null, null,
    jsonb_build_object('job_id', v_job.id), p_request_id);

  update public.account_deletion_jobs
     set state = 'sql_done', sql_done_at = now(), updated_at = now()
   where id = v_job.id
  returning * into v_job;
  return public.einrichtung01_account_job_json(v_job) || jsonb_build_object('ok', true);
end;
$$;

/*
 * Schritt 2 (Dienstrolle), je Teilschritt einzeln idempotent: 'email' (Admin-API: Pseudonym-E-Mail, Zufallspasswort,
 * Sperre, Metadaten geleert — von der Function ausgefuehrt und hier vermerkt), 'sessions' (alle Sitzungen und
 * Refresh-Tokens), 'identities' (alle Identitaeten). Ein vermerkter Teilschritt wirkt kein zweites Mal. 'error' haelt
 * nur Versuch und Fehlercode fest (ohne Geheimnisse). Sind alle drei vermerkt: auth_done.
 */
create or replace function public.account_deletion_auth_step(p_job_id uuid, p_step text, p_error_code text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.account_deletion_jobs;
begin
  select * into v_job from public.account_deletion_jobs j where j.id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.state not in ('sql_done', 'auth_done', 'completed') then
    return jsonb_build_object('ok', false, 'code', 'job_state_invalid');
  end if;
  if p_step = 'error' then
    update public.account_deletion_jobs
       set attempts = attempts + 1, last_error_code = left(coalesce(p_error_code, 'unknown'), 80), updated_at = now()
     where id = v_job.id returning * into v_job;
    return public.einrichtung01_account_job_json(v_job) || jsonb_build_object('ok', true);
  end if;
  if v_job.state = 'sql_done' then
    if p_step = 'email' and v_job.auth_email_done_at is null then
      update public.account_deletion_jobs set auth_email_done_at = now(), updated_at = now() where id = v_job.id;
    elsif p_step = 'sessions' and v_job.auth_sessions_done_at is null then
      delete from auth.sessions where user_id = v_job.user_id;
      delete from auth.refresh_tokens where user_id = v_job.user_id::text;
      update public.account_deletion_jobs set auth_sessions_done_at = now(), updated_at = now() where id = v_job.id;
    elsif p_step = 'identities' and v_job.auth_identities_done_at is null then
      delete from auth.identities where user_id = v_job.user_id;
      update public.account_deletion_jobs set auth_identities_done_at = now(), updated_at = now() where id = v_job.id;
    elsif p_step not in ('email', 'sessions', 'identities') then
      return jsonb_build_object('ok', false, 'code', 'invalid_request');
    end if;
    update public.account_deletion_jobs
       set state = 'auth_done', auth_done_at = now(), last_error_code = null, updated_at = now()
     where id = v_job.id
       and auth_email_done_at is not null and auth_sessions_done_at is not null and auth_identities_done_at is not null;
  end if;
  select * into v_job from public.account_deletion_jobs j where j.id = p_job_id;
  return public.einrichtung01_account_job_json(v_job) || jsonb_build_object('ok', true);
end;
$$;

-- Schritt 3 (Dienstrolle): Abschluss, Plattform-Pruefspur account_deleted genau einmal je Auftrag.
create or replace function public.account_deletion_complete(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.account_deletion_jobs;
begin
  select * into v_job from public.account_deletion_jobs j where j.id = p_job_id for update;
  if v_job.id is null then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.state = 'auth_done' then
    update public.account_deletion_jobs set state = 'completed', completed_at = now(), updated_at = now()
     where id = v_job.id returning * into v_job;
    insert into public.platform_admin_events (actor_user_id, action, target_user_id, workspace_id, transfer_id, before, after, request_id)
    -- Handelnd ist das Konto selbst (der Auftrag gehoert ihm); die Pruefspur verlangt einen Handelnden.
    values (v_job.user_id, 'account_deleted', v_job.user_id, null, null, null, jsonb_build_object('job_id', v_job.id), v_job.request_id);
  elsif v_job.state <> 'completed' then
    return public.einrichtung01_account_job_json(v_job) || jsonb_build_object('ok', false, 'code', 'job_state_invalid');
  end if;
  return public.einrichtung01_account_job_json(v_job) || jsonb_build_object('ok', true);
end;
$$;

-- Dienstweg: offene Auftraege (sql_done, auth_done) fuer den Wiederanlauf; ein einzelner Auftrag.
create or replace function public.account_deletion_pending_jobs(p_limit integer default 50)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.einrichtung01_account_job_json(j) || jsonb_build_object('user_id', j.user_id,
    'auth_email_done', j.auth_email_done_at is not null, 'auth_sessions_done', j.auth_sessions_done_at is not null,
    'auth_identities_done', j.auth_identities_done_at is not null)
  from public.account_deletion_jobs j
  where j.state in ('sql_done', 'auth_done')
  order by j.created_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.account_deletion_job(p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.einrichtung01_account_job_json(j) || jsonb_build_object('user_id', j.user_id,
    'auth_email_done', j.auth_email_done_at is not null, 'auth_sessions_done', j.auth_sessions_done_at is not null,
    'auth_identities_done', j.auth_identities_done_at is not null)
  from public.account_deletion_jobs j
  where j.id = p_job_id;
$$;

/* ======================================================================== */
/* 3. Betriebsloeschung (1.26, E11 b, K1, K3, K7)                           */
/* ======================================================================== */

-- Antrag, Arbeitsliste und Protokoll haengen bewusst nicht per Kaskade am Betrieb und bleiben nach completed erhalten.
create table if not exists public.workspace_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  requested_by uuid not null,
  request_id uuid not null,
  retention_notice_version text not null,
  retention_confirmed_at timestamptz not null,
  state text not null check (state in ('open', 'revoked', 'deleting', 'completed')),
  requested_at timestamptz not null default now(),
  execute_after timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  deleting_since timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  last_error_code text,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint workspace_deletion_requests_request unique (requested_by, request_id)
);
create unique index if not exists workspace_deletion_requests_active on public.workspace_deletion_requests (workspace_id)
  where state in ('open', 'deleting');
create index if not exists workspace_deletion_requests_due on public.workspace_deletion_requests (state, execute_after);
alter table public.workspace_deletion_requests enable row level security;
revoke all on public.workspace_deletion_requests from public, anon, authenticated, service_role;

-- Arbeitsliste: allein aus storage.objects (Praefix <workspace_id>/ in den fuenf Buckets), nie aus einer Anfrage.
create table if not exists public.workspace_deletion_objects (
  id bigint generated always as identity primary key,
  deletion_id uuid not null references public.workspace_deletion_requests(id) on delete cascade,
  bucket_id text not null,
  object_name text not null,
  listed_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint workspace_deletion_objects_unique unique (deletion_id, bucket_id, object_name)
);
alter table public.workspace_deletion_objects enable row level security;
revoke all on public.workspace_deletion_objects from public, anon, authenticated, service_role;

-- Loeschprotokoll: Kennung, Zeit, Anzahl je Tabelle — keine Geschaeftsdaten.
create table if not exists public.workspace_deletion_log (
  id uuid primary key default gen_random_uuid(),
  deletion_id uuid not null,
  workspace_id uuid not null,
  executed_at timestamptz not null default now(),
  table_counts jsonb not null,
  object_count integer not null
);
create unique index if not exists workspace_deletion_log_once on public.workspace_deletion_log (deletion_id);
alter table public.workspace_deletion_log enable row level security;
revoke all on public.workspace_deletion_log from public, anon, authenticated, service_role;

/* Fassung des Aufbewahrungs- und Exporthinweises, den der Inhaber bestaetigt (K3). */
create or replace function public.workspace_deletion_notice_version()
returns text
language sql
immutable
as $$ select '2026-10-25'::text $$;

create or replace function public.workspace_deletion_pending(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_deletion_requests r
    where r.workspace_id = p_workspace_id and r.state in ('open', 'deleting')
  );
$$;

create or replace function public.workspace_deletion_status(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_build_object('state', r.state, 'execute_after', r.execute_after, 'requested_at', r.requested_at)
    from public.workspace_deletion_requests r
    where r.workspace_id = p_workspace_id and r.state in ('open', 'deleting')
    order by r.requested_at desc
    limit 1
  ), jsonb_build_object('state', null));
$$;

/*
 * Der Loeschweg ist nur aktiv, wenn workspace_deletion_execute den Marker in dieser Transaktion gesetzt hat UND fuer
 * genau diesen Betrieb ein Auftrag deleting mit gueltiger Sperre besteht (K3). Ein selbst gesetzter Marker ohne solchen
 * Auftrag aendert nichts.
 */
create or replace function public.einrichtung01_deletion_path_active(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(current_setting('officetakt.loeschweg', true), '') = pg_current_xact_id()::text
     and exists (
       select 1 from public.workspace_deletion_requests r
       where r.workspace_id = p_workspace_id and r.state = 'deleting'
         and r.lease_owner is not null and r.lease_expires_at > now()
     );
$$;

/* Handlungsfaehiger Inhaber (freigegeben, nicht gesperrt) — unabhaengig von der Betriebslizenz (E19). */
create or replace function public.einrichtung01_deletion_owner(p_workspace_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_role text;
begin
  if v_user is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  perform public.workspace_session_active();
  if not exists (select 1 from public.profiles p where p.id = v_user) then
    raise exception 'profile_missing: Kein Profil' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(v_user) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(v_user) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;
  select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id for update;
  select wm.role into v_role from public.workspace_members wm
   where wm.workspace_id = p_workspace_id and wm.user_id = v_user and wm.status = 'active';
  if v_role is null then
    raise exception 'team_not_member: Kein Zugriff auf Workspace' using errcode = '42501';
  end if;
  if v_role <> 'owner' or v_owner is distinct from v_user then
    raise exception 'team_forbidden_role: Nur der Inhaber' using errcode = '42501';
  end if;
end;
$$;

/*
 * Antrag (nur der handlungsfaehige Inhaber, auch bei nicht wirksamer Lizenz): Nachweis fuer genau diesen Betrieb und
 * diese Anfrage-ID, exakter Name, aktuelle Fassung des bestaetigten Hinweises; Frist 30 Tage; offene Einladungen und
 * Uebergaben (1.6, 1.6a) beendet; Pruefspur mit Hinweisfassung. Idempotent.
 */
create or replace function public.workspace_request_deletion(p_workspace_id uuid, p_typed_name text, p_retention_notice_version text,
  p_confirmation_token text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_replay jsonb;
  v_name text;
  v_existing public.workspace_deletion_requests;
  v_req public.workspace_deletion_requests;
  v_inv record;
  v_tr record;
  v_result jsonb;
begin
  v_replay := public.einrichtung01_request_begin('workspace_request_deletion', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  perform public.einrichtung01_deletion_owner(p_workspace_id);

  select * into v_existing from public.workspace_deletion_requests r
   where r.workspace_id = p_workspace_id and r.state in ('open', 'deleting') for update;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'state', v_existing.state, 'execute_after', v_existing.execute_after, 'already', true);
  end if;

  select w.name into v_name from public.workspaces w where w.id = p_workspace_id;
  if p_typed_name is null or btrim(p_typed_name) <> v_name then
    return jsonb_build_object('ok', false, 'code', 'name_mismatch');
  end if;
  if p_retention_notice_version is distinct from public.workspace_deletion_notice_version() then
    return jsonb_build_object('ok', false, 'code', 'notice_outdated');
  end if;

  perform public.einrichtung01_consume_confirmation(v_user, 'workspace_delete_request', p_workspace_id, p_request_id, p_confirmation_token);

  insert into public.workspace_deletion_requests (workspace_id, requested_by, request_id, retention_notice_version,
    retention_confirmed_at, state, execute_after)
  values (p_workspace_id, v_user, p_request_id, p_retention_notice_version, now(), 'open', now() + interval '30 days')
  returning * into v_req;

  for v_inv in select i.id from public.workspace_invitations i where i.workspace_id = p_workspace_id and i.status = 'open' loop
    update public.workspace_invitations set status = 'revoked', decided_at = now() where id = v_inv.id;
    perform public.einrichtung01_team_event(p_workspace_id, 'invitation_revoked', null, v_inv.id, null,
      jsonb_build_object('reason', 'deletion_requested'), p_request_id);
  end loop;
  for v_tr in select t.id, t.kind from public.workspace_ownership_transfers t where t.workspace_id = p_workspace_id and t.status = 'open' loop
    update public.workspace_ownership_transfers set status = 'revoked', decided_at = now() where id = v_tr.id;
    perform public.einrichtung01_team_event(p_workspace_id,
      case when v_tr.kind = 'platform_repair' then 'ownership_repair_revoked' else 'ownership_transfer_revoked' end,
      null, null, v_tr.id, jsonb_build_object('reason', 'deletion_requested'), p_request_id);
  end loop;

  perform public.einrichtung01_team_event(p_workspace_id, 'deletion_requested', null, null, null,
    jsonb_build_object('retention_notice_version', v_req.retention_notice_version, 'retention_confirmed_at', v_req.retention_confirmed_at,
      'execute_after', v_req.execute_after), p_request_id);

  v_result := jsonb_build_object('ok', true, 'state', 'open', 'execute_after', v_req.execute_after);
  return public.einrichtung01_request_finish('workspace_request_deletion', p_request_id, v_result);
end;
$$;

-- Widerruf: nur der Inhaber und nur im Zustand open; ab deleting deletion_in_progress (K3).
create or replace function public.workspace_revoke_deletion(p_workspace_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_req public.workspace_deletion_requests;
  v_result jsonb;
begin
  v_replay := public.einrichtung01_request_begin('workspace_revoke_deletion', p_request_id, true);
  if v_replay is not null then
    return v_replay;
  end if;
  perform public.einrichtung01_deletion_owner(p_workspace_id);
  select * into v_req from public.workspace_deletion_requests r
   where r.workspace_id = p_workspace_id and r.state in ('open', 'deleting') for update;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'code', 'deletion_not_requested');
  end if;
  if v_req.state = 'deleting' then
    raise exception 'deletion_in_progress: Die Loeschung laeuft bereits' using errcode = '42501';
  end if;
  update public.workspace_deletion_requests
     set state = 'revoked', revoked_at = now(), revoked_by = auth.uid(), updated_at = now()
   where id = v_req.id;
  perform public.einrichtung01_team_event(p_workspace_id, 'deletion_revoked', null, null, null,
    jsonb_build_object('requested_at', v_req.requested_at), p_request_id);
  v_result := jsonb_build_object('ok', true, 'state', 'revoked');
  return public.einrichtung01_request_finish('workspace_revoke_deletion', p_request_id, v_result);
end;
$$;

-- Dienstweg: faellige Antraege (Frist abgelaufen) und deleting-Auftraege mit abgelaufener Sperre.
create or replace function public.workspace_deletion_due(p_limit integer default 20)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select r.workspace_id
  from public.workspace_deletion_requests r
  where (r.state = 'open' and r.execute_after <= now())
     or (r.state = 'deleting' and (r.lease_expires_at is null or r.lease_expires_at <= now()))
  order by r.execute_after
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function public.einrichtung01_deletion_buckets()
returns text[]
language sql
immutable
as $$
  select array['branding-assets', 'document-deliveries', 'email-attachments', 'inbound-email-attachments', 'workspace-files']::text[];
$$;

/*
 * Beginn bzw. Fortsetzung (Dienstrolle): wirkt nur fuer einen Antrag open mit abgelaufener Frist oder einen Auftrag
 * deleting ohne gueltige fremde Sperre. Vergibt die Sperre (Lease) an genau einen Lauf und fuehrt die Arbeitsliste aus
 * storage.objects nach. Ein zweiter Lauf mit gueltiger fremder Sperre tut nichts.
 */
create or replace function public.workspace_deletion_begin(p_workspace_id uuid, p_runner uuid, p_lease_seconds integer default 600)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req public.workspace_deletion_requests;
  v_objekte jsonb;
begin
  if p_workspace_id is null or p_runner is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  select * into v_req from public.workspace_deletion_requests r
   where r.workspace_id = p_workspace_id and r.state in ('open', 'deleting', 'completed')
   order by case r.state when 'deleting' then 0 when 'open' then 1 else 2 end, r.requested_at desc
   limit 1
   for update;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'code', 'deletion_not_requested');
  end if;
  if v_req.state = 'completed' then
    return jsonb_build_object('ok', true, 'state', 'completed');
  end if;
  if v_req.state = 'open' then
    if v_req.execute_after > now() then
      return jsonb_build_object('ok', false, 'code', 'deletion_not_due', 'execute_after', v_req.execute_after);
    end if;
    update public.workspace_deletion_requests
       set state = 'deleting', deleting_since = now(), lease_owner = p_runner,
           lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 3600))),
           attempts = attempts + 1, updated_at = now()
     where id = v_req.id returning * into v_req;
  else
    if v_req.lease_owner is distinct from p_runner and v_req.lease_expires_at > now() then
      return jsonb_build_object('ok', false, 'code', 'deletion_locked');
    end if;
    update public.workspace_deletion_requests
       set lease_owner = p_runner,
           lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 600), 3600))),
           attempts = attempts + 1, updated_at = now()
     where id = v_req.id returning * into v_req;
  end if;

  insert into public.workspace_deletion_objects (deletion_id, bucket_id, object_name)
  select v_req.id, o.bucket_id, o.name
    from storage.objects o
   where o.bucket_id = any (public.einrichtung01_deletion_buckets())
     and left(o.name, 37) = p_workspace_id::text || '/'
  on conflict (deletion_id, bucket_id, object_name) do nothing;

  select coalesce(jsonb_agg(jsonb_build_object('bucket', d.bucket_id, 'name', d.object_name) order by d.id), '[]'::jsonb)
    into v_objekte
    from public.workspace_deletion_objects d
   where d.deletion_id = v_req.id and d.deleted_at is null;
  return jsonb_build_object('ok', true, 'state', 'deleting', 'deletion_id', v_req.id, 'objects', v_objekte);
end;
$$;

-- Geloeschte Objekte vermerken (Dienstrolle, nur mit eigener Sperre; nur Eintraege der Arbeitsliste).
create or replace function public.workspace_deletion_mark_objects(p_workspace_id uuid, p_runner uuid, p_objects jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req public.workspace_deletion_requests;
  v_anzahl integer;
begin
  select * into v_req from public.workspace_deletion_requests r
   where r.workspace_id = p_workspace_id and r.state = 'deleting' for update;
  if v_req.id is null or v_req.lease_owner is distinct from p_runner or v_req.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'deletion_locked');
  end if;
  update public.workspace_deletion_objects d
     set deleted_at = now()
    from jsonb_to_recordset(coalesce(p_objects, '[]'::jsonb)) as x(bucket text, name text)
   where d.deletion_id = v_req.id and d.bucket_id = x.bucket and d.object_name = x.name and d.deleted_at is null;
  get diagnostics v_anzahl = row_count;
  return jsonb_build_object('ok', true, 'marked', v_anzahl);
end;
$$;

-- Fehlercode eines Laufs festhalten (Dienstrolle; der Auftrag bleibt deleting).
create or replace function public.workspace_deletion_fail(p_workspace_id uuid, p_runner uuid, p_error_code text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.workspace_deletion_requests
     set last_error_code = left(coalesce(p_error_code, 'unknown'), 80), updated_at = now()
   where workspace_id = p_workspace_id and state = 'deleting' and lease_owner = p_runner;
$$;

/*
 * Ausfuehrung (Dienstrolle) in EINER Transaktion: nur mit eigener gueltiger Sperre, leerer Arbeitsliste und ohne Objekte
 * unter dem Praefix. Loescht alle Zeilen aller public-Tabellen mit workspace_id (ueber den Loeschweg auch D-017-
 * geschuetzte), die Vault-Geheimnisse der Postfachverbindungen und den Betrieb; schreibt das Protokoll und setzt
 * completed. Scheitert sie, wird alles zurueckgenommen; der Auftrag bleibt deleting. Ausgenommen sind die Loeschtabellen
 * selbst und die Plattform-Pruefspur (platform_admin_events, ohne Geschaeftsdaten).
 */
create or replace function public.workspace_deletion_execute(p_workspace_id uuid, p_runner uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_req public.workspace_deletion_requests;
  v_tabelle text;
  v_anzahl bigint;
  v_zahlen jsonb := '{}'::jsonb;
  v_secret uuid;
  v_objekte integer;
  v_ausgenommen constant text[] := array['workspace_deletion_requests', 'workspace_deletion_objects', 'workspace_deletion_log', 'platform_admin_events'];
begin
  select * into v_req from public.workspace_deletion_requests r
   where r.workspace_id = p_workspace_id and r.state in ('deleting', 'completed')
   order by case r.state when 'deleting' then 0 else 1 end, r.requested_at desc
   limit 1
   for update;
  if v_req.id is null then
    return jsonb_build_object('ok', false, 'code', 'deletion_not_started');
  end if;
  if v_req.state = 'completed' then
    return jsonb_build_object('ok', true, 'state', 'completed', 'replayed', true);
  end if;
  if v_req.lease_owner is distinct from p_runner or v_req.lease_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'deletion_locked');
  end if;
  if exists (select 1 from public.workspace_deletion_objects d where d.deletion_id = v_req.id and d.deleted_at is null)
     or exists (
       select 1 from storage.objects o
        where o.bucket_id = any (public.einrichtung01_deletion_buckets()) and left(o.name, 37) = p_workspace_id::text || '/'
     ) then
    return jsonb_build_object('ok', false, 'code', 'objects_remaining');
  end if;

  perform set_config('officetakt.loeschweg', pg_current_xact_id()::text, true);

  for v_tabelle in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
       and c.table_name <> all (v_ausgenommen)
     order by c.table_name
  loop
    execute format('select count(*) from public.%I where workspace_id = $1', v_tabelle) into v_anzahl using p_workspace_id;
    if v_anzahl > 0 then
      v_zahlen := v_zahlen || jsonb_build_object(v_tabelle, v_anzahl);
    end if;
  end loop;

  for v_secret in
    select cr.vault_secret_id from public.workspace_mailbox_credentials cr
      join public.workspace_mailbox_connections c on c.id = cr.connection_id
     where c.workspace_id = p_workspace_id and cr.vault_secret_id is not null
  loop
    perform public.mailbox_delete_vault_secret(v_secret);
  end loop;

  -- Tabellen ohne Kaskade vom Betrieb zuerst (etwa Papierregister-Inhaberwechsel, Nachweise), dann der Betrieb selbst
  -- (Kaskade auf alle uebrigen; die Trigger der Kaskade laufen mit Ausloesetiefe > 1).
  for v_tabelle in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
       and c.table_name <> all (v_ausgenommen)
       and not exists (
         select 1 from pg_constraint k
          where k.contype = 'f' and k.conrelid = format('public.%I', c.table_name)::regclass
            and k.confrelid = 'public.workspaces'::regclass and k.confdeltype = 'c'
       )
     order by c.table_name
  loop
    execute format('delete from public.%I where workspace_id = $1', v_tabelle) using p_workspace_id;
  end loop;
  delete from public.workspaces where id = p_workspace_id;

  for v_tabelle in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
       and c.table_name <> all (v_ausgenommen)
  loop
    execute format('select count(*) from public.%I where workspace_id = $1', v_tabelle) into v_anzahl using p_workspace_id;
    if v_anzahl > 0 then
      raise exception 'deletion_incomplete: Zeilen verbleiben in %', v_tabelle using errcode = 'P0001';
    end if;
  end loop;

  select count(*) into v_objekte from public.workspace_deletion_objects d where d.deletion_id = v_req.id;
  insert into public.workspace_deletion_log (deletion_id, workspace_id, table_counts, object_count)
  values (v_req.id, p_workspace_id, v_zahlen, v_objekte);
  update public.workspace_deletion_requests
     set state = 'completed', completed_at = now(), lease_owner = null, lease_expires_at = null, last_error_code = null,
         updated_at = now()
   where id = v_req.id;
  return jsonb_build_object('ok', true, 'state', 'completed', 'table_counts', v_zahlen, 'object_count', v_objekte);
end;
$$;

/* D-017 (L-06): DELETE auf geschuetzte Zeilen nur ueber den Loeschweg — auch die Kaskade von workspaces. */
create or replace function public.workspace_documents_retention_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aufbewahrung record;
begin
  if public.einrichtung01_deletion_path_active(old.workspace_id) then
    return old;
  end if;
  if coalesce(old.deleted, false) or old.deleted_at is not null then
    return old;
  end if;
  select * into v_aufbewahrung from public.workspace_document_retention(old);
  if v_aufbewahrung.frist_status = 'laeuft' then
    raise exception 'Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis % (%, % Jahre)',
      to_char(v_aufbewahrung.frist_ende, 'DD.MM.YYYY'), v_aufbewahrung.klasse, v_aufbewahrung.jahre
      using errcode = '42501';
  end if;
  return old;
end;
$$;

create or replace function public.workspace_document_file_bindings_retention_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.workspace_documents;
  v_aufbewahrung record;
begin
  if public.einrichtung01_deletion_path_active(old.workspace_id) then
    return old;
  end if;
  if old.binding_kind <> 'original' or coalesce(old.deleted, false) then
    return old;
  end if;
  select * into v_document from public.workspace_documents d
   where d.workspace_id = old.workspace_id and d.client_document_id = old.client_document_id;
  if v_document.id is null or coalesce(v_document.deleted, false) or v_document.deleted_at is not null then
    return old;
  end if;
  select * into v_aufbewahrung from public.workspace_document_retention(v_document);
  if v_aufbewahrung.frist_status = 'laeuft' then
    raise exception 'Keine Schreibberechtigung: Original eines Dokuments mit Aufbewahrungsfrist bis %',
      to_char(v_aufbewahrung.frist_ende, 'DD.MM.YYYY')
      using errcode = '42501';
  end if;
  return old;
end;
$$;

create or replace function public.workspace_files_retention_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.workspace_documents;
  v_aufbewahrung record;
begin
  if public.einrichtung01_deletion_path_active(old.workspace_id) then
    return old;
  end if;
  if coalesce(old.deleted, false) then
    return old;
  end if;
  for v_document in
    select d.* from public.workspace_document_file_bindings b
      join public.workspace_documents d on d.workspace_id = b.workspace_id and d.client_document_id = b.client_document_id
     where b.workspace_id = old.workspace_id and b.client_file_ref_id = old.client_file_ref_id
       and b.binding_kind = 'original' and not b.deleted and not coalesce(d.deleted, false) and d.deleted_at is null
  loop
    select * into v_aufbewahrung from public.workspace_document_retention(v_document);
    if v_aufbewahrung.frist_status = 'laeuft' then
      raise exception 'Keine Schreibberechtigung: Datei eines Dokuments mit Aufbewahrungsfrist bis %',
        to_char(v_aufbewahrung.frist_ende, 'DD.MM.YYYY')
        using errcode = '42501';
    end if;
  end loop;
  return old;
end;
$$;

revoke all on function public.workspace_documents_retention_delete_guard() from public, anon, authenticated, service_role;
revoke all on function public.workspace_document_file_bindings_retention_delete_guard() from public, anon, authenticated, service_role;
revoke all on function public.workspace_files_retention_delete_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_documents_retention_delete_guard on public.workspace_documents;
create trigger workspace_documents_retention_delete_guard
  before delete on public.workspace_documents
  for each row execute function public.workspace_documents_retention_delete_guard();
drop trigger if exists workspace_document_file_bindings_retention_delete_guard on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_retention_delete_guard
  before delete on public.workspace_document_file_bindings
  for each row execute function public.workspace_document_file_bindings_retention_delete_guard();
drop trigger if exists workspace_files_retention_delete_guard on public.workspace_files;
create trigger workspace_files_retention_delete_guard
  before delete on public.workspace_files
  for each row execute function public.workspace_files_retention_delete_guard();

/* Neue Pruefspur-Aktionen des Betriebs. */
alter table public.workspace_member_events drop constraint if exists workspace_member_events_action_check;
alter table public.workspace_member_events add constraint workspace_member_events_action_check check (action = any (array[
  'invitation_created', 'invitation_resent', 'invitation_revoked', 'invitation_accepted', 'invitation_declined',
  'account_approved_by_invitation', 'member_role_changed', 'member_removed', 'member_left', 'ownership_transfer_requested',
  'ownership_transfer_revoked', 'ownership_transfer_declined', 'ownership_transferred', 'ownership_repair_requested',
  'ownership_repair_revoked', 'ownership_repaired', 'workspace_renamed', 'deletion_requested', 'deletion_revoked'
]::text[]));

/* ======================================================================== */
/* 4. Planer (lokal inaktiv; Aktivierung mit RELEASE-01)                     */
/* ======================================================================== */

create or replace function public.einrichtung01_scheduler_secret_valid(p_name text, p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  if p_name not in ('officetakt_workspace_deletion_secret', 'officetakt_account_deletion_secret')
     or p_secret is null or length(p_secret) < 32 or length(p_secret) > 256 then
    return false;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = p_name;
  return v_secret is not null and length(v_secret) >= 32 and v_secret = p_secret;
end;
$$;

create or replace function public.einrichtung01_scheduler_dispatch(p_url_name text, p_secret_name text)
returns bigint
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = p_url_name;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = p_secret_name;
  if v_url is null or v_secret is null or v_url !~ '^https?://' then
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('trigger', 'cron'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-officetakt-scheduler', v_secret),
    timeout_milliseconds := 150000
  );
end;
$$;

create or replace function public.workspace_deletion_dispatch()
returns bigint
language sql
security definer
set search_path = public
as $$
  select case when exists (select 1 from public.workspace_deletion_due(1))
    then public.einrichtung01_scheduler_dispatch('officetakt_workspace_deletion_url', 'officetakt_workspace_deletion_secret')
  end;
$$;

create or replace function public.account_deletion_resume_dispatch()
returns bigint
language sql
security definer
set search_path = public
as $$
  select case when exists (select 1 from public.account_deletion_jobs j where j.state in ('sql_done', 'auth_done'))
    then public.einrichtung01_scheduler_dispatch('officetakt_account_deletion_url', 'officetakt_account_deletion_secret')
  end;
$$;

do $cron$
declare
  v_id bigint;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    select cron.schedule('officetakt-workspace-deletion', '23 3 * * *', 'select public.workspace_deletion_dispatch()') into v_id;
    perform cron.alter_job(v_id, active := false);
    select cron.schedule('officetakt-account-deletion-resume', '41 * * * *', 'select public.account_deletion_resume_dispatch()') into v_id;
    perform cron.alter_job(v_id, active := false);
  end if;
end;
$cron$;

/* ======================================================================== */
/* 5. Rechte                                                                 */
/* ======================================================================== */

revoke all on function public.destructive_action_precheck(text, uuid) from public, anon;
grant execute on function public.destructive_action_precheck(text, uuid) to authenticated;
revoke all on function public.destructive_action_record_failure(uuid) from public, anon, authenticated;
revoke all on function public.destructive_action_issue(uuid, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.destructive_action_record_failure(uuid) to service_role;
grant execute on function public.destructive_action_issue(uuid, text, uuid, uuid, text) to service_role;
revoke all on function public.einrichtung01_consume_confirmation(uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;

revoke all on function public.einrichtung01_account_job_json(public.account_deletion_jobs) from public, anon, authenticated, service_role;
revoke all on function public.account_deletion_begin(uuid, text, text) from public, anon;
grant execute on function public.account_deletion_begin(uuid, text, text) to authenticated;
revoke all on function public.account_deletion_auth_step(uuid, text, text) from public, anon, authenticated;
revoke all on function public.account_deletion_complete(uuid) from public, anon, authenticated;
revoke all on function public.account_deletion_pending_jobs(integer) from public, anon, authenticated;
revoke all on function public.account_deletion_job(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_auth_step(uuid, text, text) to service_role;
grant execute on function public.account_deletion_complete(uuid) to service_role;
grant execute on function public.account_deletion_pending_jobs(integer) to service_role;
grant execute on function public.account_deletion_job(uuid) to service_role;

revoke all on function public.workspace_deletion_notice_version() from public, anon;
grant execute on function public.workspace_deletion_notice_version() to authenticated, service_role;
revoke all on function public.workspace_deletion_pending(uuid) from public, anon, authenticated, service_role;
revoke all on function public.workspace_deletion_status(uuid) from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_deletion_path_active(uuid) from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_deletion_owner(uuid) from public, anon, authenticated, service_role;
revoke all on function public.einrichtung01_deletion_buckets() from public, anon, authenticated, service_role;
revoke all on function public.workspace_request_deletion(uuid, text, text, text, uuid) from public, anon;
revoke all on function public.workspace_revoke_deletion(uuid, uuid) from public, anon;
grant execute on function public.workspace_request_deletion(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.workspace_revoke_deletion(uuid, uuid) to authenticated;
revoke all on function public.workspace_deletion_due(integer) from public, anon, authenticated;
revoke all on function public.workspace_deletion_begin(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.workspace_deletion_mark_objects(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.workspace_deletion_fail(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.workspace_deletion_execute(uuid, uuid) from public, anon, authenticated;
grant execute on function public.workspace_deletion_due(integer) to service_role;
grant execute on function public.workspace_deletion_begin(uuid, uuid, integer) to service_role;
grant execute on function public.workspace_deletion_mark_objects(uuid, uuid, jsonb) to service_role;
grant execute on function public.workspace_deletion_fail(uuid, uuid, text) to service_role;
grant execute on function public.workspace_deletion_execute(uuid, uuid) to service_role;

revoke all on function public.einrichtung01_scheduler_secret_valid(text, text) from public, anon, authenticated;
grant execute on function public.einrichtung01_scheduler_secret_valid(text, text) to service_role;
revoke all on function public.einrichtung01_scheduler_dispatch(text, text) from public, anon, authenticated, service_role;
revoke all on function public.workspace_deletion_dispatch() from public, anon, authenticated, service_role;
revoke all on function public.account_deletion_resume_dispatch() from public, anon, authenticated, service_role;

/* ======================================================================== */
/* 6. Bestandsfunktionen: Loeschantrag und Loeschweg                          */
/* ======================================================================== */

create or replace function public.assert_workspace_write_access(p_workspace_id uuid, p_requires_writer boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_role_vorher text;
  v_owner uuid;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  if not public.workspace_session_active() then
    raise exception 'session_not_active: Die Sitzung ist beendet' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(v_user_id) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;

  -- Was die vorangehende Rollenpruefung des Weges gesehen hat: der festgeschriebene Stand ohne Sperre.
  select wm.role
  into v_role_vorher
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = v_user_id
    and wm.status = 'active';

  select wm.role
  into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = v_user_id
    and wm.status = 'active'
  for share;
  if v_role is null then
    raise exception 'workspace_not_member: Kein Zugriff auf Workspace' using errcode = '42501';
  end if;
  if v_role_vorher is distinct from v_role then
    raise exception 'workspace_access_changed: Die Rechte wurden gleichzeitig geaendert' using errcode = '40001';
  end if;
  if p_requires_writer and v_role not in ('owner', 'admin') then
    raise exception 'workspace_forbidden_role: Keine Schreibberechtigung' using errcode = '42501';
  end if;

  select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id;
  perform 1 from public.profiles p where p.id = v_owner for share;

  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Loeschung beantragt: Nur-Lesen mit eigenem Grund, vor der Lizenzpruefung.
  if public.workspace_deletion_pending(p_workspace_id) then
    raise exception 'deletion_pending: Die Loeschung des Betriebs ist beantragt' using errcode = '42501';
  end if;
  -- Erst nach der Sperre gelesen: der zuletzt festgeschriebene Stand.
  if public.workspace_license_state(p_workspace_id) <> 'effective' then
    raise exception 'license_not_effective: Die Lizenz des Betriebs ist nicht wirksam' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.assert_financial_action_allowed(p_workspace_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_status text;
  v_owner uuid;
  v_license_state text;
begin
  if v_user_id is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if public.workspace_account_blocked(v_user_id) then
    raise exception 'finance_account_blocked: Konto ist gesperrt'
      using errcode = 'P0001';
  end if;

  select wm.role
  into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = v_user_id
    and wm.status = 'active'
  for share;
  if v_role is null then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht'
      using errcode = 'P0001';
  end if;

  select p.status into v_status from public.profiles p where p.id = v_user_id;
  if v_status is null then
    raise exception 'finance_account_not_approved: Konto ist nicht freigegeben'
      using errcode = 'P0001';
  end if;
  if v_status = 'blocked' then
    raise exception 'finance_account_blocked: Konto ist gesperrt'
      using errcode = 'P0001';
  end if;
  if v_status <> 'approved' then
    raise exception 'finance_account_not_approved: Konto ist nicht freigegeben'
      using errcode = 'P0001';
  end if;

  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Loeschung beantragt: Nur-Lesen mit eigenem Grund, vor der Lizenzpruefung.
  if public.workspace_deletion_pending(p_workspace_id) then
    raise exception 'deletion_pending: Die Loeschung des Betriebs ist beantragt' using errcode = '42501';
  end if;
  -- E: Betriebslizenz (E3a). Die Inhaberzeile wird vor dem Lesen FOR SHARE gesperrt.
  select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id;
  perform 1 from public.profiles p where p.id = v_owner for share;
  v_license_state := public.workspace_license_state(p_workspace_id);
  if v_license_state = 'expired' then
    raise exception 'finance_license_expired: Lizenz ist abgelaufen'
      using errcode = 'P0001';
  end if;
  if v_license_state <> 'effective' then
    raise exception 'finance_license_inactive: Keine aktive Lizenz'
      using errcode = 'P0001';
  end if;
end;
$function$;

create or replace function public.workspace_user_can_write(p_workspace_id uuid, p_user_id uuid)
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
      and wm.user_id = p_user_id
      and wm.status = 'active'
      and wm.role in ('owner', 'admin')
  )
  and not public.workspace_account_blocked(p_user_id)
  and public.workspace_account_approved(p_user_id)
  and public.workspace_license_effective(p_workspace_id)
  -- EINRICHTUNG-01 (AP7; 1.26) — waehrend eines Loeschantrags kein Schreiben, Versand oder Postfach.
  and not public.workspace_deletion_pending(p_workspace_id);
$$;

create or replace function public.workspace_user_access_denial(p_workspace_id uuid, p_user_id uuid, p_action text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if p_workspace_id is null or p_user_id is null or p_action not in ('write', 'member') then
    return 'invalid_request';
  end if;
  if public.workspace_account_blocked(p_user_id) then
    return 'account_blocked';
  end if;
  if not public.workspace_account_approved(p_user_id) then
    return 'account_not_approved';
  end if;
  select wm.role into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id and wm.status = 'active'
  limit 1;
  if v_role is null then
    return 'not_member';
  end if;
  if p_action = 'write' and v_role not in ('owner', 'admin') then
    return 'forbidden_role';
  end if;
  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Loeschung beantragt: Versand, Postfach und KI gesperrt.
  if public.workspace_deletion_pending(p_workspace_id) then
    return 'deletion_pending';
  end if;
  if not public.workspace_license_effective(p_workspace_id) then
    return 'license_not_effective';
  end if;
  return null;
end;
$$;

create or replace function public.branding_asset_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.branding_asset_workspace_id(p_name))
      and public.workspace_license_effective(public.branding_asset_workspace_id(p_name))
      and not public.workspace_deletion_pending(public.branding_asset_workspace_id(p_name)),
    false
  );
$$;

create or replace function public.document_delivery_attachment_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.document_delivery_attachment_workspace_id(p_name))
      and public.workspace_license_effective(public.document_delivery_attachment_workspace_id(p_name))
      and not public.workspace_deletion_pending(public.document_delivery_attachment_workspace_id(p_name)),
    false
  );
$$;

create or replace function public.email_attachment_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.email_attachment_workspace_id(p_name))
      and public.workspace_license_effective(public.email_attachment_workspace_id(p_name))
      and not public.workspace_deletion_pending(public.email_attachment_workspace_id(p_name)),
    false
  );
$$;

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
        and public.workspace_license_effective(split_part(p_name, '/', 1)::uuid)
        and not public.workspace_deletion_pending(split_part(p_name, '/', 1)::uuid)
    else false
  end;
$$;

create or replace function public.get_workspace_access(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_state text;
begin
  if auth.uid() is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;
  v_role := public.workspace_member_role(p_workspace_id);
  if v_role is null then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  v_state := public.workspace_license_state(p_workspace_id);
  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'role', v_role,
    'license_state', v_state,
    'license_effective', v_state = 'effective',
    -- EINRICHTUNG-01 (AP7; 1.26) — Loeschantrag: Zustand und Ausfuehrungsdatum fuer den Nur-Lesen-Hinweis.
    'deletion', public.workspace_deletion_status(p_workspace_id)
  );
end;
$$;

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
  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Einladen, Annehmen, Aufstufen, Umbenennen: waehrend eines Loeschantrags gesperrt.
  if p_require_license and public.workspace_deletion_pending(p_workspace_id) then
    raise exception 'deletion_pending: Die Loeschung des Betriebs ist beantragt' using errcode = '42501';
  end if;
  if p_require_license and public.workspace_license_state(p_workspace_id) <> 'effective' then
    raise exception 'license_not_effective: Die Lizenz des Betriebs ist nicht wirksam' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

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
  -- EINRICHTUNG-01 (AP7; 1.26, K7) — keine Annahme neuer Einladungen in einen Betrieb mit Loeschantrag.
  if public.workspace_deletion_pending(v_inv.workspace_id) then
    return jsonb_build_object('ok', false, 'code', 'deletion_pending');
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
  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Loeschung beantragt: keine Uebergabe (1.6).
  if public.workspace_deletion_pending(p_workspace_id) then
    raise exception 'deletion_pending: Die Loeschung des Betriebs ist beantragt' using errcode = '42501';
  end if;
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
  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Loeschung beantragt: keine Uebergabe, auch keine Annahme (1.6, 1.6a).
  if public.workspace_deletion_pending(v_ws) then
    raise exception 'deletion_pending: Die Loeschung des Betriebs ist beantragt' using errcode = '42501';
  end if;
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
  -- EINRICHTUNG-01 (AP7; 1.26, K7) — Loeschung beantragt: keine Plattform-Reparatur (1.6a, E15; keine Plattform-Ausnahme).
  if public.workspace_deletion_pending(p_workspace_id) then
    raise exception 'deletion_pending: Die Loeschung des Betriebs ist beantragt' using errcode = '42501';
  end if;
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

create or replace function public.list_workspace_mailbox_auto_sync_candidates(p_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sort_key), '[]'::jsonb)
  from (
    select
      c.id,
      c.provider_type,
      c.auth_mode,
      c.status,
      c.error_category,
      (cr.connection_id is not null) as has_credential,
      (c.sync_lease_until is not null and c.sync_lease_until > now()) as lease_active,
      c.next_attempt_at,
      c.last_attempt_at,
      c.consecutive_failures,
      coalesce(c.last_attempt_at, 'epoch'::timestamptz) as sort_key
    from public.workspace_mailbox_connections c
    left join public.workspace_mailbox_credentials cr on cr.connection_id = c.id
    where c.status <> 'disconnected'
      and public.workspace_license_effective(c.workspace_id)
      -- EINRICHTUNG-01 (AP7; 1.26) — kein Postfachabruf fuer einen Betrieb mit Loeschantrag.
      and not public.workspace_deletion_pending(c.workspace_id)
    order by coalesce(c.last_attempt_at, 'epoch'::timestamptz), c.id
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  ) x;
$function$;

create or replace function public.prevent_workspace_order_amendment_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- EINRICHTUNG-01 (AP7; 1.26, K3) — einzige Ausnahme: der Loeschweg einer Betriebsloeschung.
  if tg_op = 'DELETE' and public.einrichtung01_deletion_path_active(old.workspace_id) then
    return old;
  end if;
  raise exception 'workspace_order_amendments are write-once';
end;
$$;
