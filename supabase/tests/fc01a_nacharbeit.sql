-- FC01A-NACHARBEIT -- Serververtraege der Nacharbeit nach der Veroeffentlichung von FINANZ-CORE-01A.
--
--   A2  Keine Ruecknahme einer Abschlagszahlung hinter einer wirksamen Schlussrechnung.
--   A3  Eine Schlussrechnung zieht nur Abschlaege desselben Steuerfalls ab.
--   A4  Skontosatz und Skontofrist gehoeren zusammen (dieselbe Lesart wie im Client;
--       dieselbe Beispieltabelle wie src/services/skontoLesartFc01aNacharbeit.test.ts).
--
-- Setzt die Migration 20261114120000_fc01a_nacharbeit.sql voraus. Ausfuehren (nur lokal,
-- niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_nacharbeit.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles
-- wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fca01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-nach-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-nach-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fca1', 'FC01A-Nacharbeit', '00000000-0000-0000-0000-0000000fca01');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000fca1', '00000000-0000-0000-0000-0000000fca01', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000fca1', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fca01');

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

-- Wie in finanz_core_01a.sql: Kleinunternehmer (Betrag = Netto), Anschrift und Pflichthinweis.
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
        where wi.workspace_id in ('00000000-0000-0000-0000-00000000fca1')
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
    'title', 'FC01A-Nacharbeit', 'baustelle', '', 'taxStatus', p_tax,
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb);
$p$;

-- Pflichtangaben je Steuerfall fuer pg_temp.beleg(..., p_extra).
create function pg_temp.mit19(p_extra jsonb default '{}'::jsonb) returns jsonb language sql immutable as $p$
  select '{"taxStatus":"standard_19","legalNotices":[]}'::jsonb || p_extra;
$p$;
create function pg_temp.mit13b(p_extra jsonb default '{}'::jsonb) returns jsonb language sql immutable as $p$
  select '{"taxStatus":"reverse_charge_13b","legalNotices":["Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG."]}'::jsonb || p_extra;
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fca1';
  r jsonb;
  v_fehler text;
