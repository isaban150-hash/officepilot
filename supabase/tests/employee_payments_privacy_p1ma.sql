-- P1 MITARBEITERZAHLUNGEN -- Datenschutz der Belege (Laufzeittest mit echter RLS).
--
--   1  Inhaber und Admin lesen Quittung und Nachweis auf allen Wegen
--   2  Mitglied liest sie nicht
--   3  herabgestufter früherer Admin liest sie nicht — auch nicht die selbst
--      erzeugte Quittung, auch nicht vor der Verknüpfung
--   4  ursprünglicher Mitglieds-Uploader liest den verknüpften Nachweis nicht mehr
--   5  stornierte Zahlung bleibt geschützt
--   6  direkter Tabellenzugriff verweigert (Dokument, Datei, Zuordnung, Eingang,
--      Analyse, Papierregister, Kommunikation, Versand, Schutztabelle)
--   7  Cloud-Pull (Eingangs- und generischer Abzug) liefert nichts davon
--   8  Dateispeicher und Versandkopien verweigert
--   9  normale Dokumente bleiben unverändert lesbar und schreibbar
--  10  die alten Löschschutzregeln für Zahlungsnachweise bleiben erhalten
--   +  RPC-Wege: Schreiben, Wiederholung, Löschen, Versandlisten, Versanddienst
--      ohne Anmeldung; Zustand vor der Verknüpfung; Nachweiswechsel;
--      Quittungskennung und Dokumentart
--
-- Jede Prüfung läuft als Rolle `authenticated` mit den Claims des Nutzers —
-- RLS greift wie bei einem echten Client. Jede Sicht wird für Inhaber und
-- Mitglied mit derselben Abfrage erhoben; eine Abfrage, die nichts trifft,
-- fiele beim Inhaber auf.
--
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/employee_payments_privacy_p1ma.sql
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
  ('00000000-0000-0000-0000-0000000e2001'::uuid, 'inhaber-p1ma-ds@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2002'::uuid, 'admin-alt-p1ma-ds@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2003'::uuid, 'mitglied-p1ma-ds@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2004'::uuid, 'mitglied2-p1ma-ds@example.invalid'),
  ('00000000-0000-0000-0000-0000000e2005'::uuid, 'admin-p1ma-ds@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-0000000e2001'::uuid, '00000000-0000-0000-0000-0000000e2002'::uuid,
             '00000000-0000-0000-0000-0000000e2003'::uuid, '00000000-0000-0000-0000-0000000e2004'::uuid,
             '00000000-0000-0000-0000-0000000e2005'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e2a01'::uuid, 'P1MA Datenschutz', '00000000-0000-0000-0000-0000000e2001'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e2a01'::uuid, '00000000-0000-0000-0000-0000000e2001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e2a01'::uuid, '00000000-0000-0000-0000-0000000e2002'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e2a01'::uuid, '00000000-0000-0000-0000-0000000e2003'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e2a01'::uuid, '00000000-0000-0000-0000-0000000e2004'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e2a01'::uuid, '00000000-0000-0000-0000-0000000e2005'::uuid, 'admin',  'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2a01'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2001'::uuid $p$;
create function pg_temp.admin_alt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2002'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2003'::uuid $p$;
create function pg_temp.mitglied2() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2004'::uuid $p$;
create function pg_temp.admin() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e2005'::uuid $p$;

/** Speicherpfade: workspace-files ist <workspace>/<sha>, Versandkopien <workspace>/<teil>/<sha>.pdf. */
create function pg_temp.sha(p_ziffer text) returns text language sql immutable as $p$ select repeat(p_ziffer, 64) $p$;
create function pg_temp.pfad(p_ziffer text) returns text language sql immutable as $p$
  select pg_temp.ws()::text || '/' || pg_temp.sha(p_ziffer)
$p$;
create function pg_temp.kopie(p_teil text, p_ziffer text) returns text language sql immutable as $p$
  select pg_temp.ws()::text || '/' || p_teil || '/' || pg_temp.sha(p_ziffer) || '.pdf'
$p$;

/** Als dieser Nutzer — Rolle authenticated, damit RLS greift wie bei einem Client. */
create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

/** Ohne Anmeldung — Rolle anon, wie ein Aufruf nur mit dem öffentlichen Schlüssel. */
create function pg_temp.als_anon() returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end;
$p$;

/** Zurück zu postgres — Aufbau und Rohdaten. */
create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

/** Erwartet eine Abweisung mit genau diesem Text. */
create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_text text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.eingang(p_typ text, p_payload jsonb, p_version bigint default 0)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(pg_temp.ws(), p_typ, p_payload, p_version);
$p$;

create function pg_temp.sync(p_typ text, p_payload jsonb, p_version bigint default 0)
returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(pg_temp.ws(), p_typ, p_payload, p_version);
$p$;

create function pg_temp.ordner(p_pfad text) returns jsonb language sql immutable as $p$
  select jsonb_build_object('id', 'ordner', 'name', 'Ordner', 'path', p_pfad);
$p$;

create function pg_temp.dokument_payload(p_dokument text, p_titel text, p_ordner text)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('client_document_id', p_dokument,
    'payload', jsonb_build_object('id', p_dokument, 'title', p_titel, 'digitalFolder', pg_temp.ordner(p_ordner)));
$p$;

create function pg_temp.eingang_payload(p_eingang text, p_datei text, p_dokument text, p_ordner text)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('client_inbox_id', p_eingang, 'status', 'abgelegt',
    'client_file_ref_id', p_datei, 'archive_document_id', p_dokument,
    'payload', jsonb_build_object('id', p_eingang, 'digitalFolder', pg_temp.ordner(p_ordner)));
$p$;

create function pg_temp.analyse_payload(p_eingang text, p_text text)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('client_inbox_id', p_eingang, 'source_fingerprint', 'fp-' || p_eingang,
    'analysis_version', 'v1', 'analyzed_at', '2026-10-07T10:00:00Z',
    'analysis', jsonb_build_object('summary', p_text));
$p$;

create function pg_temp.zuordnung_payload(p_dokument text, p_datei text, p_art text default 'original')
returns jsonb language sql immutable as $p$
  select jsonb_build_object('binding_id', 'bind-' || p_dokument || '-' || p_art,
    'client_document_id', p_dokument, 'client_file_ref_id', p_datei,
    'binding_kind', p_art, 'provenance', case when p_art = 'original' then 'received' else 'derived' end);
$p$;

create function pg_temp.papier_payload(p_eintrag text, p_dokument text, p_titel text)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('entry_id', p_eintrag, 'document_id', p_dokument,
    'payload', jsonb_build_object('documentId', p_dokument, 'physicalFiled', true,
      'folderId', 'ordner-1', 'register', 'A', 'documentTitle', p_titel));
$p$;

create function pg_temp.ereignis_payload(p_id text, p_art text, p_kontext text)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('event_id', p_id, 'context_type', p_art, 'context_id', p_kontext,
    'event_type', 'document_received', 'event_at', '2026-10-07T10:00:00Z',
    'payload', jsonb_build_object('id', p_id, 'type', 'document_received', 'summary', 'Beleg eingegangen'));
$p$;

/** Datei, optional Eingang + Analyse, Dokument, Zuordnung — als aktueller Nutzer, über die echten RPCs. */
create function pg_temp.beleg(
  p_dokument text, p_datei text, p_ziffer text, p_ordner text, p_eingang text default null, p_titel text default 'Beleg'
) returns void language plpgsql as $p$
begin
  perform pg_temp.eingang('document_file', jsonb_build_object(
    'client_file_ref_id', p_datei, 'content_sha256', pg_temp.sha(p_ziffer), 'size_bytes', 1000,
    'mime_type', 'application/pdf', 'original_file_name', p_datei || '.pdf'));
  if p_eingang is not null then
    perform pg_temp.eingang('inbox_item', pg_temp.eingang_payload(p_eingang, p_datei, p_dokument, p_ordner));
    perform pg_temp.eingang('document_work_result', pg_temp.analyse_payload(p_eingang, p_titel));
  end if;
  perform pg_temp.eingang('archived_document', pg_temp.dokument_payload(p_dokument, p_titel, p_ordner));
  perform pg_temp.eingang('document_file_binding', pg_temp.zuordnung_payload(p_dokument, p_datei));
end;
$p$;

/**
 * Was der aktuelle Nutzer von einem Beleg sieht — jeder Leseweg einzeln:
 * Tabellen direkt (RLS), Eingangs-Abzug, generischer Abzug, Dateispeicher.
 */
create function pg_temp.sicht(p_dokument text, p_datei text, p_eingang text, p_pfad text)
returns jsonb language plpgsql as $p$
declare
  v_ws constant uuid := pg_temp.ws();
  v_e jsonb := public.pull_workspace_intake_state(pg_temp.ws());
  v_s jsonb := public.pull_workspace_sync_state(pg_temp.ws());
begin
  return jsonb_build_object(
    'dokument', (select count(*) from public.workspace_documents
                 where workspace_id = v_ws and client_document_id = p_dokument),
    'datei', (select count(*) from public.workspace_files
              where workspace_id = v_ws and client_file_ref_id = p_datei),
    'zuordnung', (select count(*) from public.workspace_document_file_bindings
                  where workspace_id = v_ws and (client_document_id = p_dokument or client_file_ref_id = p_datei)),
    'eingang', (select count(*) from public.workspace_inbox_items
                where workspace_id = v_ws and client_inbox_id = p_eingang),
    'analyse', (select count(*) from public.workspace_document_work_results
                where workspace_id = v_ws and client_inbox_id = p_eingang),
    'papier', (select count(*) from public.workspace_paper_register_entries
               where workspace_id = v_ws and client_document_id = p_dokument),
    'kommunikation', (select count(*) from public.workspace_communication_events
                      where workspace_id = v_ws
                        and ((context_type = 'document' and context_id = p_dokument)
                          or (context_type = 'inbox' and context_id = p_eingang))),
    'versand', (select count(*) from public.workspace_document_deliveries
                where workspace_id = v_ws and linked_document_id = p_dokument),
    'speicher', (select count(*) from storage.objects where bucket_id = 'workspace-files' and name = p_pfad),
    'speicher_lesbar', public.workspace_file_object_can_read(p_pfad),
    'abzug_dokument', exists (select 1 from jsonb_array_elements(v_e -> 'archived_documents') e
                              where e ->> 'client_document_id' = p_dokument),
    'abzug_datei', exists (select 1 from jsonb_array_elements(v_e -> 'files') e
                           where e ->> 'client_file_ref_id' = p_datei),
    'abzug_zuordnung', exists (select 1 from jsonb_array_elements(v_e -> 'bindings') e
                               where e ->> 'client_document_id' = p_dokument or e ->> 'client_file_ref_id' = p_datei),
    'abzug_eingang', exists (select 1 from jsonb_array_elements(v_e -> 'inbox_items') e
                             where e ->> 'client_inbox_id' = p_eingang),
    'abzug_analyse', exists (select 1 from jsonb_array_elements(v_e -> 'work_results') e
                             where e ->> 'client_inbox_id' = p_eingang),
    'abzug_papier', exists (select 1 from jsonb_array_elements(v_s -> 'paper_register_entries') e
                            where e ->> 'client_document_id' = p_dokument),
    'abzug_kommunikation', exists (select 1 from jsonb_array_elements(v_s -> 'communication_events') e
                                   where (e ->> 'context_type' = 'document' and e ->> 'context_id' = p_dokument)
                                      or (e ->> 'context_type' = 'inbox' and e ->> 'context_id' = p_eingang))
  );
end;
$p$;

/** Keine Spur auf keinem Leseweg. */
create function pg_temp.nichts() returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'dokument', 0, 'datei', 0, 'zuordnung', 0, 'eingang', 0, 'analyse', 0, 'papier', 0,
    'kommunikation', 0, 'versand', 0, 'speicher', 0, 'speicher_lesbar', false,
    'abzug_dokument', false, 'abzug_datei', false, 'abzug_zuordnung', false, 'abzug_eingang', false,
    'abzug_analyse', false, 'abzug_papier', false, 'abzug_kommunikation', false);
