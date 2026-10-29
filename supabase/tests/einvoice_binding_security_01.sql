-- GO-LIVE-SECURITY-01 / SERVER-SICHERHEIT E-RECHNUNGEN -- Vertragstest für
-- 20261106120000_einvoice_binding_security_01.sql.
--
--   M  Mitglied: legt keine E-Rechnungsbindung an (XRechnung, ZUGFeRD,
--      Altbindung ohne Unterrolle), auch nicht über verfälschte Rolle oder
--      Unterrolle oder einen Beleg, der sich als Rechnungsbeleg ausgibt; hängt
--      nichts an Rechnungs- und Korrekturbelege; ersetzt, ändert, löscht und
--      belebt auch eigene Altbindungen nicht; Dateien hinter solchen Bindungen
--      bleiben unberührt -- über den Eingangsweg, im Namen einer
--      Security-Definer-Funktion und direkt an der Tabelle. Der normale
--      Eingangsweg des Mitglieds bleibt unverändert.
--   I  Inhaber/Admin: anlegen, wiederholen, ersetzen bei bestätigtem
--      Leistungszeitraum; abgewiesen bei offenem Leistungszeitraum, Entwurf und
--      abgelaufener Lizenz; Grabstein ohne Bedingung, Wiederbeleben nicht ohne
--      Bestätigung; Archiv-PDF am Rechnungsbeleg wie bisher; Betriebe getrennt.
--   O  Offline-Reihenfolge: Bestätigung, Datei oder Beleg kommen später --
--      wiederholbare Abweisung, danach gelingt derselbe Aufruf.
--   T  Typangaben: Unterrolle nur genau und nur an structured, Beleg nur der
--      lebende Beleg einer Rechnung, Datei lebend, im Betrieb und vom
--      passenden Typ; Schlüssel unveränderlich.
--   W  Wartung ohne Nutzer frei; Fremdschlüsselpflege (SET NULL) läuft, eine
--      umgeschriebene Urheberschaft nicht.
--   D  Altbestand: Einstufung vorhandener Bindungen (Abfrage für Bestandsdaten).
--   G  Rechte und Trigger.
--
-- Jede Prüfung läuft als Rolle authenticated mit den Claims des Nutzers --
-- RLS und Funktionsrechte greifen wie bei einem echten Client. "Im Namen"
-- heißt: als postgres mit den Claims des Nutzers, so wie eine
-- Security-Definer-Funktion schreibt -- dann schützt allein der Trigger.
--
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/einvoice_binding_security_01.sql
--
-- Exit-Code 0 = alle Zusicherungen erfüllt. Alles wird zurückgerollt.
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
  ('00000000-0000-0000-0000-000000e1b001'::uuid, 'inhaber-erechnung@example.invalid'),
  ('00000000-0000-0000-0000-000000e1b002'::uuid, 'admin-erechnung@example.invalid'),
  ('00000000-0000-0000-0000-000000e1b003'::uuid, 'mitglied-erechnung@example.invalid'),
  ('00000000-0000-0000-0000-000000e1b004'::uuid, 'fremd-erechnung@example.invalid'),
  ('00000000-0000-0000-0000-000000e1b005'::uuid, 'admin-abgelaufen-erechnung@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-000000e1b001'::uuid, '00000000-0000-0000-0000-000000e1b002'::uuid,
             '00000000-0000-0000-0000-000000e1b003'::uuid, '00000000-0000-0000-0000-000000e1b004'::uuid);
update public.profiles set status = 'approved', license_status = 'expired', license_expires_at = null
where id = '00000000-0000-0000-0000-000000e1b005'::uuid;

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000e1ba01'::uuid, 'E-Rechnung A', '00000000-0000-0000-0000-000000e1b001'::uuid),
       ('00000000-0000-0000-0000-000000e1bb01'::uuid, 'E-Rechnung B', '00000000-0000-0000-0000-000000e1b004'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000e1ba01'::uuid, '00000000-0000-0000-0000-000000e1b001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-000000e1ba01'::uuid, '00000000-0000-0000-0000-000000e1b002'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000e1ba01'::uuid, '00000000-0000-0000-0000-000000e1b003'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-000000e1ba01'::uuid, '00000000-0000-0000-0000-000000e1b005'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000e1bb01'::uuid, '00000000-0000-0000-0000-000000e1b004'::uuid, 'owner',  'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1ba01'::uuid $p$;
create function pg_temp.ws_b() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1bb01'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1b001'::uuid $p$;
create function pg_temp.admin() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1b002'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1b003'::uuid $p$;
create function pg_temp.fremd() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1b004'::uuid $p$;
create function pg_temp.abgelaufen() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000e1b005'::uuid $p$;

do $$
begin
  if (select count(*) from public.profiles
      where id in (pg_temp.inhaber(), pg_temp.admin(), pg_temp.mitglied(), pg_temp.fremd(), pg_temp.abgelaufen())) <> 5 then
    raise exception 'Aufbau -- Profile fehlen';
  end if;
end $$;

-- Rechnungen: bestätigt, offen (Altbeleg), ausdrücklich unbestätigt, später
-- bestätigt, Entwurf, Beleg kommt später, Beleg gelöscht.
insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values (pg_temp.ws(), null, 'inv-e-ok',      '2026-9301', 2026, 9301, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-typ',     '2026-9302', 2026, 9302, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-alt',     '2026-9303', 2026, 9303, 'rechnung', 'versendet',   '{"status":"versendet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-alt2',    '2026-9304', 2026, 9304, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-offen',   '2026-9305', 2026, 9305, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-nein',    '2026-9306', 2026, 9306, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":false}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-spaet',   '2026-9307', 2026, 9307, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-entwurf', '2026-9308', 2026, 9308, 'rechnung', 'entwurf',     '{}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-beleg',   '2026-9309', 2026, 9309, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-e-weg',     '2026-9310', 2026, 9310, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws_b(), null, 'inv-e-b',     '2026-9391', 2026, 9391, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb);

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by, deleted, deleted_at)
values (pg_temp.ws(), 'doc-e-ok',      'generated_invoice', 'inv-e-ok',      '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-typ',     'generated_invoice', 'inv-e-typ',     '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-alt',     'generated_invoice', 'inv-e-alt',     '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-alt2',    'generated_invoice', 'inv-e-alt2',    '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-offen',   'generated_invoice', 'inv-e-offen',   '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-nein',    'generated_invoice', 'inv-e-nein',    '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-spaet',   'generated_invoice', 'inv-e-spaet',   '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-entwurf', 'generated_invoice', 'inv-e-entwurf', '{}'::jsonb, pg_temp.inhaber(), false, null),
       -- Wie tombstone_workspace_document bei Rechnungsbelegen: nur deleted_at.
       (pg_temp.ws(), 'doc-e-weg',     'generated_invoice', 'inv-e-weg',     '{}'::jsonb, pg_temp.inhaber(), false, now()),
       (pg_temp.ws(), 'doc-e-korr',    'generated_invoice_correction', 'inv-e-ok', '{}'::jsonb, pg_temp.inhaber(), false, null),
       (pg_temp.ws(), 'doc-e-scan',    'archived_document', null, '{"id":"doc-e-scan","title":"Scan"}'::jsonb, pg_temp.mitglied(), false, null),
       (pg_temp.ws_b(), 'doc-e-b',     'generated_invoice', 'inv-e-b',       '{}'::jsonb, pg_temp.fremd(), false, null);

insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by, deleted, deleted_at)
select pg_temp.ws(), v.id, repeat(v.h, 64), 10, v.typ, pg_temp.ws()::text || '/' || repeat(v.h, 64), v.von, v.von, v.weg,
       case when v.weg then now() end
