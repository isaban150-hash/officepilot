-- FINANZ-CORE-01A — Nacharbeit WEISS-Recheck 21d, P2 (T8-02): Vertragstest für
-- 20261124120000_fc01a_mitglied_erstzugang.sql (ensure_personal_workspace, Mitarbeiter-Erstzugang).
--
-- Befund WEISS: Ein Konto mit genau einer aktiven member-Mitgliedschaft erhielt beim ersten Login
-- einen neuen eigenen Betrieb (created = true, Rolle owner) statt des berechtigten Betriebs.
--
--   E1  Nur member: Erstzugang bindet an den berechtigten Betrieb mit Rolle member, created = false;
--       kein neuer Betrieb, keine neue Mitgliedschaft, Betrieb unverändert, p_name unbeachtet;
--       deckungsgleich mit get_active_workspace.
--   E2  Nur admin: derselbe Weg mit Rolle admin.
--   E3  Mehrere Mitarbeiter-Mitgliedschaften: admin vor member, sonst die älteste, bei Gleichstand
--       nach Betriebskennung.
--   E4  Inhaberabläufe unverändert: Inhaber erhält seinen Betrieb; eigener Betrieb geht einer älteren
--       Mitarbeiter-Mitgliedschaft vor.
--   E5  Ohne Mitgliedschaft: eigener Betrieb wie bisher (Name, owner, Einstellungen), zweiter Aufruf
--       liefert ihn wieder (created = false); ohne Namen „Mein Workspace“.
--   E6  Nur eingeladen / nur entfernt: kein Zugang, die Mitgliedschaft bleibt unverändert (weder
--       aktiviert noch wiederbelebt), eigener Betrieb wie bisher; entfernt + aktiv anderswo bindet dort.
--   E7  Gesperrtes Mitarbeiterkonto: account_blocked (42501), nichts angelegt.
--   E8  Ohne Anmeldung: 'Nicht angemeldet'; anon ohne Ausführungsrecht.
--   E9  Kein fremder Betrieb, Sperren bleiben: Abzug nur im eigenen Betrieb; member ohne Schreibrecht,
--       Monatsabschluss (finance_forbidden_role) und Export-/Paketfreigabe abgewiesen.
--   E10 Wiederholbarkeit: zweiter Aufruf identisch, keine Schreibvorgänge.
--   E11 Funktionseigenschaften und Rechte: Signatur, security definer, search_path; EXECUTE nur
--       authenticated (wie Produktion).
--
-- Vor der Migration scheitert der Test an E1 (Nachweis des Befunds); danach Exit 0.
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_mitglied_erstzugang.sql
-- Alles wird zurückgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from (values
  ('00000000-0000-0000-0000-0000000e2a01'::uuid, 'ez-inhaber-a@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a02'::uuid, 'ez-inhaber-b@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a11'::uuid, 'ez-mitglied@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a12'::uuid, 'ez-admin@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a13'::uuid, 'ez-mehrfach-admin@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a14'::uuid, 'ez-mehrfach-aelteste@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a15'::uuid, 'ez-mehrfach-gleichstand@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a16'::uuid, 'ez-eigen-und-mitglied@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a17'::uuid, 'ez-neu-mit-name@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a18'::uuid, 'ez-neu-ohne-name@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a19'::uuid, 'ez-eingeladen@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a1a'::uuid, 'ez-entfernt@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a1b'::uuid, 'ez-entfernt-und-mitglied@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2a1c'::uuid, 'ez-gesperrt@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null, role = 'user'
where id::text like '00000000-0000-0000-0000-0000000e2a%';
update public.profiles set status = 'blocked' where id = '00000000-0000-0000-0000-0000000e2a1c'::uuid;

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e2aa1'::uuid, 'Erstzugang A', '00000000-0000-0000-0000-0000000e2a01'::uuid),
       ('00000000-0000-0000-0000-0000000e2ab1'::uuid, 'Erstzugang B', '00000000-0000-0000-0000-0000000e2a02'::uuid),
       ('00000000-0000-0000-0000-0000000e2ac1'::uuid, 'Erstzugang C eigen', '00000000-0000-0000-0000-0000000e2a16'::uuid);

-- Zeitpunkte ausdrücklich: in einer Transaktion liefert now() überall denselben Wert.
insert into public.workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
values ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a01'::uuid, 'owner',  'active',  '2026-01-01', '2026-01-01'),
       ('00000000-0000-0000-0000-0000000e2ab1'::uuid, '00000000-0000-0000-0000-0000000e2a02'::uuid, 'owner',  'active',  '2026-01-01', '2026-01-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a11'::uuid, 'member', 'active',  '2026-03-01', '2026-03-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a12'::uuid, 'admin',  'active',  '2026-03-01', '2026-03-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a13'::uuid, 'member', 'active',  '2026-02-01', '2026-02-01'),
       ('00000000-0000-0000-0000-0000000e2ab1'::uuid, '00000000-0000-0000-0000-0000000e2a13'::uuid, 'admin',  'active',  '2026-04-01', '2026-04-01'),
       ('00000000-0000-0000-0000-0000000e2ab1'::uuid, '00000000-0000-0000-0000-0000000e2a14'::uuid, 'member', 'active',  '2026-02-01', '2026-02-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a14'::uuid, 'member', 'active',  '2026-04-01', '2026-04-01'),
       ('00000000-0000-0000-0000-0000000e2ab1'::uuid, '00000000-0000-0000-0000-0000000e2a15'::uuid, 'member', 'active',  '2026-02-01', '2026-02-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a15'::uuid, 'member', 'active',  '2026-02-01', '2026-02-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a16'::uuid, 'member', 'active',  '2026-02-01', '2026-02-01'),
       ('00000000-0000-0000-0000-0000000e2ac1'::uuid, '00000000-0000-0000-0000-0000000e2a16'::uuid, 'owner',  'active',  '2026-05-01', '2026-05-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a19'::uuid, 'member', 'invited', '2026-03-01', '2026-03-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a1a'::uuid, 'admin',  'removed', '2026-03-01', '2026-03-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a1b'::uuid, 'admin',  'removed', '2026-02-01', '2026-02-01'),
       ('00000000-0000-0000-0000-0000000e2ab1'::uuid, '00000000-0000-0000-0000-0000000e2a1b'::uuid, 'member', 'active',  '2026-04-01', '2026-04-01'),
       ('00000000-0000-0000-0000-0000000e2aa1'::uuid, '00000000-0000-0000-0000-0000000e2a1c'::uuid, 'member', 'active',  '2026-03-01', '2026-03-01');

create function pg_temp.ws_a() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2aa1'::uuid $p$;
create function pg_temp.ws_b() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2ab1'::uuid $p$;
create function pg_temp.ws_c() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2ac1'::uuid $p$;
create function pg_temp.u(p_suffix text) returns uuid language sql immutable as $p$
  select ('00000000-0000-0000-0000-0000000e2a' || p_suffix)::uuid
$p$;

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text, p_code text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if p_text is not null and position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    if p_code is not null and sqlstate <> p_code then
      raise exception '% -- falscher Fehlercode: % / % (erwartet: %)', p_label, sqlstate, sqlerrm, p_code;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, coalesce(p_text, p_code, 'eine Abweisung');
end;
$p$;

/** Erstzugang als Konto: ensure_personal_workspace(p_name) mit dessen Anmeldung. */
create function pg_temp.erstzugang(p_user uuid, p_name text) returns jsonb language plpgsql as $p$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.ensure_personal_workspace(p_name);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.aktiv(p_user uuid) returns jsonb language plpgsql as $p$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.get_active_workspace();
  perform pg_temp.zurueck();
  return v;
end;
$p$;

/** Fingerabdruck aller Betriebe, Mitgliedschaften und Einstellungen (Schreibvorgänge erkennen). */
create function pg_temp.bestand() returns text language sql stable as $p$
  select md5(
    coalesce((select string_agg(w.id::text || w.name || w.owner_user_id::text || w.version::text || w.updated_at::text, ',' order by w.id) from public.workspaces w), '')
    || '|' ||
    coalesce((select string_agg(m.workspace_id::text || m.user_id::text || m.role || m.status || m.updated_at::text, ',' order by m.workspace_id, m.user_id) from public.workspace_members m), '')
    || '|' ||
    coalesce((select string_agg(s.workspace_id::text || s.version::text, ',' order by s.workspace_id) from public.workspace_settings s), '')
  )
$p$;

/** Ergebnis einer Bindung prüfen: Betrieb, Rolle, created und dass die Mitgliedschaft dem Konto gehört. */
create function pg_temp.erwarte_bindung(p_label text, p_user uuid, v jsonb, p_ws uuid, p_role text, p_created boolean)
returns void language plpgsql as $p$
begin
  if (v->'workspace'->>'id')::uuid is distinct from p_ws
     or (v->'member'->>'workspace_id')::uuid is distinct from p_ws
     or (v->'member'->>'user_id')::uuid is distinct from p_user
     or v->'member'->>'role' is distinct from p_role
     or v->'member'->>'status' is distinct from 'active'
     or (v->>'created')::boolean is distinct from p_created then
    raise exception '% -- erwartet Betrieb % / Rolle % / created %, erhalten: Betrieb % / Rolle % / created %',
      p_label, p_ws, p_role, p_created,
      v->'workspace'->>'id', v->'member'->>'role', v->>'created';
  end if;
end;
$p$;

/* ------------------------------------------------------------------ */
/* E1 -- nur member                                                    */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text; v jsonb; v_aktiv jsonb;
begin
  v_vorher := pg_temp.bestand();
  v := pg_temp.erstzugang(pg_temp.u('11'), 'Darf nicht entstehen E1');
  perform pg_temp.erwarte_bindung('E1 member-Erstzugang', pg_temp.u('11'), v, pg_temp.ws_a(), 'member', false);
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E1 -- Erstzugang hat Betriebe, Mitgliedschaften oder Einstellungen verändert';
  end if;
  if exists (select 1 from public.workspaces where name = 'Darf nicht entstehen E1')
     or (select count(*) from public.workspace_members where user_id = pg_temp.u('11')) <> 1 then
    raise exception 'E1 -- neuer Betrieb oder neue Mitgliedschaft für das Mitglied';
  end if;
  if v->'workspace'->>'name' <> 'Erstzugang A' or (v->'workspace'->>'owner_user_id')::uuid <> pg_temp.u('01') then
    raise exception 'E1 -- Betrieb verändert zurückgegeben: %', v->'workspace';
  end if;
  v_aktiv := pg_temp.aktiv(pg_temp.u('11'));
  if (v_aktiv->'workspace'->>'id')::uuid is distinct from pg_temp.ws_a() or v_aktiv->'member'->>'role' <> 'member' then
    raise exception 'E1 -- get_active_workspace weicht ab: %', v_aktiv;
  end if;
  raise notice 'OK  E1 member-Erstzugang: berechtigter Betrieb, Rolle member, created false, nichts angelegt oder verändert';
end $$;

/* ------------------------------------------------------------------ */
/* E2 -- nur admin                                                     */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text; v jsonb;
begin
  v_vorher := pg_temp.bestand();
  v := pg_temp.erstzugang(pg_temp.u('12'), 'Darf nicht entstehen E2');
  perform pg_temp.erwarte_bindung('E2 admin-Erstzugang', pg_temp.u('12'), v, pg_temp.ws_a(), 'admin', false);
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E2 -- Erstzugang hat den Bestand verändert';
  end if;
  raise notice 'OK  E2 admin-Erstzugang: berechtigter Betrieb, Rolle admin, nichts angelegt';
end $$;

/* ------------------------------------------------------------------ */
/* E3 -- mehrere Mitarbeiter-Mitgliedschaften                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text; v jsonb; v_aktiv jsonb;
begin
  v_vorher := pg_temp.bestand();
  -- a) member in A (älter) und admin in B (jünger): admin geht vor.
  v := pg_temp.erstzugang(pg_temp.u('13'), null);
  perform pg_temp.erwarte_bindung('E3a admin vor member', pg_temp.u('13'), v, pg_temp.ws_b(), 'admin', false);
  v_aktiv := pg_temp.aktiv(pg_temp.u('13'));
  if (v_aktiv->'workspace'->>'id')::uuid is distinct from pg_temp.ws_b() then
    raise exception 'E3a -- get_active_workspace wählt anders: %', v_aktiv->'workspace'->>'id';
  end if;
  -- b) member in B (älter) und member in A (jünger): die älteste.
  v := pg_temp.erstzugang(pg_temp.u('14'), null);
  perform pg_temp.erwarte_bindung('E3b älteste Mitgliedschaft', pg_temp.u('14'), v, pg_temp.ws_b(), 'member', false);
  v_aktiv := pg_temp.aktiv(pg_temp.u('14'));
  if (v_aktiv->'workspace'->>'id')::uuid is distinct from pg_temp.ws_b() then
    raise exception 'E3b -- get_active_workspace wählt anders: %', v_aktiv->'workspace'->>'id';
  end if;
  -- c) zwei member-Mitgliedschaften mit gleichem Zeitpunkt: kleinere Betriebskennung (A).
  v := pg_temp.erstzugang(pg_temp.u('15'), null);
  perform pg_temp.erwarte_bindung('E3c Gleichstand nach Betriebskennung', pg_temp.u('15'), v, pg_temp.ws_a(), 'member', false);
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E3 -- Erstzugang hat den Bestand verändert';
  end if;
  raise notice 'OK  E3 Mehrfachmitgliedschaften: admin vor member, älteste zuerst, Gleichstand nach Betriebskennung';
end $$;

/* ------------------------------------------------------------------ */
/* E4 -- Inhaberabläufe unverändert                                    */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text; v jsonb;
begin
  v_vorher := pg_temp.bestand();
  v := pg_temp.erstzugang(pg_temp.u('01'), 'Anderer Name E4');
  perform pg_temp.erwarte_bindung('E4a Inhaber', pg_temp.u('01'), v, pg_temp.ws_a(), 'owner', false);
  if v->'workspace'->>'name' <> 'Erstzugang A' then
    raise exception 'E4a -- Inhaberbetrieb umbenannt: %', v->'workspace'->>'name';
  end if;
  -- Eigener Betrieb (jünger) geht der älteren member-Mitgliedschaft in A vor.
  v := pg_temp.erstzugang(pg_temp.u('16'), null);
  perform pg_temp.erwarte_bindung('E4b eigener Betrieb vor Mitarbeiter-Mitgliedschaft', pg_temp.u('16'), v, pg_temp.ws_c(), 'owner', false);
  if (pg_temp.aktiv(pg_temp.u('16'))->'workspace'->>'id')::uuid is distinct from pg_temp.ws_c() then
    raise exception 'E4b -- get_active_workspace wählt anders';
  end if;
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E4 -- Inhaberzugang hat den Bestand verändert';
  end if;
  raise notice 'OK  E4 Inhaber unverändert: eigener Betrieb, auch vor einer älteren Mitarbeiter-Mitgliedschaft';
end $$;

/* ------------------------------------------------------------------ */
/* E5 -- ohne Mitgliedschaft: eigener Betrieb wie bisher               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws_vorher integer; v jsonb; v2 jsonb; v_neu uuid; v_ohne jsonb;
begin
  select count(*) into v_ws_vorher from public.workspaces;
  v := pg_temp.erstzugang(pg_temp.u('17'), '  Neuer Betrieb E5  ');
  v_neu := (v->'workspace'->>'id')::uuid;
  perform pg_temp.erwarte_bindung('E5a Neuanlage', pg_temp.u('17'), v, v_neu, 'owner', true);
  if v_neu in (pg_temp.ws_a(), pg_temp.ws_b(), pg_temp.ws_c())
     or v->'workspace'->>'name' <> 'Neuer Betrieb E5'
     or (v->'workspace'->>'owner_user_id')::uuid <> pg_temp.u('17')
     or (select count(*) from public.workspaces) <> v_ws_vorher + 1
     or not exists (select 1 from public.workspace_settings where workspace_id = v_neu) then
    raise exception 'E5a -- Neuanlage nicht wie bisher: %', v;
  end if;
  v2 := pg_temp.erstzugang(pg_temp.u('17'), 'Zweiter Name E5');
  perform pg_temp.erwarte_bindung('E5b zweiter Aufruf', pg_temp.u('17'), v2, v_neu, 'owner', false);
  if (select count(*) from public.workspaces) <> v_ws_vorher + 1 then
    raise exception 'E5b -- zweiter Aufruf legt erneut an';
  end if;
  v_ohne := pg_temp.erstzugang(pg_temp.u('18'), '   ');
  if v_ohne->'workspace'->>'name' <> 'Mein Workspace' or (v_ohne->>'created')::boolean is not true then
    raise exception 'E5c -- Standardname nicht wie bisher: %', v_ohne->'workspace'->>'name';
  end if;
  raise notice 'OK  E5 ohne Mitgliedschaft: eigener Betrieb wie bisher, danach wiederverwendet, Standardname';
end $$;

/* ------------------------------------------------------------------ */
/* E6 -- eingeladen / entfernt                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb; v_zeile_vorher text;
begin
  select md5(string_agg(m.workspace_id::text || m.user_id::text || m.role || m.status || m.updated_at::text, ',' order by m.workspace_id, m.user_id))
    into v_zeile_vorher
  from public.workspace_members m where m.user_id in (pg_temp.u('19'), pg_temp.u('1a'), pg_temp.u('1b'));

  v := pg_temp.erstzugang(pg_temp.u('19'), null);
  if (v->'workspace'->>'id')::uuid in (pg_temp.ws_a(), pg_temp.ws_b(), pg_temp.ws_c())
     or (v->>'created')::boolean is not true or v->'member'->>'role' <> 'owner' then
    raise exception 'E6a -- eingeladenes Konto erhält Zugang zum einladenden Betrieb: %', v;
  end if;
  v := pg_temp.erstzugang(pg_temp.u('1a'), null);
  if (v->'workspace'->>'id')::uuid in (pg_temp.ws_a(), pg_temp.ws_b(), pg_temp.ws_c())
     or (v->>'created')::boolean is not true or v->'member'->>'role' <> 'owner' then
    raise exception 'E6b -- entferntes Konto erhält wieder Zugang: %', v;
  end if;
  v := pg_temp.erstzugang(pg_temp.u('1b'), null);
  perform pg_temp.erwarte_bindung('E6c entfernt in A, aktiv in B', pg_temp.u('1b'), v, pg_temp.ws_b(), 'member', false);

  if (select md5(string_agg(m.workspace_id::text || m.user_id::text || m.role || m.status || m.updated_at::text, ',' order by m.workspace_id, m.user_id))
      from public.workspace_members m
      where m.user_id in (pg_temp.u('19'), pg_temp.u('1a'), pg_temp.u('1b'))
        and m.workspace_id in (pg_temp.ws_a(), pg_temp.ws_b())) <> v_zeile_vorher then
    raise exception 'E6 -- eingeladene oder entfernte Mitgliedschaft verändert (aktiviert/wiederbelebt)';
  end if;
  raise notice 'OK  E6 eingeladen/entfernt: kein Zugang, Mitgliedschaft unverändert, eigener Betrieb wie bisher; aktiv anderswo bindet dort';
end $$;

/* ------------------------------------------------------------------ */
/* E7 -- gesperrtes Mitarbeiterkonto                                   */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text;
begin
  v_vorher := pg_temp.bestand();
  perform pg_temp.als(pg_temp.u('1c'));
  perform pg_temp.erwarte_abweisung('E7 gesperrtes Mitglied bindet sich',
    'select public.ensure_personal_workspace(null)', 'account_blocked', '42501');
  perform pg_temp.zurueck();
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E7 -- für das gesperrte Konto wurde etwas angelegt oder verändert';
  end if;
  raise notice 'OK  E7 gesperrtes Mitarbeiterkonto: account_blocked, nichts angelegt';
end $$;

/* ------------------------------------------------------------------ */
/* E8 -- ohne Anmeldung                                                */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text;
begin
  v_vorher := pg_temp.bestand();
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  set local role authenticated;
  perform pg_temp.erwarte_abweisung('E8a ohne Kennung', 'select public.ensure_personal_workspace(null)', 'Nicht angemeldet', null);
  perform pg_temp.zurueck();
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  perform pg_temp.erwarte_abweisung('E8b anon', 'select public.ensure_personal_workspace(null)', null, '42501');
  perform pg_temp.zurueck();
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E8 -- ohne Anmeldung wurde etwas angelegt';
  end if;
  raise notice 'OK  E8 ohne Anmeldung abgewiesen, anon ohne Ausführungsrecht';
end $$;

/* ------------------------------------------------------------------ */
/* E9 -- kein fremder Betrieb, Sperren bleiben                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb; v_pull jsonb; v_schreiben boolean;
begin
  v := pg_temp.erstzugang(pg_temp.u('11'), null);
  perform pg_temp.als(pg_temp.u('11'));
  v_pull := public.pull_workspace_sync_state((v->'workspace'->>'id')::uuid);
  v_schreiben := public.can_write_workspace((v->'workspace'->>'id')::uuid);
  perform pg_temp.erwarte_abweisung('E9a Abzug im fremden Betrieb',
    format('select public.pull_workspace_sync_state(%L::uuid)', pg_temp.ws_b()), 'Kein Zugriff', null);
  perform pg_temp.erwarte_abweisung('E9b Monatsabschluss als member',
    format('select public.close_workspace_accounting_period(%L::uuid, %L::jsonb)', pg_temp.ws_a(),
           '{"client_closure_id":"ez-e9","period_year":2026,"period_month":8}'), 'finance_forbidden_role', null);
  perform pg_temp.erwarte_abweisung('E9c Export-/Paketfreigabe als member',
    format('select public.assert_workspace_finance_export(%L::uuid)', pg_temp.ws_a()), 'Kein Zugriff', null);
  perform pg_temp.erwarte_abweisung('E9d Monatsabschluss im fremden Betrieb',
    format('select public.close_workspace_accounting_period(%L::uuid, %L::jsonb)', pg_temp.ws_b(),
           '{"client_closure_id":"ez-e9b","period_year":2026,"period_month":8}'), 'Kein Zugriff', null);
  perform pg_temp.zurueck();
  if v_pull is null or v_schreiben is not false then
    raise exception 'E9 -- Abzug im eigenen Betrieb % / Schreibrecht member %', (v_pull is not null), v_schreiben;
  end if;
  if exists (select 1 from public.workspace_accounting_period_closures where workspace_id in (pg_temp.ws_a(), pg_temp.ws_b())) then
    raise exception 'E9 -- Abschluss entstanden';
  end if;
  raise notice 'OK  E9 kein fremder Betrieb; member liest den eigenen Betrieb, ohne Schreibrecht, Abschluss und Paketfreigabe abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* E10 -- Wiederholbarkeit                                             */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher text; v1 jsonb; v2 jsonb;
begin
  v_vorher := pg_temp.bestand();
  v1 := pg_temp.erstzugang(pg_temp.u('11'), null);
  v2 := pg_temp.erstzugang(pg_temp.u('11'), 'Noch ein Name E10');
  if v1 <> v2 then
    raise exception 'E10 -- zweiter Aufruf weicht ab: % / %', v1, v2;
  end if;
  if pg_temp.bestand() <> v_vorher then
    raise exception 'E10 -- wiederholter Erstzugang schreibt';
  end if;
  raise notice 'OK  E10 wiederholter Erstzugang identisch, ohne Schreibvorgang';
end $$;

/* ------------------------------------------------------------------ */
/* E11 -- Funktionseigenschaften und Rechte                            */
/* ------------------------------------------------------------------ */

do $$
declare
  v_def boolean; v_cfg text[]; v_args text; v_ret text; v_owner text; v_berechtigt text;
begin
  select p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid), format_type(p.prorettype, null), pg_get_userbyid(p.proowner)
    into v_def, v_cfg, v_args, v_ret, v_owner
  from pg_proc p where p.oid = 'public.ensure_personal_workspace(text)'::regprocedure;
  if v_def is not true or not ('search_path=public' = any(v_cfg)) or v_args <> 'p_name text' or v_ret <> 'jsonb' then
    raise exception 'E11 -- Funktionseigenschaften: definer % / config % / args % / ret %', v_def, v_cfg, v_args, v_ret;
  end if;
  if pg_get_function_arguments('public.ensure_personal_workspace(text)'::regprocedure) <> 'p_name text DEFAULT NULL::text' then
    raise exception 'E11 -- Vorgabewert von p_name verändert';
  end if;
  select string_agg(n.name, ',' order by n.name)
    into v_berechtigt
  from (
    select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as name
    from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.ensure_personal_workspace(text)'::regprocedure
      and a.privilege_type = 'EXECUTE'
      and a.grantee <> p.proowner
  ) n;
  if v_berechtigt is distinct from 'authenticated' then
    raise exception 'E11 -- EXECUTE-Rechte: % (erwartet nur authenticated, Eigentümer %)', v_berechtigt, v_owner;
  end if;
  raise notice 'OK  E11 Signatur, security definer, search_path; EXECUTE nur authenticated (Eigentümer %)', v_owner;
end $$;

rollback;
