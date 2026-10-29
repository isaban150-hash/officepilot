-- GO-LIVE-SECURITY-01 / ABSCHLUSS -- Vertragstest für
-- 20261108120000_go_live_security_01_completion.sql (zusätzlich zu
-- go_live_security_01.sql, einvoice_binding_security_01.sql und
-- go_live_security_01_finalization.sql, die unverändert weiter gelten müssen).
--
--   E  Abgrenzung der E-Rechnungsbindungen: structured/extracted an einem
--      gewöhnlichen Archivdokument ist wieder Eingangsweg (Vertrag
--      INTAKE-CLOUD-SQL-01B); E-Rechnungen und Rechnungsbelege bleiben
--      geschützt; Einstufung und Fehlmarke folgen derselben Abgrenzung.
--   R  R1 kein Wiederbeleben durch Mitglieder, R2 Bindungen nur an eigene oder
--      unbekannte Dokumente, R3 corr- nur als Korrekturbeleg (auch Inhaber),
--      R4 Dateiwächter mit corr-, R5 kein Versandvermerk für intern stornierte
--      Rechnungen, R6 Lizenz/Freigabe bei Versandvermerk und Leistungszeitraum,
--      R7 kein Lesen eingeschränkter Speicherobjekte über den Hash, R8 Mitglieder
--      ändern nur eigene Bankzeilen.
--   M  Rollenmatrix über beliebig viele Konten: Inhaber, Admin, zwei Mitglieder,
--      entferntes Mitglied, Rechteentzug mitten im Ablauf, Mitglied und Inhaber
--      eines fremden Betriebs, Admin mit abgelaufener Lizenz, gesperrtes Konto
--      (seit 20261109 auf allen Wegen abgewiesen; vorher las und loeschte es — WEISS-Befund),
--      anon -- je gegen dieselben Schutzaktionen.
--   G  Rechte und Trigger der neuen Funktionen.
--
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/go_live_security_01_completion.sql
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
  ('00000000-0000-0000-0000-000000c0a001'::uuid, 'inhaber-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a002'::uuid, 'admin-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a003'::uuid, 'mitglied1-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a004'::uuid, 'mitglied2-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a005'::uuid, 'entfernt-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a006'::uuid, 'fremdmitglied-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a007'::uuid, 'fremdinhaber-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a008'::uuid, 'lizenz-abschluss@example.invalid'),
  ('00000000-0000-0000-0000-000000c0a009'::uuid, 'gesperrt-abschluss@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id::text like '00000000-0000-0000-0000-000000c0a00%';
update public.profiles set license_status = 'expired' where id = '00000000-0000-0000-0000-000000c0a008'::uuid;
update public.profiles set status = 'blocked' where id = '00000000-0000-0000-0000-000000c0a009'::uuid;

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000c0aa01'::uuid, 'Abschluss A', '00000000-0000-0000-0000-000000c0a001'::uuid),
       ('00000000-0000-0000-0000-000000c0ab01'::uuid, 'Abschluss B', '00000000-0000-0000-0000-000000c0a007'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a002'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a003'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a004'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a005'::uuid, 'member', 'removed'),
       ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a008'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000c0aa01'::uuid, '00000000-0000-0000-0000-000000c0a009'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000c0ab01'::uuid, '00000000-0000-0000-0000-000000c0a007'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-000000c0ab01'::uuid, '00000000-0000-0000-0000-000000c0a006'::uuid, 'member', 'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0aa01'::uuid $p$;
create function pg_temp.ws_b() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0ab01'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a001'::uuid $p$;
create function pg_temp.admin() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a002'::uuid $p$;
create function pg_temp.mitglied1() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a003'::uuid $p$;
create function pg_temp.mitglied2() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a004'::uuid $p$;
create function pg_temp.entfernt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a005'::uuid $p$;
create function pg_temp.fremdmitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a006'::uuid $p$;
create function pg_temp.fremdinhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a007'::uuid $p$;
create function pg_temp.lizenz() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a008'::uuid $p$;
create function pg_temp.gesperrt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000c0a009'::uuid $p$;

-- Rechnungen: zu bestätigen, bestätigt, intern storniert, mit Korrekturbeleg storniert.
insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload, cancelled_at, cancellation_kind, cancel_reason, correction_document_id)
values (pg_temp.ws(), null, 'inv-c-offen',  '2026-9501', 2026, 9501, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb, null, null, null, null),
       (pg_temp.ws(), null, 'inv-c-ok',     '2026-9502', 2026, 9502, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb, null, null, null, null),
       (pg_temp.ws(), null, 'inv-c-intern', '2026-9503', 2026, 9503, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb, now(), 'internal', 'Testgrund', null),
       (pg_temp.ws(), null, 'inv-c-korr',   '2026-9504', 2026, 9504, 'rechnung', 'versendet',   '{"status":"versendet","servicePeriodConfirmed":true,"sentAt":"2026-10-01","sentVia":"email"}'::jsonb, now(), 'correction', 'Testgrund', 'corr-inv-c-korr'),
       (pg_temp.ws(), null, 'inv-c-matrix', '2026-9505', 2026, 9505, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb, null, null, null, null);

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values (pg_temp.ws(), 'doc-c-inhaber', 'archived_document', null, '{"id":"doc-c-inhaber","title":"Eingang Inhaber"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-c-m1',      'archived_document', null, '{"id":"doc-c-m1","title":"Eingang Mitglied 1"}'::jsonb, pg_temp.mitglied1()),
       (pg_temp.ws(), 'doc-c-gen',     'generated_invoice', 'inv-c-ok', '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'emp-receipt-c1', 'archived_document', null, '{"id":"emp-receipt-c1","title":"Quittung"}'::jsonb, pg_temp.inhaber()),
       -- Altplatzhalter unter corr- aus der Zeit vor der Finalisierung (Wartung).
       (pg_temp.ws(), 'corr-inv-c-alt', 'archived_document', null, '{"id":"corr-inv-c-alt","title":"Platzhalter"}'::jsonb, null);

insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by)
select pg_temp.ws(), v.id, repeat(v.h, 64), 10, v.typ, pg_temp.ws()::text || '/' || repeat(v.h, 64), v.von, v.von
from (values
  ('file-c-m1',      'a', 'application/pdf', pg_temp.mitglied1()),
  ('file-c-m1-xml',  'b', 'application/xml', pg_temp.mitglied1()),
  ('file-c-inh',     'c', 'application/pdf', pg_temp.inhaber()),
  ('file-c-rest',    'd', 'application/pdf', pg_temp.inhaber()),
  ('file-c-inh-xml', 'e', 'application/xml', pg_temp.inhaber()),
  ('file-c-m2-corr', 'f', 'application/xml', pg_temp.mitglied2())
) as v(id, h, typ, von);

insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, provenance, created_by, updated_by)
values (pg_temp.ws(), 'emp-receipt-c1', 'file-c-rest', 'original', null, 'received', pg_temp.inhaber(), pg_temp.inhaber()),
       -- Altbindung unter dem künftigen Korrekturbeleg (vor der Finalisierung), bewusst keine
       -- E-Rechnungsrolle: Nur die corr-Regel des Dateiwächters (R4) schützt die Datei dahinter.
       (pg_temp.ws(), 'corr-inv-c-ok', 'file-c-m2-corr', 'archive', null, 'derived', pg_temp.mitglied2(), pg_temp.mitglied2());

insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
values (pg_temp.ws(), 'bacc-c-inh', 'Konto Inhaber', 'DE00INH', '{"displayName":"Konto Inhaber","identifier":"DE00INH"}'::jsonb, pg_temp.inhaber(), pg_temp.inhaber()),
       (pg_temp.ws(), 'bacc-c-m1',  'Konto Mitglied', 'DE00M1', '{"displayName":"Konto Mitglied","identifier":"DE00M1"}'::jsonb, pg_temp.mitglied1(), pg_temp.mitglied1());

insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name, imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)
values (pg_temp.ws(), 'btx-c-inh', 'bacc-c-inh', 'bimp-c-1', 'auszug.csv', now(), '2026-10-01', 1000, 'fp-c-inh', 1, '{"purpose":"Inhaber"}'::jsonb, pg_temp.inhaber(), pg_temp.inhaber()),
       (pg_temp.ws(), 'btx-c-m1',  'bacc-c-m1',  'bimp-c-2', 'auszug.csv', now(), '2026-10-01', 2000, 'fp-c-m1',  1, '{"purpose":"Mitglied"}'::jsonb, pg_temp.mitglied1(), pg_temp.mitglied1());

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.als_anon() returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end;
$p$;

/** Im Namen eines Nutzers, aber als postgres: prüft die Trigger auf jedem Schreibweg. */
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

create function pg_temp.datei(p_id text, p_hash text, p_typ text, p_version bigint default 0, p_geloescht boolean default false)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(pg_temp.ws(), 'document_file',
    jsonb_build_object('client_file_ref_id', p_id, 'content_sha256', p_hash, 'size_bytes', 10,
      'mime_type', p_typ, 'original_file_name', p_id, 'deleted', p_geloescht), p_version);
$p$;

create function pg_temp.bindung(p_doc text, p_datei text, p_art text, p_teil text,
  p_version bigint default 0, p_geloescht boolean default false, p_herkunft text default 'derived')
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(pg_temp.ws(), 'document_file_binding',
    jsonb_strip_nulls(jsonb_build_object(
      'binding_id', p_doc || '|' || coalesce(p_art, '') || '|' || coalesce(p_teil, ''),
      'client_document_id', p_doc, 'client_file_ref_id', p_datei,
      'binding_kind', p_art, 'part', p_teil, 'provenance', p_herkunft, 'deleted', p_geloescht)), p_version);
$p$;

create function pg_temp.bindung_sql(p_doc text, p_datei text, p_art text, p_teil text,
  p_version bigint default 0, p_geloescht boolean default false, p_herkunft text default 'derived')
returns text language sql immutable as $p$
  select format('select pg_temp.bindung(%L, %L, %L, %L, %s, %L::boolean, %L)',
    p_doc, p_datei, p_art, p_teil, p_version, p_geloescht, p_herkunft);
$p$;

create function pg_temp.archiv(p_id text, p_version bigint default 0, p_ws uuid default null)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(coalesce(p_ws, pg_temp.ws()), 'archived_document',
    jsonb_build_object('client_document_id', p_id, 'payload', jsonb_build_object('id', p_id, 'title', p_id)), p_version);
$p$;

create function pg_temp.b(p_doc text, p_art text, p_teil text)
returns public.workspace_document_file_bindings language sql as $p$
  select * from public.workspace_document_file_bindings
  where workspace_id = pg_temp.ws() and client_document_id = p_doc and binding_kind = p_art
    and coalesce(part, '') = coalesce(p_teil, '');
$p$;

create function pg_temp.f(p_id text) returns public.workspace_files language sql as $p$
  select * from public.workspace_files where workspace_id = pg_temp.ws() and client_file_ref_id = p_id;
$p$;

/* ------------------------------------------------------------------ */
/* E -- Abgrenzung der E-Rechnungsbindungen                            */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
begin
  -- E1 Vertrag 01B: Inhaber legt structured/extracted an einem empfangenen Archivdokument an.
  perform pg_temp.als(pg_temp.inhaber());
  begin
    v := pg_temp.bindung('doc-c-inhaber', 'file-c-inh-xml', 'structured', null, 0, false, 'extracted');
  exception when others then
    raise exception 'E1 Inhaber structured/extracted am Archivdokument abgewiesen: %', sqlerrm;
  end;
  if v is null or (pg_temp.b('doc-c-inhaber', 'structured', null)).provenance <> 'extracted' then
    raise exception 'E1 Inhaber structured/extracted am Archivdokument abgewiesen oder falsch gespeichert';
  end if;

  -- E2 Mitglied am eigenen Archivdokument: normaler Eingangsweg.
  perform pg_temp.als(pg_temp.mitglied1());
  begin
    v := pg_temp.bindung('doc-c-m1', 'file-c-m1-xml', 'structured', null, 0, false, 'extracted');
  exception when others then
    raise exception 'E2 Mitglied structured/extracted am eigenen Archivdokument abgewiesen: %', sqlerrm;
  end;
  if (pg_temp.b('doc-c-m1', 'structured', null)).created_by is distinct from pg_temp.mitglied1() then
    raise exception 'E2 Mitglied structured/extracted am eigenen Archivdokument nicht angelegt';
  end if;
  perform pg_temp.zurueck();
  raise notice 'OK  E1-E2 structured/extracted an gewöhnlichen Archivdokumenten ist Eingangsweg (Inhaber und Mitglied)';
