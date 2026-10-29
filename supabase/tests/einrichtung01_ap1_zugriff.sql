-- EINRICHTUNG-01 / AP1 -- Vertragstest der Zugriffsregel (Katalog V3, Vertraege 1.1, 1.2, 1.3, 1.8, 1.9).
--
--   N-Z1  Zugangsmatrix: Wege 1-12 x Konten a-m (S fuer 1-5 und 12; fuer 6-11 die Serverregel hinter dem Weg:
--         Eingangs-RPC und Storage-Schreibhelfer, Storage-Lesehelfer, Ablehnungsgrund fuer Edge Functions)
--   Z     Z-01 bis Z-07 (Einzelfaelle mit Wirkung bzw. ohne Wirkung), Z-05.9 Ablaufgrenze
--   N-Z2  Finanzschutz E3a: Vertreter je Klasse, Waechter fuer alle 25 Aufrufer
--   N-Z3  Lizenzquelle: Inhaberprofil fehlt, unbekannte Werte, fremder Betrieb, Pflichtspalte
--   S1.8  widerrufene Sitzung: Lesen, Schreiben, Finanz sofort abgewiesen
--   T-04  Postfach-Interna: Spaltenrechte, Liste, Vault
--   G     Rechte der neuen Funktionen
--
-- Jede Pruefung laeuft als Rolle authenticated (bzw. anon / service_role) mit den Claims des Kontos.
-- Erfolgreiche Aktionen der Matrix werden mit einer gezielten Ausnahme zurueckgerollt, damit alle Konten denselben
-- Stand sehen. Ausfuehren (nur lokal):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/einrichtung01_ap1_zugriff.sql
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

/* ------------------------------------------------------------------ */
/* Aufbau (Katalog Abschnitt 2, synthetisch)                           */
/* ------------------------------------------------------------------ */

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), u.meta, '{}'::jsonb
from (values
  ('00000000-0000-0000-0000-0000000e1801'::uuid, 'o1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1802'::uuid, 'a1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1803'::uuid, 'm1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1804'::uuid, 'l1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1805'::uuid, 'a2-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1806'::uuid, 'm2-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1807'::uuid, 'o5-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1808'::uuid, 'o6-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1809'::uuid, 'a6-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e180a'::uuid, 'p1-ap1@example.invalid', '{"status":"approved","license_status":"active"}'::jsonb),
  ('00000000-0000-0000-0000-0000000e180b'::uuid, 'n1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e180c'::uuid, 'g1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e180d'::uuid, 'ohneprofil-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e180e'::uuid, 'neu-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e180f'::uuid, 'pa1-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1810'::uuid, 'a7-ap1@example.invalid', '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000e1811'::uuid, 'o7-ap1@example.invalid', '{}'::jsonb)
) as u(id, email, meta);

-- Zustand je Konto (handle_new_user legt pending/inactive an).
update public.profiles p set status = s.status, license_status = s.lizenz, license_expires_at = null, role = s.rolle
from (values
  ('00000000-0000-0000-0000-0000000e1801'::uuid, 'approved', 'active',   'user'),   -- O1 Inhaber W1
  ('00000000-0000-0000-0000-0000000e1802'::uuid, 'approved', 'inactive', 'user'),   -- A1 Admin W1 ohne eigene Lizenz
  ('00000000-0000-0000-0000-0000000e1803'::uuid, 'approved', 'inactive', 'user'),   -- M1 Mitglied W1
  ('00000000-0000-0000-0000-0000000e1804'::uuid, 'approved', 'expired',  'user'),   -- L1 Inhaber W2, abgelaufen
  ('00000000-0000-0000-0000-0000000e1805'::uuid, 'approved', 'active',   'user'),   -- A2 Admin W2, eigene Lizenz aktiv
  ('00000000-0000-0000-0000-0000000e1806'::uuid, 'approved', 'inactive', 'user'),   -- M2 Mitglied W2
  ('00000000-0000-0000-0000-0000000e1807'::uuid, 'approved', 'inactive', 'user'),   -- O5 Inhaber W5, nie lizenziert
  ('00000000-0000-0000-0000-0000000e1808'::uuid, 'blocked',  'active',   'user'),   -- O6 Inhaber W6, gesperrt (E15)
  ('00000000-0000-0000-0000-0000000e1809'::uuid, 'approved', 'active',   'user'),   -- A6 Admin W6, eigene Lizenz aktiv
  ('00000000-0000-0000-0000-0000000e180a'::uuid, 'pending',  'inactive', 'user'),   -- P1 wartend (Metadaten behaupten approved)
  ('00000000-0000-0000-0000-0000000e180b'::uuid, 'approved', 'inactive', 'user'),   -- N1 ohne Lizenz, ohne Mitgliedschaft
  ('00000000-0000-0000-0000-0000000e180c'::uuid, 'blocked',  'active',   'user'),   -- G1 gesperrt
  ('00000000-0000-0000-0000-0000000e180d'::uuid, 'approved', 'active',   'user'),   -- (Profil wird unten entfernt)
  ('00000000-0000-0000-0000-0000000e180e'::uuid, 'approved', 'active',   'user'),   -- neues lizenziertes Konto
  ('00000000-0000-0000-0000-0000000e180f'::uuid, 'approved', 'inactive', 'admin'),  -- PA1 Plattform-Admin
  ('00000000-0000-0000-0000-0000000e1810'::uuid, 'approved', 'active',   'user'),   -- A7 Admin W7, eigene Lizenz aktiv
  ('00000000-0000-0000-0000-0000000e1811'::uuid, 'approved', 'active',   'user')    -- O7 Inhaber W7 (Profil wird in N-Z3.2 entfernt)
) as s(id, status, lizenz, rolle)
where p.id = s.id;

delete from public.profiles where id = '00000000-0000-0000-0000-0000000e180d'::uuid;

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e18a1'::uuid, 'AP1 W1', '00000000-0000-0000-0000-0000000e1801'::uuid),
       ('00000000-0000-0000-0000-0000000e18a2'::uuid, 'AP1 W2', '00000000-0000-0000-0000-0000000e1804'::uuid),
       ('00000000-0000-0000-0000-0000000e18a5'::uuid, 'AP1 W5', '00000000-0000-0000-0000-0000000e1807'::uuid),
       ('00000000-0000-0000-0000-0000000e18a6'::uuid, 'AP1 W6', '00000000-0000-0000-0000-0000000e1808'::uuid),
       ('00000000-0000-0000-0000-0000000e18a7'::uuid, 'AP1 W7', '00000000-0000-0000-0000-0000000e1811'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e18a1'::uuid, '00000000-0000-0000-0000-0000000e1801'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e18a1'::uuid, '00000000-0000-0000-0000-0000000e1802'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e18a1'::uuid, '00000000-0000-0000-0000-0000000e1803'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e18a1'::uuid, '00000000-0000-0000-0000-0000000e180c'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e18a1'::uuid, '00000000-0000-0000-0000-0000000e180d'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e18a1'::uuid, '00000000-0000-0000-0000-0000000e180a'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e18a2'::uuid, '00000000-0000-0000-0000-0000000e1804'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e18a2'::uuid, '00000000-0000-0000-0000-0000000e1805'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e18a2'::uuid, '00000000-0000-0000-0000-0000000e1806'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e18a5'::uuid, '00000000-0000-0000-0000-0000000e1807'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e18a6'::uuid, '00000000-0000-0000-0000-0000000e1808'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e18a6'::uuid, '00000000-0000-0000-0000-0000000e1809'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e18a7'::uuid, '00000000-0000-0000-0000-0000000e1811'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e18a7'::uuid, '00000000-0000-0000-0000-0000000e1810'::uuid, 'admin',  'active');

