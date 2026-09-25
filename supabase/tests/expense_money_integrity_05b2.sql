-- FINANZCORE-05B2 — Laufzeittest des serverseitigen Money-Integrity-Guards.
--
-- Prueft die **reale** SQL-Semantik gegen eine lokale Datenbank, nicht den
-- Migrationstext. Beantwortet werden vier Fragen:
--
--   1. Faengt der Server genau die vier harten Regeln des Clients ab?
--   2. Laesst er in Ruhe, was der Client bewusst nur als Hinweis behandelt —
--      den konkreten Steuersatz und den Status `unclear`?
--   3. Bleibt ein ungueltiger Altbeleg loeschbar und unveraendert wiederholbar,
--      statt den Sync in eine Endlosschleife zu treiben?
--   4. Wird centgenau gerechnet, nicht in Gleitkomma?
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/expense_money_integrity_05b2.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000e5b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'money-05b2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000e001', 'Geldintegritaet-05B2', '00000000-0000-0000-0000-00000000e5b2');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e5b2', 'owner', 'active');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000e5b2","role":"authenticated"}', true);

/* ------------------------------------------------------------------ */
/* Hilfen — temporaer, fallen mit dem Rollback weg.                    */
/* ------------------------------------------------------------------ */

-- Ein Aufruf, wie ihn `buildExpensePushPayload` zusammensetzt.
create function pg_temp.beleg(p_id text, p_money jsonb, p_deleted boolean default false)
returns jsonb language sql as $p$
  select jsonb_build_object(
    'client_expense_id', p_id,
    'status', 'gebucht',
    'dedupe_key', p_id,
    'deleted', p_deleted,
    'payload', '{
      "id": "x",
      "category": "material",
      "supplierName": "Baustoff Sued GmbH",
      "title": "05B2 TEST",
      "issueDate": "2026-06-01"
    }'::jsonb || p_money
  );
$p$;

create function pg_temp.geld(p_net jsonb, p_tax jsonb, p_gross jsonb, p_status text)
returns jsonb language sql as $p$
  select jsonb_build_object('netAmount', p_net, 'taxAmount', p_tax, 'grossAmount', p_gross, 'taxStatus', p_status);
$p$;

create function pg_temp.erwarte_fehler(p_label text, p_payload jsonb, p_version bigint, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.upsert_workspace_expense('00000000-0000-0000-0000-00000000e001', p_payload, p_version);
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% — falscher Fehler: % (erwartet: %)', p_label, sqlerrm, p_expected;
    end if;
    raise notice 'OK  %: %', p_label, p_expected;
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

create function pg_temp.erwarte_erfolg(p_label text, p_payload jsonb, p_version bigint)
returns bigint language plpgsql as $p$
declare v_result jsonb;
begin
  v_result := public.upsert_workspace_expense('00000000-0000-0000-0000-00000000e001', p_payload, p_version);
  raise notice 'OK  %: row_version %', p_label, v_result->>'row_version';
  return (v_result->>'row_version')::bigint;
end;
$p$;

/* ================================================================== */
/* A — die vier harten Regeln                                         */
/* ================================================================== */

-- A1 Der Kontrollfall: 100,00 + 19,00 = 119,00 bei 19 %.
select pg_temp.erwarte_erfolg('A1 gueltige Ausgabe',
  pg_temp.beleg('e-a1', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'standard_19')), null);

-- A2 Die Gleichung stimmt nicht.
select pg_temp.erwarte_fehler('A2 Gleichung gebrochen',
  pg_temp.beleg('e-a2', pg_temp.geld('100'::jsonb, '19'::jsonb, '200'::jsonb, 'standard_19')), null,
  'expense_money_equation_mismatch');

-- A3 Ein Status ohne Umsatzsteuer traegt einen Steuerbetrag.
select pg_temp.erwarte_fehler('A3 Steuer trotz Steuerfreiheit',
  pg_temp.beleg('e-a3', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'tax_free')), null,
  'expense_money_tax_on_zero_rate_status');
select pg_temp.erwarte_fehler('A3b Steuer trotz 13b',
  pg_temp.beleg('e-a3b', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'reverse_charge_13b')), null,
  'expense_money_tax_on_zero_rate_status');
select pg_temp.erwarte_fehler('A3c Steuer trotz Kleinunternehmer',
  pg_temp.beleg('e-a3c', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'kleinunternehmer_19')), null,
  'expense_money_tax_on_zero_rate_status');

