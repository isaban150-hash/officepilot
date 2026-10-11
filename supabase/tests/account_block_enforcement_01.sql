-- GO-LIVE-SECURITY-01 / KONTOSPERRE -- Vertragstest für
-- 20261109120000_account_block_enforcement.sql.
--
-- Befund WEISS (Gesamtabnahme): Ein Admin mit profiles.status = 'blocked' las weiter
-- Archivdaten und führte tombstone_workspace_document aus; can_write_workspace lieferte
-- true. Ursache: Die Mitgliedschaftshelfer prüften nur workspace_members, die
-- Kontosperre galt allein in assert_financial_action_allowed.
--
--   K1  Helfer: gesperrte Konten sind kein aktives Mitglied, haben keine Rolle und kein
--       Schreibrecht (auch nicht über die Edge-Brücke workspace_user_can_write).
--   K2  Lesen: Tabellen-RLS, Speicher-Lesebrücke und Speicherobjekte, Security-Definer-Abzüge.
--   K3  Löschen und Wiederherstellen im Archiv.
--   K4  Eingang und Synchronisation (Mitglied gesperrt).
--   K5  Finanzaktionen: weiterhin finance_account_blocked.
--   K6  Mehrere Firmen: gesperrter Admin in Firma B, gesperrter Inhaber von Firma B.
--   K7  Bestehende Sitzung: Sperre und Entsperren wirken beim nächsten Aufruf.
--   K8  Plattform-Admin gesperrt: keine Admin-Funktionen, kein Selbst-Entsperren.
--   K9  Betriebsbindung: ensure_personal_workspace / get_active_workspace.
--   K10 Mailbox-OAuth-Zwischenstand.
--   K11 Abgrenzung: abgelaufene Lizenz ist keine Kontosperre (Lesen bleibt).
--   K12 Rechte der neuen Hilfsfunktion.
--
-- Vor der Migration scheitert der Test an K1 (Nachweis des Befunds); danach Exit 0.
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/account_block_enforcement_01.sql
-- Alles wird zurückgerollt.
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
  ('00000000-0000-0000-0000-000000d0b001'::uuid, 'inhaber-sperre@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b002'::uuid, 'admin-sperre-ok@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b003'::uuid, 'admin-gesperrt@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b004'::uuid, 'mitglied-sperre-ok@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b005'::uuid, 'mitglied-gesperrt@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b006'::uuid, 'inhaber-b-gesperrt@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b007'::uuid, 'plattform-admin-ok@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b008'::uuid, 'plattform-admin-gesperrt@example.invalid'),
  ('00000000-0000-0000-0000-000000d0b009'::uuid, 'admin-lizenz-abgelaufen@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null, role = 'user'
where id::text like '00000000-0000-0000-0000-000000d0b00%';
update public.profiles set status = 'blocked'
where id in ('00000000-0000-0000-0000-000000d0b003'::uuid, '00000000-0000-0000-0000-000000d0b005'::uuid,
             '00000000-0000-0000-0000-000000d0b006'::uuid, '00000000-0000-0000-0000-000000d0b008'::uuid);
update public.profiles set role = 'admin'
where id in ('00000000-0000-0000-0000-000000d0b007'::uuid, '00000000-0000-0000-0000-000000d0b008'::uuid);
update public.profiles set license_status = 'expired' where id = '00000000-0000-0000-0000-000000d0b009'::uuid;

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000d0ba01'::uuid, 'Sperre A', '00000000-0000-0000-0000-000000d0b001'::uuid),
       ('00000000-0000-0000-0000-000000d0bb01'::uuid, 'Sperre B', '00000000-0000-0000-0000-000000d0b006'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000d0ba01'::uuid, '00000000-0000-0000-0000-000000d0b001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-000000d0ba01'::uuid, '00000000-0000-0000-0000-000000d0b002'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000d0ba01'::uuid, '00000000-0000-0000-0000-000000d0b003'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000d0ba01'::uuid, '00000000-0000-0000-0000-000000d0b004'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-000000d0ba01'::uuid, '00000000-0000-0000-0000-000000d0b005'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-000000d0ba01'::uuid, '00000000-0000-0000-0000-000000d0b009'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-000000d0bb01'::uuid, '00000000-0000-0000-0000-000000d0b006'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-000000d0bb01'::uuid, '00000000-0000-0000-0000-000000d0b003'::uuid, 'admin',  'active');

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0ba01'::uuid $p$;
create function pg_temp.ws_b() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0bb01'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b001'::uuid $p$;
create function pg_temp.admin_ok() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b002'::uuid $p$;
create function pg_temp.admin_gesperrt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b003'::uuid $p$;
create function pg_temp.mitglied_ok() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b004'::uuid $p$;
create function pg_temp.mitglied_gesperrt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b005'::uuid $p$;
create function pg_temp.inhaber_b_gesperrt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b006'::uuid $p$;
create function pg_temp.padmin_ok() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b007'::uuid $p$;
create function pg_temp.padmin_gesperrt() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b008'::uuid $p$;
create function pg_temp.admin_lizenz() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-000000d0b009'::uuid $p$;
create function pg_temp.pfad(p_ws uuid, p_h text) returns text language sql immutable as $p$ select p_ws::text || '/' || repeat(p_h, 64) $p$;

-- Archiv: je Firma Dokumente, Datei, Bindung, Speicherobjekt; eine Rechnung in A.
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload, created_by)
values (pg_temp.ws(),   'doc-k-a1', 'archived_document', null, '{"id":"doc-k-a1","title":"Archiv A1"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(),   'doc-k-a2', 'archived_document', null, '{"id":"doc-k-a2","title":"Archiv A2"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws(),   'doc-k-a3', 'archived_document', null, '{"id":"doc-k-a3","title":"Archiv A3"}'::jsonb, pg_temp.inhaber()),
       (pg_temp.ws_b(), 'doc-k-b1', 'archived_document', null, '{"id":"doc-k-b1","title":"Archiv B1"}'::jsonb, pg_temp.inhaber_b_gesperrt());

insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path, created_by, uploaded_by)
values (pg_temp.ws(),   'file-k-a1', repeat('a', 64), 10, 'application/pdf', pg_temp.pfad(pg_temp.ws(), 'a'),   pg_temp.inhaber(), pg_temp.inhaber()),
       (pg_temp.ws_b(), 'file-k-b1', repeat('b', 64), 10, 'application/pdf', pg_temp.pfad(pg_temp.ws_b(), 'b'), pg_temp.inhaber_b_gesperrt(), pg_temp.inhaber_b_gesperrt());

insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind, part, provenance, created_by, updated_by)
values (pg_temp.ws(),   'doc-k-a1', 'file-k-a1', 'original', null, 'received', pg_temp.inhaber(), pg_temp.inhaber()),
       (pg_temp.ws_b(), 'doc-k-b1', 'file-k-b1', 'original', null, 'received', pg_temp.inhaber_b_gesperrt(), pg_temp.inhaber_b_gesperrt());