$p$;

/** Vergleicht jeden Leseweg einzeln und nennt den abweichenden. */
create function pg_temp.erwarte_sicht(p_label text, p_ist jsonb, p_soll jsonb)
returns void language plpgsql as $p$
declare
  k text;
begin
  for k in select jsonb_object_keys(p_soll) loop
    if (p_ist -> k) is distinct from (p_soll -> k) then
      raise exception '% -- Leseweg %: ist %, erwartet %', p_label, k, p_ist -> k, p_soll -> k;
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(p_ist)) <> (select count(*) from jsonb_object_keys(p_soll)) then
    raise exception '% -- Lesewege unvollständig: %', p_label, p_ist;
  end if;
end;
$p$;

/** Versandzeilen über alle Listen und die Versandkopien im Speicher. */
create function pg_temp.versand() returns jsonb language plpgsql as $p$
declare
  v_ws constant uuid := pg_temp.ws();
begin
  return jsonb_build_object(
    'je_dokument_quittung', (select count(*) from public.list_workspace_document_deliveries_for_document(v_ws, 'emp-receipt-pay-1')),
    'je_dokument_normal', (select count(*) from public.list_workspace_document_deliveries_for_document(v_ws, 'doc-mitglied-normal')),
    'mehrere', (select coalesce(jsonb_agg(d.client_delivery_id order by d.client_delivery_id), '[]'::jsonb)
                from public.list_workspace_document_deliveries_for_documents(
                  v_ws, array[]::text[], array['emp-receipt-pay-1', 'doc-mitglied-normal']) d),
    'kontext', (select coalesce(jsonb_agg(d.client_delivery_id order by d.client_delivery_id), '[]'::jsonb)
                from public.list_workspace_document_deliveries_for_context(v_ws, 'kunde-1', null) d),
    'rechnung', (select coalesce(jsonb_agg(d.client_delivery_id order by d.client_delivery_id), '[]'::jsonb)
                 from public.list_workspace_document_deliveries(v_ws, null, 'inv-liste') d),
    'kopie_quittung', (select count(*) from storage.objects
                       where bucket_id = 'document-deliveries' and name = pg_temp.kopie('quittung', 'd')),
    'kopie_normal', (select count(*) from storage.objects
                     where bucket_id = 'document-deliveries' and name = pg_temp.kopie('normal', 'e')),
    'kopie_ohne_zeile', (select count(*) from storage.objects
                         where bucket_id = 'document-deliveries' and name = pg_temp.kopie('abgebrochen', 'f'))
  );
