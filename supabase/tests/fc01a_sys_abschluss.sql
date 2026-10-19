-- FINANZ-CORE-01A -- systemische Gesamtnacharbeit (SYS-01/SYS-03): Bausteine, Rechte und Datenstand der Migration
-- 20261123120000_fc01a_sys_abschluss_server.sql in einer Sitzung. Die fachlichen Abschlussfaelle (Rollen,
-- Faelschungen, Abfolgen, Wettlaeufe) pruefen die Echtserver-Pruefstaende unter
-- pruefunterlagen/finanz-core-01a/belege/systemisch/echtserver/.
--
-- Nur lokal, niemals --linked oder remote:
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/fc01a_sys_abschluss.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Daten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

create function pg_temp.pruefe(p_label text, p_ok boolean, p_detail text default '') returns void language plpgsql as $p$
begin
  if not coalesce(p_ok, false) then
    raise exception '% -- %', p_label, p_detail;
  end if;
  raise notice 'OK  %', p_label;
end;
$p$;

/* R1 -- Rechte: Hilfsfunktionen fuer niemanden ausfuehrbar, Abschlusswege nur fuer angemeldete Nutzer. */
do $$
declare
  f record;
  v_rolle text;
begin
  for f in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'workspace_fc\_%' or p.proname = 'workspace_finance_change_mark')
  loop
    foreach v_rolle in array array['anon', 'authenticated', 'service_role'] loop
      perform pg_temp.pruefe(format('R1 %s(%s) nicht fuer %s', f.proname, f.args, v_rolle),
        not has_function_privilege(v_rolle, f.oid, 'EXECUTE'));
    end loop;
  end loop;
  foreach v_rolle in array array['close_workspace_accounting_period(uuid,jsonb)',
    'reopen_workspace_accounting_period(uuid,integer,integer,text,integer)',
    'pull_workspace_accounting_period_closures(uuid)'] loop
    perform pg_temp.pruefe('R1 ' || v_rolle || ' fuer authenticated', has_function_privilege('authenticated', 'public.' || v_rolle, 'EXECUTE'));
    perform pg_temp.pruefe('R1 ' || v_rolle || ' nicht fuer anon', not has_function_privilege('anon', 'public.' || v_rolle, 'EXECUTE'));
  end loop;
  perform pg_temp.pruefe('R1 workspace_finance_changes: RLS an',
    (select relrowsecurity from pg_class where oid = 'public.workspace_finance_changes'::regclass));
  perform pg_temp.pruefe('R1 workspace_finance_changes: kein Lesen fuer authenticated',
    not has_table_privilege('authenticated', 'public.workspace_finance_changes', 'SELECT'));
  perform pg_temp.pruefe('R1 workspace_finance_changes: kein Lesen fuer anon',
    not has_table_privilege('anon', 'public.workspace_finance_changes', 'SELECT'));
  perform pg_temp.pruefe('R1 Abschlusszeile: Pruefangaben nur vollstaendig und nur mit p5',
    exists (select 1 from pg_constraint where conname = 'workspace_accounting_period_closures_validated_check'));
end;
$$;

/* B -- Buchungsbetraege einer Rechnung (invoiceBookingAmounts, resolveInvoiceNet). */
do $$
declare
  r record;
