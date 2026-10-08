-- P1 MITARBEITERZAHLUNGEN -- Laufzeittest des Server-Vertrags.
--
--   A  Mitarbeiter: Anlage, Replay (Version 0), Konflikt, Basisversion, Personalnummer
--   B  Zahlung: Anlage, Replay, Konflikt, Prüfungen (Art, Betrag, Datum, Zahlungsart,
--      Lohnmonat, Notiz bei Sonstiges, Referenzform und -datum, Referenzkonflikt)
--   C  Storno: Grund erforderlich, idempotent, erster Grund bleibt, kein Löschweg
--   D  Quittung genau einmal, nur bar; Nachweis geldfrei änderbar; nach Storno fest
--   E  Dokumentschutz: Quittung und Nachweis geschützt — auch storniert
--   F  Rollen: Mitglied ohne Finanzrecht, fremder Betrieb, gesperrtes Konto
--   G  RLS bei direktem Lesen und Schreiben
--   H  Abzug nur für Inhaber/Verwaltung, mit stornierten Zahlungen
--
-- Ausführen (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/employee_payments_p1ma.sql
--
-- Exit-Code 0 = alle Zusicherungen erfüllt. Alles wird zurückgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000e1001'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-p1ma@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1002'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-p1ma@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1003'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-p1ma@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1004'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'admin-gesperrt-p1ma@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-0000000e1001'::uuid, '00000000-0000-0000-0000-0000000e1002'::uuid,
             '00000000-0000-0000-0000-0000000e1003'::uuid);