insert into storage.objects (bucket_id, name, metadata)
values ('workspace-files', pg_temp.pfad(pg_temp.ws(), 'a'),   '{"size":10}'::jsonb),
       ('workspace-files', pg_temp.pfad(pg_temp.ws_b(), 'b'), '{"size":10}'::jsonb);

insert into public.workspace_invoices (workspace_id, vorgang_id, client_invoice_id, invoice_number, invoice_year, invoice_sequence_number, invoice_type, invoice_status, payload)
values (pg_temp.ws(), null, 'inv-k-1', '2026-9701', 2026, 9701, 'rechnung', 'vorbereitet', '{"status":"vorbereitet","servicePeriodConfirmed":true}'::jsonb);

-- Mailbox-OAuth-Zwischenstand je für den gesperrten und den freigegebenen Admin.
insert into public.workspace_mailbox_oauth_states (id, workspace_id, user_id, provider_type, state_hash, code_verifier, nonce, expected_address,
  source_kind, source_name, import_from, expires_at, detected_address, pending_reason, pending_until, outcome)
select v.id, pg_temp.ws(), v.nutzer, (select provider_type from public.mailbox_provider_types order by 1 limit 1), repeat(v.h, 64), 'v', 'n',
       'post@example.invalid', 'folder', 'INBOX', now(), now() + interval '1 hour', 'anders@example.invalid', 'address_mismatch',
       now() + interval '1 hour', 'confirm_required'
