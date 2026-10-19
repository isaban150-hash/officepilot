-- FINANZ-CORE-01A -- Gesamtnacharbeit Paket 1 (Migration 20261119120000): historische Frist- und
-- Zahlungsgrundlage. Nachgestellt sind die Faelle der WEISS-Gesamtmaengelinventur vom 15.10.2026:
--   P1  INV-03 / S1: Kundenumzug nach Schlussrechnung, Hand- und Bankzahlung, Wiederholung, Ruecknahme
--   P2  INV-01: Altbeleg ohne customerId (Grenz-PLZ 48431), Klaerung an der Rechnung
--   P3  INV-02: Ausland ohne Hoechstdauer (Fruehlingsfest 2026, 08.10.), gepruefte Fristenden
--   P4  Klaerung: Rechte, Eingaben, Wiederholung, Konflikt, Storno, Vereinbarung, Abschlag in Schlussrechnung,
--       Protokoll, Beleg unveraendert, Bindung unveraenderlich
--   P5  Kunde: alter Client laesst holidayLocation weg -> bleibt; ausdruecklich null -> entfernt
--   P6  INV-05: Zusatzgeld nach Skonto -- Schlussrechnung nimmt gezahlt = Betrag, Skonto 0
--   P7  Bindung bei der Freigabe und Rechte
--
-- Setzt die Migrationen 20261114120000 bis 20261119120000 voraus. Ausfuehren (nur lokal, niemals
-- --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_inventur_paket1.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles wird
-- zurueckgerollt.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fe201', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-inventur1-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000fe202', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-inventur1-mitglied@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-inventur1-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fe20', 'FC01A Inventur Paket 1', '00000000-0000-0000-0000-0000000fe201');
insert into public.workspace_members (workspace_id, user_id, role, status)
values
  ('00000000-0000-0000-0000-00000000fe20', '00000000-0000-0000-0000-0000000fe201', 'owner', 'active'),
  ('00000000-0000-0000-0000-00000000fe20', '00000000-0000-0000-0000-0000000fe202', 'member', 'active');

insert into public.workspace_customers (workspace_id, customer_id, payload, deleted)
values
  ('00000000-0000-0000-0000-00000000fe20', 'cust-nw', '{"id":"cust-nw","name":"Bielefeld GmbH"}'::jsonb, false),
  ('00000000-0000-0000-0000-00000000fe20', 'cust-grenz', '{"id":"cust-grenz","name":"Rheine GmbH","holidayLocation":{"region":"NW"}}'::jsonb, false),
  ('00000000-0000-0000-0000-00000000fe20', 'cust-alt', '{"id":"cust-alt","name":"Altclient GmbH","holidayLocation":{"region":"SN","fronleichnam":false}}'::jsonb, false);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fe201');

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

/* Auftrag + Pauschalabschlag 400/476 (19 %), Skonto 2 % in 10 Tagen ab Rechnungsdatum; optional eine Zahlung. */
create function pg_temp.abschlag(p_vorgang text, p_datum text, p_kunde text, p_zip text, p_land text,
  p_extra jsonb, p_zahlung numeric, p_tag text)
returns void language plpgsql as $p$
begin
  perform public.create_workspace_order('00000000-0000-0000-0000-00000000fe20', p_vorgang, jsonb_build_object(
    'customerId', p_kunde, 'customerBilling', pg_temp.adresse(p_zip, p_land),
    'title', 'FC01A Inventur', 'baustelle', '', 'taxStatus', 'standard_19',
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb));
  perform public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fe20', p_vorgang, 'inv-' || p_vorgang || '-ab',
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'abschlag', 'taxStatus', 'standard_19', 'legalNotices', '[]'::jsonb,
      'issueDate', p_datum, 'calculationMode', 'fixed_amount', 'fixedAmountNet', 400, 'abschlagNumber', 1,
      'customerId', p_kunde, 'customerSnapshot', pg_temp.adresse(p_zip, p_land),
      'positions', '[]'::jsonb, 'subtotal', 400, 'amount', 476,
      'skontoText', 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.')) || coalesce(p_extra, '{}'::jsonb));
  if p_zahlung is not null then
    perform public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fe20', 'inv-' || p_vorgang || '-ab',
      'pay-' || p_vorgang, p_zahlung, p_tag, null, null, 'bank');
  end if;
