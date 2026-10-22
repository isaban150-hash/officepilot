-- GO-LIVE-SECURITY-01 / VOLLSTÄNDIGE SICHERHEITSFINALISIERUNG -- Vertragstest
-- für 20261107120000_go_live_security_01_finalization.sql (zusätzlich zu
-- einvoice_binding_security_01.sql, das unverändert weiter gelten muss).
--
--   V  Vertrauensmarke: Einstufung des Altbestands mit genau einem Grund je
--      Bindung; kein angemeldeter Nutzer setzt oder entfernt die Marke, auch
--      nicht im Namen einer Security-Definer-Funktion; Wiederholen, Herkunft
--      ändern, Löschen und Wiederbeleben mit derselben Datei behalten sie; nur
--      eine neue Datei von Inhaber/Admin unter allen Prüfungen entfernt sie;
--      der Abzug liefert sie aus.
--   D  Identität der Rechnungsbelege: Mitglied legt kein Archivdokument mit
--      Rechnungsbezug an (Spalte oder Nutzlast), nichts unter corr-, keine
--      Rechnungs- oder Korrekturbelege; der normale Eingangsweg und das
--      Bereinigen eigener Altdokumente bleiben; Inhaber/Admin wie bisher;
--      Stornierung gelingt; ein vorab angelegtes corr-Dokument aus der Zeit
--      davor blockiert sie (Prüfabfrage findet es).
--   G  Rechte, Trigger und Sperren.
--
-- Wettläufe zwischen zwei Sitzungen prüft supabase/tests/go_live_security_01_race.mjs.
--
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/go_live_security_01_finalization.sql
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
  ('00000000-0000-0000-0000-000000f1a001'::uuid, 'inhaber-final@example.invalid'),
  ('00000000-0000-0000-0000-000000f1a002'::uuid, 'admin-final@example.invalid'),
  ('00000000-0000-0000-0000-000000f1a003'::uuid, 'mitglied-final@example.invalid'),
  ('00000000-0000-0000-0000-000000f1a004'::uuid, 'fremd-final@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-000000f1a001'::uuid, '00000000-0000-0000-0000-000000f1a002'::uuid,
             '00000000-0000-0000-0000-000000f1a003'::uuid, '00000000-0000-0000-0000-000000f1a004'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000f1aa01'::uuid, 'Final A', '00000000-0000-0000-0000-000000f1a001'::uuid),
       ('00000000-0000-0000-0000-000000f1ab01'::uuid, 'Final B', '00000000-0000-0000-0000-000000f1a004'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000f1aa01'::uuid, '00000000-0000-0000-0000-000000f1a001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-000000f1aa01'::uuid, '00000000-0000-0000-0000-000000f1a002'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000f1aa01'::uuid, '00000000-0000-0000-0000-000000f1a003'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-000000f1ab01'::uuid, '00000000-0000-0000-0000-000000f1a004'::uuid, 'owner',  'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000f1aa01'::uuid $p$;
create function pg_temp.ws_b() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000f1ab01'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000f1a001'::uuid $p$;
create function pg_temp.admin() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000f1a002'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000f1a003'::uuid $p$;
create function pg_temp.fremd() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000f1a004'::uuid $p$;

insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values (pg_temp.ws(), null, 'inv-f-ok',      '2026-9401', 2026, 9401, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-f-ok2',     '2026-9402', 2026, 9402, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-f-storno',  '2026-9403', 2026, 9403, 'rechnung', 'versendet',   '{"status":"versendet","servicePeriodConfirmed":true}'::jsonb),
       (pg_temp.ws(), null, 'inv-f-storno2', '2026-9404', 2026, 9404, 'rechnung', 'versendet',   '{"status":"versendet","servicePeriodConfirmed":true}'::jsonb);

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values (pg_temp.ws(), 'doc-f-ok',  'generated_invoice', 'inv-f-ok',  '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok2', 'generated_invoice', 'inv-f-ok2', '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-scan', 'archived_document', null, '{"id":"doc-f-scan","title":"Scan"}'::jsonb, pg_temp.mitglied()),
       -- Altbestand von vor der Migration: Archivdokument eines Mitglieds, das sich als Rechnungsbeleg ausgibt ...
       (pg_temp.ws(), 'doc-f-alt-mitglied', 'archived_document', 'inv-f-ok',
        '{"id":"doc-f-alt-mitglied","title":"Rechnung 2026-9401","category":"ausgangsrechnung","classifiedKind":"ausgangsrechnung","linkedInvoiceId":"inv-f-ok"}'::jsonb,
        pg_temp.mitglied()),
       -- ... und ein vorab angelegtes Dokument unter der Kennung des künftigen Korrekturbelegs.
       (pg_temp.ws(), 'corr-inv-f-storno2', 'archived_document', null, '{"id":"corr-inv-f-storno2","title":"Platzhalter"}'::jsonb, pg_temp.mitglied());

insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by, deleted, deleted_at)
select pg_temp.ws(), v.id, repeat(v.h, 64), 10, v.typ, pg_temp.ws()::text || '/' || repeat(v.h, 64), v.von, v.von, v.weg,
       case when v.weg then now() end
from (values
  ('file-f-x-inhaber',  '1', 'application/xml', pg_temp.inhaber(),  false),
  ('file-f-x-inhaber2', '2', 'application/xml', pg_temp.inhaber(),  false),
  ('file-f-z-inhaber',  '3', 'application/pdf', pg_temp.inhaber(),  false),
  ('file-f-x-mitglied', '4', 'application/xml', pg_temp.mitglied(), false),
  ('file-f-weg',        '5', 'application/xml', pg_temp.inhaber(),  true),
  ('file-f-scan',       '6', 'application/pdf', pg_temp.mitglied(), false)
) as v(id, h, typ, von, weg);

-- Altbestand an Bindungen (als Wartung ohne Nutzer, wie vor der Migration entstanden).
insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, provenance, created_by, updated_by)
values (pg_temp.ws(), 'doc-f-ok',   'file-f-x-mitglied', 'structured', 'xrechnung-cii',   'derived', pg_temp.mitglied(), pg_temp.mitglied()),
       (pg_temp.ws(), 'doc-f-ok',   'file-f-z-inhaber',  'structured', 'zugferd-en16931', 'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok',   'file-f-x-mitglied', 'structured', null,              'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-scan', 'file-f-fehlt',      'structured', null,              'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok2',  'file-f-fehlt',      'structured', 'xrechnung-cii',   'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok2',  'file-f-x-inhaber',  'structured', 'zugferd-en16931', 'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok2',  'file-f-weg',        'structured', null,              'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok2',  'file-f-z-inhaber',  'archive',    null,              'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-scan', 'file-f-scan',       'archive',    'xrechnung-cii',   'derived', pg_temp.inhaber(),  pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-f-ok2',  'file-f-x-inhaber2', 'structured', 'xrechnung',       'derived', pg_temp.inhaber(),  pg_temp.inhaber());

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.im_namen(p_user uuid) returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
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

create function pg_temp.bindung(p_ws uuid, p_doc text, p_datei text, p_art text, p_teil text,
  p_version bigint default 0, p_geloescht boolean default false, p_herkunft text default 'derived')
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(p_ws, 'document_file_binding',
    jsonb_strip_nulls(jsonb_build_object(
      'binding_id', p_doc || '|' || coalesce(p_art, '') || '|' || coalesce(p_teil, ''),
      'client_document_id', p_doc, 'client_file_ref_id', p_datei,
      'binding_kind', p_art, 'part', p_teil, 'provenance', p_herkunft, 'deleted', p_geloescht)), p_version);
$p$;

create function pg_temp.bindung_sql(p_ws uuid, p_doc text, p_datei text, p_art text, p_teil text,
  p_version bigint default 0, p_geloescht boolean default false, p_herkunft text default 'derived')
returns text language sql immutable as $p$
  select format('select pg_temp.bindung(%L::uuid, %L, %L, %L, %L, %s, %L::boolean, %L)',
    p_ws, p_doc, p_datei, p_art, p_teil, p_version, p_geloescht, p_herkunft);
$p$;

/** Der Eingangsweg des Clients für ein Archivdokument. */
create function pg_temp.archiv(p_id text, p_spalte text, p_nutzlast jsonb, p_version bigint default 0)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document',
    jsonb_strip_nulls(jsonb_build_object('client_document_id', p_id, 'linked_invoice_id', p_spalte))
      || jsonb_build_object('payload', p_nutzlast), p_version);
