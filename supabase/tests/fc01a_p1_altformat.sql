-- FC01A-P1-RESTKORREKTUR -- #8 Altformat: Netto und Umsatzsteuer jedes Abschlagsabzugs stehen fest.
--
-- WEISS-Recheck zu Bericht 13 (14.10.2026): Ein umsatzsteuerpflichtiger Altabschlag ohne
-- gespeichertes Netto wurde als Abzug angenommen; PDF und E-Rechnung wiesen daraus Brutto als
-- Netto und eine negative Steuer aus. Seit 20261116120000 weist die Freigabe das ab
-- (invoice_abschlag_net_unreliable); steuerfreie Altabschlaege bleiben zulaessig.
--
-- Setzt die Migrationen 20261114120000, 20261115120000 und 20261116120000 voraus. Ausfuehren
-- (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_p1_altformat.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles
-- wird zurueckgerollt. Das Altformat (kein subtotal) entsteht nur im zurueckgerollten Fixture.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fcd01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-p1alt-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-p1alt-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fcd1', 'FC01A-P1 Altformat', '00000000-0000-0000-0000-0000000fcd01');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000fcd1', '00000000-0000-0000-0000-0000000fcd01', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000fcd1', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fcd01');

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

-- Wie in fc01a_p1_nacharbeit.sql (Kleinunternehmer-Grundform; Steuerfall per p_extra).
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
    'title', 'FC01A-P1 Altformat', 'baustelle', '', 'taxStatus', p_tax,
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb);
$p$;

create function pg_temp.steuer(p_tax text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql immutable as $p$
  select case p_tax
    when 'standard_19' then '{"taxStatus":"standard_19","legalNotices":[]}'::jsonb
    when 'standard_7' then '{"taxStatus":"standard_7","legalNotices":[]}'::jsonb
    when 'reverse_charge_13b' then '{"taxStatus":"reverse_charge_13b","legalNotices":["Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG."]}'::jsonb
    else '{}'::jsonb
  end || p_extra;
$p$;

-- Ein Abzug, wie ihn der Client baut: aus dem gespeicherten Abschlag (fehlt dort das Netto, fehlt es hier).
create function pg_temp.abzug(p_inv text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql stable as $p$
  select jsonb_strip_nulls(jsonb_build_object(
    'invoiceId', a.client_invoice_id,
    'invoiceNumber', a.invoice_number,
    'abschlagNumber', a.payload->'abschlagNumber',
    'date', coalesce(a.payload->>'issueDate', a.payload->>'date'),
    'subtotal', a.payload->'subtotal',
    'amount', a.payload->'amount'
  )) || p_extra
  from public.workspace_invoices a
  where a.workspace_id = '00000000-0000-0000-0000-00000000fcd1' and a.client_invoice_id = p_inv;
$p$;

/* Auftrag + Pauschalabschlag (netto/brutto, Steuerfall, optional Skonto) + Zahlung. */
create function pg_temp.abschlag(p_vorgang text, p_tax text, p_netto numeric, p_brutto numeric, p_zahlung numeric, p_tag text, p_skonto boolean)
returns void language plpgsql as $p$
begin
  perform public.create_workspace_order('00000000-0000-0000-0000-00000000fcd1', p_vorgang, pg_temp.auftrag(p_tax));
  perform public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fcd1', p_vorgang, 'inv-' || p_vorgang || '-ab',
    pg_temp.beleg('abschlag', 0, p_netto, p_brutto, pg_temp.steuer(p_tax, jsonb_build_object(
      'calculationMode', 'fixed_amount', 'fixedAmountNet', p_netto, 'abschlagNumber', 1, 'issueDate', '2026-09-01')
      || case when p_skonto then '{"skontoText":"Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto."}'::jsonb else '{}'::jsonb end)));
  perform public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcd1', 'inv-' || p_vorgang || '-ab',
    'pay-' || p_vorgang, p_zahlung, p_tag, null, null, 'bank');
end;
$p$;

/* Schlussrechnung im Steuerfall p_tax: 100 Stunden zu 100 (10.000 netto), Abzug des Abschlags. */
create function pg_temp.schluss(p_vorgang text, p_tax text, p_amount numeric, p_abzug jsonb) returns jsonb language sql as $p$
  select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fcd1', p_vorgang, 'inv-' || p_vorgang || '-schluss',
    pg_temp.beleg('schluss', 100, 10000, p_amount,
      pg_temp.steuer(p_tax, jsonb_build_object('previousAbschlagDeductions', jsonb_build_array(p_abzug)))));
$p$;