from (values ('00000000-0000-0000-0000-000000d0bf01'::uuid, pg_temp.admin_gesperrt(), 'c'),
             ('00000000-0000-0000-0000-000000d0bf02'::uuid, pg_temp.admin_ok(), 'd')) as v(id, nutzer, h);

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
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

/** Abweisung wegen Sperre/fehlender Berechtigung — eine fachliche Abweisung gilt NICHT. */
create function pg_temp.erwarte_sperre(p_label text, p_sql text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like '%Kein Zugriff%' or sqlerrm like '%Keine Schreibberechtigung%'
       or sqlerrm like '%finance_account_blocked%' or sqlerrm like '%account_blocked%' then
      return;
    end if;
    raise exception '% -- keine Sperr-Abweisung, sondern: %', p_label, sqlerrm;
  end;
  raise exception '% -- NICHT abgewiesen', p_label;
end;
$p$;

create function pg_temp.archiv(p_id text, p_ws uuid default null)
returns jsonb language sql as $p$
  select public.upsert_workspace_intake_entity(coalesce(p_ws, pg_temp.ws()), 'archived_document',
    jsonb_build_object('client_document_id', p_id, 'payload', jsonb_build_object('id', p_id, 'title', p_id)), 0);
$p$;

/** Sichtbare Zeilen je Tabelle für den angemeldeten Nutzer (RLS) in einer Firma. */
create function pg_temp.sicht(p_ws uuid) returns jsonb language sql as $p$
  select jsonb_build_object(
    'dokumente',  (select count(*) from public.workspace_documents where workspace_id = p_ws),
    'dateien',    (select count(*) from public.workspace_files where workspace_id = p_ws),
    'bindungen',  (select count(*) from public.workspace_document_file_bindings where workspace_id = p_ws),
    'rechnungen', (select count(*) from public.workspace_invoices where workspace_id = p_ws),
    'betrieb',    (select count(*) from public.workspaces where id = p_ws),
    'speicher',   (select count(*) from storage.objects where bucket_id = 'workspace-files' and name like p_ws::text || '/%'));
$p$;

/* ------------------------------------------------------------------ */
/* K1 -- Helfer (der WEISS-Befund)                                     */
/* ------------------------------------------------------------------ */

do $$
declare
  v_schreiben boolean; v_mitglied boolean; v_rolle text; v_eingang boolean;
begin
  perform pg_temp.als(pg_temp.admin_gesperrt());
  v_schreiben := public.can_write_workspace(pg_temp.ws());
  v_mitglied := public.is_active_workspace_member(pg_temp.ws());
  v_rolle := public.workspace_member_role(pg_temp.ws());
  v_eingang := public.workspace_user_can_intake(pg_temp.ws());
  perform pg_temp.zurueck();
  if v_schreiben or v_mitglied or v_rolle is not null or v_eingang then
    raise exception 'K1 gesperrter Admin behält Rechte: can_write=% member=% role=% intake=%', v_schreiben, v_mitglied, v_rolle, v_eingang;
  end if;
  -- Edge-Brücke (Versand, Mail-Sync, Mailbox-OAuth rufen sie mit dem Dienstschlüssel).
  if public.workspace_user_can_write(pg_temp.ws(), pg_temp.admin_gesperrt()) then
    raise exception 'K1 workspace_user_can_write erlaubt dem gesperrten Admin das Schreiben';
  end if;
  -- Gegenprobe: freigegebener Admin unverändert.
  perform pg_temp.als(pg_temp.admin_ok());
  if not public.can_write_workspace(pg_temp.ws()) or public.workspace_member_role(pg_temp.ws()) <> 'admin' then
    raise exception 'K1 freigegebener Admin verliert Rechte';
  end if;
  perform pg_temp.zurueck();
  if not public.workspace_user_can_write(pg_temp.ws(), pg_temp.admin_ok()) then
    raise exception 'K1 Edge-Brücke verweigert dem freigegebenen Admin';
  end if;
  raise notice 'OK  K1 gesperrter Admin: kein Mitglied, keine Rolle, kein Schreibrecht (auch Edge-Brücke); freigegebener Admin unverändert';
end $$;

/* ------------------------------------------------------------------ */
/* K2 -- Lesen                                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_sicht jsonb; v_kontrolle jsonb; v_lesen boolean;
begin
  perform pg_temp.als(pg_temp.admin_gesperrt());
  v_sicht := pg_temp.sicht(pg_temp.ws());
  v_lesen := public.workspace_file_object_can_read(pg_temp.pfad(pg_temp.ws(), 'a'));
  perform pg_temp.zurueck();
  if v_sicht <> '{"dokumente":0,"dateien":0,"bindungen":0,"rechnungen":0,"betrieb":0,"speicher":0}'::jsonb or v_lesen then
    raise exception 'K2 gesperrter Admin liest: % / Speicherbrücke %', v_sicht, v_lesen;
  end if;
  perform pg_temp.als(pg_temp.admin_ok());
  v_kontrolle := pg_temp.sicht(pg_temp.ws());
  perform pg_temp.zurueck();
  if v_kontrolle <> '{"dokumente":3,"dateien":1,"bindungen":1,"rechnungen":1,"betrieb":1,"speicher":1}'::jsonb then
    raise exception 'K2 Gegenprobe: freigegebener Admin sieht %', v_kontrolle;
  end if;
  perform pg_temp.als(pg_temp.admin_gesperrt());
  perform pg_temp.erwarte_sperre('K2a pull_workspace_documents', format('select public.pull_workspace_documents(%L, null)', pg_temp.ws()));
  perform pg_temp.erwarte_sperre('K2b pull_workspace_intake_state', format('select public.pull_workspace_intake_state(%L)', pg_temp.ws()));
  perform pg_temp.erwarte_sperre('K2c pull_workspace_sync_state', format('select public.pull_workspace_sync_state(%L)', pg_temp.ws()));
  perform pg_temp.erwarte_sperre('K2d pull_workspace_invoices', format('select count(*) from public.pull_workspace_invoices(%L, null)', pg_temp.ws()));
  perform pg_temp.erwarte_sperre('K2e get_workspace_invoice_sent', format('select public.get_workspace_invoice_sent(%L, %L)', pg_temp.ws(), 'inv-k-1'));
  perform pg_temp.erwarte_sperre('K2f Versandliste je Dokument', format('select public.list_workspace_document_deliveries_for_document(%L, %L)', pg_temp.ws(), 'doc-k-a1'));
  perform pg_temp.zurueck();
  raise notice 'OK  K2 gesperrter Admin liest nichts: Tabellen, Speicherobjekte, Speicherbrücke, Abzüge, Versandliste';
end $$;

/* ------------------------------------------------------------------ */
/* K3 -- Löschen und Wiederherstellen                                  */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.admin_gesperrt());
  perform pg_temp.erwarte_sperre('K3a gesperrter Admin löscht ein Archivdokument',
    format('select public.tombstone_workspace_document(%L, %L)', pg_temp.ws(), 'doc-k-a1'));
  perform pg_temp.zurueck();
  if (select deleted from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-k-a1') then
    raise exception 'K3a Dokument trotzdem gelöscht';
  end if;
  -- Inhaber löscht A2, der gesperrte Admin versucht es wiederherzustellen.
  perform pg_temp.als(pg_temp.inhaber());
  perform public.tombstone_workspace_document(pg_temp.ws(), 'doc-k-a2');
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.admin_gesperrt());
  perform pg_temp.erwarte_sperre('K3b gesperrter Admin stellt wieder her',
    format('select public.restore_workspace_document(%L, %L, %L)', pg_temp.ws(), 'doc-k-a2', 'Versuch'));
  perform pg_temp.zurueck();
  if not (select deleted from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-k-a2') then
    raise exception 'K3b Dokument trotzdem wiederhergestellt';
  end if;
  -- Gegenprobe: der freigegebene Admin löscht und stellt wieder her.
  perform pg_temp.als(pg_temp.admin_ok());
  perform public.tombstone_workspace_document(pg_temp.ws(), 'doc-k-a3');
  perform public.restore_workspace_document(pg_temp.ws(), 'doc-k-a3', 'Prüfung');
  perform pg_temp.zurueck();
  if (select deleted from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-k-a3') then
    raise exception 'K3 Gegenprobe: freigegebener Admin konnte nicht wiederherstellen';
  end if;
  raise notice 'OK  K3 gesperrter Admin löscht und stellt nichts wieder her; freigegebener Admin wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* K4 -- Eingang und Synchronisation                                   */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.mitglied_gesperrt());
  perform pg_temp.erwarte_sperre('K4a gesperrtes Mitglied legt ein Archivdokument an', 'select pg_temp.archiv(''doc-k-m-gesperrt'')');
  perform pg_temp.erwarte_sperre('K4b gesperrtes Mitglied legt einen Kunden an',
    format('select public.upsert_workspace_sync_entity(%L, %L, %L::jsonb, 0)', pg_temp.ws(), 'customer',
      '{"client_customer_id":"cust-k-1","payload":{"id":"cust-k-1","name":"Gesperrt GmbH"}}'));
  perform pg_temp.zurueck();
  if exists (select 1 from public.workspace_documents where workspace_id = pg_temp.ws() and client_document_id = 'doc-k-m-gesperrt') then
    raise exception 'K4 Dokument des gesperrten Mitglieds entstanden';
  end if;
  perform pg_temp.als(pg_temp.mitglied_ok());
  perform pg_temp.archiv('doc-k-m-ok');
  perform pg_temp.zurueck();
  raise notice 'OK  K4 gesperrtes Mitglied: kein Eingang, keine Synchronisation; freigegebenes Mitglied wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* K5 -- Finanzaktionen                                                */
/* ------------------------------------------------------------------ */

do $$
begin
  perform pg_temp.als(pg_temp.admin_gesperrt());
  perform pg_temp.erwarte_sperre('K5a Zahlung',
    format('select public.add_workspace_invoice_payment(%L, %L, %L, 1, %L, null, null, %L)', pg_temp.ws(), 'inv-k-1', 'pay-k-1', '2026-10-06', 'bank'));
  perform pg_temp.erwarte_sperre('K5b Leistungszeitraum',
    format('select public.confirm_workspace_invoice_service_period(%L, %L)', pg_temp.ws(), 'inv-k-1'));
  perform pg_temp.zurueck();
  -- Die bisherige Finanzmeldung bleibt erhalten (Clients erkennen sie als endgültig).
  perform pg_temp.als(pg_temp.admin_gesperrt());
  perform pg_temp.erwarte_abweisung('K5c assert_financial_action_allowed',
    format('select public.assert_financial_action_allowed(%L)', pg_temp.ws()), 'finance_account_blocked', null);
  perform pg_temp.zurueck();
  raise notice 'OK  K5 Finanzaktionen gesperrt, Meldung finance_account_blocked bleibt';
end $$;

/* ------------------------------------------------------------------ */
/* K6 -- Mehrere Firmen                                                */
/* ------------------------------------------------------------------ */

do $$
declare
  v_sicht jsonb; v_schreiben boolean; v_inhaber jsonb; v_inhaber_mitglied boolean;
begin
  perform pg_temp.als(pg_temp.admin_gesperrt());
  v_sicht := pg_temp.sicht(pg_temp.ws_b());
  v_schreiben := public.can_write_workspace(pg_temp.ws_b());
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.inhaber_b_gesperrt());
  v_inhaber := pg_temp.sicht(pg_temp.ws_b());
  v_inhaber_mitglied := public.is_active_workspace_member(pg_temp.ws_b());
  perform pg_temp.erwarte_sperre('K6a gesperrter Inhaber löscht im eigenen Betrieb',
    format('select public.tombstone_workspace_document(%L, %L)', pg_temp.ws_b(), 'doc-k-b1'));
  perform pg_temp.erwarte_sperre('K6b gesperrter Inhaber zieht den eigenen Betrieb',
    format('select public.pull_workspace_sync_state(%L)', pg_temp.ws_b()));
  perform pg_temp.zurueck();
  if v_schreiben or (v_sicht->>'dokumente')::int <> 0 or (v_inhaber->>'dokumente')::int <> 0
     or (v_inhaber->>'speicher')::int <> 0 or v_inhaber_mitglied then
    raise exception 'K6 Firma B: Admin % / % — Inhaber % / %', v_sicht, v_schreiben, v_inhaber, v_inhaber_mitglied;
  end if;
  raise notice 'OK  K6 Sperre gilt kontoweit: gesperrter Admin auch in Firma B, gesperrter Inhaber im eigenen Betrieb';
end $$;

/* ------------------------------------------------------------------ */
/* K7 -- Bestehende Sitzung                                            */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher boolean; v_nachher boolean; v_wieder boolean;
begin
  -- Dieselbe Sitzung (dieselben Claims) vor und nach der Sperre.
  perform pg_temp.als(pg_temp.admin_ok());
  v_vorher := public.can_write_workspace(pg_temp.ws());
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.padmin_ok());
  perform public.admin_block_user(pg_temp.admin_ok());
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.admin_ok());
  v_nachher := public.can_write_workspace(pg_temp.ws());
  perform pg_temp.erwarte_sperre('K7 nach der Sperre: Löschen in derselben Sitzung',
    format('select public.tombstone_workspace_document(%L, %L)', pg_temp.ws(), 'doc-k-a1'));
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.padmin_ok());
  perform public.admin_approve_user(pg_temp.admin_ok());
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.admin_ok());
  v_wieder := public.can_write_workspace(pg_temp.ws());
  perform pg_temp.zurueck();
  if not v_vorher or v_nachher or not v_wieder then
    raise exception 'K7 Sitzung: vorher % / gesperrt % / entsperrt %', v_vorher, v_nachher, v_wieder;
  end if;
  raise notice 'OK  K7 Sperre und Entsperren wirken in einer bestehenden Sitzung beim nächsten Aufruf';