$p$;

create function pg_temp.archiv_sql(p_id text, p_spalte text, p_nutzlast jsonb, p_version bigint default 0)
returns text language sql immutable as $p$
  select format('select pg_temp.archiv(%L, %L, %L::jsonb, %s)', p_id, p_spalte, p_nutzlast, p_version);
$p$;

create function pg_temp.b(p_doc text, p_art text, p_teil text)
returns public.workspace_document_file_bindings language sql as $p$
  select * from public.workspace_document_file_bindings
  where workspace_id = pg_temp.ws() and client_document_id = p_doc and binding_kind = p_art
    and coalesce(part, '') = coalesce(p_teil, '');
$p$;

create function pg_temp.dok(p_id text) returns public.workspace_documents language sql as $p$
  select * from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = p_id;
$p$;

/* ------------------------------------------------------------------ */
/* V -- Vertrauensmarke                                                */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ist jsonb;
  v_soll jsonb := jsonb_build_object(
    'doc-f-ok|structured|xrechnung-cii',    'bindung_nicht_von_inhaber_oder_admin',
    'doc-f-ok|structured|zugferd-en16931',  null,
    'doc-f-ok|structured|',                 'datei_nicht_von_inhaber_oder_admin',
    'doc-f-scan|structured|',               'kein_rechnungsbeleg',
    'doc-f-ok2|structured|xrechnung-cii',   'datei_fehlt',
    'doc-f-ok2|structured|zugferd-en16931', 'dateityp_passt_nicht',
    'doc-f-ok2|structured|',                'datei_geloescht',
    'doc-f-ok2|archive|',                   null,
    'doc-f-scan|archive|xrechnung-cii',     'unterrolle_an_falscher_rolle',
    'doc-f-ok2|structured|xrechnung',       'unterrolle_unbekannt');
