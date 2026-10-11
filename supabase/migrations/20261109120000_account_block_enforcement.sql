-- GO-LIVE-SECURITY-01 / KONTOSPERRE — gesperrte Konten verlieren jede wirksame
-- Geschaefts-, Archiv- und Verwaltungsberechtigung.
--
-- Rein additiv. 20261105120000 (remote angewendet) sowie 20261106120000,
-- 20261107120000 und 20261108120000 bleiben unveraendert; ihre Waechter rufen die
-- hier ersetzten Helfer auf und folgen der Sperre damit ohne eigene Aenderung.
-- Keine Datenaenderung.
--
-- Befund (WEISS, Gesamtabnahme; lokal reproduziert mit
-- supabase/tests/account_block_enforcement_01.sql, Abschnitt K1):
--   Ein Admin mit profiles.status = 'blocked' las weiter Archivdaten und fuehrte
--   tombstone_workspace_document aus; can_write_workspace lieferte true.
--
-- Ursache: Die Kontosperre wurde allein in assert_financial_action_allowed geprueft.
-- Die Mitgliedschaftshelfer is_active_workspace_member und workspace_member_role
-- (und damit can_write_workspace und workspace_user_can_intake) kannten nur
-- workspace_members. Auf diesen Helfern beruhen
--   * jede RLS-Lese- und Schreibpolicy im Schema public (einzige Ausnahme:
--     profiles_select_own, das eigene Profil — noetig fuer die Sperrseite),
--   * alle acht Speicher-Bruecken (workspace-files, branding-assets,
--     document-deliveries, email-attachments, inbound-email-attachments),
--   * alle Security-Definer-Abzuege, Archiv-, Loesch-, Wiederherstellungs-,
--     Eingangs-, Versand- und Synchronisationswege sowie die Waechter aus
--     20261105–20261108.
-- Daneben pruefte keiner diese Wege die Sperre:
--   * workspace_user_can_write(ws, user) — die Bruecke, ueber die die Edge
--     Functions send-document, send-email, sync-mailbox und mailbox-oauth-start
--     sowie complete_workspace_mailbox_oauth / create_workspace_mailbox_oauth_state
--     das Schreibrecht pruefen (Dienstschluessel, ausdrueckliche Nutzerkennung),
--   * ensure_personal_workspace / get_active_workspace (Betriebsbindung),
--   * assert_is_admin — ein gesperrter Plattform-Admin konnte alle admin_*-Funktionen
--     nutzen und sich mit admin_approve_user(eigene Kennung) SELBST ENTSPERREN,
--   * get_workspace_mailbox_oauth_pending (ohne jede Mitgliedschaftspruefung).
--
-- Korrektur:
--   S1 workspace_account_blocked(uuid): interne Pruefung profiles.status = 'blocked'
--      (fehlendes Profil gilt nicht als gesperrt; Kennung null ebenso).
--   S2 is_active_workspace_member / workspace_member_role: ein gesperrtes Konto ist
--      kein aktives Mitglied und hat keine Rolle — wie ein entferntes Mitglied.
--      can_write_workspace und workspace_user_can_intake folgen unveraendert.
--   S3 workspace_user_can_write(ws, user): gesperrte Nutzer haben kein Schreibrecht.
--   S4 assert_is_admin: gesperrte Plattform-Admins sind keine Admins.
--   S5 ensure_personal_workspace / get_active_workspace: 'account_blocked' (42501),
--      ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
--   S6 assert_financial_action_allowed: Sperre VOR der Rolle, damit Finanzwege
--      weiter finance_account_blocked melden (Clients werten es als endgueltig).
--   S7 get_workspace_mailbox_oauth_pending: nur fuer aktive Mitglieder (damit auch
--      nicht fuer gesperrte Konten); sonst null wie "nicht gefunden".
--
-- Wirkung auf bestehende Sitzungen: Alle Pruefungen lesen profiles bei jedem Aufruf;
-- eine Sperre wirkt beim naechsten Aufruf, ohne Abmeldung und ohne Token-Ablauf.
--
-- Bewusst NICHT Teil dieser Migration (Produktentscheidungen, im Bericht genannt):
--   * Konten mit status 'pending' (noch nicht freigegeben) und abgelaufene Lizenzen
--     sperrt weiterhin nur der Client; Finanzaktionen prueft der Server wie bisher.
--   * cancel_workspace_mailbox_oauth_pending bleibt fuer den eigenen Zwischenstand
--     erlaubt (raeumt nur auf und loescht das Vault-Geheimnis).
--   * update_own_profile (Name, Telefon, Branche des eigenen Profils) bleibt erlaubt;
--     Status, Rolle und Lizenz kann es nicht aendern.
--   * Der automatische Postfachabgleich (mailbox-auto-sync) laeuft betriebsbezogen
--     weiter; er gibt dem gesperrten Konto selbst keinen Zugriff.