from (values
  ('file-x-inhaber',  '1', 'application/xml',         pg_temp.inhaber(),  false),
  ('file-x-inhaber2', '2', 'application/xml',         pg_temp.inhaber(),  false),
  ('file-z-inhaber',  '3', 'application/pdf',         pg_temp.inhaber(),  false),
  ('file-x-admin',    '4', 'application/xml',         pg_temp.admin(),    false),
  ('file-x-mitglied', '5', 'application/xml',         pg_temp.mitglied(), false),
  ('file-z-mitglied', '6', 'application/pdf',         pg_temp.mitglied(), false),
  ('file-scan',       '7', 'application/pdf',         pg_temp.mitglied(), false),
  ('file-scan2',      '8', 'application/pdf',         pg_temp.mitglied(), false),
  ('file-x-weg',      '9', 'application/xml',         pg_temp.inhaber(),  true),
  ('file-x-alt',      'a', 'application/xml',         pg_temp.mitglied(), false),
  ('file-x-text',     'c', 'text/xml; charset=utf-8', pg_temp.inhaber(),  false)
) as v(id, h, typ, von, weg);
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by)
values (pg_temp.ws_b(), 'file-x-b', repeat('d', 64), 10, 'application/xml', pg_temp.ws_b()::text || '/' || repeat('d', 64), pg_temp.fremd(), pg_temp.fremd());

-- Altbestand aus der Zeit vor der Migration (als Wartung ohne Nutzer angelegt):
--   L1 Mitglied hat die XRechnung einer bestätigten Rechnung angelegt (wie 2026-0005 lokal),
--   L2 Inhaber-XRechnung an einer Rechnung mit offenem Leistungszeitraum (04D3-Zeit),
--   L3 Inhaber-ZUGFeRD, deren Datei nie in der Cloud ankam,
--   L4 gelöschte XRechnung des Mitglieds.
insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, provenance, created_by, updated_by, deleted, deleted_at)
values (pg_temp.ws(), 'doc-e-alt',   'file-x-alt',      'structured', 'xrechnung-cii',   'derived', pg_temp.mitglied(), pg_temp.mitglied(), false, null),
       (pg_temp.ws(), 'doc-e-offen', 'file-x-inhaber2', 'structured', 'xrechnung-cii',   'derived', pg_temp.inhaber(),  pg_temp.inhaber(),  false, null),
       (pg_temp.ws(), 'doc-e-alt',   'file-z-fehlt',    'structured', 'zugferd-en16931', 'derived', pg_temp.inhaber(),  pg_temp.inhaber(),  false, null),
       (pg_temp.ws(), 'doc-e-alt2',  'file-x-mitglied', 'structured', 'xrechnung-cii',   'derived', pg_temp.mitglied(), pg_temp.mitglied(), true,  now());

/** Als dieser Nutzer -- Rolle authenticated, damit RLS und Funktionsrechte greifen. */
create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

/** Im Namen dieses Nutzers, aber als postgres -- wie eine Security-Definer-Funktion: Nur der Trigger schützt. */
create function pg_temp.im_namen(p_user uuid) returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
end;
$p$;

/** Zurück zu postgres -- Nachlesen ohne RLS. */
create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

/** Erwartet eine Abweisung mit diesem Text und, falls angegeben, diesem SQLSTATE. */
create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text, p_code text)
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

/** Führt aus und meldet den SQLSTATE statt abzubrechen ('ausgefuehrt' ohne Fehler). */
create function pg_temp.versuche(p_sql text) returns text language plpgsql as $p$
begin
  execute p_sql;
  return 'ausgefuehrt';
exception when others then
  return sqlstate;
end;
$p$;

create function pg_temp.bindung_nutzlast(p_doc text, p_datei text, p_art text, p_teil text, p_geloescht boolean, p_herkunft text)
returns jsonb language sql immutable as $p$
  select jsonb_strip_nulls(jsonb_build_object(
    'binding_id', p_doc || '|' || coalesce(p_art, '') || '|' || coalesce(p_teil, ''),
    'client_document_id', p_doc, 'client_file_ref_id', p_datei,
    'binding_kind', p_art, 'part', p_teil, 'provenance', p_herkunft, 'deleted', p_geloescht));
$p$;

