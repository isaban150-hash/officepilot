-- EINRICHTUNG-01 / AP2 -- Zustimmung zu den Rechtstexten (EIN-19; Katalog V3 A-13.1, A-13.2, A-13.4, A-14.1, A-14.3,
-- A-14.4; Vertrag 1.8).
--
--   A-13.1  Registrierung mit Gerätezeit in den Metadaten: gespeichert wird die Serverzeit.
--   A-13.2  unbekannte Rechtstext-Version: Zustimmung gilt als nicht erteilt (keine Version, kein Zeitpunkt).
--   A-13.4  Status, Lizenz und Rolle in den Metadaten manipuliert: Profil pending, user, inactive.
--   A-14.1  Zustimmen zur geltenden Fassung speichert Version und Serverzeit für genau dieses Konto.
--   A-14.3  Eine Zustimmung, die ein anderes Konto nennt, wirkt nicht (consent_account_mismatch).
--   A-14.4  Zustimmen ändert Status, Lizenz und Rolle nicht.
--   dazu    unbekannte Fassung, gesperrtes Konto, beendete Sitzung, anonym; Rechte der neuen Funktionen.
--
-- Als Rolle authenticated mit synthetischen Claims. Alles wird zurückgerollt. Ausführen (nur lokal):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/einrichtung01_ap2_zustimmung.sql
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

create function pg_temp.als(p_user uuid, p_session uuid default null) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    (jsonb_build_object('sub', p_user::text, 'role', 'authenticated')
      || case when p_session is null then '{}'::jsonb else jsonb_build_object('session_id', p_session::text) end)::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

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

/* Registrierung über den echten Trigger (handle_new_user), wie der Auth-Server sie auslöst. */
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  -- R1: geltende Fassung, Gerätezeit weit in der Vergangenheit
  ('00000000-0000-0000-0000-0000000e2b01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r1-ap2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb,
   '{"companyName":"R1","firstName":"R","lastName":"Eins","acceptedTermsVersion":"1.0-draft","acceptedPrivacyVersion":"1.0-draft","acceptedLicenseVersion":"1.0-draft","legalAcceptedAt":"2001-01-01T00:00:00Z"}'::jsonb),
  -- R2: unbekannte Fassung
  ('00000000-0000-0000-0000-0000000e2b02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r2-ap2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb,
   '{"companyName":"R2","firstName":"R","lastName":"Zwei","acceptedTermsVersion":"9.9","acceptedPrivacyVersion":"1.0-draft","acceptedLicenseVersion":"1.0-draft","legalAcceptedAt":"2026-01-01T00:00:00Z"}'::jsonb),
  -- R3: Metadaten behaupten Freigabe, Plattformrolle und Lizenz
  ('00000000-0000-0000-0000-0000000e2b03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r3-ap2@example.invalid', 'x', now(), now(), now(), '{"role":"admin"}'::jsonb,
   '{"companyName":"R3","firstName":"R","lastName":"Drei","status":"approved","role":"admin","license_status":"active","licenseStatus":"active","license_expires_at":"2099-01-01T00:00:00Z","acceptedTermsVersion":"1.0-draft","acceptedPrivacyVersion":"1.0-draft","acceptedLicenseVersion":"1.0-draft"}'::jsonb),
  -- R4: keine Angabe
  ('00000000-0000-0000-0000-0000000e2b04', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'r4-ap2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{"companyName":"R4"}'::jsonb);

do $$
declare
  v record;