begin
  select jsonb_object_agg(b.client_document_id || '|' || b.binding_kind || '|' || coalesce(b.part, ''),
                          public.workspace_einvoice_binding_trust_reason(b))
  into v_ist
  from public.workspace_document_file_bindings b where b.workspace_id = pg_temp.ws();
  if v_ist is distinct from v_soll then
    raise exception 'V1 Einstufung: %', v_ist;
  end if;

  -- Dieselbe Anweisung wie in der Migration, hier auf den Testbetrieb begrenzt.
  update public.workspace_document_file_bindings b
  set einvoice_untrusted_at = now(), einvoice_untrusted_reason = e.grund
  from (select x.id, public.workspace_einvoice_binding_trust_reason(x) as grund
        from public.workspace_document_file_bindings x
        where x.workspace_id = pg_temp.ws() and x.einvoice_untrusted_at is null) e
  where e.id = b.id and e.grund is not null;

  if (select count(*) from public.workspace_document_file_bindings
      where workspace_id = pg_temp.ws() and einvoice_untrusted_at is not null) <> 8
     or exists (select 1 from public.workspace_document_file_bindings
                where workspace_id = pg_temp.ws() and einvoice_untrusted_at is not null and row_version <> 1) then
    raise exception 'V1 Markierung: 8 Bindungen markiert, Versionen unverändert erwartet';
  end if;
  raise notice 'OK  V1 Altbestand: genau ein Grund je Bindung, unauffällige und Nicht-E-Rechnungen ohne Marke, Versionen unverändert';
end $$;

do $$
declare
  r public.workspace_document_file_bindings;
  v jsonb;
