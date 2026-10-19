-- FC01A-P1-NACHARBEIT -- die zwei P1-Befunde der unabhaengigen Endabnahme (WEISS, 14.10.2026).
--
--   P8  #8      Nummer, Datum, Netto und Abschlagsnummer jeder Abzugszeile einer
--               Schlussrechnung sind die des gespeicherten Abschlags desselben Betriebs.
--   Z   ZAH-04  Bankabgleich und Zahlungsannahme rechnen den offenen Betrag mit Skonto;
--               ein durch Zahlung und Skonto ausgeglichener Abschlag nimmt keine weitere
--               Zahlung an (hinter einer Schlussrechnung auch nicht bestaetigt).
--
-- Setzt die Migrationen 20261114120000_fc01a_nacharbeit.sql und
-- 20261115120000_fc01a_p1_nacharbeit.sql voraus. Ausfuehren (nur lokal, niemals --linked
-- oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_p1_nacharbeit.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles
-- wird zurueckgerollt. Wettlaeufe zwischen zwei Sitzungen: fc01a_p1_parallel.mjs.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fcb01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-p1-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-p1-%@example.invalid';

-- Zwei Betriebe desselben Inhabers: fcb2 traegt einen Abschlag mit derselben Kennung.
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fcb1', 'FC01A-P1', '00000000-0000-0000-0000-0000000fcb01'),
       ('00000000-0000-0000-0000-00000000fcb2', 'FC01A-P1 fremd', '00000000-0000-0000-0000-0000000fcb01');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000fcb1', '00000000-0000-0000-0000-0000000fcb01', 'owner', 'active'),
       ('00000000-0000-0000-0000-00000000fcb2', '00000000-0000-0000-0000-0000000fcb01', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000fcb1', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb),
       ('00000000-0000-0000-0000-00000000fcb2', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fcb01');

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

-- Wie in fc01a_nacharbeit.sql: Kleinunternehmer (Betrag = Netto), Anschrift und Pflichthinweis.
-- Bewusst OHNE Ergaenzung der Abzuege: Hier wird gerade geprueft, was ein Client schickt.
create function pg_temp.beleg(
  p_type text,
  p_menge numeric,
  p_subtotal numeric,
  p_amount numeric,
  p_extra jsonb default '{}'::jsonb
) returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'type', p_type,
    'taxStatus', 'kleinunternehmer_19',
    'legalNotices', jsonb_build_array('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'),
    'issueDate', '2026-10-04',
    'customerSnapshot', jsonb_build_object('name', 'Muster GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld'),
    'positions', case when p_menge > 0 then jsonb_build_array(jsonb_build_object(
      'id', 'line-' || p_type || '-' || p_menge::text,
      'orderPositionId', 'cp1',
      'description', 'Montagestunden',
      'quantity', p_menge,
      'unit', 'Stück',
      'unitPrice', 100,
      'lineTotal', p_menge * 100
    )) else '[]'::jsonb end,
    'subtotal', p_subtotal,
    'amount', p_amount
  ) || p_extra;
$p$;

create function pg_temp.auftrag(p_tax text default 'kleinunternehmer_19') returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'customerId', 'cust-1',
    'customerBilling', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb,
    'title', 'FC01A-P1', 'baustelle', '', 'taxStatus', p_tax,
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb);
$p$;

create function pg_temp.mit19(p_extra jsonb default '{}'::jsonb) returns jsonb language sql immutable as $p$
  select '{"taxStatus":"standard_19","legalNotices":[]}'::jsonb || p_extra;
$p$;

-- Ein Abzug, wie ihn der Client baut (getPreviousAbschlagDeductions): aus dem gespeicherten Abschlag.
create function pg_temp.abzug(p_ws uuid, p_inv text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql stable as $p$
  select jsonb_strip_nulls(jsonb_build_object(
    'invoiceId', a.client_invoice_id,
    'invoiceNumber', a.invoice_number,
    'abschlagNumber', a.payload->'abschlagNumber',
    'date', coalesce(a.payload->>'issueDate', a.payload->>'date'),
    'subtotal', a.payload->'subtotal',
    'amount', a.payload->'amount'
  )) || p_extra
  from public.workspace_invoices a
  where a.workspace_id = p_ws and a.client_invoice_id = p_inv;
$p$;

-- Eine Schlussrechnung im Betrieb fcb1 mit genau diesen Abzuegen.
create function pg_temp.schluss(
  p_vorgang text, p_inv text, p_subtotal numeric, p_amount numeric, p_abzuege jsonb, p_extra jsonb default '{}'::jsonb
) returns jsonb language sql as $p$
  select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fcb1', p_vorgang, p_inv,
    pg_temp.beleg('schluss', p_subtotal / 100, p_subtotal, p_amount,
      p_extra || jsonb_build_object('previousAbschlagDeductions', p_abzuege)));
$p$;

-- Eine Bankbewegung (Cent, Buchungstag) im Betrieb fcb1.
create function pg_temp.bank(p_id text, p_cents bigint, p_date date) returns void language sql as $p$
  insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name,
    imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)
  values ('00000000-0000-0000-0000-00000000fcb1', p_id, 'p1-bacc', 'p1-import', 'P1.csv',
    now(), p_date, p_cents, 'fp-' || p_id, 1, '{}'::jsonb, auth.uid(), auth.uid());