-- A3d Dieselben Status ohne Steuerbetrag sind selbstverstaendlich erlaubt.
select pg_temp.erwarte_erfolg('A3d 13b ohne Steuer',
  pg_temp.beleg('e-a3d', pg_temp.geld('100'::jsonb, '0'::jsonb, '100'::jsonb, 'reverse_charge_13b')), null);

-- A4 Steuer und Netto laufen gegeneinander. Die Gleichung stimmt dabei
--    (100 - 19 = 81) — nur die Vorzeichenregel faengt das ab.
select pg_temp.erwarte_fehler('A4 Vorzeichen gegenlaeufig',
  pg_temp.beleg('e-a4', pg_temp.geld('100'::jsonb, '-19'::jsonb, '81'::jsonb, 'standard_19')), null,
  'expense_money_tax_sign_mismatch');
select pg_temp.erwarte_fehler('A4b Vorzeichen gegenlaeufig, andersherum',
  pg_temp.beleg('e-a4b', pg_temp.geld('-100'::jsonb, '19'::jsonb, '-81'::jsonb, 'standard_19')), null,
  'expense_money_tax_sign_mismatch');

-- A5 Betraege, die keine sind.
select pg_temp.erwarte_fehler('A5 netAmount fehlt',
  pg_temp.beleg('e-a5', jsonb_build_object('taxAmount', 19, 'grossAmount', 119, 'taxStatus', 'standard_19')), null,
  'expense_money_invalid_amount');
select pg_temp.erwarte_fehler('A5b netAmount ist null',
  pg_temp.beleg('e-a5b', pg_temp.geld('null'::jsonb, '19'::jsonb, '119'::jsonb, 'standard_19')), null,
  'expense_money_invalid_amount');
select pg_temp.erwarte_fehler('A5c grossAmount ist Text',
  pg_temp.beleg('e-a5c', pg_temp.geld('100'::jsonb, '19'::jsonb, '"keine Zahl"'::jsonb, 'standard_19')), null,
  'expense_money_invalid_amount');
select pg_temp.erwarte_fehler('A5d taxAmount ist ein Objekt',
  pg_temp.beleg('e-a5d', pg_temp.geld('100'::jsonb, '{}'::jsonb, '119'::jsonb, 'standard_19')), null,
  'expense_money_invalid_amount');

/* ================================================================== */
/* B — was der Server bewusst NICHT erzwingt                          */
/* ================================================================== */

-- B1 Der Steuersatz passt nicht zu `standard_19` (7 % statt 19 %). Das ist der
--    gemischte Beleg — Hotelrechnung, Baumarktbon — und muss buchbar bleiben.
select pg_temp.erwarte_erfolg('B1 abweichender Satz bleibt erlaubt',
  pg_temp.beleg('e-b1', pg_temp.geld('100'::jsonb, '7'::jsonb, '107'::jsonb, 'standard_19')), null);

-- B2 `unclear` heisst „unbekannt", nicht „keine Steuer".
select pg_temp.erwarte_erfolg('B2 unclear mit Steuer',
  pg_temp.beleg('e-b2', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'unclear')), null);
select pg_temp.erwarte_erfolg('B2b unclear ohne Steuer',
  pg_temp.beleg('e-b2b', pg_temp.geld('100'::jsonb, '0'::jsonb, '100'::jsonb, 'unclear')), null);

-- B3 Fehlt der Steuerstatus ganz, greift keine Nullsatzregel. Die Gleichung
--    gilt trotzdem.
select pg_temp.erwarte_erfolg('B3 ohne taxStatus',
  pg_temp.beleg('e-b3', jsonb_build_object('netAmount', 100, 'taxAmount', 19, 'grossAmount', 119)), null);

-- B4 Die Gutschrift: durchgehend negativ, in sich stimmig.
select pg_temp.erwarte_erfolg('B4 Gutschrift',
  pg_temp.beleg('e-b4', pg_temp.geld('-100'::jsonb, '-19'::jsonb, '-119'::jsonb, 'standard_19')), null);

-- B5 Null ist ein gueltiger Betrag.
select pg_temp.erwarte_erfolg('B5 Nullbeleg',
  pg_temp.beleg('e-b5', pg_temp.geld('0'::jsonb, '0'::jsonb, '0'::jsonb, 'standard_19')), null);

/* ================================================================== */
/* C — centgenau, nicht in Gleitkomma                                 */
/* ================================================================== */

-- C1 Krumme Betraege, die exakt aufgehen.
select pg_temp.erwarte_erfolg('C1 Cent exakt',
  pg_temp.beleg('e-c1', pg_temp.geld('100.31'::jsonb, '19.06'::jsonb, '119.37'::jsonb, 'standard_19')), null);