begin
  -- Im Namen des Inhabers (wie eine Security-Definer-Funktion): Marke entfernen und neu setzen wirkt nicht.
  perform pg_temp.im_namen(pg_temp.inhaber());
  update public.workspace_document_file_bindings set einvoice_untrusted_at = null, einvoice_untrusted_reason = null
  where workspace_id = pg_temp.ws() and client_document_id = 'doc-f-ok' and part = 'xrechnung-cii';
  update public.workspace_document_file_bindings set einvoice_untrusted_at = now(), einvoice_untrusted_reason = 'erfunden'
  where workspace_id = pg_temp.ws() and client_document_id = 'doc-f-ok' and part = 'zugferd-en16931';
  insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, einvoice_untrusted_at, einvoice_untrusted_reason)
  values (pg_temp.ws(), 'doc-f-scan', 'file-f-scan', 'original', now(), 'erfunden');
  perform pg_temp.zurueck();
  if (pg_temp.b('doc-f-ok', 'structured', 'xrechnung-cii')).einvoice_untrusted_reason is distinct from 'bindung_nicht_von_inhaber_oder_admin'
     or (pg_temp.b('doc-f-ok', 'structured', 'zugferd-en16931')).einvoice_untrusted_at is not null
     or (pg_temp.b('doc-f-scan', 'original', null)).einvoice_untrusted_at is not null then
    raise exception 'V2 Marke von einem angemeldeten Nutzer verändert';
  end if;

  -- Über den Eingangsweg: wiederholen, Herkunft ändern, löschen, wiederbeleben -- die Marke bleibt.
  perform pg_temp.als(pg_temp.inhaber());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok', 'file-f-x-mitglied', 'structured', 'xrechnung-cii', 1);
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok', 'file-f-x-mitglied', 'structured', 'xrechnung-cii', 2, false, 'extracted');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok', 'file-f-x-mitglied', 'structured', 'xrechnung-cii', 3, true, 'extracted');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok', 'file-f-x-mitglied', 'structured', 'xrechnung-cii', 4, false, 'extracted');
  perform pg_temp.zurueck();
  r := pg_temp.b('doc-f-ok', 'structured', 'xrechnung-cii');
  if r.einvoice_untrusted_at is null or r.row_version is distinct from 5::bigint or r.deleted then
    raise exception 'V3 Wiederholen, Herkunft, Grabstein und Wiederbeleben mit derselben Datei behalten die Marke: %', to_jsonb(r);
  end if;

  -- Nur eine neue Datei unter allen Prüfungen entfernt sie.
  perform pg_temp.als(pg_temp.admin());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok', 'file-f-x-inhaber', 'structured', 'xrechnung-cii', 5);
  perform pg_temp.zurueck();
  r := pg_temp.b('doc-f-ok', 'structured', 'xrechnung-cii');
  if r.einvoice_untrusted_at is not null or r.einvoice_untrusted_reason is not null
     or r.client_file_ref_id is distinct from 'file-f-x-inhaber' or r.updated_by is distinct from pg_temp.admin() then
    raise exception 'V4 neue Datei durch Admin entfernt die Marke: %', to_jsonb(r);
  end if;

  -- Ein Ersatz, der eine Prüfung nicht besteht, entfernt nichts.
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('V5 Ersatz mit falschem Dateityp',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-f-ok', 'file-f-z-inhaber', 'structured', null, 1),
    'einvoice_binding_invalid: Dateityp', '22023');
  perform pg_temp.zurueck();
  if (pg_temp.b('doc-f-ok', 'structured', null)).einvoice_untrusted_reason is distinct from 'datei_nicht_von_inhaber_oder_admin' then
    raise exception 'V5 -- Marke trotz abgewiesenem Ersatz entfernt';
  end if;

  -- Der Abzug liefert die Marke aus (Inhaber/Admin sehen alle Bindungen, Mitglieder nur eigene).
  perform pg_temp.als(pg_temp.inhaber());
  v := public.pull_workspace_intake_state(pg_temp.ws());
  perform pg_temp.zurueck();
  if not exists (
    select 1 from jsonb_array_elements(v->'bindings') e
    where e->>'client_document_id' = 'doc-f-ok' and coalesce(e->>'part', '') = ''
      and e->>'einvoice_untrusted_reason' = 'datei_nicht_von_inhaber_oder_admin'
  ) or not exists (
    select 1 from jsonb_array_elements(v->'bindings') e
    where e->>'client_document_id' = 'doc-f-ok' and e->>'part' = 'xrechnung-cii'
      and e ? 'einvoice_untrusted_at' and e->'einvoice_untrusted_at' = 'null'::jsonb
  ) then
    raise exception 'V6 Abzug ohne Vertrauensmarke';
  end if;
  raise notice 'OK  V2-V6 Marke nur durch den Server: kein Nutzer setzt oder entfernt sie, Wiederholen/Herkunft/Grabstein/Wiederbeleben behalten sie, nur eine geprüfte neue Datei entfernt sie, der Abzug liefert sie';
end $$;

/* ------------------------------------------------------------------ */
/* D -- Identität der Rechnungsbelege                                  */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
  v_dokumente bigint := (select count(*) from public.workspace_documents where workspace_id = pg_temp.ws());