end;
$p$;

/* Rechnungsdokument (für alle Mitglieder lesbar) und die Belege der alten Zahlungsnachweise. */
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values (pg_temp.ws(), 'doc-rechnung-g', 'generated_invoice', 'inv-g', '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-ausgabe-nachweis', 'archived_document', null,
        jsonb_build_object('title', 'Tankbeleg', 'digitalFolder', pg_temp.ordner('/Tankbelege/2026/10/')), pg_temp.mitglied()),
       (pg_temp.ws(), 'doc-rechnung-nachweis', 'archived_document', null,
        jsonb_build_object('title', 'Kontoauszug', 'digitalFolder', pg_temp.ordner('/Bank/2026/')), pg_temp.inhaber());

insert into public.workspace_expense_payments (workspace_id, client_expense_id, client_payment_id, amount, paid_on, method, proof_document_id)
values (pg_temp.ws(), 'exp-1', 'exp-pay-1', 10.00, '2026-10-01', 'cash', 'doc-ausgabe-nachweis');
insert into public.workspace_invoice_payments (workspace_id, client_invoice_id, client_payment_id, amount, paid_on, method, proof_document_id)
values (pg_temp.ws(), 'inv-1', 'inv-pay-1', 20.00, '2026-10-01', 'bank', 'doc-rechnung-nachweis');

/* ------------------------------------------------------------------ */
/* A -- Vor der Verknüpfung: der Admin erzeugt Quittung und Nachweis   */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.admin_alt());

  -- Die erzeugte Quittung: feste Kennung, Original und abgeleitete Vorschau.
  perform pg_temp.beleg('emp-receipt-pay-1', 'file-quittung-1', '1', '/Mitarbeiter/Zahlungsnachweise/2026/',
                        null, 'Auszahlungsquittung Max Mustermann');
  perform pg_temp.eingang('document_file', jsonb_build_object(
    'client_file_ref_id', 'file-quittung-1-vorschau', 'content_sha256', pg_temp.sha('2'), 'size_bytes', 500,
    'mime_type', 'image/png', 'original_file_name', 'vorschau.png',
    'derived_from_client_file_ref_id', 'file-quittung-1'));
  perform pg_temp.eingang('document_file_binding',
    pg_temp.zuordnung_payload('emp-receipt-pay-1', 'file-quittung-1-vorschau', 'preview'));
  perform pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-quittung', 'emp-receipt-pay-1', 'Auszahlungsquittung Max Mustermann'));
  perform pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-quittung', 'document', 'emp-receipt-pay-1'));

  -- Ein unterschriebener Nachweis im Personalordner, noch nicht verknüpft.
  perform pg_temp.beleg('doc-nachweis-ordner', 'file-nachweis-ordner', '3', '/Mitarbeiter/Zahlungsnachweise/2026/',
                        'inbox-nachweis-ordner', 'Nachweis unterschrieben');

  -- Ein gewöhnliches eigenes Dokument.
  perform pg_temp.beleg('doc-admin-normal', 'file-admin-normal', '4', '/Eingang/Sonstiges/2026/');

  perform pg_temp.zurueck();
