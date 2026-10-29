-- EINRICHTUNG-01 / EIN-06 -- Vertragstest Firmenprofil-Schema 3 (Katalog V3, Vertrag 1.10).
--
--   S-06  Schema 2 bewahrt die spaeter eingefuehrten Felder (introduced_in = 3); echter
--         Schema-2-Payload aus dem Stand vor AP0 (Fixture, unten wortgleich eingebettet,
--         Gleichheit mit supabase/tests/fixtures/einrichtung01_s06_schema2_payload.json
--         belegt ein Vitest); Versionskonflikt; Zurueckschreiben nach einem Schema-3-Stand.
--   S-07  Schema 3 ist ein Patch: fehlend = unveraendert, null loescht Optionales,
--         Pflichtfelder und Steuerangaben geschuetzt, ungueltige Payloads nie als Loeschen,
--         ohne Versionsangabe Bewahrung wie Schema 1.
--   S-08  Textgrenzen in Codepunkten (Grenze-1, Grenze, Grenze+1 aus ae, Euro, Bauarbeiter),
--         Betreffe ohne Zeilenumbruch.
--   S-09  Server-Katalog = erwartete Felder; Rechte (has_function_privilege).
--   dazu  Mitglied darf nicht schreiben; Neuanlage per Schema 3; Branding-Regel.
--
-- Jede Schreibpruefung laeuft als Rolle authenticated mit den Claims des Nutzers.
-- Ausfuehren (nur lokal):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/einrichtung01_profil_schema3.sql
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
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
  ('00000000-0000-0000-0000-0000000e1601'::uuid, 'inhaber-ein01-s3@example.invalid'),
  ('00000000-0000-0000-0000-0000000e1602'::uuid, 'mitglied-ein01-s3@example.invalid'),
  ('00000000-0000-0000-0000-0000000e1603'::uuid, 'inhaber2-ein01-s3@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-0000000e1601'::uuid, '00000000-0000-0000-0000-0000000e1602'::uuid,
             '00000000-0000-0000-0000-0000000e1603'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e16a1'::uuid, 'EIN01 Schema 3', '00000000-0000-0000-0000-0000000e1601'::uuid),
       ('00000000-0000-0000-0000-0000000e16b1'::uuid, 'EIN01 Schema 3 neu', '00000000-0000-0000-0000-0000000e1603'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e16a1'::uuid, '00000000-0000-0000-0000-0000000e1601'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e16a1'::uuid, '00000000-0000-0000-0000-0000000e1602'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e16b1'::uuid, '00000000-0000-0000-0000-0000000e1603'::uuid, 'owner',  'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e16a1'::uuid $p$;
create function pg_temp.ws_neu() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e16b1'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e1601'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e1602'::uuid $p$;
create function pg_temp.inhaber_neu() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e1603'::uuid $p$;

/** Fixture S-06.1: der echte Schema-2-Payload eines Clients vor AP0 (ohne die spaeteren Felder). */
create function pg_temp.fixture() returns jsonb language sql immutable as $fixture$ select $json${
  "payload": {
    "companyName": "Beispiel Haustechnik",
    "legalForm": "GmbH",
    "street": "Musterstraße 5",
    "zip": "33602",
    "city": "Bielefeld",
    "country": "Deutschland",
    "contactPerson": "A. Beispiel",
    "phone": "+49 521 000000",
    "email": "info@beispiel-haustechnik.example",
    "website": "https://beispiel-haustechnik.example",
    "taxNumber": "305/123/45678",
    "vatId": "",
    "bankName": "Beispielbank",
    "iban": "DE89370400440532013000",
    "bic": "COBADEFFXXX",
    "defaultPaymentDays": 14,
    "defaultPaymentTerms": "Zahlbar innerhalb von 14 Tagen ohne Abzug.",
    "defaultSkonto": "",
    "skontoEnabled": false,
    "skontoPercent": 0,
    "skontoDays": 0,
    "managingDirector": "",
    "taxFreeNotice": "Die Leistung ist ohne Umsatzsteuer.",
    "invoiceFooterNotes": "",
    "defaultTaxStatus": "standard_19",
    "currency": "EUR",
    "replyToEmail": "antwort@beispiel-haustechnik.example",
    "senderDisplayName": "Beispiel Haustechnik GmbH",
    "branding": {
      "documentTemplate": "classic"
    }
  },
  "profile_schema_version": 2
}
$json$::jsonb $fixture$;

/** Die 13 nach der ersten Fassung ohne Katalogeintrag eingefuehrten Felder (introduced_in = 3). */
create function pg_temp.neuere_felder() returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'accountHolder', 'Beispiel Haustechnik GmbH',
    'countryCode', 'DE',
    'defaultIntroText', 'Wir danken fuer Ihren Auftrag.',
    'defaultClosingText', 'Mit freundlichen Gruessen',
    'defaultInvoiceEmailSubject', 'Rechnung {nummer}',
    'defaultInvoiceEmailBody', 'Anbei die Rechnung.',
    'defaultOfferEmailSubject', 'Angebot {nummer}',
    'defaultOfferEmailBody', 'Anbei das Angebot.',
    'defaultLetterEmailSubject', 'Schreiben',
    'defaultLetterEmailBody', 'Anbei unser Schreiben.',
    'emailSignature', 'Beispiel Haustechnik GmbH' || chr(10) || 'Musterstrasse 5',
    'registrationAuthority', 'Amtsgericht Bielefeld',
    'registrationNumber', 'HRB 1234'
  )
$p$;

create function pg_temp.vollprofil() returns jsonb language sql immutable as $p$
  select (pg_temp.fixture()->'payload') || pg_temp.neuere_felder()
$p$;

/** Als dieser Nutzer -- Rolle authenticated, damit RLS und Funktionsrechte greifen. */
create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

create function pg_temp.profil(p_ws uuid default null) returns jsonb language sql as $p$
  select payload from public.workspace_company_profiles where workspace_id = coalesce(p_ws, pg_temp.ws());
$p$;

create function pg_temp.version(p_ws uuid default null) returns bigint language sql as $p$
  select row_version from public.workspace_company_profiles where workspace_id = coalesce(p_ws, pg_temp.ws());
$p$;

/** Sendet als Nutzer; der Aufruf laeuft als authenticated, danach zurueck zu postgres. */
create function pg_temp.sende(p_user uuid, p_payload jsonb, p_version bigint, p_ws uuid default null) returns jsonb language plpgsql as $p$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.upsert_workspace_sync_entity(coalesce(p_ws, pg_temp.ws()), 'company_profile', p_payload, p_version);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.patch(p_felder jsonb) returns jsonb language sql immutable as $p$
  select jsonb_build_object('payload', p_felder, 'profile_schema_version', 3)
$p$;

/** Genau p_n Codepunkte aus ae (2 Byte), Euro (3 Byte) und Bauarbeiter (4 Byte) im Wechsel. */
create function pg_temp.text_n(p_n integer) returns text language sql immutable as $p$
  select coalesce(string_agg(case i % 3 when 0 then chr(228) when 1 then chr(8364) else chr(128119) end, '' order by i), '')
  from generate_series(0, p_n - 1) as i
$p$;

/** Erwartet eine Abweisung mit diesem Text und, falls angegeben, diesem SQLSTATE; der Stand bleibt. */
create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text, p_code text)
returns void language plpgsql as $p$
declare
  v_vorher jsonb := pg_temp.profil();
  v_version_vorher bigint := pg_temp.version();
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
    if pg_temp.profil() is distinct from v_vorher or pg_temp.version() is distinct from v_version_vorher then
      raise exception '% -- abgewiesen, aber der Stand hat sich veraendert', p_label;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.sende_sql(p_user uuid, p_payload jsonb, p_version text default null) returns text language sql as $p$
  select format('select pg_temp.sende(%L::uuid, %L::jsonb, %s)', p_user, p_payload, coalesce(p_version, 'pg_temp.version()'));
