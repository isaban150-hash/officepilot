-- FINANZ-CORE-01A -- Feiertage an Fristenden nach Paragraf 193 BGB (Migration 20261118120000),
-- Nacharbeit zu WEISS FC01A-END16-R1 (Fristende Fr 01.05.2026, Zahlung Mo 04.05.2026).
--
-- Gleiche Vektoren wie der Client (src/services/fristen/fristenVektoren.json, wortgleich zwischen den
-- Markierungen unten; der Client-Test prueft die Gleichheit). Dazu die Lage echter Rechnungen und die
-- Wirkung auf offenen Betrag, Schlussrechnung, Zahlungsannahme und Bankabgleich.
--
-- Seit der Gesamtnacharbeit (20261119120000, INV-02/03): Ausland ohne Hoechstdauer, Lage bei der Freigabe
-- gebunden, Klaerung an der Rechnung (FT5, FT12, FT14).
--
-- Setzt die Migrationen 20261114120000 bis 20261119120000 voraus. Ausfuehren (nur lokal, niemals
-- --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_feiertage.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles wird
-- zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fe101', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-feiertage-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-feiertage-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fe10', 'FC01A Feiertage', '00000000-0000-0000-0000-0000000fe101');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000fe10', '00000000-0000-0000-0000-0000000fe101', 'owner', 'active');

/* Kunden: ohne Angabe (PLZ entscheidet), Grenz-PLZ, ausdrücklich Sachsen mit Fronleichnam, Ausland, gelöscht. */
insert into public.workspace_customers (workspace_id, customer_id, payload, deleted)
values
  ('00000000-0000-0000-0000-00000000fe10', 'cust-nw', '{"id":"cust-nw","name":"Bielefeld GmbH"}'::jsonb, false),
  ('00000000-0000-0000-0000-00000000fe10', 'cust-grenz', '{"id":"cust-grenz","name":"Rheine GmbH"}'::jsonb, false),
  ('00000000-0000-0000-0000-00000000fe10', 'cust-sn', '{"id":"cust-sn","name":"Bautzen GmbH","holidayLocation":{"region":"SN","fronleichnam":true}}'::jsonb, false),
  ('00000000-0000-0000-0000-00000000fe10', 'cust-at', '{"id":"cust-at","name":"Wien GmbH","holidayLocation":{"region":"AUSLAND"}}'::jsonb, false),
  ('00000000-0000-0000-0000-00000000fe10', 'cust-weg', '{"id":"cust-weg","name":"Alt GmbH","holidayLocation":{"region":"BY"}}'::jsonb, true);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fe101');

create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 and position(p_expected in sqlstate) = 0 then
      raise exception '% — falscher Fehler: % (%)', p_label, sqlerrm, sqlstate;
    end if;
    raise notice 'OK  %: %', p_label, left(sqlerrm, 120);
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

create function pg_temp.adresse(p_zip text, p_land text) returns jsonb language sql immutable as $p$
  select jsonb_strip_nulls(jsonb_build_object('name', 'Muster GmbH', 'street', 'Weg 1', 'zip', p_zip, 'city', 'Musterstadt', 'countryCode', p_land));
$p$;

/*
 * Auftrag + Pauschalabschlag 400/476 (19 %): Rechnungsdatum p_datum, Skontotext p_skonto, Kunde p_kunde mit
 * Anschrift p_zip/p_land, Zusatzfelder p_extra; optional eine Zahlung p_zahlung am p_tag.
 */
create function pg_temp.abschlag(p_vorgang text, p_datum text, p_skonto text, p_kunde text, p_zip text, p_land text,
  p_extra jsonb, p_zahlung numeric, p_tag text)
returns void language plpgsql as $p$
begin
  perform public.create_workspace_order('00000000-0000-0000-0000-00000000fe10', p_vorgang, jsonb_build_object(
    'customerId', p_kunde, 'customerBilling', pg_temp.adresse(p_zip, p_land),
    'title', 'FC01A Feiertage', 'baustelle', '', 'taxStatus', 'standard_19',
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb));
  perform public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fe10', p_vorgang, 'inv-' || p_vorgang || '-ab',
    jsonb_build_object(
      'type', 'abschlag', 'taxStatus', 'standard_19', 'legalNotices', '[]'::jsonb,
      'issueDate', p_datum, 'calculationMode', 'fixed_amount', 'fixedAmountNet', 400, 'abschlagNumber', 1,
      'customerId', p_kunde, 'customerSnapshot', pg_temp.adresse(p_zip, p_land),
      'positions', '[]'::jsonb, 'subtotal', 400, 'amount', 476, 'skontoText', p_skonto) || coalesce(p_extra, '{}'::jsonb));
  if p_zahlung is not null then
    perform public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fe10', 'inv-' || p_vorgang || '-ab',
      'pay-' || p_vorgang, p_zahlung, p_tag, null, null, 'bank');
  end if;