insert into public.workspace_customers (workspace_id, customer_id, payload)
select w.id, 'cust-ap1', '{"name":"Musterbau GmbH"}'::jsonb
from public.workspaces w where w.id::text like '00000000-0000-0000-0000-0000000e18a%';

-- Gespeicherte Dateien (Inhaltspfad <Betrieb>/<sha256>); in W1 zusaetzlich eine eigene Datei von M1.
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by)
select w.id, 'file-inhaber', repeat('1', 64), 10, 'application/pdf', w.id::text || '/' || repeat('1', 64), w.owner_user_id, w.owner_user_id
from public.workspaces w where w.id::text like '00000000-0000-0000-0000-0000000e18a%';
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by)
values ('00000000-0000-0000-0000-0000000e18a1'::uuid, 'file-m1', repeat('2', 64), 10, 'application/pdf',
        '00000000-0000-0000-0000-0000000e18a1/' || repeat('2', 64),
        '00000000-0000-0000-0000-0000000e1803'::uuid, '00000000-0000-0000-0000-0000000e1803'::uuid);

create function pg_temp.w1() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e18a1'::uuid $p$;
create function pg_temp.w2() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e18a2'::uuid $p$;
create function pg_temp.w5() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e18a5'::uuid $p$;
create function pg_temp.w6() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e18a6'::uuid $p$;
create function pg_temp.w7() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e18a7'::uuid $p$;
create function pg_temp.k(p_name text) returns uuid language sql immutable as $p$
  select case p_name
    when 'o1' then '00000000-0000-0000-0000-0000000e1801' when 'a1' then '00000000-0000-0000-0000-0000000e1802'
    when 'm1' then '00000000-0000-0000-0000-0000000e1803' when 'l1' then '00000000-0000-0000-0000-0000000e1804'
    when 'a2' then '00000000-0000-0000-0000-0000000e1805' when 'm2' then '00000000-0000-0000-0000-0000000e1806'
    when 'o5' then '00000000-0000-0000-0000-0000000e1807' when 'o6' then '00000000-0000-0000-0000-0000000e1808'
    when 'a6' then '00000000-0000-0000-0000-0000000e1809' when 'p1' then '00000000-0000-0000-0000-0000000e180a'
    when 'n1' then '00000000-0000-0000-0000-0000000e180b' when 'g1' then '00000000-0000-0000-0000-0000000e180c'
    when 'ohneprofil' then '00000000-0000-0000-0000-0000000e180d' when 'neu' then '00000000-0000-0000-0000-0000000e180e'
    when 'pa1' then '00000000-0000-0000-0000-0000000e180f' when 'a7' then '00000000-0000-0000-0000-0000000e1810'
    when 'o7' then '00000000-0000-0000-0000-0000000e1811'
  end::uuid
$p$;

/** Als dieses Konto -- Rolle authenticated; optional mit Sitzungsbezug (session_id). */
create function pg_temp.als(p_user uuid, p_session uuid default null) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', p_user::text, 'role', 'authenticated')
      || case when p_session is null then '{}'::jsonb else jsonb_build_object('session_id', p_session::text) end)::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.als_anon() returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end;
$p$;

create function pg_temp.als_dienst() returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

/** Eine gueltige freie Rechnung ohne Auftrag (wie MANUELLE-RECHNUNG-03F). */
create function pg_temp.beleg() returns jsonb language sql immutable as $p$
  select '{
    "type": "rechnung", "taxStatus": "standard_19", "customerId": "cust-ap1",
    "customerSnapshot": {"name": "Musterbau GmbH", "street": "Industriestrasse 12", "zip": "33602", "city": "Bielefeld"},
    "issueDate": "2026-09-23",
    "positions": [{"id":"p1","description":"Wartung","quantity":2,"unit":"Stunden","unitPrice":80,"lineTotal":160},
                  {"id":"p2","description":"Anfahrt","quantity":1,"unit":"Pauschal","unitPrice":40,"lineTotal":40}],
    "subtotal": 200, "amount": 238
  }'::jsonb
$p$;

/** Kurzform einer Abweisung. */
create function pg_temp.kurz(p_text text) returns text language sql immutable as $p$
  select case
    when p_text like 'license_not_effective%' or p_text like 'finance_license_expired%' or p_text like 'finance_license_inactive%' then 'lizenz'
    when p_text like 'finance_forbidden_role%' or p_text like 'Keine Schreibberechtigung%' or p_text = 'forbidden_role' then 'rolle'
    when p_text like 'Kein Zugriff%' or p_text like 'workspace_not_member%' or p_text = 'not_member' then 'kein_zugriff'
    when p_text like 'finance_account_blocked%' or p_text like 'account_blocked%' then 'gesperrt'
    when p_text like 'finance_account_not_approved%' or p_text like 'account_not_approved%' then 'nicht_freigegeben'
    when p_text like 'Nicht angemeldet%' or p_text like 'permission denied%' or p_text like 'session_not_active%' then 'nicht_angemeldet'
    else 'sonst:' || left(p_text, 60)
  end
$p$;

/*
 * Fuehrt einen Weg fuer ein Konto aus und liefert 'E' (zugelassen) oder 'A:<kurz>' (abgewiesen). Jede Aktion laeuft
 * in einem eigenen Unterblock; auch ein Erfolg wird zurueckgerollt (gezielte Ausnahme). Wege mit Wahrheitswert
 * (RLS-Lesen, Storage-Helfer) und Ablehnungsgrund (Edge Functions) werden ausgewertet statt geworfen.
 */
create function pg_temp.weg(p_weg text, p_konto text, p_ws uuid, p_user uuid) returns text language plpgsql as $p$
declare
  v_ergebnis text;
  v_zahl bigint;
  v_wahr boolean;
  v_grund text;
  v_json jsonb;