/** Der Eingangsweg des Clients für eine Dateibindung. */
create function pg_temp.bindung(p_ws uuid, p_doc text, p_datei text, p_art text, p_teil text,
  p_version bigint default 0, p_geloescht boolean default false, p_herkunft text default 'derived')
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(p_ws, 'document_file_binding',
    pg_temp.bindung_nutzlast(p_doc, p_datei, p_art, p_teil, p_geloescht, p_herkunft), p_version);
$p$;

create function pg_temp.bindung_sql(p_ws uuid, p_doc text, p_datei text, p_art text, p_teil text,
  p_version bigint default 0, p_geloescht boolean default false, p_herkunft text default 'derived')
returns text language sql immutable as $p$
  select format('select pg_temp.bindung(%L::uuid, %L, %L, %L, %L, %s, %L::boolean, %L)',
    p_ws, p_doc, p_datei, p_art, p_teil, p_version, p_geloescht, p_herkunft);
$p$;

/** Der Eingangsweg des Clients für eine Datei. */
create function pg_temp.datei(p_ws uuid, p_id text, p_hash text, p_typ text, p_name text, p_version bigint default 0)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(p_ws, 'document_file',
    jsonb_build_object('client_file_ref_id', p_id, 'content_sha256', p_hash, 'size_bytes', 10,
      'mime_type', p_typ, 'original_file_name', p_name), p_version);
$p$;

create function pg_temp.datei_sql(p_ws uuid, p_id text, p_hash text, p_typ text, p_name text, p_version bigint default 0)
returns text language sql immutable as $p$
  select format('select pg_temp.datei(%L::uuid, %L, %L, %L, %L, %s)', p_ws, p_id, p_hash, p_typ, p_name, p_version);
$p$;

create function pg_temp.b(p_ws uuid, p_doc text, p_art text, p_teil text)
returns public.workspace_document_file_bindings language sql as $p$
  select * from public.workspace_document_file_bindings
  where workspace_id = p_ws and client_document_id = p_doc and binding_kind = p_art
    and coalesce(part, '') = coalesce(p_teil, '');
$p$;

create function pg_temp.f(p_ws uuid, p_id text) returns public.workspace_files language sql as $p$
  select * from public.workspace_files where workspace_id = p_ws and client_file_ref_id = p_id;
$p$;

create function pg_temp.bindungen() returns jsonb language sql as $p$
  select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]'::jsonb)
  from public.workspace_document_file_bindings b where b.workspace_id in (pg_temp.ws(), pg_temp.ws_b());
$p$;

create function pg_temp.dateien() returns jsonb language sql as $p$
  select coalesce(jsonb_agg(to_jsonb(f) order by f.id), '[]'::jsonb)
  from public.workspace_files f where f.workspace_id in (pg_temp.ws(), pg_temp.ws_b());
$p$;

-- Altbestand aus der Zeit vor 20261107120000: ein Archivdokument eines
-- Mitglieds, das sich mit linked_invoice_id und Nutzlast als Beleg einer
-- Rechnung ausgibt. Neu anlegen kann ein Mitglied es seitdem nicht mehr
-- (go_live_security_01_finalization.sql, D1/D2); als Bestand zählt es unten
-- trotzdem nicht als Rechnungsbeleg.
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by, updated_by)
values (pg_temp.ws(), 'doc-e-falsch', 'archived_document', 'inv-e-ok',
        jsonb_build_object('id', 'doc-e-falsch', 'title', 'Rechnung 2026-9301',
          'linkedInvoiceId', 'inv-e-ok', 'category', 'ausgangsrechnung'),
        pg_temp.mitglied(), pg_temp.mitglied());