$p$;

-- Ausgangsstand: vollstaendiges Profil mit allen Feldern (wie ein Schema-3-Client es fuehrt).
insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
values (pg_temp.ws(), pg_temp.vollprofil(), 1, pg_temp.inhaber());

/* ------------------------------------------------------------------ */
/* S-09 Rechte und Katalog                                             */
/* ------------------------------------------------------------------ */

do $$
begin
  if not has_function_privilege('authenticated', 'public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint)', 'execute') then
    raise exception 'S-09 authenticated muss upsert_workspace_sync_entity ausfuehren duerfen';
  end if;
  if has_function_privilege('anon', 'public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint)', 'execute')
     or has_function_privilege('service_role', 'public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint)', 'execute') then
    raise exception 'S-09 anon/service_role duerfen upsert_workspace_sync_entity nicht ausfuehren (Rechte unveraendert)';
  end if;
  if has_function_privilege('authenticated', 'public.apply_workspace_company_profile_patch(jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.apply_workspace_company_profile_patch(jsonb, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.apply_workspace_company_profile_patch(jsonb, jsonb)', 'execute') then
    raise exception 'S-09 der Patch-Helfer darf fuer keine Client-Rolle ausfuehrbar sein';
  end if;
  raise notice 'OK  S-09 Rechte: Sync-RPC unveraendert, Patch-Helfer ohne Client-Rechte';