begin
  begin
    if p_weg in ('8', '9', '10', '11') then
      perform pg_temp.als_dienst();
      v_grund := public.workspace_user_access_denial(p_ws, p_user, case when p_weg = '10' then 'member' else 'write' end);
      raise exception 'WEG_ERGEBNIS:%', case when v_grund is null then 'E' else 'A:' || pg_temp.kurz(v_grund) end;
    end if;
    if p_user is null then perform pg_temp.als_anon(); else perform pg_temp.als(p_user); end if;
    if p_weg = '1' then
      v_json := public.ensure_personal_workspace(null);
      raise exception 'WEG_ERGEBNIS:%', case when (v_json->'workspace'->>'id')::uuid = p_ws and not (v_json->>'created')::boolean then 'E' else 'A:sonst:' || coalesce(v_json::text, 'null') end;
    elsif p_weg = '2' then
      select count(*) into v_zahl from public.workspace_customers c where c.workspace_id = p_ws;
      raise exception 'WEG_ERGEBNIS:%', case when v_zahl > 0 then 'E' else 'A:leer' end;
    elsif p_weg = '3' then
      perform public.pull_workspace_sync_state(p_ws);
    elsif p_weg = '4' then
      perform public.upsert_workspace_sync_entity(p_ws, 'customer',
        jsonb_build_object('customer_id', 'cust-neu-' || p_konto, 'payload', jsonb_build_object('name', 'Neu ' || p_konto)), 0);
    elsif p_weg = '5' then
      perform public.upsert_workspace_sync_entity(p_ws, 'workspace_settings', jsonb_build_object('settings', jsonb_build_object('probe', p_konto)), 0);
    elsif p_weg = '6' then
      perform public.upsert_workspace_intake_entity(p_ws, 'archived_document',
        jsonb_build_object('client_document_id', 'doc-neu-' || p_konto, 'deleted', false,
          'payload', jsonb_build_object('id', 'doc-neu-' || p_konto, 'title', 'Neu')), 0);
    elsif p_weg = '6s' then
      v_wahr := public.workspace_file_object_can_write(p_ws::text || '/' || repeat('f', 64));
      raise exception 'WEG_ERGEBNIS:%', case when v_wahr then 'E' else 'A:helfer' end;
    elsif p_weg = '7' then
      v_wahr := public.workspace_file_object_can_read(p_ws::text || '/' || repeat(case when p_konto = 'g' then '2' else '1' end, 64));
      raise exception 'WEG_ERGEBNIS:%', case when v_wahr then 'E' else 'A:helfer' end;
    elsif p_weg = '12' then
      perform public.finalize_workspace_invoice(p_ws, null, 'ap1-' || p_konto, pg_temp.beleg());
    else
      raise exception 'unbekannter Weg %', p_weg;
    end if;
    raise exception 'WEG_ERGEBNIS:E';
  exception when others then
    if sqlerrm like 'WEG_ERGEBNIS:%' then
      v_ergebnis := substr(sqlerrm, length('WEG_ERGEBNIS:') + 1);
    else
      v_ergebnis := 'A:' || pg_temp.kurz(sqlerrm);
    end if;
  end;
  return v_ergebnis;
end;
$p$;

/* ------------------------------------------------------------------ */
/* N-Z1 Zugangsmatrix                                                  */
/* ------------------------------------------------------------------ */

do $$
declare
  v_spalte record;
  v_weg text;
  v_ist text;
  v_soll text;
  v_abweichungen text[] := array[]::text[];
  v_anzahl integer := 0;
  -- Erwartung je Weg und Spalte: E = erlaubt, A = abgewiesen (beliebiger Grund), A:<grund> = genau dieser Grund.
  v_matrix jsonb := '{
    "1":  {"a":"A","b":"A:nicht_freigegeben","c":"A:nicht_freigegeben","d":"A:gesperrt","e":"E","f":"E","g":"E","i":"E","j":"E","k":"E","l":"E","m":"E"},
    "2":  {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"E","h":"A","i":"E","j":"E","k":"E","l":"E","m":"E"},
    "3":  {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"E","h":"A","i":"E","j":"E","k":"E","l":"E","m":"E"},
    "4":  {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"A:rolle","h":"A","i":"A:lizenz","j":"A:lizenz","k":"A:rolle","l":"A:lizenz","m":"A:lizenz"},
    "5":  {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"A:rolle","h":"A","i":"A:lizenz","j":"A:lizenz","k":"A:rolle","l":"A:lizenz","m":"A:lizenz"},
    "6":  {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"E","h":"A","i":"A:lizenz","j":"A:lizenz","k":"A:lizenz","l":"A:lizenz","m":"A:lizenz"},
    "6s": {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"E","h":"A","i":"A","j":"A","k":"A","l":"A","m":"A"},
    "7":  {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"E","h":"A","i":"E","j":"E","l":"E","m":"E"},
    "8":  {"a":"A","b":"A:nicht_freigegeben","c":"A:nicht_freigegeben","d":"A:gesperrt","e":"E","f":"E","g":"A:rolle","h":"A:kein_zugriff","i":"A:lizenz","j":"A:lizenz","k":"A:rolle","l":"A:lizenz","m":"A:lizenz"},
    "9":  {"a":"A","b":"A:nicht_freigegeben","c":"A:nicht_freigegeben","d":"A:gesperrt","e":"E","f":"E","g":"A:rolle","h":"A:kein_zugriff","i":"A:lizenz","j":"A:lizenz","k":"A:rolle","l":"A:lizenz","m":"A:lizenz"},
    "10": {"a":"A","b":"A:nicht_freigegeben","c":"A:nicht_freigegeben","d":"A:gesperrt","e":"E","f":"E","g":"E","h":"A:kein_zugriff","i":"A:lizenz","j":"A:lizenz","k":"A:lizenz","l":"A:lizenz","m":"A:lizenz"},
    "11": {"a":"A","b":"A:nicht_freigegeben","c":"A:nicht_freigegeben","d":"A:gesperrt","e":"E","f":"E","g":"A:rolle","h":"A:kein_zugriff","i":"A:lizenz","j":"A:lizenz","k":"A:rolle","l":"A:lizenz","m":"A:lizenz"},
    "12": {"a":"A","b":"A","c":"A","d":"A","e":"E","f":"E","g":"A:rolle","h":"A","i":"A:lizenz","j":"A:lizenz","k":"A:rolle","l":"A:lizenz","m":"A:lizenz"}
  }'::jsonb;
begin
  for v_spalte in
    select * from (values
      ('a', null::text, 'w1'), ('b', 'p1', 'w1'), ('c', 'ohneprofil', 'w1'), ('d', 'g1', 'w1'),
      ('e', 'o1', 'w1'), ('f', 'a1', 'w1'), ('g', 'm1', 'w1'), ('h', 'o1', 'w2'),
      ('i', 'l1', 'w2'), ('j', 'a2', 'w2'), ('k', 'm2', 'w2'), ('l', 'o5', 'w5'), ('m', 'a6', 'w6')
    ) as s(spalte, konto, ws)
  loop
    for v_weg in select jsonb_object_keys(v_matrix) loop
      v_soll := v_matrix->v_weg->>v_spalte.spalte;
      continue when v_soll is null;
      v_ist := pg_temp.weg(v_weg, v_spalte.spalte,
        case v_spalte.ws when 'w1' then pg_temp.w1() when 'w2' then pg_temp.w2() when 'w5' then pg_temp.w5() else pg_temp.w6() end,
        case when v_spalte.konto is null then null else pg_temp.k(v_spalte.konto) end);
      v_anzahl := v_anzahl + 1;
      if not (v_ist = v_soll or (v_soll = 'A' and v_ist like 'A:%')) then
        v_abweichungen := v_abweichungen || format('N-Z1.%s%s ist %s, soll %s', v_weg, v_spalte.spalte, v_ist, v_soll);
      end if;
    end loop;
  end loop;
  if array_length(v_abweichungen, 1) > 0 then
    raise exception 'N-Z1 Zugangsmatrix weicht ab (% von % Zellen): %', array_length(v_abweichungen, 1), v_anzahl, array_to_string(v_abweichungen, '; ');
  end if;
  raise notice 'OK  N-Z1 Zugangsmatrix: % Zellen (Wege 1-12, Konten a-m) wie erwartet', v_anzahl;
end $$;

/* ------------------------------------------------------------------ */
/* Z-01 bis Z-07 -- Einzelfaelle mit Wirkung                           */
/* ------------------------------------------------------------------ */