/* ------------------------------------------------------------------------ */
/* S1 — interne Sperrpruefung                                               */
/* ------------------------------------------------------------------------ */

create or replace function public.workspace_account_blocked(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.status = 'blocked' from public.profiles p where p.id = p_user_id),
    false
  );
$$;

revoke all on function public.workspace_account_blocked(uuid) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* S2 — Mitgliedschaftshelfer                                               */
/* ------------------------------------------------------------------------ */

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
  )
  and not public.workspace_account_blocked(auth.uid());
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
    and not public.workspace_account_blocked(auth.uid())
  limit 1;
$$;

/* ------------------------------------------------------------------------ */
/* S3 — Schreibrecht eines ausdruecklich genannten Nutzers (Edge Functions)  */
/* ------------------------------------------------------------------------ */

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
  and not public.workspace_account_blocked(p_user_id);
$$;

/* ------------------------------------------------------------------------ */
/* S4 — Plattform-Admin                                                     */
/* ------------------------------------------------------------------------ */

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
      and status is distinct from 'blocked'
  ) then
    raise exception 'Keine Admin-Berechtigung';
  end if;
end;
$$;

/* ------------------------------------------------------------------------ */
/* S5–S7 — aus den bisherigen Fassungen erzeugt (pg_get_functiondef), nur    */
/* die Sperrpruefung eingefuegt                                             */
/* ------------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION public.ensure_personal_workspace(p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.get_active_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_member public.workspace_members;
  v_workspace public.workspaces;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
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
$function$;

CREATE OR REPLACE FUNCTION public.assert_financial_action_allowed(p_workspace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_status text;
  v_license text;
  v_expires timestamptz;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  -- KONTOSPERRE vor der Rolle: Die Mitgliedschaftshelfer behandeln ein gesperrtes Konto
  -- (20261109) wie ein Nicht-Mitglied. Damit Clients die Sperre bei Finanzaktionen weiter
  -- als endgueltige Abweisung erkennen, kommt die bisherige Meldung zuerst.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'finance_account_blocked: Konto ist gesperrt'
      using errcode = 'P0001';
  end if;

  -- B: aktives Mitglied. Nicht-Mitglieder bekommen denselben Satz wie bisher.
  v_role := public.workspace_member_role(p_workspace_id);
  if v_role is null then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  -- C: Rolle. Ein 'member' arbeitet mit, entscheidet aber nicht ueber Geld.
  if v_role not in ('owner', 'admin') then
    raise exception 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht'
      using errcode = 'P0001';
  end if;

  select p.status, p.license_status, p.license_expires_at
    into v_status, v_license, v_expires
  from public.profiles p
  where p.id = v_user_id;

  -- D: Freigabe. Ohne Profil gibt es keine Freigabe, die man pruefen koennte.
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

  -- E: Lizenz. 'expired' und ein abgelaufenes Datum sind derselbe Fall.
  if v_license = 'expired' or (v_expires is not null and v_expires <= now()) then
    raise exception 'finance_license_expired: Lizenz ist abgelaufen'
      using errcode = 'P0001';
  end if;
  if v_license <> 'active' then
    raise exception 'finance_license_inactive: Keine aktive Lizenz'
      using errcode = 'P0001';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_workspace_mailbox_oauth_pending(p_workspace_id uuid, p_state_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_state public.workspace_mailbox_oauth_states;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  -- KONTOSPERRE und Mitgliedschaft: Gesperrte Konten und ehemalige Mitglieder lesen keinen
  -- Zwischenstand mehr (fail-closed wie "nicht gefunden").
  if not public.is_active_workspace_member(p_workspace_id) then
    return null;
  end if;
  select * into v_state from public.workspace_mailbox_oauth_states
  where id = p_state_id and workspace_id = p_workspace_id and user_id = auth.uid();
  if v_state.id is null or v_state.outcome is distinct from 'confirm_required' or v_state.pending_until < now() then
    return null;
  end if;
  -- Nur Adressen, Quelle und Grund — nie Secret, Verifier, Nonce oder Konto-Kennung.
  return jsonb_build_object('state_id', v_state.id, 'provider_type', v_state.provider_type, 'reason', v_state.pending_reason,
    'expected_address', v_state.expected_address, 'detected_address', v_state.detected_address,
    'source_kind', v_state.source_kind, 'source_name', v_state.source_name, 'pending_until', v_state.pending_until);
end;
$function$;