end $$;

do $$
declare
  v_src text;
  v_katalog text[];
  v_erwartet text[] := array[
    'defaultTaxStatus:2', 'currency:2', 'replyToEmail:2', 'senderDisplayName:2',
    'accountHolder:3', 'countryCode:3', 'defaultIntroText:3', 'defaultClosingText:3',
    'defaultInvoiceEmailSubject:3', 'defaultInvoiceEmailBody:3', 'defaultOfferEmailSubject:3',
    'defaultOfferEmailBody:3', 'defaultLetterEmailSubject:3', 'defaultLetterEmailBody:3',
    'emailSignature:3', 'registrationAuthority:3', 'registrationNumber:3',
    -- EINRICHTUNG-01 (AP6; 1.21, E-05) — Vorlagenfelder und Kommunikationssprache, ebenfalls Schema 3 (V-03.2).
    'offerValidityDays:3', 'offerIntroText:3', 'offerClosingText:3', 'orderIntroText:3', 'orderClosingText:3',
    'letterSalutation:3', 'letterClosing:3', 'communicationLanguage:3'];
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'upsert_workspace_sync_entity';
  -- Der Katalog des Aktualisierungswegs: vom ersten Eintrag bis zum Ende der Werteliste.
  select array_agg(m[1] || ':' || m[2] order by ord)
  into v_katalog
  from regexp_matches(
         substring(v_src
           from position('(''defaultTaxStatus'', 2)' in v_src)
           for position(') as catalog(key, introduced_in)' in v_src) - position('(''defaultTaxStatus'', 2)' in v_src)),
         '\(''([A-Za-z]+)'', ([0-9]+)\)', 'g') with ordinality as t(m, ord);
  if v_katalog is distinct from v_erwartet then
    raise exception 'S-09.2 Server-Katalog weicht ab: %', v_katalog;
  end if;
  raise notice 'OK  S-09.2 Server-Katalog: 4 Felder mit Version 2, 21 mit Version 3 (davon 8 aus AP6)';
end $$;