create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text, p_code text default null)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    if p_code is not null and sqlstate <> p_code then
      raise exception '% -- falscher Fehlercode: % (erwartet: %)', p_label, sqlstate, p_code;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.betriebe_von(p_user uuid) returns bigint language sql as $p$
  select count(*) from public.workspaces where owner_user_id = p_user
$p$;

do $$
declare
  v jsonb;
begin
  -- Z-01.1 / Z-01.5: P1 wartend (Metadaten behaupten approved) -> 42501 account_not_approved, nichts angelegt.
  perform pg_temp.als(pg_temp.k('p1'));
  perform pg_temp.erwarte_abweisung('Z-01.1 P1 ensure', 'select public.ensure_personal_workspace(null)', 'account_not_approved', '42501');
  perform pg_temp.zurueck();
  if pg_temp.betriebe_von(pg_temp.k('p1')) <> 0 then raise exception 'Z-01.1 Betrieb fuer P1 angelegt'; end if;
  -- Z-01.2: Konto ohne Profilzeile.
  perform pg_temp.als(pg_temp.k('ohneprofil'));
  perform pg_temp.erwarte_abweisung('Z-01.2 ohne Profil', 'select public.ensure_personal_workspace(null)', 'account_not_approved', '42501');
  perform pg_temp.zurueck();
  if pg_temp.betriebe_von(pg_temp.k('ohneprofil')) <> 0 then raise exception 'Z-01.2 Betrieb ohne Profil angelegt'; end if;
  -- Z-03.1: N1 freigegeben, ohne Lizenz und Mitgliedschaft -> no_license, nichts angelegt.
  perform pg_temp.als(pg_temp.k('n1'));
  v := public.ensure_personal_workspace(null);
  perform pg_temp.zurueck();
  if v->>'reason' is distinct from 'no_license' or v->'workspace' <> 'null'::jsonb or (v->>'created')::boolean then
    raise exception 'Z-03.1 N1 erhielt %', v;
  end if;
  if pg_temp.betriebe_von(pg_temp.k('n1')) <> 0 or exists (select 1 from public.workspace_members where user_id = pg_temp.k('n1')) then
    raise exception 'Z-03.1 fuer N1 angelegt';
  end if;
  -- Z-04.1 / Z-09.3: neues lizenziertes Konto -> genau ein Betrieb; die Wiederholung liefert denselben.
  perform pg_temp.als(pg_temp.k('neu'));
  v := public.ensure_personal_workspace('Neu');
  if not (v->>'created')::boolean then raise exception 'Z-04.1 nicht angelegt: %', v; end if;
  if (public.ensure_personal_workspace('Neu')->'workspace'->>'id') is distinct from v->'workspace'->>'id' then
    raise exception 'Z-09.3 Wiederholung liefert einen anderen Betrieb';
  end if;
  perform pg_temp.zurueck();
  if pg_temp.betriebe_von(pg_temp.k('neu')) <> 1 then raise exception 'Z-04.1 nicht genau ein Betrieb'; end if;
  raise notice 'OK  Z-01.1, Z-01.2, Z-01.5, Z-03.1, Z-04.1, Z-09.3 Betriebsanlage nach Freigabe und eigener Lizenz';
end $$;

do $$
begin
  -- Z-01.3: O1 mit unveraendertem Token, danach gesperrt -> naechster Schreibaufruf abgewiesen.
  update public.profiles set status = 'blocked' where id = pg_temp.k('o1');
  perform pg_temp.als(pg_temp.k('o1'));
  perform pg_temp.erwarte_abweisung('Z-01.3 Sperre nach Tokenausgabe',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w1(), 'customer', '{"customer_id":"cust-z013","payload":{"name":"X"}}'),
    'Kein Zugriff');
  perform pg_temp.zurueck();
  update public.profiles set status = 'approved' where id = pg_temp.k('o1');
  raise notice 'OK  Z-01.3 die Sperre wirkt beim naechsten Aufruf trotz altem Token';
end $$;

do $$
declare
  v_zeilen bigint;
  v jsonb;
begin
  -- Z-04.3: O1 schreibt einen Kunden -> genau eine Zeile.
  perform pg_temp.als(pg_temp.k('o1'));
  perform public.upsert_workspace_sync_entity(pg_temp.w1(), 'customer', '{"customer_id":"cust-z043","payload":{"name":"Neu"}}'::jsonb, 0);
  perform pg_temp.zurueck();
  select count(*) into v_zeilen from public.workspace_customers where workspace_id = pg_temp.w1() and customer_id = 'cust-z043';
  if v_zeilen <> 1 then raise exception 'Z-04.3 % Zeilen', v_zeilen; end if;
  -- Z-04.9 / Z-07.1: Freigabe durch O1 und durch A1 (ohne eigene Lizenz) -> je genau eine Nummer.
  perform pg_temp.als(pg_temp.k('o1'));
  v := public.finalize_workspace_invoice(pg_temp.w1(), null, 'z049-o1', pg_temp.beleg());
  perform pg_temp.als(pg_temp.k('a1'));
  v := public.finalize_workspace_invoice(pg_temp.w1(), null, 'z071-a1', pg_temp.beleg());
  perform pg_temp.zurueck();
  if (select count(*) from public.workspace_invoices where workspace_id = pg_temp.w1() and coalesce(invoice_number, '') <> '') <> 2 then
    raise exception 'Z-04.9/Z-07.1 nicht genau zwei Nummern';
  end if;
  raise notice 'OK  Z-04.3, Z-04.9, Z-07.1 O1 schreibt genau eine Zeile; O1 und A1 (ohne eigene Lizenz) geben je eine Rechnung frei';
end $$;

do $$
declare
  v_vorher jsonb;