$p$;

create function pg_temp.zuordnen(p_btx text, p_inv text, p_pay text) returns jsonb language sql as $p$
  select public.confirm_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fcb1',
    p_btx, 'invoice', p_inv, p_pay, 'rec-' || p_pay);
$p$;

create function pg_temp.offen(p_inv text) returns numeric language sql stable as $p$
  select public.workspace_invoice_open_cents('00000000-0000-0000-0000-00000000fcb1', p_inv);
$p$;

create function pg_temp.gezahlt(p_inv text) returns numeric language sql stable as $p$
  select coalesce(sum(amount), 0) from public.workspace_invoice_payments
  where workspace_id = '00000000-0000-0000-0000-00000000fcb1' and client_invoice_id = p_inv and reversed_at is null;
$p$;

insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
values ('00000000-0000-0000-0000-00000000fcb1', 'p1-bacc', 'P1 synthetisch', 'DE00P1', '{}'::jsonb,
        '00000000-0000-0000-0000-0000000fcb01', '00000000-0000-0000-0000-0000000fcb01');

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fcb1';
  fremd constant uuid := '00000000-0000-0000-0000-00000000fcb2';
  skonto2 constant text := 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';
  r jsonb;
  d jsonb;
  v_netto numeric;
  v_steuer numeric;