end $$;

/* ------------------------------------------------------------------ */
/* K8 -- Plattform-Admin                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_anzahl integer;
begin
  perform pg_temp.als(pg_temp.padmin_gesperrt());
  perform pg_temp.erwarte_abweisung('K8a gesperrter Plattform-Admin entsperrt sich selbst',
    format('select public.admin_approve_user(%L)', pg_temp.padmin_gesperrt()), 'Keine Admin-Berechtigung', null);
  perform pg_temp.erwarte_abweisung('K8b gesperrter Plattform-Admin listet Profile',
    'select count(*) from public.admin_list_profiles()', 'Keine Admin-Berechtigung', null);
  perform pg_temp.erwarte_abweisung('K8c gesperrter Plattform-Admin sperrt andere',
    format('select public.admin_block_user(%L)', pg_temp.inhaber()), 'Keine Admin-Berechtigung', null);
  perform pg_temp.erwarte_abweisung('K8d gesperrter Plattform-Admin verlängert Lizenzen',
    format('select public.admin_activate_license(%L, null)', pg_temp.admin_lizenz()), 'Keine Admin-Berechtigung', null);
  perform pg_temp.zurueck();
  if (select status from public.profiles where id = pg_temp.padmin_gesperrt()) <> 'blocked'
     or (select status from public.profiles where id = pg_temp.inhaber()) <> 'approved' then
    raise exception 'K8 Profilstatus verändert';
  end if;
  perform pg_temp.als(pg_temp.padmin_ok());
  select count(*) into v_anzahl from public.admin_list_profiles();
  perform pg_temp.zurueck();
  if v_anzahl < 9 then
    raise exception 'K8 Gegenprobe: freigegebener Plattform-Admin sieht % Profile', v_anzahl;
  end if;
  raise notice 'OK  K8 gesperrter Plattform-Admin: keine Admin-Funktion, kein Selbst-Entsperren; freigegebener wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* K9 -- Betriebsbindung                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_vorher integer; v_ok jsonb;
begin
  select count(*) into v_vorher from public.workspaces where owner_user_id = pg_temp.padmin_gesperrt();
  perform pg_temp.als(pg_temp.padmin_gesperrt());
  perform pg_temp.erwarte_abweisung('K9a gesperrtes Konto legt einen Betrieb an',
    'select public.ensure_personal_workspace(null)', 'account_blocked', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.admin_gesperrt());
  perform pg_temp.erwarte_abweisung('K9b gesperrtes Konto bindet sich an einen Betrieb',
    'select public.get_active_workspace()', 'account_blocked', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.inhaber_b_gesperrt());
  perform pg_temp.erwarte_abweisung('K9c gesperrter Inhaber bindet sich an seinen Betrieb',
    'select public.ensure_personal_workspace(null)', 'account_blocked', '42501');
  perform pg_temp.zurueck();
  if (select count(*) from public.workspaces where owner_user_id = pg_temp.padmin_gesperrt()) <> v_vorher then
    raise exception 'K9 Betrieb für gesperrtes Konto angelegt';
  end if;
  perform pg_temp.als(pg_temp.inhaber());
  v_ok := public.ensure_personal_workspace(null);
  perform pg_temp.zurueck();
  if (v_ok->'workspace'->>'id')::uuid is distinct from pg_temp.ws() then
    raise exception 'K9 Gegenprobe: Inhaber erhält seinen Betrieb nicht: %', v_ok;
  end if;
  raise notice 'OK  K9 gesperrte Konten erhalten und erzeugen keine Betriebsbindung; Inhaber wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* K10 -- Mailbox-OAuth-Zwischenstand                                  */