/* ------------------------------------------------------------------ */
/* S-06 Schema 2 bewahrt                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher bigint := pg_temp.version();
begin
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.fixture(), v_vorher);
  if pg_temp.version() <> v_vorher + 1 then raise exception 'S-06.1 Version nicht erhoeht'; end if;
  if pg_temp.profil() is distinct from pg_temp.vollprofil() then
    raise exception 'S-06.1 Profil veraendert: %', pg_temp.profil();
  end if;
  raise notice 'OK  S-06.1 echter Schema-2-Payload: alle 13 Felder mit introduced_in = 3 bleiben, sonst keine Aenderung';
end $$;

select pg_temp.erwarte_abweisung('S-06.2 alter row_version',
  pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.fixture(), '1'), 'Versionskonflikt company_profile', 'P0001');
do $$ begin raise notice 'OK  S-06.2 Wiederholung mit altem row_version: Konflikt, keine Aenderung'; end $$;

do $$
begin
  -- Ein Schema-3-Client aendert die Signatur; ein Schema-2-Client schreibt danach seinen Stand zurueck.
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('emailSignature', 'Neu gesetzt')), pg_temp.version());
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.fixture(), pg_temp.version());
  if pg_temp.profil()->>'emailSignature' is distinct from 'Neu gesetzt' then
    raise exception 'S-06.3 Schema 2 hat die Signatur geloescht: %', pg_temp.profil()->'emailSignature';
  end if;
  -- Zurueckschreiben mit allen gezogenen Feldern: ebenfalls unveraendert.
  perform pg_temp.sende(pg_temp.inhaber(),
    jsonb_build_object('payload', pg_temp.profil(), 'profile_schema_version', 2), pg_temp.version());
  if pg_temp.profil()->>'emailSignature' is distinct from 'Neu gesetzt'
     or pg_temp.profil() - 'emailSignature' is distinct from pg_temp.vollprofil() - 'emailSignature' then
    raise exception 'S-06.3 Zurueckschreiben veraendert das Profil';
  end if;
  -- zurueck auf den Ausgangsstand
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(pg_temp.neuere_felder()), pg_temp.version());
  if pg_temp.profil() is distinct from pg_temp.vollprofil() then raise exception 'S-06.3 Ausgangsstand nicht wiederhergestellt'; end if;
  raise notice 'OK  S-06.3 Schema-2-Client nach Schema-3-Stand: Felder bleiben beim Zurueckschreiben';
end $$;

/* ------------------------------------------------------------------ */
/* S-07 Schema 3 ist ein Patch                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher jsonb := pg_temp.profil();
begin
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('phone', '+49 521 111111')), pg_temp.version());
  if pg_temp.profil() is distinct from jsonb_set(v_vorher, '{phone}', '"+49 521 111111"') then
    raise exception 'S-07.1 Patch hat mehr als das genannte Feld veraendert';
  end if;
  raise notice 'OK  S-07.1 fehlende Felder bleiben unveraendert';
end $$;

do $$
declare
  v_vorher jsonb := pg_temp.profil();
begin
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('emailSignature', null)), pg_temp.version());
  if pg_temp.profil() ? 'emailSignature' then raise exception 'S-07.2 Signatur nicht geloescht'; end if;
  if pg_temp.profil() is distinct from v_vorher - 'emailSignature' then raise exception 'S-07.2 weitere Aenderung'; end if;
  raise notice 'OK  S-07.2 null loescht die Signatur, sonst keine Aenderung';
end $$;

do $$
declare
  v_feld text;
  v_buchstabe text;
  v_wert jsonb;
  v_i integer := 0;
begin
  foreach v_feld in array array['companyName', 'contactPerson', 'street', 'zip', 'city', 'email', 'iban'] loop
    v_buchstabe := chr(ascii('a') + v_i);
    v_i := v_i + 1;
    foreach v_wert in array array['null'::jsonb, '""'::jsonb, '"   "'::jsonb] loop
      perform pg_temp.erwarte_abweisung(format('S-07.3%s %s = %s', v_buchstabe, v_feld, v_wert),
        pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object(v_feld, v_wert))),
        'Firmenprofil ungueltig: ' || v_feld, 'P0001');
    end loop;
  end loop;
  raise notice 'OK  S-07.3a-g Pflichtfelder: null, leer und nur Leerzeichen abgelehnt, Profil unveraendert';
end $$;

do $$
begin
  if coalesce(pg_temp.profil()->>'taxNumber', '') = '' or coalesce(pg_temp.profil()->>'vatId', 'x') <> '' then
    raise exception 'S-07.4 Ausgang falsch: Steuernummer gesetzt, USt-IdNr. leer erwartet';
  end if;
  perform pg_temp.erwarte_abweisung('S-07.4 Steuernummer null',
    pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('taxNumber', null))), 'Firmenprofil ungueltig: taxNumber', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.4 Steuernummer leer',
    pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('taxNumber', ''))), 'Firmenprofil ungueltig: taxNumber', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.4 beide leer',
    pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('taxNumber', '', 'vatId', ''))), 'Firmenprofil ungueltig: taxNumber', 'P0001');
  -- Gegenprobe: Wechsel auf die USt-IdNr. ist erlaubt.
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('taxNumber', null, 'vatId', 'DE123456789')), pg_temp.version());
  if pg_temp.profil() ? 'taxNumber' or pg_temp.profil()->>'vatId' <> 'DE123456789' then
    raise exception 'S-07.4 Wechsel auf die USt-IdNr. nicht uebernommen';
  end if;
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('taxNumber', '305/123/45678', 'vatId', '')), pg_temp.version());
  raise notice 'OK  S-07.4 Steuernummer und USt-IdNr. werden nicht beide leer; Wechsel bleibt moeglich';
end $$;

do $$
begin
  perform pg_temp.erwarte_abweisung('S-07.5a Payload Text',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('payload', 'kein Objekt', 'profile_schema_version', 3)), 'Firmenprofil ungueltig: payload', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5a Payload Liste',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('payload', jsonb_build_array(1, 2), 'profile_schema_version', 3)), 'Firmenprofil ungueltig: payload', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5a Payload null',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('payload', null, 'profile_schema_version', 3)), 'Firmenprofil ungueltig: payload', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5a Payload fehlt',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('profile_schema_version', 3)), 'Firmenprofil ungueltig: payload', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5a Schema 2 mit Text-Payload',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('payload', 'kein Objekt', 'profile_schema_version', 2)), 'Firmenprofil ungueltig: payload', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5b Version 4',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('payload', jsonb_build_object('phone', '1'), 'profile_schema_version', 4)), 'Firmenprofil ungueltig: profile_schema_version', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5b Version -1',
    pg_temp.sende_sql(pg_temp.inhaber(), jsonb_build_object('payload', jsonb_build_object('phone', '1'), 'profile_schema_version', -1)), 'Firmenprofil ungueltig: profile_schema_version', 'P0001');
  perform pg_temp.erwarte_abweisung('S-07.5c abgeschnittenes JSON',
    format('select pg_temp.sende(%L::uuid, %L::jsonb, pg_temp.version())', pg_temp.inhaber(), '{"payload": {"companyName": "X"'),
    'invalid input syntax for type json', '22P02');
  raise notice 'OK  S-07.5a-c ungueltige Payloads abgelehnt, nie als Loeschen gewertet';
end $$;

do $$
declare
  -- Ein Altclient (vor 01B, ohne Versionsangabe) kennt keines der Katalogfelder.
  v_ohne jsonb := pg_temp.profil() - array['defaultTaxStatus', 'currency', 'replyToEmail', 'senderDisplayName',
    'accountHolder', 'countryCode', 'defaultIntroText', 'defaultClosingText', 'defaultInvoiceEmailSubject',
    'defaultInvoiceEmailBody', 'defaultOfferEmailSubject', 'defaultOfferEmailBody', 'defaultLetterEmailSubject',
    'defaultLetterEmailBody', 'emailSignature', 'registrationAuthority', 'registrationNumber'];
  v_vorher jsonb := pg_temp.profil();
begin
  if v_ohne ? 'currency' or not (v_vorher ? 'currency') then raise exception 'S-07.6 Ausgang falsch'; end if;
  perform pg_temp.sende(pg_temp.inhaber(), jsonb_build_object('payload', v_ohne), pg_temp.version());
  if pg_temp.profil() is distinct from v_vorher then
    raise exception 'S-07.6 ohne Versionsangabe wurde geloescht: %', pg_temp.profil();
  end if;
  raise notice 'OK  S-07.6 ohne Versionsangabe: Bewahrung wie Schema 1, nichts geloescht';
end $$;

/* ------------------------------------------------------------------ */
/* S-08 Textgrenzen in Codepunkten                                     */
/* ------------------------------------------------------------------ */