end;
$p$;

create function pg_temp.zahlung(p_vorgang text, p_id text, p_betrag numeric, p_tag text) returns void language sql as $p$
  select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fe10', 'inv-' || p_vorgang || '-ab',
    p_id, p_betrag, p_tag, null, null, 'bank');
$p$;

create function pg_temp.offen(p_vorgang text) returns numeric language sql stable as $p$
  select public.workspace_invoice_open_cents('00000000-0000-0000-0000-00000000fe10', 'inv-' || p_vorgang || '-ab');
$p$;

create function pg_temp.erwarte_offen(p_label text, p_vorgang text, p_cents numeric) returns void language plpgsql as $p$
declare
  v numeric := pg_temp.offen(p_vorgang);
begin
  if v is distinct from p_cents then
    raise exception '% — offen % Cent, erwartet %', p_label, v, p_cents;
  end if;
  raise notice 'OK  %: offen % Cent', p_label, v;
end;
$p$;

/* Schlussrechnung 100 Stunden zu 100 mit Abzug des Abschlags (gezahlt/Skonto eingefroren). */
create function pg_temp.schluss(p_vorgang text, p_paid numeric, p_skonto numeric) returns jsonb language sql as $p$
  select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fe10', p_vorgang, 'inv-' || p_vorgang || '-schluss',
    jsonb_build_object(
      'type', 'schluss', 'taxStatus', 'standard_19', 'legalNotices', '[]'::jsonb, 'issueDate', '2026-10-05',
      'customerId', a.payload->'customerId', 'customerSnapshot', a.payload->'customerSnapshot',
      'positions', jsonb_build_array(jsonb_build_object('id', 'line-s', 'orderPositionId', 'cp1', 'description', 'Montagestunden',
        'quantity', 100, 'unit', 'Stück', 'unitPrice', 100, 'lineTotal', 10000)),
      'subtotal', 10000, 'amount', 11424,
      'previousAbschlagDeductions', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'invoiceId', a.client_invoice_id, 'invoiceNumber', a.invoice_number, 'abschlagNumber', a.payload->'abschlagNumber',
        'date', a.payload->>'issueDate', 'subtotal', a.payload->'subtotal', 'amount', a.payload->'amount',
        'paidAmount', p_paid, 'skontoAmount', p_skonto)))))
  from public.workspace_invoices a
  where a.workspace_id = '00000000-0000-0000-0000-00000000fe10' and a.client_invoice_id = 'inv-' || p_vorgang || '-ab';
$p$;

/* Eine Bankbewegung (Cent, Buchungstag) im Betrieb fe10. */
create function pg_temp.bank(p_id text, p_cents bigint, p_date date) returns void language sql as $p$
  insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name,
    imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)
  values ('00000000-0000-0000-0000-00000000fe10', p_id, 'ft-bacc', 'ft-import', 'FT.csv',
    now(), p_date, p_cents, 'fp-' || p_id, 1, '{}'::jsonb, auth.uid(), auth.uid());
$p$;

insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
values ('00000000-0000-0000-0000-00000000fe10', 'ft-bacc', 'FT synthetisch', 'DE00FT', '{}'::jsonb,
        '00000000-0000-0000-0000-0000000fe101', '00000000-0000-0000-0000-0000000fe101');

create function pg_temp.sortiert(p jsonb) returns text[] language sql immutable as $p$
  select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(coalesce(p, '[]'::jsonb)) x;
$p$;

