-- EINRICHTUNG-01 / AP3 -- Konto-Bereich und Betriebsname (Katalog V3 K-01.1 bis K-01.3, K-02.1, K-02.2, K-04.1, K-04.2,
-- K-05.1, O-03.1 bis O-03.4, O-05.2, O-05.3).
--
-- Als Rolle authenticated mit synthetischen Claims. Alles wird zurückgerollt. Ausführen (nur lokal):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/einrichtung01_ap3_konto.sql
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

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000e3c01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o1-ap3@example.invalid', 'x', now(), now(), now(), '{}', '{"firstName":"Olga","lastName":"Eins"}'),
  ('00000000-0000-0000-0000-0000000e3c02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm1-ap3@example.invalid', 'x', now(), now(), now(), '{}', '{"firstName":"Mira","lastName":"Eins"}'),
  ('00000000-0000-0000-0000-0000000e3c03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o2-ap3@example.invalid', 'x', now(), now(), now(), '{}', '{"firstName":"Otto","lastName":"Zwei"}');

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
 where id in ('00000000-0000-0000-0000-0000000e3c01', '00000000-0000-0000-0000-0000000e3c03');
update public.profiles set status = 'approved' where id = '00000000-0000-0000-0000-0000000e3c02';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e3ca1', 'AP3 Alt-Name', '00000000-0000-0000-0000-0000000e3c01'),
       ('00000000-0000-0000-0000-0000000e3ca2', 'AP3 Fremd', '00000000-0000-0000-0000-0000000e3c03');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e3ca1', '00000000-0000-0000-0000-0000000e3c01', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000e3ca1', '00000000-0000-0000-0000-0000000e3c02', 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e3ca2', '00000000-0000-0000-0000-0000000e3c03', 'owner', 'active');

-- K-01: eigenes Profil
do $$
declare
  v record;
  v_zeilen bigint;
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c01');
  perform public.update_own_profile('Olga Betrieb', 'Olga', 'Neu', '+49 30 123', 'Bau');
  -- K-01.2: eine fremde Zeile lässt sich direkt nicht ändern (RLS kennt nur das Lesen der eigenen Zeile).
  update public.profiles set first_name = 'Fremd' where id = '00000000-0000-0000-0000-0000000e3c03';
  get diagnostics v_zeilen = row_count;
  if v_zeilen <> 0 then raise exception 'K-01.2 fremdes Profil geändert'; end if;
  -- K-01.3: auch das eigene nicht direkt, schon gar nicht role/status/license.
  update public.profiles set role = 'admin', status = 'approved', license_status = 'active' where id = '00000000-0000-0000-0000-0000000e3c02';
  get diagnostics v_zeilen = row_count;
  if v_zeilen <> 0 then raise exception 'K-01.3 direkte Änderung möglich'; end if;
  perform pg_temp.zurueck();

  select * into v from public.profiles where id = '00000000-0000-0000-0000-0000000e3c01';
  if v.last_name <> 'Neu' or v.phone <> '+49 30 123' then raise exception 'K-01.1 nicht gespeichert'; end if;
  if v.role <> 'user' or v.status <> 'approved' or v.license_status <> 'active' then raise exception 'K-01.3 Rechte verändert'; end if;
  if (select first_name from public.profiles where id = '00000000-0000-0000-0000-0000000e3c03') <> 'Otto' then raise exception 'K-01.2 fremd geändert'; end if;
  if (select role from public.profiles where id = '00000000-0000-0000-0000-0000000e3c02') <> 'user' then raise exception 'K-01.3 Rolle gesetzt'; end if;
  raise notice 'OK  K-01.1/K-01.2/K-01.3 eigenes Profil: Name und Telefon gespeichert; fremde Zeile und Rechtefelder unantastbar';
end $$;

-- K-01 / Vertrag 1.8: beendete Sitzung ändert nichts.
do $$
declare
  v_sitzung uuid := gen_random_uuid();