/* ------------------------------------------------------------------ */
/* M -- Mitglied: keine E-Rechnungsdatei, auf keinem Weg               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher jsonb := pg_temp.bindungen();
begin
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('M1 XRechnung an bestätigter Rechnung, eigene XML-Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'structured', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M2 ZUGFeRD an bestätigter Rechnung, eigene PDF-Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-z-mitglied', 'structured', 'zugferd-en16931'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M3 Altbindung ohne Unterrolle (XML gilt im Client als XRechnung)',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'structured', null), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M4a Unterrolle in anderer Schreibweise',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'structured', 'XRechnung-CII'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M4b erfundene Unterrolle',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'structured', 'xrechnung-cii-v2'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M4c Unterrolle mit Leerzeichen',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'structured', ' xrechnung-cii '), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M5a Rolle Structured',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'Structured', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M5b Rolle mit Leerzeichen, ohne Unterrolle',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', ' structured', null), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M5c Rolle STRUCTURED',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-z-mitglied', 'STRUCTURED', 'zugferd-en16931'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M6a archive mit Unterrolle xrechnung-cii am eigenen Scan',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-scan', 'file-x-mitglied', 'archive', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M6b original mit Unterrolle ZUGFeRD-EN16931 am eigenen Scan',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-scan', 'file-z-mitglied', 'original', 'ZUGFeRD-EN16931', 0, false, 'received'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M7a ZUGFeRD-PDF als Archivfassung der Rechnung',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-z-mitglied', 'archive', null), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M7b Original am Korrekturbeleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-korr', 'file-z-mitglied', 'original', null, 0, false, 'received'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M8 XRechnung am eigenen Archivdokument, das sich als Rechnungsbeleg ausgibt',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-falsch', 'file-x-mitglied', 'structured', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  if pg_temp.bindungen() is distinct from v_vorher then
    raise exception 'M1-M8 -- Bindungen verändert';
  end if;
  raise notice 'OK  M1-M8 Mitglied legt keine E-Rechnungsbindung an; keine Rolle, Unterrolle, Schreibweise und kein vorgeblicher Rechnungsbeleg hilft';
end $$;

do $$
declare
  v_bindungen jsonb := pg_temp.bindungen();
  v_dateien jsonb := pg_temp.dateien();
begin
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('M9a eigene Altbindung: Datei ersetzen',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-alt', 'file-x-mitglied', 'structured', 'xrechnung-cii', 1), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M9b eigene Altbindung: unveränderte Wiederholung',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-alt', 'file-x-alt', 'structured', 'xrechnung-cii', 1), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M9c eigene Altbindung: Herkunft ändern',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-alt', 'file-x-alt', 'structured', 'xrechnung-cii', 1, false, 'extracted'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M9d eigene Altbindung: löschen',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-alt', 'file-x-alt', 'structured', 'xrechnung-cii', 1, true), 'Keine Schreibberechtigung', null);
  perform pg_temp.erwarte_abweisung('M9e eigene gelöschte Altbindung wiederbeleben',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-alt2', 'file-x-mitglied', 'structured', 'xrechnung-cii', 1), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M9f Inhaber-Altbindung ersetzen',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-offen', 'file-x-mitglied', 'structured', 'xrechnung-cii', 1), 'Keine Schreibberechtigung', null);
  perform pg_temp.erwarte_abweisung('M10a eigene Datei hinter der Altbindung umbenennen und umtypisieren',
    pg_temp.datei_sql(pg_temp.ws(), 'file-x-alt', repeat('a', 64), 'application/pdf', 'umbenannt.pdf', 1), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M10b eigene Datei hinter einer gelöschten Altbindung ändern',
    pg_temp.datei_sql(pg_temp.ws(), 'file-x-mitglied', repeat('5', 64), 'application/xml', 'neu.xml', 1), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M10c fehlende Datei einer Inhaber-Bindung selbst stellen',
    pg_temp.datei_sql(pg_temp.ws(), 'file-z-fehlt', repeat('e', 64), 'application/pdf', 'zugferd.pdf', 0), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  if pg_temp.bindungen() is distinct from v_bindungen then
    raise exception 'M9 -- Altbindungen verändert';
  end if;
  if pg_temp.dateien() is distinct from v_dateien then
    raise exception 'M10 -- Dateien verändert oder angelegt';
  end if;
  raise notice 'OK  M9-M10 Altbestand: Mitglied ersetzt, wiederholt, ändert, löscht und belebt nichts; Dateien dahinter unberührt, fehlende nicht nachgereicht';
end $$;

do $$
declare
  v_bindungen jsonb := pg_temp.bindungen();
  v_dateien jsonb := pg_temp.dateien();
  v_ergebnis text;
begin
  -- Direkt an der Tabelle, als authenticated.
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('M11a direkt einfügen',
    format('insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, created_by) values (%L, %L, %L, %L, %L, %L)',
      pg_temp.ws(), 'doc-e-typ', 'file-x-mitglied', 'structured', 'xrechnung-cii', pg_temp.mitglied()), '', '42501');
  v_ergebnis := pg_temp.versuche(format(
    'update public.workspace_document_file_bindings set client_file_ref_id = %L where workspace_id = %L and client_document_id = %L',
    'file-x-mitglied', pg_temp.ws(), 'doc-e-alt'));
  if v_ergebnis not in ('ausgefuehrt', '42501') then
    raise exception 'M11b direkt ändern -- unerwarteter Ausgang %', v_ergebnis;
  end if;
  perform pg_temp.zurueck();

  -- Im Namen des Mitglieds, wie eine Security-Definer-Funktion: Nur der Trigger steht dazwischen.
  perform pg_temp.im_namen(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('M11c im Namen einfügen',
    format('insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, created_by) values (%L, %L, %L, %L, %L, %L)',
      pg_temp.ws(), 'doc-e-typ', 'file-x-mitglied', 'structured', 'xrechnung-cii', pg_temp.mitglied()), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M11d im Namen die Datei der Altbindung ersetzen',
    format('update public.workspace_document_file_bindings set client_file_ref_id = %L, row_version = row_version + 1 where workspace_id = %L and client_document_id = %L and part = %L',
      'file-x-mitglied', pg_temp.ws(), 'doc-e-alt', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M11e im Namen eine gelöschte Altbindung wiederbeleben',
    format('update public.workspace_document_file_bindings set deleted = false, deleted_at = null where workspace_id = %L and client_document_id = %L',
      pg_temp.ws(), 'doc-e-alt2'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M11f im Namen ein Archiv-PDF an den Rechnungsbeleg hängen',
    format('insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind) values (%L, %L, %L, %L)',
      pg_temp.ws(), 'doc-e-typ', 'file-z-mitglied', 'archive'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('M11g im Namen die Datei hinter der Altbindung umtypisieren',
    format('update public.workspace_files set mime_type = %L where workspace_id = %L and client_file_ref_id = %L',
      'application/pdf', pg_temp.ws(), 'file-x-alt'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  if pg_temp.bindungen() is distinct from v_bindungen then
    raise exception 'M11 -- Bindungen verändert';
  end if;
  if pg_temp.dateien() is distinct from v_dateien then
    raise exception 'M11 -- Dateien verändert';
  end if;
  raise notice 'OK  M11 auch direkt an der Tabelle und im Namen des Mitglieds (wie jede Security-Definer-Funktion) keine Änderung';
end $$;

do $$
declare
  r public.workspace_document_file_bindings;
  v jsonb;
begin
  perform pg_temp.als(pg_temp.mitglied());
  v := pg_temp.datei(pg_temp.ws(), 'file-scan-neu', repeat('f', 64), 'application/pdf', 'scan-neu.pdf', 0);
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-scan', 'file-scan', 'original', null, 0, false, 'received');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-scan', 'file-scan2', 'archive', null, 0, false, 'derived');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-scan', 'file-scan-neu', 'archive', null, 1, false, 'derived');
  v := pg_temp.datei(pg_temp.ws(), 'file-scan', repeat('7', 64), 'application/pdf', 'scan-umbenannt.pdf', 1);
  perform pg_temp.zurueck();

  r := pg_temp.b(pg_temp.ws(), 'doc-e-scan', 'original', null);
  if r.client_file_ref_id is distinct from 'file-scan' or r.created_by is distinct from pg_temp.mitglied() then
    raise exception 'M12a Original am eigenen Scan: %', to_jsonb(r);
  end if;
  r := pg_temp.b(pg_temp.ws(), 'doc-e-scan', 'archive', null);
  if r.client_file_ref_id is distinct from 'file-scan-neu' or r.row_version is distinct from 2::bigint then
    raise exception 'M12b Archivfassung am eigenen Scan ersetzt: %', to_jsonb(r);
  end if;
  if (pg_temp.f(pg_temp.ws(), 'file-scan')).original_file_name is distinct from 'scan-umbenannt.pdf'
     or (pg_temp.f(pg_temp.ws(), 'file-scan-neu')).created_by is distinct from pg_temp.mitglied() then
    raise exception 'M12c eigene Dateien anlegen und umbenennen';
  end if;
  raise notice 'OK  M12 Eingangsweg des Mitglieds unverändert: Datei anlegen, Original und Archivfassung binden, ersetzen, umbenennen';
end $$;

/* ------------------------------------------------------------------ */
/* I -- Inhaber und Admin                                              */
/* ------------------------------------------------------------------ */

