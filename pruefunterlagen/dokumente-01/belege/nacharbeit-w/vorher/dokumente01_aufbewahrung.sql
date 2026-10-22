-- DOKUMENTE-01 / D-017 -- Vertragstest Aufbewahrung und Löschschutz (20261125120000).
--
--   V  Regel: dieselben Vektoren wie der Client (documentRetentionVectors.ts).
--   A  Grabstein über tombstone_workspace_document: während der Frist nein, für
--      Inhaber und Admin; „prüfen", rechnerisch abgelaufen und Rechnungsentwurf ja.
--   B  Grabstein über den Eingangsweg: dasselbe; normale Bearbeitung bleibt.
--   C  Keine Abschwächung der Einstufung während der Frist (Kategorie, Art),
--      Aufwertung ja; eine veränderte Nutzlast verkürzt die Frist nicht.
--   D  Ausgabenbeleg und Korrekturbeleg sind Buchungsbelege, unabhängig von der Art.
--   E  Original und Datei eines geschützten Dokuments bleiben; Vorschau und
--      Dateien ungeschützter Dokumente nicht.
--   F  Kein Weg vorbei: auch ein direktes UPDATE scheitert; Wiederherstellung frei,
--      danach gilt der Schutz wieder.
--   G  Rechte: alle neuen Funktionen intern.
--
-- Jede Prüfung läuft als Rolle authenticated mit den Claims des Nutzers --
-- RLS und Funktionsrechte greifen wie bei einem echten Client. Zustände werden
-- danach als postgres nachgelesen.
--
-- Ausführen (nur lokal, niemals --linked oder remote), mit der Migration in
-- derselben Transaktion:
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261125120000_dokumente01_aufbewahrung.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/dokumente01_aufbewahrung.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Exit-Code 0 = alle Zusicherungen erfüllt. Alles wird zurückgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

/* ------------------------------------------------------------------ */
/* V — die Regel                                                       */
/* ------------------------------------------------------------------ */

create temp table aufbewahrung_vektoren (
  name text,
  rechnungsbeleg text,
  classified_kind text,
  category text,
  ausgabenbeleg boolean,
  zahlungsnachweis boolean,
  dates text[],
  fallback_year integer,
  heute date,
  e_klasse text,
  e_grund text,
  e_jahre integer,
  e_bezugsjahr integer,
  e_frist_ende date,
  e_status text
) on commit drop;