do $$
declare
  neu constant text := 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';
  alt constant text := 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';
  -- VEKTOREN-ANFANG (wortgleich mit src/services/fristen/fristenVektoren.json)
  v jsonb := $vektoren${
  "ostern": [
    [1999, "1999-04-04"],
    [2000, "2000-04-23"],
    [2019, "2019-04-21"],
    [2024, "2024-03-31"],
    [2025, "2025-04-20"],
    [2026, "2026-04-05"],
    [2027, "2027-03-28"],
    [2028, "2028-04-16"],
    [2038, "2038-04-25"]
  ],
  "feiertage": [
    ["2026-01-01", "HH", "feiertag"],
    ["2026-01-06", "BY", "feiertag"],
    ["2026-01-06", "NW", "kein"],
    ["2026-04-03", "NW", "feiertag"],
    ["2026-04-05", "BB", "kein"],
    ["2026-04-06", "SH", "feiertag"],
    ["2026-05-01", "NW", "feiertag"],
    ["2026-05-14", "HH", "feiertag"],
    ["2026-05-25", "BY", "feiertag"],
    ["2026-06-04", "NW", "feiertag"],
    ["2026-06-04", "NI", "kein"],
    ["2026-06-04", "SN", "gemeinde:fronleichnam"],
    ["2026-06-04", "TH", "gemeinde:fronleichnam"],
    ["2028-08-08", "BY", "gemeinde:augsburgerFriedensfest"],
    ["2028-08-08", "BW", "kein"],
    ["2028-08-15", "SL", "feiertag"],
    ["2028-08-15", "BY", "gemeinde:mariaeHimmelfahrt"],
    ["2028-08-15", "NW", "kein"],
    ["2019-09-20", "TH", "feiertag"],
    ["2018-09-20", "TH", "kein"],
    ["2026-10-03", "HE", "feiertag"],
    ["2016-10-31", "NI", "kein"],
    ["2017-10-31", "NW", "feiertag"],
    ["2018-10-31", "NI", "feiertag"],
    ["2026-10-31", "SN", "feiertag"],
    ["2026-11-01", "BW", "feiertag"],
    ["2026-11-01", "BE", "kein"],
    ["2026-11-18", "SN", "feiertag"],
    ["2026-11-18", "BY", "kein"],
    ["2018-03-08", "BE", "kein"],
    ["2019-03-08", "BE", "feiertag"],
    ["2022-03-08", "MV", "kein"],
    ["2023-03-08", "MV", "feiertag"],
    ["2025-05-08", "BE", "feiertag"],
    ["2025-05-08", "BB", "kein"],
    ["2026-05-08", "BE", "kein"],
    ["2026-12-24", "BY", "kein"],
    ["2026-12-25", "BY", "feiertag"],
    ["2026-12-26", "BY", "feiertag"]
  ],
  "plz": [
    ["33602", { "laender": ["NW"], "augsburg": "nein" }],
    ["48431", { "laender": ["NI", "NW"], "augsburg": "nein" }],
    ["86150", { "laender": ["BY"], "augsburg": "ja" }],
    ["86343", { "laender": ["BY"], "augsburg": "nein" }],
    ["01067", { "laender": ["SN"], "augsburg": "nein" }],
    ["99084", { "laender": ["TH"], "augsburg": "nein" }],
    ["10115", { "laender": ["BE"], "augsburg": "nein" }],
    ["80001", { "laender": ["BY"], "augsburg": "nein" }],
    ["1234", null],
    ["ABCDE", null],
    ["", null]
  ],
  "fenster": [
    { "name": "V01 WEISS: Fr 01.05. (bundesweit), Sitz NW", "ende": "2026-05-01", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-05-04", "spaetestens": "2026-05-04" },
    { "name": "V02 Fr 01.05., Ort unbekannt", "ende": "2026-05-01", "lage": { "art": "inland", "laender": ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"], "gemeinde": {} }, "fruehestens": "2026-05-04", "spaetestens": "2026-05-04" },
    { "name": "V03 Samstag", "ende": "2026-09-12", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-09-14", "spaetestens": "2026-09-14" },
    { "name": "V04 Werktag bleibt", "ende": "2026-09-14", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-09-14", "spaetestens": "2026-09-14" },
    { "name": "V05 Fronleichnam NW", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-06-05", "spaetestens": "2026-06-05" },
    { "name": "V06 Fronleichnam NI", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["NI"], "gemeinde": {} }, "fruehestens": "2026-06-04", "spaetestens": "2026-06-04" },
    { "name": "V07 Fronleichnam Grenz-PLZ NI+NW", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["NI", "NW"], "gemeinde": {} }, "fruehestens": "2026-06-04", "spaetestens": "2026-06-05" },
    { "name": "V08 Fronleichnam SN ohne Angabe", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["SN"], "gemeinde": {} }, "fruehestens": "2026-06-04", "spaetestens": "2026-06-05" },
    { "name": "V09 Fronleichnam SN, am Sitz Feiertag", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["SN"], "gemeinde": { "fronleichnam": true } }, "fruehestens": "2026-06-05", "spaetestens": "2026-06-05" },
    { "name": "V10 Fronleichnam SN, am Sitz kein Feiertag", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["SN"], "gemeinde": { "fronleichnam": false } }, "fruehestens": "2026-06-04", "spaetestens": "2026-06-04" },
    { "name": "V11 Karfreitag bis Ostermontag", "ende": "2026-04-03", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-04-07", "spaetestens": "2026-04-07" },
    { "name": "V12 Weihnachten und Wochenende", "ende": "2026-12-25", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-12-28", "spaetestens": "2026-12-28" },
    { "name": "V13 Silvester ist Werktag", "ende": "2026-12-31", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-12-31", "spaetestens": "2026-12-31" },
    { "name": "V14 Neujahr, Jahreswechsel", "ende": "2027-01-01", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2027-01-04", "spaetestens": "2027-01-04" },
    { "name": "V15 Monatswechsel", "ende": "2026-05-31", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-06-01", "spaetestens": "2026-06-01" },
    { "name": "V16 Pfingstmontag", "ende": "2026-05-25", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": {} }, "fruehestens": "2026-05-26", "spaetestens": "2026-05-26" },
    { "name": "V17 Reformationstag 2025 NI", "ende": "2025-10-31", "lage": { "art": "inland", "laender": ["NI"], "gemeinde": {} }, "fruehestens": "2025-11-03", "spaetestens": "2025-11-03" },
    { "name": "V18 Reformationstag 2025 NW kein Feiertag", "ende": "2025-10-31", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2025-10-31", "spaetestens": "2025-10-31" },
    { "name": "V19 2017 Reformationstag und Allerheiligen NW", "ende": "2017-10-31", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2017-11-02", "spaetestens": "2017-11-02" },
    { "name": "V20 2017 Reformationstag NI, Allerheiligen nicht", "ende": "2017-10-31", "lage": { "art": "inland", "laender": ["NI"], "gemeinde": {} }, "fruehestens": "2017-11-01", "spaetestens": "2017-11-01" },
    { "name": "V21 Buss- und Bettag SN", "ende": "2026-11-18", "lage": { "art": "inland", "laender": ["SN"], "gemeinde": {} }, "fruehestens": "2026-11-19", "spaetestens": "2026-11-19" },
    { "name": "V22 Buss- und Bettag BY kein Feiertag", "ende": "2026-11-18", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": {} }, "fruehestens": "2026-11-18", "spaetestens": "2026-11-18" },
    { "name": "V23 Heilige Drei Koenige BY", "ende": "2026-01-06", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": {} }, "fruehestens": "2026-01-07", "spaetestens": "2026-01-07" },
    { "name": "V24 Heilige Drei Koenige NW", "ende": "2026-01-06", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2026-01-06", "spaetestens": "2026-01-06" },
    { "name": "V25 Frauentag BE 2027", "ende": "2027-03-08", "lage": { "art": "inland", "laender": ["BE"], "gemeinde": {} }, "fruehestens": "2027-03-09", "spaetestens": "2027-03-09" },
    { "name": "V26 Frauentag MV 2022 noch nicht", "ende": "2022-03-08", "lage": { "art": "inland", "laender": ["MV"], "gemeinde": {} }, "fruehestens": "2022-03-08", "spaetestens": "2022-03-08" },
    { "name": "V27 Frauentag MV 2023", "ende": "2023-03-08", "lage": { "art": "inland", "laender": ["MV"], "gemeinde": {} }, "fruehestens": "2023-03-09", "spaetestens": "2023-03-09" },
    { "name": "V28 Weltkindertag TH 2027", "ende": "2027-09-20", "lage": { "art": "inland", "laender": ["TH"], "gemeinde": {} }, "fruehestens": "2027-09-21", "spaetestens": "2027-09-21" },
    { "name": "V29 Weltkindertag TH 2018 noch nicht", "ende": "2018-09-20", "lage": { "art": "inland", "laender": ["TH"], "gemeinde": {} }, "fruehestens": "2018-09-20", "spaetestens": "2018-09-20" },
    { "name": "V30 Mariae Himmelfahrt SL", "ende": "2028-08-15", "lage": { "art": "inland", "laender": ["SL"], "gemeinde": {} }, "fruehestens": "2028-08-16", "spaetestens": "2028-08-16" },
    { "name": "V31 Mariae Himmelfahrt BY ohne Angabe", "ende": "2028-08-15", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": {} }, "fruehestens": "2028-08-15", "spaetestens": "2028-08-16" },
    { "name": "V32 Mariae Himmelfahrt BY, am Sitz Feiertag", "ende": "2028-08-15", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": { "mariaeHimmelfahrt": true } }, "fruehestens": "2028-08-16", "spaetestens": "2028-08-16" },
    { "name": "V33 Mariae Himmelfahrt BY, am Sitz kein Feiertag", "ende": "2028-08-15", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": { "mariaeHimmelfahrt": false } }, "fruehestens": "2028-08-15", "spaetestens": "2028-08-15" },
    { "name": "V34 Augsburger Friedensfest, Stadt Augsburg", "ende": "2028-08-08", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": { "augsburgerFriedensfest": true } }, "fruehestens": "2028-08-09", "spaetestens": "2028-08-09" },
    { "name": "V35 Augsburger Friedensfest, ausserhalb", "ende": "2028-08-08", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": { "augsburgerFriedensfest": false } }, "fruehestens": "2028-08-08", "spaetestens": "2028-08-08" },
    { "name": "V36 Augsburger Friedensfest, ungeklaert", "ende": "2028-08-08", "lage": { "art": "inland", "laender": ["BY"], "gemeinde": {} }, "fruehestens": "2028-08-08", "spaetestens": "2028-08-09" },
    { "name": "V37 Tag der Befreiung BE 2025", "ende": "2025-05-08", "lage": { "art": "inland", "laender": ["BE"], "gemeinde": {} }, "fruehestens": "2025-05-09", "spaetestens": "2025-05-09" },
    { "name": "V38 Tag der Befreiung nicht 2026", "ende": "2026-05-08", "lage": { "art": "inland", "laender": ["BE"], "gemeinde": {} }, "fruehestens": "2026-05-08", "spaetestens": "2026-05-08" },
    { "name": "V39 Ausland ohne Bestaetigung: Ende offen", "ende": "2026-05-01", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": false }, "fruehestens": "2026-05-01", "spaetestens": null },
    { "name": "V40 Ausland bestaetigt", "ende": "2026-05-01", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": true }, "fruehestens": "2026-05-01", "spaetestens": "2026-05-01" },
    { "name": "V41 Ausland, Ende Samstag: Ende offen", "ende": "2026-05-02", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": false }, "fruehestens": "2026-05-04", "spaetestens": null },
    { "name": "V42 abweichend vereinbart, Samstag", "ende": "2026-05-02", "lage": { "art": "abbedungen" }, "fruehestens": "2026-05-02", "spaetestens": "2026-05-02" },
    { "name": "V43 abweichend vereinbart, Feiertag", "ende": "2026-05-01", "lage": { "art": "abbedungen" }, "fruehestens": "2026-05-01", "spaetestens": "2026-05-01" },
    { "name": "V44 Fronleichnam, Ort unbekannt", "ende": "2026-06-04", "lage": { "art": "inland", "laender": ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"], "gemeinde": {} }, "fruehestens": "2026-06-04", "spaetestens": "2026-06-05" },
    { "name": "V45 Reformationstag 2025, Ort unbekannt, dann Wochenende", "ende": "2025-10-31", "lage": { "art": "inland", "laender": ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"], "gemeinde": {} }, "fruehestens": "2025-10-31", "spaetestens": "2025-11-03" },
    { "name": "V46 Christi Himmelfahrt HH", "ende": "2026-05-14", "lage": { "art": "inland", "laender": ["HH"], "gemeinde": {} }, "fruehestens": "2026-05-15", "spaetestens": "2026-05-15" },
    { "name": "V47 Karfreitag 2027 bis Ostermontag", "ende": "2027-03-26", "lage": { "art": "inland", "laender": ["NW"], "gemeinde": {} }, "fruehestens": "2027-03-30", "spaetestens": "2027-03-30" },
    { "name": "V48 Ausland, vier gesetzliche Feiertage (Fruehlingsfest 2026), Ende offen", "ende": "2026-02-16", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": false }, "fruehestens": "2026-02-16", "spaetestens": null },
    { "name": "V49 Ausland, geprueftes Ende", "ende": "2026-02-16", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": false, "geprueft": { "2026-02-16": "2026-02-24" } }, "fruehestens": "2026-02-24", "spaetestens": "2026-02-24" },
    { "name": "V50 Ausland, Pruefung zu anderem Fristende gilt nicht", "ende": "2026-03-02", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": false, "geprueft": { "2026-02-16": "2026-02-24" } }, "fruehestens": "2026-03-02", "spaetestens": null },
    { "name": "V51 Ausland, gepruefter Tag vor dem Wochenendende zaehlt nicht", "ende": "2026-05-02", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": false, "geprueft": { "2026-05-02": "2026-05-02" } }, "fruehestens": "2026-05-04", "spaetestens": null },
    { "name": "V52 Ausland bestaetigt, gepruefte Angabe geht vor", "ende": "2026-05-01", "lage": { "art": "ausland", "ohneFeiertagBestaetigt": true, "geprueft": { "2026-05-01": "2026-05-04" } }, "fruehestens": "2026-05-04", "spaetestens": "2026-05-04" }
  ]
}$vektoren$::jsonb;
  -- VEKTOREN-ENDE
  e jsonb;
  f record;
  r jsonb;
  ws constant uuid := '00000000-0000-0000-0000-00000000fe10';
  n integer;
begin
  /* FT1 -- Ostersonntag (gemeinsame Vektoren). */
  n := 0;
  for e in select * from jsonb_array_elements(v->'ostern') loop
    if public.workspace_osterdatum((e->>0)::integer) is distinct from (e->>1)::date then
      raise exception 'FT1: Ostern % = %, erwartet %', e->>0, public.workspace_osterdatum((e->>0)::integer), e->>1;
    end if;
    n := n + 1;
  end loop;
  raise notice 'OK  FT1: % Osterdaten', n;

  /* FT2 -- Feiertag je Land (gemeinsame Vektoren). */
  n := 0;
  for e in select * from jsonb_array_elements(v->'feiertage') loop
    if public.workspace_feiertag_im_land((e->>0)::date, e->>1) is distinct from e->>2 then
      raise exception 'FT2: % % = %, erwartet %', e->>0, e->>1, public.workspace_feiertag_im_land((e->>0)::date, e->>1), e->>2;
    end if;
    n := n + 1;
  end loop;
  raise notice 'OK  FT2: % Feiertagsvektoren (bundesweit, regional, Gemeinde, Stichtage)', n;

  /* FT3 -- PLZ -> Länder (gemeinsame Vektoren; Reihenfolge der Länder zählt nicht). */
  n := 0;
  for e in select * from jsonb_array_elements(v->'plz') loop
    r := public.workspace_laender_fuer_plz(e->>0);
    if jsonb_typeof(e->1) = 'null' then
      if r is not null then raise exception 'FT3: PLZ "%" = %, erwartet NULL', e->>0, r; end if;
    elsif r is null or pg_temp.sortiert(r->'laender') <> pg_temp.sortiert(e->1->'laender') or r->>'augsburg' <> e->1->>'augsburg' then
      raise exception 'FT3: PLZ % = %, erwartet %', e->>0, r, e->1;
    end if;
    n := n + 1;
  end loop;
  raise notice 'OK  FT3: % PLZ-Vektoren (eindeutig, Grenze, Augsburg, Rückfall Leitregion, ungültig)', n;

  /* FT4 -- PLZ-Tabelle = Client-Tabelle (kanonische md5 wie im Generator). */
  if (select md5(string_agg(leitbereich || ':' || array_to_string(laender, '+') || ':' || augsburg, E'\n' order by leitbereich))
      from public.workspace_plz_leitbereiche) <> '9225419144963c0adeff70fb690b2de8'
     or (select count(*) from public.workspace_plz_leitbereiche) <> 676 then
    raise exception 'FT4: PLZ-Tabelle weicht von der Client-Tabelle ab';
  end if;
  raise notice 'OK  FT4: PLZ-Tabelle 676 Leitbereiche, md5 9225419144963c0adeff70fb690b2de8 = Client';

  /* FT5 -- Fristfenster (gemeinsame Vektoren). */
  n := 0;
  for e in select * from jsonb_array_elements(v->'fenster') loop
    select * into f from public.workspace_fristfenster((e->>'ende')::date, e->'lage');
    /* INV-02 -- spaetestens null im Vektor heisst offen (Server: infinity). */
    if f.fruehestens is distinct from (e->>'fruehestens')::date
       or f.spaetestens is distinct from coalesce((e->>'spaetestens')::date, 'infinity'::date) then
      raise exception 'FT5: % = % bis %, erwartet % bis %', e->>'name', f.fruehestens, f.spaetestens, e->>'fruehestens', e->>'spaetestens';
    end if;
    n := n + 1;
  end loop;
  raise notice 'OK  FT5: % Fristfenster (Wochenende, Feiertagsketten, Monats-/Jahreswechsel, Grenze, Gemeinde, Ausland, Vereinbarung)', n;

  /* FT6 -- Lage einer Rechnung: Vereinbarung, Kunde, gelöschter Kunde, Land, Österreich-PLZ, PLZ, unbekannt. */
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('deadlineShiftWaived', true, 'customerId', 'cust-sn'));
  if r->>'art' <> 'abbedungen' then raise exception 'FT6a: %', r; end if;
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('customerId', 'cust-sn', 'customerSnapshot', pg_temp.adresse('33602', null)));
  if r->>'art' <> 'inland' or r->'laender' <> '["SN"]'::jsonb or r->'gemeinde' <> '{"fronleichnam": true}'::jsonb or r->>'quelle' <> 'kunde' then
    raise exception 'FT6b: Kunde geht der PLZ vor: %', r;
  end if;
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('customerId', 'cust-weg', 'customerSnapshot', pg_temp.adresse('33602', null)));
  if r->'laender' <> '["NW"]'::jsonb or r->>'quelle' <> 'plz' then raise exception 'FT6c: gelöschter Kunde zählt: %', r; end if;
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('customerId', 'cust-at'));
  if r->>'art' <> 'ausland' or (r->>'ohneFeiertagBestaetigt')::boolean then raise exception 'FT6d: %', r; end if;
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('customerSnapshot', pg_temp.adresse('1010', 'at')));
  if r->>'art' <> 'ausland' or r->>'quelle' <> 'land' then raise exception 'FT6e: %', r; end if;
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('customerSnapshot', pg_temp.adresse('87567', null)));
  if r->>'art' <> 'ausland' or r->>'quelle' <> 'plz' then raise exception 'FT6f: Kleinwalsertal: %', r; end if;
  r := public.workspace_invoice_frist_lage(ws, jsonb_build_object('customerSnapshot', pg_temp.adresse('86150', 'DE')));
  if r->'laender' <> '["BY"]'::jsonb or r->'gemeinde' <> '{"augsburgerFriedensfest": true}'::jsonb then raise exception 'FT6g: %', r; end if;
  r := public.workspace_invoice_frist_lage(ws, '{}'::jsonb);
  if r->>'quelle' <> 'unbekannt' or jsonb_array_length(r->'laender') <> 16 then raise exception 'FT6h: %', r; end if;
  raise notice 'OK  FT6: Lage: Vereinbarung > Kunde > (gelöschter Kunde zählt nicht) > Land > Österreich-PLZ > PLZ > unbekannt';

  /* FT7 -- WEISS FC01A-END16-R1: Di 21.04. + 10 = Fr 01.05. (Feiertag) -> Mo 04.05.; 466,48 am Montag: ausgeglichen. */
  perform pg_temp.abschlag('ft7', '2026-04-21', neu, 'cust-nw', '33602', null, null, 466.48, '2026-05-04');
  perform pg_temp.erwarte_offen('FT7 WEISS-Fall: Fristende Fr 01.05., Zahlung Mo 04.05.', 'ft7', 0);
  r := pg_temp.schluss('ft7', 466.48, 9.52);
  if r->'invoice'->>'type' is distinct from 'schluss' then raise exception 'FT7: Schlussrechnung nicht angenommen: %', r; end if;
  raise notice 'OK  FT7: Schlussrechnung mit Abzug 466,48 gezahlt + 9,52 Skonto angenommen (vorher invoice_abschlag_unpaid)';

  /* FT8 -- Dienstag 05.05. ist verspätet: 9,52 offen, Schlussrechnung abgewiesen. */
  perform pg_temp.abschlag('ft8', '2026-04-21', neu, 'cust-nw', '33602', null, null, 466.48, '2026-05-05');
  perform pg_temp.erwarte_offen('FT8 Zahlung Di 05.05.', 'ft8', 952);
  perform pg_temp.erwarte_fehler('FT8 Schlussrechnung nach verspäteter Skontozahlung',
    $q$select pg_temp.schluss('ft8', 466.48, 9.52)$q$, 'invoice_abschlag_unpaid');

  /* FT9 -- Teilzahlungen: 200 am Do 30.04. und 266,48 am Mo 04.05. (bisheriger Wortlaut): ausgeglichen. */
  perform pg_temp.abschlag('ft9', '2026-04-21', alt, 'cust-nw', '33602', null, null, 200, '2026-04-30');
  perform pg_temp.zahlung('ft9', 'pay-ft9-2', 266.48, '2026-05-04');
  perform pg_temp.erwarte_offen('FT9 Teilzahlungen bis Montag, bisheriger Wortlaut', 'ft9', 0);

  /* FT10 -- ausdrücklich abweichend vereinbart: Fristende kalendarisch Fr 01.05.; Montag verspätet. */
  perform pg_temp.abschlag('ft10', '2026-04-21', neu, 'cust-nw', '33602', null, '{"deadlineShiftWaived": true}'::jsonb, 466.48, '2026-05-04');
  perform pg_temp.erwarte_offen('FT10 Vereinbarung ohne Verschiebung', 'ft10', 952);

  /* FT11 -- Grenz-PLZ 48431 (NI+NW), Fronleichnam Do 04.06.: Zahlung Fr 05.06. ist ungeklärt -> keine Entscheidung. */
  perform pg_temp.abschlag('ft11', '2026-05-25', neu, 'cust-grenz', '48431', null, null, 466.48, '2026-06-05');
  perform pg_temp.erwarte_fehler('FT11a offener Betrag ungeklärt', $q$select pg_temp.offen('ft11')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.erwarte_fehler('FT11b Schlussrechnung', $q$select pg_temp.schluss('ft11', 466.48, 9.52)$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.erwarte_fehler('FT11c weitere Zahlung', $q$select pg_temp.zahlung('ft11', 'pay-ft11-2', 9.52, '2026-06-10')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.bank('btx-ft11', 952, '2026-06-10');
  perform pg_temp.erwarte_fehler('FT11d Bankabgleich',
    $q$select public.confirm_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fe10', 'btx-ft11', 'invoice', 'inv-ft11-ab', 'pay-ft11-b', 'rec-ft11')$q$,
    'invoice_skonto_deadline_unclear');

  /*
   * FT12 -- geklärt: Sitz Nordrhein-Westfalen (Fronleichnam) -> rechtzeitig, Schlussrechnung angenommen.
   * Seit 20261119 (INV-03) ist die Lage bei der Freigabe gebunden: Die spätere Angabe am Kunden ändert
   * die Rechnung nicht mehr; geklärt wird an der Rechnung selbst.
   */
  update public.workspace_customers set payload = payload || '{"holidayLocation":{"region":"NW"}}'::jsonb
  where workspace_id = ws and customer_id = 'cust-grenz';
  perform pg_temp.erwarte_fehler('FT12a Kundenangabe nach der Freigabe ändert die Rechnung nicht', $q$select pg_temp.offen('ft11')$q$, 'invoice_skonto_deadline_unclear');
  perform public.clarify_workspace_invoice_frist(ws, 'inv-ft11-ab', 'kl-ft11', '{"art":"inland","region":"NW"}'::jsonb, 'Sitz laut Handelsregister in Rheine (NW)');
  perform pg_temp.erwarte_offen('FT12 geklärt NW', 'ft11', 0);
  r := pg_temp.schluss('ft11', 466.48, 9.52);
  if r->'invoice'->>'type' is distinct from 'schluss' then raise exception 'FT12: Schlussrechnung nicht angenommen: %', r; end if;
  raise notice 'OK  FT12: nach Angabe NW Schlussrechnung angenommen';

  /* FT13 -- geklärt als Niedersachsen (kein Fronleichnam): verspätet. */
  update public.workspace_customers set payload = payload || '{"holidayLocation":{"region":"NI"}}'::jsonb
  where workspace_id = ws and customer_id = 'cust-grenz';
  perform pg_temp.abschlag('ft13', '2026-05-25', neu, 'cust-grenz', '48431', null, null, 466.48, '2026-06-05');
  perform pg_temp.erwarte_offen('FT13 geklärt NI', 'ft13', 952);

  /*
   * FT14 -- Ausland ohne Bestätigung: Zahlung Mo 04.05. ungeklärt (seit 20261119 ohne Höchstdauer, INV-02);
   * die Bestätigung am Kunden gilt für danach freigegebene Rechnungen (INV-03), geprüft wird je Fristende.
   */
  perform pg_temp.abschlag('ft14', '2026-04-21', neu, 'cust-at', '1010', 'AT', null, 466.48, '2026-05-04');
  perform pg_temp.erwarte_fehler('FT14a Ausland ungeklärt', $q$select pg_temp.offen('ft14')$q$, 'invoice_skonto_deadline_unclear');
  update public.workspace_customers set payload = payload || '{"holidayLocation":{"region":"AUSLAND","auslandOhneFeiertag":true}}'::jsonb
  where workspace_id = ws and customer_id = 'cust-at';
  perform pg_temp.erwarte_fehler('FT14b Bestätigung am Kunden nach der Freigabe ändert die Rechnung nicht', $q$select pg_temp.offen('ft14')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.abschlag('ft14n', '2026-04-21', neu, 'cust-at', '1010', 'AT', null, 466.48, '2026-05-04');
  perform pg_temp.erwarte_offen('FT14c danach freigegeben, am Kunden bestätigt ohne Feiertag', 'ft14n', 952);
  perform public.clarify_workspace_invoice_frist(ws, 'inv-ft14-ab', 'kl-ft14', '{"art":"ausland","kalenderEnde":"2026-05-01","wirksamesEnde":"2026-05-04"}'::jsonb, 'Staatsfeiertag 1. Mai in Wien geprüft');
  perform pg_temp.erwarte_offen('FT14d geprüftes Fristende Mo 04.05.', 'ft14', 0);

  /* FT15 -- Rechte: neue Funktionen und Tabelle nur für den Eigentümer. */
  if has_function_privilege('anon', 'public.workspace_osterdatum(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_feiertag_im_land(date, text)', 'execute')
     or has_function_privilege('service_role', 'public.workspace_feiertag_im_land(date, text)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_laender_fuer_plz(text)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_frist_tagstatus(date, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_fristfenster(date, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.workspace_invoice_frist_lage(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_invoice_frist_lage(uuid, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.workspace_invoice_frist_lage(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_invoice_open_cents(uuid, text)', 'execute')
     or has_table_privilege('anon', 'public.workspace_plz_leitbereiche', 'select')
     or has_table_privilege('authenticated', 'public.workspace_plz_leitbereiche', 'select')
     or has_table_privilege('service_role', 'public.workspace_plz_leitbereiche', 'select') then
    raise exception 'FT15: Feiertagsfunktionen oder PLZ-Tabelle sind von aussen erreichbar';
  end if;
  raise notice 'OK  FT15: Rechte nur Eigentümer';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