update public.profiles set status = 'blocked', license_status = 'active'
where id = '00000000-0000-0000-0000-0000000e1004'::uuid;

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e1a01'::uuid, 'P1MA Betrieb', '00000000-0000-0000-0000-0000000e1001'::uuid),
       ('00000000-0000-0000-0000-0000000e1a02'::uuid, 'P1MA Fremd',   '00000000-0000-0000-0000-0000000e1003'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e1a01'::uuid, '00000000-0000-0000-0000-0000000e1001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-0000000e1a01'::uuid, '00000000-0000-0000-0000-0000000e1002'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-0000000e1a01'::uuid, '00000000-0000-0000-0000-0000000e1004'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-0000000e1a02'::uuid, '00000000-0000-0000-0000-0000000e1003'::uuid, 'owner',  'active');

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
values ('00000000-0000-0000-0000-0000000e1a01'::uuid, 'emp-receipt-pay-1', 'archived_document', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1a01'::uuid, 'doc-signiert-1', 'archived_document', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1a01'::uuid, 'doc-signiert-2', 'archived_document', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1a01'::uuid, 'doc-frei', 'archived_document', '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000e1a02'::uuid, 'doc-fremd', 'archived_document', '{}'::jsonb);

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
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

create function pg_temp.mitarbeiter(p_id text, p_name text, p_nummer text default null, p_aktiv boolean default true)
returns jsonb language sql as $p$
  select jsonb_build_object('client_employee_id', p_id, 'name', p_name, 'personnel_number', p_nummer, 'active', p_aktiv);
$p$;

/** Eine Zahlung, wie sie der Client sendet (Referenz zum Datum passend). */
create function pg_temp.zahlung(
  p_ws uuid, p_id text, p_referenz text, p_art text default 'wage', p_betrag numeric default 350.00,
  p_datum text default '2026-10-07', p_methode text default 'cash', p_lohnmonat text default null,
  p_zweck text default 'Lohn September', p_notiz text default null, p_mitarbeiter text default 'emp-1'
) returns jsonb language sql as $p$
  select public.add_workspace_employee_payment(
    p_ws, p_id, p_mitarbeiter, 'Max Mustermann', 'P-001', p_art, p_betrag, p_datum, p_methode,
    p_lohnmonat, p_zweck, p_notiz, p_referenz, 'Saban Irmak');
$p$;

/* ------------------------------------------------------------------ */
/* A -- Mitarbeiter                                                    */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);

  v := public.upsert_workspace_employee(v_ws, pg_temp.mitarbeiter('emp-1', 'Max Mustermann', 'P-001'), 0);
  if (v->>'row_version')::bigint <> 1 or (v->>'replayed')::boolean then
    raise exception 'A1 Anlage: %', v;
  end if;

  -- Wiederanlauf nach verlorener Bestätigung: Version 0, gleicher Inhalt.
  v := public.upsert_workspace_employee(v_ws, pg_temp.mitarbeiter('emp-1', 'Max Mustermann', 'P-001'), 0);
  if (v->>'row_version')::bigint <> 1 or not (v->>'replayed')::boolean then
    raise exception 'A2 Replay: %', v;
  end if;
  if (select count(*) from public.workspace_employees where workspace_id = v_ws) <> 1 then
    raise exception 'A2 genau eine Zeile erwartet';
  end if;

  perform pg_temp.erwarte_fehler('A3 Version 0 mit anderem Inhalt',
    format('select public.upsert_workspace_employee(%L, pg_temp.mitarbeiter(''emp-1'', ''Max Neu'', ''P-001''), 0)', v_ws),
    'Versionskonflikt employee:1');

  -- Umbenennen mit Basisversion; Deaktivieren.
  v := public.upsert_workspace_employee(v_ws, pg_temp.mitarbeiter('emp-1', 'Max Mustermann-Neu', 'P-001'), 1);
  if (v->>'row_version')::bigint <> 2 then raise exception 'A4 Umbenennen: %', v; end if;
  perform pg_temp.erwarte_fehler('A5 veraltete Basisversion',
    format('select public.upsert_workspace_employee(%L, pg_temp.mitarbeiter(''emp-1'', ''X'', ''P-001''), 1)', v_ws),
    'Versionskonflikt employee:2');
  v := public.upsert_workspace_employee(v_ws, pg_temp.mitarbeiter('emp-1', 'Max Mustermann-Neu', 'P-001', false), 2);
  if (v->>'row_version')::bigint <> 3 then raise exception 'A6 Deaktivieren: %', v; end if;
  if (select active from public.workspace_employees where workspace_id = v_ws and client_employee_id = 'emp-1') then
    raise exception 'A6 Mitarbeiter muss inaktiv sein';
  end if;
  v := public.upsert_workspace_employee(v_ws, pg_temp.mitarbeiter('emp-1', 'Max Mustermann', 'P-001', true), 3);

  perform pg_temp.erwarte_fehler('A7 Personalnummer doppelt',
    format('select public.upsert_workspace_employee(%L, pg_temp.mitarbeiter(''emp-2'', ''Erika'', ''p-001''), 0)', v_ws),
    'employee_personnel_number_taken');
  perform pg_temp.erwarte_fehler('A8 Name fehlt',
    format('select public.upsert_workspace_employee(%L, pg_temp.mitarbeiter(''emp-3'', ''   ''), 0)', v_ws),
    'employee_name_invalid');
  perform public.upsert_workspace_employee(v_ws, pg_temp.mitarbeiter('emp-2', 'Erika Beispiel'), 0);
end $$;

/* ------------------------------------------------------------------ */
/* B -- Zahlung                                                        */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);

  v := pg_temp.zahlung(v_ws, 'pay-1', 'MZ-20261007-ABCDEFGH', 'wage', 350.00, '2026-10-07', 'cash', '2026-09');
  if (v->>'replayed')::boolean or v->>'receipt_reference' <> 'MZ-20261007-ABCDEFGH' or (v->>'amount')::numeric <> 350.00 then
    raise exception 'B1 Anlage: %', v;
  end if;
  v := pg_temp.zahlung(v_ws, 'pay-1', 'MZ-20261007-ABCDEFGH', 'wage', 350.00, '2026-10-07', 'cash', '2026-09');
  if not (v->>'replayed')::boolean then raise exception 'B2 Replay: %', v; end if;
  if (select count(*) from public.workspace_employee_payments where workspace_id = v_ws) <> 1 then
    raise exception 'B2 genau eine Zahlung erwartet';
  end if;

  perform pg_temp.erwarte_fehler('B3 gleiche Kennung, anderer Betrag',
    format('select pg_temp.zahlung(%L, ''pay-1'', ''MZ-20261007-ABCDEFGH'', ''wage'', 351.00, ''2026-10-07'', ''cash'', ''2026-09'')', v_ws),
    'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten');
  perform pg_temp.erwarte_fehler('B4 Betrag 0',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''wage'', 0)', v_ws),
    'employee_payment_amount_invalid');
  perform pg_temp.erwarte_fehler('B5 drei Nachkommastellen',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''wage'', 1.005)', v_ws),
    'employee_payment_amount_invalid');
  perform pg_temp.erwarte_fehler('B6 Art ungültig',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''bonus'')', v_ws),
    'employee_payment_kind_invalid');
  perform pg_temp.erwarte_fehler('B7 Zahlungsart fehlt',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''advance'', 100, ''2026-10-07'', '''')', v_ws),
    'employee_payment_method_invalid');
  perform pg_temp.erwarte_fehler('B8 Lohnmonat nur bei Lohn',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''advance'', 100, ''2026-10-07'', ''cash'', ''2026-09'')', v_ws),
    'employee_payment_wage_month_invalid');
  perform pg_temp.erwarte_fehler('B9 Sonstiges ohne Notiz',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''other'', 100, ''2026-10-07'', ''cash'', null, ''Zweck'', null)', v_ws),
    'employee_payment_note_required');
  perform pg_temp.erwarte_fehler('B10 Referenzform',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-abcdefgh'')', v_ws),
    'employee_payment_reference_invalid');
  perform pg_temp.erwarte_fehler('B11 Referenzdatum passt nicht',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261006-ABCDEFGJ'')', v_ws),
    'employee_payment_reference_invalid');
  perform pg_temp.erwarte_fehler('B12 Referenz schon vergeben',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGH'')', v_ws),
    'Referenzkonflikt');
  perform pg_temp.erwarte_fehler('B13 Datum in der Zukunft',
    format('select pg_temp.zahlung(%L, ''pay-x'', %L, ''advance'', 100, %L)', v_ws,
           'MZ-' || to_char(current_date + 10, 'YYYYMMDD') || '-ABCDEFGJ', to_char(current_date + 10, 'YYYY-MM-DD')),
    'employee_payment_date_invalid');
  perform pg_temp.erwarte_fehler('B14 Mitarbeiter unbekannt',
    format('select pg_temp.zahlung(%L, ''pay-x'', ''MZ-20261007-ABCDEFGJ'', ''advance'', 100, ''2026-10-07'', ''cash'', null, ''Z'', null, ''emp-unbekannt'')', v_ws),
    'Mitarbeiter nicht gefunden');

  -- Alle fünf Arten sind anlegbar.
  perform pg_temp.zahlung(v_ws, 'pay-2', 'MZ-20261007-ABCDEFG2', 'advance', 200.00, '2026-10-07', 'cash', null, 'Vorschuss');
  perform pg_temp.zahlung(v_ws, 'pay-3', 'MZ-20261007-ABCDEFG3', 'reimbursement', 42.50, '2026-10-07', 'bank', null, 'Baumarkt');
  perform pg_temp.zahlung(v_ws, 'pay-4', 'MZ-20261007-ABCDEFG4', 'travel', 18.00, '2026-10-07', 'other', null, 'Fahrt');
  perform pg_temp.zahlung(v_ws, 'pay-5', 'MZ-20261007-ABCDEFG5', 'other', 10.00, '2026-10-07', 'cash', null, null, 'Geschenk Jubilaeum', 'emp-2');
  if (select count(*) from public.workspace_employee_payments where workspace_id = v_ws) <> 5 then
    raise exception 'B15 fünf Zahlungen erwartet';
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* C -- Storno                                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);

  perform pg_temp.erwarte_fehler('C1 Grund fehlt',
    format('select public.reverse_workspace_employee_payment(%L, ''pay-2'', '' a '')', v_ws),
    'employee_payment_reversal_reason_invalid');
  v := public.reverse_workspace_employee_payment(v_ws, 'pay-2', 'Falscher Betrag');
  if v->>'reversed_at' is null or v->>'reversal_reason' <> 'Falscher Betrag' or (v->>'replayed')::boolean then
    raise exception 'C2 Storno: %', v;
  end if;
  v := public.reverse_workspace_employee_payment(v_ws, 'pay-2', 'Anderer Grund');
  if not (v->>'replayed')::boolean or v->>'reversal_reason' <> 'Falscher Betrag' then
    raise exception 'C3 idempotent, erster Grund bleibt: %', v;
  end if;
  -- Replay der Anlage einer stornierten Zahlung bewegt nichts und scheitert nicht.
  v := pg_temp.zahlung(v_ws, 'pay-2', 'MZ-20261007-ABCDEFG2', 'advance', 200.00, '2026-10-07', 'cash', null, 'Vorschuss');
  if not (v->>'replayed')::boolean or v->>'reversed_at' is null then
    raise exception 'C4 Replay nach Storno: %', v;
  end if;
  if exists (
    select 1 from pg_proc where proname in ('delete_workspace_employee_payment', 'delete_workspace_employee')
  ) then
    raise exception 'C5 es darf keinen Löschweg geben';
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* D -- Quittung und Nachweis                                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);

  perform pg_temp.erwarte_fehler('D1 Quittungsdokument fehlt',
    format('select public.set_workspace_employee_payment_receipt(%L, ''pay-1'', ''doc-gibt-es-nicht'')', v_ws),
    'Quittungsdokument nicht gefunden');
  perform pg_temp.erwarte_fehler('D2 fremdes Dokument',
    format('select public.set_workspace_employee_payment_receipt(%L, ''pay-1'', ''doc-fremd'')', v_ws),
    'Quittungsdokument nicht gefunden');
  v := public.set_workspace_employee_payment_receipt(v_ws, 'pay-1', 'emp-receipt-pay-1');
  if v->>'receipt_document_id' <> 'emp-receipt-pay-1' or (v->>'replayed')::boolean then raise exception 'D3: %', v; end if;
  v := public.set_workspace_employee_payment_receipt(v_ws, 'pay-1', 'emp-receipt-pay-1');
  if not (v->>'replayed')::boolean then raise exception 'D4 Replay: %', v; end if;
  perform pg_temp.erwarte_fehler('D5 Quittung genau einmal',
    format('select public.set_workspace_employee_payment_receipt(%L, ''pay-1'', ''doc-frei'')', v_ws),
    'Quittung bereits gesetzt');
  perform pg_temp.erwarte_fehler('D6 Quittung nur bar',
    format('select public.set_workspace_employee_payment_receipt(%L, ''pay-3'', ''doc-frei'')', v_ws),
    'employee_payment_receipt_cash_only');
  perform pg_temp.erwarte_fehler('D7 keine Quittung nach Storno',
    format('select public.set_workspace_employee_payment_receipt(%L, ''pay-2'', ''doc-frei'')', v_ws),
    'employee_payment_reversed');

  v := public.set_workspace_employee_payment_proof(v_ws, 'pay-1', 'doc-signiert-1');
  if v->>'proof_document_id' <> 'doc-signiert-1' then raise exception 'D8: %', v; end if;
  v := public.set_workspace_employee_payment_proof(v_ws, 'pay-1', 'doc-signiert-2');
  if v->>'proof_document_id' <> 'doc-signiert-2' then raise exception 'D9 Nachweis ändern: %', v; end if;
  if (select amount from public.workspace_employee_payments where workspace_id = v_ws and client_payment_id = 'pay-1') <> 350.00 then
    raise exception 'D9 der Nachweis darf kein Geld bewegen';
  end if;
  perform pg_temp.erwarte_fehler('D10 Nachweis gleich Quittung',
    format('select public.set_workspace_employee_payment_proof(%L, ''pay-1'', ''emp-receipt-pay-1'')', v_ws),
    'employee_payment_proof_is_receipt');
  v := public.set_workspace_employee_payment_proof(v_ws, 'pay-1', 'doc-signiert-1');

  -- Nach dem Storno ist der Nachweis fest; derselbe Wert bleibt ein Replay.
  perform public.reverse_workspace_employee_payment(v_ws, 'pay-1', 'Doppelt erfasst');
  v := public.set_workspace_employee_payment_proof(v_ws, 'pay-1', 'doc-signiert-1');
  if not (v->>'replayed')::boolean then raise exception 'D11 Replay nach Storno: %', v; end if;
  perform pg_temp.erwarte_fehler('D12 Nachweis nach Storno ändern',
    format('select public.set_workspace_employee_payment_proof(%L, ''pay-1'', ''doc-signiert-2'')', v_ws),
    'employee_payment_reversed');
end $$;

/* ------------------------------------------------------------------ */
/* E -- Dokumentschutz                                                 */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);

  if not public.is_workspace_document_payment_proof(v_ws, 'emp-receipt-pay-1') then
    raise exception 'E1 Quittung einer stornierten Zahlung muss geschützt sein';
  end if;
  if not public.is_workspace_document_payment_proof(v_ws, 'doc-signiert-1') then
    raise exception 'E2 Nachweis einer stornierten Zahlung muss geschützt sein';
  end if;
  if public.is_workspace_document_payment_proof(v_ws, 'doc-frei') then
    raise exception 'E3 ein freies Dokument ist kein Nachweis';
  end if;
  perform pg_temp.erwarte_fehler('E4 Quittung löschen',
    format('select public.assert_document_not_payment_proof(%L, ''emp-receipt-pay-1'')', v_ws),
    'Dokument ist als Zahlungsnachweis verknuepft');
  perform pg_temp.erwarte_fehler('E5 Grabstein auf Quittung',
    format('select public.tombstone_workspace_document(%L, ''emp-receipt-pay-1'')', v_ws),
    'Dokument ist als Zahlungsnachweis verknuepft');
  perform pg_temp.erwarte_fehler('E6 Grabstein auf Nachweis',
    format('select public.tombstone_workspace_document(%L, ''doc-signiert-1'')', v_ws),
    'Dokument ist als Zahlungsnachweis verknuepft');
end $$;

/* ------------------------------------------------------------------ */
/* F -- Rollen                                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
begin
  -- Mitglied: kein Finanzrecht.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1002'::uuid);
  perform pg_temp.erwarte_fehler('F1 Mitglied legt Mitarbeiter an',
    format('select public.upsert_workspace_employee(%L, pg_temp.mitarbeiter(''emp-m'', ''Mitglied''), 0)', v_ws),
    'finance_forbidden_role');
  perform pg_temp.erwarte_fehler('F2 Mitglied zahlt',
    format('select pg_temp.zahlung(%L, ''pay-m'', ''MZ-20261007-ABCDEFGM'')', v_ws),
    'finance_forbidden_role');
  perform pg_temp.erwarte_fehler('F3 Mitglied storniert',
    format('select public.reverse_workspace_employee_payment(%L, ''pay-3'', ''Versuch'')', v_ws),
    'finance_forbidden_role');
  perform pg_temp.erwarte_fehler('F4 Mitglied setzt Nachweis',
    format('select public.set_workspace_employee_payment_proof(%L, ''pay-3'', ''doc-frei'')', v_ws),
    'finance_forbidden_role');
  perform pg_temp.erwarte_fehler('F5 Mitglied liest',
    format('select public.pull_workspace_employee_data(%L)', v_ws),
    'Kein Zugriff');

  -- Fremder Betrieb.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1003'::uuid);
  perform pg_temp.erwarte_fehler('F6 fremder Inhaber schreibt',
    format('select public.upsert_workspace_employee(%L, pg_temp.mitarbeiter(''emp-f'', ''Fremd''), 0)', v_ws),
    'Kein Zugriff');
  perform pg_temp.erwarte_fehler('F7 fremder Inhaber liest',
    format('select public.pull_workspace_employee_data(%L)', v_ws),
    'Kein Zugriff');

  -- Gesperrtes Konto mit Verwaltungsrolle.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1004'::uuid);
  perform pg_temp.erwarte_fehler('F8 gesperrtes Konto',
    format('select pg_temp.zahlung(%L, ''pay-g'', ''MZ-20261007-ABCDEFGK'')', v_ws),
    'finance_account_blocked');
end $$;

/* ------------------------------------------------------------------ */
/* G -- RLS bei direktem Zugriff                                       */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000e1002'::uuid);
set local role authenticated;

do $$
begin
  if (select count(*) from public.workspace_employee_payments) <> 0 then
    raise exception 'G1 Mitglied darf keine Zahlungen sehen';
  end if;
  if (select count(*) from public.workspace_employees) <> 0 then
    raise exception 'G2 Mitglied darf keine Mitarbeiter sehen';
  end if;
  begin
    insert into public.workspace_employees (workspace_id, client_employee_id, name)
    values ('00000000-0000-0000-0000-0000000e1a01', 'emp-direkt', 'Direkt');
    raise exception 'G3 direkter Insert darf nicht gelingen';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.workspace_employee_payments set amount = 1;
    raise exception 'G4 direktes Update darf nicht gelingen';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.workspace_employee_payments;
    raise exception 'G5 direktes Löschen darf nicht gelingen';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);
set local role authenticated;

do $$
begin
  if (select count(*) from public.workspace_employee_payments) <> 5 then
    raise exception 'G6 Inhaber liest alle fünf Zahlungen';
  end if;
  begin
    update public.workspace_employee_payments set amount = 1;
    raise exception 'G7 auch der Inhaber ändert Geld nie direkt';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

/* ------------------------------------------------------------------ */
/* H -- Abzug                                                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-0000000e1a01';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000e1001'::uuid);
  v := public.pull_workspace_employee_data(v_ws);
  if jsonb_array_length(v->'employees') <> 2 then raise exception 'H1 zwei Mitarbeiter: %', v->'employees'; end if;
  if jsonb_array_length(v->'payments') <> 5 then raise exception 'H2 fünf Zahlungen: %', v->'payments'; end if;
  if (select count(*) from jsonb_array_elements(v->'payments') e where e->>'reversed_at' is not null) <> 2 then
    raise exception 'H3 stornierte Zahlungen bleiben im Abzug';
  end if;
  if exists (select 1 from jsonb_array_elements(v->'payments') e where e->>'client_payment_id' = 'pay-1'
             and (e->>'receipt_document_id' <> 'emp-receipt-pay-1' or e->>'proof_document_id' <> 'doc-signiert-1')) then
    raise exception 'H4 Belege bleiben nach Storno erhalten';
  end if;
end $$;

select 'P1 MITARBEITERZAHLUNGEN SQL-Vertrag: alle Zusicherungen erfuellt';

rollback;