-- VEKTOREN-ANFANG
insert into aufbewahrung_vektoren values
  ('eingangsrechnung-2026', null, 'eingangsrechnung', null, false, false, array['2026-03-15', null, null, '2026-03-16T08:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2026, '2034-12-31', 'laeuft'),
  ('quittung-2016-abgelaufen', null, 'quittung', null, false, false, array['2016-05-01', null, null, '2016-05-02T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2016, '2024-12-31', 'abgelaufen'),
  ('grenze-letzter-tag-berlin', null, 'tankbeleg', null, false, false, array[null, '2018-07-01', null, '2018-07-02T10:00:00.000Z']::text[], 2026, '2026-12-31', 'buchungsbeleg', 'belegart', 8, 2018, '2026-12-31', 'laeuft'),
  ('grenze-erster-tag-danach-berlin', null, 'tankbeleg', null, false, false, array[null, '2018-07-01', null, '2018-07-02T10:00:00.000Z']::text[], 2027, '2027-01-01', 'buchungsbeleg', 'belegart', 8, 2018, '2026-12-31', 'abgelaufen'),
  ('spaetere-erfassung-gewinnt', null, 'rechnung', null, false, false, array['2025-12-30', null, '2026-01-05T08:00:00.000Z', null]::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2026, '2034-12-31', 'laeuft'),
  ('silvesterabend-zaehlt-berliner-jahr', null, 'kassenbeleg', null, false, false, array[null, '2026-12-31', null, '2026-12-31T23:30:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2027, '2035-12-31', 'laeuft'),
  ('zeitstempel-ohne-zone-gilt-als-utc', null, 'kontoauszug', null, false, false, array[null, null, null, '2026-12-31T23:30:00']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2027, '2035-12-31', 'laeuft'),
  ('zeitstempel-mit-versatz', null, 'kontoauszug', null, false, false, array[null, null, null, '2026-12-31T23:30:00-01:00']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2027, '2035-12-31', 'laeuft'),
  ('ungueltiges-datum-zaehlt-nicht', null, 'ec_beleg', null, false, false, array[null, '2026-02-30', null, '2020-01-10T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2020, '2028-12-31', 'laeuft'),
  ('schalttag-gilt', null, 'quittung', null, false, false, array['2024-02-29', null, null, '2019-03-01T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2024, '2032-12-31', 'laeuft'),
  ('unplausibles-jahr-zaehlt-nicht', null, 'kreditkartenbeleg', null, false, false, array['3026-01-01', null, null, '2024-04-04T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2024, '2032-12-31', 'laeuft'),
  ('deutsches-datumsformat-zaehlt-nicht', null, 'reparaturrechnung', null, false, false, array[null, '15.03.2019', null, '2021-03-16T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2021, '2029-12-31', 'laeuft'),
  ('ohne-lesbares-datum-ab-heute', null, 'gutschrift', null, false, false, array[null, null, null, null]::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2026, '2034-12-31', 'laeuft'),
  ('kategorie-ausgangsrechnung-ohne-art', null, null, 'ausgangsrechnung', false, false, array[null, null, null, '2025-02-01T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2025, '2033-12-31', 'laeuft'),
  ('art-gross-geschrieben-und-mit-leerzeichen', null, ' Rechnung ', null, false, false, array[null, null, null, '2025-02-01T09:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'belegart', 8, 2025, '2033-12-31', 'laeuft'),
  ('erzeugte-rechnung-festgeschrieben', 'festgeschrieben', 'ausgangsrechnung', 'ausgangsrechnung', false, false, array[null, '2026-08-24', null, '2026-08-24T10:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'rechnungsbeleg', 8, 2026, '2034-12-31', 'laeuft'),
  ('erzeugte-rechnung-entwurf', 'offen', 'ausgangsrechnung', 'ausgangsrechnung', false, false, array[null, '2026-08-24', null, '2026-08-24T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'rechnung_nicht_festgeschrieben', null, null, null, 'pruefen'),
  ('korrekturbeleg', 'korrektur', 'rechnungskorrektur', null, false, false, array[null, null, null, '2026-09-01T10:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'rechnungsbeleg', 8, 2026, '2034-12-31', 'laeuft'),
  ('zahlungsnachweis-als-foto', null, 'foto', null, false, true, array[null, null, null, '2026-05-05T10:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'zahlungsnachweis', 8, 2026, '2034-12-31', 'laeuft'),
  ('ausgabenbeleg-ohne-art', null, 'sonstiges', null, true, false, array[null, null, null, '2026-05-05T10:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'ausgabenbeleg', 8, 2026, '2034-12-31', 'laeuft'),
  ('ausgabenbeleg-schlaegt-geschaeftsbrief', null, 'auftrag', null, true, false, array[null, null, null, '2026-05-05T10:00:00.000Z']::text[], 2026, '2026-10-20', 'buchungsbeleg', 'ausgabenbeleg', 8, 2026, '2034-12-31', 'laeuft'),
  ('auftragsbestaetigung-2021', null, 'auftragsbestaetigung', null, false, false, array['2021-04-01', null, null, '2021-04-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'geschaeftsbrief', 'geschaeftsbrief', 6, 2021, '2027-12-31', 'laeuft'),
  ('mahnung-2019-abgelaufen', null, 'mahnung', null, false, false, array['2019-11-11', null, null, '2019-11-12T10:00:00.000Z']::text[], 2026, '2026-10-20', 'geschaeftsbrief', 'geschaeftsbrief', 6, 2019, '2025-12-31', 'abgelaufen'),
  ('werkvertrag-2026', null, 'werkvertrag', null, false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'geschaeftsbrief', 'geschaeftsbrief', 6, 2026, '2032-12-31', 'laeuft'),
  ('angebot-pruefen', null, 'angebot', null, false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('lieferschein-pruefen', null, 'lieferschein', null, false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('lohnabrechnung-pruefen', null, 'lohnabrechnung', null, false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('arbeitsvertrag-pruefen', null, 'arbeitsvertrag', 'personal', false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('steuerbescheid-pruefen', null, 'steuerbescheid', 'steuer', false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('kategorie-vertrag-ohne-art-pruefen', null, null, 'vertrag', false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('kategorie-steuer-sonstiges-pruefen', null, 'sonstiges', 'steuer', false, false, array[null, null, null, '2026-02-02T10:00:00.000Z']::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen'),
  ('ohne-angaben-pruefen', null, null, null, false, false, array[null, null, null, null]::text[], 2026, '2026-10-20', 'pruefen', 'keine_feste_regel', null, null, null, 'pruefen');
-- VEKTOREN-ENDE

do $v$
declare
  v record;
  r record;
  v_anzahl integer := 0;
begin
  for v in select * from aufbewahrung_vektoren loop
    select * into r from public.workspace_retention_rule(
      v.rechnungsbeleg, v.classified_kind, v.category, v.ausgabenbeleg, v.zahlungsnachweis,
      v.dates, v.fallback_year, v.heute);
    if r.klasse is distinct from v.e_klasse
       or r.grund is distinct from v.e_grund
       or r.jahre is distinct from v.e_jahre
       or r.bezugsjahr is distinct from v.e_bezugsjahr
       or r.frist_ende is distinct from v.e_frist_ende
       or r.frist_status is distinct from v.e_status then
      raise exception 'V % -- Server: % % % % % %, erwartet: % % % % % %', v.name,
        r.klasse, r.grund, r.jahre, r.bezugsjahr, r.frist_ende, r.frist_status,
        v.e_klasse, v.e_grund, v.e_jahre, v.e_bezugsjahr, v.e_frist_ende, v.e_status;
    end if;
    v_anzahl := v_anzahl + 1;
  end loop;
  if v_anzahl < 30 then
    raise exception 'V -- nur % Vektoren geprüft', v_anzahl;
  end if;
  raise notice 'V  % Regelvektoren wie im Client', v_anzahl;
end;
$v$;

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from (values
  ('00000000-0000-0000-0000-0000000d0101'::uuid, 'inhaber-dok01@example.invalid'),
  ('00000000-0000-0000-0000-0000000d0102'::uuid, 'admin-dok01@example.invalid'),
  ('00000000-0000-0000-0000-0000000d0103'::uuid, 'mitglied-dok01@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-0000000d0101'::uuid, '00000000-0000-0000-0000-0000000d0102'::uuid,
             '00000000-0000-0000-0000-0000000d0103'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000d01a1'::uuid, 'DOK01 Aufbewahrung', '00000000-0000-0000-0000-0000000d0101'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000d01a1'::uuid, '00000000-0000-0000-0000-0000000d0101'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000d01a1'::uuid, '00000000-0000-0000-0000-0000000d0102'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000d01a1'::uuid, '00000000-0000-0000-0000-0000000d0103'::uuid, 'member', 'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d01a1'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d0101'::uuid $p$;
create function pg_temp.admin() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d0102'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000d0103'::uuid $p$;

-- Rechnungen: ein Entwurf (sein Beleg ist noch keiner) und eine versendete.
insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values (pg_temp.ws(), null, 'inv-dok01-entwurf', '2026-9601', 2026, 9601, 'rechnung', 'entwurf', '{}'::jsonb);

/** Ein Archivdokument mit dieser Nutzlast; `p_angelegt` ist die Serveranlage. */
create function pg_temp.archiv(p_id text, p_payload jsonb, p_angelegt timestamptz default now())
returns void language sql as $p$
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by, created_at)
  values (pg_temp.ws(), p_id, 'archived_document', jsonb_build_object('id', p_id, 'title', p_id) || p_payload,
          pg_temp.inhaber(), p_angelegt);
$p$;

select pg_temp.archiv('doc-dok01-rechnung', '{"classifiedKind":"eingangsrechnung","createdAt":"2026-03-16T08:00:00.000Z"}');
select pg_temp.archiv('doc-dok01-rechnung-b', '{"classifiedKind":"eingangsrechnung","createdAt":"2026-03-16T08:00:00.000Z"}');
select pg_temp.archiv('doc-dok01-alt', '{"classifiedKind":"quittung","documentDate":"2016-05-01","createdAt":"2016-05-02T09:00:00.000Z"}',
                      '2016-05-02 09:00:00+00');
select pg_temp.archiv('doc-dok01-alt-b', '{"classifiedKind":"quittung","documentDate":"2016-05-01","createdAt":"2016-05-02T09:00:00.000Z"}',
                      '2016-05-02 09:00:00+00');
select pg_temp.archiv('doc-dok01-pruefen', '{"classifiedKind":"sonstiges","category":"sonstiges"}');
select pg_temp.archiv('doc-dok01-pruefen-b', '{"classifiedKind":"sonstiges","category":"sonstiges"}');
select pg_temp.archiv('doc-dok01-kategorie', '{"category":"ausgangsrechnung"}');
select pg_temp.archiv('doc-dok01-auftrag', '{"classifiedKind":"auftragsbestaetigung"}');
select pg_temp.archiv('doc-dok01-ausgabe', '{"classifiedKind":"foto","category":"sonstiges"}');
select pg_temp.archiv('doc-dok01-eingang', '{"classifiedKind":"foto","sourceInboxItemId":"inbox-dok01-eingang"}');
-- Altbestand: vor dieser Migration gelöscht. Nachträglich ginge das nicht mehr (F1).
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, created_by,
                                        deleted, deleted_at, deleted_by)
values (pg_temp.ws(), 'doc-dok01-zurueck', 'archived_document',
        '{"id":"doc-dok01-zurueck","title":"Zurück","classifiedKind":"eingangsrechnung"}'::jsonb, pg_temp.inhaber(),
        true, now(), pg_temp.inhaber());

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values (pg_temp.ws(), 'doc-dok01-g-entwurf', 'generated_invoice', 'inv-dok01-entwurf',
        '{"id":"doc-dok01-g-entwurf","category":"ausgangsrechnung","classifiedKind":"ausgangsrechnung","linkedInvoiceId":"inv-dok01-entwurf"}'::jsonb,
        pg_temp.inhaber()),
       -- Kuenstlich: Korrekturbeleg an einem Entwurf. Der Rechnungsschutz greift nicht, die Aufbewahrung schon.
       (pg_temp.ws(), 'doc-dok01-g-korrektur', 'generated_invoice_correction', 'inv-dok01-entwurf',
        '{"id":"doc-dok01-g-korrektur","classifiedKind":"rechnungskorrektur"}'::jsonb, pg_temp.inhaber());

-- Ausgaben: Beleg ueber die eigene Verknuepfung und ueber den gemeinsamen Eingang.
insert into public.workspace_expenses (workspace_id, client_expense_id, status, archive_document_id, linked_inbox_id, payload, created_by)
values (pg_temp.ws(), 'exp-dok01-1', 'gebucht', 'doc-dok01-ausgabe', null, '{}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(), 'exp-dok01-2', 'gebucht', null, 'inbox-dok01-eingang', '{}'::jsonb, pg_temp.inhaber());

-- Dateien und Bindungen.
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by)
select pg_temp.ws(), f.id, f.hash, 100, 'application/pdf', pg_temp.ws()::text || '/' || f.hash, pg_temp.inhaber()
from (values
  ('file-dok01-rechnung', repeat('a', 64)),
  ('file-dok01-vorschau', repeat('b', 64)),
  ('file-dok01-pruefen', repeat('c', 64))
) as f(id, hash);

insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, provenance, created_by)
values (pg_temp.ws(), 'doc-dok01-rechnung', 'file-dok01-rechnung', 'original', 'received', pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-dok01-rechnung', 'file-dok01-vorschau', 'preview', 'derived', pg_temp.inhaber()),
       (pg_temp.ws(), 'doc-dok01-pruefen-b', 'file-dok01-pruefen', 'original', 'received', pg_temp.inhaber());

/** Als dieser Nutzer -- Rolle authenticated, damit RLS und Funktionsrechte greifen. */
create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
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
    raise notice 'ABGEWIESEN  %', p_label;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.dok(p_id text) returns public.workspace_documents language sql as $p$
  select * from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = p_id;
$p$;

create function pg_temp.lebt(p_id text) returns boolean language sql as $p$
  select not d.deleted and d.deleted_at is null from public.workspace_documents d
  where d.workspace_id = pg_temp.ws() and d.client_document_id = p_id;
$p$;

create function pg_temp.pruefe(p_label text, p_ok boolean) returns void language plpgsql as $p$
begin
  if not coalesce(p_ok, false) then
    raise exception '% -- Zusicherung verletzt', p_label;
  end if;
  raise notice 'OK  %', p_label;
end;
$p$;

create function pg_temp.loeschen_sql(p_id text) returns text language sql immutable as $p$
  select format('select public.tombstone_workspace_document(%L, %L)', pg_temp.ws(), p_id);
$p$;

/** Der Eingangsweg, wie ihn der Sync aufruft. */
create function pg_temp.eingang_sql(p_typ text, p_payload jsonb, p_version bigint) returns text language sql immutable as $p$
  select format('select public.upsert_workspace_intake_entity(%L, %L, %L::jsonb, %s)', pg_temp.ws(), p_typ, p_payload, p_version);
$p$;

/** Ein Archivdokument für den Eingangsweg: Nutzlast wie gespeichert, geändert um p_aenderung. */
create function pg_temp.archiv_push(p_id text, p_aenderung jsonb, p_geloescht boolean) returns jsonb language sql as $p$
  select jsonb_build_object('client_document_id', p_id, 'deleted', p_geloescht,
    'payload', (select d.payload from public.workspace_documents d
                where d.workspace_id = pg_temp.ws() and d.client_document_id = p_id) || p_aenderung);
$p$;

create function pg_temp.version(p_id text) returns bigint language sql as $p$
  select d.row_version from public.workspace_documents d where d.workspace_id = pg_temp.ws() and d.client_document_id = p_id;
$p$;

/* ------------------------------------------------------------------ */
/* A — tombstone_workspace_document                                    */
/* ------------------------------------------------------------------ */

select pg_temp.als(pg_temp.inhaber());
select pg_temp.erwarte_abweisung('A1 Inhaber: Eingangsrechnung während der Frist',
  pg_temp.loeschen_sql('doc-dok01-rechnung'), 'Aufbewahrungsfrist laeuft bis 31.12.2034', '42501');
select pg_temp.zurueck();
select pg_temp.als(pg_temp.admin());
select pg_temp.erwarte_abweisung('A2 Admin: ebenso',
  pg_temp.loeschen_sql('doc-dok01-rechnung'), 'Aufbewahrungsfrist laeuft bis 31.12.2034', '42501');
select pg_temp.zurueck();
select pg_temp.als(pg_temp.mitglied());
select pg_temp.erwarte_abweisung('A3 Mitglied: Rollenabweisung wie bisher',
  pg_temp.loeschen_sql('doc-dok01-rechnung'), 'Keine Schreibberechtigung', '42501');
select pg_temp.zurueck();
select pg_temp.pruefe('A4 die Eingangsrechnung lebt unverändert',
  pg_temp.lebt('doc-dok01-rechnung') and pg_temp.version('doc-dok01-rechnung') = 1
  and (pg_temp.dok('doc-dok01-rechnung')).deleted_by is null);

select pg_temp.als(pg_temp.inhaber());
select public.tombstone_workspace_document(pg_temp.ws(), 'doc-dok01-pruefen');
select public.tombstone_workspace_document(pg_temp.ws(), 'doc-dok01-alt');
select public.tombstone_workspace_document(pg_temp.ws(), 'doc-dok01-g-entwurf');
select pg_temp.zurueck();
select pg_temp.pruefe('A5 „prüfen", rechnerisch abgelaufen und Rechnungsentwurf: gelöscht',
  not pg_temp.lebt('doc-dok01-pruefen') and not pg_temp.lebt('doc-dok01-alt')
  and (pg_temp.dok('doc-dok01-g-entwurf')).deleted_at is not null);

/* ------------------------------------------------------------------ */
/* B — Eingangsweg                                                     */
/* ------------------------------------------------------------------ */

select pg_temp.als(pg_temp.inhaber());
select pg_temp.erwarte_abweisung('B1 Grabstein über den Eingangsweg während der Frist',
  pg_temp.eingang_sql('archived_document', pg_temp.archiv_push('doc-dok01-rechnung-b', '{}', true), 1),
  'Aufbewahrungsfrist laeuft bis 31.12.2034', '42501');
select pg_temp.zurueck();
select pg_temp.pruefe('B2 das Dokument lebt, Version unverändert',
  pg_temp.lebt('doc-dok01-rechnung-b') and pg_temp.version('doc-dok01-rechnung-b') = 1);

select pg_temp.als(pg_temp.inhaber());
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document',
  pg_temp.archiv_push('doc-dok01-rechnung-b', '{"title":"Neuer Titel"}', false), 1);
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document',
  pg_temp.archiv_push('doc-dok01-alt-b', '{}', true), 1);
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document',
  pg_temp.archiv_push('doc-dok01-pruefen-b', '{}', true), 1);
select pg_temp.zurueck();
select pg_temp.pruefe('B3 Bearbeitung bleibt möglich, abgelaufen und „prüfen" werden gelöscht',
  (pg_temp.dok('doc-dok01-rechnung-b')).payload->>'title' = 'Neuer Titel'
  and pg_temp.version('doc-dok01-rechnung-b') = 2
  and not pg_temp.lebt('doc-dok01-alt-b') and not pg_temp.lebt('doc-dok01-pruefen-b'));

/* ------------------------------------------------------------------ */
/* C — keine Abschwächung während der Frist                            */
/* ------------------------------------------------------------------ */

select pg_temp.als(pg_temp.inhaber());
select pg_temp.erwarte_abweisung('C1 Kategorie Ausgangsrechnung → Sonstiges',
  pg_temp.eingang_sql('archived_document', pg_temp.archiv_push('doc-dok01-kategorie', '{"category":"sonstiges"}', false), 1),
  'kann nicht abgeschwaecht werden', '42501');
select pg_temp.erwarte_abweisung('C2 Art Eingangsrechnung → Sonstiges',
  pg_temp.eingang_sql('archived_document', pg_temp.archiv_push('doc-dok01-rechnung-b', '{"classifiedKind":"sonstiges"}', false), 2),
  'kann nicht abgeschwaecht werden', '42501');
-- Aufwertung vom Geschäftsbrief zum Buchungsbeleg: erlaubt.
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document',
  pg_temp.archiv_push('doc-dok01-auftrag', '{"classifiedKind":"rechnung"}', false), 1);
select pg_temp.erwarte_abweisung('C3 und zurück zum Geschäftsbrief: Abschwächung',
  pg_temp.eingang_sql('archived_document', pg_temp.archiv_push('doc-dok01-auftrag', '{"classifiedKind":"auftrag"}', false), 2),
  'kann nicht abgeschwaecht werden', '42501');
-- Alte Daten in der Nutzlast: Die Serveranlage hält die Frist.
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'archived_document',
  pg_temp.archiv_push('doc-dok01-rechnung-b',
    '{"documentDate":"2010-01-01","issueDate":"2010-01-01","uploadedAt":"2010-01-01T00:00:00Z","createdAt":"2010-01-01T00:00:00Z"}', false), 2);
select pg_temp.erwarte_abweisung('C4 rückdatierte Nutzlast verkürzt die Frist nicht',
  pg_temp.loeschen_sql('doc-dok01-rechnung-b'), 'Aufbewahrungsfrist laeuft bis 31.12.2034', '42501');
select pg_temp.zurueck();
select pg_temp.pruefe('C5 Einstufungen unverändert, Aufwertung angekommen',
  (pg_temp.dok('doc-dok01-kategorie')).payload->>'category' = 'ausgangsrechnung'
  and (pg_temp.dok('doc-dok01-auftrag')).payload->>'classifiedKind' = 'rechnung'
  and (pg_temp.dok('doc-dok01-rechnung-b')).payload->>'classifiedKind' = 'eingangsrechnung'
  and pg_temp.lebt('doc-dok01-rechnung-b'));

/* ------------------------------------------------------------------ */
/* D — Ausgabenbeleg und Korrekturbeleg                                */
/* ------------------------------------------------------------------ */

select pg_temp.als(pg_temp.inhaber());
select pg_temp.erwarte_abweisung('D1 Beleg einer Ausgabe (eigene Verknüpfung), Art Foto',
  pg_temp.loeschen_sql('doc-dok01-ausgabe'), 'Aufbewahrungsfrist laeuft', '42501');
select pg_temp.erwarte_abweisung('D2 Beleg einer Ausgabe (gemeinsamer Eingang)',
  pg_temp.loeschen_sql('doc-dok01-eingang'), 'Aufbewahrungsfrist laeuft', '42501');
select pg_temp.erwarte_abweisung('D3 Korrekturbeleg, auch ohne festgeschriebene Rechnung',
  pg_temp.loeschen_sql('doc-dok01-g-korrektur'), 'Aufbewahrungsfrist laeuft', '42501');
select pg_temp.zurueck();
select pg_temp.pruefe('D4 alle drei leben',
  pg_temp.lebt('doc-dok01-ausgabe') and pg_temp.lebt('doc-dok01-eingang')
  and (pg_temp.dok('doc-dok01-g-korrektur')).deleted_at is null);

/* ------------------------------------------------------------------ */
/* E — Original und Datei                                              */
/* ------------------------------------------------------------------ */

select pg_temp.als(pg_temp.inhaber());
select pg_temp.erwarte_abweisung('E1 Original-Bindung eines geschützten Dokuments',
  pg_temp.eingang_sql('document_file_binding', jsonb_build_object(
    'binding_id', 'doc-dok01-rechnung|original|', 'client_document_id', 'doc-dok01-rechnung',
    'client_file_ref_id', 'file-dok01-rechnung', 'binding_kind', 'original', 'provenance', 'received',
    'deleted', true), 1),
  'Original eines Dokuments mit Aufbewahrungsfrist', '42501');
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'document_file_binding', jsonb_build_object(
  'binding_id', 'doc-dok01-rechnung|preview|', 'client_document_id', 'doc-dok01-rechnung',
  'client_file_ref_id', 'file-dok01-vorschau', 'binding_kind', 'preview', 'provenance', 'derived',
  'deleted', true), 1);
select pg_temp.erwarte_abweisung('E2 Datei eines geschützten Dokuments',
  pg_temp.eingang_sql('document_file', jsonb_build_object(
    'client_file_ref_id', 'file-dok01-rechnung', 'content_sha256', repeat('a', 64),
    'size_bytes', 100, 'mime_type', 'application/pdf', 'deleted', true), 1),
  'Datei eines Dokuments mit Aufbewahrungsfrist', '42501');
-- Das Dokument von doc-dok01-pruefen-b ist schon gelöscht (B3): Bindung und Datei sind frei.
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'document_file_binding', jsonb_build_object(
  'binding_id', 'doc-dok01-pruefen-b|original|', 'client_document_id', 'doc-dok01-pruefen-b',
  'client_file_ref_id', 'file-dok01-pruefen', 'binding_kind', 'original', 'provenance', 'received',
  'deleted', true), 1);
select public.upsert_workspace_intake_entity(pg_temp.ws(), 'document_file', jsonb_build_object(
  'client_file_ref_id', 'file-dok01-pruefen', 'content_sha256', repeat('c', 64),
  'size_bytes', 100, 'mime_type', 'application/pdf', 'deleted', true), 1);
select pg_temp.zurueck();
select pg_temp.pruefe('E3 Original und Datei leben, Vorschau und freie Datei gelöscht',
  exists (select 1 from public.workspace_document_file_bindings b where b.workspace_id = pg_temp.ws()
          and b.client_document_id = 'doc-dok01-rechnung' and b.binding_kind = 'original' and not b.deleted)
  and exists (select 1 from public.workspace_document_file_bindings b where b.workspace_id = pg_temp.ws()
          and b.client_document_id = 'doc-dok01-rechnung' and b.binding_kind = 'preview' and b.deleted)
  and exists (select 1 from public.workspace_files f where f.workspace_id = pg_temp.ws()
          and f.client_file_ref_id = 'file-dok01-rechnung' and not f.deleted)
  and exists (select 1 from public.workspace_files f where f.workspace_id = pg_temp.ws()
          and f.client_file_ref_id = 'file-dok01-pruefen' and f.deleted));

/* ------------------------------------------------------------------ */
/* F — kein Weg vorbei                                                 */
/* ------------------------------------------------------------------ */

select pg_temp.erwarte_abweisung('F1 direktes UPDATE als postgres',
  $q$update public.workspace_documents set deleted = true, deleted_at = now()
     where workspace_id = '00000000-0000-0000-0000-0000000d01a1' and client_document_id = 'doc-dok01-rechnung'$q$,
  'Aufbewahrungsfrist laeuft', '42501');
select pg_temp.erwarte_abweisung('F2 direktes Beerdigen der Original-Bindung als postgres',
  $q$update public.workspace_document_file_bindings set deleted = true, deleted_at = now()
     where workspace_id = '00000000-0000-0000-0000-0000000d01a1' and client_document_id = 'doc-dok01-rechnung'
       and binding_kind = 'original'$q$,
  'Original eines Dokuments mit Aufbewahrungsfrist', '42501');

select pg_temp.als(pg_temp.inhaber());
select public.restore_workspace_document(pg_temp.ws(), 'doc-dok01-zurueck', 'Versehentlich gelöscht (DOK01-Test)');
select pg_temp.erwarte_abweisung('F3 nach der Wiederherstellung gilt der Schutz wieder',
  pg_temp.loeschen_sql('doc-dok01-zurueck'), 'Aufbewahrungsfrist laeuft', '42501');
select pg_temp.zurueck();
select pg_temp.pruefe('F4 wiederhergestellt und lebend', pg_temp.lebt('doc-dok01-zurueck'));

/* ------------------------------------------------------------------ */
/* G — Rechte                                                          */
/* ------------------------------------------------------------------ */

do $g$
declare
  v_funktion text;
  v_rolle text;
begin
  foreach v_funktion in array array[
    'public.workspace_retention_year(text)',
    'public.workspace_retention_rule(text, text, text, boolean, boolean, text[], integer, date)',
    'public.workspace_document_retention(public.workspace_documents)',
    'public.workspace_documents_retention_guard()',
    'public.workspace_document_file_bindings_retention_guard()',
    'public.workspace_files_retention_guard()'
  ] loop
    foreach v_rolle in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if v_rolle = 'public' then
        if exists (
          select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where p.oid = v_funktion::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
        ) then
          raise exception 'G % -- EXECUTE für public', v_funktion;
        end if;
      elsif has_function_privilege(v_rolle, v_funktion, 'execute') then
        raise exception 'G % -- EXECUTE für %', v_funktion, v_rolle;
      end if;
    end loop;
  end loop;
  raise notice 'OK  G neue Funktionen nur intern';
end;
$g$;

rollback;