end $$;

do $$
begin
  -- E3 weiterhin E-Rechnung: selbst erzeugte structured-Fassung (derived) an einem Archivdokument.
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('E3 structured/derived am Archivdokument',
    pg_temp.bindung_sql('doc-c-inhaber', 'file-c-inh-xml', 'structured', 'xrechnung-cii'),
    'E-Rechnungen gehoeren nur an den Beleg einer Rechnung', '22023');
  -- E4 Mitglied: E-Rechnungs-Unterrolle am eigenen Archivdokument, structured/extracted am Rechnungsbeleg.
  perform pg_temp.als(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('E4a Mitglied Unterrolle am eigenen Archivdokument',
    pg_temp.bindung_sql('doc-c-m1', 'file-c-m1-xml', 'structured', 'xrechnung-cii'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('E4b Mitglied structured/extracted am Rechnungsbeleg',
    pg_temp.bindung_sql('doc-c-gen', 'file-c-m1-xml', 'structured', null, 0, false, 'extracted'),
    'Keine Schreibberechtigung', '42501');
  -- E5 Umwidmen einer Eingangsbindung zu einer selbst erzeugten Fassung: nur über alle Prüfungen.
  perform pg_temp.erwarte_abweisung('E5 Mitglied macht aus extracted ein derived',
    pg_temp.bindung_sql('doc-c-m1', 'file-c-m1-xml', 'structured', null,
      (pg_temp.b('doc-c-m1', 'structured', null)).row_version, false, 'derived'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  E3-E5 E-Rechnungen und Rechnungsbelege bleiben geschützt; Umwidmen wird geprüft';
end $$;

do $$
declare
  v_grund text;
begin
  -- E6 Einstufung: structured/extracted am Archivdokument ist keine E-Rechnung.
  select public.workspace_einvoice_binding_trust_reason(b) into v_grund
  from public.workspace_document_file_bindings b
  where b.workspace_id = pg_temp.ws() and b.client_document_id = 'doc-c-m1' and b.binding_kind = 'structured';
  if v_grund is not null then
    raise exception 'E6 Einstufung structured/extracted: % (erwartet: null)', v_grund;
  end if;

  -- E7 Fehlmarke: dieselbe Anweisung wie die Migration, auf den Testbetrieb begrenzt.
  insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, provenance, created_by, updated_by, einvoice_untrusted_at, einvoice_untrusted_reason)
  values (pg_temp.ws(), 'doc-c-alt-eingang', 'file-fehlt', 'structured', null, 'extracted', pg_temp.inhaber(), pg_temp.inhaber(), now(), 'kein_rechnungsbeleg'),
         (pg_temp.ws(), 'doc-c-alt-erzeugt', 'file-fehlt', 'structured', null, 'derived',   pg_temp.inhaber(), pg_temp.inhaber(), now(), 'kein_rechnungsbeleg'),
         (pg_temp.ws(), 'doc-c-gen',         'file-c-m1-xml', 'structured', 'xrechnung-cii', 'derived', pg_temp.mitglied1(), pg_temp.mitglied1(), now(), 'bindung_nicht_von_inhaber_oder_admin');
  update public.workspace_document_file_bindings b
  set einvoice_untrusted_at = null, einvoice_untrusted_reason = null
  where b.workspace_id = pg_temp.ws()
    and b.einvoice_untrusted_at is not null
    and b.einvoice_untrusted_reason = 'kein_rechnungsbeleg'
    and public.workspace_einvoice_binding_trust_reason(b) is null
    and lower(btrim(b.binding_kind)) = 'structured'
    and b.provenance = 'extracted'
    and not coalesce(lower(btrim(b.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
    and b.client_document_id not like 'corr-%'
    and not exists (select 1 from public.workspace_documents d
                    where d.workspace_id = b.workspace_id and d.client_document_id = b.client_document_id
                      and d.document_kind in ('generated_invoice', 'generated_invoice_correction'));
  if (pg_temp.b('doc-c-alt-eingang', 'structured', null)).einvoice_untrusted_at is not null
     or (pg_temp.b('doc-c-alt-erzeugt', 'structured', null)).einvoice_untrusted_reason is distinct from 'kein_rechnungsbeleg'
     or (pg_temp.b('doc-c-gen', 'structured', 'xrechnung-cii')).einvoice_untrusted_reason is distinct from 'bindung_nicht_von_inhaber_oder_admin' then
    raise exception 'E7 Fehlmarke: nur structured/extracted am Archivdokument verliert die Marke';
  end if;
  -- Aufraeumen (Wartung), damit die Matrix denselben freien Bindungsplatz sieht.
  delete from public.workspace_document_file_bindings
  where workspace_id = pg_temp.ws() and client_document_id in ('doc-c-alt-eingang', 'doc-c-alt-erzeugt', 'doc-c-gen');
  raise notice 'OK  E6-E7 Einstufung und Fehlmarke mit derselben Abgrenzung; andere Marken bleiben';
end $$;

/* ------------------------------------------------------------------ */
/* R1 -- kein Wiederbeleben durch Mitglieder                           */
/* ------------------------------------------------------------------ */

do $$
declare
  v_version bigint;
begin
  -- Inhaber löscht Datei und Bindung des Mitglieds (Grabstein).
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.datei('file-c-m1', repeat('a', 64), 'application/pdf', (pg_temp.f('file-c-m1')).row_version, true);
  perform pg_temp.bindung('doc-c-m1', 'file-c-m1', 'archive', null, 0, false, 'derived');
  perform pg_temp.bindung('doc-c-m1', 'file-c-m1', 'archive', null, (pg_temp.b('doc-c-m1', 'archive', null)).row_version, true, 'derived');
  if not (pg_temp.f('file-c-m1')).deleted then raise exception 'R1 Aufbau: Datei nicht gelöscht'; end if;
  -- Die Bindung gehört (wie aus dem Eingangsweg des Mitglieds) dem Mitglied (Wartung).
  perform pg_temp.zurueck();
  update public.workspace_document_file_bindings set created_by = pg_temp.mitglied1()
  where workspace_id = pg_temp.ws() and client_document_id = 'doc-c-m1' and binding_kind = 'archive';
  perform pg_temp.als(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R1a Mitglied belebt seine gelöschte Datei wieder',
    format('select pg_temp.datei(%L, %L, %L, %s, false)', 'file-c-m1', repeat('a', 64), 'application/pdf', (pg_temp.f('file-c-m1')).row_version),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('R1b Mitglied belebt seine gelöschte Bindung wieder',
    pg_temp.bindung_sql('doc-c-m1', 'file-c-m1', 'archive', null, (pg_temp.b('doc-c-m1', 'archive', null)).row_version, false, 'derived'),
    'Keine Schreibberechtigung', '42501');
  if not (pg_temp.f('file-c-m1')).deleted or not (pg_temp.b('doc-c-m1', 'archive', null)).deleted then
    raise exception 'R1 Grabsteine verändert';
  end if;
  -- Gewöhnliche Änderung der eigenen lebenden Zeile bleibt.
  perform pg_temp.datei('file-c-m1-xml', repeat('b', 64), 'text/xml', (pg_temp.f('file-c-m1-xml')).row_version, false);
  if (pg_temp.f('file-c-m1-xml')).mime_type <> 'text/xml' then raise exception 'R1c eigene Änderung nicht gespeichert'; end if;
  -- Inhaber darf wiederbeleben.
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.datei('file-c-m1', repeat('a', 64), 'application/pdf', (pg_temp.f('file-c-m1')).row_version, false);
  if (pg_temp.f('file-c-m1')).deleted then raise exception 'R1d Inhaber kann nicht wiederbeleben'; end if;
  perform pg_temp.zurueck();

  -- Jeder Schreibweg (Trigger): Eingangseintrag und Arbeitsergebnis im Namen des Mitglieds.
  insert into public.workspace_inbox_items (workspace_id, client_inbox_id, status, payload, created_by, deleted, deleted_at)
  values (pg_temp.ws(), 'inbox-c-m1', 'neu', '{}'::jsonb, pg_temp.mitglied1(), true, now());
  insert into public.workspace_document_work_results (workspace_id, client_inbox_id, source_fingerprint, analysis_version, analyzed_at, analysis, created_by, deleted, deleted_at)
  values (pg_temp.ws(), 'inbox-c-m1', 'fp', 1, now(), '{}'::jsonb, pg_temp.mitglied1(), true, now());
  perform pg_temp.im_namen(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R1e Eingangseintrag wiederbeleben (Trigger)',
    format('update public.workspace_inbox_items set deleted = false, deleted_at = null where workspace_id = %L and client_inbox_id = %L', pg_temp.ws(), 'inbox-c-m1'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('R1f Arbeitsergebnis wiederbeleben (Trigger)',
    format('update public.workspace_document_work_results set deleted = false, deleted_at = null where workspace_id = %L and client_inbox_id = %L', pg_temp.ws(), 'inbox-c-m1'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  R1 Mitglieder beleben keine Grabsteine wieder (Datei, Bindung, Eingang, Arbeitsergebnis); eigene Änderungen und Inhaber wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* R2 -- Bindungen nur an eigene oder unbekannte Dokumente             */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R2a Mitglied besetzt den Vorschauplatz am Dokument des Inhabers',
    pg_temp.bindung_sql('doc-c-inhaber', 'file-c-m1-xml', 'preview', null),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.bindung('doc-c-m1', 'file-c-m1-xml', 'preview', null);
  perform pg_temp.bindung('doc-c-neu-m1', 'file-c-m1-xml', 'original', null, 0, false, 'received');
  perform pg_temp.archiv('doc-c-neu-m1');
  if (pg_temp.b('doc-c-neu-m1', 'original', null)).id is null or (pg_temp.b('doc-c-m1', 'preview', null)).id is null then
    raise exception 'R2b eigene Bindungen (auch vor dem eigenen Dokument) nicht angelegt';
  end if;
  -- Ein zweites Mitglied bindet nicht an das Dokument des ersten.
  perform pg_temp.als(pg_temp.mitglied2());
  perform pg_temp.erwarte_abweisung('R2c zweites Mitglied an fremdem Mitgliedsdokument',
    pg_temp.bindung_sql('doc-c-m1', 'file-c-m1-xml', 'thumbnail', null),
    'Keine Schreibberechtigung', '42501');
  -- Inhaber und Admin binden überall.
  perform pg_temp.als(pg_temp.admin());
  perform pg_temp.bindung('doc-c-m1', 'file-c-inh', 'thumbnail', null);
  if (pg_temp.b('doc-c-m1', 'thumbnail', null)).id is null then raise exception 'R2d Admin bindet nicht'; end if;
  perform pg_temp.zurueck();
  -- Jeder Schreibweg (Trigger).
  perform pg_temp.im_namen(pg_temp.mitglied2());
  perform pg_temp.erwarte_abweisung('R2e Bindung an fremdem Dokument (Trigger)',
    format('insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, provenance, created_by, updated_by) values (%L, %L, %L, %L, %L, %L, %L)',
      pg_temp.ws(), 'doc-c-inhaber', 'file-c-m1', 'thumbnail', 'derived', pg_temp.mitglied2(), pg_temp.mitglied2()),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  R2 Mitglieder binden nur an eigene oder noch unbekannte Dokumente; Inhaber/Admin überall';
end $$;

/* ------------------------------------------------------------------ */
/* R3 -- corr- nur als Korrekturbeleg                                  */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('R3a Inhaber legt Archivdokument unter corr- an',
    format('select pg_temp.archiv(%L)', 'corr-inv-c-ok'),
    'Kennungen unter corr- sind dem Korrekturbeleg der Stornierung vorbehalten', '22023');
  perform pg_temp.als(pg_temp.admin());
  perform pg_temp.erwarte_abweisung('R3b Admin legt Archivdokument unter corr- an',
    format('select pg_temp.archiv(%L)', 'corr-inv-c-offen'),
    'Kennungen unter corr- sind dem Korrekturbeleg der Stornierung vorbehalten', '22023');
  perform pg_temp.als(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R3c Mitglied legt Archivdokument unter corr- an',
    format('select pg_temp.archiv(%L)', 'corr-inv-c-matrix'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  -- Der Altplatzhalter bleibt für Inhaber/Admin bearbeitbar (Aufräumen), wird aber nicht umgewidmet.
  perform pg_temp.im_namen(pg_temp.inhaber());
  update public.workspace_documents set payload = payload || '{"title":"Platzhalter (geprüft)"}'::jsonb
  where workspace_id = pg_temp.ws() and client_document_id = 'corr-inv-c-alt';
  perform pg_temp.erwarte_abweisung('R3d Archivdokument nachträglich nach corr- umbenennen',
    format('update public.workspace_documents set client_document_id = %L where workspace_id = %L and client_document_id = %L',
      'corr-inv-c-neu', pg_temp.ws(), 'doc-c-inhaber'),
    'Kennungen unter corr- sind dem Korrekturbeleg der Stornierung vorbehalten', '22023');
  -- Der Korrekturbeleg selbst entsteht wie bisher (Art generated_invoice_correction).
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
  values (pg_temp.ws(), 'corr-inv-c-korr', 'generated_invoice_correction', 'inv-c-korr', '{}'::jsonb, pg_temp.inhaber());
  perform pg_temp.zurueck();
  raise notice 'OK  R3 corr- nur als Korrekturbeleg, auch für Inhaber/Admin; Altplatzhalter bleibt bereinigbar';
end $$;

/* ------------------------------------------------------------------ */
/* R4 -- Dateiwächter zählt Bindungen unter corr- mit                  */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.mitglied2());
  perform pg_temp.erwarte_abweisung('R4 Mitglied ändert Datei hinter einer Bindung unter corr-',
    format('select pg_temp.datei(%L, %L, %L, %s, false)', 'file-c-m2-corr', repeat('f', 64), 'application/pdf', (pg_temp.f('file-c-m2-corr')).row_version),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  if (pg_temp.f('file-c-m2-corr')).mime_type <> 'application/xml' then
    raise exception 'R4 Datei verändert';
  end if;
  raise notice 'OK  R4 Datei hinter einer Bindung unter corr- bleibt für Mitglieder unveränderlich';
end $$;

/* ------------------------------------------------------------------ */
/* R5/R6 -- Versandvermerk und Leistungszeitraum                       */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('R5a Versandvermerk für intern stornierte Rechnung',
    format('select public.update_workspace_invoice_sent(%L, %L, %L, %L, null)', pg_temp.ws(), 'inv-c-intern', '2026-10-05', 'email'),
    'invoice_cancelled', '22023');
  perform public.update_workspace_invoice_sent(pg_temp.ws(), 'inv-c-korr', '2026-10-02', 'post', 'korrigiert');
  perform public.update_workspace_invoice_sent(pg_temp.ws(), 'inv-c-ok', '2026-10-05', 'email', null);
  perform pg_temp.zurueck();
  if (select invoice_status from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id = 'inv-c-intern') <> 'vorbereitet'
     or (select payload->>'sentVia' from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id = 'inv-c-korr') <> 'post'
     or (select invoice_status from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id = 'inv-c-ok') <> 'versendet' then
    raise exception 'R5 Zustände falsch';
  end if;
  raise notice 'OK  R5 kein Versandvermerk für intern stornierte Rechnungen; Korrektur der Versandangaben und normaler Vermerk wie bisher';
end $$;

do $$
begin
  -- R6 abgelaufene Lizenz und gesperrtes Konto (Admin-Rolle).
  /*
   * EINRICHTUNG-01 (E3a, Katalog V3 Z-07.1/Z-07.2) -- bewusst geaenderte Erwartung: Die eigene abgelaufene Lizenz
   * des Admins hindert nicht mehr (Waechter besteht); abgewiesen wird bei abgelaufener Betriebslizenz (Inhaber),
   * mit dem unveraenderten Code.
   */
  perform pg_temp.als(pg_temp.lizenz());
  perform public.assert_financial_action_allowed(pg_temp.ws());
  perform pg_temp.zurueck();
  update public.profiles set license_status = 'expired' where id = pg_temp.inhaber();
  perform pg_temp.als(pg_temp.lizenz());
  perform pg_temp.erwarte_abweisung('R6a Betriebslizenz abgelaufen: Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-c-offen'),
    'finance_license_expired', null);
  perform pg_temp.erwarte_abweisung('R6b Betriebslizenz abgelaufen: Versandvermerk',
    format('select public.update_workspace_invoice_sent(%L, %L, %L, %L, null)', pg_temp.ws(), 'inv-c-matrix', '2026-10-05', 'email'),
    'finance_license_expired', null);
  perform pg_temp.zurueck();
  update public.profiles set license_status = 'active' where id = pg_temp.inhaber();
  -- Gesperrtes Konto: Seit 20261109 ist es kein aktives Mitglied mehr; die Mitgliedschaftspruefung
  -- vor der Finanzpruefung weist es ab (Kontosperre im Einzelnen: account_block_enforcement_01.sql).
  perform pg_temp.als(pg_temp.gesperrt());
  perform pg_temp.erwarte_abweisung('R6c gesperrtes Konto: Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-c-offen'),
    'Kein Zugriff', null);
  perform pg_temp.erwarte_abweisung('R6d gesperrtes Konto: Versandvermerk',
    format('select public.update_workspace_invoice_sent(%L, %L, %L, %L, null)', pg_temp.ws(), 'inv-c-matrix', '2026-10-05', 'email'),
    'Kein Zugriff', null);
  -- Mitglied weiterhin 42501 (nicht die Finanzmeldung), Admin mit gültiger Lizenz wie bisher.
  perform pg_temp.als(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R6e Mitglied: Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-c-offen'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.als(pg_temp.admin());
  perform public.confirm_workspace_invoice_service_period(pg_temp.ws(), 'inv-c-offen');
  perform pg_temp.zurueck();
  if (select payload->>'servicePeriodConfirmed' from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id = 'inv-c-offen') <> 'true'
     or (select invoice_status from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id = 'inv-c-matrix') <> 'vorbereitet' then
    raise exception 'R6 Zustände falsch';
  end if;
  raise notice 'OK  R6 Versandvermerk und Leistungszeitraum prüfen Lizenz und Sperre; Mitglied 42501, Admin mit Lizenz wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* R7 -- kein Lesen eingeschränkter Speicherobjekte über den Hash      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_pfad_rest text := pg_temp.ws()::text || '/' || repeat('d', 64);
  v_pfad_inh text := pg_temp.ws()::text || '/' || repeat('c', 64);
begin
  perform pg_temp.als(pg_temp.mitglied1());
  -- Eigene Dateizeilen mit dem Hash fremder Dateien.
  perform pg_temp.datei('file-c-m1-rest', repeat('d', 64), 'application/pdf');
  perform pg_temp.datei('file-c-m1-inh', repeat('c', 64), 'application/pdf');
  if public.workspace_file_object_can_read(v_pfad_rest) then
    raise exception 'R7a Mitglied liest über den Hash ein eingeschränktes Objekt';
  end if;
  if not public.workspace_file_object_can_read(pg_temp.ws()::text || '/' || repeat('b', 64)) then
    raise exception 'R7b Mitglied liest die eigene Datei nicht';
  end if;
  perform pg_temp.als(pg_temp.inhaber());
  if not public.workspace_file_object_can_read(v_pfad_rest) or not public.workspace_file_object_can_read(v_pfad_inh) then
    raise exception 'R7c Inhaber liest nicht';
  end if;
  perform pg_temp.als(pg_temp.fremdinhaber());
  if public.workspace_file_object_can_read(v_pfad_inh) then
    raise exception 'R7d fremder Inhaber liest';
  end if;
  perform pg_temp.zurueck();
  raise notice 'OK  R7 eigene Zeile mit fremdem Hash öffnet kein eingeschränktes Objekt; Inhaber liest, Fremde nicht';
end $$;

/* ------------------------------------------------------------------ */
/* R8 -- Mitglieder ändern nur eigene Bankzeilen                       */
/* ------------------------------------------------------------------ */

do $$
declare
  v_version bigint;
  v_version_m1 bigint;
begin
  -- Versionen als Wartung lesen: Bankzeilen sieht ein Mitglied nicht (RLS nur Inhaber/Admin).
  select row_version into v_version from public.workspace_bank_accounts where workspace_id = pg_temp.ws() and client_account_id = 'bacc-c-inh';
  select row_version into v_version_m1 from public.workspace_bank_accounts where workspace_id = pg_temp.ws() and client_account_id = 'bacc-c-m1';
  perform pg_temp.als(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R8a Mitglied benennt das Konto des Inhabers um',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, %s)', pg_temp.ws(), 'bank_account',
      jsonb_build_object('account_id', 'bacc-c-inh', 'payload', jsonb_build_object('displayName', 'Gekapert', 'identifier', 'DE00INH')), v_version),
    'Keine Schreibberechtigung', '42501');
  perform public.upsert_workspace_sync_entity(pg_temp.ws(), 'bank_account',
    jsonb_build_object('account_id', 'bacc-c-m1', 'payload', jsonb_build_object('displayName', 'Mein Konto', 'identifier', 'DE00M1')), v_version_m1);
  perform public.upsert_workspace_sync_entity(pg_temp.ws(), 'bank_account',
    jsonb_build_object('account_id', 'bacc-c-m1-neu', 'payload', jsonb_build_object('displayName', 'Neues Konto', 'identifier', 'DE00M1NEU')), 0);
  perform pg_temp.zurueck();
  -- Jeder Schreibweg (Trigger): Umsatz des Inhabers im Namen des Mitglieds.
  perform pg_temp.im_namen(pg_temp.mitglied1());
  perform pg_temp.erwarte_abweisung('R8b Mitglied ändert einen Umsatz des Inhabers (Trigger)',
    format('update public.workspace_bank_transactions set payload = payload || %L::jsonb where workspace_id = %L and client_transaction_id = %L',
      '{"purpose":"gekapert"}', pg_temp.ws(), 'btx-c-inh'),
    'Keine Schreibberechtigung', '42501');
  update public.workspace_bank_transactions set payload = payload || '{"note":"eigene Notiz"}'::jsonb
  where workspace_id = pg_temp.ws() and client_transaction_id = 'btx-c-m1';
  perform pg_temp.im_namen(pg_temp.inhaber());
  update public.workspace_bank_accounts set display_name = 'Vom Inhaber geprüft'
  where workspace_id = pg_temp.ws() and client_account_id = 'bacc-c-m1';
  perform pg_temp.zurueck();
  if (select display_name from public.workspace_bank_accounts where workspace_id = pg_temp.ws() and client_account_id = 'bacc-c-inh') <> 'Konto Inhaber'
     or (select payload->>'purpose' from public.workspace_bank_transactions where workspace_id = pg_temp.ws() and client_transaction_id = 'btx-c-inh') <> 'Inhaber'
     or (select payload->>'note' from public.workspace_bank_transactions where workspace_id = pg_temp.ws() and client_transaction_id = 'btx-c-m1') <> 'eigene Notiz'
     or not exists (select 1 from public.workspace_bank_accounts where workspace_id = pg_temp.ws() and client_account_id = 'bacc-c-m1-neu') then
    raise exception 'R8 Zustände falsch';
  end if;
  raise notice 'OK  R8 Mitglieder ändern nur eigene Bankzeilen; Anlegen, eigenes Umbenennen und Inhaber wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* M -- Rollenmatrix                                                   */
/* ------------------------------------------------------------------ */

do $$
declare
  v_akteur record;
  v_ergebnis text;
  v_soll jsonb;
  v_ist jsonb := '{}'::jsonb;
  v_aktion record;
begin
  -- Jede Aktion je Akteur: 'ok' oder ein kurzes Kennzeichen der Abweisung.
  for v_akteur in
    select * from (values
      ('inhaber', pg_temp.inhaber()), ('admin', pg_temp.admin()),
      ('mitglied1', pg_temp.mitglied1()), ('mitglied2', pg_temp.mitglied2()),
      ('entfernt', pg_temp.entfernt()), ('fremdmitglied', pg_temp.fremdmitglied()),
      ('fremdinhaber', pg_temp.fremdinhaber()), ('lizenz', pg_temp.lizenz()),
      ('gesperrt', pg_temp.gesperrt()), ('anon', null::uuid)
    ) as a(name, id)
  loop
    for v_aktion in
      select * from (values
        ('lesen',       'select count(*) from public.pull_workspace_invoices(%1$L, null)'),
        ('eingang',     'select pg_temp.archiv(%2$L)'),
        ('zahlung',     'select public.add_workspace_invoice_payment(%1$L, %3$L, %4$L, 1, %5$L, null, null, %14$L)'),
        ('storno',      'select public.cancel_workspace_invoice(%1$L, %7$L, %8$L)'),
        ('versand',     'select public.update_workspace_invoice_sent(%1$L, %7$L, %5$L, %6$L, null)'),
        ('zeitraum',    'select public.confirm_workspace_invoice_service_period(%1$L, %7$L)'),
        ('erechnung',   'select pg_temp.bindung(%9$L, %10$L, %11$L, %12$L)'),
        ('loeschen',    'select public.tombstone_workspace_document(%1$L, %13$L)')
      ) as x(name, sql)
    loop
      -- Jede Aktion in einem eigenen Unterblock: Auch ein Erfolg wird mit einer
      -- gezielten Ausnahme zurueckgerollt, damit alle Akteure denselben Stand sehen.
      begin
        if v_akteur.id is null then
          perform pg_temp.als_anon();
        else
          perform pg_temp.als(v_akteur.id);
        end if;
        execute format(v_aktion.sql,
          pg_temp.ws(), 'doc-m-' || v_akteur.name, 'inv-c-matrix', 'pay-m-' || v_akteur.name, '2026-10-06', 'email',
          'inv-c-matrix', 'Matrix', 'doc-c-gen', 'file-c-inh-xml', 'structured', 'xrechnung-cii', 'doc-c-inhaber',
          'bank');
        raise exception 'MATRIX_ZUGELASSEN';
      exception when others then
        v_ergebnis := case
          when sqlerrm = 'MATRIX_ZUGELASSEN' then 'ok'
          -- Zuerst: kein EXECUTE fuer anon ("permission denied", ebenfalls SQLSTATE 42501) oder ohne Sitzung.
          when sqlerrm like '%Nicht angemeldet%' or sqlerrm like '%permission denied%' then 'nicht_angemeldet'
          when sqlstate = '42501' or sqlerrm like '%Keine Schreibberechtigung%' then 'rolle'
          when sqlerrm like '%Kein Zugriff%' then 'kein_zugriff'
          when sqlerrm like '%finance_forbidden_role%' then 'rolle'
          when sqlerrm like '%finance_license_expired%' then 'lizenz'
          when sqlerrm like '%finance_account_blocked%' then 'gesperrt'
          -- Berechtigung bestanden, fachliche Pruefung danach (z. B. Betrag, Steuerstatus):
          -- fuer die Matrix zugelassen; die Erfolgswege pruefen die Fachtests.
          else 'ok'
        end;
        if v_ergebnis = 'ok' and sqlerrm <> 'MATRIX_ZUGELASSEN' then
          raise notice '    (Matrix: % / % zugelassen, fachlich abgewiesen: %)', v_akteur.name, v_aktion.name, left(sqlerrm, 120);
        end if;
      end;
      perform pg_temp.zurueck();
      v_ist := jsonb_set(v_ist, array[v_akteur.name], coalesce(v_ist->v_akteur.name, '{}'::jsonb) || jsonb_build_object(v_aktion.name, v_ergebnis));
    end loop;
  end loop;

  /*
   * EINRICHTUNG-01 (E3a, Katalog V3 Z-07.1) -- bewusst geaenderte Erwartung fuer "lizenz": Der Admin mit eigener
   * abgelaufener Lizenz arbeitet in einem Betrieb mit wirksamer Betriebslizenz; massgeblich ist allein die Lizenz des
   * Betriebs. Die abgelaufene Betriebslizenz prueft supabase/tests/einrichtung01_ap1_zugriff.sql (N-Z1, N-Z2).
   */
  v_soll := '{
    "inhaber":       {"lesen":"ok","eingang":"ok","zahlung":"ok","storno":"ok","versand":"ok","zeitraum":"ok","erechnung":"ok","loeschen":"ok"},
    "admin":         {"lesen":"ok","eingang":"ok","zahlung":"ok","storno":"ok","versand":"ok","zeitraum":"ok","erechnung":"ok","loeschen":"ok"},
    "mitglied1":     {"lesen":"ok","eingang":"ok","zahlung":"rolle","storno":"rolle","versand":"rolle","zeitraum":"rolle","erechnung":"rolle","loeschen":"rolle"},
    "mitglied2":     {"lesen":"ok","eingang":"ok","zahlung":"rolle","storno":"rolle","versand":"rolle","zeitraum":"rolle","erechnung":"rolle","loeschen":"rolle"},
    "entfernt":      {"lesen":"kein_zugriff","eingang":"kein_zugriff","zahlung":"kein_zugriff","storno":"kein_zugriff","versand":"kein_zugriff","zeitraum":"kein_zugriff","erechnung":"kein_zugriff","loeschen":"kein_zugriff"},
    "fremdmitglied": {"lesen":"kein_zugriff","eingang":"kein_zugriff","zahlung":"kein_zugriff","storno":"kein_zugriff","versand":"kein_zugriff","zeitraum":"kein_zugriff","erechnung":"kein_zugriff","loeschen":"kein_zugriff"},
    "fremdinhaber":  {"lesen":"kein_zugriff","eingang":"kein_zugriff","zahlung":"kein_zugriff","storno":"kein_zugriff","versand":"kein_zugriff","zeitraum":"kein_zugriff","erechnung":"kein_zugriff","loeschen":"kein_zugriff"},
    "lizenz":        {"lesen":"ok","eingang":"ok","zahlung":"ok","storno":"ok","versand":"ok","zeitraum":"ok","erechnung":"ok","loeschen":"ok"},
    "gesperrt":      {"lesen":"kein_zugriff","eingang":"kein_zugriff","zahlung":"gesperrt","storno":"gesperrt","versand":"kein_zugriff","zeitraum":"kein_zugriff","erechnung":"kein_zugriff","loeschen":"kein_zugriff"},
    "anon":          {"lesen":"nicht_angemeldet","eingang":"nicht_angemeldet","zahlung":"nicht_angemeldet","storno":"nicht_angemeldet","versand":"nicht_angemeldet","zeitraum":"nicht_angemeldet","erechnung":"nicht_angemeldet","loeschen":"nicht_angemeldet"}
  }'::jsonb;

  if v_ist is distinct from v_soll then
    raise exception 'M1 Rollenmatrix weicht ab: %', (
      select jsonb_object_agg(k, jsonb_build_object('ist', v_ist->k, 'soll', v_soll->k))
      from jsonb_object_keys(v_soll) k where v_ist->k is distinct from v_soll->k);
  end if;
  raise notice 'OK  M1 Rollenmatrix: 10 Akteure x 8 Schutzaktionen wie erwartet (Kontosperre auf allen Wegen, seit 20261109; Lizenzquelle ist der Betrieb, E3a)';
end $$;

do $$
declare
  v_version bigint;
begin
  -- M2 Rechteentzug mitten im Ablauf: Mitglied 2 legt an, wird entfernt, danach nichts mehr.
  perform pg_temp.als(pg_temp.mitglied2());
  perform pg_temp.archiv('doc-m-entzug');
  perform pg_temp.zurueck();
  update public.workspace_members set status = 'removed' where workspace_id = pg_temp.ws() and user_id = pg_temp.mitglied2();
  select row_version into v_version from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-m-entzug';
  perform pg_temp.als(pg_temp.mitglied2());
  perform pg_temp.erwarte_abweisung('M2a entferntes Mitglied ändert sein Dokument',
    format('select pg_temp.archiv(%L, %s)', 'doc-m-entzug', v_version),
    'Kein Zugriff', null);
  perform pg_temp.erwarte_abweisung('M2b entferntes Mitglied liest',
    format('select count(*) from public.pull_workspace_intake_state(%L)', pg_temp.ws()), 'Kein Zugriff', null);
  perform pg_temp.zurueck();
  -- M3 Herabstufung Admin -> Mitglied: E-Rechnungsbindung danach 42501.
  update public.workspace_members set role = 'member' where workspace_id = pg_temp.ws() and user_id = pg_temp.admin();
  perform pg_temp.als(pg_temp.admin());
  perform pg_temp.erwarte_abweisung('M3 herabgestufter Admin legt E-Rechnung ab',
    pg_temp.bindung_sql('doc-c-gen', 'file-c-inh-xml', 'structured', 'xrechnung-cii'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  update public.workspace_members set role = 'admin' where workspace_id = pg_temp.ws() and user_id = pg_temp.admin();
  raise notice 'OK  M2-M3 Rechteentzug und Herabstufung wirken sofort, auch mitten im Ablauf';
end $$;

/* ------------------------------------------------------------------ */
/* G -- Rechte und Trigger                                             */
/* ------------------------------------------------------------------ */

do $$
declare
  v_fn text;
  v_rolle text;
begin
  foreach v_fn in array array[
    'public.workspace_member_revive_guard()',
    'public.workspace_binding_document_owner_guard()',
    'public.workspace_bank_member_own_row_guard()',
    'public.workspace_invoice_document_identity_guard()',
    'public.workspace_einvoice_binding_write_guard()',
    'public.workspace_einvoice_file_write_guard()',
    'public.workspace_einvoice_binding_trust_reason(public.workspace_document_file_bindings)']
  loop
    foreach v_rolle in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_rolle, v_fn, 'execute') then
        raise exception 'G1 % hat EXECUTE auf %', v_rolle, v_fn;
      end if;
    end loop;
  end loop;
  if not has_function_privilege('authenticated', 'public.workspace_file_object_can_read(text)', 'execute') then
    raise exception 'G2 Speicher-Lesepolicy fuer authenticated nicht ausfuehrbar';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D' and tgname in (
        'workspace_files_member_revive_guard', 'workspace_document_file_bindings_member_revive_guard',
        'workspace_inbox_items_member_revive_guard', 'workspace_document_work_results_member_revive_guard',
        'workspace_document_file_bindings_document_owner_guard',
        'workspace_bank_accounts_member_own_row_guard', 'workspace_bank_transactions_member_own_row_guard')) <> 7 then
    raise exception 'G3 neue Trigger fehlen oder sind abgeschaltet';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('workspace_member_revive_guard', 'workspace_binding_document_owner_guard', 'workspace_bank_member_own_row_guard')
               and not p.prosecdef) then
    raise exception 'G4 neue Wächter nicht security definer';
  end if;
  raise notice 'OK  G1-G4 Wächter für niemanden direkt aufrufbar, security definer, Trigger aktiv; Lesepolicy aufrufbar';
end $$;

rollback;