begin
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
  values (v_sitzung, '00000000-0000-0000-0000-0000000e3c01', now(), now(), 'aal1', now());
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c01', v_sitzung);
  perform pg_temp.erwarte_abweisung('Profil mit beendeter Sitzung', $q$select public.update_own_profile('X', 'X', 'X')$q$, 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('Sprache mit beendeter Sitzung', $q$select public.set_own_ui_language('tr')$q$, 'session_not_active', '42501');
  perform pg_temp.erwarte_abweisung('Mitgliedschaften mit beendeter Sitzung', $q$select * from public.list_own_memberships()$q$, 'session_not_active', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  Vertrag 1.8 Kontowege: beendete Sitzung abgewiesen';
end $$;

-- K-02.1/K-02.2: profiles.email folgt erst dem vollständig bestätigten Wechsel.
do $$
begin
  -- Angefordert, noch nicht bestätigt: Der Auth-Server führt die neue Adresse in email_change, email bleibt.
  update auth.users set email_change = 'neu-o1-ap3@example.invalid', email_change_sent_at = now() where id = '00000000-0000-0000-0000-0000000e3c01';
  if (select email from public.profiles where id = '00000000-0000-0000-0000-0000000e3c01') <> 'o1-ap3@example.invalid' then
    raise exception 'K-02.1 Profil vor der Bestätigung geändert';
  end if;
  -- Beide Links bestätigt: email wird gewechselt.
  update auth.users set email = 'neu-o1-ap3@example.invalid', email_change = '' where id = '00000000-0000-0000-0000-0000000e3c01';
  if (select email from public.profiles where id = '00000000-0000-0000-0000-0000000e3c01') <> 'neu-o1-ap3@example.invalid' then
    raise exception 'K-02.2 Profil folgt nicht';
  end if;
  if (select email from public.profiles where id = '00000000-0000-0000-0000-0000000e3c03') <> 'o2-ap3@example.invalid' then
    raise exception 'K-02 fremdes Profil geändert';
  end if;
  raise notice 'OK  K-02.1/K-02.2 E-Mail: bis zur Bestätigung die alte, danach die neue Adresse in profiles';
end $$;

-- K-04: Sprache je Person, ohne Firmen-Schreibauftrag, auch im Nur-Lesen-Betrieb.
do $$
declare
  v_setup_vorher bigint := (select count(*) from public.workspace_setup);
begin
  -- Nur-Lesen: Die Betriebslizenz von W1 ist abgelaufen (Inhaber O1).
  update public.profiles set license_status = 'expired' where id = '00000000-0000-0000-0000-0000000e3c01';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c02');
  perform public.set_own_ui_language('tr');
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c01');
  perform public.set_own_ui_language('de');
  perform pg_temp.erwarte_abweisung('unbekannte Sprache', $q$select public.set_own_ui_language('xx')$q$, 'ui_language_invalid', '22023');
  perform pg_temp.zurueck();
  if (select ui_language from public.profiles where id = '00000000-0000-0000-0000-0000000e3c02') <> 'tr' then raise exception 'K-04.1 M1 nicht tr'; end if;
  if (select ui_language from public.profiles where id = '00000000-0000-0000-0000-0000000e3c01') <> 'de' then raise exception 'K-04.1 O1 nicht de'; end if;
  if (select count(*) from public.workspace_setup) <> v_setup_vorher then raise exception 'K-04 Firmen-Setup geschrieben'; end if;
  update public.profiles set license_status = 'active' where id = '00000000-0000-0000-0000-0000000e3c01';
  raise notice 'OK  K-04.1/K-04.2 Sprache je Person am Profil, auch im Nur-Lesen-Betrieb, ohne Firmen-Schreibauftrag';
end $$;

-- K-05.1: eigene Mitgliedschaften mit Betrieb und Rolle; nichts Fremdes.
do $$
declare
  v_zeilen jsonb;
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c02');
  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_zeilen from public.list_own_memberships() m;
  perform pg_temp.zurueck();
  if jsonb_array_length(v_zeilen) <> 1 or v_zeilen->0->>'workspace_name' <> 'AP3 Alt-Name' or v_zeilen->0->>'role' <> 'member' then
    raise exception 'K-05.1 falsche Mitgliedschaften: %', v_zeilen;
  end if;
  raise notice 'OK  K-05.1 eigene Mitgliedschaften: richtiger Betrieb, richtige Rolle, nichts Fremdes';
end $$;

-- O-03: Betriebsname folgt dem Firmennamen -- beides oder nichts, nur der eigene Betrieb.
do $$
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c01');
  perform public.upsert_workspace_sync_entity('00000000-0000-0000-0000-0000000e3ca1', 'company_profile',
    jsonb_build_object('payload', jsonb_build_object('companyName', 'Olga Bau GmbH', 'contactPerson', 'Olga', 'street', 'Weg 1', 'zip', '10115', 'city', 'Berlin', 'email', 'info@olga.invalid', 'iban', 'DE89370400440532013000', 'taxNumber', '12/345/67890'), 'schemaVersion', 2), 0);
  perform pg_temp.zurueck();
  if (select name from public.workspaces where id = '00000000-0000-0000-0000-0000000e3ca1') <> 'Olga Bau GmbH' then
    raise exception 'O-03.1 Betriebsname folgt nicht: %', (select name from public.workspaces where id = '00000000-0000-0000-0000-0000000e3ca1');
  end if;
  if (select name from public.workspaces where id = '00000000-0000-0000-0000-0000000e3ca2') <> 'AP3 Fremd' then raise exception 'O-03.4 fremder Betrieb geändert'; end if;

  -- O-03.2: spätere Änderung.
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c01');
  perform public.upsert_workspace_sync_entity('00000000-0000-0000-0000-0000000e3ca1', 'company_profile',
    jsonb_build_object('payload', jsonb_build_object('companyName', 'Olga Bau und Sanierung GmbH'), 'schemaVersion', 3),
    (select row_version from public.workspace_company_profiles where workspace_id = '00000000-0000-0000-0000-0000000e3ca1'));
  perform pg_temp.zurueck();
  if (select name from public.workspaces where id = '00000000-0000-0000-0000-0000000e3ca1') <> 'Olga Bau und Sanierung GmbH' then
    raise exception 'O-03.2 spätere Änderung folgt nicht';
  end if;

  -- O-03.3: abgewiesene Profiländerung (Mitglied) ändert auch den Namen nicht. O-05.2: Mitglied darf Setup und Profil nicht schreiben.
  perform pg_temp.als('00000000-0000-0000-0000-0000000e3c02');
  perform pg_temp.erwarte_abweisung('O-05.2 Profil durch Mitglied',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-0000000e3ca1', 'company_profile', '{"payload":{"companyName":"Unterwandert"},"schemaVersion":3}'::jsonb, 2)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_abweisung('O-05.2 Setup durch Mitglied',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-0000000e3ca1', 'company_setup', '{"payload":{"companyName":"Unterwandert","setupComplete":true}}'::jsonb, 0)$q$,
    'Keine Schreibberechtigung');
  -- O-05.3: Nummernkreis direkt. Das Format läuft über den Finanzwächter (finance_forbidden_role). Der Startwert prüft
  -- in FINANZ-CORE-01A die Rolle schon vor dem Wächter und meldet „Keine Schreibberechtigung“ -- abgewiesen ohne Wirkung;
  -- der im Katalog genannte Code käme nur mit einer Änderung am FC01A-Rumpf (Abweichung, gemeldet, nicht geändert).
  perform pg_temp.erwarte_abweisung('O-05.3 Nummernformat durch Mitglied',
    $q$select public.set_workspace_invoice_number_format('00000000-0000-0000-0000-0000000e3ca1', 'RE-{YYYY}-{NNNN}', true, 4, 0)$q$,
    'finance_forbidden_role');
  perform pg_temp.erwarte_abweisung('O-05.3 Nummernstart durch Mitglied',
    $q$select public.set_workspace_invoice_number_start('00000000-0000-0000-0000-0000000e3ca1', 2026, 100)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.zurueck();
  if (select name from public.workspaces where id = '00000000-0000-0000-0000-0000000e3ca1') <> 'Olga Bau und Sanierung GmbH' then
    raise exception 'O-03.3 Name trotz Abweisung geändert';
  end if;
  raise notice 'OK  O-03.1/O-03.2/O-03.3/O-03.4 Betriebsname folgt dem Firmennamen in derselben Transaktion; O-05.2/O-05.3 Mitglied abgewiesen';
end $$;

-- Rechte der neuen Funktionen.
do $$
begin
  if has_function_privilege('anon', 'public.set_own_ui_language(text)', 'execute') or has_function_privilege('anon', 'public.list_own_memberships()', 'execute') then
    raise exception 'G anon darf Kontowege';
  end if;
  if not has_function_privilege('authenticated', 'public.set_own_ui_language(text)', 'execute') or not has_function_privilege('authenticated', 'public.list_own_memberships()', 'execute') then
    raise exception 'G authenticated fehlt';
  end if;
  if has_function_privilege('authenticated', 'public.sync_profile_email_from_auth()', 'execute')
     or has_function_privilege('authenticated', 'public.einrichtung01_workspace_name_follows_company()', 'execute') then
    raise exception 'G Triggerfunktionen für Clients aufrufbar';
  end if;
  raise notice 'OK  G Rechte: Kontowege nur authenticated, Triggerfunktionen ohne Client-Recht';
end $$;

rollback;
