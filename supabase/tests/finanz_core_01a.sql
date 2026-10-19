-- FINANZ-CORE-01A — Serververträge für Angebote, Rechnungen und Storno.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/finanz_core_01a.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fc001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000fc002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-mitglied@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

-- Wie in invoice_closeout_03d: freigegebene Konten mit aktiver Lizenz.
update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values
  ('00000000-0000-0000-0000-00000000fc01', 'FC01A-Regeln', '00000000-0000-0000-0000-0000000fc001'),
  ('00000000-0000-0000-0000-00000000fc02', 'FC01A-Nummern', '00000000-0000-0000-0000-0000000fc001'),
  ('00000000-0000-0000-0000-00000000fc03', 'FC01A-Start', '00000000-0000-0000-0000-0000000fc001'),
  ('00000000-0000-0000-0000-00000000fc04', 'FC01A-Fortsetzung', '00000000-0000-0000-0000-0000000fc001');
insert into public.workspace_members (workspace_id, user_id, role, status)
values
  ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-0000000fc001', 'owner', 'active'),
  ('00000000-0000-0000-0000-00000000fc02', '00000000-0000-0000-0000-0000000fc001', 'owner', 'active'),
  ('00000000-0000-0000-0000-00000000fc03', '00000000-0000-0000-0000-0000000fc001', 'owner', 'active'),
  ('00000000-0000-0000-0000-00000000fc03', '00000000-0000-0000-0000-0000000fc002', 'member', 'active'),
  ('00000000-0000-0000-0000-00000000fc04', '00000000-0000-0000-0000-0000000fc001', 'owner', 'active'),
  ('00000000-0000-0000-0000-00000000fc04', '00000000-0000-0000-0000-0000000fc002', 'member', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values
  ('00000000-0000-0000-0000-00000000fc01', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb),
  ('00000000-0000-0000-0000-00000000fc02', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb),
  ('00000000-0000-0000-0000-00000000fc03', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb),
  ('00000000-0000-0000-0000-00000000fc04', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb),
  ('00000000-0000-0000-0000-00000000fc04', 'cust-2', '{"id":"cust-2","name":"Muster GmbH"}'::jsonb);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fc001');

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

-- Beleg ohne Umsatzsteuer (Kleinunternehmer): Betrag = Netto, keine Steuerrundung im Weg.
-- Fortsetzung: Empfaengeranschrift und Paragraf-19-Hinweis sind jetzt Pflicht (RE-09, SQL-09).
-- FC01A-P1-NACHARBEIT (#8): Seit 20261115120000 traegt jede Abzugszeile Nummer, Datum, Netto und
-- Abschlagsnummer des gespeicherten Abschlags -- wie jeder Client sie sendet
-- (getPreviousAbschlagDeductions). Verkuerzte Abzuege dieser Datei ({invoiceId, amount}) werden
-- deshalb wie im Client aus dem Abschlag ergaenzt. Kennung, Betrag und eingefrorene Zahlung/Skonto
-- bleiben unberuehrt; ein Abzug mit eigener Nummer oder ohne gespeicherten Abschlag ebenso.
create function pg_temp.abzuege_wie_client(p_payload jsonb) returns jsonb language sql stable as $p$
  select case when jsonb_typeof(p_payload->'previousAbschlagDeductions') = 'array' then
    p_payload || jsonb_build_object('previousAbschlagDeductions', coalesce((
      select jsonb_agg(
        case when a.client_invoice_id is null or d.value ? 'invoiceNumber' then d.value
        else jsonb_strip_nulls(jsonb_build_object(
               'invoiceNumber', a.invoice_number,
               'abschlagNumber', a.payload->'abschlagNumber',
               'date', coalesce(a.payload->>'issueDate', a.payload->>'date'),
               'subtotal', a.payload->'subtotal')) || d.value
        end order by d.n)
      from jsonb_array_elements(p_payload->'previousAbschlagDeductions') with ordinality d(value, n)
      left join lateral (
        select wi.client_invoice_id, wi.invoice_number, wi.payload
        from public.workspace_invoices wi
        where wi.workspace_id in ('00000000-0000-0000-0000-00000000fc01', '00000000-0000-0000-0000-00000000fc02', '00000000-0000-0000-0000-00000000fc03', '00000000-0000-0000-0000-00000000fc04')
          and wi.client_invoice_id = d.value->>'invoiceId'
        limit 1
      ) a on true
    ), '[]'::jsonb))
  else p_payload end;
$p$;

create function pg_temp.beleg(
  p_type text,
  p_menge numeric,
  p_subtotal numeric,
  p_amount numeric,
  p_extra jsonb default '{}'::jsonb
) returns jsonb language sql stable as $p$
  select pg_temp.abzuege_wie_client(jsonb_build_object(
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
  ) || p_extra);
$p$;

create function pg_temp.auftrag(p_tax text default 'kleinunternehmer_19') returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'customerId', 'cust-1',
    'customerBilling', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb,
    'title', 'FC01A', 'baustelle', '', 'taxStatus', p_tax,
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb);
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fc01';
  r jsonb;
begin
  /* ---------------------------------------------------------------- */
  /* SQL-01 — frueherer Beleg erst nach Storno der Schlussrechnung     */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-s1', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-s1', 'inv-s1-ab',
    pg_temp.beleg('abschlag', 0, 200, 200, '{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-s1', 'inv-s1-teil', pg_temp.beleg('teilrechnung', 2, 200, 200));
  -- WEISS-Nacharbeit N02: Eine Schlussrechnung zieht nur beglichene Abschlaege ab.
  perform public.add_workspace_invoice_payment(ws, 'inv-s1-ab', 'pay-s1-ab', 200, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-s1', 'inv-s1-schluss',
    pg_temp.beleg('schluss', 98, 9800, 9600, '{"previousAbschlagDeductions":[{"invoiceId":"inv-s1-ab","amount":200}]}'::jsonb));

  perform pg_temp.erwarte_fehler('SQL-01a Pauschalabschlag nach Schlussrechnung',
    $q$select public.cancel_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'inv-s1-ab', 'Test')$q$,
    'invoice_cancel_final_invoice_exists');
  perform pg_temp.erwarte_fehler('SQL-01b Teilrechnung nach Schlussrechnung',
    $q$select public.cancel_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'inv-s1-teil', 'Test')$q$,
    'invoice_cancel_final_invoice_exists');
  if exists (select 1 from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-s1' and cancelled_at is not null) then
    raise exception 'SQL-01c: abgewiesenes Storno hat dennoch storniert';
  end if;

  -- Erst die Schlussrechnung, dann die frueheren Belege.
  perform public.cancel_workspace_invoice(ws, 'inv-s1-schluss', 'Schlussrechnung neu');
  -- Ein bezahlter Beleg wird erst nach Ruecknahme seiner Zahlung storniert.
  perform public.reverse_workspace_invoice_payment(ws, 'inv-s1-ab', 'pay-s1-ab');
  perform public.cancel_workspace_invoice(ws, 'inv-s1-ab', 'Abschlag falsch');
  perform public.cancel_workspace_invoice(ws, 'inv-s1-teil', 'Teilrechnung falsch');
  if (select count(*) from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-s1' and cancelled_at is not null) <> 3 then
    raise exception 'SQL-01d: nach dem Storno der Schlussrechnung nicht alles stornierbar';
  end if;
  raise notice 'OK  SQL-01: frueherer Beleg erst nach Storno der Schlussrechnung stornierbar';

  /*
   * STO-05 — der Korrekturbeleg traegt den Geschaeftstag (Europe/Berlin), nicht den UTC-Tag.
   * Grenze der Gegenprobe: Von der alten UTC-Regel unterscheidet sich das nur, solange
   * Berliner und UTC-Datum auseinanderfallen (0 bis 2 Uhr Berliner Zeit).
   */
  perform public.create_workspace_order(ws, 'v-sto5', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-sto5', 'inv-sto5', pg_temp.beleg('rechnung', 1, 100, 100));
  perform public.update_workspace_invoice_sent(ws, 'inv-sto5', '2026-10-05', 'email', null);
  perform public.cancel_workspace_invoice(ws, 'inv-sto5', 'Falscher Empfaenger');
  if (select d.payload->>'correctionIssueDate' from public.workspace_documents d
      where d.workspace_id = ws and d.client_document_id = 'corr-inv-sto5')
     is distinct from to_char(timezone('Europe/Berlin', now()), 'YYYY-MM-DD') then
    raise exception 'STO-05: Korrekturdatum ist nicht der Geschaeftstag';
  end if;
  raise notice 'OK  STO-05: Korrekturdatum = Geschaeftstag Europe/Berlin';

  /* ---------------------------------------------------------------- */
  /* SQL-04 — nach wirksamer Schlussrechnung keine weitere Rechnung    */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-s4', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-s4', 'inv-s4-ab',
    pg_temp.beleg('abschlag', 0, 300, 300, '{"calculationMode":"fixed_amount","fixedAmountNet":300,"abschlagNumber":1}'::jsonb));
  -- WEISS-Nacharbeit N02: Eine Schlussrechnung zieht nur beglichene Abschlaege ab.
  perform public.add_workspace_invoice_payment(ws, 'inv-s4-ab', 'pay-s4-ab', 300, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-s4', 'inv-s4-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9700, '{"previousAbschlagDeductions":[{"invoiceId":"inv-s4-ab","amount":300}]}'::jsonb));

  perform pg_temp.erwarte_fehler('SQL-04a weiterer Abschlag nach Schlussrechnung',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-s4', 'inv-s4-ab2',
         pg_temp.beleg('abschlag', 0, 100, 100, '{"calculationMode":"fixed_amount","fixedAmountNet":100,"abschlagNumber":2}'::jsonb))$q$,
    'invoice_after_final_invoice');
  perform pg_temp.erwarte_fehler('SQL-04b Teilrechnung nach Schlussrechnung',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-s4', 'inv-s4-teil',
         pg_temp.beleg('teilrechnung', 1, 100, 100, '{"overbillingAcknowledged":true}'::jsonb), true)$q$,
    'invoice_after_final_invoice');

  -- Eine Wiederholung bekommt ihren Erfolg — auch fuer den frueheren Abschlag.
  r := public.finalize_workspace_invoice(ws, 'v-s4', 'inv-s4-ab',
    pg_temp.beleg('abschlag', 0, 300, 300, '{"calculationMode":"fixed_amount","fixedAmountNet":300,"abschlagNumber":1}'::jsonb));
  if (r->>'idempotent_replay')::boolean is distinct from true then
    raise exception 'SQL-04c: Replay des frueheren Abschlags nicht als Wiederholung beantwortet';
  end if;
  if (select count(*) from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-s4') <> 2 then
    raise exception 'SQL-04d: abgewiesene Freigabe hat eine Rechnung hinterlassen';
  end if;

  -- Nach dem Storno der Schlussrechnung ist ein weiterer Abschlag wieder moeglich.
  perform public.cancel_workspace_invoice(ws, 'inv-s4-schluss', 'Neu');
  perform public.finalize_workspace_invoice(ws, 'v-s4', 'inv-s4-ab2',
    pg_temp.beleg('abschlag', 0, 100, 100, '{"calculationMode":"fixed_amount","fixedAmountNet":100,"abschlagNumber":2}'::jsonb));
  raise notice 'OK  SQL-04: nach wirksamer Schlussrechnung keine weitere Rechnung, Replay unberuehrt';

  /* ---------------------------------------------------------------- */
  /* SQL-06 — stornierte Schlussrechnung sperrt keinen Nachtrag        */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-s6', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-s6', 'inv-s6-schluss', pg_temp.beleg('schluss', 100, 10000, 10000));
  perform pg_temp.erwarte_fehler('SQL-06a Nachtrag nach wirksamer Schlussrechnung',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000fc01', 'v-s6', 'oam-s6',
         jsonb_build_object('title', 'Nachtrag', 'positions', jsonb_build_array(jsonb_build_object(
           'id', 'oad-s6', 'changeType', 'add', 'description', 'Zusatz', 'plannedQuantity', 1, 'unit', 'Stunden', 'unitPrice', 50))))$q$,
    'order_amendment_final_invoice_exists');
  perform public.cancel_workspace_invoice(ws, 'inv-s6-schluss', 'Nachtrag folgt');
  r := public.confirm_workspace_order_amendment(ws, 'v-s6', 'oam-s6',
    jsonb_build_object('title', 'Nachtrag', 'positions', jsonb_build_array(jsonb_build_object(
      'id', 'oad-s6', 'changeType', 'add', 'description', 'Zusatz', 'plannedQuantity', 1, 'unit', 'Stunden', 'unitPrice', 50))));
  if not exists (select 1 from public.workspace_order_amendments where workspace_id = ws and vorgang_id = 'v-s6') then
    raise exception 'SQL-06b: Nachtrag nach storniertem Schluss nicht angelegt';
  end if;
  raise notice 'OK  SQL-06: stornierte Schlussrechnung sperrt den Nachtrag nicht mehr';

  /* ---------------------------------------------------------------- */
  /* SQL-10 — "unclear" ist keine Steuerentscheidung                   */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-t-unklar', pg_temp.auftrag('unclear'));
  -- Die Rechnung entscheidet: 19 % auf einem Auftrag ohne Entscheidung ist zulaessig.
  perform public.finalize_workspace_invoice(ws, 'v-t-unklar', 'inv-t-19',
    pg_temp.beleg('rechnung', 1, 100, 119, '{"taxStatus":"standard_19"}'::jsonb));
  perform pg_temp.erwarte_fehler('SQL-10a Rechnung mit unklarem Steuerstatus',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-t-unklar', 'inv-t-unklar',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"taxStatus":"unclear"}'::jsonb))$q$,
    'invoice_tax_status_invalid');
  -- Ein entschiedener Auftrag gibt den Status weiterhin vor.
  perform public.create_workspace_order(ws, 'v-t-klar', pg_temp.auftrag('kleinunternehmer_19'));
  perform pg_temp.erwarte_fehler('SQL-10b abweichender Status gegen entschiedenen Auftrag',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-t-klar', 'inv-t-abw',
         pg_temp.beleg('rechnung', 1, 100, 119, '{"taxStatus":"standard_19"}'::jsonb))$q$,
    'invoice_tax_status_mismatch');

  -- Angebot: Freigabe nur mit Steuerentscheidung.
  perform pg_temp.erwarte_fehler('ANG-01 Angebot mit unklarem Steuerstatus',
    $q$select public.finalize_workspace_offer('00000000-0000-0000-0000-00000000fc01', 'off-unklar',
         '{"customer":{"name":"Muster GmbH"},"title":"Dach","validUntil":"2026-11-30","offerDate":"2026-10-11","taxStatus":"unclear",
           "positions":[{"description":"Dach","quantity":1,"unit":"Stück","unitPrice":100}],"totals":{"subtotal":100,"taxRate":0,"tax":0,"total":100}}'::jsonb, 'fp-1', 0)$q$,
    'Steuerstatus unklar');
  r := public.finalize_workspace_offer(ws, 'off-klar',
    '{"customer":{"name":"Muster GmbH"},"title":"Dach","validUntil":"2026-11-30","offerDate":"2026-10-11","taxStatus":"standard_19",
      "positions":[{"description":"Dach","quantity":1,"unit":"Stück","unitPrice":100}],"totals":{"subtotal":100,"taxRate":19,"tax":19,"total":119}}'::jsonb, 'fp-2', 0);
  if r->'row'->>'status' is distinct from 'freigegeben' then
    raise exception 'ANG-01b: entschiedenes Angebot nicht freigegeben';
  end if;
  raise notice 'OK  SQL-10/ANG-01: unklarer Steuerstatus weder auf Rechnung noch auf Angebot; Auftrag ohne Entscheidung abrechenbar';

  /* ---------------------------------------------------------------- */
  /* RE-04 — Pauschalabschlag: Grenze gegen alles Abgerechnete; danach */
  /*         keine "Rechnung" mehr, sondern die Schlussrechnung        */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-r4', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-r4', 'inv-r4-teil', pg_temp.beleg('teilrechnung', 80, 8000, 8000));
  perform pg_temp.erwarte_fehler('RE-04a Pauschalabschlag ueber dem Rest nach Teilrechnung',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-r4', 'inv-r4-ab-hoch',
         pg_temp.beleg('abschlag', 0, 2500, 2500, '{"calculationMode":"fixed_amount","fixedAmountNet":2500,"abschlagNumber":1}'::jsonb))$q$,
    'invoice_fixed_amount_exceeds_remaining');
  -- Innerhalb des Rests (10.000 - 8.000) ist der Pauschalabschlag zulaessig.
  perform public.finalize_workspace_invoice(ws, 'v-r4', 'inv-r4-ab',
    pg_temp.beleg('abschlag', 0, 1500, 1500, '{"calculationMode":"fixed_amount","fixedAmountNet":1500,"abschlagNumber":1}'::jsonb));
  perform pg_temp.erwarte_fehler('RE-04b Rechnung nach Pauschalabschlag',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-r4', 'inv-r4-rechnung',
         pg_temp.beleg('rechnung', 20, 2000, 2000))$q$,
    'invoice_requires_final_after_fixed_abschlag');
  -- Die Schlussrechnung zieht den Pauschalabschlag ab.
  -- WEISS-Nacharbeit N02: Eine Schlussrechnung zieht nur beglichene Abschlaege ab.
  perform public.add_workspace_invoice_payment(ws, 'inv-r4-ab', 'pay-r4-ab', 1500, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-r4', 'inv-r4-schluss',
    pg_temp.beleg('schluss', 20, 2000, 500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-r4-ab","amount":1500}]}'::jsonb));
  if (select count(*) from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-r4') <> 3 then
    raise exception 'RE-04c: abgewiesene Freigaben haben Rechnungen hinterlassen';
  end if;

  -- Ein stornierter Pauschalabschlag sperrt nichts; ein mengenbasierter Abschlag ebenso wenig.
  perform public.create_workspace_order(ws, 'v-r4s', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-r4s', 'inv-r4s-ab',
    pg_temp.beleg('abschlag', 0, 1000, 1000, '{"calculationMode":"fixed_amount","fixedAmountNet":1000,"abschlagNumber":1}'::jsonb));
  perform public.cancel_workspace_invoice(ws, 'inv-r4s-ab', 'Falscher Betrag');
  perform public.finalize_workspace_invoice(ws, 'v-r4s', 'inv-r4s-rechnung', pg_temp.beleg('rechnung', 10, 1000, 1000));
  perform public.create_workspace_order(ws, 'v-r4m', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-r4m', 'inv-r4m-ab', pg_temp.beleg('abschlag', 10, 1000, 1000, '{"abschlagNumber":1}'::jsonb));
  perform public.finalize_workspace_invoice(ws, 'v-r4m', 'inv-r4m-rechnung', pg_temp.beleg('rechnung', 90, 9000, 9000));
  raise notice 'OK  RE-04: Pauschalgrenze nach Teilrechnung, keine Rechnung nach Pauschalabschlag, Schluss zieht ab; Storno und Mengenabschlag sperren nicht';

  /* ---------------------------------------------------------------- */
  /* SQL-08 — nur die vier Rechnungsarten des Clients                  */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-s8', pg_temp.auftrag());
  perform pg_temp.erwarte_fehler('SQL-08a Schreibweise Schluss',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-s8', 'inv-s8-a',
         pg_temp.beleg('Schluss', 100, 10000, 10000))$q$,
    'invoice_type_invalid');
  perform pg_temp.erwarte_fehler('SQL-08b Gutschrift',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc01', 'v-s8', 'inv-s8-b',
         pg_temp.beleg('gutschrift', 1, 100, 100))$q$,
    'invoice_type_invalid');
  if exists (select 1 from public.workspace_invoices where workspace_id = ws and vorgang_id = 'v-s8') then
    raise exception 'SQL-08c: abgewiesene Rechnungsart hat einen Beleg hinterlassen';
  end if;
  -- Die vier gueltigen Arten bleiben moeglich.
  perform public.finalize_workspace_invoice(ws, 'v-s8', 'inv-s8-ok', pg_temp.beleg('rechnung', 1, 100, 100));
  raise notice 'OK  SQL-08: nur rechnung, abschlag, teilrechnung und schluss';
end $$;

/* -------------------------------------------------------------------- */
/* SQL-03 — Nummernformat ohne Jahreszahl zaehlt jahresuebergreifend     */
/* -------------------------------------------------------------------- */
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fc02';
  r jsonb;
begin
  perform public.set_workspace_invoice_number_format(ws, 'RE', false, 4, 0);
  perform public.create_workspace_order(ws, 'v-n', pg_temp.auftrag());
  /*
   * Fortsetzung (SQL-15): Ein Rechnungsdatum in der Zukunft ist jetzt abgewiesen. Der
   * Jahreswechsel laeuft deshalb ueber das Vorjahr 2025 und das laufende Jahr 2026.
   */
  r := public.finalize_workspace_invoice(ws, 'v-n', 'inv-n-1',
    pg_temp.beleg('rechnung', 1, 100, 100, '{"issueDate":"2025-12-29"}'::jsonb));
  if r->'invoice'->>'number' <> 'RE-0001' then raise exception 'SQL-03a: % statt RE-0001', r->'invoice'->>'number'; end if;
  r := public.finalize_workspace_invoice(ws, 'v-n', 'inv-n-2',
    pg_temp.beleg('rechnung', 1, 100, 100, '{"issueDate":"2025-12-29"}'::jsonb));
  if r->'invoice'->>'number' <> 'RE-0002' then raise exception 'SQL-03b: % statt RE-0002', r->'invoice'->>'number'; end if;

  -- Folgejahr: bisher wieder RE-0001 und damit dauerhaft eine Kollision.
  r := public.finalize_workspace_invoice(ws, 'v-n', 'inv-n-3', pg_temp.beleg('rechnung', 1, 100, 100));
  if r->'invoice'->>'number' <> 'RE-0003' then raise exception 'SQL-03c: % statt RE-0003', r->'invoice'->>'number'; end if;
  -- Ein nachtraeglicher Beleg des Vorjahres liegt ueber allem bisher Vergebenen.
  r := public.finalize_workspace_invoice(ws, 'v-n', 'inv-n-4',
    pg_temp.beleg('rechnung', 1, 100, 100, '{"issueDate":"2025-12-30"}'::jsonb));
  if r->'invoice'->>'number' <> 'RE-0004' then raise exception 'SQL-03d: % statt RE-0004', r->'invoice'->>'number'; end if;
  r := public.finalize_workspace_invoice(ws, 'v-n', 'inv-n-5', pg_temp.beleg('rechnung', 1, 100, 100));
  if r->'invoice'->>'number' <> 'RE-0005' then raise exception 'SQL-03e: % statt RE-0005', r->'invoice'->>'number'; end if;
  raise notice 'OK  SQL-03: ohne Jahreszahl RE-0001, RE-0002 (2025), RE-0003 (2026), RE-0004 (2025), RE-0005 (2026)';
end $$;

/* -------------------------------------------------------------------- */
/* RE-02 — Startnummer aus der Einrichtung                               */
/* -------------------------------------------------------------------- */
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fc03';
  r jsonb;
begin
  -- Mitglieder duerfen den Nummernkreis nicht setzen (42501 wie der Versandvermerk).
  perform pg_temp.als('00000000-0000-0000-0000-0000000fc002');
  perform pg_temp.erwarte_fehler('RE-02a Mitglied',
    $q$select public.set_workspace_invoice_number_start('00000000-0000-0000-0000-00000000fc03', 2026, 123)$q$,
    '42501');
  perform pg_temp.als('00000000-0000-0000-0000-0000000fc001');

  r := public.set_workspace_invoice_number_start(ws, 2026, 123);
  if (r->>'applied')::boolean is distinct from true then raise exception 'RE-02b: nicht angewendet: %', r; end if;
  r := public.set_workspace_invoice_number_start(ws, 2026, 123);
  if (r->>'applied')::boolean is distinct from false then raise exception 'RE-02c: Wiederholung nicht idempotent: %', r; end if;

  perform public.create_workspace_order(ws, 'v-start', pg_temp.auftrag());
  r := public.finalize_workspace_invoice(ws, 'v-start', 'inv-start-1', pg_temp.beleg('rechnung', 1, 100, 100));
  if r->'invoice'->>'number' <> '2026-0124' then raise exception 'RE-02d: % statt 2026-0124', r->'invoice'->>'number'; end if;

  -- Ein benutzter Kreis wird nie verschoben.
  perform pg_temp.erwarte_fehler('RE-02e benutzter Kreis',
    $q$select public.set_workspace_invoice_number_start('00000000-0000-0000-0000-00000000fc03', 2026, 500)$q$,
    'invoice_number_start_locked');
  perform pg_temp.erwarte_fehler('RE-02f ungueltiger Wert',
    $q$select public.set_workspace_invoice_number_start('00000000-0000-0000-0000-00000000fc03', 2028, -1)$q$,
    'invoice_number_start_invalid');

  -- Rechte: anon nie, authenticated ja; die interne Untergrenze ruft niemand direkt.
  if has_function_privilege('anon', 'public.set_workspace_invoice_number_start(uuid, integer, integer)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.set_workspace_invoice_number_start(uuid, integer, integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.workspace_invoice_sequence_floor(uuid, integer, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.workspace_invoice_sequence_floor(uuid, integer, integer)', 'EXECUTE') then
    raise exception 'RE-02g: Rechte der neuen Funktionen falsch';
  end if;
  raise notice 'OK  RE-02: Startnummer 123 → erste Rechnung 2026-0124; benutzter Kreis gesperrt; Mitglied 42501';
end $$;

/* ==================================================================== */
/* FORTSETZUNG (Fachabschluss) — SQL-11, SQL-07, AUS-15, SQL-05, RE-09,  */
/* SQL-09, SQL-12 bis SQL-18, SQL-10, ANG-09, ANG-15, SQL-16, SQL-17,    */
/* SQL-08                                                                 */
/* ==================================================================== */
create function pg_temp.heute() returns text language sql stable as $p$
  select to_char(timezone('Europe/Berlin', now()), 'YYYY-MM-DD');
$p$;

create function pg_temp.lieferung(p_ws uuid, p_id text, p_kind text, p_invoice text, p_document text, p_status text)
returns uuid language sql as $p$
  insert into public.workspace_document_deliveries (
    workspace_id, client_delivery_id, document_kind, linked_invoice_id, linked_document_id,
    recipient_email, subject, body_text, provider, status, requested_by, requested_at, sending_started_at)
  values (p_ws, p_id, p_kind, p_invoice, p_document, 'kunde@example.invalid', 'Beleg', 'Text', 'stub', p_status,
          '00000000-0000-0000-0000-0000000fc001', now(), case when p_status = 'sending' then now() end)
  returning id;
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fc04';
  r jsonb;
  v_row public.workspace_invoices;
  v_nummer text;
  v_seq_vorher integer;
  v_delivery uuid;
  v_paid public.workspace_invoice_payments;
  v_heute jsonb := jsonb_build_object('issueDate', pg_temp.heute());
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000fc001');

  /* ---------------------------------------------------------------- */
  /* SQL-11 — eigene Korrekturnummer aus dem Rechnungskreis            */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-k', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-k', 'inv-k-1', pg_temp.beleg('rechnung', 1, 100, 100, v_heute));
  perform public.update_workspace_invoice_sent(ws, 'inv-k-1', pg_temp.heute(), 'email', null);
  select * into v_row from public.cancel_workspace_invoice(ws, 'inv-k-1', 'Falsche Menge');
  if v_row.cancellation_kind is distinct from 'correction' or v_row.correction_number is null then
    raise exception 'SQL-11a: keine Korrekturnummer (%, %)', v_row.cancellation_kind, v_row.correction_number;
  end if;
  if v_row.correction_number = v_row.invoice_number then
    raise exception 'SQL-11b: Korrekturnummer gleich Rechnungsnummer';
  end if;
  if (select d.payload->>'correctionNumber' from public.workspace_documents d
      where d.workspace_id = ws and d.client_document_id = 'corr-inv-k-1') is distinct from v_row.correction_number then
    raise exception 'SQL-11c: Korrekturbeleg traegt eine andere Nummer';
  end if;
  v_nummer := v_row.correction_number;
  select s.last_sequence into v_seq_vorher
  from public.workspace_invoice_sequences s
  where s.workspace_id = ws and s.invoice_year = extract(year from timezone('Europe/Berlin', now()))::integer;
  -- Wiederholung: dieselbe Nummer, kein weiterer Platz im Kreis.
  select * into v_row from public.cancel_workspace_invoice(ws, 'inv-k-1', 'Anderer Grund');
  if v_row.correction_number is distinct from v_nummer or (
    select s.last_sequence from public.workspace_invoice_sequences s
    where s.workspace_id = ws and s.invoice_year = extract(year from timezone('Europe/Berlin', now()))::integer
  ) <> v_seq_vorher then
    raise exception 'SQL-11d: Wiederholung hat neu vergeben';
  end if;
  -- Die naechste Rechnung folgt nach der Korrekturnummer; nichts doppelt.
  r := public.finalize_workspace_invoice(ws, 'v-k', 'inv-k-2', pg_temp.beleg('rechnung', 1, 100, 100, v_heute));
  if (r->'row'->>'invoice_sequence_number')::integer <> v_seq_vorher + 1 or r->'invoice'->>'number' = v_nummer then
    raise exception 'SQL-11e: Folge nach der Korrekturnummer: % (%)', r->'invoice'->>'number', v_nummer;
  end if;
  -- Internes Storno: kein Beleg, keine Nummer.
  select * into v_row from public.cancel_workspace_invoice(ws, 'inv-k-2', 'Nie versendet');
  if v_row.cancellation_kind is distinct from 'internal' or v_row.correction_number is not null then
    raise exception 'SQL-11f: internes Storno mit Korrekturnummer';
  end if;
  raise notice 'OK  SQL-11: Korrekturbeleg % aus dem Rechnungskreis, Wiederholung stabil, intern ohne Nummer', v_nummer;

  /* ---------------------------------------------------------------- */
  /* SQL-07 / AUS-15 — Versand gegen Storno                            */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-d', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-d', 'inv-d-1', pg_temp.beleg('rechnung', 1, 100, 100));
  v_delivery := pg_temp.lieferung(ws, 'cd-d-1', 'invoice', 'inv-d-1', null, 'sending');
  perform pg_temp.erwarte_fehler('SQL-07a Storno waehrend des Versands',
    $q$select public.cancel_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'inv-d-1', 'Test')$q$,
    'invoice_cancel_delivery_in_progress');
  update public.workspace_document_deliveries set status = 'unknown', error_category = 'unknown' where id = v_delivery;
  perform pg_temp.erwarte_fehler('SQL-07b internes Storno bei unklarem Versand',
    $q$select public.cancel_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'inv-d-1', 'Test')$q$,
    'invoice_cancel_delivery_uncertain');
  -- Als versendet vermerkt: Storno mit Korrekturbeleg.
  perform public.update_workspace_invoice_sent(ws, 'inv-d-1', pg_temp.heute(), 'email', null);
  select * into v_row from public.cancel_workspace_invoice(ws, 'inv-d-1', 'Kunde hat sie doch');
  if v_row.cancellation_kind is distinct from 'correction' then
    raise exception 'SQL-07c: unklarer Versand einer versendeten Rechnung blockiert das Korrekturstorno';
  end if;

  -- Ein wartender Auftrag einer intern stornierten Rechnung geht nicht hinaus.
  perform public.finalize_workspace_invoice(ws, 'v-d', 'inv-d-2', pg_temp.beleg('rechnung', 1, 100, 100));
  v_delivery := pg_temp.lieferung(ws, 'cd-d-2', 'invoice', 'inv-d-2', null, 'queued');
  perform public.cancel_workspace_invoice(ws, 'inv-d-2', 'Nie versendet');
  r := public.claim_workspace_document_delivery_for_send(v_delivery, 1);
  if (r->>'claimed')::boolean or r->'delivery'->>'status' <> 'failed' or r->'delivery'->>'error_code' <> 'invoice_cancelled' then
    raise exception 'SQL-07d: Claim einer stornierten Rechnung: %', r;
  end if;

  -- Aelterer Weg ohne Claim (queued -> provider_accepted): keine stille Kopplung.
  perform public.finalize_workspace_invoice(ws, 'v-d', 'inv-d-3', pg_temp.beleg('rechnung', 1, 100, 100));
  v_delivery := pg_temp.lieferung(ws, 'cd-d-3', 'invoice', 'inv-d-3', null, 'queued');
  perform public.cancel_workspace_invoice(ws, 'inv-d-3', 'Nie versendet');
  r := public.mark_workspace_document_delivery_accepted(v_delivery, 'msg-d-3', null);
  if r->>'coupling' <> 'invoice_cancelled_conflict' or (
    select wi.invoice_status from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-3'
  ) <> 'vorbereitet' then
    raise exception 'SQL-07e: intern stornierte Rechnung still gekoppelt: %', r;
  end if;

  -- Der normale Weg bleibt: Claim, Annahme, Kopplung mit dem Geschaeftstag.
  perform public.finalize_workspace_invoice(ws, 'v-d', 'inv-d-4', pg_temp.beleg('rechnung', 1, 100, 100));
  v_delivery := pg_temp.lieferung(ws, 'cd-d-4', 'invoice', 'inv-d-4', null, 'queued');
  r := public.claim_workspace_document_delivery_for_send(v_delivery, 1);
  if not (r->>'claimed')::boolean or r->'delivery'->>'status' <> 'sending' then
    raise exception 'SQL-07f: normaler Claim gestoert: %', r;
  end if;
  r := public.mark_workspace_document_delivery_accepted(v_delivery, 'msg-d-4', null);
  if r->>'coupling' <> 'linked' or (
    select wi.payload->>'sentAt' from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-4'
  ) is distinct from pg_temp.heute() then
    raise exception 'AUS-15: Versanddatum ist nicht der Geschaeftstag: %', r;
  end if;
  raise notice 'OK  SQL-07/AUS-15: kein Storno waehrend des Versands, kein internes bei unklarem Ausgang, Claim sendet nichts Storniertes, keine stille Kopplung';

  /* ---------------------------------------------------------------- */
  /* SQL-05 / SQL-15 — Ueberzahlung nur mit Bestaetigung               */
  /* ---------------------------------------------------------------- */
  perform public.finalize_workspace_invoice(ws, 'v-d', 'inv-z-1', pg_temp.beleg('rechnung', 1, 100, 100));
  -- Acht Argumente wie der Bankabgleich: trifft die neue Fassung ueber den Standardwert.
  perform public.add_workspace_invoice_payment(ws, 'inv-z-1', 'pay-z-1', 60, '2026-10-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('SQL-05a Ueberzahlung ohne Bestaetigung',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-z-1', 'pay-z-2', 60, '2026-10-06', null, null, 'bank')$q$,
    'invoice_payment_overpayment_unconfirmed');
  perform public.add_workspace_invoice_payment(ws, 'inv-z-1', 'pay-z-3', 40, '2026-10-06', null, null, 'bank');
  perform public.add_workspace_invoice_payment(ws, 'inv-z-1', 'pay-z-4', 5, '2026-10-07', null, null, 'bank', true);
  select * into v_paid from public.add_workspace_invoice_payment(ws, 'inv-z-1', 'pay-z-4', 5, '2026-10-07', null, null, 'bank');
  if v_paid.client_payment_id is distinct from 'pay-z-4' then
    raise exception 'SQL-05b: Wiederholung der bestaetigten Zahlung verlangt eine zweite Bestaetigung';
  end if;
  perform pg_temp.erwarte_fehler('SQL-15a Zahlungsdatum in der Zukunft',
    format($q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-z-1', 'pay-z-5', 1, %L, null, null, 'bank', true)$q$,
      to_char(current_date + 10, 'YYYY-MM-DD')),
    'paid_on ungueltig');
  if exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'add_workspace_invoice_payment' and p.pronargs <> 9)
     or has_function_privilege('anon', 'public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text, boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text, boolean)', 'EXECUTE') then
    raise exception 'SQL-05c: Signatur oder Rechte der Zahlungsfunktion falsch';
  end if;
  raise notice 'OK  SQL-05/SQL-15: Ueberzahlung nur bestaetigt, genauer Rest ohne Rueckfrage, Wiederholung idempotent, kein Zukunftsdatum';

  /* ---------------------------------------------------------------- */
  /* RE-09 — Pflichtangaben fuer jede Rechnungsart                     */
  /* ---------------------------------------------------------------- */
  perform pg_temp.erwarte_fehler('RE-09a Aussteller ohne Steuernummer und USt-IdNr.',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-d', 'inv-r9-a',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"companySnapshot":{"companyName":"Muster Bau","street":"Weg 2","zip":"33602","city":"Bielefeld"}}'::jsonb))$q$,
    'invoice_company_tax_id_missing');
  perform pg_temp.erwarte_fehler('RE-09b Aussteller ohne Anschrift',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-d', 'inv-r9-b',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"companySnapshot":{"companyName":"Muster Bau","taxNumber":"133/8150/8159"}}'::jsonb))$q$,
    'invoice_company_incomplete');
  perform pg_temp.erwarte_fehler('RE-09c Auftragsrechnung ohne Empfaengeranschrift',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-d', 'inv-r9-c',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"customerSnapshot":{"name":"Muster GmbH"}}'::jsonb))$q$,
    'invoice_customer_address_incomplete');
  perform public.finalize_workspace_invoice(ws, 'v-d', 'inv-r9-ok', pg_temp.beleg('rechnung', 1, 100, 100,
    '{"companySnapshot":{"companyName":"Muster Bau","street":"Weg 2","zip":"33602","city":"Bielefeld","vatId":"DE123456789"}}'::jsonb));
  raise notice 'OK  RE-09: Steuer-ID und Anschrift des Ausstellers, Empfaengeranschrift auch im Auftragspfad';

  /* ---------------------------------------------------------------- */
  /* SQL-09 — gedruckte Belegfelder                                    */
  /* ---------------------------------------------------------------- */
  perform pg_temp.erwarte_fehler('SQL-09a Kleinunternehmer ohne Paragraf-19-Hinweis',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-d', 'inv-s9-a',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"legalNotices":["Vielen Dank fuer Ihren Auftrag."]}'::jsonb))$q$,
    'invoice_legal_notice_missing');
  perform pg_temp.erwarte_fehler('SQL-09b anderer Stammkunde als im Auftrag',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-d', 'inv-s9-b',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"customerId":"cust-2"}'::jsonb))$q$,
    'invoice_customer_mismatch');
  perform pg_temp.erwarte_fehler('SQL-09c falscher Zeilenbetrag im Auftragspfad',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-d', 'inv-s9-c',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"positions":[{"id":"l1","orderPositionId":"cp1","description":"Montagestunden","quantity":1,"unit":"Stück","unitPrice":100,"lineTotal":150}]}'::jsonb))$q$,
    'invoice_totals_mismatch');

  perform public.create_workspace_order(ws, 'v-ab', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-ab', 'inv-ab-1',
    pg_temp.beleg('abschlag', 0, 100, 100, '{"calculationMode":"fixed_amount","fixedAmountNet":100,"abschlagNumber":1}'::jsonb));
  perform pg_temp.erwarte_fehler('SQL-09d Abschlagsnummer doppelt',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-ab', 'inv-ab-2',
         pg_temp.beleg('abschlag', 0, 100, 100, '{"calculationMode":"fixed_amount","fixedAmountNet":100,"abschlagNumber":1}'::jsonb))$q$,
    'invoice_abschlag_number_taken');
  perform public.cancel_workspace_invoice(ws, 'inv-ab-1', 'Falscher Betrag');
  perform pg_temp.erwarte_fehler('SQL-09e Nummer eines stornierten Abschlags',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-ab', 'inv-ab-2',
         pg_temp.beleg('abschlag', 0, 100, 100, '{"calculationMode":"fixed_amount","fixedAmountNet":100,"abschlagNumber":1}'::jsonb))$q$,
    'invoice_abschlag_number_taken');
  perform public.finalize_workspace_invoice(ws, 'v-ab', 'inv-ab-2',
    pg_temp.beleg('abschlag', 0, 100, 100, '{"calculationMode":"fixed_amount","fixedAmountNet":100,"abschlagNumber":2}'::jsonb));
  perform pg_temp.erwarte_fehler('SQL-09f stornierter Abschlag in der Abzugsliste (gleiche Summe)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-ab', 'inv-ab-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9900, '{"previousAbschlagDeductions":[{"invoiceId":"inv-ab-1","amount":100}]}'::jsonb))$q$,
    'invoice_deductions_mismatch');
  perform pg_temp.erwarte_fehler('SQL-09g wirksamer Abschlag doppelt gelistet',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-ab', 'inv-ab-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9900, '{"previousAbschlagDeductions":[{"invoiceId":"inv-ab-2","amount":50},{"invoiceId":"inv-ab-2","amount":50}]}'::jsonb))$q$,
    'invoice_deductions_mismatch');
  -- WEISS-Nacharbeit N02: Eine Schlussrechnung zieht nur beglichene Abschlaege ab.
  perform public.add_workspace_invoice_payment(ws, 'inv-ab-2', 'pay-ab-2', 100, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-ab', 'inv-ab-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9900, '{"previousAbschlagDeductions":[{"invoiceId":"inv-ab-2","amount":100}]}'::jsonb));
  raise notice 'OK  SQL-09: Pflichthinweis, Stammkunde, Zeilenbetrag, Abschlagsnummer (auch storniert), Abzuege als Menge';

  /* ---------------------------------------------------------------- */
  /* SQL-12 / SQL-13 / SQL-14                                          */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-12', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-12', 'inv-12-a', pg_temp.beleg('teilrechnung', 90, 9000, 9000));
  perform pg_temp.erwarte_fehler('SQL-12 zwei Zeilen derselben Position ueber dem Rest',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-12', 'inv-12-b',
         pg_temp.beleg('teilrechnung', 6, 1200, 1200, '{"positions":[
           {"id":"l1","orderPositionId":"cp1","description":"Montagestunden","quantity":6,"unit":"Stück","unitPrice":100,"lineTotal":600},
           {"id":"l2","orderPositionId":"cp1","description":"Montagestunden","quantity":6,"unit":"Stück","unitPrice":100,"lineTotal":600}]}'::jsonb))$q$,
    'invoice_quantity_exceeds_available');

  perform public.create_workspace_order(ws, 'v-13', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-13', 'inv-13-ab',
    pg_temp.beleg('abschlag', 0, 1500, 1500, '{"calculationMode":"fixed_amount","fixedAmountNet":1500,"abschlagNumber":1}'::jsonb));
  perform pg_temp.erwarte_fehler('SQL-13 Abzug groesser als brutto',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-13', 'inv-13-schluss',
         pg_temp.beleg('schluss', 10, 1000, 0, '{"previousAbschlagDeductions":[{"invoiceId":"inv-13-ab","amount":1500}]}'::jsonb))$q$,
    'invoice_deductions_exceed_total');
  perform pg_temp.erwarte_fehler('SQL-14 Nullbeleg',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-12', 'inv-14',
         pg_temp.beleg('teilrechnung', 0, 0, 0))$q$,
    'invoice_positions_missing');
  raise notice 'OK  SQL-12/13/14: Grenze je Auftragsposition, kein Abzug ueber brutto, kein Nullbeleg';

  /* ---------------------------------------------------------------- */
  /* SQL-15 — Datumsangaben; SQL-18 — Wiederholung nach Versandvermerk */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-15', pg_temp.auftrag());
  perform pg_temp.erwarte_fehler('SQL-15b ungueltiges Rechnungsdatum',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-15', 'inv-15-b',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"issueDate":"2026-02-30"}'::jsonb))$q$,
    'invoice_issue_date_invalid');
  perform pg_temp.erwarte_fehler('SQL-15c Rechnungsdatum in der Zukunft',
    format($q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-15', 'inv-15-c',
         pg_temp.beleg('rechnung', 1, 100, 100, jsonb_build_object('issueDate', %L)))$q$, to_char(current_date + 10, 'YYYY-MM-DD')),
    'invoice_issue_date_in_future');
  perform pg_temp.erwarte_fehler('SQL-15d Leistungszeitraum rueckwaerts',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-15', 'inv-15-d',
         pg_temp.beleg('rechnung', 1, 100, 100, '{"servicePeriodFrom":"2026-10-05","servicePeriodTo":"2026-10-01"}'::jsonb))$q$,
    'invoice_service_period_invalid');
  perform public.finalize_workspace_invoice(ws, 'v-15', 'inv-15-ok', pg_temp.beleg('rechnung', 1, 100, 100,
    '{"servicePeriodFrom":"2026-10-01","servicePeriodTo":"2026-10-03"}'::jsonb));
  perform pg_temp.erwarte_fehler('SQL-15e Versanddatum in der Zukunft',
    format($q$select public.update_workspace_invoice_sent('00000000-0000-0000-0000-00000000fc04', 'inv-15-ok', %L, 'post', null)$q$,
      to_char(current_date + 10, 'YYYY-MM-DD')),
    'sent_at ungueltig');
  perform public.update_workspace_invoice_sent(ws, 'inv-15-ok', '2026-10-06', 'post', null);
  begin
    r := public.finalize_workspace_invoice(ws, 'v-15', 'inv-15-ok', pg_temp.beleg('rechnung', 1, 100, 100,
      '{"servicePeriodFrom":"2026-10-01","servicePeriodTo":"2026-10-03"}'::jsonb));
  exception when others then
    raise exception 'SQL-18: Wiederholung nach Versandvermerk abgewiesen: %', sqlerrm;
  end;
  if (r->>'idempotent_replay')::boolean is distinct from true then
    raise exception 'SQL-18: Wiederholung nach Versandvermerk kein Replay: %', r;
  end if;
  raise notice 'OK  SQL-15/SQL-18: Datumsregeln; Wiederholung nach Versandvermerk bleibt eine Wiederholung';

  /* ---------------------------------------------------------------- */
  /* SQL-10 / ANG-15 — Angebotssummen, Auftrag aus Angebot             */
  /* ---------------------------------------------------------------- */
  perform pg_temp.erwarte_fehler('SQL-10c Angebotssumme passt nicht zu den Positionen',
    $q$select public.finalize_workspace_offer('00000000-0000-0000-0000-00000000fc04', 'off-falsch',
         '{"customer":{"name":"Muster GmbH"},"title":"Dach","validUntil":"2026-11-30","offerDate":"2026-10-11","taxStatus":"standard_19",
           "positions":[{"id":"p1","description":"Dach","quantity":2,"unit":"Stück","unitPrice":100}],
           "totals":{"subtotal":100,"taxRate":19,"tax":19,"total":119}}'::jsonb, 'fp-f', 0)$q$,
    'Summen passen nicht');
  -- Centpreis wie im Client: 3 x 0,045 EUR ist 3 x 0,05 = 0,15 netto, 0,03 Steuer.
  perform public.finalize_workspace_offer(ws, 'off-cent',
    '{"customer":{"name":"Muster GmbH"},"title":"Schrauben","validUntil":"2026-11-30","offerDate":"2026-10-11","taxStatus":"standard_19",
      "positions":[{"id":"p1","description":"Schrauben","quantity":3,"unit":"Stück","unitPrice":0.045}],
      "totals":{"subtotal":0.15,"taxRate":19,"tax":0.03,"total":0.18}}'::jsonb, 'fp-c', 0);
  -- Ein Altangebot (freigegeben vor dieser Pruefung) kann eine falsche Summe tragen; der Auftrag rechnet selbst.
  update public.workspace_offers
  set payload = jsonb_set(jsonb_set(payload, '{totals,total}', '999'), '{totals,subtotal}', '999')
  where workspace_id = ws and client_offer_id = 'off-cent';
  r := public.accept_workspace_offer(ws, 'off-cent', 'v-aus-angebot', 0);
  if (r->'vorgang'->'payload'->'contractTotals'->>'total')::numeric <> 0.18
     or (r->'vorgang'->'payload'->'contractTotals'->>'subtotal')::numeric <> 0.15 then
    raise exception 'SQL-10d: Auftragssumme nicht aus den Positionen: %', r->'vorgang'->'payload'->'contractTotals';
  end if;
  if r->'vorgang'->>'order_number' not like 'AU-' || public.workspace_vorgang_year(now())::text || '-%' then
    raise exception 'ANG-15: Auftragsnummer % nicht im Geschaeftsjahr', r->'vorgang'->>'order_number';
  end if;
  raise notice 'OK  SQL-10/ANG-15: Angebotssummen geprueft, Auftragssumme aus Positionen (Centpreis), Nummernjahr Europe/Berlin';

  /* ---------------------------------------------------------------- */
  /* ANG-09 — kein Versand eines Angebots im Endzustand                */
  /* ---------------------------------------------------------------- */
  perform public.finalize_workspace_offer(ws, 'off-abgelehnt',
    '{"customer":{"name":"Muster GmbH"},"title":"Fassade","validUntil":"2026-11-30","offerDate":"2026-10-11","taxStatus":"standard_19",
      "positions":[{"id":"p1","description":"Fassade","quantity":1,"unit":"Stück","unitPrice":100}],
      "totals":{"subtotal":100,"taxRate":19,"tax":19,"total":119}}'::jsonb, 'fp-a', 0);
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
  values (ws, 'doc-off-abgelehnt', 'archived_document', '{"classifiedKind":"angebot","linkedOfferId":"off-abgelehnt"}'::jsonb);
  v_delivery := pg_temp.lieferung(ws, 'cd-off-1', 'offer', null, 'doc-off-abgelehnt', 'queued');
  update public.workspace_offers set status = 'abgelehnt' where workspace_id = ws and client_offer_id = 'off-abgelehnt';
  r := public.claim_workspace_document_delivery_for_send(v_delivery, 1);
  if (r->>'claimed')::boolean or r->'delivery'->>'error_code' is distinct from 'offer_not_sendable' then
    raise exception 'ANG-09a: Claim eines abgelehnten Angebots: %', r;
  end if;
  perform pg_temp.erwarte_fehler('ANG-09b Versandauftrag fuer abgelehntes Angebot',
    format($q$select public.create_workspace_document_delivery(%L, 'cd-off-2', 'offer', null, 'kunde@example.invalid',
         'Angebot', 'Text', %L, %L, 1000, 'Angebot.pdf', 'application/pdf', 'stub', null, 'doc-off-abgelehnt', false)$q$,
      ws, ws::text || '/angebote/' || repeat('a', 64) || '.pdf', repeat('a', 64)),
    'offer_not_sendable');
  raise notice 'OK  ANG-09: abgelehntes Angebot weder beim Anlegen noch beim Senden';

  /* ---------------------------------------------------------------- */
  /* SQL-16 — Rechte am Nummernformat                                  */
  /* ---------------------------------------------------------------- */
  if has_function_privilege('authenticated', 'public.format_workspace_invoice_number(uuid, integer, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.format_workspace_invoice_number(uuid, integer, integer)', 'EXECUTE') then
    raise exception 'SQL-16a: Formatfunktion direkt ausfuehrbar';
  end if;
  perform pg_temp.als('00000000-0000-0000-0000-0000000fc002');
  perform pg_temp.erwarte_fehler('SQL-16b Mitglied setzt das Nummernformat',
    $q$select public.set_workspace_invoice_number_format('00000000-0000-0000-0000-00000000fc04', 'X', true, 4, 0)$q$,
    'finance_forbidden_role');
  perform pg_temp.als('00000000-0000-0000-0000-0000000fc001');
  raise notice 'OK  SQL-16: Formatfunktion nur intern, Nummernformat mit Finanzautorisierung';

  /* ---------------------------------------------------------------- */
  /* SQL-17 — Mahnnachweis                                             */
  /* ---------------------------------------------------------------- */
  perform pg_temp.erwarte_fehler('SQL-17a Mahnnachweis mit unbekanntem Weg',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000fc04', 'dunning_documentation',
         '{"documentation_id":"dun-1","invoice_id":"inv-r9-ok","kind":"payment_reminder","delivery_method":"brieftaube","documented_at":"2026-10-08","payload":{}}'::jsonb, 0)$q$,
    'delivery_method');
  perform pg_temp.erwarte_fehler('SQL-17b Mahnnachweis in der Zukunft',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000fc04', 'dunning_documentation',
         jsonb_build_object('documentation_id', 'dun-2', 'invoice_id', 'inv-r9-ok', 'kind', 'payment_reminder',
           'delivery_method', 'post', 'documented_at', %L, 'payload', '{}'::jsonb), 0)$q$, to_char(current_date + 10, 'YYYY-MM-DD')),
    'documented_at');
  r := public.upsert_workspace_sync_entity(ws, 'dunning_documentation',
    '{"documentation_id":"dun-3","invoice_id":"inv-r9-ok","kind":"payment_reminder","delivery_method":"post","documented_at":"2026-10-08","payload":{}}'::jsonb, 0);
  if r->>'entity_id' is distinct from 'dun-3' then raise exception 'SQL-17c: gueltiger Nachweis abgewiesen: %', r; end if;
  raise notice 'OK  SQL-17: Mahnnachweis mit Werteliste und Datumsgrenze';

  /* ---------------------------------------------------------------- */
  /* SQL-08 — Werteliste an der Tabelle (lokaler Bestand ist sauber)   */
  /* ---------------------------------------------------------------- */
  if not exists (select 1 from pg_constraint where conname = 'workspace_invoices_invoice_type_check') then
    raise exception 'SQL-08d: Werteliste der Rechnungsart fehlt';
  end if;
  perform pg_temp.erwarte_fehler('SQL-08e Rechnungsart am Funktionsweg vorbei',
    $q$update public.workspace_invoices set invoice_type = 'Schluss'
       where workspace_id = '00000000-0000-0000-0000-00000000fc04' and client_invoice_id = 'inv-r9-ok'$q$,
    'workspace_invoices_invoice_type_check');
  raise notice 'OK  SQL-08: Werteliste der Rechnungsart an der Tabelle';

  /* ---------------------------------------------------------------- */
  /* ZAH-03 — Bankbewegung mit erfasster Zahlung verknuepfen           */
  /* ---------------------------------------------------------------- */
  insert into public.workspace_bank_accounts (workspace_id, client_account_id, display_name, identifier, payload, created_by, updated_by)
  values (ws, 'bacc-z', 'Konto Z', 'DE00Z', '{"displayName":"Konto Z","identifier":"DE00Z"}'::jsonb, auth.uid(), auth.uid());
  insert into public.workspace_bank_transactions (workspace_id, client_transaction_id, account_key, import_id, file_name, imported_at, booking_date, amount_cents, fingerprint, occurrence, payload, created_by, updated_by)
  values (ws, 'btx-z-1', 'bacc-z', 'bimp-z', 'auszug.csv', now(), '2026-10-05', 6000, 'fp-z-1', 1, '{}'::jsonb, auth.uid(), auth.uid()),
         (ws, 'btx-z-2', 'bacc-z', 'bimp-z', 'auszug.csv', now(), '2026-10-06', 6000, 'fp-z-2', 1, '{}'::jsonb, auth.uid(), auth.uid()),
         (ws, 'btx-z-3', 'bacc-z', 'bimp-z', 'auszug.csv', now(), '2026-10-06', 4100, 'fp-z-3', 1, '{}'::jsonb, auth.uid(), auth.uid()),
         (ws, 'btx-z-4', 'bacc-z', 'bimp-z', 'auszug.csv', now(), '2026-10-06', -4000, 'fp-z-4', 1, '{}'::jsonb, auth.uid(), auth.uid());

  r := public.link_workspace_bank_reconciliation(ws, 'btx-z-1', 'invoice', 'inv-z-1', 'pay-z-1', 'brec-z-1');
  if r->'reconciliation'->>'client_payment_id' is distinct from 'pay-z-1'
     or (r->>'replayed')::boolean
     or (r->'reconciliation'->>'amount_cents')::bigint <> 6000
     or coalesce((r->'reconciliation'->'payload'->>'linkedExistingPayment')::boolean, false) is not true then
    raise exception 'ZAH-03a: Verknuepfung falsch: %', r;
  end if;
  -- Keine zweite Zahlung: weiterhin genau die drei Zahlungen aus SQL-05.
  if (select count(*) from public.workspace_invoice_payments
      where workspace_id = ws and client_invoice_id = 'inv-z-1') <> 3 then
    raise exception 'ZAH-03b: die Verknuepfung hat eine Zahlung angelegt';
  end if;
  r := public.link_workspace_bank_reconciliation(ws, 'btx-z-1', 'invoice', 'inv-z-1', 'pay-z-1', 'brec-z-1');
  if not (r->>'replayed')::boolean then
    raise exception 'ZAH-03c: Wiederholung ist kein Replay: %', r;
  end if;
  perform pg_temp.erwarte_fehler('ZAH-03d Zahlung belegt schon eine Bewegung',
    $q$select public.link_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fc04', 'btx-z-2', 'invoice', 'inv-z-1', 'pay-z-1', 'brec-z-2')$q$,
    'bereits einer Bankbewegung');
  perform pg_temp.erwarte_fehler('ZAH-03e Betrag passt nicht',
    $q$select public.link_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fc04', 'btx-z-3', 'invoice', 'inv-z-1', 'pay-z-3', 'brec-z-3')$q$,
    'passt nicht');
  perform pg_temp.erwarte_fehler('ZAH-03f Falsche Richtung',
    $q$select public.link_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fc04', 'btx-z-4', 'invoice', 'inv-z-1', 'pay-z-3', 'brec-z-4')$q$,
    'Falsche Richtung');
  perform pg_temp.erwarte_fehler('ZAH-03g Unbekannte Zahlung',
    $q$select public.link_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fc04', 'btx-z-2', 'invoice', 'inv-z-1', 'pay-gibt-es-nicht', 'brec-z-5')$q$,
    'Zahlung nicht gefunden');
  perform pg_temp.erwarte_fehler('ZAH-03h Bewegung schon anders zugeordnet',
    $q$select public.link_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fc04', 'btx-z-1', 'invoice', 'inv-z-1', 'pay-z-3', 'brec-z-6')$q$,
    'bereits zugeordnet');
  if has_function_privilege('anon', 'public.link_workspace_bank_reconciliation(uuid, text, text, text, text, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.link_workspace_bank_reconciliation(uuid, text, text, text, text, text)', 'EXECUTE') then
    raise exception 'ZAH-03i: Rechte der Verknuepfungsfunktion falsch';
  end if;
  -- Storno der Zahlung gibt die Bewegung frei (BANKABGLEICH BLOCK 5): dieselbe Zeile, dieselbe Regel.
  perform public.reverse_workspace_invoice_payment(ws, 'inv-z-1', 'pay-z-1');
  if exists (select 1 from public.workspace_bank_reconciliations
             where workspace_id = ws and bank_transaction_id = 'btx-z-1') then
    raise exception 'ZAH-03j: Storno der Zahlung hat die Bewegung nicht freigegeben';
  end if;
  -- Eine stornierte Zahlung laesst sich nicht verknuepfen.
  perform pg_temp.erwarte_fehler('ZAH-03k Stornierte Zahlung',
    $q$select public.link_workspace_bank_reconciliation('00000000-0000-0000-0000-00000000fc04', 'btx-z-1', 'invoice', 'inv-z-1', 'pay-z-1', 'brec-z-7')$q$,
    'Zahlung storniert');
  raise notice 'OK  ZAH-03: Verknuepfung ohne zweite Zahlung, Replay, Eindeutigkeit je Zahlung und Bewegung, Betrag, Richtung, Rechte, Freigabe beim Storno';

  /* ---------------------------------------------------------------- */
  /* AUS-19 — manueller Vermerk nach OfficeTakt-Versand                */
  /* ---------------------------------------------------------------- */
  if (select wi.sent_source from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-4') is distinct from 'officepilot' then
    raise exception 'AUS-19a: Ausgangslage ohne OfficeTakt-Versand';
  end if;
  -- Dieselben Daten (Abgleich, Wiederholung): die Herkunft bleibt.
  perform public.update_workspace_invoice_sent(ws, 'inv-d-4', pg_temp.heute(), 'email', null);
  if (select wi.sent_source from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-4') is distinct from 'officepilot' then
    raise exception 'AUS-19b: Wiederholung hat die Herkunft geaendert';
  end if;
  -- Abweichend (per Post nach Ruecklauf): manuell, Datum und Weg wie vermerkt.
  perform public.update_workspace_invoice_sent(ws, 'inv-d-4', pg_temp.heute(), 'post', 'nach Ruecklauf per Post');
  if (select wi.sent_source from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-4') is distinct from 'manual'
     or (select wi.payload->>'sentSource' from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-4') is distinct from 'manual'
     or (select wi.payload->>'sentVia' from public.workspace_invoices wi where wi.workspace_id = ws and wi.client_invoice_id = 'inv-d-4') is distinct from 'post' then
    raise exception 'AUS-19c: abweichender manueller Vermerk nicht als manuell gefuehrt';
  end if;
  raise notice 'OK  AUS-19: Wiederholung behaelt OfficeTakt, abweichender Vermerk ist manuell';

  /* ---------------------------------------------------------------- */
  /* N03 — nur endliche Geldbetraege (WEISS-Nacharbeit)                */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-n03', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n03', 'inv-n03', pg_temp.beleg('rechnung', 1, 100, 100));
  perform pg_temp.erwarte_fehler('N03a NaN ohne Bestaetigung',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-n03', 'pay-n03-a', 'NaN'::numeric, '2026-10-05', null, null, 'bank', false)$q$,
    'amount ungueltig');
  perform pg_temp.erwarte_fehler('N03b NaN mit Bestaetigung',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-n03', 'pay-n03-b', 'NaN'::numeric, '2026-10-05', null, null, 'bank', true)$q$,
    'amount ungueltig');
  perform pg_temp.erwarte_fehler('N03c Unendlich mit Bestaetigung',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-n03', 'pay-n03-c', 'Infinity'::numeric, '2026-10-05', null, null, 'bank', true)$q$,
    'amount ungueltig');
  perform pg_temp.erwarte_fehler('N03d minus unendlich',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-n03', 'pay-n03-d', '-Infinity'::numeric, '2026-10-05', null, null, 'bank', false)$q$,
    'amount ungueltig');
  perform pg_temp.erwarte_fehler('N03e unter einem halben Cent',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fc04', 'inv-n03', 'pay-n03-e', 0.004, '2026-10-05', null, null, 'bank', true)$q$,
    'amount ungueltig');
  -- Endliche, centgenaue Betraege gehen weiter durch -- auch der kleinste.
  perform public.add_workspace_invoice_payment(ws, 'inv-n03', 'pay-n03-f', 0.01, '2026-10-05', null, null, 'bank');
  perform public.add_workspace_invoice_payment(ws, 'inv-n03', 'pay-n03-g', 99.99, '2026-10-05', null, null, 'bank');
  if (select sum(p.amount) from public.workspace_invoice_payments p
      where p.workspace_id = ws and p.client_invoice_id = 'inv-n03' and p.reversed_at is null) is distinct from 100.00
     or exists (select 1 from public.workspace_invoice_payments p
                where p.workspace_id = ws and p.client_invoice_id = 'inv-n03'
                  and p.client_payment_id in ('pay-n03-a', 'pay-n03-b', 'pay-n03-c', 'pay-n03-d', 'pay-n03-e')) then
    raise exception 'N03f: Zahlungssumme falsch oder ungueltiger Betrag gespeichert';
  end if;

  -- Ausgabenzahlung: dieselbe Luecke, dieselbe Pruefung.
  insert into public.workspace_expenses (workspace_id, client_expense_id, status, dedupe_key, payload, deleted, row_version, created_by)
  values (ws, 'e-n03', 'gebucht', 'e-n03',
          '{"id":"e-n03","category":"material","supplierName":"N03 GmbH","title":"N03","issueDate":"2026-10-05","netAmount":10,"taxAmount":1.9,"grossAmount":11.9,"taxStatus":"standard_19"}'::jsonb,
          false, 1, '00000000-0000-0000-0000-0000000fc001');
  perform pg_temp.erwarte_fehler('N03g Ausgabenzahlung NaN',
    $q$select public.add_workspace_expense_payment('00000000-0000-0000-0000-00000000fc04', 'e-n03', 'epay-n03-a', 'NaN'::numeric, '2026-10-05', null, null, 'bank')$q$,
    'amount ungueltig');
  perform pg_temp.erwarte_fehler('N03h Ausgabenzahlung unendlich',
    $q$select public.add_workspace_expense_payment('00000000-0000-0000-0000-00000000fc04', 'e-n03', 'epay-n03-b', 'Infinity'::numeric, '2026-10-05', null, null, 'bank')$q$,
    'amount ungueltig');
  perform public.add_workspace_expense_payment(ws, 'e-n03', 'epay-n03-c', 11.90, '2026-10-05', null, null, 'bank');
  if (select count(*) from public.workspace_expense_payments p where p.workspace_id = ws and p.client_expense_id = 'e-n03') <> 1 then
    raise exception 'N03i: Ausgabenzahlung falsch gespeichert';
  end if;

  -- Auftrag: der Text "Infinity" ist keine Menge und kein Preis.
  perform pg_temp.erwarte_fehler('N03j Auftrag mit unendlicher Menge',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000fc04', 'v-n03-inf', pg_temp.auftrag() || '{"positions":[{"id":"cp1","description":"Montagestunden","plannedQuantity":"Infinity","unit":"Stück","unitPrice":100}]}'::jsonb)$q$,
    'ungueltige Mengen oder Preise');
  perform pg_temp.erwarte_fehler('N03k Auftrag mit unendlichem Preis',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000fc04', 'v-n03-inf', pg_temp.auftrag() || '{"positions":[{"id":"cp1","description":"Montagestunden","plannedQuantity":1,"unit":"Stück","unitPrice":"Infinity"}]}'::jsonb)$q$,
    'ungueltige Mengen oder Preise');
  raise notice 'OK  N03: NaN und unendlich (mit und ohne Bestaetigung), Betrag unter einem halben Cent abgewiesen; 0,01 und 99,99 gespeichert; Ausgabe und Auftrag ebenso';

  /* ---------------------------------------------------------------- */
  /* N02 — Schlussrechnung zieht nur beglichene Abschlaege ab          */
  /* ---------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-n02', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02', 'inv-n02-ab',
    pg_temp.beleg('abschlag', 0, 476, 476, '{"calculationMode":"fixed_amount","fixedAmountNet":476,"abschlagNumber":1}'::jsonb));
  perform pg_temp.erwarte_fehler('N02a unbezahlter Abschlag',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02', 'inv-n02-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9524, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02-ab","amount":476}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02-ab', 'pay-n02-1', 200, '2026-10-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('N02b teilbezahlter Abschlag',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02', 'inv-n02-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9524, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02-ab","amount":476}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02-ab', 'pay-n02-2', 276, '2026-10-06', null, null, 'bank');
  perform public.reverse_workspace_invoice_payment(ws, 'inv-n02-ab', 'pay-n02-2');
  perform pg_temp.erwarte_fehler('N02c zurueckgenommene Zahlung zaehlt nicht',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02', 'inv-n02-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9524, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02-ab","amount":476}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  if exists (select 1 from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-n02-schluss') then
    raise exception 'N02d: abgewiesene Schlussrechnung hat eine Zeile hinterlassen';
  end if;
  perform public.add_workspace_invoice_payment(ws, 'inv-n02-ab', 'pay-n02-3', 276, '2026-10-06', null, null, 'bank');
  r := public.finalize_workspace_invoice(ws, 'v-n02', 'inv-n02-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9524, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02-ab","amount":476}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric is distinct from 9524 then
    raise exception 'N02e: voll bezahlter Abschlag nicht abgezogen: %', r->'invoice'->>'amount';
  end if;

  -- Skontosatz im Abschlag: 98 % beglichen reicht, 90 % nicht.
  perform public.create_workspace_order(ws, 'v-n02s', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02s', 'inv-n02s-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"skontoText":"2 % Skonto bei Zahlung innerhalb von 10 Tagen"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-n02s-ab', 'pay-n02s-1', 450, '2026-10-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('N02f Skontosatz, aber nur 90 % gezahlt',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02s-ab', 'pay-n02s-2', 40, '2026-10-05', null, null, 'bank');
  -- WEISS-Recheck N02-R1: 98 % fristgerecht -- die Schlussrechnung muss gezahlt und Skonto getrennt nennen.
  perform pg_temp.erwarte_fehler('N02h Skonto ohne Aufteilung (direkter Aufruf, alter Client)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  perform pg_temp.erwarte_fehler('N02i Skonto als voll gezahlt ausgegeben',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500,"paidAmount":500,"skontoAmount":0}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  perform pg_temp.erwarte_fehler('N02j nur der gezahlte Teil angegeben',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500,"paidAmount":490}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  perform pg_temp.erwarte_fehler('N02k Aufteilung als Text',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500,"paidAmount":"490","skontoAmount":"10"}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  perform pg_temp.erwarte_fehler('N02v nur der gezahlte Teil falsch (480 statt 490)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500,"paidAmount":480,"skontoAmount":10}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  perform pg_temp.erwarte_fehler('N02w nur der Skontoteil falsch (5 statt 10)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02s', 'inv-n02s-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500,"paidAmount":490,"skontoAmount":5}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  r := public.finalize_workspace_invoice(ws, 'v-n02s', 'inv-n02s-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02s-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric is distinct from 9500
     or (r->'invoice'->'previousAbschlagDeductions'->0->>'paidAmount')::numeric is distinct from 490
     or (r->'invoice'->'previousAbschlagDeductions'->0->>'skontoAmount')::numeric is distinct from 10 then
    raise exception 'N02l: Schlussrechnung mit Skonto-Aufteilung falsch gespeichert: %', r->'invoice';
  end if;

  -- WEISS-Recheck N02-R2: Skonto nur bei Zahlung bis zum Fristende (Rechnungsdatum + Tage).
  perform public.create_workspace_order(ws, 'v-n02l', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02l', 'inv-n02l-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01","skontoText":"2 % Skonto bei Zahlung innerhalb von 10 Tagen"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-n02l-ab', 'pay-n02l-1', 490, '2026-10-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('N02m Skonto erst nach Fristablauf (mit Aufteilung)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02l', 'inv-n02l-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02l-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  perform pg_temp.erwarte_fehler('N02n Skonto erst nach Fristablauf (ohne Aufteilung)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02l', 'inv-n02l-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02l-ab","amount":500}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02l-ab', 'pay-n02l-2', 10, '2026-10-06', null, null, 'bank');
  r := public.finalize_workspace_invoice(ws, 'v-n02l', 'inv-n02l-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02l-ab","amount":500,"paidAmount":500,"skontoAmount":0}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric is distinct from 9500 then
    raise exception 'N02o: nachgezahlter Abschlag nicht abgezogen: %', r->'invoice'->>'amount';
  end if;

  -- Teilzahlung vor der Frist, Rest danach: das Skonto gilt nicht, es fehlt der Rest.
  perform public.create_workspace_order(ws, 'v-n02p', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02p', 'inv-n02p-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-20","skontoText":"2 % Skonto bei Zahlung innerhalb von 10 Tagen"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-n02p-ab', 'pay-n02p-1', 300, '2026-09-25', null, null, 'bank');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02p-ab', 'pay-n02p-2', 190, '2026-10-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('N02p 300 in der Frist, 190 danach',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02p', 'inv-n02p-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02p-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  -- Eine Teilzahlung in der Frist, die zusammen mit einer zweiten (ebenfalls in der Frist) 98 % erreicht, genügt.
  perform public.create_workspace_order(ws, 'v-n02q', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02q', 'inv-n02q-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-20","skontoText":"2 % Skonto bei Zahlung innerhalb von 10 Tagen"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-n02q-ab', 'pay-n02q-1', 300, '2026-09-25', null, null, 'bank');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02q-ab', 'pay-n02q-2', 190, '2026-09-30', null, null, 'bank');
  -- Rücknahme der zweiten Zahlung: wieder offen.
  perform public.reverse_workspace_invoice_payment(ws, 'inv-n02q-ab', 'pay-n02q-2');
  perform pg_temp.erwarte_fehler('N02q zurueckgenommene fristgerechte Zahlung',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02q', 'inv-n02q-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02q-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');
  perform public.add_workspace_invoice_payment(ws, 'inv-n02q-ab', 'pay-n02q-3', 190, '2026-09-29', null, null, 'bank');
  r := public.finalize_workspace_invoice(ws, 'v-n02q', 'inv-n02q-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02q-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric is distinct from 9500 then
    raise exception 'N02r: fristgerechte Teilzahlungen nicht anerkannt: %', r->'invoice'->>'amount';
  end if;

  -- Voll bezahlt: die Aufteilung darf fehlen; ist sie da, muss sie stimmen.
  perform public.create_workspace_order(ws, 'v-n02v', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02v', 'inv-n02v-ab',
    pg_temp.beleg('abschlag', 0, 300, 300, '{"calculationMode":"fixed_amount","fixedAmountNet":300,"abschlagNumber":1}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-n02v-ab', 'pay-n02v-1', 300, '2026-10-05', null, null, 'bank');
  perform pg_temp.erwarte_fehler('N02s voll bezahlt, aber Skonto behauptet',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fc04', 'v-n02v', 'inv-n02v-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9700, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02v-ab","amount":300,"paidAmount":295,"skontoAmount":5}]}'::jsonb))$q$,
    'invoice_abschlag_settlement_mismatch');
  r := public.finalize_workspace_invoice(ws, 'v-n02v', 'inv-n02v-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9700, '{"previousAbschlagDeductions":[{"invoiceId":"inv-n02v-ab","amount":300,"paidAmount":300,"skontoAmount":0}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric is distinct from 9700 then
    raise exception 'N02t: voll bezahlter Abschlag mit Aufteilung falsch: %', r->'invoice'->>'amount';
  end if;

  -- Die Lesart des Skontotexts entspricht dem Client.
  if (select count(*) from public.workspace_skonto_terms('2 % Skonto bei Zahlung innerhalb von 10 Tagen') t where t.pct = 2 and t.days = 10) <> 1
     or (select count(*) from public.workspace_skonto_terms('Innerhalb von 14 Tagen 3,5 % Skonto') t where t.pct = 3.5 and t.days = 14) <> 1
     or (select count(*) from public.workspace_skonto_terms('2 % Skonto' || chr(10) || 'innerhalb von 10 Tagen')) <> 0
     or (select count(*) from public.workspace_skonto_terms('2 % Skonto ohne Frist')) <> 0
     or (select count(*) from public.workspace_skonto_terms(null)) <> 0
     or public.workspace_safe_date('2026-02-30') is not null
     or public.workspace_safe_date('kein Datum') is not null
     or public.workspace_safe_date('2026-09-01T10:00:00Z') is distinct from date '2026-09-01' then
    raise exception 'N02u: Lesart von Skontotext oder Datum weicht ab';
  end if;

  -- Ein stornierter unbezahlter Abschlag wird nicht abgezogen; die Schlussrechnung berechnet alles.
  perform public.create_workspace_order(ws, 'v-n02c', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-n02c', 'inv-n02c-ab',
    pg_temp.beleg('abschlag', 0, 300, 300, '{"calculationMode":"fixed_amount","fixedAmountNet":300,"abschlagNumber":1}'::jsonb));
  perform public.cancel_workspace_invoice(ws, 'inv-n02c-ab', 'Kunde zahlt den Abschlag nicht');
  r := public.finalize_workspace_invoice(ws, 'v-n02c', 'inv-n02c-schluss', pg_temp.beleg('schluss', 100, 10000, 10000));
  if (r->'invoice'->>'amount')::numeric is distinct from 10000 then
    raise exception 'N02g: Schlussrechnung nach Storno des Abschlags falsch: %', r->'invoice'->>'amount';
  end if;
  raise notice 'OK  N02: unbezahlt, teilbezahlt, zurueckgenommen abgewiesen; voll bezahlt und Skonto im Satz abgezogen; stornierter Abschlag nicht abgezogen';
  raise notice 'OK  N02-R1/R2: Skonto nur in der Frist (verspaetet, Teilzahlung vor/nach Frist, Ruecknahme); Aufteilung gezahlt/Skonto verpflichtend und gegen Zahlungen geprueft; Lesart wie im Client';

  /* ---------------------------------------------------------------- */
  /* N06 — bestaetigte Kontierung nur mit geklaerter Steuer           */
  /* N09 — der Server haelt je Beleg genau eine aktive Kontierung      */
  /* ---------------------------------------------------------------- */
  perform pg_temp.erwarte_fehler('N06a bestaetigt mit unklarer Steuer',
    $q$select public.upsert_workspace_accounting_assignment('00000000-0000-0000-0000-00000000fc04',
         '{"client_assignment_id":"acc-n06-a","source_type":"expense","source_id":"e-n03","payload":{"status":"confirmed","origin":"manual","chartOfAccounts":"SKR03","accountNumber":"4980","accountLabel":"Material","taxTreatment":"unclear","bookingText":"N06","confirmedAt":"2026-10-12T08:00:00Z"}}'::jsonb, 0)$q$,
    'accounting_confirmed_without_tax');
  perform pg_temp.erwarte_fehler('N06b bestaetigt ohne Steuerangabe',
    $q$select public.upsert_workspace_accounting_assignment('00000000-0000-0000-0000-00000000fc04',
         '{"client_assignment_id":"acc-n06-a","source_type":"expense","source_id":"e-n03","payload":{"status":"confirmed","origin":"manual","chartOfAccounts":"SKR03","accountNumber":"4980","accountLabel":"Material","bookingText":"N06","confirmedAt":"2026-10-12T08:00:00Z"}}'::jsonb, 0)$q$,
    'accounting_confirmed_without_tax');
  -- Zu pruefen darf "unklar" bleiben; bestaetigt mit geklaerter Steuer geht durch.
  perform public.upsert_workspace_accounting_assignment(ws,
    '{"client_assignment_id":"acc-n06-a","source_type":"expense","source_id":"e-n03","payload":{"status":"needs_review","origin":"suggested","chartOfAccounts":"SKR03","accountNumber":"","accountLabel":"","taxTreatment":"unclear","bookingText":"N06"}}'::jsonb, 0);
  perform public.upsert_workspace_accounting_assignment(ws,
    '{"client_assignment_id":"acc-n06-a","source_type":"expense","source_id":"e-n03","payload":{"status":"confirmed","origin":"manual","chartOfAccounts":"SKR03","accountNumber":"4980","accountLabel":"Material","taxTreatment":"standard_19","bookingText":"N06","confirmedAt":"2026-10-12T08:00:00Z"}}'::jsonb, 1);
  if (select a.payload->>'status' from public.workspace_accounting_assignments a
      where a.workspace_id = ws and a.client_assignment_id = 'acc-n06-a') is distinct from 'confirmed' then
    raise exception 'N06c: bestaetigte Kontierung mit geklaerter Steuer nicht gespeichert';
  end if;
  raise notice 'OK  N06: bestaetigt nur mit geklaerter Steuer; zu pruefen darf unklar bleiben';

  perform pg_temp.erwarte_fehler('N09a zweite aktive Kontierung fuer denselben Beleg',
    $q$select public.upsert_workspace_accounting_assignment('00000000-0000-0000-0000-00000000fc04',
         '{"client_assignment_id":"acc-n09-zweite","source_type":"expense","source_id":"e-n03","payload":{"status":"needs_review","origin":"suggested","chartOfAccounts":"SKR03","accountNumber":"","accountLabel":"","taxTreatment":"standard_19","bookingText":"Doppel"}}'::jsonb, 0)$q$,
    'workspace_accounting_assignments_source_unique');
  if (select count(*) from public.workspace_accounting_assignments a
      where a.workspace_id = ws and a.source_type = 'expense' and a.source_id = 'e-n03' and not a.deleted) <> 1 then
    raise exception 'N09b: mehr als eine aktive Kontierung je Beleg';
  end if;
  raise notice 'OK  N09: der Server haelt je Beleg genau eine aktive Kontierung';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