begin
  /* ---------------------------------------------------------------------- */
  /* A2 — Abschlagszahlung erst nach Storno der Schlussrechnung ruecknehmbar */
  /* ---------------------------------------------------------------------- */
  perform public.create_workspace_order(ws, 'v-a2', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-a2', 'inv-a2-ab',
    pg_temp.beleg('abschlag', 0, 200, 200, '{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-a2-ab', 'pay-a2-ab', 200, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-a2', 'inv-a2-teil', pg_temp.beleg('teilrechnung', 2, 200, 200));
  perform public.add_workspace_invoice_payment(ws, 'inv-a2-teil', 'pay-a2-teil', 200, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-a2', 'inv-a2-schluss',
    pg_temp.beleg('schluss', 98, 9800, 9600, '{"previousAbschlagDeductions":[{"invoiceId":"inv-a2-ab","amount":200}]}'::jsonb));

  perform pg_temp.erwarte_fehler('A2a Zahlung eines abgezogenen Abschlags hinter wirksamer Schlussrechnung',
    $q$select public.reverse_workspace_invoice_payment('00000000-0000-0000-0000-00000000fca1', 'inv-a2-ab', 'pay-a2-ab')$q$,
    'invoice_payment_reverse_final_invoice_exists');
  if exists (select 1 from public.workspace_invoice_payments
             where workspace_id = ws and client_payment_id = 'pay-a2-ab' and reversed_at is not null) then
    raise exception 'A2b: abgewiesene Ruecknahme hat die Zahlung dennoch zurueckgenommen';
  end if;
  raise notice 'OK  A2b: die Zahlung bleibt wirksam';

  -- Eine Teilrechnung ist nicht abgezogen: ihre Zahlung bleibt ruecknehmbar (unveraendert).
  perform public.reverse_workspace_invoice_payment(ws, 'inv-a2-teil', 'pay-a2-teil');
  if not exists (select 1 from public.workspace_invoice_payments
                 where workspace_id = ws and client_payment_id = 'pay-a2-teil' and reversed_at is not null) then
    raise exception 'A2c: Zahlung einer nicht abgezogenen Teilrechnung nicht ruecknehmbar';
  end if;
  raise notice 'OK  A2c: nicht abgezogene Rechnung wie bisher';

  -- Erst die Schlussrechnung stornieren, dann geht die Ruecknahme -- und sie ist idempotent.
  perform public.cancel_workspace_invoice(ws, 'inv-a2-schluss', 'Schlussrechnung neu');
  perform public.reverse_workspace_invoice_payment(ws, 'inv-a2-ab', 'pay-a2-ab');
  perform public.reverse_workspace_invoice_payment(ws, 'inv-a2-ab', 'pay-a2-ab');
  if not exists (select 1 from public.workspace_invoice_payments
                 where workspace_id = ws and client_payment_id = 'pay-a2-ab' and reversed_at is not null) then
    raise exception 'A2d: nach Storno der Schlussrechnung nicht ruecknehmbar';
  end if;
  raise notice 'OK  A2d: nach Storno der Schlussrechnung ruecknehmbar, zweiter Aufruf idempotent';

  -- Eine Schlussrechnung OHNE diesen Abschlag als Abzug sperrt ihn nicht (mengenbasierter Abschlag).
  perform public.create_workspace_order(ws, 'v-a2m', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-a2m', 'inv-a2m-ab', pg_temp.beleg('abschlag', 2, 200, 200, '{"abschlagNumber":1}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-a2m-ab', 'pay-a2m-ab', 200, '2026-10-04', null, null, 'bank');
  perform public.finalize_workspace_invoice(ws, 'v-a2m', 'inv-a2m-schluss', pg_temp.beleg('schluss', 98, 9800, 9800));
  perform public.reverse_workspace_invoice_payment(ws, 'inv-a2m-ab', 'pay-a2m-ab');
  raise notice 'OK  A2e: mengenbasierter Abschlag (kein Abzug) bleibt ruecknehmbar';

  -- Rechte wie in der Produktion: nur angemeldete Nutzer, anon ausdruecklich nicht.
  if has_function_privilege('anon', 'public.reverse_workspace_invoice_payment(uuid, text, text)', 'execute') then
    raise exception 'A2f: anon darf reverse_workspace_invoice_payment ausfuehren';
  end if;
  if not has_function_privilege('authenticated', 'public.reverse_workspace_invoice_payment(uuid, text, text)', 'execute') then
    raise exception 'A2f: authenticated darf reverse_workspace_invoice_payment nicht ausfuehren';
  end if;
  raise notice 'OK  A2f: Ruecknahme nur fuer angemeldete Nutzer (anon ohne EXECUTE)';

  /* ---------------------------------------------------------------------- */
  /* A3 — Abschlag und Schlussrechnung im selben Steuerfall                  */
  /* ---------------------------------------------------------------------- */
  -- Ein Vorgang ohne Steuerstatus (wie aus dem Eingang): der Auftrag sperrt nichts.
  perform public.create_workspace_order(ws, 'v-a3', pg_temp.auftrag('standard_19'));
  update public.workspace_vorgaenge set payload = payload - 'taxStatus' where workspace_id = ws and vorgang_id = 'v-a3';
  perform public.finalize_workspace_invoice(ws, 'v-a3', 'inv-a3-ab',
    pg_temp.beleg('abschlag', 0, 200, 238, pg_temp.mit19('{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb)));
  perform public.add_workspace_invoice_payment(ws, 'inv-a3-ab', 'pay-a3-ab', 238, '2026-10-04', null, null, 'bank');
  perform pg_temp.erwarte_fehler('A3a Abschlag 19 %, Schlussrechnung nach 13b',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fca1', 'v-a3', 'inv-a3-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9762, pg_temp.mit13b('{"previousAbschlagDeductions":[{"invoiceId":"inv-a3-ab","amount":238}]}'::jsonb)))$q$,
    'invoice_abschlag_tax_status_mismatch');
  perform pg_temp.erwarte_fehler('A3b Abschlag 19 %, Schlussrechnung Kleinunternehmer',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fca1', 'v-a3', 'inv-a3-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9762, '{"previousAbschlagDeductions":[{"invoiceId":"inv-a3-ab","amount":238}]}'::jsonb))$q$,
    'invoice_abschlag_tax_status_mismatch');
  if exists (select 1 from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-a3-schluss') then
    raise exception 'A3c: abgewiesene Schlussrechnung hat eine Zeile hinterlassen';
  end if;
  r := public.finalize_workspace_invoice(ws, 'v-a3', 'inv-a3-schluss',
    pg_temp.beleg('schluss', 100, 10000, 11662, pg_temp.mit19('{"previousAbschlagDeductions":[{"invoiceId":"inv-a3-ab","amount":238}]}'::jsonb)));
  if (r->'invoice'->>'amount')::numeric is distinct from 11662 then
    raise exception 'A3d: gleicher Steuerfall abgewiesen oder falsch: %', r->'invoice'->>'amount';
  end if;
  raise notice 'OK  A3d: gleicher Steuerfall wie bisher';

  -- Umgekehrt: Abschlag nach 13b, Schlussrechnung mit 19 %.
  perform public.create_workspace_order(ws, 'v-a3r', pg_temp.auftrag('standard_19'));
  update public.workspace_vorgaenge set payload = payload - 'taxStatus' where workspace_id = ws and vorgang_id = 'v-a3r';
  perform public.finalize_workspace_invoice(ws, 'v-a3r', 'inv-a3r-ab',
    pg_temp.beleg('abschlag', 0, 200, 200, pg_temp.mit13b('{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb)));
  perform public.add_workspace_invoice_payment(ws, 'inv-a3r-ab', 'pay-a3r-ab', 200, '2026-10-04', null, null, 'bank');
  perform pg_temp.erwarte_fehler('A3e Abschlag 13b, Schlussrechnung 19 %',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fca1', 'v-a3r', 'inv-a3r-schluss',
         pg_temp.beleg('schluss', 100, 10000, 11700, pg_temp.mit19('{"previousAbschlagDeductions":[{"invoiceId":"inv-a3r-ab","amount":200}]}'::jsonb)))$q$,
    'invoice_abschlag_tax_status_mismatch');

  -- Altbestand ohne Steuerstatus am Abschlag: Steuer ja/nein muss zum Satz passen.
  perform public.create_workspace_order(ws, 'v-a3alt', pg_temp.auftrag('standard_19'));
  update public.workspace_vorgaenge set payload = payload - 'taxStatus' where workspace_id = ws and vorgang_id = 'v-a3alt';
  perform public.finalize_workspace_invoice(ws, 'v-a3alt', 'inv-a3alt-ab',
    pg_temp.beleg('abschlag', 0, 200, 238, pg_temp.mit19('{"calculationMode":"fixed_amount","fixedAmountNet":200,"abschlagNumber":1}'::jsonb)));
  perform public.add_workspace_invoice_payment(ws, 'inv-a3alt-ab', 'pay-a3alt-ab', 238, '2026-10-04', null, null, 'bank');
  update public.workspace_invoices set payload = payload - 'taxStatus' where workspace_id = ws and client_invoice_id = 'inv-a3alt-ab';
  perform pg_temp.erwarte_fehler('A3f Altbestand mit Steuer, Schlussrechnung nach 13b',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fca1', 'v-a3alt', 'inv-a3alt-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9762, pg_temp.mit13b('{"previousAbschlagDeductions":[{"invoiceId":"inv-a3alt-ab","amount":238}]}'::jsonb)))$q$,
    'invoice_abschlag_tax_status_mismatch');
  r := public.finalize_workspace_invoice(ws, 'v-a3alt', 'inv-a3alt-schluss',
    pg_temp.beleg('schluss', 100, 10000, 11662, pg_temp.mit19('{"previousAbschlagDeductions":[{"invoiceId":"inv-a3alt-ab","amount":238}]}'::jsonb)));
  if (r->'invoice'->>'amount')::numeric is distinct from 11662 then
    raise exception 'A3g: Altbestand mit passender Steuer abgewiesen: %', r->'invoice'->>'amount';
  end if;
  raise notice 'OK  A3g: Altbestand mit passender Steuer wie bisher';

  /* ---------------------------------------------------------------------- */
  /* A4 — Skontolesart (dieselbe Tabelle wie im Client) und ihre Wirkung     */
  /* ---------------------------------------------------------------------- */
  select string_agg(format('%L -> erwartet %s/%s, gelesen %s/%s', b.text, b.pct, b.days, t.pct, t.days), '; ')
  into v_fehler
  from (values
    ('Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.', 2::numeric, 10),
    ('Bei Zahlung innerhalb von 1 Tag gewähren wir 2 % Skonto.', 2, 1),
    ('3 % Skonto bei Zahlung innerhalb von 10 Tagen', 3, 10),
    ('2,5 % Skonto bei Zahlung innerhalb von 14 Tagen', 2.5, 14),
    ('Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, sonst 30 Tage netto', 2, 10),
    ('30 Tage netto, 10 Tage 2 % Skonto', 2, 10),
    ('Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto. Zahlbar innerhalb von 30 Tagen ohne Abzug.', 2, 10),
    ('Zahlungsziel 30 Tage, bei Zahlung innerhalb 8 Tagen 3 % Skonto', 3, 8),
    ('Skonto: 2 % innerhalb von 8 Tagen, Zahlungsziel: 30 Tage netto', 2, 8),
    ('Zahlbar innerhalb 30 Tagen ohne Abzug oder innerhalb 10 Tagen mit 3 % Skonto', 3, 10),
    ('Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, bei Zahlung innerhalb von 20 Tagen 1 % Skonto', 2, 10),
    ('2' || chr(160) || '% Skonto bei Zahlung innerhalb von 10' || chr(160) || 'Tagen', 2, 10),
    ('Zahlbar innerhalb 30 Tagen netto.' || chr(10) || 'Bei Zahlung innerhalb 10 Tagen 2 % Skonto.', 2, 10),
    ('14 Tage netto, 2,5 % Skonto', null, null),
    ('Zahlungsziel 30 Tage, 2 % Skonto', null, null),
    ('2 % Skonto.' || chr(10) || 'Zahlbar innerhalb von 30 Tagen.', null, null),
    ('Zahlbar innerhalb von 30 Tagen. 2 % Skonto.', null, null),
    ('Bei Zahlung bis zum 15.10.2026 2 % Skonto', null, null),
    ('Tagung am Montag, 2 % Rabatt', null, null),
    ('2 % Skonto innerhalb 0 Tagen', null, null),
    ('0 % Skonto innerhalb 10 Tagen', null, null),
    ('2 %', null, null),
    ('10 Tage', null, null),
    ('', null, null)
  ) as b(text, pct, days)
  left join lateral public.workspace_skonto_terms(b.text) t on true
  where t.pct is distinct from b.pct or t.days is distinct from b.days;
  if v_fehler is not null then
    raise exception 'A4a: Lesart weicht vom Client ab: %', v_fehler;
  end if;
  if (select count(*) from public.workspace_skonto_terms(null)) <> 0 then
    raise exception 'A4a: null-Text ergibt ein Skonto';
  end if;
  raise notice 'OK  A4a: 24 Beispiele wie im Client';

  -- Wirkung: "10 Tagen 2 % Skonto, sonst 30 Tage netto" -- eine Zahlung am 19. Tag ist kein Skonto.
  perform public.create_workspace_order(ws, 'v-a4', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-a4', 'inv-a4-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01","skontoText":"Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, sonst 30 Tage netto"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-a4-ab', 'pay-a4-ab', 490, '2026-09-20', null, null, 'bank');
  perform pg_temp.erwarte_fehler('A4b 98 % am 19. Tag bei 10 Tagen Skontofrist (Nettofrist 30 Tage)',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fca1', 'v-a4', 'inv-a4-schluss',
         pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-a4-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb))$q$,
    'invoice_abschlag_unpaid');

  perform public.create_workspace_order(ws, 'v-a4f', pg_temp.auftrag());
  perform public.finalize_workspace_invoice(ws, 'v-a4f', 'inv-a4f-ab',
    pg_temp.beleg('abschlag', 0, 500, 500, '{"calculationMode":"fixed_amount","fixedAmountNet":500,"abschlagNumber":1,"issueDate":"2026-09-01","skontoText":"Bei Zahlung innerhalb von 10 Tagen 2 % Skonto, sonst 30 Tage netto"}'::jsonb));
  perform public.add_workspace_invoice_payment(ws, 'inv-a4f-ab', 'pay-a4f-ab', 490, '2026-09-08', null, null, 'bank');
  r := public.finalize_workspace_invoice(ws, 'v-a4f', 'inv-a4f-schluss',
    pg_temp.beleg('schluss', 100, 10000, 9500, '{"previousAbschlagDeductions":[{"invoiceId":"inv-a4f-ab","amount":500,"paidAmount":490,"skontoAmount":10}]}'::jsonb));
  if (r->'invoice'->>'amount')::numeric is distinct from 9500 then
    raise exception 'A4c: fristgerechtes Skonto (8. Tag) nicht anerkannt: %', r->'invoice'->>'amount';
  end if;
  raise notice 'OK  A4c: fristgerechtes Skonto wie bisher';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