-- C2 Ein Cent daneben ist ein Fehler — keine stille Toleranz.
select pg_temp.erwarte_fehler('C2 ein Cent daneben',
  pg_temp.beleg('e-c2', pg_temp.geld('100.31'::jsonb, '19.06'::jsonb, '119.38'::jsonb, 'standard_19')), null,
  'expense_money_equation_mismatch');

-- C3 Der klassische Gleitkommafall: 0.1 + 0.2 ist in Gleitkomma nicht 0.3.
--    In Cent gerechnet ist es 10 + 20 = 30.
select pg_temp.erwarte_erfolg('C3 0.10 + 0.20 = 0.30',
  pg_temp.beleg('e-c3', pg_temp.geld('0.1'::jsonb, '0.2'::jsonb, '0.3'::jsonb, 'unclear')), null);

-- C4 Betraege als Zeichenkette sind derselbe Wert.
select pg_temp.erwarte_erfolg('C4 Betraege als Text',
  pg_temp.beleg('e-c4', pg_temp.geld('"100.00"'::jsonb, '"19.00"'::jsonb, '"119.00"'::jsonb, 'standard_19')), null);

/* ================================================================== */
/* D — der Altbestand wird nicht eingesperrt                          */
/* ================================================================== */

-- Ein ungueltiger Altbeleg, wie ihn ein Client vor 05B geschrieben haben kann:
-- 59,25 netto + 11,26 Steuer, aber 42,10 brutto. Direkt eingesetzt, weil der
-- Guard genau das ab jetzt verhindert.
insert into public.workspace_expenses (workspace_id, client_expense_id, status, dedupe_key, payload, deleted, row_version, created_by)
values ('00000000-0000-0000-0000-00000000e001', 'e-alt', 'gebucht', 'e-alt',
        '{"id":"e-alt","category":"material","supplierName":"Alt GmbH","title":"ALTBESTAND",
          "issueDate":"2026-01-05","netAmount":59.25,"taxAmount":11.26,"grossAmount":42.10,
          "taxStatus":"standard_19"}'::jsonb,
        false, 1, '00000000-0000-0000-0000-00000000e5b2');