begin
  -- Z-05.3 / Z-05.7: L1 (W2 abgelaufen) -> Schreiben license_not_effective, Freigabe finance_license_expired, keine Zeile, keine Nummer.
  select jsonb_build_object(
    'kunden', (select count(*) from public.workspace_customers where workspace_id = pg_temp.w2()),
    'einstellungen', (select count(*) from public.workspace_settings where workspace_id = pg_temp.w2()),
    'rechnungen', (select count(*) from public.workspace_invoices where workspace_id = pg_temp.w2()),
    'nummern', (select count(*) from public.workspace_invoice_sequences where workspace_id = pg_temp.w2())) into v_vorher;
  perform pg_temp.als(pg_temp.k('l1'));
  perform pg_temp.erwarte_abweisung('Z-05.3 Kunde',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w2(), 'customer', '{"customer_id":"cust-z053","payload":{"name":"X"}}'),
    'license_not_effective', '42501');
  perform pg_temp.erwarte_abweisung('Z-05.3 Einstellungen',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w2(), 'workspace_settings', '{"settings":{"x":1}}'),
    'license_not_effective', '42501');
  perform pg_temp.erwarte_abweisung('Z-05.7 Freigabe',
    format('select public.finalize_workspace_invoice(%L, null, %L, %L::jsonb)', pg_temp.w2(), 'z057-l1', pg_temp.beleg()),
    'finance_license_expired');
  -- Z-05.2 / Z-05.8: Lesen, Abzug und gespeicherte Dateien bleiben.
  perform public.pull_workspace_sync_state(pg_temp.w2());
  perform public.pull_workspace_invoices(pg_temp.w2(), null);
  if not public.workspace_file_object_can_read(pg_temp.w2()::text || '/' || repeat('1', 64)) then
    raise exception 'Z-05.8 gespeicherte Datei nicht lesbar';
  end if;
  perform pg_temp.zurueck();
  if jsonb_build_object(
    'kunden', (select count(*) from public.workspace_customers where workspace_id = pg_temp.w2()),
    'einstellungen', (select count(*) from public.workspace_settings where workspace_id = pg_temp.w2()),
    'rechnungen', (select count(*) from public.workspace_invoices where workspace_id = pg_temp.w2()),
    'nummern', (select count(*) from public.workspace_invoice_sequences where workspace_id = pg_temp.w2())) is distinct from v_vorher then
    raise exception 'Z-05 abgewiesen, aber Stand veraendert';
  end if;
  -- Z-06.2 / Z-06.3 / Z-06.4: M2 -> Eingang, Aufgabe, Dokumentbindung, Finanz abgewiesen.
  perform pg_temp.als(pg_temp.k('m2'));
  perform pg_temp.erwarte_abweisung('Z-06.2 Eingang',
    format('select public.upsert_workspace_intake_entity(%L, %L, %L::jsonb, 0)', pg_temp.w2(), 'archived_document',
      '{"client_document_id":"doc-z062","deleted":false,"payload":{"id":"doc-z062","title":"X"}}'), 'license_not_effective', '42501');
  perform pg_temp.erwarte_abweisung('Z-06.3 Aufgabe',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w2(), 'task',
      '{"task_id":"task-z063","payload":{"id":"task-z063","title":"X"}}'), 'license_not_effective', '42501');
  perform pg_temp.erwarte_abweisung('Z-06.4 Finanz',
    format('select public.assert_financial_action_allowed(%L)', pg_temp.w2()), 'finance_forbidden_role');
  perform public.pull_workspace_sync_state(pg_temp.w2());
  perform pg_temp.zurueck();
  -- Z-07.2 / Z-07.4: A2 (eigene Lizenz aktiv, W2 abgelaufen) -> Freigabe finance_license_expired, Einstellungen abgewiesen; A1 erlaubt.
  perform pg_temp.als(pg_temp.k('a2'));
  perform pg_temp.erwarte_abweisung('Z-07.2 A2 Freigabe',
    format('select public.finalize_workspace_invoice(%L, null, %L, %L::jsonb)', pg_temp.w2(), 'z072-a2', pg_temp.beleg()), 'finance_license_expired');
  perform pg_temp.erwarte_abweisung('Z-07.4 A2 Einstellungen',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w2(), 'workspace_settings', '{"settings":{"x":2}}'),
    'license_not_effective', '42501');
  perform pg_temp.als(pg_temp.k('a1'));
  perform public.upsert_workspace_sync_entity(pg_temp.w1(), 'workspace_settings', '{"settings":{"z074":true}}'::jsonb, 0);
  perform pg_temp.zurueck();
  raise notice 'OK  Z-05.2/.3/.7/.8, Z-06.2/.3/.4, Z-07.2/.4 Nur-Lesen bei abgelaufener Betriebslizenz; Lesen und gespeicherte Dateien bleiben';
end $$;

do $$
begin
  -- Z-05.9 / N-Z3.4: Ablauf genau jetzt = abgelaufen; eine Sekunde spaeter = wirksam.
  update public.profiles set license_status = 'active', license_expires_at = now() where id = pg_temp.k('l1');
  if public.workspace_license_state(pg_temp.w2()) <> 'expired' then raise exception 'Z-05.9 now() gilt nicht als abgelaufen'; end if;
  update public.profiles set license_expires_at = now() + interval '1 second' where id = pg_temp.k('l1');
  if public.workspace_license_state(pg_temp.w2()) <> 'effective' then raise exception 'Z-05.9 now()+1s nicht wirksam'; end if;
  update public.profiles set license_status = 'expired', license_expires_at = null where id = pg_temp.k('l1');
  raise notice 'OK  Z-05.9 / N-Z3.4 Ablauf gleich now() ist abgelaufen, now()+1s wirksam';
end $$;

/* ------------------------------------------------------------------ */
/* N-Z2 Finanzschutz E3a                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_klasse record;
  v_konto record;
  v_ist text;
  v_abweichungen text[] := array[]::text[];
  v_anzahl integer := 0;
begin
  for v_klasse in
    select * from (values
      ('Freigabe',        'select public.finalize_workspace_invoice(%1$L, null, %2$L, %3$L::jsonb)'),
      ('Zahlung',         'select public.add_workspace_invoice_payment(%1$L, %4$L, %2$L, 1, %5$L, null, null, %6$L, false)'),
      ('Storno',          'select public.cancel_workspace_invoice(%1$L, %4$L, %7$L)'),
      ('Monatsabschluss', 'select public.close_workspace_accounting_period(%1$L, %8$L::jsonb)'),
      ('Bankabgleich',    'select public.link_workspace_bank_reconciliation(%1$L, %9$L, %10$L, %4$L, %2$L, %2$L)'),
      ('Ruecknahme',      'select public.reverse_workspace_invoice_payment(%1$L, %4$L, %2$L)'),
      ('Kontierung',      'select public.upsert_workspace_accounting_assignment(%1$L, %11$L::jsonb, 0)'),
      ('Ausgabe',         'select public.upsert_workspace_expense(%1$L, %11$L::jsonb, 0)'),
      ('Mitarbeiter',     'select public.upsert_workspace_employee(%1$L, %11$L::jsonb, 0)'),
      ('Nummernkreis',    'select public.set_workspace_invoice_number_start(%1$L, 2027, 5)'),
      ('Nachweis',        'select public.set_workspace_invoice_payment_proof(%1$L, %4$L, %2$L, %2$L)'),
      ('Versandstatus',   'select public.update_workspace_invoice_sent(%1$L, %4$L, %5$L, %6$L, null)')
    ) as k(name, sql)
  loop
    for v_konto in
      select * from (values
        ('O1', 'o1', 'w1', 'E'), ('A1', 'a1', 'w1', 'E'), ('M1', 'm1', 'w1', 'A:rolle'), ('A2', 'a2', 'w2', 'A:lizenz'),
        ('L1', 'l1', 'w2', 'A:lizenz'), ('G1', 'g1', 'w1', 'A:gesperrt'), ('O1 auf W2', 'o1', 'w2', 'A:kein_zugriff'),
        ('PA1', 'pa1', 'w1', 'A:kein_zugriff'), ('O5', 'o5', 'w5', 'A:lizenz'), ('A6', 'a6', 'w6', 'A:lizenz')
      ) as a(name, konto, ws, soll)
    loop
      begin
        perform pg_temp.als(pg_temp.k(v_konto.konto));
        execute format(v_klasse.sql,
          case v_konto.ws when 'w1' then pg_temp.w1() when 'w2' then pg_temp.w2() when 'w5' then pg_temp.w5() else pg_temp.w6() end,
          'nz2-' || v_konto.konto, pg_temp.beleg(), 'z049-o1', '2026-10-06', 'bank', 'Probe',
          '{"periodYear":2026,"periodMonth":1}', 'tx-nz2', 'invoice', '{"id":"nz2"}');
        raise exception 'NZ2_ZUGELASSEN';
      exception when others then
        v_ist := case
          when sqlerrm = 'NZ2_ZUGELASSEN' then 'E'
          when pg_temp.kurz(sqlerrm) like 'sonst:%' then 'E'  -- Berechtigung bestanden, fachliche Pruefung danach
          else 'A:' || pg_temp.kurz(sqlerrm)
        end;
      end;
      perform pg_temp.zurueck();
      v_anzahl := v_anzahl + 1;
      -- Katalog N-Z2: den Sperrcode verlangt nur die Freigabe; sonst genuegt die Abweisung (Mitgliedschaft vor Waechter, GLS01).
      if v_konto.name = 'G1' and v_klasse.name <> 'Freigabe' and v_ist like 'A:%' then
        continue;
      end if;
      if v_ist <> v_konto.soll then
        v_abweichungen := v_abweichungen || format('N-Z2.%s.%s ist %s, soll %s', v_klasse.name, v_konto.name, v_ist, v_konto.soll);
      end if;
    end loop;
  end loop;
  if array_length(v_abweichungen, 1) > 0 then
    raise exception 'N-Z2 Finanzmatrix weicht ab (% von %): %', array_length(v_abweichungen, 1), v_anzahl, array_to_string(v_abweichungen, '; ');
  end if;
  raise notice 'OK  N-Z2 Finanzschutz: % Faelle (12 Klassen x 10 Konten) wie erwartet; massgeblich ist die Betriebslizenz', v_anzahl;
end $$;

do $$
declare
  v_ohne text[];
begin
  -- N-Z2.R: Jeder Aufrufer des Waechters ruft ihn, bevor er schreibt (Rumpf: Aufruf vor dem ersten insert/update/delete).
  select array_agg(p.proname order by p.proname)
  into v_ohne
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc like '%assert_financial_action_allowed%'
    and p.proname <> 'assert_financial_action_allowed'
    and least(
          nullif(position('insert into' in lower(p.prosrc)), 0),
          nullif(position('update public.' in lower(p.prosrc)), 0),
          nullif(position('delete from' in lower(p.prosrc)), 0)
        ) < position('assert_financial_action_allowed' in p.prosrc);
  if v_ohne is not null then
    raise exception 'N-Z2.R Waechter nach der ersten Mutation: %', v_ohne;
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosrc like '%assert_financial_action_allowed%' and p.proname <> 'assert_financial_action_allowed') <> 25 then
    raise exception 'N-Z2.R nicht genau 25 Aufrufer';
  end if;
  if (select provolatile from pg_proc where proname = 'assert_financial_action_allowed') <> 'v' then
    raise exception 'N-Z2 Waechter nicht VOLATILE (FOR SHARE)';
  end if;
  raise notice 'OK  N-Z2.R alle 25 Aufrufer pruefen vor der ersten Mutation; Waechter VOLATILE';
end $$;

/* ------------------------------------------------------------------ */
/* N-Z3 Lizenzquelle                                                   */
/* ------------------------------------------------------------------ */

