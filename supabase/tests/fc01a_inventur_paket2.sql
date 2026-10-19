-- FINANZ-CORE-01A -- Gesamtnacharbeit Paket 2 (Migration 20261120120000): atomarer Ausgabenvertrag.
-- Nachgestellt sind die Faelle der WEISS-Gesamtmaengelinventur vom 15.10.2026 (S5-S10) und die
-- Abnahmekriterien 5 und 6:
--   A  INV-08 Zahlung: Ueberzahlung mit/ohne Bestaetigung, gleiche/verschiedene Kennung, Entwurf, Gutschrift,
--      Storno, Loeschmarke, 0,004/0,005/1,005, NaN/Unendlich, ungueltiger Tag, Altaufrufer, Mitglied
--   B  INV-09 Lebenszyklus: Betrag/Steuer/Gutschrift nach Zahlung gebunden, kein Storno/Entwurf/Loeschen mit
--      Zahlung, Storno nur aus gebucht, storniert bleibt storniert, Replay unveraendert
--   C  Rechte
-- Die echten Zwei-Sitzungen-Wettlaeufe (INV-11) stehen in fc01a_inventur_ausgaben_parallel.mjs.
--
-- Setzt die Migrationen bis 20261120120000 voraus. Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_inventur_paket2.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles wird
-- zurueckgerollt.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-0000000fe401', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-inventur2-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-0000000fe402', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'fc01a-inventur2-mitglied@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like 'fc01a-inventur2-%@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fe40', 'FC01A Inventur Paket 2', '00000000-0000-0000-0000-0000000fe401');
insert into public.workspace_members (workspace_id, user_id, role, status)
values
  ('00000000-0000-0000-0000-00000000fe40', '00000000-0000-0000-0000-0000000fe401', 'owner', 'active'),
  ('00000000-0000-0000-0000-00000000fe40', '00000000-0000-0000-0000-0000000fe402', 'member', 'active');

create function pg_temp.als(p_user text) returns void language sql as $p$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$p$;

select pg_temp.als('00000000-0000-0000-0000-0000000fe401');

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

/* Ausgabe als Push des Clients: Status, Betraege (19 %), optional Titel und Gutschriftkennzeichen. */
create function pg_temp.ausgabe(p_id text, p_status text default 'gebucht', p_gross numeric default 119,
  p_titel text default 'Inventur', p_tax_status text default 'standard_19', p_deleted boolean default false)
returns jsonb language sql immutable as $p$
  select jsonb_build_object('client_expense_id', p_id, 'status', p_status, 'dedupe_key', p_id, 'deleted', p_deleted,
    'payload', jsonb_build_object('id', p_id, 'category', 'material', 'supplierName', 'Lieferant', 'title', p_titel,
      'issueDate', '2026-06-01', 'netAmount', round(p_gross / 1.19, 2), 'taxAmount', p_gross - round(p_gross / 1.19, 2),
      'grossAmount', p_gross, 'taxStatus', p_tax_status, 'isCreditNote', p_gross < 0));
$p$;

create function pg_temp.version(p_id text) returns bigint language sql stable as $p$
  select row_version from public.workspace_expenses
  where workspace_id = '00000000-0000-0000-0000-00000000fe40' and client_expense_id = p_id;
$p$;

create function pg_temp.schreibe(p_payload jsonb) returns jsonb language sql as $p$
  select public.upsert_workspace_expense('00000000-0000-0000-0000-00000000fe40', p_payload, pg_temp.version(p_payload->>'client_expense_id'));
$p$;

create function pg_temp.zahle(p_id text, p_pay text, p_betrag numeric, p_tag text default '2026-06-02', p_bestaetigt boolean default false)
returns void language sql as $p$
  select public.add_workspace_expense_payment('00000000-0000-0000-0000-00000000fe40', p_id, p_pay, p_betrag, p_tag,
    null, null, 'bank', p_bestaetigt);
$p$;