end $$;

/* ------------------------------------------------------------------ */
/* B -- Mitglied lädt hoch: späterer Nachweis und normale Dokumente     */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
begin
  perform pg_temp.als(pg_temp.mitglied());

  perform pg_temp.beleg('doc-mitglied-scan', 'file-mitglied-scan', '5', '/Mitarbeiter/Lohnunterlagen/2026/',
                        'inbox-mitglied-scan', 'Quittung unterschrieben');
  perform pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-mitglied-scan', 'doc-mitglied-scan', 'Quittung unterschrieben'));
  perform pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-mitglied-inbox', 'inbox', 'inbox-mitglied-scan'));
  perform pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-mitglied-dokument', 'document', 'doc-mitglied-scan'));

  perform pg_temp.beleg('doc-mitglied-zweit', 'file-mitglied-zweit', '6', '/Mitarbeiter/Lohnunterlagen/2026/',
                        null, 'Zweiter Scan');

  perform pg_temp.beleg('doc-mitglied-normal', 'file-mitglied-normal', '7', '/Eingang/Sonstiges/2026/',
                        'inbox-mitglied-normal', 'Baumarkt');
  perform pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-mitglied-normal', 'doc-mitglied-normal', 'Baumarkt'));
  perform pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-mitglied-normal', 'document', 'doc-mitglied-normal'));

  -- Vor der Verknüpfung ist der Scan ein gewöhnliches eigenes Dokument.
  perform pg_temp.erwarte_sicht('B1 Uploader vor der Verknüpfung',
    pg_temp.sicht('doc-mitglied-scan', 'file-mitglied-scan', 'inbox-mitglied-scan', pg_temp.pfad('5')),
    pg_temp.nichts() || jsonb_build_object(
      'dokument', 1, 'datei', 1, 'zuordnung', 1, 'eingang', 1, 'analyse', 1, 'papier', 1, 'kommunikation', 2,
      'speicher', 0, 'speicher_lesbar', true,
      'abzug_dokument', true, 'abzug_datei', true, 'abzug_zuordnung', true, 'abzug_eingang', true,
      'abzug_analyse', true, 'abzug_papier', true, 'abzug_kommunikation', true));

  -- Die Wiederholungswege bestehen (sonst prüfte C nichts).
  v := pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-mitglied-scan', 'doc-mitglied-scan', 'Quittung unterschrieben'));
  if not coalesce((v ->> 'replayed')::boolean, false) then raise exception 'B2 Papier-Wiederholung: %', v; end if;
  v := pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-mitglied-inbox', 'inbox', 'inbox-mitglied-scan'));
  if not coalesce((v ->> 'replayed')::boolean, false) then raise exception 'B3 Ereignis-Wiederholung: %', v; end if;

  perform pg_temp.zurueck();
end $$;

/* Speicherobjekte und Versandzeilen, wie sie Upload und Versand hinterlassen. */
insert into storage.objects (bucket_id, name)
select 'workspace-files', pg_temp.pfad(z) from unnest(array['1', '2', '3', '4', '5', '6', '7']) z;
insert into storage.objects (bucket_id, name)
values ('document-deliveries', pg_temp.kopie('quittung', 'd')),
       ('document-deliveries', pg_temp.kopie('normal', 'e')),
       ('document-deliveries', pg_temp.kopie('abgebrochen', 'f'));

insert into public.workspace_document_deliveries (
  workspace_id, client_delivery_id, document_kind, linked_invoice_id, linked_document_id, customer_id,
  recipient_email, subject, body_text, provider, status, requested_by,
  attachment_storage_path, attachment_sha256, attachment_size_bytes, attachment_filename, attachment_mime_type)
values (pg_temp.ws(), 'dlv-quittung', 'other', 'inv-liste', 'emp-receipt-pay-1', 'kunde-1',
        'max@example.invalid', 'Ihre Auszahlungsquittung', 'Quittung über 350,00 EUR', 'stub', 'queued', pg_temp.inhaber(),
        pg_temp.kopie('quittung', 'd'), pg_temp.sha('d'), 1000, 'Quittung.pdf', 'application/pdf'),
       (pg_temp.ws(), 'dlv-normal', 'other', 'inv-liste', 'doc-mitglied-normal', 'kunde-1',
        'kunde@example.invalid', 'Unterlagen', 'Anbei', 'stub', 'queued', pg_temp.inhaber(),
        pg_temp.kopie('normal', 'e'), pg_temp.sha('e'), 1000, 'Unterlagen.pdf', 'application/pdf');

/* ------------------------------------------------------------------ */
/* C -- Zustand vor der Verknüpfung: herabgestufter Admin               */
/* ------------------------------------------------------------------ */

update public.workspace_members set role = 'member'
where workspace_id = pg_temp.ws() and user_id = pg_temp.admin_alt();

do $$
declare
  v jsonb;