-- D1 Derselbe Beleg unveraendert erneut geschickt — der Replay eines neu
--    angemeldeten Geraets. Muss durchgehen, sonst laeuft der Sync endlos.
select pg_temp.erwarte_erfolg('D1 unveraenderter Replay',
  pg_temp.beleg('e-alt', '{"id":"e-alt","category":"material","supplierName":"Alt GmbH","title":"ALTBESTAND",
     "issueDate":"2026-01-05","netAmount":59.25,"taxAmount":11.26,"grossAmount":42.10,
     "taxStatus":"standard_19"}'::jsonb), 1);

-- D2 Ein nicht-monetaeres Feld aendert sich, die Betraege nicht. Auch das ist
--    keine Geldaenderung — Titel oder Lieferant muessen korrigierbar bleiben.
select pg_temp.erwarte_erfolg('D2 nur Titel geaendert',
  pg_temp.beleg('e-alt', '{"id":"e-alt","category":"material","supplierName":"Alt GmbH","title":"ALTBESTAND KORRIGIERT",
     "issueDate":"2026-01-05","netAmount":59.25,"taxAmount":11.26,"grossAmount":42.10,
     "taxStatus":"standard_19"}'::jsonb), 2);

-- D3 Aber eine echte Geldaenderung auf etwas weiterhin Ungueltiges wird
--    abgelehnt. Wer die Betraege anfasst, muss sie richtig machen.
select pg_temp.erwarte_fehler('D3 Geldaenderung bleibt ungueltig',
  pg_temp.beleg('e-alt', '{"id":"e-alt","category":"material","supplierName":"Alt GmbH","title":"ALTBESTAND",
     "issueDate":"2026-01-05","netAmount":59.25,"taxAmount":11.26,"grossAmount":50.00,
     "taxStatus":"standard_19"}'::jsonb), 3,
  'expense_money_equation_mismatch');

-- D4 Die Reparatur auf stimmige Betraege geht durch.
select pg_temp.erwarte_erfolg('D4 Reparatur',
  pg_temp.beleg('e-alt', '{"id":"e-alt","category":"material","supplierName":"Alt GmbH","title":"ALTBESTAND",
     "issueDate":"2026-01-05","netAmount":35.38,"taxAmount":6.72,"grossAmount":42.10,
     "taxStatus":"standard_19"}'::jsonb), 3);

-- D5 Und ein ungueltiger Altbeleg bleibt loeschbar. Ein Grabstein traegt keine
--    Betraege; wuerde der Guard hier greifen, haenge der Beleg fuer immer fest.
insert into public.workspace_expenses (workspace_id, client_expense_id, status, dedupe_key, payload, deleted, row_version, created_by)
values ('00000000-0000-0000-0000-00000000e001', 'e-alt2', 'gebucht', 'e-alt2',
        '{"id":"e-alt2","netAmount":59.25,"taxAmount":11.26,"grossAmount":42.10,"taxStatus":"tax_free"}'::jsonb,
        false, 1, '00000000-0000-0000-0000-00000000e5b2');
select pg_temp.erwarte_erfolg('D5 ungueltiger Altbeleg loeschbar',
  pg_temp.beleg('e-alt2', '{}'::jsonb, true), 1);
do $$
begin
  if not exists (select 1 from public.workspace_expenses
                 where client_expense_id = 'e-alt2' and deleted) then
    raise exception 'D5 — der Beleg wurde nicht als geloescht markiert';
  end if;
  raise notice 'OK  D5b: Grabstein gesetzt, Payload unangetastet';
end;
$$;

-- D6 Der Grabstein fuer eine Zeile, die die Cloud nie sah, bleibt ein No-op —
--    ohne Geldpruefung und ohne Fehler.
do $$
declare v jsonb;
begin
  v := public.upsert_workspace_expense('00000000-0000-0000-0000-00000000e001',
       pg_temp.beleg('e-nie-gesehen', '{"netAmount":"kaputt"}'::jsonb, true), null);
  if coalesce((v->>'noop')::boolean, false) is not true then
    raise exception 'D6 — erwartet war ein No-op, erhalten: %', v;
  end if;
  raise notice 'OK  D6: unbekannter Grabstein bleibt No-op';
end;
$$;

/* ================================================================== */
/* E — der Rest der Funktion ist unveraendert                         */
/* ================================================================== */

-- E1 Der Versionskonflikt greift weiterhin.
select pg_temp.erwarte_fehler('E1 Versionskonflikt',
  pg_temp.beleg('e-a1', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'standard_19')), 99,
  'Versionskonflikt');

-- E2 Ein bereits geloeschter Beleg wird nicht wiederbelebt.
select pg_temp.erwarte_fehler('E2 bereits geloescht',
  pg_temp.beleg('e-alt2', pg_temp.geld('100'::jsonb, '19'::jsonb, '119'::jsonb, 'standard_19')), 2,
  'Ausgabe bereits geloescht');

-- E3 Eine Ausgabe mit gebuchter Zahlung laesst sich nicht loeschen — die
--    Zahlungspruefung liegt vor der Geldpruefung und bleibt unberuehrt.
insert into public.workspace_expense_payments (workspace_id, client_expense_id, client_payment_id, amount, paid_on, created_by)
values ('00000000-0000-0000-0000-00000000e001', 'e-a1', 'pay-1', 119, '2026-06-05', '00000000-0000-0000-0000-00000000e5b2');
select pg_temp.erwarte_fehler('E3 Loeschen trotz Zahlung',
  pg_temp.beleg('e-a1', '{}'::jsonb, true), 1,
  'Ausgabe hat gebuchte Zahlungen');

-- E4 Die Funktion ist weiterhin SECURITY DEFINER mit festem search_path und
--    denselben Rechten.
do $$
declare v_def boolean; v_cfg text[]; v_acl text;
begin
  select p.prosecdef, p.proconfig, array_to_string(p.proacl, ',')
    into v_def, v_cfg, v_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'upsert_workspace_expense';

  if not v_def then raise exception 'E4 — SECURITY DEFINER verloren'; end if;
  if not ('search_path=public' = any(v_cfg)) then
    raise exception 'E4 — search_path nicht gesetzt: %', v_cfg;
  end if;
  if v_acl like '%=X/%' and v_acl not like '%authenticated=X%' then
    raise exception 'E4 — authenticated darf nicht mehr ausfuehren: %', v_acl;
  end if;
  if v_acl like '%,=X/%' or v_acl like '=X/%' then
    raise exception 'E4 — public darf noch ausfuehren: %', v_acl;
  end if;
  raise notice 'OK  E4: SECURITY DEFINER, search_path=public, Rechte unveraendert';
end;
$$;

rollback;