do $$
declare
  v_grenze record;
  v_n integer;
  v_wert text;
begin
  if length(pg_temp.text_n(3)) <> 3 or octet_length(pg_temp.text_n(3)) <> 9 then
    raise exception 'S-08 Testtext falsch aufgebaut';
  end if;
  for v_grenze in
    select * from (values
      ('S-08.1', 'accountHolder', 120),
      ('S-08.2', 'senderDisplayName', 120),
      ('S-08.3', 'defaultIntroText', 2000),
      ('S-08.3', 'defaultClosingText', 2000),
      ('S-08.4', 'emailSignature', 2000),
      ('S-08.5', 'defaultInvoiceEmailSubject', 255),
      ('S-08.5', 'defaultOfferEmailSubject', 255),
      ('S-08.5', 'defaultLetterEmailSubject', 255),
      ('S-08.6', 'defaultInvoiceEmailBody', 20000),
      ('S-08.6', 'defaultOfferEmailBody', 20000),
      ('S-08.6', 'defaultLetterEmailBody', 20000)
    ) as g(id, feld, grenze)
  loop
    foreach v_n in array array[v_grenze.grenze - 1, v_grenze.grenze] loop
      v_wert := pg_temp.text_n(v_n);
      perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object(v_grenze.feld, v_wert)), pg_temp.version());
      if pg_temp.profil()->>v_grenze.feld is distinct from v_wert then
        raise exception '% % mit % Codepunkten nicht gespeichert', v_grenze.id, v_grenze.feld, v_n;
      end if;
    end loop;
    perform pg_temp.erwarte_abweisung(format('%sc %s mit %s Codepunkten', v_grenze.id, v_grenze.feld, v_grenze.grenze + 1),
      pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object(v_grenze.feld, pg_temp.text_n(v_grenze.grenze + 1)))),
      'Firmenprofil ungueltig: ' || v_grenze.feld, 'P0001');
  end loop;
  raise notice 'OK  S-08.1a-c bis S-08.6a-c Grenze-1 und Grenze gespeichert, Grenze+1 abgelehnt (gezaehlt in Codepunkten)';