do $$
begin
  -- N-Z3.1: owner_user_id ist Pflicht und verweist auf ein Konto.
  if (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'owner_user_id') <> 'NO' then
    raise exception 'N-Z3.1 owner_user_id ist nicht NOT NULL';
  end if;
  if not exists (
    select 1 from pg_constraint c where c.conrelid = 'public.workspaces'::regclass and c.contype = 'f'
      and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.workspaces'::regclass and attname = 'owner_user_id')]
  ) then
    raise exception 'N-Z3.1 kein Fremdschluessel auf owner_user_id';
  end if;
  raise notice 'OK  N-Z3.1 owner_user_id NOT NULL mit Fremdschluessel';
end $$;

do $$
begin
  -- N-Z3.2: Inhaberprofil von W7 fehlt (zurueckgerollt) -> A7 schreibt nicht, Finanz inactive, Lesen bleibt.
  begin
    delete from public.profiles where id = pg_temp.k('o7');
    perform pg_temp.als(pg_temp.k('a7'));
    perform pg_temp.erwarte_abweisung('N-Z3.2 Schreiben',
      format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w7(), 'workspace_settings', '{"settings":{"x":1}}'),
      'license_not_effective', '42501');
    perform pg_temp.erwarte_abweisung('N-Z3.2 Finanz',
      format('select public.assert_financial_action_allowed(%L)', pg_temp.w7()), 'finance_license_inactive');
    perform public.pull_workspace_sync_state(pg_temp.w7());
    perform pg_temp.zurueck();
    raise exception 'NZ32_ZURUECK';
  exception when others then
    if sqlerrm <> 'NZ32_ZURUECK' then raise; end if;
  end;
  if not exists (select 1 from public.profiles where id = pg_temp.k('o7')) then raise exception 'N-Z3.2 Rueckrollen fehlgeschlagen'; end if;
  raise notice 'OK  N-Z3.2 fehlendes Inhaberprofil: Schreiben license_not_effective, Finanz finance_license_inactive, Lesen bleibt';
end $$;

do $$
declare
  v_constraint text;
begin
  -- N-Z3.3: Pruefregeln isoliert entfernt, unbekannte Werte -> fail-closed (zurueckgerollt).
  begin
    for v_constraint in
      select conname from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'c'
    loop
      execute format('alter table public.profiles drop constraint %I', v_constraint);
    end loop;
    update public.profiles set license_status = 'lifetime' where id = pg_temp.k('o1');
    if public.workspace_license_state(pg_temp.w1()) <> 'inactive' then raise exception 'N-Z3.3 unbekannte Lizenz nicht fail-closed'; end if;
    perform pg_temp.als(pg_temp.k('a1'));
    perform pg_temp.erwarte_abweisung('N-Z3.3 Schreiben', format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w1(), 'workspace_settings', '{"settings":{"x":1}}'), 'license_not_effective');
    perform pg_temp.erwarte_abweisung('N-Z3.3 Finanz', format('select public.assert_financial_action_allowed(%L)', pg_temp.w1()), 'finance_license_inactive');
    perform pg_temp.zurueck();
    update public.profiles set license_status = 'active', status = 'superuser' where id = pg_temp.k('o1');
    if public.workspace_license_state(pg_temp.w1()) <> 'inactive' then raise exception 'N-Z3.3 unbekannter Status nicht fail-closed'; end if;
    update public.profiles set status = 'superuser' where id = pg_temp.k('a1');
    perform pg_temp.als(pg_temp.k('a1'));
    if public.is_active_workspace_member(pg_temp.w1()) then raise exception 'N-Z3.3 unbekannter eigener Status gilt als freigegeben'; end if;
    perform pg_temp.zurueck();
    raise exception 'NZ33_ZURUECK';
  exception when others then
    if sqlerrm <> 'NZ33_ZURUECK' then raise; end if;
  end;
  if (select count(*) from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'c') = 0 then
    raise exception 'N-Z3.3 Pruefregeln nicht wiederhergestellt';
  end if;
  raise notice 'OK  N-Z3.3 unbekannte Status- und Lizenzwerte werden fail-closed abgewiesen';
end $$;

do $$
declare
  v_w2_rechnung text;