begin
  -- A-13.1: Serverzeit, nicht die Gerätezeit.
  select * into v from public.profiles where id = '00000000-0000-0000-0000-0000000e2b01';
  if v.accepted_terms_version <> '1.0-draft' or v.accepted_privacy_version <> '1.0-draft' or v.accepted_license_version <> '1.0-draft' then
    raise exception 'A-13.1 Versionen nicht gespeichert: % % %', v.accepted_terms_version, v.accepted_privacy_version, v.accepted_license_version;
  end if;
  if v.legal_accepted_at is null or v.legal_accepted_at < now() - interval '1 minute' or v.legal_accepted_at > now() + interval '1 minute' then
    raise exception 'A-13.1 Zeitpunkt ist nicht die Serverzeit: %', v.legal_accepted_at;
  end if;
  -- A-13.2: unbekannte Fassung = nicht erteilt, auch nicht teilweise.
  select * into v from public.profiles where id = '00000000-0000-0000-0000-0000000e2b02';
  if v.accepted_terms_version is not null or v.accepted_privacy_version is not null or v.accepted_license_version is not null or v.legal_accepted_at is not null then
    raise exception 'A-13.2 unbekannte Fassung gespeichert: % % % %', v.accepted_terms_version, v.accepted_privacy_version, v.accepted_license_version, v.legal_accepted_at;
  end if;
  -- A-13.4: keine Selbstfreigabe über Metadaten.
  select * into v from public.profiles where id = '00000000-0000-0000-0000-0000000e2b03';
  if v.status <> 'pending' or v.role <> 'user' or v.license_status <> 'inactive' or v.license_expires_at is not null then
    raise exception 'A-13.4 Metadaten wirken: status % role % lizenz % ablauf %', v.status, v.role, v.license_status, v.license_expires_at;
  end if;
  select * into v from public.profiles where id = '00000000-0000-0000-0000-0000000e2b04';
  if v.legal_accepted_at is not null or v.accepted_terms_version is not null then
    raise exception 'A-13.3 ohne Angabe trotzdem Zustimmung gespeichert';
  end if;
  raise notice 'OK  A-13.1/A-13.2/A-13.3/A-13.4 Registrierung: Serverzeit, nur die geltende Fassung, keine Selbstfreigabe';
end $$;

do $$
declare
  v_vorher record;
  v_nachher record;
  v_antwort jsonb;
  v_sitzung uuid := gen_random_uuid();