begin
  select * into r from public.workspace_fc_rechnung_buchung('rechnung', '{"amount": 119, "subtotal": 100, "taxStatus": "standard_19"}');
  perform pg_temp.pruefe('B1 gespeichertes Netto ergibt den Betrag: 11900/10000', r.brutto = 11900 and r.netto = 10000, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('rechnung', '{"amount": 119, "subtotal": 99, "taxStatus": "standard_19"}');
  perform pg_temp.pruefe('B2 widersprechendes Netto bleibt ungeklaert (NULL), nie geschaetzt', r.brutto = 11900 and r.netto is null, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('rechnung', '{"amount": 119, "subtotal": 119, "taxStatus": "standard_19", "positions": [{"quantity": 2, "unitPrice": 50}]}');
  perform pg_temp.pruefe('B3 Spur der alten Ersatzregel (Netto = Brutto): Positionssumme gilt', r.netto = 10000, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('abschlag', '{"amount": 476, "taxStatus": "standard_19", "calculationMode": "fixed_amount", "fixedAmountNet": 400}');
  perform pg_temp.pruefe('B4 Pauschalabschlag ohne gespeichertes Netto: Pauschalnetto', r.netto = 40000, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('rechnung', '{"amount": 100, "taxStatus": "kleinunternehmer_19"}');
  perform pg_temp.pruefe('B5 ausdruecklich steuerfrei ohne Netto: Netto = Betrag', r.netto = 10000, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('rechnung', '{"amount": 119, "taxStatus": "unclear"}');
  perform pg_temp.pruefe('B6 unklarer Steuerstatus ohne Netto: ungeklaert', r.netto is null, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('schluss',
    '{"amount": 11424, "subtotal": 10000, "taxStatus": "standard_19", "previousAbschlagDeductions": [{"amount": 476, "subtotal": 400}]}');
  perform pg_temp.pruefe('B7 Schlussrechnung mit verlaesslichem Abzug: Rest 9600 netto / 1824 Steuer',
    r.brutto = 1142400 and r.netto = 960000 and r.brutto - r.netto = 182400, r::text);
  select * into r from public.workspace_fc_rechnung_buchung('schluss',
    '{"amount": 11424, "subtotal": 10000, "taxStatus": "standard_19", "previousAbschlagDeductions": [{"amount": 476}]}');
  perform pg_temp.pruefe('B8 Altabzug ohne Netto: Steuer des Rests ueber den Satz (round(brutto*19/119))',
    r.brutto - r.netto = round(1142400 * 19 / 119.0) and r.netto = 1142400 - round(1142400 * 19 / 119.0), r::text);
  select * into r from public.workspace_fc_rechnung_buchung('rechnung', '{"subtotal": 100, "taxStatus": "standard_19"}');
  perform pg_temp.pruefe('B9 ohne Betrag: Brutto 0, Netto ungeklaert', r.brutto = 0 and r.netto is null, r::text);
end;
$$;

/* K -- Kanonische Bausteine wie im Client. */
do $$
begin
  perform pg_temp.pruefe('K1 Maskierung \\, |, CR, LF', public.workspace_fc_kanon(E'a\\b|c\rd\ne') = E'a\\\\b\\pc\\rd\\ne',
    public.workspace_fc_kanon(E'a\\b|c\rd\ne'));
  perform pg_temp.pruefe('K2 NULL wird leer', public.workspace_fc_kanon(null) = '');
  perform pg_temp.pruefe('K3 Cent halb weg von null: 0.005 -> 1, -0.005 -> -1, 1.004 -> 100',
    public.workspace_fc_json_cent('0.005') = '1' and public.workspace_fc_json_cent('-0.005') = '-1' and public.workspace_fc_json_cent('1.004') = '100');
  perform pg_temp.pruefe('K4 kein Betrag: -', public.workspace_fc_json_cent('null') = '-' and public.workspace_fc_json_cent('"12"') = '-');
  perform pg_temp.pruefe('K5 Geschaeftstag Europe/Berlin: 30.09. 22:30 UTC -> 2026-10-01',
    public.workspace_fc_geschaeftstag('2026-09-30T22:30:00.000Z') = '2026-10-01');
  perform pg_temp.pruefe('K6 reines Datum bleibt, leer ist NULL',
    public.workspace_fc_geschaeftstag('2026-09-30') = '2026-09-30' and public.workspace_fc_geschaeftstag('  ') is null);
  perform pg_temp.pruefe('K7 Steuer aus Netto wie Math.round', public.workspace_fc_steuer_aus_netto(50, 19) = 10 and public.workspace_fc_steuer_aus_netto(-50, 19) = -9);
  perform pg_temp.pruefe('K8 wirksames Skonto: fristgerecht 466,48 auf 476 -> 952',
    public.workspace_fc_wirksames_skonto(47600, 46648, '2026-07-20', 46648, 46648) = 952);
  perform pg_temp.pruefe('K9 verspaetet: kein Skonto',
    public.workspace_fc_wirksames_skonto(47600, 46648, '2026-07-20', 46648, 0) = 0);
  perform pg_temp.pruefe('K10 Zahlungsart nur bank/cash/other', public.workspace_fc_zahlungsart('bank') = 'bank' and public.workspace_fc_zahlungsart('scheck') = '');
end;
$$;

/* D -- Datenstand: jede Finanzaenderung schreibt eine Zeile; die Loeschkaskade des Betriebs hinterlaesst keine. */
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'fc01a-sys-abschluss@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000f5a1', 'FC01A SYS Abschluss', '00000000-0000-0000-0000-0000000f5a01');

do $$
declare
  v_vorher bigint;
  v_nach bigint;
  v_stand bigint;
begin
  select count(*) into v_vorher from public.workspace_finance_changes where workspace_id = '00000000-0000-0000-0000-00000000f5a1';
  insert into public.workspace_settings (workspace_id, settings) values ('00000000-0000-0000-0000-00000000f5a1', '{"chartOfAccounts":"SKR04"}')
    on conflict (workspace_id) do update set settings = excluded.settings;
  select count(*) into v_nach from public.workspace_finance_changes where workspace_id = '00000000-0000-0000-0000-00000000f5a1';
  perform pg_temp.pruefe('D1 Einstellungsaenderung schreibt den Datenstand', v_nach > v_vorher, v_vorher || ' -> ' || v_nach);
  v_stand := public.workspace_fc_datenstand_sperren('00000000-0000-0000-0000-00000000f5a1');
  perform pg_temp.pruefe('D2 Datenstand = hoechste Kennung des Betriebs',
    v_stand = (select max(id) from public.workspace_finance_changes where workspace_id = '00000000-0000-0000-0000-00000000f5a1'));
  perform pg_temp.pruefe('D3 Kontenrahmen kommt in den Kopf der Projektion',
    left(public.workspace_fc_abschluss_projektion('00000000-0000-0000-0000-00000000f5a1', 2026, 9)->>'text', 30) = 'v=5|month=2026-09|chart=SKR04');
  delete from public.workspaces where id = '00000000-0000-0000-0000-00000000f5a1';
  perform pg_temp.pruefe('D4 Loeschkaskade: keine Datenstandszeilen bleiben',
    not exists (select 1 from public.workspace_finance_changes where workspace_id = '00000000-0000-0000-0000-00000000f5a1'));
end;
$$;

/* M -- Manifesttext: dieselbe Bildung wie der Client (Reihenfolge nach Bytes, Skonto-Standard 0). */
do $$
declare
  v_text text;
begin
  v_text := public.workspace_fc_manifest_text('{"monthKey":"2026-09","chartOfAccounts":"SKR03",
    "entries":[{"sourceType":"invoice","sourceId":"b","belegart":"ausgangsrechnung","datum":"2026-09-02","brutto":119,"netto":100,"steuer":19,"belegStatus":"aktiv","accountNumber":"8400","taxTreatment":"standard_19","assignmentStatus":"confirmed","bookingText":"x","kontenrahmen":"SKR03"},
               {"sourceType":"expense","sourceId":"a","belegart":"eingangsbeleg","datum":"2026-09-01","brutto":59.5,"netto":50,"steuer":9.5,"belegStatus":"aktiv","accountNumber":"","taxTreatment":"","assignmentStatus":"none","bookingText":""}],
    "payments":[{"sourceType":"invoice","sourceId":"b","paymentId":"p","datum":"2026-09-05","betrag":119}]}');
  perform pg_temp.pruefe('M1 Kopf, E nach Quelle (expense vor invoice), Skonto 0, P ohne Skontoangabe = 0',
    v_text = E'v=5|month=2026-09|chart=SKR03\nE|expense|a|eingangsbeleg|2026-09-01|5950|5000|950|0|aktiv||||none|\nE|invoice|b|ausgangsrechnung|2026-09-02|11900|10000|1900|0|aktiv|SKR03|8400|standard_19|confirmed|x\nP|invoice|b|p|2026-09-05|11900|0|',
    v_text);
  perform pg_temp.pruefe('M2 Befund nennt fehlend/erfunden/abweichend',
    public.workspace_fc_text_befund(E'v=5|x\nE|invoice|a|ausgangsrechnung|1\nE|invoice|c|ausgangsrechnung|1', E'v=5|x\nE|invoice|a|ausgangsrechnung|2\nE|invoice|b|ausgangsrechnung|1')
      like 'fehlend=1 erfunden=1 abweichend=1 doppelt=0 kopf=0;%');
end;
$$;

rollback;