begin
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('D1 Archivdokument mit linked_invoice_id',
    pg_temp.archiv_sql('doc-f-falsch1', 'inv-f-ok', '{"id":"doc-f-falsch1","title":"Rechnung 2026-9401","category":"ausgangsrechnung","classifiedKind":"ausgangsrechnung"}'::jsonb),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D2 Archivdokument mit linkedInvoiceId nur in der Nutzlast',
    pg_temp.archiv_sql('doc-f-falsch2', null, '{"id":"doc-f-falsch2","title":"Rechnung 2026-9401","category":"ausgangsrechnung","classifiedKind":"ausgangsrechnung","linkedInvoiceId":"inv-f-ok"}'::jsonb),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D3 Dokument unter der Kennung des künftigen Korrekturbelegs',
    pg_temp.archiv_sql('corr-inv-f-storno', null, '{"id":"corr-inv-f-storno","title":"Platzhalter"}'::jsonb),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D4a Archivbindung an den künftigen Korrekturbeleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'corr-inv-f-storno', 'file-f-scan', 'archive', null), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D4b Original an den künftigen Korrekturbeleg',
    pg_temp.bindung_sql(pg_temp.ws(), 'corr-inv-f-storno', 'file-f-scan', 'original', null, 0, false, 'received'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D5 eigenes Altdokument mit Rechnungsbezug weiter bearbeiten',
    pg_temp.archiv_sql('doc-f-alt-mitglied', 'inv-f-ok', '{"id":"doc-f-alt-mitglied","title":"Umbenannt","linkedInvoiceId":"inv-f-ok"}'::jsonb, 1),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  perform pg_temp.im_namen(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('D6a im Namen einen Rechnungsbeleg anlegen',
    format('insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload) values (%L, %L, %L, %L, %L)',
      pg_temp.ws(), 'doc-f-gefaelscht', 'generated_invoice', 'inv-f-ok2', '{}'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D6b im Namen den Rechnungsbezug eines Archivdokuments setzen',
    format('update public.workspace_documents set linked_invoice_id = %L where workspace_id = %L and client_document_id = %L',
      'inv-f-ok', pg_temp.ws(), 'doc-f-scan'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('D6c im Namen einen Rechnungsbeleg verändern',
    format('update public.workspace_documents set payload = %L where workspace_id = %L and client_document_id = %L',
      '{"title":"anders"}', pg_temp.ws(), 'doc-f-ok'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  if (select count(*) from public.workspace_documents where workspace_id = pg_temp.ws()) <> v_dokumente
     or (pg_temp.dok('doc-f-scan')).linked_invoice_id is not null
     or (pg_temp.dok('doc-f-alt-mitglied')).row_version is distinct from 1::bigint
     or (pg_temp.dok('doc-f-ok')).payload is distinct from '{}'::jsonb then
    raise exception 'D1-D6 -- Dokumente verändert';
  end if;
  raise notice 'OK  D1-D6 Mitglied fälscht keinen Rechnungsbeleg: kein Rechnungsbezug in Spalte oder Nutzlast, nichts unter corr-, keine Rechnungsbelege, auf keinem Weg';
end $$;

do $$
declare
  v jsonb;
  r public.workspace_documents;
begin
  -- Normaler Eingangsweg und Bereinigen eigener Altdokumente bleiben.
  perform pg_temp.als(pg_temp.mitglied());
  v := pg_temp.archiv('doc-f-neu', null, '{"id":"doc-f-neu","title":"Lieferschein","linkedInvoiceId":null}'::jsonb);
  v := pg_temp.archiv('doc-f-neu', null, '{"id":"doc-f-neu","title":"Lieferschein Mai","linkedInvoiceId":null}'::jsonb, 1);
  -- DOKUMENTE-01: nur der Rechnungsbezug geht, die Einstufung bleibt (wie `withoutInvoiceDocumentClaim`).
  -- Seit 20261125 weist der Server das Entfernen der Kategorie während der Aufbewahrungsfrist ab.
  v := pg_temp.archiv('doc-f-alt-mitglied', null,
    '{"id":"doc-f-alt-mitglied","title":"Kein Rechnungsbeleg","category":"ausgangsrechnung","classifiedKind":"ausgangsrechnung"}'::jsonb, 1);
  perform pg_temp.zurueck();
  r := pg_temp.dok('doc-f-neu');
  if r.row_version is distinct from 2::bigint or r.payload->>'title' is distinct from 'Lieferschein Mai' then
    raise exception 'D7a normaler Eingangsweg: %', to_jsonb(r);
  end if;
  r := pg_temp.dok('doc-f-alt-mitglied');
  if r.linked_invoice_id is not null or r.payload ? 'linkedInvoiceId' then
    raise exception 'D7b eigenes Altdokument vom Rechnungsbezug befreien: %', to_jsonb(r);
  end if;

  -- Fremdschlüsselpflege im Namen des Mitglieds.
  perform pg_temp.im_namen(pg_temp.mitglied());
  update public.workspace_documents set created_by = null, updated_by = null
  where workspace_id = pg_temp.ws() and client_document_id = 'corr-inv-f-storno2';
  perform pg_temp.zurueck();
  if (pg_temp.dok('corr-inv-f-storno2')).created_by is not null then
    raise exception 'D8 Fremdschlüsselpflege';
  end if;

  -- Inhaber/Admin wie bisher.
  perform pg_temp.als(pg_temp.admin());
  v := pg_temp.archiv('doc-f-admin', 'inv-f-ok', '{"id":"doc-f-admin","title":"Zahlungsavis","linkedInvoiceId":"inv-f-ok"}'::jsonb);
  perform pg_temp.zurueck();
  if (pg_temp.dok('doc-f-admin')).linked_invoice_id is distinct from 'inv-f-ok' then
    raise exception 'D9 Admin legt Archivdokument mit Rechnungsbezug an';
  end if;

  -- Die Stornierung gelingt; ein vorab angelegtes corr-Dokument aus der Zeit davor blockiert sie.
  perform pg_temp.als(pg_temp.inhaber());
  perform public.cancel_workspace_invoice(pg_temp.ws(), 'inv-f-storno', 'Fehlerhafte Anschrift');
  perform pg_temp.erwarte_abweisung('D10b Altbestand: vorab angelegtes corr-Dokument',
    format('select public.cancel_workspace_invoice(%L, %L, %L)', pg_temp.ws(), 'inv-f-storno2', 'Fehlerhafte Anschrift'),
    'Dokumentkonflikt', null);
  perform pg_temp.zurueck();
  r := pg_temp.dok('corr-inv-f-storno');
  if r.document_kind is distinct from 'generated_invoice_correction' or r.linked_invoice_id is distinct from 'inv-f-storno' then
    raise exception 'D10a Stornierung legt den Korrekturbeleg an: %', to_jsonb(r);
  end if;
  raise notice 'OK  D7-D10 Eingangsweg und Bereinigen bleiben, Inhaber/Admin wie bisher, Stornierung gelingt; Altbestand unter corr- blockiert (siehe P1)';
end $$;

/* ------------------------------------------------------------------ */
/* P -- Prüfabfragen für den Bestand (nur lesend)                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ist jsonb;
begin
  -- P1 Dokumente, die einen Rechnungsbeleg vorgeben oder eine corr-Kennung
  -- belegen, ohne Rechnungs- oder Korrekturbeleg zu sein.
  select jsonb_agg(d.client_document_id order by d.client_document_id) into v_ist
  from public.workspace_documents d
  where d.workspace_id = pg_temp.ws()
    and d.document_kind = 'archived_document'
    and (d.client_document_id like 'corr-%'
         or (d.linked_invoice_id is not null
             and not exists (select 1 from public.workspace_members m
                             where m.workspace_id = d.workspace_id and m.user_id = d.created_by
                               and m.status = 'active' and m.role in ('owner', 'admin'))));
  if v_ist is distinct from '["corr-inv-f-storno2"]'::jsonb then
    raise exception 'P1 Prüfabfrage Dokumente: %', v_ist;
  end if;
  raise notice 'OK  P1 Prüfabfrage findet das vorab angelegte corr-Dokument; das bereinigte Altdokument ist nicht mehr auffällig';
end $$;

/* ------------------------------------------------------------------ */
/* R -- Rollenwechsel, Rechteentzug, abgelaufene Lizenz                */
/* ------------------------------------------------------------------ */

-- Die Rolle gilt zum Schreibzeitpunkt: Wer herabgestuft wird, schreibt ab
-- sofort nichts mehr; wer aufsteigt, darf; wer entfernt wird, kommt nicht
-- mehr hinein; ohne gültige Lizenz entsteht nichts, Aufräumen bleibt.
do $$
declare
  v jsonb;
begin
  -- Admin legt die ZUGFeRD-Rechnung an doc-f-ok2 an ...
  delete from public.workspace_document_file_bindings
  where workspace_id = pg_temp.ws() and client_document_id = 'doc-f-ok2' and part = 'zugferd-en16931';
  perform pg_temp.als(pg_temp.admin());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok2', 'file-f-z-inhaber', 'structured', 'zugferd-en16931');
  perform pg_temp.zurueck();

  -- ... wird herabgestuft und kann sie nicht mehr ersetzen, löschen oder neu anlegen.
  update public.workspace_members set role = 'member' where workspace_id = pg_temp.ws() and user_id = pg_temp.admin();
  perform pg_temp.als(pg_temp.admin());
  perform pg_temp.erwarte_abweisung('R1a herabgestufter Admin ersetzt',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-f-ok2', 'file-f-z-inhaber', 'structured', 'zugferd-en16931', 1, false, 'extracted'),
    'Keine Schreibberechtigung', null);
  perform pg_temp.erwarte_abweisung('R1b herabgestufter Admin legt neu an',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-f-ok', 'file-f-x-inhaber2', 'structured', null), 'Keine Schreibberechtigung', null);
  perform pg_temp.zurueck();

  -- Das Mitglied steigt zum Admin auf und darf.
  update public.workspace_members set role = 'admin' where workspace_id = pg_temp.ws() and user_id = pg_temp.mitglied();
  perform pg_temp.als(pg_temp.mitglied());
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok2', 'file-f-z-inhaber', 'structured', 'zugferd-en16931', 1, false, 'extracted');
  perform pg_temp.zurueck();
  if (pg_temp.b('doc-f-ok2', 'structured', 'zugferd-en16931')).updated_by is distinct from pg_temp.mitglied() then
    raise exception 'R2 aufgestiegenes Mitglied schreibt als Admin';
  end if;

  -- Rechteentzug: entfernt (inaktiv) kommt nicht mehr hinein.
  update public.workspace_members set status = 'removed' where workspace_id = pg_temp.ws() and user_id = pg_temp.mitglied();
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('R3 entferntes Mitglied',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-f-ok2', 'file-f-z-inhaber', 'structured', 'zugferd-en16931', 2), 'Kein Zugriff auf Workspace', null);
  perform pg_temp.zurueck();

  -- Abgelaufene Lizenz des Inhabers: nichts Neues, Aufräumen bleibt.
  update public.profiles set license_status = 'expired' where id = pg_temp.inhaber();
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('R4a Inhaber mit abgelaufener Lizenz legt an',
    pg_temp.bindung_sql(pg_temp.ws(), 'doc-f-ok', 'file-f-x-inhaber2', 'structured', null, 1), 'finance_license_expired', 'P0001');
  v := pg_temp.bindung(pg_temp.ws(), 'doc-f-ok2', 'file-f-z-inhaber', 'structured', 'zugferd-en16931', 2, true, 'extracted');
  perform pg_temp.zurueck();
  if not (pg_temp.b('doc-f-ok2', 'structured', 'zugferd-en16931')).deleted then
    raise exception 'R4b Grabstein trotz abgelaufener Lizenz';
  end if;
  raise notice 'OK  R1-R4 Rolle zum Schreibzeitpunkt: herabgestuft nein, aufgestiegen ja, entfernt kein Zugang, abgelaufene Lizenz legt nichts an, räumt aber auf';
end $$;

/* ------------------------------------------------------------------ */
/* G -- Rechte, Trigger und Sperren                                    */
/* ------------------------------------------------------------------ */

do $$
declare
  v_funktion text;
  v_rolle text;
begin
  foreach v_funktion in array array[
    'public.workspace_einvoice_binding_write_guard()',
    'public.workspace_einvoice_file_write_guard()',
    'public.workspace_invoice_document_identity_guard()',
    'public.workspace_einvoice_binding_trust_reason(public.workspace_document_file_bindings)'] loop
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
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.workspace_documents'::regclass
                   and tgname = 'workspace_documents_invoice_identity_guard'
                   and tgenabled = 'O' and (tgtype::int & 23) = 23) then
    raise exception 'G3 Dokument-Trigger fehlt oder ist nicht vor INSERT/UPDATE aktiv';
  end if;
  if (select count(*) from regexp_matches(
        (select prosrc from pg_proc where oid = 'public.workspace_einvoice_binding_write_guard()'::regprocedure),
        'for share', 'g')) <> 2 then
    raise exception 'G4 Bindungswächter sperrt Beleg und Datei nicht (FOR SHARE)';
  end if;
  raise notice 'OK  G1-G4 Funktionen für niemanden direkt aufrufbar, security definer, Dokument-Trigger aktiv, Sperren auf Beleg und Datei';
end $$;

rollback;