begin
  -- R2 (pending, ohne gültige Zustimmung) stimmt zu: Ausnahme B, Stufe 1 genügt.
  select status, role, license_status, license_expires_at into v_vorher from public.profiles where id = '00000000-0000-0000-0000-0000000e2b02';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e2b02');
  v_antwort := public.accept_current_legal_terms('00000000-0000-0000-0000-0000000e2b02', '1.0-draft', '1.0-draft', '1.0-draft');
  perform pg_temp.zurueck();
  if v_antwort->>'accepted_terms_version' <> '1.0-draft' or (v_antwort->>'legal_accepted_at') is null then
    raise exception 'A-14.1 Antwort unvollständig: %', v_antwort;
  end if;
  select status, role, license_status, license_expires_at, legal_accepted_at, accepted_privacy_version, accepted_license_version
    into v_nachher from public.profiles where id = '00000000-0000-0000-0000-0000000e2b02';
  if v_nachher.legal_accepted_at is null or abs(extract(epoch from (v_nachher.legal_accepted_at - now()))) > 60 then
    raise exception 'A-14.1 kein Serverzeitpunkt: %', v_nachher.legal_accepted_at;
  end if;
  if v_nachher.accepted_privacy_version <> '1.0-draft' or v_nachher.accepted_license_version <> '1.0-draft' then
    raise exception 'A-14.1 Versionen fehlen';
  end if;
  -- A-14.4: nichts anderes geändert.
  if v_nachher.status is distinct from v_vorher.status or v_nachher.role is distinct from v_vorher.role
     or v_nachher.license_status is distinct from v_vorher.license_status or v_nachher.license_expires_at is distinct from v_vorher.license_expires_at then
    raise exception 'A-14.4 Status, Rolle oder Lizenz verändert';
  end if;

  -- A-14.3: eine Zustimmung, die ein anderes Konto nennt, wirkt nicht -- weder für das genannte noch für das angemeldete.
  perform pg_temp.als('00000000-0000-0000-0000-0000000e2b04');
  perform pg_temp.erwarte_abweisung('A-14.3 fremdes Konto',
    $q$select public.accept_current_legal_terms('00000000-0000-0000-0000-0000000e2b02', '1.0-draft', '1.0-draft', '1.0-draft')$q$,
    'consent_account_mismatch', '42501');
  perform pg_temp.zurueck();
  if (select legal_accepted_at from public.profiles where id = '00000000-0000-0000-0000-0000000e2b04') is not null then
    raise exception 'A-14.3 Zustimmung beim angemeldeten Konto gespeichert';
  end if;

  -- Unbekannte Fassung: abgewiesen, nichts gespeichert.
  perform pg_temp.als('00000000-0000-0000-0000-0000000e2b04');
  perform pg_temp.erwarte_abweisung('A-13.2 unbekannte Fassung',
    $q$select public.accept_current_legal_terms('00000000-0000-0000-0000-0000000e2b04', '2.0', '1.0-draft', '1.0-draft')$q$,
    'legal_version_unknown', '22023');
  perform pg_temp.zurueck();

  -- Gesperrtes Konto: nur Abmelden und Profiländerung (Ausnahme B) -- keine Zustimmung.
  update public.profiles set status = 'blocked' where id = '00000000-0000-0000-0000-0000000e2b04';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e2b04');
  perform pg_temp.erwarte_abweisung('gesperrt',
    $q$select public.accept_current_legal_terms('00000000-0000-0000-0000-0000000e2b04', '1.0-draft', '1.0-draft', '1.0-draft')$q$,
    'account_blocked', '42501');
  perform pg_temp.zurueck();
  update public.profiles set status = 'pending' where id = '00000000-0000-0000-0000-0000000e2b04';

  -- Vertrag 1.8: beendete Sitzung stimmt nicht zu.
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
  values (v_sitzung, '00000000-0000-0000-0000-0000000e2b04', now(), now(), 'aal1', now());
  perform pg_temp.als('00000000-0000-0000-0000-0000000e2b04', v_sitzung);
  perform pg_temp.erwarte_abweisung('Sitzung beendet',
    $q$select public.accept_current_legal_terms('00000000-0000-0000-0000-0000000e2b04', '1.0-draft', '1.0-draft', '1.0-draft')$q$,
    'session_not_active', '42501');
  perform pg_temp.zurueck();
  if (select legal_accepted_at from public.profiles where id = '00000000-0000-0000-0000-0000000e2b04') is not null then
    raise exception 'Abweisungen haben gespeichert';
  end if;
  raise notice 'OK  A-14.1/A-14.3/A-14.4 Zustimmung: Serverzeit, nur das eigene Konto, nur die geltende Fassung, sonst nichts geändert';
end $$;

do $$
begin
  if has_function_privilege('anon', 'public.accept_current_legal_terms(uuid, text, text, text)', 'execute') then
    raise exception 'G anon darf zustimmen';
  end if;
  if not has_function_privilege('authenticated', 'public.accept_current_legal_terms(uuid, text, text, text)', 'execute') then
    raise exception 'G authenticated darf nicht zustimmen';
  end if;
  if has_function_privilege('anon', 'public.legal_current_versions()', 'execute')
     or has_function_privilege('authenticated', 'public.legal_current_versions()', 'execute') then
    raise exception 'G legal_current_versions für Clients freigegeben';
  end if;
  -- Direkte Änderungen am Profil bleiben gesperrt: RLS kennt für Clients nur das Lesen der eigenen Zeile.
  if exists (select 1 from pg_policy where polrelid = 'public.profiles'::regclass and polcmd <> 'r') then
    raise exception 'G profiles hat eine schreibende Richtlinie';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass) then
    raise exception 'G RLS auf profiles aus';
  end if;
  raise notice 'OK  G Rechte: Zustimmung nur authenticated, Versionsfunktion ohne Client-Recht, Profil nur über Serverfunktionen schreibbar';
end $$;

rollback;