do $$
declare
  r public.workspace_document_file_bindings;
  v jsonb;
begin
  perform pg_temp.als(pg_temp.inhaber());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-ok', 'file-x-inhaber', 'structured', 'xrechnung-cii');
  perform pg_temp.zurueck();
  r := pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'structured', 'xrechnung-cii');
  if r.id is null or r.deleted or r.created_by is distinct from pg_temp.inhaber() or r.row_version is distinct from 1::bigint
     or r.client_file_ref_id is distinct from 'file-x-inhaber' then
    raise exception 'I1 Inhaber legt XRechnung an: %', to_jsonb(r);
  end if;

  perform pg_temp.als(pg_temp.inhaber());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-ok', 'file-x-inhaber', 'structured', 'xrechnung-cii', 1);
  perform pg_temp.zurueck();
  r := pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'structured', 'xrechnung-cii');
  if r.row_version is distinct from 2::bigint or r.client_file_ref_id is distinct from 'file-x-inhaber' then
    raise exception 'I2 unveränderte Wiederholung: %', to_jsonb(r);
  end if;

  perform pg_temp.als(pg_temp.admin());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-ok', 'file-x-admin', 'structured', 'xrechnung-cii', 2);
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-ok', 'file-z-inhaber', 'structured', 'zugferd-en16931');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-ok', 'file-x-text', 'structured', null);
  perform pg_temp.zurueck();
  r := pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'structured', 'xrechnung-cii');
  if r.row_version is distinct from 3::bigint or r.client_file_ref_id is distinct from 'file-x-admin' or r.updated_by is distinct from pg_temp.admin() then
    raise exception 'I3 Admin ersetzt die XRechnung: %', to_jsonb(r);
  end if;
  if (pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'structured', 'zugferd-en16931')).client_file_ref_id is distinct from 'file-z-inhaber' then
    raise exception 'I4 Admin legt ZUGFeRD an';
  end if;
  if (pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'structured', null)).client_file_ref_id is distinct from 'file-x-text' then
    raise exception 'I5 Altbindung ohne Unterrolle (text/xml mit Zeichensatz)';
  end if;

  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('I6 Mitglied ersetzt die Datei der Inhaber-XRechnung',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-ok', 'file-x-mitglied', 'structured', 'xrechnung-cii', 3), 'Keine Schreibberechtigung', null);
  perform pg_temp.zurueck();
  if (pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'structured', 'xrechnung-cii')).row_version is distinct from 3::bigint then
    raise exception 'I6 -- Inhaber-XRechnung verändert';
  end if;
  raise notice 'OK  I1-I6 Inhaber/Admin legen XRechnung, ZUGFeRD und Altbindung an, wiederholen und ersetzen; das Mitglied nicht';
end $$;

do $$
declare
  v_vorher jsonb := pg_temp.bindungen();
