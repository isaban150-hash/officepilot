-- FINANZ-CORE-01A -- Gesamtabschluss: Skontofrist nach Paragraf 193 BGB (Migrationen 20261117120000, 20261118120000).
--
-- Faellt das kalendarische Ende der Skontofrist auf Samstag oder Sonntag, gilt der Montag. Seit 20261118
-- verschieben auch gesetzliche Feiertage am Sitz des Kunden (WEISS FC01A-END16-R1; SF7); die Feiertagsfaelle
-- im Einzelnen pruefen supabase/tests/fc01a_feiertage.sql. Gleiche Faelle wie im Client-Test
-- src/services/invoice/skontofristFc01aAbschluss.test.ts (gemeinsame Beispiele).
--
-- Setzt die Migrationen 20261114120000 bis 20261118120000 voraus. Ausfuehren (nur lokal,
-- niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_skontofrist.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles
-- wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fcd02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-skontofrist-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-skontofrist-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fcd2', 'FC01A Skontofrist', '00000000-0000-0000-0000-0000000fcd02');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000fcd2', '00000000-0000-0000-0000-0000000fcd02', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000fcd2', 'cust-1', '{"id":"cust-1","name":"Muster GmbH"}'::jsonb);

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fcd02');

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

create function pg_temp.auftrag() returns jsonb language sql immutable as $p$
  select jsonb_build_object(
    'customerId', 'cust-1',
    'customerBilling', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb,
    'title', 'FC01A Skontofrist', 'baustelle', '', 'taxStatus', 'standard_19',
    'positions', '[{"id":"cp1","description":"Montagestunden","plannedQuantity":100,"unit":"Stück","unitPrice":100}]'::jsonb);
$p$;

/* Auftrag + Pauschalabschlag 400/476 (19 %) mit Rechnungsdatum p_datum, Skontotext p_skonto, Zahlung p_zahlung am p_tag. */
create function pg_temp.abschlag(p_vorgang text, p_datum text, p_skonto text, p_zahlung numeric, p_tag text)
returns void language plpgsql as $p$
begin
  perform public.create_workspace_order('00000000-0000-0000-0000-00000000fcd2', p_vorgang, pg_temp.auftrag());
  perform public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fcd2', p_vorgang, 'inv-' || p_vorgang || '-ab',
    jsonb_build_object(
      'type', 'abschlag', 'taxStatus', 'standard_19', 'legalNotices', '[]'::jsonb,
      'issueDate', p_datum, 'calculationMode', 'fixed_amount', 'fixedAmountNet', 400, 'abschlagNumber', 1,
      'customerSnapshot', jsonb_build_object('name', 'Muster GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld'),
      'positions', '[]'::jsonb, 'subtotal', 400, 'amount', 476, 'skontoText', p_skonto));
  if p_zahlung is not null then
    perform public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcd2', 'inv-' || p_vorgang || '-ab',
      'pay-' || p_vorgang, p_zahlung, p_tag, null, null, 'bank');
  end if;
end;
$p$;

create function pg_temp.offen(p_vorgang text) returns numeric language sql stable as $p$
  select public.workspace_invoice_open_cents('00000000-0000-0000-0000-00000000fcd2', 'inv-' || p_vorgang || '-ab');
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

/* Schlussrechnung 100 Stunden zu 100 (10.000 netto, 11.900 brutto) mit Abzug des Abschlags (gezahlt/Skonto eingefroren). */
create function pg_temp.schluss(p_vorgang text, p_paid numeric, p_skonto numeric) returns jsonb language sql as $p$
  select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fcd2', p_vorgang, 'inv-' || p_vorgang || '-schluss',
    jsonb_build_object(
      'type', 'schluss', 'taxStatus', 'standard_19', 'legalNotices', '[]'::jsonb, 'issueDate', '2026-10-05',
      'customerSnapshot', jsonb_build_object('name', 'Muster GmbH', 'street', 'Weg 1', 'zip', '33602', 'city', 'Bielefeld'),
      'positions', jsonb_build_array(jsonb_build_object('id', 'line-s', 'orderPositionId', 'cp1', 'description', 'Montagestunden',
        'quantity', 100, 'unit', 'Stück', 'unitPrice', 100, 'lineTotal', 10000)),
      'subtotal', 10000, 'amount', 11424,
      'previousAbschlagDeductions', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'invoiceId', a.client_invoice_id, 'invoiceNumber', a.invoice_number, 'abschlagNumber', a.payload->'abschlagNumber',
        'date', a.payload->>'issueDate', 'subtotal', a.payload->'subtotal', 'amount', a.payload->'amount',
        'paidAmount', p_paid, 'skontoAmount', p_skonto)))))
  from public.workspace_invoices a
  where a.workspace_id = '00000000-0000-0000-0000-00000000fcd2' and a.client_invoice_id = 'inv-' || p_vorgang || '-ab';
$p$;

do $$
declare
  neu constant text := 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';
  alt constant text := 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';
  r jsonb;
  t record;