/* ------------------------------------------------------------------ */

do $$
declare
  v_gesperrt jsonb; v_ok jsonb;
begin
  perform pg_temp.als(pg_temp.admin_gesperrt());
  v_gesperrt := public.get_workspace_mailbox_oauth_pending(pg_temp.ws(), '00000000-0000-0000-0000-000000d0bf01'::uuid);
  perform pg_temp.zurueck();
  perform pg_temp.als(pg_temp.admin_ok());
  v_ok := public.get_workspace_mailbox_oauth_pending(pg_temp.ws(), '00000000-0000-0000-0000-000000d0bf02'::uuid);
  perform pg_temp.zurueck();
  if v_gesperrt is not null or v_ok is null then
    raise exception 'K10 OAuth-Zwischenstand: gesperrt % / freigegeben %', v_gesperrt, v_ok;
  end if;
  raise notice 'OK  K10 gesperrtes Konto liest keinen Mailbox-OAuth-Zwischenstand; freigegebenes wie bisher';
end $$;

/* ------------------------------------------------------------------ */
/* K11 -- Abgrenzung Lizenz                                            */
/* ------------------------------------------------------------------ */

do $$
declare
  v_sicht jsonb;
begin
  perform pg_temp.als(pg_temp.admin_lizenz());
  v_sicht := pg_temp.sicht(pg_temp.ws());
  perform pg_temp.erwarte_abweisung('K11 abgelaufene Lizenz: Finanzaktion',
    format('select public.assert_financial_action_allowed(%L)', pg_temp.ws()), 'finance_license_expired', null);
  perform pg_temp.zurueck();
  if (v_sicht->>'dokumente')::int = 0 then
    raise exception 'K11 abgelaufene Lizenz sperrt das Lesen: %', v_sicht;
  end if;
  raise notice 'OK  K11 abgelaufene Lizenz ist keine Kontosperre: Lesen bleibt, Finanzaktionen abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* K12 -- Rechte                                                       */
/* ------------------------------------------------------------------ */

do $$
declare
  v_rolle text;
begin
  foreach v_rolle in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_rolle, 'public.workspace_account_blocked(uuid)', 'execute') then
      raise exception 'K12 % darf workspace_account_blocked ausführen', v_rolle;
    end if;
  end loop;
  if not (select prosecdef from pg_proc where oid = 'public.workspace_account_blocked(uuid)'::regprocedure) then
    raise exception 'K12 workspace_account_blocked ist nicht SECURITY DEFINER';
  end if;
  raise notice 'OK  K12 neue Hilfsfunktion intern (kein EXECUTE für anon, authenticated, service_role)';
end $$;

rollback;