begin
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('I7a offener Leistungszeitraum (Altbeleg ohne Bestätigung)',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-offen', 'file-z-inhaber', 'structured', 'zugferd-en16931'), 'einvoice_binding_pending: Leistungszeitraum', 'P0001');
  perform pg_temp.erwarte_abweisung('I7b Bestätigung ausdrücklich false',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-nein', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Leistungszeitraum', 'P0001');
  perform pg_temp.erwarte_abweisung('I8 Rechnung ist ein Entwurf',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-entwurf', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Rechnung ist in der Cloud nicht festgeschrieben', 'P0001');
  perform pg_temp.zurueck();
  /*
   * EINRICHTUNG-01 (E3a, Katalog V3 N-Z2 Zeile E-Rechnungs-Bindung) -- bewusst geaenderte Erwartung: Die Lizenz
   * des Betriebs zaehlt, nicht die eigene. Der Admin mit eigener abgelaufener Lizenz besteht den Waechter (I9a);
   * abgewiesen wird bei abgelaufener Betriebslizenz, mit dem unveraenderten Code (I9).
   */
  perform pg_temp.als(pg_temp.abgelaufen());
  perform public.assert_financial_action_allowed(pg_temp.ws());
  perform pg_temp.zurueck();
  update public.profiles set license_status = 'expired' where id = pg_temp.inhaber();
  perform pg_temp.als(pg_temp.abgelaufen());
  perform pg_temp.erwarte_abweisung('I9 abgelaufene Betriebslizenz',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'finance_license_expired', 'P0001');
  perform pg_temp.zurueck();
  update public.profiles set license_status = 'active' where id = pg_temp.inhaber();
  if pg_temp.bindungen() is distinct from v_vorher then
    raise exception 'I7-I9 -- Bindung trotz Abweisung';
  end if;
  raise notice 'OK  I7-I9 kein Anlegen bei offenem oder verneintem Leistungszeitraum, an Entwürfen oder mit abgelaufener Lizenz';
end $$;

do $$
declare
  r public.workspace_document_file_bindings;
  v jsonb;
begin
  perform pg_temp.als(pg_temp.inhaber());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-offen', 'file-x-inhaber2', 'structured', 'xrechnung-cii', 1, true);
  perform pg_temp.erwarte_abweisung('I10b Wiederbeleben ohne Bestätigung',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-offen', 'file-x-inhaber2', 'structured', 'xrechnung-cii', 2), 'einvoice_binding_pending: Leistungszeitraum', 'P0001');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-ok', 'file-z-inhaber', 'archive', null);
  perform pg_temp.zurueck();
  r := pg_temp.b(pg_temp.ws(), 'doc-e-offen', 'structured', 'xrechnung-cii');
  if not r.deleted or r.deleted_at is null or r.row_version is distinct from 2::bigint then
    raise exception 'I10 Grabstein ohne Bestätigung, Wiederbeleben abgewiesen: %', to_jsonb(r);
  end if;
  if (pg_temp.b(pg_temp.ws(), 'doc-e-ok', 'archive', null)).created_by is distinct from pg_temp.inhaber() then
    raise exception 'I11 Archiv-PDF am Rechnungsbeleg durch den Inhaber';
  end if;

  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('I12a fremder Inhaber schreibt in Betrieb A',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'Kein Zugriff auf Workspace', null);
  v := pg_temp.bindung(pg_temp.ws_b(), 'doc-e-b', 'file-x-b', 'structured', 'xrechnung-cii');
  perform pg_temp.zurueck();
  if (pg_temp.b(pg_temp.ws_b(), 'doc-e-b', 'structured', 'xrechnung-cii')).created_by is distinct from pg_temp.fremd() then
    raise exception 'I12b Inhaber B im eigenen Betrieb';
  end if;
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('I12c Beleg aus Betrieb B',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-b', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Rechnungsbeleg', 'P0001');
  perform pg_temp.erwarte_abweisung('I12d Datei aus Betrieb B',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-b', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Datei', 'P0001');
  perform pg_temp.zurueck();
  raise notice 'OK  I10-I12 Grabstein ohne Bedingung, kein Wiederbeleben ohne Bestätigung, Archiv-PDF wie bisher, Betriebe getrennt';
end $$;

/* ------------------------------------------------------------------ */
/* O -- Offline-Reihenfolge                                            */
/* ------------------------------------------------------------------ */

do $$
declare
  r public.workspace_document_file_bindings;
  v jsonb;
begin
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('O1a XRechnung vor der Bestätigung',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-spaet', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Leistungszeitraum', 'P0001');
  perform public.confirm_workspace_invoice_service_period(pg_temp.ws(), 'inv-e-spaet');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-spaet', 'file-x-inhaber', 'structured', 'xrechnung-cii');

  perform pg_temp.erwarte_abweisung('O2a ZUGFeRD vor der Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-spaet', 'file-z-spaet', 'structured', 'zugferd-en16931'), 'einvoice_binding_pending: Datei', 'P0001');
  v := pg_temp.datei(pg_temp.ws(), 'file-z-spaet', repeat('b', 64), 'application/pdf', 'zugferd.pdf', 0);
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-spaet', 'file-z-spaet', 'structured', 'zugferd-en16931');

  perform pg_temp.erwarte_abweisung('O3a XRechnung vor dem Rechnungsbeleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-beleg', 'file-x-inhaber2', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Rechnungsbeleg', 'P0001');
  perform pg_temp.zurueck();
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
  values (pg_temp.ws(), 'doc-e-beleg', 'generated_invoice', 'inv-e-beleg', '{}'::jsonb, pg_temp.inhaber());
  perform pg_temp.als(pg_temp.inhaber());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-beleg', 'file-x-inhaber2', 'structured', 'xrechnung-cii');

  -- Nach der Bestätigung belebt der Inhaber seine Altbindung aus I10 wieder.
  perform public.confirm_workspace_invoice_service_period(pg_temp.ws(), 'inv-e-offen');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-e-offen', 'file-x-inhaber2', 'structured', 'xrechnung-cii', 2);
  perform pg_temp.zurueck();

  if (pg_temp.b(pg_temp.ws(), 'doc-e-spaet', 'structured', 'xrechnung-cii')).id is null
     or (pg_temp.b(pg_temp.ws(), 'doc-e-spaet', 'structured', 'zugferd-en16931')).client_file_ref_id is distinct from 'file-z-spaet'
     or (pg_temp.b(pg_temp.ws(), 'doc-e-beleg', 'structured', 'xrechnung-cii')).id is null then
    raise exception 'O1-O3 -- der wiederholte Aufruf hat nicht angelegt';
  end if;
  r := pg_temp.b(pg_temp.ws(), 'doc-e-offen', 'structured', 'xrechnung-cii');
  if r.deleted or r.deleted_at is not null or r.row_version is distinct from 3::bigint then
    raise exception 'O4 Wiederbeleben nach der Bestätigung: %', to_jsonb(r);
  end if;
  raise notice 'OK  O1-O4 Bestätigung, Datei und Beleg dürfen später kommen: wiederholbare Abweisung, danach gelingt derselbe Aufruf';
end $$;

/* ------------------------------------------------------------------ */
/* T -- Typangaben                                                     */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher jsonb := pg_temp.bindungen();
begin
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('T1a archive mit Unterrolle xrechnung-cii',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', 'archive', 'xrechnung-cii'), 'einvoice_binding_invalid', '22023');
  perform pg_temp.erwarte_abweisung('T1b original mit Unterrolle ZUGFeRD-EN16931',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-z-inhaber', 'original', 'ZUGFeRD-EN16931', 0, false, 'received'), 'einvoice_binding_invalid', '22023');
  perform pg_temp.erwarte_abweisung('T1c Unterrolle in anderer Schreibweise',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', 'structured', 'XRechnung-CII'), 'einvoice_binding_invalid', '22023');
  perform pg_temp.erwarte_abweisung('T1d erfundene Unterrolle',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', 'structured', 'xrechnung'), 'einvoice_binding_invalid', '22023');
  perform pg_temp.erwarte_abweisung('T1e Rolle mit Leerzeichen',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', ' structured', 'xrechnung-cii'), 'einvoice_binding_invalid', '22023');
  perform pg_temp.erwarte_abweisung('T2a Archivdokument des Mitglieds mit Rechnungsbezug',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-falsch', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_invalid: E-Rechnungen gehoeren nur an den Beleg einer Rechnung', '22023');
  perform pg_temp.erwarte_abweisung('T2b Korrekturbeleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-korr', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_invalid: E-Rechnungen gehoeren nur an den Beleg einer Rechnung', '22023');
  perform pg_temp.erwarte_abweisung('T2c gelöschter Rechnungsbeleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-weg', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_invalid: Rechnungsbeleg ist geloescht', '22023');
  perform pg_temp.erwarte_abweisung('T2d unbekannter Beleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-gibt-es-nicht', 'file-x-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Rechnungsbeleg', 'P0001');
  perform pg_temp.erwarte_abweisung('T3a XRechnung auf eine PDF-Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-z-inhaber', 'structured', 'xrechnung-cii'), 'einvoice_binding_invalid: Dateityp', '22023');
  perform pg_temp.erwarte_abweisung('T3b ZUGFeRD auf eine XML-Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-inhaber', 'structured', 'zugferd-en16931'), 'einvoice_binding_invalid: Dateityp', '22023');
  perform pg_temp.erwarte_abweisung('T3c Altbindung ohne Unterrolle auf eine PDF-Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-z-inhaber', 'structured', null), 'einvoice_binding_invalid: Dateityp', '22023');
  perform pg_temp.erwarte_abweisung('T3d gelöschte Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-x-weg', 'structured', 'xrechnung-cii'), 'einvoice_binding_invalid: Datei ist geloescht', '22023');
  perform pg_temp.erwarte_abweisung('T3e unbekannte Datei',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-e-typ', 'file-gibt-es-nicht', 'structured', 'xrechnung-cii'), 'einvoice_binding_pending: Datei', 'P0001');
  perform pg_temp.zurueck();

  perform pg_temp.im_namen(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('T4a Rolle umetikettieren',
    format('update public.workspace_document_file_bindings set binding_kind = %L, row_version = row_version + 1 where workspace_id = %L and client_document_id = %L and part = %L',
      'archive', pg_temp.ws(), 'doc-e-ok', 'xrechnung-cii'), 'einvoice_binding_invalid: Schluessel', '22023');
  perform pg_temp.erwarte_abweisung('T4b Unterrolle umetikettieren',
    format('update public.workspace_document_file_bindings set part = %L, row_version = row_version + 1 where workspace_id = %L and client_document_id = %L and part = %L',
      'zugferd-en16931', pg_temp.ws(), 'doc-e-ok', 'xrechnung-cii'), 'einvoice_binding_invalid: Schluessel', '22023');
  perform pg_temp.erwarte_abweisung('T4c an einen anderen Beleg hängen',
    format('update public.workspace_document_file_bindings set client_document_id = %L, row_version = row_version + 1 where workspace_id = %L and client_document_id = %L and part = %L',
      'doc-e-typ', pg_temp.ws(), 'doc-e-ok', 'xrechnung-cii'), 'einvoice_binding_invalid: Schluessel', '22023');
  perform pg_temp.zurueck();

  if pg_temp.bindungen() is distinct from v_vorher then
    raise exception 'T1-T4 -- Bindung trotz Abweisung';
  end if;
  raise notice 'OK  T1-T4 Unterrolle nur genau und an structured, nur am lebenden Rechnungsbeleg, Datei lebend, im Betrieb und vom passenden Typ, Schlüssel fest';
end $$;

/* ------------------------------------------------------------------ */
/* W -- Wartung und Fremdschlüsselpflege                               */
/* ------------------------------------------------------------------ */

do $$
declare
  r public.workspace_document_file_bindings;
  f public.workspace_files;
begin
  -- Ohne Nutzer (Migration, service_role): frei, auch an offener Rechnung.
  insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part)
  values (pg_temp.ws(), 'doc-e-nein', 'file-z-inhaber', 'structured', 'zugferd-en16931');

  -- ON DELETE SET NULL beim Löschen eines Kontos, im Namen des Mitglieds.
  perform pg_temp.im_namen(pg_temp.mitglied());
  update public.workspace_document_file_bindings set created_by = null, updated_by = null
  where workspace_id = pg_temp.ws() and client_document_id = 'doc-e-alt2';
  update public.workspace_files set created_by = null, uploaded_by = null, updated_by = null
  where workspace_id = pg_temp.ws() and client_file_ref_id = 'file-x-mitglied';
  perform pg_temp.erwarte_abweisung('W3a Altbindung dem Inhaber zuschreiben',
    format('update public.workspace_document_file_bindings set created_by = %L, updated_by = %L where workspace_id = %L and client_document_id = %L and part = %L',
      pg_temp.inhaber(), pg_temp.inhaber(), pg_temp.ws(), 'doc-e-alt', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('W3b Datei hinter der Altbindung dem Inhaber zuschreiben',
    format('update public.workspace_files set created_by = %L where workspace_id = %L and client_file_ref_id = %L',
      pg_temp.inhaber(), pg_temp.ws(), 'file-x-alt'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  if (pg_temp.b(pg_temp.ws(), 'doc-e-nein', 'structured', 'zugferd-en16931')).id is null then
    raise exception 'W1 Wartung ohne Nutzer';
  end if;
  r := pg_temp.b(pg_temp.ws(), 'doc-e-alt2', 'structured', 'xrechnung-cii');
  f := pg_temp.f(pg_temp.ws(), 'file-x-mitglied');
  if r.created_by is not null or r.updated_by is not null or r.row_version is distinct from 1::bigint
     or f.created_by is not null or f.uploaded_by is not null then
    raise exception 'W2 Fremdschlüsselpflege: % / %', to_jsonb(r), to_jsonb(f);
  end if;
  if (pg_temp.b(pg_temp.ws(), 'doc-e-alt', 'structured', 'xrechnung-cii')).created_by is distinct from pg_temp.mitglied()
     or (pg_temp.f(pg_temp.ws(), 'file-x-alt')).created_by is distinct from pg_temp.mitglied() then
    raise exception 'W3 -- Urheberschaft umgeschrieben';
  end if;
  raise notice 'OK  W1-W3 Wartung ohne Nutzer frei, Fremdschlüsselpflege läuft, Urheberschaft lässt sich nicht umschreiben';
end $$;

/* ------------------------------------------------------------------ */
/* D -- Altbestand: Einstufung vorhandener Bindungen                   */
/* ------------------------------------------------------------------ */

-- Dieselbe Abfrage dient (ohne Betriebsfilter, nur lesend) zur Sichtung des
-- Bestands. Die Rollen sind die heutigen, nicht die zum Schreibzeitpunkt.
create function pg_temp.einstufung(p_ws uuid) returns table (dokument text, unterrolle text, einstufung text)
language sql as $p$
  select b.client_document_id, coalesce(b.part, ''),
    case
      when b.deleted then 'geloescht'
      when coalesce(ma.role, '-') not in ('owner', 'admin') or coalesce(mu.role, '-') not in ('owner', 'admin')
        then 'pruefen: Bindung von Mitglied oder unbekannt'
      when f.id is null then 'pruefen: Datei fehlt'
      when coalesce(mf.role, '-') not in ('owner', 'admin') then 'pruefen: Datei von Mitglied oder unbekannt'
      when d.document_kind is distinct from 'generated_invoice' then 'pruefen: kein Rechnungsbeleg'
      when i.payload->>'servicePeriodConfirmed' is distinct from 'true' then 'pruefen: Leistungszeitraum nicht bestaetigt'
      else 'unauffaellig'
    end
  from public.workspace_document_file_bindings b
  left join public.workspace_documents d on d.workspace_id = b.workspace_id and d.client_document_id = b.client_document_id
  left join public.workspace_invoices i on i.workspace_id = b.workspace_id and i.client_invoice_id = d.linked_invoice_id
  left join public.workspace_files f on f.workspace_id = b.workspace_id and f.client_file_ref_id = b.client_file_ref_id
  left join public.workspace_members ma on ma.workspace_id = b.workspace_id and ma.user_id = b.created_by and ma.status = 'active'
  left join public.workspace_members mu on mu.workspace_id = b.workspace_id and mu.user_id = b.updated_by and mu.status = 'active'
  left join public.workspace_members mf on mf.workspace_id = b.workspace_id and mf.user_id = f.created_by and mf.status = 'active'
  where b.workspace_id = p_ws
    and (b.binding_kind = 'structured' or lower(btrim(coalesce(b.part, ''))) in ('xrechnung-cii', 'zugferd-en16931'));
$p$;

do $$
declare
  v_ist jsonb;
  v_soll jsonb := jsonb_build_object(
    'doc-e-alt|xrechnung-cii',     'pruefen: Bindung von Mitglied oder unbekannt',
    'doc-e-alt|zugferd-en16931',   'pruefen: Datei fehlt',
    'doc-e-alt2|xrechnung-cii',    'geloescht',
    'doc-e-ok|xrechnung-cii',      'unauffaellig',
    'doc-e-ok|zugferd-en16931',    'unauffaellig',
    'doc-e-ok|',                   'unauffaellig',
    'doc-e-offen|xrechnung-cii',   'unauffaellig',
    'doc-e-spaet|xrechnung-cii',   'unauffaellig',
    'doc-e-spaet|zugferd-en16931', 'unauffaellig',
    'doc-e-beleg|xrechnung-cii',   'unauffaellig',
    'doc-e-nein|zugferd-en16931',  'pruefen: Bindung von Mitglied oder unbekannt');
begin
  select jsonb_object_agg(e.dokument || '|' || e.unterrolle, e.einstufung) into v_ist from pg_temp.einstufung(pg_temp.ws()) e;
  if v_ist is distinct from v_soll then
    raise exception 'D1 Einstufung: %', v_ist;
  end if;
  raise notice 'OK  D1 Altbestand: Mitgliedsbindung, fehlende Datei und Wartungsbindung zur Prüfung markiert, nichts gelöscht';
end $$;

/* ------------------------------------------------------------------ */
/* G -- Rechte und Trigger                                             */
/* ------------------------------------------------------------------ */

do $$
declare
  v_funktion text;
  v_rolle text;
begin
  foreach v_funktion in array array['public.workspace_einvoice_binding_write_guard()', 'public.workspace_einvoice_file_write_guard()'] loop
    foreach v_rolle in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_rolle, v_funktion, 'execute') then
        raise exception 'G1 % darf % direkt ausführen', v_rolle, v_funktion;
      end if;
    end loop;
    if not exists (select 1 from pg_proc p where p.oid = v_funktion::regprocedure
                   and p.prosecdef and p.proconfig @> array['search_path=public']) then
      raise exception 'G2 % ist nicht security definer mit festem search_path', v_funktion;
    end if;
  end loop;
  -- Zeilentrigger vor INSERT und UPDATE (Bits: ROW 1, BEFORE 2, INSERT 4, UPDATE 16), aktiv.
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.workspace_document_file_bindings'::regclass
                   and tgname = 'workspace_document_file_bindings_einvoice_write_guard'
                   and tgenabled = 'O' and (tgtype::int & 23) = 23) then
    raise exception 'G3 Bindungs-Trigger fehlt oder ist nicht vor INSERT/UPDATE aktiv';
  end if;
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.workspace_files'::regclass
                   and tgname = 'workspace_files_einvoice_write_guard'
                   and tgenabled = 'O' and (tgtype::int & 23) = 23) then
    raise exception 'G4 Datei-Trigger fehlt oder ist nicht vor INSERT/UPDATE aktiv';
  end if;
  raise notice 'OK  G1-G4 Trigger-Funktionen für niemanden direkt aufrufbar, security definer, Trigger aktiv vor INSERT und UPDATE';
end $$;

rollback;