begin
  -- N-Z3.5: A2 wird zusaetzlich Admin in W1 (aktiv). Eine Finanzaktion auf eine W2-Rechnung mit p_workspace_id = W1 trifft
  -- nur den Bestand von W1: keine W2-Zeile wird beruehrt, weder W1-Lizenz noch eigene Lizenz autorisieren W2.
  insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
  values (pg_temp.w2(), null, 'nz35-w2', '2026-7001', 2026, 7001, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb);
  insert into public.workspace_members (workspace_id, user_id, role, status) values (pg_temp.w1(), pg_temp.k('a2'), 'admin', 'active');
  perform pg_temp.als(pg_temp.k('a2'));
  perform pg_temp.erwarte_abweisung('N-Z3.5 fremde Rechnung ueber W1',
    format('select public.cancel_workspace_invoice(%L, %L, %L)', pg_temp.w1(), 'nz35-w2', 'Probe'), '');
  perform pg_temp.erwarte_abweisung('N-Z3.5 direkt auf W2',
    format('select public.cancel_workspace_invoice(%L, %L, %L)', pg_temp.w2(), 'nz35-w2', 'Probe'), 'finance_license_expired');
  perform pg_temp.zurueck();
  select invoice_status into v_w2_rechnung from public.workspace_invoices where workspace_id = pg_temp.w2() and client_invoice_id = 'nz35-w2';
  if v_w2_rechnung <> 'vorbereitet' then raise exception 'N-Z3.5 W2-Rechnung veraendert: %', v_w2_rechnung; end if;
  delete from public.workspace_members where workspace_id = pg_temp.w1() and user_id = pg_temp.k('a2');
  raise notice 'OK  N-Z3.5 eine fremde Rechnung ist ueber einen anderen Betrieb nicht erreichbar';
end $$;

do $$
declare
  v_treffer text[];
begin
  -- N-Z3.6: Kein Client-RPC nimmt eine Inhaber-ID oder Lizenzangabe an (Parameterliste der authenticated-Funktionen).
  -- EINRICHTUNG-01 (AP2, EIN-19): p_license_version in accept_current_legal_terms ist die Fassung der Lizenzbedingungen
  -- (ein Rechtstext wie AGB und Datenschutz), keine Lizenzangabe; das Muster nimmt diesen einen Namen aus.
  select array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')
  into v_treffer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('authenticated', p.oid, 'execute')
    and regexp_replace(pg_get_function_identity_arguments(p.oid), 'p_license_version', '', 'gi') ~* '(owner|licen[cs]e)';
  if v_treffer is not null then
    raise exception 'N-Z3.6 Client-RPC mit Inhaber- oder Lizenzparameter: %', v_treffer;
  end if;
  raise notice 'OK  N-Z3.6 keine Client-RPC nimmt Inhaber- oder Lizenzangaben an';
end $$;

/* ------------------------------------------------------------------ */
/* Vertrag 1.8 -- widerrufene Sitzung                                   */
/* ------------------------------------------------------------------ */

do $$
declare
  v_sitzung uuid := gen_random_uuid();
  v_zahl bigint;