create function pg_temp.altformat(p_vorgang text) returns void language sql as $p$
  update public.workspace_invoices set payload = payload - 'subtotal'
  where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-' || p_vorgang || '-ab';
$p$;

do $$
declare
  r jsonb;
begin
  /* AF1 — WEISS-Nachstellung wörtlich: 19 %, 400/476, 2 % Skonto, 466,48 am 8. Tag, Altformat ohne Netto. */
  perform pg_temp.abschlag('af1', 'standard_19', 400, 476, 466.48, '2026-09-08', true);
  perform pg_temp.altformat('af1');
  perform pg_temp.erwarte_fehler('AF1 WEISS: 19 %, Skonto, Altabschlag ohne Netto',
    $q$select pg_temp.schluss('af1', 'standard_19', 11424, pg_temp.abzug('inv-af1-ab', '{"paidAmount":466.48,"skontoAmount":9.52}'))$q$,
    'invoice_abschlag_net_unreliable');
  -- Ein Client kann das fehlende Netto nicht nachreichen: Die Angaben müssen die des Abschlags sein (#8).
  perform pg_temp.erwarte_fehler('AF1b Netto 400 im Abzug, Abschlag ohne Netto',
    $q$select pg_temp.schluss('af1', 'standard_19', 11424, pg_temp.abzug('inv-af1-ab', '{"subtotal":400,"paidAmount":466.48,"skontoAmount":9.52}'))$q$,
    'invoice_deductions_mismatch: angaben');
  if exists (select 1 from public.workspace_invoices where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-af1-schluss') then
    raise exception 'AF1c: abgewiesene Schlussrechnung gespeichert';
  end if;
  raise notice 'OK  AF1c: keine Schlussrechnung gespeichert';

  /* AF2 — dasselbe ohne Skonto (voll bezahlt). */
  perform pg_temp.abschlag('af2', 'standard_19', 400, 476, 476, '2026-09-08', false);
  perform pg_temp.altformat('af2');
  perform pg_temp.erwarte_fehler('AF2 19 %, ohne Skonto, Altabschlag ohne Netto',
    $q$select pg_temp.schluss('af2', 'standard_19', 11424, pg_temp.abzug('inv-af2-ab'))$q$,
    'invoice_abschlag_net_unreliable');

  /* AF3 — Gegenkontrolle: derselbe Fall mit gespeichertem Netto wird angenommen (Aufteilung 392,00/74,48 im Client). */
  perform pg_temp.abschlag('af3', 'standard_19', 400, 476, 466.48, '2026-09-08', true);
  r := pg_temp.schluss('af3', 'standard_19', 11424, pg_temp.abzug('inv-af3-ab', '{"paidAmount":466.48,"skontoAmount":9.52}'));
  if (r->'invoice'->'previousAbschlagDeductions'->0->>'subtotal')::numeric is distinct from 400 then
    raise exception 'AF3: Abzug mit Netto nicht wie erwartet gespeichert: %', r->'invoice'->'previousAbschlagDeductions';
  end if;
  raise notice 'OK  AF3: mit gespeichertem Netto angenommen (netto 400, gezahlt 466,48, Skonto 9,52)';

  /* AF4 — steuerfreie Altabschläge ohne Netto bleiben zulässig: § 19 mit und § 13b mit Skonto. */
  perform pg_temp.abschlag('af4k', 'kleinunternehmer_19', 500, 500, 500, '2026-09-05', false);
  perform pg_temp.altformat('af4k');
  r := pg_temp.schluss('af4k', 'kleinunternehmer_19', 9500, pg_temp.abzug('inv-af4k-ab'));
  perform pg_temp.abschlag('af4r', 'reverse_charge_13b', 400, 400, 392, '2026-09-08', true);
  perform pg_temp.altformat('af4r');
  r := pg_temp.schluss('af4r', 'reverse_charge_13b', 9600, pg_temp.abzug('inv-af4r-ab', '{"paidAmount":392,"skontoAmount":8}'));
  raise notice 'OK  AF4: Altabschlag ohne Netto bei § 19 und § 13b (mit Skonto) angenommen — Netto = Brutto';

  /* AF5 — Steuerfall unbekannt (Altbestand ohne Steuerstatus, ohne Netto): nicht aufteilbar. */
  perform pg_temp.abschlag('af5', 'kleinunternehmer_19', 500, 500, 500, '2026-09-05', false);
  update public.workspace_invoices set payload = payload - 'subtotal' - 'taxStatus'
  where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-af5-ab';
  perform pg_temp.erwarte_fehler('AF5 Altabschlag ohne Netto und ohne Steuerstatus',
    $q$select pg_temp.schluss('af5', 'kleinunternehmer_19', 9500, pg_temp.abzug('inv-af5-ab'))$q$,
    'invoice_abschlag_net_unreliable');
  update public.workspace_invoices set payload = payload || '{"taxStatus":"unclear"}'::jsonb
  where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-af5-ab';
  perform pg_temp.erwarte_fehler('AF5b Altabschlag ohne Netto mit Steuerstatus "unklar"',
    $q$select pg_temp.schluss('af5', 'kleinunternehmer_19', 9500, pg_temp.abzug('inv-af5-ab'))$q$,
    'invoice_abschlag_net_unreliable');

  /* AF6 — widersprüchliche Steuerdaten: Netto passt nicht zum Satz. */
  perform pg_temp.abschlag('af6', 'standard_19', 400, 476, 476, '2026-09-08', false);
  update public.workspace_invoices set payload = payload || '{"subtotal":390}'::jsonb
  where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-af6-ab';
  perform pg_temp.erwarte_fehler('AF6 19 %: Netto 390 zu Brutto 476 (Steuer 86 statt 74,10)',
    $q$select pg_temp.schluss('af6', 'standard_19', 11424, pg_temp.abzug('inv-af6-ab'))$q$,
    'invoice_abschlag_net_unreliable');
  perform pg_temp.abschlag('af6k', 'kleinunternehmer_19', 500, 500, 500, '2026-09-05', false);
  update public.workspace_invoices set payload = payload || '{"subtotal":420.17}'::jsonb
  where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-af6k-ab';
  perform pg_temp.erwarte_fehler('AF6k § 19: Netto 420,17 zu Brutto 500 (Steuer ohne Umsatzsteuer)',
    $q$select pg_temp.schluss('af6k', 'kleinunternehmer_19', 9500, pg_temp.abzug('inv-af6k-ab'))$q$,
    'invoice_abschlag_net_unreliable');

  /* AF7 — Cent-Rundung: 333,33 netto, 19 % = 63,33 (63,3327), brutto 396,66; mit Skonto. Ein Cent daneben: Widerspruch. */
  perform pg_temp.abschlag('af7', 'standard_19', 333.33, 396.66, 388.73, '2026-09-08', true);
  r := pg_temp.schluss('af7', 'standard_19', 11503.34, pg_temp.abzug('inv-af7-ab', '{"paidAmount":388.73,"skontoAmount":7.93}'));
  raise notice 'OK  AF7: 333,33 / 396,66 bei 19 %% mit Skonto angenommen (Rundung auf den Cent)';
  perform pg_temp.abschlag('af7b', 'standard_19', 333.33, 396.66, 396.66, '2026-09-08', false);
  update public.workspace_invoices set payload = payload || '{"subtotal":333.34}'::jsonb
  where workspace_id = '00000000-0000-0000-0000-00000000fcd1' and client_invoice_id = 'inv-af7b-ab';
  perform pg_temp.erwarte_fehler('AF7b ein Cent daneben: 333,34 zu 396,66',
    $q$select pg_temp.schluss('af7b', 'standard_19', 11503.34, pg_temp.abzug('inv-af7b-ab'))$q$,
    'invoice_abschlag_net_unreliable');

  /* AF8 — 7 %: Altabschlag ohne Netto abgewiesen, mit Netto angenommen. */
  perform pg_temp.abschlag('af8', 'standard_7', 100, 107, 107, '2026-09-08', false);
  perform pg_temp.altformat('af8');
  perform pg_temp.erwarte_fehler('AF8 7 %: Altabschlag ohne Netto',
    $q$select pg_temp.schluss('af8', 'standard_7', 10593, pg_temp.abzug('inv-af8-ab'))$q$,
    'invoice_abschlag_net_unreliable');
  perform pg_temp.abschlag('af8b', 'standard_7', 100, 107, 107, '2026-09-08', false);
  r := pg_temp.schluss('af8b', 'standard_7', 10593, pg_temp.abzug('inv-af8b-ab'));
  raise notice 'OK  AF8b: 7 %% mit gespeichertem Netto angenommen';

  /* AF9 — Rechte unverändert: die Prüfung nur für den Eigentümer. */
  if has_function_privilege('anon', 'public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean)', 'execute')
     or has_function_privilege('service_role', 'public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean)', 'execute') then
    raise exception 'AF9: assert_workspace_invoice_integrity ist von aussen aufrufbar';
  end if;
  raise notice 'OK  AF9: Rechte unverändert (nur Eigentümer)';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