begin
  /* ====================================================================== */
  /* P8 — #8: Angaben jeder Abzugszeile = die des Abschlags                   */
  /* ====================================================================== */
  perform public.create_workspace_order(ws, 'v-p8', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-p8', 'inv-p8-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-p8-ab', 'pay-p8-ab', 500, '2026-09-05', null, null, 'bank');

  -- Derselbe Abschlag (gleiche Kennung) in einem anderen Betrieb, mit anderem Netto und Datum.
  perform public.create_workspace_order(fremd, 'v-p8', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(fremd, 'v-p8', 'inv-p8-ab',
    pg_temp.beleg('abschlag', 0, 700, 700, '{"calculationMode":"fixed_amount","fixedAmountNet":700,"abschlagNumber":1,"issueDate":"2026-08-15"}'::jsonb));

  -- P8a: WEISS-Nachstellung wortgleich (Netto 1, fremde Nummer, Datum 1900).
  perform pg_temp.erwarte_fehler('P8a WEISS #8: Netto 1, Nummer WEISS-FALSCH, Datum 1900-01-01',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500,
       '[{"invoiceId":"inv-p8-ab","amount":500,"subtotal":1,"invoiceNumber":"WEISS-FALSCH","date":"1900-01-01","paidAmount":500,"skontoAmount":0}]'::jsonb)$q$,
    'invoice_deductions_mismatch: angaben');
  -- P8b–P8d: je eine falsche Angabe, alles andere wie vom Client.
  perform pg_temp.erwarte_fehler('P8b nur Netto falsch (1 statt 500)',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab', '{"subtotal":1}')))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8c nur Rechnungsnummer falsch',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab', '{"invoiceNumber":"WEISS-FALSCH"}')))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8d nur Rechnungsdatum falsch (Datum der Schlussrechnung)',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab', '{"date":"2026-10-04"}')))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8e Abschlagsnummer falsch',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab', '{"abschlagNumber":2}')))$q$,
    'invoice_deductions_mismatch: angaben');
  -- P8f–P8i: fehlende Angaben (der Abschlag traegt sie) und falscher Typ.
  perform pg_temp.erwarte_fehler('P8f Netto fehlt',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab') - 'subtotal'))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8g Rechnungsnummer fehlt',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab') - 'invoiceNumber'))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8h Datum fehlt',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab') - 'date'))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8i Abschlagsnummer fehlt',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab') - 'abschlagNumber'))$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8j Netto als Text',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8-ab', '{"subtotal":"500"}')))$q$,
    'invoice_deductions_mismatch: angaben');
  -- P8k: mandantengebunden -- die Angaben des gleichnamigen Abschlags eines anderen Betriebs.
  perform pg_temp.erwarte_fehler('P8k Angaben des gleichnamigen Abschlags im fremden Betrieb',
    $q$select pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb2', 'inv-p8-ab', '{"amount":500}')))$q$,
    'invoice_deductions_mismatch: angaben');
  if exists (select 1 from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-p8-schluss') then
    raise exception 'P8l: abgewiesene Schlussrechnung hat eine Zeile hinterlassen';
  end if;
  raise notice 'OK  P8l: keine abgewiesene Schlussrechnung gespeichert';

  -- P8m: der Abzug, wie ihn der Client baut, geht durch und wird so gespeichert.
  r := pg_temp.schluss('v-p8', 'inv-p8-schluss', 10000, 9500, jsonb_build_array(pg_temp.abzug(ws, 'inv-p8-ab')));
  select a.payload->'previousAbschlagDeductions'->0 into d
  from public.workspace_invoices a where a.workspace_id = ws and a.client_invoice_id = 'inv-p8-schluss';
  if d is distinct from pg_temp.abzug(ws, 'inv-p8-ab') then
    raise exception 'P8m: gespeicherter Abzug weicht ab: %', d;
  end if;
  -- Buchungsbetraege wie monatsmappeModelService (Netto = Netto - Netto der Abzuege).
  select (s.payload->>'subtotal')::numeric - sum((x.value->>'subtotal')::numeric), max((s.payload->>'amount')::numeric)
  into v_netto, v_steuer
  from public.workspace_invoices s, jsonb_array_elements(s.payload->'previousAbschlagDeductions') x
  where s.workspace_id = ws and s.client_invoice_id = 'inv-p8-schluss'
  group by s.payload;
  v_steuer := v_steuer - v_netto;
  if v_netto <> 9500 or v_steuer <> 0 then
    raise exception 'P8m: Exportaufteilung % / %', v_netto, v_steuer;
  end if;
  raise notice 'OK  P8m: Client-Abzug gespeichert; Export netto 9500, Steuer 0 (WEISS: 9999 / -499)';

  -- P8n: 19 % -- Brutto als Netto oder fehlendes Netto ergaebe eine falsche Steueraufteilung.
  perform public.create_workspace_order(ws, 'v-p8s', pg_temp.auftrag('standard_19'));
  perform public.finalize_workspace_invoice(ws, 'v-p8s', 'inv-p8s-ab',
    pg_temp.beleg('abschlag', 0, 400, 476, pg_temp.mit19('{"calculationMode":"fixed_amount","fixedAmountNet":400,"abschlagNumber":1,"issueDate":"2026-09-01"}'::jsonb)));
  perform public.add_workspace_invoice_payment(ws, 'inv-p8s-ab', 'pay-p8s-ab', 476, '2026-09-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('P8n 19 %: Brutto 476 als Netto',
    $q$select pg_temp.schluss('v-p8s', 'inv-p8s-schluss', 10000, 11424, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8s-ab', '{"subtotal":476}')), pg_temp.mit19())$q$,
    'invoice_deductions_mismatch: angaben');
  perform pg_temp.erwarte_fehler('P8n 19 %: Netto fehlt',
    $q$select pg_temp.schluss('v-p8s', 'inv-p8s-schluss', 10000, 11424, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8s-ab') - 'subtotal'), pg_temp.mit19())$q$,
    'invoice_deductions_mismatch: angaben');
  r := pg_temp.schluss('v-p8s', 'inv-p8s-schluss', 10000, 11424, jsonb_build_array(pg_temp.abzug(ws, 'inv-p8s-ab')), pg_temp.mit19());
  select (s.payload->>'subtotal')::numeric - sum((x.value->>'subtotal')::numeric), max((s.payload->>'amount')::numeric)
  into v_netto, v_steuer
  from public.workspace_invoices s, jsonb_array_elements(s.payload->'previousAbschlagDeductions') x
  where s.workspace_id = ws and s.client_invoice_id = 'inv-p8s-schluss'
  group by s.payload;
  v_steuer := v_steuer - v_netto;
  if v_netto <> 9600 or v_steuer <> 1824 then
    raise exception 'P8n: Exportaufteilung 19 %% % / %', v_netto, v_steuer;
  end if;
  raise notice 'OK  P8n: 19 %% -- Export netto 9600, Steuer 1824 (= 19 %% von 9600)';

  -- P8o: Altbestand, Abschlag nur mit 'date' (ohne issueDate).
  perform public.create_workspace_order(ws, 'v-p8alt', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-p8alt', 'inv-p8alt-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-p8alt-ab', 'pay-p8alt-ab', 500, '2026-09-05', null, null, 'bank');
  update public.workspace_invoices set payload = (payload - 'issueDate') || '{"date":"2026-09-01"}'::jsonb
  where workspace_id = ws and client_invoice_id = 'inv-p8alt-ab';
  perform pg_temp.erwarte_fehler('P8o Altbestand nur date: anderes Datum',
    $q$select pg_temp.schluss('v-p8alt', 'inv-p8alt-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8alt-ab', '{"date":"2026-09-02"}')))$q$,
    'invoice_deductions_mismatch: angaben');
  r := pg_temp.schluss('v-p8alt', 'inv-p8alt-schluss', 10000, 9500, jsonb_build_array(
    pg_temp.abzug(ws, 'inv-p8alt-ab', '{"date":"2026-09-01"}')));
  raise notice 'OK  P8o: Altbestand nur mit date -- dieses Datum gilt';

  -- P8p: Altbestand mit abweichendem issueDate und date: beide Felder des Abschlags gelten.
  perform public.create_workspace_order(ws, 'v-p8alt2', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-p8alt2', 'inv-p8alt2-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-02"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-p8alt2-ab', 'pay-p8alt2-ab', 500, '2026-09-05', null, null, 'bank');
  update public.workspace_invoices set payload = payload || '{"date":"2026-09-01"}'::jsonb
  where workspace_id = ws and client_invoice_id = 'inv-p8alt2-ab';
  r := pg_temp.schluss('v-p8alt2', 'inv-p8alt2-schluss', 10000, 9500, jsonb_build_array(
    pg_temp.abzug(ws, 'inv-p8alt2-ab', '{"date":"2026-09-01"}')));
  raise notice 'OK  P8p: Altbestand mit altem date-Feld des Abschlags';

  -- P8q: Altbestand ohne Netto am Abschlag: ohne Netto im Abzug zulaessig, mit Netto nicht.
  perform public.create_workspace_order(ws, 'v-p8ohne', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-p8ohne', 'inv-p8ohne-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-p8ohne-ab', 'pay-p8ohne-ab', 500, '2026-09-05', null, null, 'bank');
  update public.workspace_invoices set payload = payload - 'subtotal'
  where workspace_id = ws and client_invoice_id = 'inv-p8ohne-ab';
  perform pg_temp.erwarte_fehler('P8q Altbestand ohne Netto: Abzug mit erfundenem Netto',
    $q$select pg_temp.schluss('v-p8ohne', 'inv-p8ohne-schluss', 10000, 9500, jsonb_build_array(
       pg_temp.abzug('00000000-0000-0000-0000-00000000fcb1', 'inv-p8ohne-ab', '{"subtotal":500}')))$q$,
    'invoice_deductions_mismatch: angaben');
  r := pg_temp.schluss('v-p8ohne', 'inv-p8ohne-schluss', 10000, 9500, jsonb_build_array(pg_temp.abzug(ws, 'inv-p8ohne-ab')));
  if (r->'invoice'->'previousAbschlagDeductions'->0) ? 'subtotal' then
    raise exception 'P8q: Abzug ohne Netto traegt Netto';
  end if;
  raise notice 'OK  P8q: Altbestand ohne Netto kompatibel';

  /* ====================================================================== */
  /* Z — ZAH-04: offener Betrag mit Skonto in Bankabgleich und Zahlung       */
  /* ====================================================================== */
  -- Z1: WEISS-Nachstellung -- Abschlag 500, rechtzeitig 490, Skonto 10, Schlussrechnung friert 490 + 10 ein.
  perform public.create_workspace_order(ws, 'v-z1', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z1', 'inv-z1-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, jsonb_build_object('calculationMode', 'fixed_amount', 'fixedAmountNet', 500,
      'abschlagNumber', 1, 'issueDate', '2026-09-01', 'skontoText', skonto2)));
  perform public.add_workspace_invoice_payment(ws, 'inv-z1-ab', 'pay-z1-ab', 490, '2026-09-08', null, null, 'bank');
  r := pg_temp.schluss('v-z1', 'inv-z1-schluss', 10000, 9500, jsonb_build_array(
    pg_temp.abzug(ws, 'inv-z1-ab', '{"paidAmount":490,"skontoAmount":10}')));
  perform pg_temp.bank('btx-z1', 1000, '2026-09-09');
  if pg_temp.offen('inv-z1-ab') <> 0 then
    raise exception 'Z1: offener Betrag eines mit Skonto ausgeglichenen Abschlags: %', pg_temp.offen('inv-z1-ab');
  end if;
  perform pg_temp.erwarte_fehler('Z1 WEISS ZAH-04: Bankabgleich +10 auf ausgeglichenen Abschlag',
    $q$select pg_temp.zuordnen('btx-z1', 'inv-z1-ab', 'pay-z1-extra')$q$,
    'Kein offener Betrag');
  if pg_temp.gezahlt('inv-z1-ab') <> 490
     or exists (select 1 from public.workspace_bank_reconciliations where workspace_id = ws and bank_transaction_id = 'btx-z1') then
    raise exception 'Z1: abgewiesener Bankabgleich hat Zahlung oder Zuordnung hinterlassen';
  end if;
  raise notice 'OK  Z1: keine Zahlung, keine Zuordnung; gezahlt bleibt 490';

  -- Z2: dieselbe Zahlung von Hand (neuer und alter Client) -- auch bestaetigt nicht hinter der Schlussrechnung.
  perform pg_temp.erwarte_fehler('Z2a Zahlung 10 ohne Bestaetigung (alter Client, 8 Argumente)',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcb1', 'inv-z1-ab', 'pay-z1-hand', 10, '2026-09-09', null, null, 'bank')$q$,
    'invoice_payment_final_invoice_exists');
  perform pg_temp.erwarte_fehler('Z2b Zahlung 10 bestaetigt hinter wirksamer Schlussrechnung',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcb1', 'inv-z1-ab', 'pay-z1-hand', 10, '2026-09-09', null, null, 'bank', true)$q$,
    'invoice_payment_final_invoice_exists');
  if pg_temp.gezahlt('inv-z1-ab') <> 490 then
    raise exception 'Z2: abgewiesene Zahlung gebucht';
  end if;
  -- Die Zahlung gehoert auf die Schlussrechnung: dort geht sie wie bisher.
  perform public.add_workspace_invoice_payment(ws, 'inv-z1-schluss', 'pay-z1-schluss', 10, '2026-10-05', null, null, 'bank');
  raise notice 'OK  Z2: Abschlag nimmt nichts mehr an; Zahlung auf die Schlussrechnung wie bisher';

  -- Z2c: Altbestand -- eine Schlussrechnung von vor N02 zog einen noch offenen Abschlag ab (hier
  -- nachgestellt: Zahlung danach direkt als zurueckgenommen markiert). Der Rest ist zahlbar, mehr nicht.
  perform public.create_workspace_order(ws, 'v-z2l', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z2l', 'inv-z2l-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-z2l-ab', 'pay-z2l-ab', 500, '2026-09-05', null, null, 'bank');
  r := pg_temp.schluss('v-z2l', 'inv-z2l-schluss', 10000, 9500, jsonb_build_array(pg_temp.abzug(ws, 'inv-z2l-ab')));
  update public.workspace_invoice_payments set reversed_at = now()
  where workspace_id = ws and client_invoice_id = 'inv-z2l-ab' and client_payment_id = 'pay-z2l-ab';
  perform public.add_workspace_invoice_payment(ws, 'inv-z2l-ab', 'pay-z2l-1', 300, '2026-09-10', null, null, 'bank');
  perform pg_temp.erwarte_fehler('Z2c Altbestand: 201 bei offen 200, bestaetigt',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcb1', 'inv-z2l-ab', 'pay-z2l-2', 201, '2026-09-11', null, null, 'bank', true)$q$,
    'invoice_payment_final_invoice_exists');
  perform public.add_workspace_invoice_payment(ws, 'inv-z2l-ab', 'pay-z2l-3', 200, '2026-09-11', null, null, 'bank');
  if pg_temp.gezahlt('inv-z2l-ab') <> 500 or pg_temp.offen('inv-z2l-ab') <> 0 then
    raise exception 'Z2c: Altbestand nicht bis zum Betrag zahlbar';
  end if;
  raise notice 'OK  Z2c: Altbestand hinter alter Schlussrechnung -- Rest zahlbar, Ueberzahlung nicht';

  -- Z3: ohne Schlussrechnung -- Bankabgleich abgewiesen, bewusste (bestaetigte) Ueberzahlung von Hand wie bisher.
  perform public.create_workspace_order(ws, 'v-z3', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z3', 'inv-z3-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, jsonb_build_object('calculationMode', 'fixed_amount', 'fixedAmountNet', 500,
      'abschlagNumber', 1, 'issueDate', '2026-09-01', 'skontoText', skonto2)));
  perform public.add_workspace_invoice_payment(ws, 'inv-z3-ab', 'pay-z3-ab', 490, '2026-09-08', null, null, 'bank');
  perform pg_temp.bank('btx-z3', 1000, '2026-09-09');
  perform pg_temp.erwarte_fehler('Z3a Bankabgleich +10, mit Skonto ausgeglichen, ohne Schlussrechnung',
    $q$select pg_temp.zuordnen('btx-z3', 'inv-z3-ab', 'pay-z3-extra')$q$,
    'Kein offener Betrag');
  perform pg_temp.erwarte_fehler('Z3b Zahlung 10 ohne Bestaetigung',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcb1', 'inv-z3-ab', 'pay-z3-hand', 10, '2026-09-09', null, null, 'bank')$q$,
    'invoice_payment_overpayment_unconfirmed');
  perform public.add_workspace_invoice_payment(ws, 'inv-z3-ab', 'pay-z3-hand', 10, '2026-09-09', null, null, 'bank', true);
  if pg_temp.gezahlt('inv-z3-ab') <> 500 then
    raise exception 'Z3c: bestaetigte Zahlung nicht gebucht';
  end if;
  raise notice 'OK  Z3c: bestaetigte Ueberzahlung ohne Schlussrechnung wie bisher';

  -- Z3d: dieselbe Regel fuer eine Teilrechnung (jede Rechnungsart, wie im Client).
  perform public.create_workspace_order(ws, 'v-z3t', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z3t', 'inv-z3-teil',
    pg_temp.beleg('teilrechnung', 2, 200, 200, jsonb_build_object('issueDate', '2026-09-01', 'skontoText', skonto2)));
  perform public.add_workspace_invoice_payment(ws, 'inv-z3-teil', 'pay-z3-teil', 196, '2026-09-08', null, null, 'bank');
  perform pg_temp.bank('btx-z3t', 400, '2026-09-09');
  perform pg_temp.erwarte_fehler('Z3d Teilrechnung mit Skonto ausgeglichen: Bankabgleich +4',
    $q$select pg_temp.zuordnen('btx-z3t', 'inv-z3-teil', 'pay-z3t-extra')$q$,
    'Kein offener Betrag');

  -- Z4: Teilzahlung -- der Rest bis zum Skontobetrag geht, mehr nicht, danach nichts mehr.
  perform public.create_workspace_order(ws, 'v-z4', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z4', 'inv-z4-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, jsonb_build_object('calculationMode', 'fixed_amount', 'fixedAmountNet', 500,
      'abschlagNumber', 1, 'issueDate', '2026-09-01', 'skontoText', skonto2)));
  perform public.add_workspace_invoice_payment(ws, 'inv-z4-ab', 'pay-z4', 400, '2026-09-05', null, null, 'bank');
  if pg_temp.offen('inv-z4-ab') <> 10000 then
    raise exception 'Z4: offen nach Teilzahlung %', pg_temp.offen('inv-z4-ab');
  end if;
  perform pg_temp.bank('btx-z4a', 10100, '2026-09-06');
  perform pg_temp.erwarte_fehler('Z4a Bankbetrag 101 > offen 100',
    $q$select pg_temp.zuordnen('btx-z4a', 'inv-z4-ab', 'pay-z4a')$q$,
    'Bankbetrag hoeher als offener Betrag');
  perform pg_temp.bank('btx-z4b', 9000, '2026-09-07');
  r := pg_temp.zuordnen('btx-z4b', 'inv-z4-ab', 'pay-z4b');
  if (r->>'replayed')::boolean or pg_temp.gezahlt('inv-z4-ab') <> 490 or pg_temp.offen('inv-z4-ab') <> 0 then
    raise exception 'Z4b: Skontorest 90 nicht korrekt gebucht: %', r;
  end if;
  perform pg_temp.bank('btx-z4c', 1000, '2026-09-08');
  perform pg_temp.erwarte_fehler('Z4c danach +10 (Skonto ausgeglichen)',
    $q$select pg_temp.zuordnen('btx-z4c', 'inv-z4-ab', 'pay-z4c')$q$,
    'Kein offener Betrag');
  raise notice 'OK  Z4: Teilzahlung 400, Rest 90 per Bank, danach nichts mehr offen';

  -- Z5: Wiederholungen -- dieselbe Zuordnung und dieselbe Zahlung noch einmal: idempotent, auch nach dem Ausgleich.
  r := pg_temp.zuordnen('btx-z4b', 'inv-z4-ab', 'pay-z4b');
  if not (r->>'replayed')::boolean then
    raise exception 'Z5a: Wiederholung des Bankabgleichs nicht als Wiederholung erkannt: %', r;
  end if;
  perform public.add_workspace_invoice_payment(ws, 'inv-z4-ab', 'pay-z4', 400, '2026-09-05', null, null, 'bank');
  if pg_temp.gezahlt('inv-z4-ab') <> 490
     or (select count(*) from public.workspace_invoice_payments where workspace_id = ws and client_invoice_id = 'inv-z4-ab') <> 2 then
    raise exception 'Z5b: Wiederholung hat eine weitere Zahlung erzeugt';
  end if;
  raise notice 'OK  Z5: Wiederholungen idempotent, keine weitere Zahlung';

  -- Z6: verspaetetes Skonto -- kein Ausgleich, der Rest bleibt offen und ist per Bank buchbar.
  perform public.create_workspace_order(ws, 'v-z6', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z6', 'inv-z6-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, jsonb_build_object('calculationMode', 'fixed_amount', 'fixedAmountNet', 500,
      'abschlagNumber', 1, 'issueDate', '2026-09-01', 'skontoText', skonto2)));
  perform public.add_workspace_invoice_payment(ws, 'inv-z6-ab', 'pay-z6', 490, '2026-09-20', null, null, 'bank');
  if pg_temp.offen('inv-z6-ab') <> 1000 then
    raise exception 'Z6: verspaetetes Skonto als Ausgleich gewertet: %', pg_temp.offen('inv-z6-ab');
  end if;
  perform pg_temp.bank('btx-z6', 1000, '2026-09-21');
  r := pg_temp.zuordnen('btx-z6', 'inv-z6-ab', 'pay-z6-bank');
  if pg_temp.gezahlt('inv-z6-ab') <> 500 then
    raise exception 'Z6: Rest nach verspaetetem Skonto nicht buchbar';
  end if;
  raise notice 'OK  Z6: verspaetetes Skonto -- Rest 10 per Bank gebucht';

  -- Z7: Ruecknahme -- die Bankzahlung zurueckgenommen, der Rest ist wieder offen und neu zuordenbar.
  perform public.reverse_workspace_invoice_payment(ws, 'inv-z6-ab', 'pay-z6-bank');
  if pg_temp.offen('inv-z6-ab') <> 1000
     or exists (select 1 from public.workspace_bank_reconciliations where workspace_id = ws and bank_transaction_id = 'btx-z6') then
    raise exception 'Z7: nach Ruecknahme nicht wieder offen oder Zuordnung nicht frei';
  end if;
  r := pg_temp.zuordnen('btx-z6', 'inv-z6-ab', 'pay-z6-bank2');
  raise notice 'OK  Z7: Ruecknahme oeffnet den Rest, neue Zuordnung moeglich';

  -- Z8: Rundung -- 333,33 mit 3 % Skonto: 323,32 rechtzeitig gleicht aus (ein Cent Spielraum), 323,31 nicht.
  perform public.create_workspace_order(ws, 'v-z8', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z8', 'inv-z8-ab',
    pg_temp.beleg('abschlag', 0, 333.33, 333.33, '{"calculationMode":"fixed_amount","fixedAmountNet":333.33,"abschlagNumber":1,"issueDate":"2026-09-01","skontoText":"3 % Skonto bei Zahlung innerhalb von 10 Tagen"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-z8-ab', 'pay-z8', 323.32, '2026-09-05', null, null, 'bank');
  perform pg_temp.bank('btx-z8', 1, '2026-09-06');
  perform pg_temp.erwarte_fehler('Z8a 323,32 von 323,33 rechtzeitig: +0,01 per Bank',
    $q$select pg_temp.zuordnen('btx-z8', 'inv-z8-ab', 'pay-z8-cent')$q$,
    'Kein offener Betrag');
  perform public.create_workspace_order(ws, 'v-z8b', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-z8b', 'inv-z8b-ab',
    pg_temp.beleg('abschlag', 0, 333.33, 333.33, '{"calculationMode":"fixed_amount","fixedAmountNet":333.33,"abschlagNumber":1,"issueDate":"2026-09-01","skontoText":"3 % Skonto bei Zahlung innerhalb von 10 Tagen"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-z8b-ab', 'pay-z8b', 323.31, '2026-09-05', null, null, 'bank');
  if pg_temp.offen('inv-z8b-ab') <> 1002 then
    raise exception 'Z8b: offen nach 323,31 ist % statt 1002 Cent', pg_temp.offen('inv-z8b-ab');
  end if;
  perform pg_temp.bank('btx-z8b', 1, '2026-09-06');
  r := pg_temp.zuordnen('btx-z8b', 'inv-z8b-ab', 'pay-z8b-cent');
  if pg_temp.offen('inv-z8b-ab') <> 0 then
    raise exception 'Z8b: der fehlende Cent gleicht nicht aus';
  end if;
  raise notice 'OK  Z8: Rundung -- ein Cent Spielraum wie in Schlussrechnung und Client';

  -- Z9: Ausgaben im Bankabgleich unveraendert.
  insert into public.workspace_expenses (workspace_id, client_expense_id, status, dedupe_key, payload, deleted, row_version, created_by)
  values (ws, 'e-z9', 'gebucht', 'e-z9',
          '{"id":"e-z9","category":"material","supplierName":"Lieferant","title":"Material","issueDate":"2026-09-01","netAmount":42.02,"taxAmount":7.98,"grossAmount":50,"taxStatus":"standard_19"}'::jsonb,
          false, 1, '00000000-0000-0000-0000-0000000fcb01');
  perform pg_temp.bank('btx-z9', -5000, '2026-09-06');
  r := public.confirm_workspace_bank_reconciliation(ws, 'btx-z9', 'expense', 'e-z9', 'pay-z9', 'rec-z9');
  if not exists (select 1 from public.workspace_expense_payments where workspace_id = ws and client_expense_id = 'e-z9' and amount = 50) then
    raise exception 'Z9: Ausgabe nicht per Bank bezahlt';
  end if;
  raise notice 'OK  Z9: Ausgabe per Bankabgleich wie bisher';

  -- Z10: Rechte wie in der Produktion; die neue Rechenfunktion nur fuer den Eigentuemer.
  if has_function_privilege('anon', 'public.workspace_invoice_open_cents(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_invoice_open_cents(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.workspace_invoice_open_cents(uuid, text)', 'execute') then
    raise exception 'Z10: workspace_invoice_open_cents ist von aussen aufrufbar';
  end if;
  -- Die Pruefung der Schlussrechnung wie in der Produktion: nur der Eigentuemer (Aufruf aus der Freigabe).
  if has_function_privilege('anon', 'public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean)', 'execute')
     or has_function_privilege('service_role', 'public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean)', 'execute') then
    raise exception 'Z10: assert_workspace_invoice_integrity ist von aussen aufrufbar';
  end if;
  if has_function_privilege('anon', 'public.confirm_workspace_bank_reconciliation(uuid, text, text, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.confirm_workspace_bank_reconciliation(uuid, text, text, text, text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text, boolean)', 'execute') then
    raise exception 'Z10: Rechte von Bankabgleich oder Zahlung veraendert';
  end if;
  raise notice 'OK  Z10: Rechte unveraendert; Rechenfunktion nur fuer den Eigentuemer';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