end;
$p$;

create function pg_temp.zahlung(p_vorgang text, p_id text, p_betrag numeric, p_tag text, p_bestaetigt boolean default false)
returns void language sql as $p$
  select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fe20', 'inv-' || p_vorgang || '-ab',
    p_id, p_betrag, p_tag, null, null, 'bank', p_bestaetigt);
$p$;

create function pg_temp.offen(p_vorgang text) returns numeric language sql stable as $p$
  select public.workspace_invoice_open_cents('00000000-0000-0000-0000-00000000fe20', 'inv-' || p_vorgang || '-ab');
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

create function pg_temp.gezahlt(p_vorgang text) returns numeric language sql stable as $p$
  select coalesce(sum(amount), 0) from public.workspace_invoice_payments
  where workspace_id = '00000000-0000-0000-0000-00000000fe20' and client_invoice_id = 'inv-' || p_vorgang || '-ab'
    and reversed_at is null;
$p$;

/* Schlussrechnung 100 Stunden zu 100 mit Abzug des Abschlags (gezahlt/Skonto eingefroren). */
create function pg_temp.schluss(p_vorgang text, p_paid numeric, p_skonto numeric) returns jsonb language sql as $p$
  select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fe20', p_vorgang, 'inv-' || p_vorgang || '-schluss',
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
  where a.workspace_id = '00000000-0000-0000-0000-00000000fe20' and a.client_invoice_id = 'inv-' || p_vorgang || '-ab';
$p$;

create function pg_temp.bank(p_id text, p_cents bigint, p_date date) returns void language sql as $p$
  insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name,
    imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)
  values ('00000000-0000-0000-0000-00000000fe20', p_id, 'iv-bacc', 'iv-import', 'IV.csv',
    now(), p_date, p_cents, 'fp-' || p_id, 1, '{}'::jsonb, auth.uid(), auth.uid());
$p$;

insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
values ('00000000-0000-0000-0000-00000000fe20', 'iv-bacc', 'IV synthetisch', 'DE00IV', '{}'::jsonb,
        '00000000-0000-0000-0000-0000000fe201', '00000000-0000-0000-0000-0000000fe201');

create function pg_temp.klaere(p_vorgang text, p_id text, p_klaerung jsonb, p_grund text default 'Sitz geprüft (Handelsregister)')
returns setof public.workspace_invoices language sql as $p$
  select * from public.clarify_workspace_invoice_frist('00000000-0000-0000-0000-00000000fe20', 'inv-' || p_vorgang || '-ab',
    p_id, p_klaerung, p_grund);
$p$;

create function pg_temp.basis(p_vorgang text) returns jsonb language sql stable as $p$
  select frist_basis from public.workspace_invoices
  where workspace_id = '00000000-0000-0000-0000-00000000fe20' and client_invoice_id = 'inv-' || p_vorgang || '-ab';
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fe20';
  r jsonb;
  v_payload_vorher jsonb;
  v_version_vorher bigint;
  n integer;