begin
  /* SF1 -- Hilfsfunktion: Samstag und Sonntag -> Montag, sonst unverändert (auch Feiertage). */
  if public.workspace_shift_to_working_day('2026-09-12') <> '2026-09-14'
     or public.workspace_shift_to_working_day('2026-09-13') <> '2026-09-14'
     or public.workspace_shift_to_working_day('2026-09-14') <> '2026-09-14'
     or public.workspace_shift_to_working_day('2026-09-11') <> '2026-09-11'
     or public.workspace_shift_to_working_day('2026-05-01') <> '2026-05-01'
     or public.workspace_shift_to_working_day(null) is not null then
    raise exception 'SF1: workspace_shift_to_working_day falsch';
  end if;
  raise notice 'OK  SF1: Sa 12.09./So 13.09. -> Mo 14.09.; Mo, Fr und Feiertag 01.05. unverändert; NULL bleibt NULL';

  /* SF2 -- neuer Standardtext mit Fristbeginn wird gelesen wie der bisherige. */
  select * into t from public.workspace_skonto_terms(neu);
  if t.pct is distinct from 2 or t.days is distinct from 10 then
    raise exception 'SF2: neuer Standardtext gelesen als % / %', t.pct, t.days;
  end if;
  raise notice 'OK  SF2: „… 10 Tagen ab Rechnungsdatum … 2 %% Skonto.“ = 2 %% / 10 Tage';

  /* SF3 -- WEISS-/Bericht-11-Beispiel: Do 03.09. + 10 = So 13.09. -> Mo 14.09.; Zahlung 466,48 am Montag: ausgeglichen. */
  perform pg_temp.abschlag('sf3', '2026-09-03', alt, 466.48, '2026-09-14');
  perform pg_temp.erwarte_offen('SF3 Fristende Sonntag, Zahlung Montag (bisheriger Text)', 'sf3', 0);

  /* SF4 -- dasselbe am Dienstag: verspätet, der Skontorest bleibt offen. */
  perform pg_temp.abschlag('sf4', '2026-09-03', neu, 466.48, '2026-09-15');
  perform pg_temp.erwarte_offen('SF4 Fristende Sonntag, Zahlung Dienstag', 'sf4', 952);

  /* SF5 -- Fristende Samstag: Mi 02.09. + 10 = Sa 12.09. -> Mo 14.09. */
  perform pg_temp.abschlag('sf5', '2026-09-02', neu, 466.48, '2026-09-14');
  perform pg_temp.erwarte_offen('SF5 Fristende Samstag, Zahlung Montag', 'sf5', 0);

  /* SF6 -- Fristende an einem Werktag bleibt: Fr 04.09. + 10 = Mo 14.09.; Zahlung Di 15.09. verspätet. */
  perform pg_temp.abschlag('sf6', '2026-09-04', neu, 466.48, '2026-09-15');
  perform pg_temp.erwarte_offen('SF6 Fristende Montag, Zahlung Dienstag', 'sf6', 952);

  /*
   * SF7 -- Feiertag verschiebt (20261118, WEISS FC01A-END16-R1): Di 21.04. + 10 = Fr 01.05. (bundesweit
   * Feiertag, Sitz Bielefeld) -> Mo 04.05.; Zahlung am Montag ausgeglichen. Bis 20261117: 952 Cent offen.
   */
  perform pg_temp.abschlag('sf7', '2026-04-21', neu, 466.48, '2026-05-04');
  perform pg_temp.erwarte_offen('SF7 Fristende Feiertag (Fr 01.05.), Zahlung Montag', 'sf7', 0);

  /* SF8 -- 100 % sind kein Skonto: ohne Zahlung bleibt alles offen (wie im Client). */
  perform pg_temp.abschlag('sf8', '2026-09-03', 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 100 % Skonto.', null, null);
  perform pg_temp.erwarte_offen('SF8 100 Prozent Skonto, keine Zahlung', 'sf8', 47600);

  /* SF9 -- Schlussrechnung: der am Montag (Fristende Sonntag) mit Skonto beglichene Abschlag ist abziehbar. */
  r := pg_temp.schluss('sf3', 466.48, 9.52);
  if r->'invoice'->>'type' is distinct from 'schluss' then
    raise exception 'SF9: Schlussrechnung nicht angenommen: %', r;
  end if;
  raise notice 'OK  SF9: Schlussrechnung mit Abzug 466,48 gezahlt + 9,52 Skonto angenommen';

  /* SF10 -- der am Dienstag gezahlte Abschlag ist nicht beglichen: Schlussrechnung abgewiesen. */
  perform pg_temp.erwarte_fehler('SF10 Zahlung nach dem verschobenen Fristende',
    $q$select pg_temp.schluss('sf4', 466.48, 9.52)$q$, 'invoice_abschlag_unpaid');

  /* SF11 -- Zahlungsannahme: auf den am Montag ausgeglichenen Abschlag keine weitere Zahlung ohne Bestätigung. */
  perform pg_temp.erwarte_fehler('SF11 weitere Zahlung auf den beglichenen Abschlag',
    $q$select public.add_workspace_invoice_payment('00000000-0000-0000-0000-00000000fcd2', 'inv-sf5-ab', 'pay-sf5-2', 9.52, '2026-09-20', null, null, 'bank')$q$,
    'overpayment');

  /* SF12 -- Rechte: beide Funktionen nur für den Eigentümer. */
  if has_function_privilege('anon', 'public.workspace_shift_to_working_day(date)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_shift_to_working_day(date)', 'execute')
     or has_function_privilege('service_role', 'public.workspace_shift_to_working_day(date)', 'execute')
     or has_function_privilege('anon', 'public.workspace_invoice_open_cents(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.workspace_invoice_open_cents(uuid, text)', 'execute')
     or has_function_privilege('service_role', 'public.workspace_invoice_open_cents(uuid, text)', 'execute') then
    raise exception 'SF12: Hilfsfunktionen sind von aussen aufrufbar';
  end if;
  raise notice 'OK  SF12: Rechte nur Eigentümer';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