end $$;

do $$
declare
  v_feld text;
  v_umbruch text;
begin
  foreach v_feld in array array['defaultInvoiceEmailSubject', 'defaultOfferEmailSubject', 'defaultLetterEmailSubject'] loop
    foreach v_umbruch in array array[chr(10), chr(13), chr(8232), chr(9)] loop
      perform pg_temp.erwarte_abweisung(format('S-08.7 %s mit Steuerzeichen %s', v_feld, ascii(v_umbruch)),
        pg_temp.sende_sql(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object(v_feld, 'Rechnung' || v_umbruch || 'Zeile 2'))),
        'Firmenprofil ungueltig: ' || v_feld, 'P0001');
    end loop;
  end loop;
  -- Mailtexte duerfen mehrzeilig sein.
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('defaultInvoiceEmailBody', 'Zeile 1' || chr(10) || 'Zeile 2')), pg_temp.version());
  raise notice 'OK  S-08.7 Betreff mit Zeilenumbruch abgelehnt; Mailtexte bleiben mehrzeilig';
end $$;

/* ------------------------------------------------------------------ */
/* Rollen, Neuanlage, Branding                                         */
/* ------------------------------------------------------------------ */

select pg_temp.erwarte_abweisung('Mitglied schreibt das Profil',
  pg_temp.sende_sql(pg_temp.mitglied(), pg_temp.patch(jsonb_build_object('phone', '0'))), 'Keine Schreibberechtigung', null);
do $$ begin raise notice 'OK  Mitglied: Schema-3-Patch abgewiesen, Profil unveraendert'; end $$;

do $$
declare
  v_branding jsonb;
begin
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('branding', jsonb_build_object('documentTemplate', 'modern'))), pg_temp.version());
  v_branding := pg_temp.profil()->'branding';
  if v_branding is distinct from '{"documentTemplate": "modern"}'::jsonb then raise exception 'Branding-Objekt nicht uebernommen'; end if;
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('branding', null)), pg_temp.version());
  if pg_temp.profil()->'branding' is distinct from v_branding then raise exception 'Branding null hat geloescht'; end if;
  perform pg_temp.sende(pg_temp.inhaber(), pg_temp.patch(jsonb_build_object('branding', '{}'::jsonb)), pg_temp.version());
  if pg_temp.profil()->'branding' is distinct from '{}'::jsonb then raise exception 'Branding {} nicht uebernommen'; end if;
  raise notice 'OK  Branding im Patch: Objekt ersetzt, null bewahrt, {} entfernt das Logo';
end $$;

do $$
begin
  perform pg_temp.erwarte_abweisung('Neuanlage mit null-Pflichtfeld',
    format('select pg_temp.sende(%L::uuid, %L::jsonb, 0, %L::uuid)', pg_temp.inhaber_neu(),
      pg_temp.patch(jsonb_build_object('companyName', null)), pg_temp.ws_neu()),
    'Firmenprofil ungueltig: companyName', 'P0001');
  if pg_temp.profil(pg_temp.ws_neu()) is not null then raise exception 'Neuanlage trotz Abweisung'; end if;
  perform pg_temp.sende(pg_temp.inhaber_neu(),
    pg_temp.patch(jsonb_build_object('companyName', 'Neu GmbH', 'iban', '', 'emailSignature', null, 'phone', '1')), 0, pg_temp.ws_neu());
  if pg_temp.profil(pg_temp.ws_neu()) is distinct from '{"companyName": "Neu GmbH", "iban": "", "phone": "1"}'::jsonb
     or pg_temp.version(pg_temp.ws_neu()) <> 1 then
    raise exception 'Neuanlage per Schema 3 falsch: %', pg_temp.profil(pg_temp.ws_neu());
  end if;
  raise notice 'OK  Neuanlage per Schema 3: null entfaellt, leeres Pflichtfeld ohne Vorwert erlaubt';
end $$;

rollback;