begin
  /* ------------------------------------------------------------------ P1 -- INV-03 / WEISS S1 */
  -- Kunde mit Sitz NW (Angabe am Kunden), Grenz-PLZ 48431; Fronleichnam Do 04.06.: Zahlung Fr 05.06. rechtzeitig.
  perform pg_temp.abschlag('s1', '2026-05-25', 'cust-grenz', '48431', null, null, 466.48, '2026-06-05');
  if pg_temp.basis('s1')->'lage'->'laender' is distinct from '["NW"]'::jsonb or pg_temp.basis('s1')->>'quelle' is distinct from 'freigabe' then
    raise exception 'P1: Lage nicht bei der Freigabe gebunden: %', pg_temp.basis('s1');
  end if;
  perform pg_temp.erwarte_offen('P1a NW: Zahlung Fr 05.06. rechtzeitig', 's1', 0);
  r := pg_temp.schluss('s1', 466.48, 9.52);
  if r->'invoice'->>'type' is distinct from 'schluss' then raise exception 'P1: Schlussrechnung nicht angenommen: %', r; end if;
  -- Umzug: Kunde jetzt NI. Die Rechnung bleibt bei ihrer Grundlage.
  update public.workspace_customers set payload = payload || '{"holidayLocation":{"region":"NI"}}'::jsonb
  where workspace_id = ws and customer_id = 'cust-grenz';
  perform pg_temp.erwarte_offen('P1b nach Kundenumzug NI weiter ausgeglichen (WEISS S1: 952)', 's1', 0);
  perform pg_temp.erwarte_fehler('P1c neue Handzahlung 9,52 hinter Schlussrechnung',
    $q$select pg_temp.zahlung('s1', 'pay-s1-topup', 9.52, '2026-06-10')$q$, 'invoice_payment_final_invoice_exists');
  perform pg_temp.erwarte_fehler('P1d dieselbe Zahlung ausdrücklich bestätigt',
    $q$select pg_temp.zahlung('s1', 'pay-s1-topup', 9.52, '2026-06-10', true)$q$, 'invoice_payment_final_invoice_exists');
  perform pg_temp.zahlung('s1', 'pay-s1', 466.48, '2026-06-05');
  raise notice 'OK  P1e Wiederholung der ursprünglichen Zahlung (gleiche Kennung) bleibt möglich';
  perform pg_temp.erwarte_fehler('P1f Rücknahme hinter Schlussrechnung (A2 unverändert)',
    $q$select public.reverse_workspace_invoice_payment('00000000-0000-0000-0000-00000000fe20', 'inv-s1-ab', 'pay-s1')$q$,
    'invoice_payment_reverse_final_invoice_exists');
  if pg_temp.gezahlt('s1') is distinct from 466.48 then raise exception 'P1: gezahlt %, erwartet 466,48', pg_temp.gezahlt('s1'); end if;
  if (select payload->'previousAbschlagDeductions'->0->>'paidAmount' from public.workspace_invoices
      where workspace_id = ws and client_invoice_id = 'inv-s1-schluss')::numeric is distinct from 466.48 then
    raise exception 'P1: eingefrorener Abzug verändert';
  end if;
  raise notice 'OK  P1g gezahlt 466,48 = eingefrorener Abzug; kein Widerspruch';
  -- Bankweg (WEISS S1 Bank).
  perform pg_temp.bank('btx-s1', 952, '2026-06-10');
  perform pg_temp.erwarte_fehler('P1h Bankabgleich 9,52 hinter Schlussrechnung',
    $q$select public.confirm_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fe20', 'btx-s1', 'invoice', 'inv-s1-ab', 'pay-s1-bank', 'rec-s1')$q$,
    'Kein offener Betrag');
  if pg_temp.gezahlt('s1') is distinct from 466.48
     or exists (select 1 from public.workspace_bank_reconciliations where workspace_id = ws and bank_transaction_id = 'btx-s1') then
    raise exception 'P1: abgewiesener Bankabgleich hat Zahlung oder Zuordnung hinterlassen';
  end if;
  raise notice 'OK  P1i keine Zahlung, keine Zuordnung';
  -- Klaerung an einem abgezogenen Abschlag ist ebenfalls gesperrt.
  perform pg_temp.erwarte_fehler('P1j Klärung eines abgezogenen Abschlags',
    $q$select pg_temp.klaere('s1', 'kl-s1', '{"art":"inland","region":"NI"}'::jsonb)$q$, 'invoice_frist_final_invoice_exists');
  -- Unabhaengig vom offenen Betrag: Selbst wenn ein Altzustand (hier nachgestellt durch eine direkt als
  -- zurueckgenommen markierte Zahlung) den Abschlag wieder voll offen erscheinen laesst, nimmt er hinter der
  -- eingefrorenen Aufteilung keine neue Zahlung an -- auch nicht innerhalb des offenen Betrags.
  perform pg_temp.abschlag('s1k', '2026-04-21', 'cust-nw', '33602', null, null, 466.48, '2026-05-04');
  r := pg_temp.schluss('s1k', 466.48, 9.52);
  update public.workspace_invoice_payments set reversed_at = now()
  where workspace_id = ws and client_invoice_id = 'inv-s1k-ab';
  perform pg_temp.erwarte_fehler('P1k eingefrorene Aufteilung: neue Zahlung auch innerhalb des offenen Betrags abgewiesen',
    $q$select pg_temp.zahlung('s1k', 'pay-s1k-neu', 100, '2026-06-10')$q$, 'invoice_payment_final_invoice_exists: Abschlag in Schlussrechnung abgezogen');
  -- Ein Abschlag ohne eingefrorene Aufteilung ist hier nicht nachgestellt: fc01a_p1_nacharbeit.sql Z2c.

  /* ------------------------------------------------------------------ P2 -- INV-01 Altbeleg ohne customerId */
  update public.workspace_customers set payload = payload || '{"holidayLocation":{"region":"NI"}}'::jsonb
  where workspace_id = ws and customer_id = 'cust-grenz';
  perform pg_temp.abschlag('ohne-id', '2026-05-25', null, '48431', null, null, 466.48, '2026-06-05');
  if pg_temp.basis('ohne-id')->'lage'->'laender' is distinct from '["NI", "NW"]'::jsonb then
    raise exception 'P2: Lage %', pg_temp.basis('ohne-id');
  end if;
  perform pg_temp.erwarte_fehler('P2a ungeklärt', $q$select pg_temp.offen('ohne-id')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.erwarte_fehler('P2b Nachzahlung 9,52 ungeklärt',
    $q$select pg_temp.zahlung('ohne-id', 'pay-ohne-id-2', 9.52, '2026-06-10')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.bank('btx-ohne-id', 952, '2026-06-10');
  perform pg_temp.erwarte_fehler('P2c Bankabgleich ungeklärt',
    $q$select public.confirm_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fe20', 'btx-ohne-id', 'invoice', 'inv-ohne-id-ab', 'pay-ohne-id-b', 'rec-ohne-id')$q$,
    'invoice_skonto_deadline_unclear');
  perform pg_temp.erwarte_fehler('P2d Schlussrechnung ungeklärt',
    $q$select pg_temp.schluss('ohne-id', 466.48, 9.52)$q$, 'invoice_skonto_deadline_unclear');
  -- Gewoehnliche Teil- und Vollzahlungen ohne strittigen Skontoeffekt bleiben moeglich (WEISS B17).
  perform pg_temp.abschlag('teil', '2026-05-25', null, '48431', null, null, 200, '2026-06-05');
  perform pg_temp.zahlung('teil', 'pay-teil-2', 100, '2026-06-08');
  perform pg_temp.erwarte_offen('P2e gewöhnliche Teilzahlungen bei Grenzort', 'teil', 17600);
  perform pg_temp.abschlag('voll', '2026-05-25', null, '48431', null, null, 476, '2026-06-05');
  perform pg_temp.erwarte_offen('P2f gewöhnliche Vollzahlung bei Grenzort', 'voll', 0);
  -- Klaerung an der Rechnung: Sitz war Nordrhein-Westfalen.
  v_payload_vorher := (select payload from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-ohne-id-ab');
  v_version_vorher := (select row_version from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-ohne-id-ab');
  perform pg_temp.klaere('ohne-id', 'kl-ohne-id', '{"art":"inland","region":"NW"}'::jsonb, 'Sitz laut Rechnungsanschrift Rheine (NW) bestätigt');
  perform pg_temp.erwarte_offen('P2g nach Klärung NW ausgeglichen', 'ohne-id', 0);
  if (select payload from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-ohne-id-ab') is distinct from v_payload_vorher then
    raise exception 'P2: Beleg (payload) durch die Klärung verändert';
  end if;
  if (select row_version from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-ohne-id-ab') is distinct from v_version_vorher + 1 then
    raise exception 'P2: row_version nicht erhöht';
  end if;
  select count(*) into n from public.workspace_invoice_frist_klaerungen k
  where k.workspace_id = ws and k.client_invoice_id = 'inv-ohne-id-ab'
    and k.lage_vorher->'laender' = '["NI", "NW"]'::jsonb and k.lage_nachher->'laender' = '["NW"]'::jsonb
    and k.created_by = '00000000-0000-0000-0000-0000000fe201' and k.begruendung like 'Sitz laut%';
  if n is distinct from 1 then raise exception 'P2: Protokollzeile fehlt (%)', n; end if;
  if pg_temp.basis('ohne-id')->'klaerung'->>'id' is distinct from 'kl-ohne-id' or pg_temp.basis('ohne-id')->>'quelle' is distinct from 'klaerung' then
    raise exception 'P2: frist_basis ohne Klärungsangabe: %', pg_temp.basis('ohne-id');
  end if;
  raise notice 'OK  P2h Beleg unverändert, Version +1, Protokoll mit Person, Grund, Lage vorher/nachher';
  r := pg_temp.schluss('ohne-id', 466.48, 9.52);
  if r->'invoice'->>'type' is distinct from 'schluss' then raise exception 'P2: Schlussrechnung nicht angenommen: %', r; end if;
  raise notice 'OK  P2i Schlussrechnung nach Klärung angenommen';
  -- Eine Klaerung als NI waere verspaetet: an einer frischen Rechnung.
  perform pg_temp.abschlag('ohne-id-ni', '2026-05-25', null, '48431', null, null, 466.48, '2026-06-05');
  perform pg_temp.klaere('ohne-id-ni', 'kl-ohne-id-ni', '{"art":"inland","region":"NI"}'::jsonb);
  perform pg_temp.erwarte_offen('P2j Klärung NI: verspätet', 'ohne-id-ni', 952);

  /* ------------------------------------------------------------------ P3 -- INV-02 Ausland */
  perform pg_temp.abschlag('cn-feb', '2026-02-06', null, '200000', 'CN', null, 466.48, '2026-02-20');
  perform pg_temp.erwarte_fehler('P3a China, Zahlung nach vier gesetzlichen Feiertagen: ungeklärt statt verspätet',
    $q$select pg_temp.offen('cn-feb')$q$, 'Frist 2026-02-16 bis offen');
  perform pg_temp.abschlag('cn-spaet', '2026-02-06', null, '200000', 'CN', null, 466.48, '2026-03-31');
  perform pg_temp.erwarte_fehler('P3b auch sechs Wochen später keine Höchstdauer',
    $q$select pg_temp.offen('cn-spaet')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.abschlag('cn-okt', '2026-09-21', null, '200000', 'CN', null, 466.48, '2026-10-08');
  perform pg_temp.erwarte_fehler('P3c Zahlung 08.10. (WEISS: 952)', $q$select pg_temp.offen('cn-okt')$q$, 'invoice_skonto_deadline_unclear');
  perform pg_temp.erwarte_fehler('P3d Schlussrechnung ungeklärt', $q$select pg_temp.schluss('cn-feb', 466.48, 9.52)$q$,
    'invoice_skonto_deadline_unclear');
  perform pg_temp.klaere('cn-feb', 'kl-cn-feb', '{"art":"ausland","kalenderEnde":"2026-02-16","wirksamesEnde":"2026-02-24"}'::jsonb,
    'Frühlingsfest 15.–23.02.2026 laut amtlicher Planung (gov.cn)');
  perform pg_temp.erwarte_offen('P3e geprüftes Fristende Di 24.02.: rechtzeitig', 'cn-feb', 0);
  perform pg_temp.klaere('cn-spaet', 'kl-cn-spaet', '{"art":"ausland","kalenderEnde":"2026-02-16","wirksamesEnde":"2026-02-24"}'::jsonb,
    'Frühlingsfest 15.–23.02.2026 laut amtlicher Planung (gov.cn)');
  perform pg_temp.erwarte_offen('P3f geprüftes Fristende, Zahlung 31.03.: verspätet', 'cn-spaet', 952);
  if pg_temp.basis('cn-feb')->'lage'->>'art' is distinct from 'ausland'
     or pg_temp.basis('cn-feb')->'lage'->'geprueft' is distinct from '{"2026-02-16": "2026-02-24"}'::jsonb then
    raise exception 'P3: Lage nach Prüfung %', pg_temp.basis('cn-feb');
  end if;
  -- Zahlungsziel derselben Rechnung ist ein eigenes Fristende.
  perform pg_temp.abschlag('cn-ziel', '2026-02-06', null, '200000', 'CN', '{"paymentDueDate":"2026-02-20"}'::jsonb, null, null);
  perform pg_temp.klaere('cn-ziel', 'kl-cn-ziel-1', '{"art":"ausland","kalenderEnde":"2026-02-16","wirksamesEnde":"2026-02-24"}'::jsonb, 'Frühlingsfest geprüft');
  perform pg_temp.klaere('cn-ziel', 'kl-cn-ziel-2', '{"art":"ausland","kalenderEnde":"2026-02-20","wirksamesEnde":"2026-02-24"}'::jsonb, 'Frühlingsfest geprüft');
  if pg_temp.basis('cn-ziel')->'lage'->'geprueft' is distinct from '{"2026-02-16": "2026-02-24", "2026-02-20": "2026-02-24"}'::jsonb then
    raise exception 'P3: zwei geprüfte Fristenden nicht beide gehalten: %', pg_temp.basis('cn-ziel');
  end if;
  raise notice 'OK  P3g Skontofrist und Zahlungsziel je für sich geprüft';

  /* ------------------------------------------------------------------ P4 -- Klaerungsregeln */
  perform pg_temp.abschlag('k', '2026-05-25', null, '48431', null, null, 466.48, '2026-06-05');
  perform pg_temp.erwarte_fehler('P4a Begründung fehlt',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"inland","region":"NW"}'::jsonb, ' x ')$q$, 'invoice_frist_klaerung_invalid: begruendung');
  perform pg_temp.erwarte_fehler('P4b unbekanntes Land',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"inland","region":"XX"}'::jsonb)$q$, 'invoice_frist_klaerung_invalid: region');
  perform pg_temp.erwarte_fehler('P4c unbekannte Art',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"egal"}'::jsonb)$q$, 'invoice_frist_klaerung_invalid: art');
  perform pg_temp.erwarte_fehler('P4d Ausland: kein Fristende dieser Rechnung',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"ausland","kalenderEnde":"2026-06-05","wirksamesEnde":"2026-06-08"}'::jsonb)$q$,
    'invoice_frist_klaerung_invalid: kalenderEnde');
  perform pg_temp.erwarte_fehler('P4e Ausland: wirksames Ende vor dem Fristende',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"ausland","kalenderEnde":"2026-06-04","wirksamesEnde":"2026-06-03"}'::jsonb)$q$,
    'invoice_frist_klaerung_invalid: wirksamesEnde');
  perform pg_temp.erwarte_fehler('P4f Ausland: wirksames Ende an einem Samstag',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"ausland","kalenderEnde":"2026-06-04","wirksamesEnde":"2026-06-06"}'::jsonb)$q$,
    'invoice_frist_klaerung_invalid: wirksamesEnde');
  perform pg_temp.erwarte_fehler('P4g Ausland: Eingabegrenze 60 Tage',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"ausland","kalenderEnde":"2026-06-04","wirksamesEnde":"2026-08-04"}'::jsonb)$q$,
    'invoice_frist_klaerung_invalid: wirksamesEnde');
  -- Mitglied: keine Finanzentscheidung.
  perform pg_temp.als('00000000-0000-0000-0000-0000000fe202');
  perform pg_temp.erwarte_fehler('P4h Mitglied klärt nicht',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"inland","region":"NW"}'::jsonb)$q$, 'finance_forbidden_role');
  perform pg_temp.als('00000000-0000-0000-0000-0000000fe201');
  -- Gueltig, dann Wiederholung und Konflikt.
  perform pg_temp.klaere('k', 'kl-k1', '{"art":"inland","region":"NW","fronleichnam":true,"mariaeHimmelfahrt":true}'::jsonb);
  if pg_temp.basis('k')->'lage'->'gemeinde' is distinct from '{}'::jsonb then
    raise exception 'P4: Gemeindeangaben ausserhalb ihres Landes gespeichert: %', pg_temp.basis('k');
  end if;
  perform pg_temp.klaere('k', 'kl-k1', '{"art":"inland","region":"NW","fronleichnam":true,"mariaeHimmelfahrt":true}'::jsonb);
  select count(*) into n from public.workspace_invoice_frist_klaerungen where workspace_id = ws and client_klaerung_id = 'kl-k1';
  if n is distinct from 1 then raise exception 'P4: Wiederholung legte eine zweite Protokollzeile an'; end if;
  raise notice 'OK  P4i Wiederholung derselben Kennung: dieselbe Zeile, kein zweiter Eintrag';
  perform pg_temp.erwarte_fehler('P4j dieselbe Kennung mit anderem Inhalt',
    $q$select pg_temp.klaere('k', 'kl-k1', '{"art":"inland","region":"NI"}'::jsonb)$q$, 'invoice_frist_klaerung_conflict');
  -- Korrektur mit neuer Kennung ist protokolliert moeglich.
  perform pg_temp.klaere('k', 'kl-k2', '{"art":"inland","region":"NI"}'::jsonb, 'Korrektur: Sitz in Niedersachsen');
  perform pg_temp.erwarte_offen('P4k Korrektur NI protokolliert', 'k', 952);
  select count(*) into n from public.workspace_invoice_frist_klaerungen where workspace_id = ws and client_invoice_id = 'inv-k-ab';
  if n is distinct from 2 then raise exception 'P4: Protokoll hat % statt 2 Einträge', n; end if;
  -- Storno, Vereinbarung.
  perform pg_temp.abschlag('storno', '2026-05-25', null, '48431', null, null, null, null);
  perform public.cancel_workspace_invoice(ws, 'inv-storno-ab', 'Test');
  perform pg_temp.erwarte_fehler('P4l stornierte Rechnung',
    $q$select pg_temp.klaere('storno', 'kl-storno', '{"art":"inland","region":"NW"}'::jsonb)$q$, 'Rechnung storniert');
  perform pg_temp.abschlag('waiver', '2026-05-25', null, '48431', null, '{"deadlineShiftWaived": true}'::jsonb, null, null);
  perform pg_temp.erwarte_fehler('P4m abweichend vereinbart (kalendarisch)',
    $q$select pg_temp.klaere('waiver', 'kl-waiver', '{"art":"inland","region":"NW"}'::jsonb)$q$, 'invoice_frist_abbedungen');
  -- Bindung ist nur ueber die Klaerung aenderbar.
  perform pg_temp.erwarte_fehler('P4n frist_basis direkt geändert',
    $q$update public.workspace_invoices set frist_basis = '{"lage":{"art":"abbedungen"}}'::jsonb where workspace_id = '00000000-0000-0000-0000-00000000fe20' and client_invoice_id = 'inv-k-ab'$q$,
    'invoice_frist_basis_immutable');
  perform pg_temp.erwarte_fehler('P4o frist_basis auf null gesetzt',
    $q$update public.workspace_invoices set frist_basis = null where workspace_id = '00000000-0000-0000-0000-00000000fe20' and client_invoice_id = 'inv-k-ab'$q$,
    'invoice_frist_basis_immutable');
  update public.workspace_invoices set payload = payload || '{"sentNote":"x"}'::jsonb
  where workspace_id = ws and client_invoice_id = 'inv-k-ab';
  if pg_temp.basis('k')->'lage'->'laender' is distinct from '["NI"]'::jsonb then raise exception 'P4: andere Änderung verlor die Bindung'; end if;
  raise notice 'OK  P4p andere Zeilenänderungen lassen die Bindung stehen';

  /* ------------------------------------------------------------------ P5 -- Kunde, alter Client */
  -- Alter Client: Payload ohne holidayLocation ueber den normalen Sync-Weg.
  perform public.upsert_workspace_sync_entity(ws, 'customer',
    jsonb_build_object('customer_id', 'cust-alt', 'payload', '{"id":"cust-alt","name":"Altclient GmbH (geändert)"}'::jsonb),
    (select row_version from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt'));
  if (select payload->'holidayLocation' from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt')
     is distinct from '{"region":"SN","fronleichnam":false}'::jsonb
     or (select payload->>'name' from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt') is distinct from 'Altclient GmbH (geändert)' then
    raise exception 'P5: Weglassen hat die Angabe gelöscht oder die Änderung verloren';
  end if;
  raise notice 'OK  P5a alter Client lässt holidayLocation weg: Angabe bleibt, übrige Änderung gilt';
  perform public.upsert_workspace_sync_entity(ws, 'customer',
    jsonb_build_object('customer_id', 'cust-alt', 'payload', '{"id":"cust-alt","name":"Altclient GmbH (geändert)","holidayLocation":null}'::jsonb),
    (select row_version from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt'));
  if (select payload ? 'holidayLocation' from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt') then
    raise exception 'P5: ausdrückliches null hat die Angabe nicht entfernt';
  end if;
  raise notice 'OK  P5b ausdrückliches null entfernt die Angabe (neuer Client)';
  perform public.upsert_workspace_sync_entity(ws, 'customer',
    jsonb_build_object('customer_id', 'cust-alt', 'payload', '{"id":"cust-alt","name":"Altclient GmbH (geändert)","holidayLocation":"NW"}'::jsonb),
    (select row_version from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt'));
  if (select payload ? 'holidayLocation' from public.workspace_customers where workspace_id = ws and customer_id = 'cust-alt') then
    raise exception 'P5: ungültige Angabe gespeichert';
  end if;
  raise notice 'OK  P5c keine ungültige Angabe gespeichert';

  /* ------------------------------------------------------------------ P6 -- INV-05 Zusatzgeld nach Skonto */
  perform pg_temp.abschlag('extra', '2026-04-21', 'cust-nw', '33602', null, null, 466.48, '2026-05-04');
  perform pg_temp.erwarte_offen('P6a mit Skonto ausgeglichen', 'extra', 0);
  perform pg_temp.erwarte_fehler('P6b weitere 9,52 ohne Bestätigung',
    $q$select pg_temp.zahlung('extra', 'pay-extra-2', 9.52, '2026-05-10')$q$, 'invoice_payment_overpayment_unconfirmed');
  perform pg_temp.zahlung('extra', 'pay-extra-2', 9.52, '2026-05-10', true);
  if pg_temp.gezahlt('extra') is distinct from 476 then raise exception 'P6: bestätigte Zahlung fehlt'; end if;
  perform pg_temp.erwarte_fehler('P6c Schlussrechnung mit Skonto 9,52 trotz voller Zahlung',
    $q$select pg_temp.schluss('extra', 466.48, 9.52)$q$, 'invoice_abschlag_settlement_mismatch');
  r := pg_temp.schluss('extra', 476, 0);
  if r->'invoice'->>'type' is distinct from 'schluss' then raise exception 'P6: Schlussrechnung 476/0 nicht angenommen: %', r; end if;
  raise notice 'OK  P6d Vertrag: gezahlt = min(Betrag, Zahlungen) = 476, Skonto = 0 (keine doppelte Entgeltminderung)';

  /* ------------------------------------------------------------------ P7 -- Bindung und Rechte */
  perform pg_temp.abschlag('kunde', '2026-05-25', 'cust-grenz', '48431', null, null, null, null);
  if pg_temp.basis('kunde')->'lage' is distinct from '{"art":"inland","laender":["NI"],"gemeinde":{},"quelle":"kunde"}'::jsonb then
    raise exception 'P7: Angabe am Kunden nicht gebunden: %', pg_temp.basis('kunde');
  end if;
  raise notice 'OK  P7a Freigabe bindet die Angabe am Kunden (quelle kunde)';
  if has_function_privilege('authenticated', 'public.workspace_invoice_abschlag_abzug(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.workspace_invoice_abschlag_abzug(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_invoices_frist_basis()', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_customers_holiday_location()', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_fristfenster(date, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_invoice_open_cents(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.clarify_workspace_invoice_frist(uuid, text, text, jsonb, text)', 'execute')
     or has_function_privilege('anon', 'public.pull_workspace_invoices(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.pull_workspace_invoices(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.clarify_workspace_invoice_frist(uuid, text, text, jsonb, text)', 'execute')
     or has_table_privilege('authenticated', 'public.workspace_invoice_frist_klaerungen', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_invoice_frist_klaerungen', 'update')
     or has_table_privilege('authenticated', 'public.workspace_invoice_frist_klaerungen', 'delete')
     or has_table_privilege('anon', 'public.workspace_invoice_frist_klaerungen', 'select')
     or not has_table_privilege('authenticated', 'public.workspace_invoice_frist_klaerungen', 'select')
     /* Lokal haben Tabellen Rechte-Drift (Standardrechte); massgeblich ist RLS ohne Schreib-Policy. */
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('workspace_invoices', 'workspace_invoice_frist_klaerungen')
                  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) then
    raise exception 'P7: Rechte der neuen Funktionen oder Tabellen falsch';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.workspace_invoice_frist_klaerungen'::regclass) then
    raise exception 'P7: RLS auf dem Klärungsprotokoll fehlt';
  end if;
  raise notice 'OK  P7b Rechte: Hilfsfunktionen nur Eigentümer, Klärung nur angemeldet, Protokoll nur lesbar (RLS)';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