begin
  perform pg_temp.als(pg_temp.admin_alt());

  -- C1 Quittung: feste Kennung — geschützt ab der ersten Zeile, vor jeder Verknüpfung.
  perform pg_temp.erwarte_sicht('C1 herabgestuft, Quittung vor Verknüpfung',
    pg_temp.sicht('emp-receipt-pay-1', 'file-quittung-1', '', pg_temp.pfad('1')), pg_temp.nichts());
  perform pg_temp.erwarte_sicht('C2 herabgestuft, abgeleitete Vorschau',
    pg_temp.sicht('emp-receipt-pay-1', 'file-quittung-1-vorschau', '', pg_temp.pfad('2')), pg_temp.nichts());
  -- C3 Nachweis im Personalordner: geschützt, bevor er verknüpft ist.
  perform pg_temp.erwarte_sicht('C3 herabgestuft, Nachweis im Personalordner',
    pg_temp.sicht('doc-nachweis-ordner', 'file-nachweis-ordner', 'inbox-nachweis-ordner', pg_temp.pfad('3')),
    pg_temp.nichts());
  -- C4 Das eigene gewöhnliche Dokument bleibt lesbar (Regel „selbst angelegt" unverändert).
  perform pg_temp.erwarte_sicht('C4 herabgestuft, eigenes normales Dokument',
    pg_temp.sicht('doc-admin-normal', 'file-admin-normal', '', pg_temp.pfad('4')),
    pg_temp.nichts() || jsonb_build_object('dokument', 1, 'datei', 1, 'zuordnung', 1, 'speicher', 1,
      'speicher_lesbar', true, 'abzug_dokument', true, 'abzug_datei', true, 'abzug_zuordnung', true));

  -- C5 Schreiben: keine Zeile eines geschützten Belegs, auch keine neue.
  perform pg_temp.erwarte_fehler('C5 Quittung ändern',
    $q$select pg_temp.eingang('archived_document', pg_temp.dokument_payload('emp-receipt-pay-1', 'X', '/Eingang/'), 1)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('C6 neue Quittung anlegen',
    $q$select pg_temp.eingang('archived_document', pg_temp.dokument_payload('emp-receipt-pay-9', 'X', '/Eingang/'))$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('C7 Dokument in den Personalordner legen',
    $q$select pg_temp.eingang('archived_document', pg_temp.dokument_payload('doc-neu-im-ordner', 'X', '/Mitarbeiter/Zahlungsnachweise/2026/'))$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('C8 Papier-Wiederholung der Quittung',
    $q$select pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-quittung', 'emp-receipt-pay-1', 'Auszahlungsquittung Max Mustermann'))$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('C9 Ereignis-Wiederholung der Quittung',
    $q$select pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-quittung', 'document', 'emp-receipt-pay-1'))$q$,
    'Keine Schreibberechtigung');
  -- C10 Das eigene gewöhnliche Dokument bleibt schreibbar.
  v := pg_temp.eingang('archived_document', pg_temp.dokument_payload('doc-admin-normal', 'Neu', '/Eingang/Sonstiges/2026/'), 1);
  if (v ->> 'row_version')::bigint <> 2 then raise exception 'C10 normales Dokument schreiben: %', v; end if;

  perform pg_temp.zurueck();
end $$;

/* ------------------------------------------------------------------ */
/* D -- Verknüpfen (Inhaber)                                           */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
begin
  perform pg_temp.als(pg_temp.inhaber());

  perform public.upsert_workspace_employee(pg_temp.ws(),
    jsonb_build_object('client_employee_id', 'emp-1', 'name', 'Max Mustermann', 'personnel_number', 'P-001', 'active', true), 0);
  perform public.add_workspace_employee_payment(pg_temp.ws(), 'pay-1', 'emp-1', 'Max Mustermann', 'P-001', 'wage', 350.00,
    '2026-10-07', 'cash', '2026-09', 'Lohn September', null, 'MZ-20261007-DATENSC1', 'Inhaber');
  perform public.add_workspace_employee_payment(pg_temp.ws(), 'pay-2', 'emp-1', 'Max Mustermann', 'P-001', 'advance', 200.00,
    '2026-10-07', 'cash', null, 'Vorschuss', null, 'MZ-20261007-DATENSC2', 'Inhaber');

  -- D1 Die Quittung trägt die feste Kennung der Zahlung, sonst keine Verknüpfung.
  perform pg_temp.erwarte_fehler('D1 fremde Kennung als Quittung',
    format('select public.set_workspace_employee_payment_receipt(%L, ''pay-2'', ''doc-mitglied-normal'')', pg_temp.ws()),
    'employee_payment_receipt_invalid');
  -- D2 Nur Archivdokumente — kein Rechnungsdokument.
  perform pg_temp.erwarte_fehler('D2 Rechnungsdokument als Nachweis',
    format('select public.set_workspace_employee_payment_proof(%L, ''pay-2'', ''doc-rechnung-g'')', pg_temp.ws()),
    'employee_payment_document_kind');

  v := public.set_workspace_employee_payment_receipt(pg_temp.ws(), 'pay-1', 'emp-receipt-pay-1');
  if v ->> 'receipt_document_id' <> 'emp-receipt-pay-1' then raise exception 'D3 Quittung: %', v; end if;
  v := public.set_workspace_employee_payment_proof(pg_temp.ws(), 'pay-1', 'doc-mitglied-scan');
  if v ->> 'proof_document_id' <> 'doc-mitglied-scan' then raise exception 'D4 Nachweis: %', v; end if;
  v := public.set_workspace_employee_payment_proof(pg_temp.ws(), 'pay-2', 'doc-mitglied-zweit');
  if v ->> 'proof_document_id' <> 'doc-mitglied-zweit' then raise exception 'D5 Nachweis 2: %', v; end if;

  perform pg_temp.zurueck();

  -- D6 Im selben Schritt dauerhaft geschützt — keine Zwischenphase.
  if (select count(*) from public.workspace_restricted_documents where workspace_id = pg_temp.ws()) <> 3
     or not exists (select 1 from public.workspace_restricted_documents where workspace_id = pg_temp.ws()
                    and client_document_id = 'doc-mitglied-scan' and reason = 'employee_payment_proof')
     or not exists (select 1 from public.workspace_restricted_documents where workspace_id = pg_temp.ws()
                    and client_document_id = 'emp-receipt-pay-1' and reason = 'employee_payment_receipt') then
    raise exception 'D6 Schutzeinträge fehlen: %',
      (select jsonb_agg(to_jsonb(r)) from public.workspace_restricted_documents r where r.workspace_id = pg_temp.ws());
  end if;
  -- D7 Die abgewiesenen Versuche haben nichts geschützt.
  if exists (select 1 from public.workspace_restricted_documents
             where workspace_id = pg_temp.ws() and client_document_id in ('doc-mitglied-normal', 'doc-rechnung-g')) then
    raise exception 'D7 abgewiesene Verknüpfung hat einen Schutzeintrag hinterlassen';
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* E -- Nach der Verknüpfung: wer sieht was (Tests 1, 2, 3, 4, 6, 7, 8) */
/* ------------------------------------------------------------------ */

do $$
declare
  v_quittung_voll constant jsonb := pg_temp.nichts() || jsonb_build_object(
    'dokument', 1, 'datei', 1, 'zuordnung', 2, 'papier', 1, 'kommunikation', 1, 'versand', 1,
    'speicher', 1, 'speicher_lesbar', true, 'abzug_dokument', true, 'abzug_datei', true,
    'abzug_zuordnung', true, 'abzug_papier', true, 'abzug_kommunikation', true);
  v_nachweis_voll constant jsonb := pg_temp.nichts() || jsonb_build_object(
    'dokument', 1, 'datei', 1, 'zuordnung', 1, 'eingang', 1, 'analyse', 1, 'papier', 1, 'kommunikation', 2,
    'speicher', 1, 'speicher_lesbar', true, 'abzug_dokument', true, 'abzug_datei', true,
    'abzug_zuordnung', true, 'abzug_eingang', true, 'abzug_analyse', true, 'abzug_papier', true,
    'abzug_kommunikation', true);
  v_versand_alle constant jsonb := jsonb_build_object(
    'je_dokument_quittung', 1, 'je_dokument_normal', 1,
    'mehrere', jsonb_build_array('dlv-normal', 'dlv-quittung'),
    'kontext', jsonb_build_array('dlv-normal', 'dlv-quittung'),
    'rechnung', jsonb_build_array('dlv-normal', 'dlv-quittung'),
    'kopie_quittung', 1, 'kopie_normal', 1, 'kopie_ohne_zeile', 1);
  v_versand_mitglied constant jsonb := jsonb_build_object(
    'je_dokument_quittung', 0, 'je_dokument_normal', 1,
    'mehrere', jsonb_build_array('dlv-normal'),
    'kontext', jsonb_build_array('dlv-normal'),
    'rechnung', jsonb_build_array('dlv-normal'),
    'kopie_quittung', 0, 'kopie_normal', 1, 'kopie_ohne_zeile', 0);
  v_wer uuid;
begin
  -- 1 Inhaber und Admin: alles, auf jedem Weg.
  foreach v_wer in array array[pg_temp.inhaber(), pg_temp.admin()] loop
    perform pg_temp.als(v_wer);
    perform pg_temp.erwarte_sicht('E1 Inhaber/Admin Quittung',
      pg_temp.sicht('emp-receipt-pay-1', 'file-quittung-1', '', pg_temp.pfad('1')), v_quittung_voll);
    perform pg_temp.erwarte_sicht('E1 Inhaber/Admin Nachweis',
      pg_temp.sicht('doc-mitglied-scan', 'file-mitglied-scan', 'inbox-mitglied-scan', pg_temp.pfad('5')), v_nachweis_voll);
    perform pg_temp.erwarte_sicht('E1 Inhaber/Admin Versand', pg_temp.versand(), v_versand_alle);
    perform pg_temp.zurueck();
  end loop;

  -- 2, 3, 4: Mitglied, herabgestufter Admin, Mitglieds-Uploader — nichts.
  foreach v_wer in array array[pg_temp.mitglied2(), pg_temp.admin_alt(), pg_temp.mitglied()] loop
    perform pg_temp.als(v_wer);
    perform pg_temp.erwarte_sicht('E2 Quittung für ' || v_wer,
      pg_temp.sicht('emp-receipt-pay-1', 'file-quittung-1', '', pg_temp.pfad('1')), pg_temp.nichts());
    perform pg_temp.erwarte_sicht('E2 Vorschau für ' || v_wer,
      pg_temp.sicht('emp-receipt-pay-1', 'file-quittung-1-vorschau', '', pg_temp.pfad('2')), pg_temp.nichts());
    perform pg_temp.erwarte_sicht('E2 Nachweis für ' || v_wer,
      pg_temp.sicht('doc-mitglied-scan', 'file-mitglied-scan', 'inbox-mitglied-scan', pg_temp.pfad('5')), pg_temp.nichts());
    perform pg_temp.erwarte_sicht('E2 Nachweis 2 für ' || v_wer,
      pg_temp.sicht('doc-mitglied-zweit', 'file-mitglied-zweit', '', pg_temp.pfad('6')), pg_temp.nichts());
    perform pg_temp.erwarte_sicht('E2 Versand für ' || v_wer, pg_temp.versand(), v_versand_mitglied);
    -- 6 Die Schutztabelle selbst ist für Clients gesperrt.
    perform pg_temp.erwarte_fehler('E3 Schutztabelle lesen',
      'select count(*) from public.workspace_restricted_documents', 'permission denied');
    perform pg_temp.zurueck();
  end loop;

  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_fehler('E4 Schutztabelle auch für den Inhaber nur über Funktionen',
    'select count(*) from public.workspace_restricted_documents', 'permission denied');
  perform pg_temp.zurueck();
end $$;

/* ------------------------------------------------------------------ */
/* F -- Der Uploader auf RPC-Wegen (Test 4) und seine normalen Belege   */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
begin
  perform pg_temp.als(pg_temp.mitglied());

  perform pg_temp.erwarte_fehler('F1 Nachweis ändern',
    $q$select pg_temp.eingang('archived_document', pg_temp.dokument_payload('doc-mitglied-scan', 'X', '/Eingang/'), 1)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F2 Eingang ändern',
    $q$select pg_temp.eingang('inbox_item', pg_temp.eingang_payload('inbox-mitglied-scan', 'file-mitglied-scan', null, '/Eingang/'), 1)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F3 Analyse ändern',
    $q$select pg_temp.eingang('document_work_result', pg_temp.analyse_payload('inbox-mitglied-scan', 'X'), 1)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F4 Datei ändern',
    $q$select pg_temp.eingang('document_file', jsonb_build_object('client_file_ref_id', 'file-mitglied-scan', 'content_sha256', pg_temp.sha('5'), 'original_file_name', 'x.pdf'), 1)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F5 neue Zuordnung zum Nachweis',
    $q$select pg_temp.eingang('document_file_binding', pg_temp.zuordnung_payload('doc-mitglied-scan', 'file-mitglied-normal', 'archive'))$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F6 Papier ändern',
    $q$select pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-mitglied-scan', 'doc-mitglied-scan', 'Neu'), 1)$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F7 Papier-Wiederholung',
    $q$select pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-mitglied-scan', 'doc-mitglied-scan', 'Quittung unterschrieben'))$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F8 Ereignis-Wiederholung',
    $q$select pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-mitglied-inbox', 'inbox', 'inbox-mitglied-scan'))$q$,
    'Keine Schreibberechtigung');
  perform pg_temp.erwarte_fehler('F9 neues Ereignis zum Nachweis',
    $q$select pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-neu', 'document', 'doc-mitglied-scan'))$q$,
    'Keine Schreibberechtigung');
  -- F10 Löschen gibt keine Zeile zurück — der Zahlungsnachweis-Schutz greift zuerst.
  perform pg_temp.erwarte_fehler('F10 Nachweis löschen',
    format('select public.tombstone_workspace_document(%L, ''doc-mitglied-scan'')', pg_temp.ws()),
    'Dokument ist als Zahlungsnachweis verknuepft');

  -- 9 Normale Dokumente: unverändert lesbar und schreibbar.
  perform pg_temp.erwarte_sicht('F11 Uploader, normales Dokument',
    pg_temp.sicht('doc-mitglied-normal', 'file-mitglied-normal', 'inbox-mitglied-normal', pg_temp.pfad('7')),
    pg_temp.nichts() || jsonb_build_object(
      'dokument', 1, 'datei', 1, 'zuordnung', 1, 'eingang', 1, 'analyse', 1, 'papier', 1, 'kommunikation', 1,
      'versand', 1, 'speicher', 1, 'speicher_lesbar', true,
      'abzug_dokument', true, 'abzug_datei', true, 'abzug_zuordnung', true, 'abzug_eingang', true,
      'abzug_analyse', true, 'abzug_papier', true, 'abzug_kommunikation', true));
  v := pg_temp.eingang('archived_document', pg_temp.dokument_payload('doc-mitglied-normal', 'Baumarkt neu', '/Eingang/Sonstiges/2026/'), 1);
  if (v ->> 'row_version')::bigint <> 2 then raise exception 'F12 normales Dokument schreiben: %', v; end if;
  v := pg_temp.sync('paper_register_entry', pg_temp.papier_payload('paper-mitglied-normal', 'doc-mitglied-normal', 'Baumarkt'));
  if not coalesce((v ->> 'replayed')::boolean, false) then raise exception 'F13 normale Papier-Wiederholung: %', v; end if;
  v := pg_temp.sync('communication_event', pg_temp.ereignis_payload('event-mitglied-normal', 'document', 'doc-mitglied-normal'));
  if not coalesce((v ->> 'replayed')::boolean, false) then raise exception 'F14 normale Ereignis-Wiederholung: %', v; end if;
  -- Der Beleg einer Ausgabenzahlung ist kein Personalbeleg: weiter für den Uploader lesbar.
  if (select count(*) from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-ausgabe-nachweis') <> 1 then
    raise exception 'F15 Ausgabennachweis des Uploaders muss lesbar bleiben';
  end if;
  if (select count(*) from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-rechnung-g') <> 1 then
    raise exception 'F16 Rechnungsdokument muss für Mitglieder lesbar bleiben';
  end if;

  perform pg_temp.zurueck();

  -- Das zweite Mitglied: fremde Uploads wie bisher nicht, Versand und Rechnungsdokument wie bisher ja.
  perform pg_temp.als(pg_temp.mitglied2());
  perform pg_temp.erwarte_sicht('F17 anderes Mitglied, fremdes normales Dokument',
    pg_temp.sicht('doc-mitglied-normal', 'file-mitglied-normal', 'inbox-mitglied-normal', pg_temp.pfad('7')),
    pg_temp.nichts() || jsonb_build_object('versand', 1));
  if (select count(*) from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-rechnung-g') <> 1 then
    raise exception 'F18 Rechnungsdokument muss für Mitglieder lesbar bleiben';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.pull_workspace_documents(pg_temp.ws())) e
                 where e ->> 'client_document_id' = 'doc-rechnung-g') then
    raise exception 'F19 Rechnungsdokument muss im Dokument-Abzug bleiben';
  end if;
  perform pg_temp.zurueck();
end $$;

/* ------------------------------------------------------------------ */
/* G -- Nachweiswechsel: einmal verknüpft, bleibt geschützt             */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
begin
  perform pg_temp.als(pg_temp.inhaber());
  v := public.set_workspace_employee_payment_proof(pg_temp.ws(), 'pay-2', 'doc-nachweis-ordner');
  if v ->> 'proof_document_id' <> 'doc-nachweis-ordner' then raise exception 'G1 Wechsel: %', v; end if;
  v := public.set_workspace_employee_payment_proof(pg_temp.ws(), 'pay-2', null);
  if v ->> 'proof_document_id' is not null then raise exception 'G2 Nachweis entfernt: %', v; end if;
  -- Nicht mehr verknüpft: der Inhaber darf löschen (alter Schutz greift nicht mehr).
  perform public.tombstone_workspace_document(pg_temp.ws(), 'doc-mitglied-zweit');
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_sicht('G3 früherer Nachweis bleibt geschützt',
    pg_temp.sicht('doc-mitglied-zweit', 'file-mitglied-zweit', '', pg_temp.pfad('6')), pg_temp.nichts());
  -- G4 Die Wiederholung des Löschens am gelöschten Beleg gibt keine Zeile zurück.
  perform pg_temp.erwarte_fehler('G4 gelöschten früheren Nachweis „löschen"',
    format('select public.tombstone_workspace_document(%L, ''doc-mitglied-zweit'')', pg_temp.ws()),
    'Keine Schreibberechtigung');
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.admin_alt());
  perform pg_temp.erwarte_sicht('G5 zwischenzeitlicher Nachweis bleibt geschützt',
    pg_temp.sicht('doc-nachweis-ordner', 'file-nachweis-ordner', 'inbox-nachweis-ordner', pg_temp.pfad('3')),
    pg_temp.nichts());
  perform pg_temp.zurueck();
end $$;

/* ------------------------------------------------------------------ */
/* H -- Storno (Test 5) und die alten Löschschutzregeln (Test 10)       */
/* ------------------------------------------------------------------ */

do $$
declare
  v_wer uuid;
begin
  perform pg_temp.als(pg_temp.inhaber());
  perform public.reverse_workspace_employee_payment(pg_temp.ws(), 'pay-1', 'Doppelt erfasst');
  perform pg_temp.zurueck();

  foreach v_wer in array array[pg_temp.mitglied2(), pg_temp.admin_alt(), pg_temp.mitglied()] loop
    perform pg_temp.als(v_wer);
    perform pg_temp.erwarte_sicht('H1 storniert, Quittung für ' || v_wer,
      pg_temp.sicht('emp-receipt-pay-1', 'file-quittung-1', '', pg_temp.pfad('1')), pg_temp.nichts());
    perform pg_temp.erwarte_sicht('H1 storniert, Nachweis für ' || v_wer,
      pg_temp.sicht('doc-mitglied-scan', 'file-mitglied-scan', 'inbox-mitglied-scan', pg_temp.pfad('5')), pg_temp.nichts());
    perform pg_temp.zurueck();
  end loop;

  perform pg_temp.als(pg_temp.inhaber());
  if (pg_temp.sicht('doc-mitglied-scan', 'file-mitglied-scan', 'inbox-mitglied-scan', pg_temp.pfad('5')) ->> 'dokument')::int <> 1 then
    raise exception 'H2 Inhaber liest den Nachweis auch nach Storno';
  end if;
  -- 10 Alte Regeln: verknüpfte Nachweise werden nicht gelöscht — Mitarbeiterzahlung (auch storniert),
  --    Ausgabe, Rechnung; auf beiden Löschwegen.
  perform pg_temp.erwarte_fehler('H3 Quittung löschen (storniert)',
    format('select public.tombstone_workspace_document(%L, ''emp-receipt-pay-1'')', pg_temp.ws()),
    'Dokument ist als Zahlungsnachweis verknuepft');
  perform pg_temp.erwarte_fehler('H4 Nachweis löschen über den Eingangsweg (storniert)',
    $q$select pg_temp.eingang('archived_document', jsonb_build_object('client_document_id', 'doc-mitglied-scan', 'deleted', true), 1)$q$,
    'Dokument ist als Zahlungsnachweis verknuepft');
  perform pg_temp.erwarte_fehler('H5 Ausgabennachweis löschen',
    format('select public.tombstone_workspace_document(%L, ''doc-ausgabe-nachweis'')', pg_temp.ws()),
    'Dokument ist als Zahlungsnachweis verknuepft');
  perform pg_temp.erwarte_fehler('H6 Rechnungsnachweis löschen über den Eingangsweg',
    $q$select pg_temp.eingang('archived_document', jsonb_build_object('client_document_id', 'doc-rechnung-nachweis', 'deleted', true), 1)$q$,
    'Dokument ist als Zahlungsnachweis verknuepft');
  perform pg_temp.zurueck();
end $$;

/* ------------------------------------------------------------------ */
/* I -- Versanddienst ohne Anmeldung                                    */
/* ------------------------------------------------------------------ */

do $$
declare
  v_id uuid := (select id from public.workspace_document_deliveries
                where workspace_id = pg_temp.ws() and client_delivery_id = 'dlv-quittung');
begin
  perform pg_temp.als_anon();
  perform pg_temp.erwarte_fehler('I1 Versanddaten ohne Anmeldung',
    format('select public.get_workspace_document_delivery_for_send(%L, ''dlv-quittung'')', pg_temp.ws()),
    'permission denied');
  perform pg_temp.erwarte_fehler('I2 Versandstatus ohne Anmeldung',
    format('select public.update_workspace_document_delivery_status(%L, ''sending'')', v_id),
    'permission denied');
  perform pg_temp.zurueck();

  -- Der Dienst behält sein Recht.
  if not has_function_privilege('service_role', 'public.get_workspace_document_delivery_for_send(uuid, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.update_workspace_document_delivery_status(uuid, text, text, text, text, text, bigint)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_workspace_document_delivery_for_send(uuid, bigint)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.mark_workspace_document_delivery_accepted(uuid, text, bigint)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.resolve_stale_workspace_document_delivery_claim(uuid, integer)', 'EXECUTE') then
    raise exception 'I3 service_role muss die Versanddienst-Funktionen behalten';
  end if;
  if has_function_privilege('anon', 'public.claim_workspace_document_delivery_for_send(uuid, bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.mark_workspace_document_delivery_accepted(uuid, text, bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.resolve_stale_workspace_document_delivery_claim(uuid, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.workspace_document_is_restricted(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.workspace_restricted_content_write_guard()', 'EXECUTE') then
    raise exception 'I4 anon/authenticated haben ein Recht, das sie nicht haben dürfen';
  end if;
end $$;

select 'P1 MITARBEITERZAHLUNGEN Datenschutz: alle Zusicherungen erfuellt';

rollback;