create function pg_temp.gezahlt(p_id text) returns numeric language sql stable as $p$
  select coalesce(sum(amount), 0) from public.workspace_expense_payments
  where workspace_id = '00000000-0000-0000-0000-00000000fe40' and client_expense_id = p_id and reversed_at is null;
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fe40';
begin
  /* ------------------------------------------------------------------ A -- INV-08 Zahlung */
  perform pg_temp.schreibe(pg_temp.ausgabe('a1'));
  perform pg_temp.zahle('a1', 'a1-p1', 119);
  perform pg_temp.erwarte_fehler('A1 WEISS S5: zweite Zahlung 119 ohne Bestätigung',
    $q$select pg_temp.zahle('a1', 'a1-p2', 119)$q$, 'expense_payment_overpayment_unconfirmed');
  perform pg_temp.erwarte_fehler('A1b Altaufrufer mit 8 Argumenten bekommt keine Bestätigung',
    $q$select public.add_workspace_expense_payment('00000000-0000-0000-0000-00000000fe40', 'a1', 'a1-p2', 119, '2026-06-02', null, null, 'bank')$q$,
    'expense_payment_overpayment_unconfirmed');
  perform pg_temp.zahle('a1', 'a1-p1', 119);
  if pg_temp.gezahlt('a1') is distinct from 119 then raise exception 'A1: Wiederholung derselben Kennung hat gebucht'; end if;
  raise notice 'OK  A1c Wiederholung derselben Kennung: keine zweite Zahlung';
  perform pg_temp.zahle('a1', 'a1-p2', 119, '2026-06-02', true);
  if pg_temp.gezahlt('a1') is distinct from 238 then raise exception 'A1: bestätigte Überzahlung nicht gebucht'; end if;
  raise notice 'OK  A1d bewusst bestätigte Überzahlung gebucht (238)';
  perform pg_temp.schreibe(pg_temp.ausgabe('a1t'));
  perform pg_temp.zahle('a1t', 'a1t-p1', 100);
  perform pg_temp.zahle('a1t', 'a1t-p2', 19);
  raise notice 'OK  A1e Teilzahlungen bis zum Betrag ohne Bestätigung';

  perform pg_temp.schreibe(pg_temp.ausgabe('a2', 'entwurf'));
  perform pg_temp.erwarte_fehler('A2 WEISS S8: Zahlung auf Entwurf', $q$select pg_temp.zahle('a2', 'a2-p', 10)$q$, 'expense_payment_not_payable');
  perform pg_temp.schreibe(pg_temp.ausgabe('a3', 'gebucht', -119));
  perform pg_temp.erwarte_fehler('A3 WEISS S9: positive Zahlung auf Gutschrift −119', $q$select pg_temp.zahle('a3', 'a3-p', 10, '2026-06-02', true)$q$,
    'expense_payment_not_payable: Gutschrift');
  perform pg_temp.schreibe(pg_temp.ausgabe('a4'));
  perform pg_temp.schreibe(pg_temp.ausgabe('a4', 'storniert'));
  perform pg_temp.erwarte_fehler('A4 Zahlung auf stornierte Ausgabe', $q$select pg_temp.zahle('a4', 'a4-p', 10)$q$, 'Ausgabe storniert');
  perform pg_temp.schreibe(pg_temp.ausgabe('a5'));
  perform pg_temp.schreibe(pg_temp.ausgabe('a5', 'gebucht', 119, 'Inventur', 'standard_19', true));
  perform pg_temp.erwarte_fehler('A5 Zahlung auf gelöschte Ausgabe', $q$select pg_temp.zahle('a5', 'a5-p', 10)$q$, 'Ausgabe geloescht');

  perform pg_temp.schreibe(pg_temp.ausgabe('a6'));
  perform pg_temp.erwarte_fehler('A6a WEISS S10: 0,004', $q$select pg_temp.zahle('a6', 'a6-p0', 0.004)$q$, 'amount ungueltig');
  perform pg_temp.erwarte_fehler('A6b NaN', $q$select pg_temp.zahle('a6', 'a6-p1', 'NaN'::numeric)$q$, 'amount ungueltig');
  perform pg_temp.erwarte_fehler('A6c Unendlich', $q$select pg_temp.zahle('a6', 'a6-p2', 'Infinity'::numeric)$q$, 'amount ungueltig');
  perform pg_temp.erwarte_fehler('A6d ungültiger Tag 30.02.', $q$select pg_temp.zahle('a6', 'a6-p3', 10, '2026-02-30')$q$, 'paid_on ungueltig');
  perform pg_temp.erwarte_fehler('A6e negativer Betrag', $q$select pg_temp.zahle('a6', 'a6-p4', -10)$q$, 'amount ungueltig');
  perform pg_temp.zahle('a6', 'a6-p5', 0.005);
  perform pg_temp.zahle('a6', 'a6-p6', 1.005);
  if (select array_agg(amount order by client_payment_id) from public.workspace_expense_payments
      where workspace_id = ws and client_expense_id = 'a6') is distinct from array[0.01, 1.01]::numeric[] then
    raise exception 'A6: Centnormalisierung (0,005 -> 0,01; 1,005 -> 1,01) verletzt';
  end if;
  raise notice 'OK  A6f 0,005 -> 0,01 und 1,005 -> 1,01 (kaufmännisch, wie der Client)';

  perform pg_temp.als('00000000-0000-0000-0000-0000000fe402');
  perform pg_temp.erwarte_fehler('A7 Mitglied zahlt nicht', $q$select pg_temp.zahle('a6', 'a6-p7', 1)$q$, 'finance_forbidden_role');
  perform pg_temp.als('00000000-0000-0000-0000-0000000fe401');

  /* ------------------------------------------------------------------ B -- INV-09 Lebenszyklus */
  perform pg_temp.schreibe(pg_temp.ausgabe('b1'));
  perform pg_temp.zahle('b1', 'b1-p', 119);
  perform pg_temp.erwarte_fehler('B1a WEISS S6: Betrag 119 -> 238 nach Zahlung',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 238))$q$, 'expense_amount_locked_after_payment');
  perform pg_temp.erwarte_fehler('B1b Steuerstatus nach Zahlung',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 119, 'Inventur', 'unclear'))$q$, 'expense_amount_locked_after_payment');
  perform pg_temp.erwarte_fehler('B1c Gutschriftkennzeichen nach Zahlung',
    $q$select pg_temp.schreibe(jsonb_set(pg_temp.ausgabe('b1'), '{payload,isCreditNote}', 'true'::jsonb))$q$, 'expense_amount_locked_after_payment');
  perform pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 119, 'Inventur (Titel geändert)'));
  raise notice 'OK  B1d Titel nach Zahlung änderbar (kein Geldfeld)';
  perform pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 119, 'Inventur (Titel geändert)'));
  raise notice 'OK  B1e Replay unveränderter Zeile mit Zahlung';
  perform pg_temp.erwarte_fehler('B2 WEISS S7: Storno trotz Zahlung',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b1', 'storniert', 119, 'Inventur (Titel geändert)'))$q$, 'expense_cancel_has_payments');
  perform pg_temp.erwarte_fehler('B3 zurück in Entwurf trotz Zahlung',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b1', 'entwurf', 119, 'Inventur (Titel geändert)'))$q$, 'expense_status_locked_after_payment');
  perform pg_temp.erwarte_fehler('B4 Löschmarke trotz Zahlung',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 119, 'Inventur (Titel geändert)', 'standard_19', true))$q$, 'Ausgabe hat gebuchte Zahlungen');
  if (select status from public.workspace_expenses where workspace_id = ws and client_expense_id = 'b1') is distinct from 'gebucht'
     or (select payload->>'grossAmount' from public.workspace_expenses where workspace_id = ws and client_expense_id = 'b1') is distinct from '119'
     or (select deleted from public.workspace_expenses where workspace_id = ws and client_expense_id = 'b1') then
    raise exception 'B: abgewiesene Änderung hat die Ausgabe verändert';
  end if;
  raise notice 'OK  B4b Ausgabe unverändert: gebucht, 119, nicht gelöscht';
  -- Nach der Ruecknahme der Zahlung ist die Ausgabe wieder frei.
  perform public.reverse_workspace_expense_payment(ws, 'b1', 'b1-p');
  perform pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 238, 'Inventur (Titel geändert)'));
  perform pg_temp.schreibe(pg_temp.ausgabe('b1', 'storniert', 238, 'Inventur (Titel geändert)'));
  raise notice 'OK  B5 nach Rücknahme der Zahlung: Betrag änderbar, Storno möglich';
  perform pg_temp.erwarte_fehler('B6 storniert bleibt storniert',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b1', 'gebucht', 238, 'Inventur (Titel geändert)'))$q$, 'expense_cancelled_immutable');
  perform pg_temp.schreibe(pg_temp.ausgabe('b7', 'entwurf'));
  perform pg_temp.erwarte_fehler('B7 Storno nur aus gebucht (Entwurf)',
    $q$select pg_temp.schreibe(pg_temp.ausgabe('b7', 'storniert'))$q$, 'expense_cancel_not_booked');
  perform pg_temp.schreibe(pg_temp.ausgabe('b7', 'gebucht'));
  perform pg_temp.zahle('b7', 'b7-p', 50);
  perform public.reverse_workspace_expense_payment(ws, 'b7', 'b7-p');
  perform public.reverse_workspace_expense_payment(ws, 'b7', 'b7-p');
  raise notice 'OK  B8 Rücknahme wiederholbar (gleiche Zeile)';

  /* ------------------------------------------------------------------ C -- Rechte */
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'add_workspace_expense_payment' and p.pronargs = 8) then
    raise exception 'C: alte 8-Argument-Fassung besteht noch (mehrdeutiger Aufruf)';
  end if;
  if has_function_privilege('anon', 'public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text, boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.upsert_workspace_expense(uuid, jsonb, bigint)', 'execute')
     or has_function_privilege('anon', 'public.reverse_workspace_expense_payment(uuid, text, text)', 'execute')
     or not (select prosecdef from pg_proc where oid = 'public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text, boolean)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.upsert_workspace_expense(uuid, jsonb, bigint)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.reverse_workspace_expense_payment(uuid, text, text)'::regprocedure) then
    raise exception 'C: Rechte oder SECURITY DEFINER der Ausgabenfunktionen falsch';
  end if;
  raise notice 'OK  C Rechte: nur angemeldet, SECURITY DEFINER, keine 8-Argument-Fassung';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
