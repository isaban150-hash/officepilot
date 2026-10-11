-- GO-LIVE-SECURITY-01 / PHASE 1 -- Vertragstest Rollen- und Archivsicherheit.
--
--   A  Löschen (tombstone_workspace_document): Mitglied nein -- auch kein
--      Existenz-Orakel und keine Zeile zurück --, Inhaber/Admin ja; Schutz der
--      festgeschriebenen Rechnung, Wiederholung und Mandantentrennung unverändert;
--      bei Archivdokumenten beide Grabstein-Marker deckungsgleich.
--   R  Wiederherstellen (restore_workspace_document): nur Inhaber/Admin, nur mit
--      Begründung, genau eine unveränderliche Prüfzeile, Wiederholung ohne
--      Wirkung, Rückkehr in beiden Abzügen, Mandantentrennung.
--   I  Eingangsweg: kein Wiederbeleben gelöschter Archivdokumente, für keine
--      Rolle; Mitglieds-Löschverbot und normale Bearbeitung unverändert.
--   B  Rollen: Versand vermerken, Leistungszeitraum bestätigen, Rechnungsdokument
--      sichern, Versand mit Kontext -- Mitglied nein (42501), Inhaber/Admin ja,
--      Wiederholungen und Mandantentrennung unverändert.
--   O  Angebote und Nachträge (Produktentscheidung vom 2026-10-09): Mitglied
--      bereitet vor, gibt aber nicht frei und bestätigt nicht (42501, ohne eine
--      Zeile anzulegen); Inhaber/Admin geben frei, Wiederholung ohne zweite Nummer.
--   S  Status freigegebener Angebote auf jedem Schreibweg: Mitglied setzt weder
--      versendet, abgelehnt, storniert, ersetzt noch angenommen noch die Ablage
--      (auch nicht direkt an der Tabelle); Wiederholungen und Entwurfsarbeit
--      bleiben; Inhaber/Admin wie bisher; keine Umgehung über gelöschte Entwürfe
--      oder präparierte Nutzlast, für keine Rolle.
--   Z  Keine Auskunft über fremde Betriebe: Zahlungsnachweis-Prüfung nur intern,
--      Client-Abfrage und Datenschutz-Helfer antworten Fremden einheitlich;
--      Mitglieder, Policies, Löschschutz und interne Aufrufe unverändert.
--   G  Rechte: geänderte und neue Funktionen, Prüfspur-Tabelle, Postfach, OAuth
--      und E-Mail-Versand -- ausdrücklich, ohne Standardrechte.
--
-- Jede Prüfung läuft als Rolle authenticated (bzw. anon) mit den Claims des
-- Nutzers -- RLS und Funktionsrechte greifen wie bei einem echten Client.
-- Zustände werden danach als postgres nachgelesen.
--
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/go_live_security_01.sql
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
  ('00000000-0000-0000-0000-00000005ec01'::uuid, 'inhaber-gls01@example.invalid'),
  ('00000000-0000-0000-0000-00000005ec02'::uuid, 'admin-gls01@example.invalid'),
  ('00000000-0000-0000-0000-00000005ec03'::uuid, 'mitglied-gls01@example.invalid'),
  ('00000000-0000-0000-0000-00000005ec04'::uuid, 'fremd-gls01@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-00000005ec01'::uuid, '00000000-0000-0000-0000-00000005ec02'::uuid,
             '00000000-0000-0000-0000-00000005ec03'::uuid, '00000000-0000-0000-0000-00000005ec04'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000005eca1'::uuid, 'GLS01 A', '00000000-0000-0000-0000-00000005ec01'::uuid),
       ('00000000-0000-0000-0000-00000005ecb1'::uuid, 'GLS01 B', '00000000-0000-0000-0000-00000005ec04'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000005eca1'::uuid, '00000000-0000-0000-0000-00000005ec01'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000005eca1'::uuid, '00000000-0000-0000-0000-00000005ec02'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-00000005eca1'::uuid, '00000000-0000-0000-0000-00000005ec03'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000005ecb1'::uuid, '00000000-0000-0000-0000-00000005ec04'::uuid, 'owner',  'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-00000005eca1'::uuid $p$;
create function pg_temp.ws_b() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-00000005ecb1'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-00000005ec01'::uuid $p$;
create function pg_temp.admin() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-00000005ec02'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-00000005ec03'::uuid $p$;
create function pg_temp.fremd() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-00000005ec04'::uuid $p$;

-- Rechnungen in A: Entwurf (Archiv löschbar), vorbereitet und versendet
-- (festgeschrieben), eine weitere vorbereitete ohne Archivdokument.
insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values (pg_temp.ws(), null, 'inv-gls-entwurf', '2026-9101', 2026, 9101, 'rechnung', 'entwurf', '{}'::jsonb),
       (pg_temp.ws(), null, 'inv-gls-vorb', '2026-9102', 2026, 9102, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb),
       (pg_temp.ws(), null, 'inv-gls-vers', '2026-9103', 2026, 9103, 'rechnung', 'versendet', '{"status":"versendet"}'::jsonb),
       (pg_temp.ws(), null, 'inv-gls-neu', '2026-9104', 2026, 9104, 'rechnung', 'vorbereitet', '{"status":"vorbereitet"}'::jsonb);

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values (pg_temp.ws(), 'doc-gls-mitglied', 'archived_document', null, '{"id":"doc-gls-mitglied","title":"Mitglied"}'::jsonb, pg_temp.mitglied()),
       (pg_temp.ws(), 'doc-gls-mitglied2', 'archived_document', null, '{"id":"doc-gls-mitglied2","title":"Mitglied 2"}'::jsonb, pg_temp.mitglied()),
       (pg_temp.ws(), 'doc-gls-inhaber', 'archived_document', null, '{"id":"doc-gls-inhaber","title":"Inhaber"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-gls-g-entwurf', 'generated_invoice', 'inv-gls-entwurf', '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-gls-g-vorb', 'generated_invoice', 'inv-gls-vorb', '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws_b(), 'doc-gls-fremd', 'archived_document', null, '{"id":"doc-gls-fremd","title":"Fremd"}'::jsonb, pg_temp.fremd());

/** Als dieser Nutzer -- Rolle authenticated, damit RLS und Funktionsrechte greifen. */
create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

/** Ohne Anmeldung -- Rolle anon, wie ein Aufruf nur mit dem öffentlichen Schlüssel. */
create function pg_temp.als_anon() returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
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

create function pg_temp.dok(p_ws uuid, p_id text) returns public.workspace_documents language sql as $p$
  select * from public.workspace_documents where workspace_id = p_ws and client_document_id = p_id;
$p$;

create function pg_temp.rechnung(p_id text) returns public.workspace_invoices language sql as $p$
  select * from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id = p_id;
$p$;

create function pg_temp.eingang(p_payload jsonb, p_version bigint)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document', p_payload, p_version);
$p$;

create function pg_temp.archiv(p_id text, p_titel text, p_geloescht boolean default false)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('client_document_id', p_id, 'deleted', p_geloescht,
    'payload', jsonb_build_object('id', p_id, 'title', p_titel));
$p$;

create function pg_temp.rechnungsdokument(p_id text, p_rechnung text) returns jsonb language sql immutable as $p$
  select jsonb_build_object('id', p_id, 'linkedInvoiceId', p_rechnung,
    'category', 'ausgangsrechnung', 'classifiedKind', 'ausgangsrechnung', 'archived', true);
$p$;

create function pg_temp.loeschen_sql(p_ws uuid, p_id text) returns text language sql immutable as $p$
  select format('select public.tombstone_workspace_document(%L, %L)', p_ws, p_id);
$p$;

create function pg_temp.zurueckholen_sql(p_ws uuid, p_id text, p_grund text) returns text language sql immutable as $p$
  select format('select public.restore_workspace_document(%L, %L, %L)', p_ws, p_id, p_grund);
$p$;

create function pg_temp.versand_mit_kontext_sql(p_ws uuid, p_kunde text) returns text language sql immutable as $p$
  select format('select public.create_workspace_document_delivery_with_context(%L, %L, %L, %L, %L, %L, %L, '
    'null, null, null, null, null, %L, null, null, false, %L, null)',
    p_ws, 'dlv-gls-1', 'invoice', 'inv-gls-vorb', 'kunde@example.invalid', 'Rechnung', 'Anbei', 'resend', p_kunde);
$p$;

/* ------------------------------------------------------------------ */
/* A -- Löschen                                                        */
/* ------------------------------------------------------------------ */

do $$
declare
  r public.workspace_documents;
  v_summe bigint;
begin
  select sum(row_version) into v_summe from public.workspace_documents where workspace_id = pg_temp.ws();

  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('A1 Mitglied löscht eigenes Archivdokument',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-mitglied'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('A2 Mitglied löscht fremdes Archivdokument (bekäme sonst die verborgene Zeile)',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-inhaber'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('A3 Mitglied löscht das Rechnungsdokument eines Entwurfs',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-g-entwurf'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('A4 Mitglied, unbekanntes Dokument: kein Existenz-Orakel',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gibt-es-nicht'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  if exists (select 1 from public.workspace_documents where workspace_id = pg_temp.ws() and (deleted or deleted_at is not null)) then
    raise exception 'A1-A4 -- ein Mitglied hat etwas gelöscht';
  end if;
  if (select sum(row_version) from public.workspace_documents where workspace_id = pg_temp.ws()) <> v_summe then
    raise exception 'A1-A4 -- Versionen verändert';
  end if;
  raise notice 'OK  A1-A4 Mitglied löscht nichts und liest nichts über den Löschweg';

  perform pg_temp.als(pg_temp.admin());
  select * into r from public.tombstone_workspace_document(pg_temp.ws(), 'doc-gls-mitglied');
  if r.deleted_at is null or not r.deleted or r.deleted_by <> pg_temp.admin() or r.row_version <> 2 then
    raise exception 'A5 Admin löscht Archivdokument: %', to_jsonb(r);
  end if;
  select * into r from public.tombstone_workspace_document(pg_temp.ws(), 'doc-gls-mitglied');
  if r.row_version <> 2 or not r.deleted then
    raise exception 'A6 Wiederholung des Löschens bewegt die Zeile: %', to_jsonb(r);
  end if;
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.inhaber());
  select * into r from public.tombstone_workspace_document(pg_temp.ws(), 'doc-gls-g-entwurf');
  if r.deleted_at is null or r.deleted or r.deleted_by <> pg_temp.inhaber() then
    raise exception 'A7 Rechnungsdokument: deleted_at gesetzt, deleted unverändert erwartet: %', to_jsonb(r);
  end if;
  perform pg_temp.erwarte_abweisung('A8 Archiv einer festgeschriebenen Rechnung bleibt geschützt',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-g-vorb'),
    'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden', null);
  perform pg_temp.erwarte_abweisung('A10 Kennung aus dem fremden Workspace',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-fremd'), 'Dokument nicht gefunden', null);
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('A9 fremder Inhaber',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-inhaber'), 'Kein Zugriff auf Workspace', null);
  perform pg_temp.zurueck();

  perform pg_temp.als_anon();
  perform pg_temp.erwarte_abweisung('A11 ohne Anmeldung',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-inhaber'), 'permission denied', '42501');
  perform pg_temp.zurueck();

  if (pg_temp.dok(pg_temp.ws(), 'doc-gls-g-vorb')).deleted_at is not null
     or (pg_temp.dok(pg_temp.ws(), 'doc-gls-inhaber')).deleted
     or (pg_temp.dok(pg_temp.ws_b(), 'doc-gls-fremd')).deleted then
    raise exception 'A8-A11 -- geschützte oder fremde Zeile verändert';
  end if;
  raise notice 'OK  A5-A11 Inhaber/Admin löschen; Schutzregeln, Wiederholung, Mandantentrennung unverändert';
end $$;

/* ------------------------------------------------------------------ */
/* R -- Wiederherstellen                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  r public.workspace_documents;
  a public.workspace_document_restorations;
  v_vorher timestamptz;
  n integer;
begin
  v_vorher := (pg_temp.dok(pg_temp.ws(), 'doc-gls-mitglied')).deleted_at;

  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('R1 Mitglied stellt wieder her',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-mitglied', 'Versehentlich gelöscht'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('R1b Mitglied, unbekanntes Dokument: kein Existenz-Orakel',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gibt-es-nicht', 'Versehentlich gelöscht'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('R2a ohne Begründung',
    format('select public.restore_workspace_document(%L, %L, null)', pg_temp.ws(), 'doc-gls-mitglied'), 'Begruendung fehlt', null);
  perform pg_temp.erwarte_abweisung('R2b leere Begründung',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-mitglied', '   '), 'Begruendung fehlt', null);
  perform pg_temp.erwarte_abweisung('R2c zu kurze Begründung',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-mitglied', ' ab '), 'Begruendung fehlt', null);
  perform pg_temp.erwarte_abweisung('R2d zu lange Begründung',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-mitglied', repeat('x', 501)), 'Begruendung zu lang', null);
  perform pg_temp.erwarte_abweisung('R7a unbekanntes Dokument',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gibt-es-nicht', 'Test'), 'Dokument nicht gefunden', null);
  perform pg_temp.erwarte_abweisung('R7b Kennung aus dem fremden Workspace',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-fremd', 'Test'), 'Dokument nicht gefunden', null);
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('R6 fremder Inhaber',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-mitglied', 'Test'), 'Kein Zugriff auf Workspace', null);
  perform pg_temp.zurueck();

  perform pg_temp.als_anon();
  perform pg_temp.erwarte_abweisung('R6b ohne Anmeldung',
    pg_temp.zurueckholen_sql(pg_temp.ws(), 'doc-gls-mitglied', 'Test'), 'permission denied', '42501');
  perform pg_temp.zurueck();

  if (select count(*) from public.workspace_document_restorations where workspace_id = pg_temp.ws()) <> 0 then
    raise exception 'R1-R7 -- Prüfzeile ohne Wiederherstellung';
  end if;
  if not (pg_temp.dok(pg_temp.ws(), 'doc-gls-mitglied')).deleted then
    raise exception 'R1-R7 -- Dokument ohne Berechtigung zurückgekehrt';
  end if;
  raise notice 'OK  R1-R7 Mitglied, fremder Nutzer, anon und ungültige Begründung stellen nichts wieder her';

  perform pg_temp.als(pg_temp.admin());
  select * into r from public.restore_workspace_document(pg_temp.ws(), 'doc-gls-mitglied', '  Versehentlich gelöscht  ');
  if r.deleted or r.deleted_at is not null or r.deleted_by is not null or r.row_version <> 3 or r.updated_by <> pg_temp.admin() then
    raise exception 'R3 Admin stellt Archivdokument wieder her: %', to_jsonb(r);
  end if;
  select * into r from public.restore_workspace_document(pg_temp.ws(), 'doc-gls-mitglied', 'Noch einmal');
  if r.row_version <> 3 or r.deleted then
    raise exception 'R4 Wiederholung bewegt die Zeile: %', to_jsonb(r);
  end if;
  perform pg_temp.zurueck();

  select count(*) into n from public.workspace_document_restorations where workspace_id = pg_temp.ws();
  if n <> 1 then raise exception 'R3/R4 -- genau eine Prüfzeile erwartet, gefunden %', n; end if;
  select * into a from public.workspace_document_restorations where workspace_id = pg_temp.ws();
  if a.client_document_id <> 'doc-gls-mitglied' or a.document_kind <> 'archived_document'
     or a.reason <> 'Versehentlich gelöscht' or a.previous_deleted_at is distinct from v_vorher
     or a.previous_deleted_by is distinct from pg_temp.admin() or a.restored_by <> pg_temp.admin()
     or a.row_version_after <> 3 then
    raise exception 'R3 Prüfzeile: %', to_jsonb(a);
  end if;

  perform pg_temp.als(pg_temp.inhaber());
  select * into r from public.restore_workspace_document(pg_temp.ws(), 'doc-gls-g-entwurf', 'Archiv des Entwurfs wird gebraucht');
  if r.deleted_at is not null or r.deleted or r.row_version <> 3 then
    raise exception 'R5 Inhaber stellt Rechnungsdokument wieder her: %', to_jsonb(r);
  end if;

  -- R11 Rückkehr in beiden Abzügen, wie sie die Geräte lesen.
  if not exists (select 1 from jsonb_array_elements(public.pull_workspace_intake_state(pg_temp.ws()) -> 'archived_documents') e
                 where e ->> 'client_document_id' = 'doc-gls-mitglied'
                   and not (e ->> 'deleted')::boolean and e ->> 'deleted_at' is null
                   and (e ->> 'row_version')::bigint = 3) then
    raise exception 'R11a Eingangs-Abzug zeigt die Rückkehr nicht';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.pull_workspace_documents(pg_temp.ws())) e
                 where e ->> 'client_document_id' = 'doc-gls-g-entwurf' and e ->> 'deleted_at' is null) then
    raise exception 'R11b Dokument-Abzug zeigt die Rückkehr nicht';
  end if;

  -- R9 Prüfspur lesen: Inhaber ja (beide Zeilen) ...
  select count(*) into n from public.workspace_document_restorations;
  if n <> 2 then raise exception 'R9a Inhaber sieht die Prüfspur nicht vollständig: %', n; end if;
  perform pg_temp.erwarte_abweisung('R9b Inhaber ändert die Prüfspur',
    format('update public.workspace_document_restorations set reason = %L', 'geändert'), 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('R9c Inhaber löscht die Prüfspur',
    'delete from public.workspace_document_restorations', 'permission denied', '42501');
  perform pg_temp.zurueck();

  -- ... Mitglied und fremder Inhaber nein.
  perform pg_temp.als(pg_temp.mitglied());
  select count(*) into n from public.workspace_document_restorations;
  if n <> 0 then raise exception 'R9d Mitglied sieht die Prüfspur: %', n; end if;
  perform pg_temp.erwarte_abweisung('R9e Mitglied schreibt eine Prüfzeile',
    format('insert into public.workspace_document_restorations (workspace_id, client_document_id, document_kind, reason, restored_by, row_version_after) values (%L, %L, %L, %L, %L, 1)',
      pg_temp.ws(), 'doc-gls-inhaber', 'archived_document', 'Gefälscht', pg_temp.mitglied()),
    'permission denied', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.fremd());
  select count(*) into n from public.workspace_document_restorations;
  if n <> 0 then raise exception 'R9f fremder Inhaber sieht fremde Prüfspur: %', n; end if;
  perform pg_temp.zurueck();

  -- R8 Unveränderlich auch für den Tabelleneigentümer.
  perform pg_temp.erwarte_abweisung('R8 Prüfspur unveränderlich',
    format('update public.workspace_document_restorations set reason = %L', 'geändert'), 'Pruefspur ist unveraenderlich', '42501');
  raise notice 'OK  R3-R11 Inhaber/Admin stellen mit Begründung wieder her; eine unveränderliche Prüfzeile je Wiederherstellung; Rückkehr im Abzug';
end $$;

/* ------------------------------------------------------------------ */
/* I -- Eingangsweg: kein Wiederbeleben                                */
/* ------------------------------------------------------------------ */

do $$
declare
  v jsonb;
  r public.workspace_documents;
begin
  perform pg_temp.als(pg_temp.inhaber());
  v := pg_temp.eingang(pg_temp.archiv('doc-gls-inhaber', 'Inhaber', true), 1);
  if not (v ->> 'deleted')::boolean or (v ->> 'row_version')::bigint <> 2 then
    raise exception 'I0 Löschen über den Eingangsweg: %', v;
  end if;
  v := pg_temp.eingang(pg_temp.archiv('doc-gls-mitglied2', 'Mitglied 2', true), 1);
  if not (v ->> 'deleted')::boolean then raise exception 'I0b Löschen über den Eingangsweg: %', v; end if;
  perform pg_temp.erwarte_abweisung('I1 Inhaber belebt über den Eingangsweg wieder',
    format('select pg_temp.eingang(%L::jsonb, 2)', pg_temp.archiv('doc-gls-inhaber', 'Inhaber zurück')),
    'geloeschtes Dokument nur ueber die Wiederherstellung', '42501');
  perform pg_temp.zurueck();

  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('I2 Mitglied belebt eigenes, von der Verwaltung gelöschtes Dokument wieder',
    format('select pg_temp.eingang(%L::jsonb, 2)', pg_temp.archiv('doc-gls-mitglied2', 'Mitglied 2 zurück')),
    'geloeschtes Dokument nur ueber die Wiederherstellung', '42501');
  perform pg_temp.erwarte_abweisung('I3 Mitglied setzt einen Grabstein (unverändert verboten)',
    format('select pg_temp.eingang(%L::jsonb, 3)', pg_temp.archiv('doc-gls-mitglied', 'Mitglied', true)),
    'Keine Schreibberechtigung', null);
  v := pg_temp.eingang(pg_temp.archiv('doc-gls-mitglied', 'Mitglied bearbeitet'), 3);
  if (v ->> 'row_version')::bigint <> 4 or (v ->> 'deleted')::boolean then
    raise exception 'I4 Mitglied bearbeitet eigenes aktives Dokument: %', v;
  end if;
  perform pg_temp.zurueck();

  if not (pg_temp.dok(pg_temp.ws(), 'doc-gls-inhaber')).deleted
     or not (pg_temp.dok(pg_temp.ws(), 'doc-gls-mitglied2')).deleted then
    raise exception 'I1/I2 -- Dokument über den Eingangsweg wiederbelebt';
  end if;

  perform pg_temp.als(pg_temp.inhaber());
  select * into r from public.restore_workspace_document(pg_temp.ws(), 'doc-gls-inhaber', 'Irrtümlich abgelegt');
  if r.deleted or r.deleted_at is not null or r.row_version <> 3 then
    raise exception 'I5 Wiederherstellung nach Löschung über den Eingangsweg: %', to_jsonb(r);
  end if;
  v := pg_temp.eingang(pg_temp.archiv('doc-gls-inhaber', 'Inhaber wieder da'), 3);
  if (v ->> 'row_version')::bigint <> 4 or (v ->> 'deleted')::boolean then
    raise exception 'I5b Bearbeitung nach der Wiederherstellung: %', v;
  end if;
  perform pg_temp.zurueck();
  raise notice 'OK  I1-I5 kein Wiederbeleben über den Eingangsweg; Löschverbot und Bearbeitung unverändert; geprüfter Weg funktioniert';
end $$;

/* ------------------------------------------------------------------ */
/* B -- Rollen an Rechnung und Versand                                 */
/* ------------------------------------------------------------------ */

do $$
declare
  r public.workspace_documents;
  i public.workspace_invoices;
  v_vorb bigint := (pg_temp.rechnung('inv-gls-vorb')).row_version;
  v_vers bigint := (pg_temp.rechnung('inv-gls-vers')).row_version;
  n integer;
begin
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('B1 Mitglied vermerkt den Versand',
    format('select public.update_workspace_invoice_sent(%L, %L, %L, %L, null)', pg_temp.ws(), 'inv-gls-vorb', '2026-10-01', 'email'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('B2 Mitglied bestätigt den Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-gls-vers'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('B3 Mitglied sichert ein Rechnungsdokument',
    format('select public.upsert_workspace_generated_invoice_document(%L, %L, %L, null, %L::jsonb)',
      pg_temp.ws(), 'doc-gls-g-neu', 'inv-gls-neu', pg_temp.rechnungsdokument('doc-gls-g-neu', 'inv-gls-neu')),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('B3b Mitglied, Wiederholung am bestehenden Rechnungsdokument (Leseweg)',
    format('select public.upsert_workspace_generated_invoice_document(%L, %L, %L, null, %L::jsonb)',
      pg_temp.ws(), 'doc-gls-g-vorb', 'inv-gls-vorb', pg_temp.rechnungsdokument('doc-gls-g-vorb', 'inv-gls-vorb')),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('B4 Mitglied, Versand mit Kontext: Rollenprüfung vor der Kontextprüfung',
    pg_temp.versand_mit_kontext_sql(pg_temp.ws(), 'kunde-gibt-es-nicht'), 'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();

  i := pg_temp.rechnung('inv-gls-vorb');
  if i.invoice_status <> 'vorbereitet' or i.row_version <> v_vorb or i.payload ? 'sentAt' then
    raise exception 'B1 -- Rechnung verändert: %', to_jsonb(i);
  end if;
  i := pg_temp.rechnung('inv-gls-vers');
  if i.payload ? 'servicePeriodConfirmed' or i.row_version <> v_vers then
    raise exception 'B2 -- Rechnung verändert: %', to_jsonb(i);
  end if;
  if exists (select 1 from public.workspace_documents where workspace_id = pg_temp.ws() and linked_invoice_id = 'inv-gls-neu') then
    raise exception 'B3 -- Rechnungsdokument angelegt';
  end if;
  if exists (select 1 from public.workspace_document_deliveries where workspace_id = pg_temp.ws()) then
    raise exception 'B4 -- Versandauftrag angelegt';
  end if;
  raise notice 'OK  B1-B4 Mitglied schreibt nicht an festgeschriebenen Rechnungen und am Versand (42501)';

  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('B5a fremder Inhaber vermerkt den Versand',
    format('select public.update_workspace_invoice_sent(%L, %L, %L, %L, null)', pg_temp.ws(), 'inv-gls-vorb', '2026-10-01', 'email'),
    'Kein Zugriff auf Workspace', null);
  perform pg_temp.erwarte_abweisung('B5b fremder Inhaber bestätigt den Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-gls-vers'),
    'Kein Zugriff auf Workspace', null);
  perform pg_temp.erwarte_abweisung('B5c fremder Inhaber sichert ein Rechnungsdokument',
    format('select public.upsert_workspace_generated_invoice_document(%L, %L, %L, null, %L::jsonb)',
      pg_temp.ws(), 'doc-gls-g-neu', 'inv-gls-neu', pg_temp.rechnungsdokument('doc-gls-g-neu', 'inv-gls-neu')),
    'Kein Zugriff auf Workspace', null);
  perform pg_temp.erwarte_abweisung('B5d fremder Inhaber, Versand mit Kontext',
    pg_temp.versand_mit_kontext_sql(pg_temp.ws(), 'kunde-gibt-es-nicht'), 'Kein Zugriff auf Workspace', null);
  perform pg_temp.zurueck();

  perform pg_temp.als_anon();
  perform pg_temp.erwarte_abweisung('B5e ohne Anmeldung, Versand vermerken',
    format('select public.update_workspace_invoice_sent(%L, %L, %L, %L, null)', pg_temp.ws(), 'inv-gls-vorb', '2026-10-01', 'email'),
    'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('B5f ohne Anmeldung, Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-gls-vers'),
    'permission denied', '42501');
  perform pg_temp.zurueck();

  -- Inhaber und Admin: unverändert erlaubt, Wiederholungen unverändert.
  perform pg_temp.als(pg_temp.inhaber());
  perform public.update_workspace_invoice_sent(pg_temp.ws(), 'inv-gls-vorb', '2026-10-01', 'email', null);
  perform pg_temp.zurueck();
  i := pg_temp.rechnung('inv-gls-vorb');
  if i.invoice_status <> 'versendet' or i.payload ->> 'sentAt' <> '2026-10-01' or i.payload ->> 'sentVia' <> 'email'
     or i.updated_by <> pg_temp.inhaber() or i.row_version <> v_vorb + 1 then
    raise exception 'B6 Inhaber vermerkt den Versand: %', to_jsonb(i);
  end if;

  perform pg_temp.als(pg_temp.admin());
  perform public.confirm_workspace_invoice_service_period(pg_temp.ws(), 'inv-gls-vers');
  perform public.confirm_workspace_invoice_service_period(pg_temp.ws(), 'inv-gls-vers');
  perform pg_temp.zurueck();
  i := pg_temp.rechnung('inv-gls-vers');
  if i.payload ->> 'servicePeriodConfirmed' <> 'true' or i.row_version <> v_vers + 1 or i.updated_by <> pg_temp.admin() then
    raise exception 'B7 Admin bestätigt den Leistungszeitraum (Wiederholung ohne Wirkung): %', to_jsonb(i);
  end if;

  perform pg_temp.als(pg_temp.inhaber());
  select * into r from public.upsert_workspace_generated_invoice_document(pg_temp.ws(), 'doc-gls-g-neu', 'inv-gls-neu', null,
    pg_temp.rechnungsdokument('doc-gls-g-neu', 'inv-gls-neu'));
  if r.client_document_id <> 'doc-gls-g-neu' or r.created_by <> pg_temp.inhaber() or r.deleted_at is not null then
    raise exception 'B8 Inhaber sichert das Rechnungsdokument: %', to_jsonb(r);
  end if;
  perform pg_temp.erwarte_abweisung('B9 Inhaber passiert die Rollenprüfung; Kontextprüfung unverändert',
    pg_temp.versand_mit_kontext_sql(pg_temp.ws(), 'kunde-gibt-es-nicht'), 'customer_id gehoert nicht zum Workspace', null);
  perform pg_temp.zurueck();

  -- Zweites Gerät (Admin, andere lokale Kennung): die kanonische Zeile, keine zweite.
  perform pg_temp.als(pg_temp.admin());
  select * into r from public.upsert_workspace_generated_invoice_document(pg_temp.ws(), 'doc-gls-g-zweit', 'inv-gls-neu', null,
    pg_temp.rechnungsdokument('doc-gls-g-zweit', 'inv-gls-neu'));
  if r.client_document_id <> 'doc-gls-g-neu' then
    raise exception 'B10 Wiederholung eines zweiten Geräts: %', to_jsonb(r);
  end if;
  perform pg_temp.zurueck();
  select count(*) into n from public.workspace_documents where workspace_id = pg_temp.ws() and linked_invoice_id = 'inv-gls-neu';
  if n <> 1 then raise exception 'B10 -- % Rechnungsdokumente statt einem', n; end if;
  raise notice 'OK  B5-B10 fremde Nutzer und anon abgewiesen; Inhaber/Admin unverändert; Wiederholungen unverändert';
end $$;

/* ------------------------------------------------------------------ */
/* O -- Angebote und Nachträge: vorbereiten ja, verbindlich nur        */
/*      Inhaber und Admin (Produktentscheidung vom 2026-10-09)          */
/* ------------------------------------------------------------------ */

do $$
declare
  basis constant jsonb := '{"customer":{"name":"K"},"title":"T","offerDate":"2026-09-21","validUntil":"2026-10-21","positions":[{"id":"p","description":"x","quantity":1,"unit":"Stück","unitPrice":10}],"taxStatus":"standard_19","totals":{"subtotal":10,"taxRate":19,"tax":1.9,"total":11.9},"createdAt":"2026-09-21T10:00:00.000Z"}'::jsonb;
  r jsonb;
  v_version bigint;
  v_nummer text;
begin
  -- O1 Das Mitglied bereitet ein Angebot vor (Entwurf über den generischen Schreibweg).
  perform pg_temp.als(pg_temp.mitglied());
  r := public.upsert_workspace_sync_entity(pg_temp.ws(), 'offer',
    jsonb_build_object('offer_id', 'off-gls-1', 'status', 'entwurf', 'payload', basis || '{"id":"off-gls-1","status":"entwurf"}'), 0);
  v_version := (r ->> 'row_version')::bigint;
  if coalesce(v_version, 0) < 1 then raise exception 'O1 Mitglied speichert einen Angebotsentwurf: %', r; end if;
  -- O2/O3 ... gibt es aber nicht frei, auch kein nie gespeichertes Angebot.
  perform pg_temp.erwarte_abweisung('O2 Mitglied gibt ein Angebot frei',
    format('select public.finalize_workspace_offer(%L, %L, %L::jsonb, %L, %s)', pg_temp.ws(), 'off-gls-1', basis || '{"id":"off-gls-1"}', 'fp-gls-1', v_version),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('O3 Mitglied gibt ein nie gespeichertes Angebot frei',
    format('select public.finalize_workspace_offer(%L, %L, %L::jsonb, %L, 0)', pg_temp.ws(), 'off-gls-nie', basis || '{"id":"off-gls-nie"}', 'fp-gls-nie'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  if exists (select 1 from public.workspace_offers where workspace_id = pg_temp.ws() and client_offer_id = 'off-gls-nie') then
    raise exception 'O3 -- der Freigabeversuch eines Mitglieds hat eine Zeile angelegt';
  end if;
  if (select status from public.workspace_offers where workspace_id = pg_temp.ws() and client_offer_id = 'off-gls-1') <> 'entwurf'
     or exists (select 1 from public.workspace_offer_sequences where workspace_id = pg_temp.ws()) then
    raise exception 'O2 -- Angebot freigegeben oder Nummer vergeben';
  end if;

  -- O4 Der Admin gibt den Entwurf des Mitglieds frei: Nummer vom Server.
  perform pg_temp.als(pg_temp.admin());
  r := public.finalize_workspace_offer(pg_temp.ws(), 'off-gls-1', basis || '{"id":"off-gls-1"}', 'fp-gls-1', v_version);
  v_nummer := r -> 'row' ->> 'offer_number';
  if r -> 'row' ->> 'status' <> 'freigegeben' or v_nummer is null or coalesce((r ->> 'replayed')::boolean, false) then
    raise exception 'O4 Admin gibt frei: %', r;
  end if;
  -- O5 Wiederholung: dieselbe Nummer, keine zweite.
  r := public.finalize_workspace_offer(pg_temp.ws(), 'off-gls-1', basis || '{"id":"off-gls-1"}', 'fp-gls-1', v_version);
  if not coalesce((r ->> 'replayed')::boolean, false) or r -> 'row' ->> 'offer_number' <> v_nummer then
    raise exception 'O5 Wiederholung: %', r;
  end if;
  perform pg_temp.zurueck();

  -- O6 Fremder Inhaber: kein Zugriff.
  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('O6 fremder Inhaber gibt frei',
    format('select public.finalize_workspace_offer(%L, %L, %L::jsonb, %L, 0)', pg_temp.ws(), 'off-gls-2', basis || '{"id":"off-gls-2"}', 'fp-gls-2'),
    'Kein Zugriff auf Workspace', null);
  perform pg_temp.zurueck();

  -- O7 Nachtrag: Das Mitglied bestätigt nicht, abgewiesen vor jeder fachlichen Prüfung ...
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('O7 Mitglied bestätigt einen Nachtrag',
    format('select public.confirm_workspace_order_amendment(%L, %L, %L, %L::jsonb)', pg_temp.ws(), 'v-gibt-es-nicht', 'am-gls-1', '{}'),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  -- O8 ... der Inhaber kommt durch die Rollenprüfung und scheitert erst fachlich (unverändert).
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('O8 Inhaber passiert die Rollenprüfung',
    format('select public.confirm_workspace_order_amendment(%L, %L, %L, %L::jsonb)', pg_temp.ws(), 'v-gibt-es-nicht', 'am-gls-1', '{}'),
    'order_amendment_vorgang_not_found', null);
  perform pg_temp.zurueck();
  raise notice 'OK  O1-O8 Mitglied bereitet Angebote vor, gibt nicht frei und bestätigt keine Nachträge; Inhaber/Admin unverändert';
end $$;

/* ------------------------------------------------------------------ */
/* S -- Status freigegebener Angebote: auf jedem Schreibweg geprüft    */
/* ------------------------------------------------------------------ */

-- Die Ablage zu Beleg S1, wie sie die App anlegt (eigenes Angebot, Rückverweis).
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by)
values (pg_temp.ws(), 'doc-gls-angebot-s1', 'archived_document',
        '{"id":"doc-gls-angebot-s1","title":"Angebot S1","classifiedKind":"angebot","linkedOfferId":"off-gls-s1"}'::jsonb, pg_temp.inhaber());

create function pg_temp.angebot(p_id text) returns public.workspace_offers language sql as $p$
  select * from public.workspace_offers where workspace_id = pg_temp.ws() and client_offer_id = p_id;
$p$;

/** Der generische Schreibweg für ein Angebot, wie ihn der Client nutzt. */
create function pg_temp.angebot_sql(p_id text, p_status text, p_payload jsonb, p_version bigint, p_geloescht boolean default false)
returns text language sql immutable as $p$
  select format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, %s)', pg_temp.ws(), 'offer',
    jsonb_build_object('offer_id', p_id, 'status', p_status, 'deleted', p_geloescht, 'payload', p_payload), p_version);
$p$;

create function pg_temp.angebot_schreiben(p_id text, p_status text, p_payload jsonb, p_version bigint, p_geloescht boolean default false)
returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(pg_temp.ws(), 'offer',
    jsonb_build_object('offer_id', p_id, 'status', p_status, 'deleted', p_geloescht, 'payload', p_payload), p_version);
$p$;

do $$
declare
  basis constant jsonb := '{"customer":{"name":"K"},"title":"T","offerDate":"2026-09-21","validUntil":"2026-10-21","positions":[{"id":"p","description":"x","quantity":1,"unit":"Stück","unitPrice":10}],"taxStatus":"standard_19","totals":{"subtotal":10,"taxRate":19,"tax":1.9,"total":11.9},"createdAt":"2026-09-21T10:00:00.000Z"}'::jsonb;
  stempel constant jsonb := '{"sentAt":"2026-10-09T10:00:00.000Z","decidedAt":"2026-10-09T11:00:00.000Z"}'::jsonb;
  r jsonb;
  v bigint;
  id text;
  ziel text;
  vorher public.workspace_offers;
  o public.workspace_offers;
begin
  -- Aufbau: drei Belege, vom Mitglied vorbereitet, vom Admin freigegeben.
  foreach id in array array['off-gls-s1', 'off-gls-s2', 'off-gls-s3'] loop
    perform pg_temp.als(pg_temp.mitglied());
    r := pg_temp.angebot_schreiben(id, 'entwurf', basis || jsonb_build_object('id', id, 'status', 'entwurf'), 0);
    v := (r ->> 'row_version')::bigint;
    perform pg_temp.zurueck();
    perform pg_temp.als(pg_temp.admin());
    perform public.finalize_workspace_offer(pg_temp.ws(), id, basis || jsonb_build_object('id', id), 'fp-' || id, v);
    perform pg_temp.zurueck();
  end loop;

  -- S1 Mitglied: kein verbindlicher Status und keine Ablage über den generischen Weg.
  vorher := pg_temp.angebot('off-gls-s1');
  perform pg_temp.als(pg_temp.mitglied());
  foreach ziel in array array['versendet', 'abgelehnt', 'storniert', 'ersetzt'] loop
    perform pg_temp.erwarte_abweisung('S1 Mitglied setzt ' || ziel,
      pg_temp.angebot_sql('off-gls-s1', ziel, vorher.payload || stempel || jsonb_build_object('status', ziel), vorher.row_version),
      'Keine Schreibberechtigung', '42501');
  end loop;
  perform pg_temp.erwarte_abweisung('S1 Mitglied setzt angenommen (nur über die Annahme)',
    pg_temp.angebot_sql('off-gls-s1', 'angenommen', vorher.payload || stempel || '{"status":"angenommen"}'::jsonb, vorher.row_version),
    'Annahme nur ueber accept_workspace_offer', null);
  perform pg_temp.erwarte_abweisung('S1 Mitglied ordnet die Ablage zu',
    pg_temp.angebot_sql('off-gls-s1', 'freigegeben', vorher.payload || '{"archiveDocumentId":"doc-gls-angebot-s1"}'::jsonb, vorher.row_version),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.erwarte_abweisung('S1 Mitglied löscht den Beleg',
    pg_temp.angebot_sql('off-gls-s1', 'freigegeben', vorher.payload, vorher.row_version, true),
    'Ein freigegebenes Angebot kann nicht geloescht werden', null);
  -- Direkt an der Tabelle: remote fehlt das Schreibrecht, lokal (Standardrechte)
  -- trifft die reine Leserichtlinie keine Zeile. S2 prüft danach den Datenstand.
  begin
    execute format('update public.workspace_offers set status = %L where workspace_id = %L and client_offer_id = %L', 'versendet', pg_temp.ws(), 'off-gls-s1');
  exception when insufficient_privilege then
    null;
  end;
  perform pg_temp.zurueck();
  o := pg_temp.angebot('off-gls-s1');
  if o.status <> vorher.status or o.payload <> vorher.payload or o.row_version <> vorher.row_version or o.deleted <> vorher.deleted then
    raise exception 'S2 -- verbotene Mutation hat den Beleg verändert: %', to_jsonb(o);
  end if;
  raise notice 'OK  S1/S2 Mitglied setzt keinen verbindlichen Angebotsstatus und keine Ablage; Beleg unverändert';

  -- S3 Wiederholungen bleiben: unverändert senden (ohne und mit Version) ist kein Fehler.
  perform pg_temp.als(pg_temp.mitglied());
  r := pg_temp.angebot_schreiben('off-gls-s1', 'freigegeben', vorher.payload, 0);
  if not coalesce((r ->> 'replayed')::boolean, false) then raise exception 'S3a Wiederholung ohne Version: %', r; end if;
  r := pg_temp.angebot_schreiben('off-gls-s1', 'freigegeben', vorher.payload, vorher.row_version);
  if (r ->> 'row_version')::bigint <> vorher.row_version + 1 then raise exception 'S3b inhaltsgleiche Wiederholung: %', r; end if;
  perform pg_temp.zurueck();
  o := pg_temp.angebot('off-gls-s1');
  if o.status <> 'freigegeben' or o.payload <> vorher.payload then
    raise exception 'S3 -- Wiederholung hat den Inhalt verändert: %', to_jsonb(o);
  end if;

  -- S4 Entwürfe bleiben für Mitglieder voll bearbeitbar: anlegen, ändern, löschen.
  perform pg_temp.als(pg_temp.mitglied());
  r := pg_temp.angebot_schreiben('off-gls-s4', 'entwurf', basis || '{"id":"off-gls-s4","status":"entwurf"}'::jsonb, 0);
  r := pg_temp.angebot_schreiben('off-gls-s4', 'entwurf', basis || '{"id":"off-gls-s4","status":"entwurf","title":"T neu"}'::jsonb, (r ->> 'row_version')::bigint);
  r := pg_temp.angebot_schreiben('off-gls-s4', 'entwurf', basis || '{"id":"off-gls-s4","status":"entwurf","title":"T neu"}'::jsonb, (r ->> 'row_version')::bigint, true);
  if not coalesce((r ->> 'deleted')::boolean, false) then raise exception 'S4 Mitglied verwirft den eigenen Entwurf: %', r; end if;
  perform pg_temp.zurueck();
  raise notice 'OK  S3/S4 Wiederholungen und Entwurfsarbeit bleiben für Mitglieder erhalten';

  -- S5 Inhaber und Admin: Ablage und alle Statuswechsel wie bisher.
  perform pg_temp.als(pg_temp.inhaber());
  o := pg_temp.angebot('off-gls-s1');
  r := pg_temp.angebot_schreiben('off-gls-s1', 'freigegeben', o.payload || '{"archiveDocumentId":"doc-gls-angebot-s1"}'::jsonb, o.row_version);
  o := pg_temp.angebot('off-gls-s1');
  r := pg_temp.angebot_schreiben('off-gls-s1', 'versendet', o.payload || '{"status":"versendet","sentAt":"2026-10-09T10:00:00.000Z"}'::jsonb, o.row_version);
  o := pg_temp.angebot('off-gls-s1');
  r := pg_temp.angebot_schreiben('off-gls-s1', 'abgelehnt', o.payload || '{"status":"abgelehnt","decidedAt":"2026-10-09T11:00:00.000Z"}'::jsonb, o.row_version);
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.admin());
  o := pg_temp.angebot('off-gls-s2');
  r := pg_temp.angebot_schreiben('off-gls-s2', 'storniert', o.payload || '{"status":"storniert","decidedAt":"2026-10-09T11:00:00.000Z"}'::jsonb, o.row_version);
  o := pg_temp.angebot('off-gls-s3');
  r := pg_temp.angebot_schreiben('off-gls-s3', 'ersetzt', o.payload || '{"status":"ersetzt","decidedAt":"2026-10-09T11:00:00.000Z"}'::jsonb, o.row_version);
  perform pg_temp.zurueck();
  if (pg_temp.angebot('off-gls-s1')).status <> 'abgelehnt'
     or (pg_temp.angebot('off-gls-s1')).payload ->> 'archiveDocumentId' <> 'doc-gls-angebot-s1'
     or (pg_temp.angebot('off-gls-s2')).status <> 'storniert'
     or (pg_temp.angebot('off-gls-s3')).status <> 'ersetzt' then
    raise exception 'S5 -- Inhaber/Admin konnten den Status nicht setzen';
  end if;
  raise notice 'OK  S5 Inhaber und Admin: Ablage, versendet, abgelehnt, storniert, ersetzt wie bisher';

  -- S6 Fremder Inhaber und ohne Anmeldung: kein Zugriff.
  vorher := pg_temp.angebot('off-gls-s2');
  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('S6a fremder Inhaber setzt einen Status',
    pg_temp.angebot_sql('off-gls-s2', 'versendet', vorher.payload || '{"status":"versendet"}'::jsonb, vorher.row_version),
    'Kein Zugriff auf Workspace', null);
  perform pg_temp.zurueck();
  perform pg_temp.als_anon();
  perform pg_temp.erwarte_abweisung('S6b ohne Anmeldung',
    pg_temp.angebot_sql('off-gls-s2', 'versendet', vorher.payload || '{"status":"versendet"}'::jsonb, vorher.row_version),
    'permission denied', '42501');
  perform pg_temp.zurueck();
  o := pg_temp.angebot('off-gls-s2');
  if o.status <> vorher.status or o.row_version <> vorher.row_version then
    raise exception 'S6 -- fremder Zugriff hat den Beleg verändert: %', to_jsonb(o);
  end if;
  raise notice 'OK  S6 fremder Betrieb und anon abgewiesen; Beleg unverändert';

  -- S7 Umgehung über einen gelöschten Entwurf: für keine Rolle ein Beleg ohne Freigabe.
  perform pg_temp.als(pg_temp.inhaber());
  r := pg_temp.angebot_schreiben('off-gls-s5', 'entwurf', basis || '{"id":"off-gls-s5","status":"entwurf"}'::jsonb, 0);
  r := pg_temp.angebot_schreiben('off-gls-s5', 'entwurf', basis || '{"id":"off-gls-s5","status":"entwurf"}'::jsonb, (r ->> 'row_version')::bigint, true);
  vorher := pg_temp.angebot('off-gls-s5');
  foreach ziel in array array['freigegeben', 'angenommen', 'versendet'] loop
    perform pg_temp.erwarte_abweisung('S7 Inhaber belebt einen gelöschten Entwurf als ' || ziel,
      pg_temp.angebot_sql('off-gls-s5', ziel, basis || jsonb_build_object('id', 'off-gls-s5', 'status', ziel, 'resultingVorgangId', 'v-fremd'), vorher.row_version),
      'Freigabe nur ueber finalize_workspace_offer', null);
  end loop;
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.mitglied());
  perform pg_temp.erwarte_abweisung('S7 Mitglied belebt einen gelöschten Entwurf als freigegeben',
    pg_temp.angebot_sql('off-gls-s5', 'freigegeben', basis || '{"id":"off-gls-s5","status":"freigegeben"}'::jsonb, vorher.row_version),
    'Keine Schreibberechtigung', '42501');
  perform pg_temp.zurueck();
  o := pg_temp.angebot('off-gls-s5');
  if o.status <> 'entwurf' or not o.deleted or o.row_version <> vorher.row_version or o.offer_number is not null then
    raise exception 'S7 -- gelöschter Entwurf wurde verändert: %', to_jsonb(o);
  end if;

  -- S8 Ein Entwurf trägt weder Auftragsbezug noch Ablage; die Freigabe übernimmt beides nicht.
  perform pg_temp.als(pg_temp.inhaber());
  perform pg_temp.erwarte_abweisung('S8a Entwurf mit Auftragsbezug',
    pg_temp.angebot_sql('off-gls-s6', 'entwurf', basis || '{"id":"off-gls-s6","status":"entwurf","resultingVorgangId":"v-fremd"}'::jsonb, 0),
    'Auftragsbezug eines Angebots nur ueber accept_workspace_offer', null);
  perform pg_temp.erwarte_abweisung('S8b Entwurf mit Ablage',
    pg_temp.angebot_sql('off-gls-s6', 'entwurf', basis || '{"id":"off-gls-s6","status":"entwurf","archiveDocumentId":"doc-gls-angebot-s1"}'::jsonb, 0),
    'Ein Entwurf hat keine Archivablage', null);
  perform pg_temp.erwarte_abweisung('S8c Freigabe mit präpariertem Auftragsbezug',
    format('select public.finalize_workspace_offer(%L, %L, %L::jsonb, %L, 0)', pg_temp.ws(), 'off-gls-s7',
      basis || '{"id":"off-gls-s7","resultingVorgangId":"v-fremd"}'::jsonb, 'fp-gls-s7'),
    'Auftragsbezug eines Angebots nur ueber accept_workspace_offer', null);
  perform pg_temp.zurueck();
  if exists (select 1 from public.workspace_offers where workspace_id = pg_temp.ws() and client_offer_id in ('off-gls-s6', 'off-gls-s7')) then
    raise exception 'S8 -- präparierter Entwurf oder Beleg wurde angelegt';
  end if;
  raise notice 'OK  S7/S8 keine Umgehung über gelöschte Entwürfe oder präparierte Nutzlast, für keine Rolle';
end $$;

/* ------------------------------------------------------------------ */
/* Z -- keine Auskunft über fremde Betriebe                            */
/* ------------------------------------------------------------------ */

-- Ein Zahlungsnachweis (Rechnungszahlung) und ein Personalbeleg samt Datei und
-- Eingang in Betrieb A. Den Personalbeleg hat das Mitglied selbst hochgeladen:
-- So entscheidet in der Lese-Policy allein der Datenschutz-Helfer.
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by)
values (pg_temp.ws(), 'doc-gls-nachweis', 'archived_document', '{"id":"doc-gls-nachweis","title":"Nachweis"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-gls-personal', 'archived_document', '{"id":"doc-gls-personal","title":"Personalbeleg"}'::jsonb, pg_temp.mitglied());
insert into public.workspace_invoice_payments (workspace_id, client_invoice_id, client_payment_id, amount, paid_on, proof_document_id)
values (pg_temp.ws(), 'inv-gls-vers', 'pay-gls-1', 10, '2026-10-01', 'doc-gls-nachweis');
insert into public.workspace_restricted_documents (workspace_id, client_document_id, reason)
values (pg_temp.ws(), 'doc-gls-personal', 'employee_payment_receipt');
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path)
values (pg_temp.ws(), 'file-gls-personal', repeat('a', 64), 10, 'application/pdf', pg_temp.ws()::text || '/' || repeat('a', 64));
insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind)
values (pg_temp.ws(), 'doc-gls-personal', 'file-gls-personal', 'original');
insert into public.workspace_inbox_items (workspace_id, client_inbox_id, archive_document_id)
values (pg_temp.ws(), 'inbox-gls-personal', 'doc-gls-personal');
-- Ein zweiter Eingang gilt allein über seinen Ablagepfad als Personalbeleg, ohne
-- Dokumentbezug: So prüft der Test Datei- und Eingangshelfer jeweils für sich.
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path)
values (pg_temp.ws(), 'file-gls-ordner', repeat('b', 64), 10, 'application/pdf', pg_temp.ws()::text || '/' || repeat('b', 64));
insert into public.workspace_inbox_items (workspace_id, client_inbox_id, client_file_ref_id, payload)
values (pg_temp.ws(), 'inbox-gls-ordner', 'file-gls-ordner', '{"digitalFolder":{"path":"/Mitarbeiter/Zahlungsnachweise/2026/"}}'::jsonb);

create function pg_temp.pruefe_sql(p_funktion text, p_dokument text) returns text language sql immutable as $p$
  select format('select public.%s(%L, %L)', p_funktion, pg_temp.ws(), p_dokument);
$p$;

do $$
begin
  -- Z1 Fremder Inhaber: Die interne Zahlungsnachweis-Prüfung ist nicht aufrufbar, für jede Kennung gleich.
  perform pg_temp.als(pg_temp.fremd());
  perform pg_temp.erwarte_abweisung('Z1a fremd, Zahlungsnachweis', pg_temp.pruefe_sql('assert_document_not_payment_proof', 'doc-gls-nachweis'), 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('Z1b fremd, normales Dokument', pg_temp.pruefe_sql('assert_document_not_payment_proof', 'doc-gls-inhaber'), 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('Z1c fremd, unbekanntes Dokument', pg_temp.pruefe_sql('assert_document_not_payment_proof', 'doc-gibt-es-nicht'), 'permission denied', '42501');
  -- Z2 Die Client-Abfrage antwortet Fremden einheitlich, egal ob Nachweis, normal oder unbekannt.
  perform pg_temp.erwarte_abweisung('Z2a fremd, Zahlungsnachweis', pg_temp.pruefe_sql('is_workspace_document_payment_proof', 'doc-gls-nachweis'), 'Kein Zugriff auf Workspace', null);
  perform pg_temp.erwarte_abweisung('Z2b fremd, normales Dokument', pg_temp.pruefe_sql('is_workspace_document_payment_proof', 'doc-gls-inhaber'), 'Kein Zugriff auf Workspace', null);
  perform pg_temp.erwarte_abweisung('Z2c fremd, unbekanntes Dokument', pg_temp.pruefe_sql('is_workspace_document_payment_proof', 'doc-gibt-es-nicht'), 'Kein Zugriff auf Workspace', null);
  -- Z3 Die Datenschutz-Helfer antworten Fremden immer mit false, auch beim Namensmuster.
  if public.workspace_document_is_restricted(pg_temp.ws(), 'doc-gls-personal')
     or public.workspace_document_is_restricted(pg_temp.ws(), 'emp-receipt-gls-1')
     or public.workspace_file_is_restricted(pg_temp.ws(), 'file-gls-personal')
     or public.workspace_inbox_item_is_restricted(pg_temp.ws(), 'inbox-gls-personal')
     or public.workspace_communication_context_is_restricted(pg_temp.ws(), 'document', 'doc-gls-personal')
     or public.workspace_communication_context_is_restricted(pg_temp.ws(), 'inbox', 'inbox-gls-personal')
     or public.workspace_inbox_item_is_restricted(pg_temp.ws(), 'inbox-gls-ordner')
     or public.workspace_file_is_restricted(pg_temp.ws(), 'file-gls-ordner') then
    raise exception 'Z3 fremder Inhaber erfährt etwas über Personalbelege eines anderen Betriebs';
  end if;
  perform pg_temp.zurueck();
  raise notice 'OK  Z1-Z3 fremder Inhaber: keine Auskunft über Zahlungsnachweise oder Personalbelege, auch nicht über deren Existenz';

  -- Z4 Gegenprobe Mitglied im eigenen Betrieb: echte Werte, Lese-Policy wirksam, interne Prüfung gesperrt.
  perform pg_temp.als(pg_temp.mitglied());
  if not public.workspace_document_is_restricted(pg_temp.ws(), 'doc-gls-personal')
     or not public.workspace_file_is_restricted(pg_temp.ws(), 'file-gls-personal')
     or not public.workspace_inbox_item_is_restricted(pg_temp.ws(), 'inbox-gls-personal')
     or not public.workspace_communication_context_is_restricted(pg_temp.ws(), 'document', 'doc-gls-personal')
     or not public.workspace_inbox_item_is_restricted(pg_temp.ws(), 'inbox-gls-ordner')
     or not public.workspace_file_is_restricted(pg_temp.ws(), 'file-gls-ordner')
     or public.workspace_document_is_restricted(pg_temp.ws(), 'doc-gls-inhaber') then
    raise exception 'Z4a Mitglied bekommt nicht die echten Werte der Datenschutz-Helfer';
  end if;
  if not public.is_workspace_document_payment_proof(pg_temp.ws(), 'doc-gls-nachweis')
     or public.is_workspace_document_payment_proof(pg_temp.ws(), 'doc-gls-inhaber') then
    raise exception 'Z4b Mitglied bekommt nicht die echte Zahlungsnachweis-Auskunft';
  end if;
  if exists (select 1 from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-gls-personal')
     or exists (select 1 from public.workspace_files where workspace_id = pg_temp.ws() and client_file_ref_id = 'file-gls-personal') then
    raise exception 'Z4c Mitglied sieht den eigenen, inzwischen geschützten Personalbeleg';
  end if;
  perform pg_temp.erwarte_abweisung('Z4d Mitglied ruft die interne Prüfung', pg_temp.pruefe_sql('assert_document_not_payment_proof', 'doc-gls-nachweis'), 'permission denied', '42501');
  perform pg_temp.zurueck();

  -- Z5 Inhaber: sieht den Personalbeleg; der interne Wächter schützt den Nachweis auf beiden Löschwegen.
  perform pg_temp.als(pg_temp.inhaber());
  if not exists (select 1 from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-gls-personal') then
    raise exception 'Z5a Inhaber sieht den Personalbeleg nicht';
  end if;
  perform pg_temp.erwarte_abweisung('Z5b Zahlungsnachweis bleibt löschgeschützt (Löschweg)',
    pg_temp.loeschen_sql(pg_temp.ws(), 'doc-gls-nachweis'), 'Dokument ist als Zahlungsnachweis verknuepft', null);
  perform pg_temp.erwarte_abweisung('Z5c Zahlungsnachweis bleibt löschgeschützt (Eingangsweg)',
    format('select pg_temp.eingang(%L::jsonb, 1)', pg_temp.archiv('doc-gls-nachweis', 'Nachweis', true)),
    'Dokument ist als Zahlungsnachweis verknuepft', null);
  perform pg_temp.zurueck();

  -- Z6 Ohne Anmeldung: nichts davon aufrufbar.
  perform pg_temp.als_anon();
  perform pg_temp.erwarte_abweisung('Z6a anon, interne Prüfung', pg_temp.pruefe_sql('assert_document_not_payment_proof', 'doc-gls-nachweis'), 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('Z6b anon, Client-Abfrage', pg_temp.pruefe_sql('is_workspace_document_payment_proof', 'doc-gls-nachweis'), 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('Z6c anon, Datenschutz-Helfer', pg_temp.pruefe_sql('workspace_document_is_restricted', 'doc-gls-personal'), 'permission denied', '42501');
  perform pg_temp.zurueck();

  -- Z7 Interne Aufrufe ohne Nutzer (Trigger, Service-Kontext) sehen den echten Wert.
  if not public.workspace_document_is_restricted(pg_temp.ws(), 'doc-gls-personal')
     or not public.workspace_file_is_restricted(pg_temp.ws(), 'file-gls-personal') then
    raise exception 'Z7 interner Aufruf ohne Nutzer verliert den Schutzstatus';
  end if;
  raise notice 'OK  Z4-Z7 Mitglied, Policies, Löschschutz und interne Aufrufe unverändert; anon ausgeschlossen';
end $$;

/* ------------------------------------------------------------------ */
/* G -- Rechte                                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_sig text;
  v_name text;
  v_fehler text := '';
begin
  -- G1 Geänderte und neue Client-RPCs: nur authenticated.
  foreach v_sig in array array[
    'public.tombstone_workspace_document(uuid, text)',
    'public.restore_workspace_document(uuid, text, text)',
    'public.upsert_workspace_intake_entity(uuid, text, jsonb, bigint)',
    'public.update_workspace_invoice_sent(uuid, text, text, text, text)',
    'public.confirm_workspace_invoice_service_period(uuid, text)',
    'public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb)',
    'public.create_workspace_document_delivery_with_context(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean, text, text)',
    'public.create_workspace_document_delivery(uuid, text, text, text, text, text, text, text, text, bigint, text, text, text, uuid, text, boolean)',
    'public.finalize_workspace_offer(uuid, text, jsonb, text, bigint)',
    'public.confirm_workspace_order_amendment(uuid, text, text, jsonb, text, bigint)',
    'public.is_workspace_document_payment_proof(uuid, text)',
    'public.workspace_document_is_restricted(uuid, text)',
    'public.workspace_file_is_restricted(uuid, text)',
    'public.workspace_inbox_item_is_restricted(uuid, text)',
    'public.workspace_communication_context_is_restricted(uuid, text, text)',
    'public.upsert_workspace_sync_entity(uuid, text, jsonb, bigint)'
  ] loop
    if not has_function_privilege('authenticated', v_sig, 'execute')
       or has_function_privilege('anon', v_sig, 'execute')
       or has_function_privilege('service_role', v_sig, 'execute') then
      v_fehler := v_fehler || ' G1:' || v_sig;
    end if;
  end loop;

  -- G2 Prüfspur: nur lesen, nur angemeldet; der Trigger ist niemandem aufrufbar.
  if has_table_privilege('anon', 'public.workspace_document_restorations', 'select')
     or not has_table_privilege('authenticated', 'public.workspace_document_restorations', 'select')
     or has_table_privilege('authenticated', 'public.workspace_document_restorations', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_document_restorations', 'update')
     or has_table_privilege('authenticated', 'public.workspace_document_restorations', 'delete')
     or has_table_privilege('service_role', 'public.workspace_document_restorations', 'insert')
     or has_function_privilege('authenticated', 'public.workspace_document_restorations_immutable()', 'execute') then
    v_fehler := v_fehler || ' G2:workspace_document_restorations';
  end if;

  -- G2b Die Zahlungsnachweis-Prüfung ist nur intern aufrufbar.
  if has_function_privilege('anon', 'public.assert_document_not_payment_proof(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.assert_document_not_payment_proof(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.assert_document_not_payment_proof(uuid, text)', 'execute') then
    v_fehler := v_fehler || ' G2b:assert_document_not_payment_proof';
  end if;

  -- G2c Der Angebotswächter ist niemandem direkt aufrufbar.
  if has_function_privilege('anon', 'public.workspace_offers_status_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_offers_status_guard()', 'execute')
     or has_function_privilege('service_role', 'public.workspace_offers_status_guard()', 'execute') then
    v_fehler := v_fehler || ' G2c:workspace_offers_status_guard';
  end if;

  -- G3 Kein privilegierter Postfach-, OAuth- oder E-Mail-Helfer ist für anon ausführbar.
  for v_name in
    select p.oid::regprocedure::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and (p.proname ~ '(mailbox|oauth|inbound|email)' or p.proname = 'workspace_user_can_write')
  loop
    if has_function_privilege('anon', v_name, 'execute') then
      v_fehler := v_fehler || ' G3:' || v_name;
    end if;
  end loop;

  -- G4 Nur die Service-Rolle (Edge Functions).
  foreach v_name in array array[
    'advance_workspace_mailbox_cursor', 'claim_workspace_email_message_for_send', 'claim_workspace_mailbox_sync',
    'complete_workspace_mailbox_oauth', 'consume_workspace_mailbox_oauth_state', 'create_workspace_mailbox_oauth_state',
    'email_inbound_resolve_assignment', 'email_message_to_jsonb', 'email_resolve_thread', 'fail_workspace_mailbox_oauth',
    'finish_workspace_mailbox_sync', 'get_workspace_email_message_for_send', 'get_workspace_mailbox_credential',
    'import_workspace_inbound_email', 'list_workspace_mailbox_auto_sync_candidates', 'mailbox_auto_sync_secret_valid',
    'mailbox_connection_belongs_to_workspace', 'purge_expired_workspace_mailbox_oauth_states', 'record_email_provider_event',
    'record_workspace_inbound_import_failure', 'resolve_stale_workspace_email_message_claim', 'rotate_workspace_mailbox_credential',
    'set_workspace_mailbox_credential', 'set_workspace_mailbox_source_id', 'update_workspace_email_message_status',
    'workspace_user_can_write'
  ] loop
    select p.oid::regprocedure::text into v_sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = v_name;
    if v_sig is null
       or has_function_privilege('anon', v_sig, 'execute')
       or has_function_privilege('authenticated', v_sig, 'execute')
       or not has_function_privilege('service_role', v_sig, 'execute') then
      v_fehler := v_fehler || ' G4:' || v_name;
    end if;
  end loop;

  -- G5 Nur intern (andere Security-Definer-Funktionen, pg_cron als postgres).
  foreach v_name in array array[
    'email_message_assert_rate_limit', 'email_provider_apply_event', 'email_provider_rematch_after_accept',
    'mailbox_auto_sync_dispatch', 'mailbox_delete_vault_secret', 'mailbox_source_name_allowed',
    'mailbox_upsert_delegated_connection'
  ] loop
    select p.oid::regprocedure::text into v_sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = v_name;
    if v_sig is null
       or has_function_privilege('anon', v_sig, 'execute')
       or has_function_privilege('authenticated', v_sig, 'execute')
       or has_function_privilege('service_role', v_sig, 'execute') then
      v_fehler := v_fehler || ' G5:' || v_name;
    end if;
  end loop;

  -- G6 Client-RPCs des Postfachs: angemeldete Nutzer (Rolle prüft jede Funktion selbst).
  foreach v_name in array array[
    'assign_workspace_inbound_email_message', 'cancel_workspace_mailbox_oauth_pending', 'confirm_workspace_mailbox_oauth_pending',
    'create_workspace_email_message', 'disconnect_workspace_mailbox_connection', 'email_attachment_can_read',
    'email_attachment_can_write', 'get_workspace_email_message_chain', 'get_workspace_email_thread',
    'get_workspace_inbound_email_message', 'get_workspace_mailbox_oauth_pending', 'list_workspace_email_delivery_events',
    'list_workspace_email_messages', 'list_workspace_inbound_email_messages', 'list_workspace_mailbox_connections',
    'retry_workspace_email_message'
  ] loop
    select p.oid::regprocedure::text into v_sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = v_name;
    if v_sig is null
       or has_function_privilege('anon', v_sig, 'execute')
       or not has_function_privilege('authenticated', v_sig, 'execute')
       or has_function_privilege('service_role', v_sig, 'execute') then
      v_fehler := v_fehler || ' G6:' || v_name;
    end if;
  end loop;

  if v_fehler <> '' then
    raise exception 'G Rechte abweichend:%', v_fehler;
  end if;
  raise notice 'OK  G1-G6 Rechte ausdrücklich: Client-RPCs nur authenticated, Helfer nur service_role oder intern, nichts für anon';
end $$;

/* ------------------------------------------------------------------ */
/* G7 -- Aufrufketten der Service-Rolle laufen weiter                  */
/* ------------------------------------------------------------------ */

-- Die Edge Functions rufen als service_role (ohne Nutzer-Claims). Die
-- Rechte reichen: Aufruf ohne Rechtefehler, fachliche Antwort unverändert.
do $$
declare
  v boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  v := public.workspace_user_can_write(pg_temp.ws(), pg_temp.inhaber());
  if not v then raise exception 'G7a Inhaber muss schreiben dürfen'; end if;
  v := public.workspace_user_can_write(pg_temp.ws(), pg_temp.mitglied());
  if v then raise exception 'G7b Mitglied darf nicht schreiben'; end if;
  v := public.mailbox_connection_belongs_to_workspace(gen_random_uuid(), pg_temp.ws());
  if v then raise exception 'G7c unbekanntes Postfach gehört zu keinem Workspace'; end if;
  perform public.list_workspace_mailbox_auto_sync_candidates(1);
  perform public.purge_expired_workspace_mailbox_oauth_states(interval '7 days');
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  raise notice 'OK  G7 Aufrufketten der Service-Rolle (Rechteprüfung, Postfachzuordnung, Auto-Sync, Aufräumen) laufen';
end $$;

rollback;