begin
  insert into auth.sessions (id, user_id, created_at, updated_at, aal) values (v_sitzung, pg_temp.k('o1'), now(), now(), 'aal1');
  -- Bestehende Sitzung: Lesen und Schreiben wie gewohnt.
  perform pg_temp.als(pg_temp.k('o1'), v_sitzung);
  select count(*) into v_zahl from public.workspace_customers where workspace_id = pg_temp.w1();
  if v_zahl = 0 then raise exception 'S1.8 bestehende Sitzung liest nicht'; end if;
  perform public.upsert_workspace_sync_entity(pg_temp.w1(), 'workspace_settings', '{"settings":{"sitzung":1}}'::jsonb, 0);
  perform pg_temp.zurueck();
  -- Widerruf (Abmelden auf allen Geraeten): dieselben Claims werden sofort abgewiesen -- mit eigenem Code, damit der
  -- Client die Anmeldung verlangt, statt Auftraege als endgueltig abgewiesen zu verbuchen.
  delete from auth.sessions where id = v_sitzung;
  perform pg_temp.als(pg_temp.k('o1'), v_sitzung);
  perform pg_temp.erwarte_abweisung('S1.8 RLS-Lesen', format('select count(*) from public.workspace_customers where workspace_id = %L', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('S1.8 Schreiben', format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.w1(), 'workspace_settings', '{"settings":{"sitzung":2}}'), 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('S1.8 Finanz', format('select public.assert_financial_action_allowed(%L)', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('S1.8 Abzug', format('select public.pull_workspace_sync_state(%L)', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('S1.8 Betriebsbindung', 'select public.ensure_personal_workspace(null)', 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('S1.8 Zugriffsauskunft', format('select public.get_workspace_access(%L)', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('S1.8 Datei', format('select public.workspace_file_object_can_read(%L)', pg_temp.w1()::text || '/' || repeat('1', 64)), 'session_not_active', '42501');
  perform pg_temp.zurueck();
  -- Zeitlich beendete Sitzung (not_after erreicht) wirkt wie ein Widerruf.
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after) values (v_sitzung, pg_temp.k('o1'), now(), now(), 'aal1', now());
  perform pg_temp.als(pg_temp.k('o1'), v_sitzung);
  perform pg_temp.erwarte_abweisung('S1.8 beendete Sitzung', format('select public.is_active_workspace_member(%L)', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.zurueck();
  -- Eine Sitzung eines anderen Kontos zaehlt nicht.
  update auth.sessions set user_id = pg_temp.k('a1'), not_after = null where id = v_sitzung;
  perform pg_temp.als(pg_temp.k('o1'), v_sitzung);
  perform pg_temp.erwarte_abweisung('S1.8 fremde Sitzung', format('select public.is_active_workspace_member(%L)', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.zurueck();
  -- Ein unbrauchbarer Sitzungsbezug gilt nicht als bestehend.
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.k('o1')::text, 'role', 'authenticated', 'session_id', 'kein-uuid')::text, true);
  set local role authenticated;
  perform pg_temp.erwarte_abweisung('S1.8 unbrauchbarer Bezug', format('select public.is_active_workspace_member(%L)', pg_temp.w1()), 'session_not_active', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  Vertrag 1.8 widerrufene, beendete, fremde oder unbrauchbare Sitzung: Lesen, Schreiben, Finanz, Abzug, Dateien und Bindung sofort mit session_not_active abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* get_workspace_access                                                */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
begin
  perform pg_temp.als(pg_temp.k('m2'));
  v := public.get_workspace_access(pg_temp.w2());
  if v->>'role' <> 'member' or v->>'license_state' <> 'expired' or (v->>'license_effective')::boolean then raise exception 'Zugriffsauskunft M2: %', v; end if;
  perform pg_temp.als(pg_temp.k('a6'));
  v := public.get_workspace_access(pg_temp.w6());
  if v->>'license_state' <> 'inactive' then raise exception 'Zugriffsauskunft A6 (Inhaber gesperrt): %', v; end if;
  perform pg_temp.als(pg_temp.k('a1'));
  v := public.get_workspace_access(pg_temp.w1());
  if v->>'role' <> 'admin' or not (v->>'license_effective')::boolean then raise exception 'Zugriffsauskunft A1: %', v; end if;
  if v ?| array['owner_user_id', 'license_expires_at', 'owner'] then raise exception 'Zugriffsauskunft verraet Inhaberdaten: %', v; end if;
  perform pg_temp.erwarte_abweisung('Zugriffsauskunft fremd', format('select public.get_workspace_access(%L)', pg_temp.w2()), 'Kein Zugriff');
  perform pg_temp.als(pg_temp.k('p1'));
  perform pg_temp.erwarte_abweisung('Zugriffsauskunft wartend', format('select public.get_workspace_access(%L)', pg_temp.w1()), 'Kein Zugriff');
  perform pg_temp.zurueck();
  raise notice 'OK  get_workspace_access: Rolle und Lizenzstand nur fuer aktive freigegebene Mitglieder, ohne Inhaberdaten';
end $$;

/* ------------------------------------------------------------------ */
/* T-04 Postfach-Interna                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_spalte text;
begin
  foreach v_spalte in array array['sync_cursor', 'sync_lease_token', 'sync_lease_until', 'provider_account_subject'] loop
    if has_column_privilege('authenticated', 'public.workspace_mailbox_connections', v_spalte, 'select') then
      raise exception 'T-04.1 % lesbar', v_spalte;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.workspace_mailbox_connections', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_mailbox_connections', 'update')
     or has_table_privilege('authenticated', 'public.workspace_mailbox_connections', 'delete')
     or has_table_privilege('anon', 'public.workspace_mailbox_connections', 'select') then
    raise exception 'T-04.1 Tabellenrechte zu weit';
  end if;
  if not has_column_privilege('authenticated', 'public.workspace_mailbox_connections', 'status', 'select') then
    raise exception 'T-04.1 unkritische Spalte nicht lesbar';
  end if;
  if has_table_privilege('authenticated', 'public.workspace_mailbox_credentials', 'select')
     and exists (select 1 from pg_policy where polrelid = 'public.workspace_mailbox_credentials'::regclass) then
    raise exception 'T-04.5 Zugangsdaten lesbar';
  end if;
  if has_schema_privilege('authenticated', 'vault', 'usage') and has_table_privilege('authenticated', 'vault.secrets', 'select') then
    raise exception 'T-04.5 Vault lesbar';
  end if;
  raise notice 'OK  T-04.1/T-04.5 Cursor, Lease und Kontosubjekt nicht lesbar; keine Schreibrechte; Vault und Zugangsdaten verschlossen';
end $$;

do $$
declare
  v jsonb;
begin
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, mailbox_address, display_name, status, sync_cursor, sync_lease_token, provider_account_subject, created_by)
  values (pg_temp.w1(), 'imap', 'postfach@example.invalid', 'Postfach', 'connected', '{"cursor":"cursor-geheim"}'::jsonb, gen_random_uuid(), 'subjekt-geheim', pg_temp.k('o1'));
  foreach v in array array[to_jsonb(pg_temp.k('m1')), to_jsonb(pg_temp.k('o1'))] loop
    perform pg_temp.als((v #>> '{}')::uuid);
    v := public.list_workspace_mailbox_connections(pg_temp.w1());
    perform pg_temp.zurueck();
    if v::text ~ '(cursor-geheim|subjekt-geheim|sync_lease|sync_cursor|provider_account_subject)' then
      raise exception 'T-04.2/.3 Liste verraet Interna: %', v;
    end if;
    if jsonb_array_length(v) <> 1 then raise exception 'T-04.2/.3 Liste unvollstaendig: %', v; end if;
  end loop;
  perform pg_temp.als(pg_temp.k('m1'));
  perform pg_temp.erwarte_abweisung('T-04.1 direkter Zugriff auf den Cursor',
    format('select sync_cursor from public.workspace_mailbox_connections where workspace_id = %L', pg_temp.w1()), 'permission denied');
  perform pg_temp.zurueck();
  raise notice 'OK  T-04.2/T-04.3 die Liste liefert nur freigegebene Felder; direkter Cursor-Zugriff verweigert';
end $$;

do $$
declare
  v jsonb;
  v_w1 uuid;
  v_w2 uuid;
begin
  -- Z-05.6 (Planerweg): Postfaecher eines Betriebs ohne wirksame Betriebslizenz werden nicht automatisch abgerufen.
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, mailbox_address, display_name, status, created_by)
  values (pg_temp.w2(), 'imap', 'w2-postfach@example.invalid', 'W2', 'connected', pg_temp.k('l1'))
  returning id into v_w2;
  select id into v_w1 from public.workspace_mailbox_connections where workspace_id = pg_temp.w1() limit 1;
  perform pg_temp.als_dienst();
  v := public.list_workspace_mailbox_auto_sync_candidates(1000);
  perform pg_temp.zurueck();
  if not exists (select 1 from jsonb_array_elements(v) e where (e->>'id')::uuid = v_w1) then
    raise exception 'Z-05.6 Postfach des lizenzierten Betriebs fehlt in der Kandidatenliste';
  end if;
  if exists (select 1 from jsonb_array_elements(v) e where (e->>'id')::uuid = v_w2) then
    raise exception 'Z-05.6 Postfach des Betriebs ohne wirksame Lizenz wird automatisch abgerufen';
  end if;
  raise notice 'OK  Z-05.6 automatischer Postfachabruf nur fuer Betriebe mit wirksamer Betriebslizenz';
end $$;

/* ------------------------------------------------------------------ */
/* G Rechte der neuen Funktionen                                        */
/* ------------------------------------------------------------------ */

do $$
declare
  v_funktion text;
begin
  foreach v_funktion in array array['public.workspace_session_active()', 'public.workspace_account_approved(uuid)',
    'public.workspace_license_state(uuid)', 'public.workspace_license_effective(uuid)', 'public.assert_workspace_write_access(uuid, boolean)',
    'public.einrichtung01_workspace_write_guard()'] loop
    if has_function_privilege('authenticated', v_funktion, 'execute') or has_function_privilege('anon', v_funktion, 'execute')
       or has_function_privilege('service_role', v_funktion, 'execute') then
      raise exception 'G interne Funktion % fuer eine Client-Rolle ausfuehrbar', v_funktion;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.workspace_user_access_denial(uuid, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.workspace_user_access_denial(uuid, uuid, text)', 'execute')
     or not has_function_privilege('service_role', 'public.workspace_user_access_denial(uuid, uuid, text)', 'execute') then
    raise exception 'G workspace_user_access_denial nur fuer service_role';
  end if;
  if not has_function_privilege('authenticated', 'public.get_workspace_access(uuid)', 'execute')
     or has_function_privilege('anon', 'public.get_workspace_access(uuid)', 'execute') then
    raise exception 'G get_workspace_access nur fuer authenticated';
  end if;
  if has_function_privilege('anon', 'public.ensure_personal_workspace(text)', 'execute')
     or has_function_privilege('service_role', 'public.ensure_personal_workspace(text)', 'execute') then
    raise exception 'G ensure_personal_workspace Rechte veraendert';
  end if;
  if (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'zz_einrichtung01_schreibschutz') <> 52 then
    raise exception 'G nicht genau 52 Schreibschutz-Trigger';
  end if;
  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname = 'zz_einrichtung01_schreibschutz'
             and c.relname in ('workspace_members', 'workspace_mailbox_oauth_states')) then
    raise exception 'G Schreibschutz an Team- oder OAuth-Zwischenstand';
  end if;
  raise notice 'OK  G interne Pruefungen ohne Client-Rechte; Ablehnungsgrund nur service_role; Auskunft nur authenticated; 52 Trigger';
end $$;

rollback;
