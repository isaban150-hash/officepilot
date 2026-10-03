-- R1-SEC-01 — Laufzeittest der serverseitigen Autorisierung finanzwirksamer Aktionen.
--
-- Geprueft wird nicht die Guard-Funktion fuer sich, sondern jeder der zehn
-- **echten** RPC-Einstiegspunkte. Das ist der Kern: Ein Guard, den man umgehen
-- kann, indem man den RPC direkt aufruft, waere keiner.
--
-- Die Aufrufe tragen bewusst minimale Nutzlast. Der Guard steht als erste
-- Anweisung im Rumpf, also entscheidet sich die Autorisierung, bevor irgendeine
-- Fachpruefung greift. Fuer abgewiesene Faelle muss exakt der Guard-Code
-- kommen; fuer erlaubte Faelle darf **kein** Guard-Code kommen — welcher
-- Fachfehler danach folgt, ist hier gleichgueltig und wird nicht geprueft.
--
--   A  owner, freigegeben + lizenziert      -> Guard laesst durch (alle zehn)
--   B  admin, freigegeben + lizenziert      -> Guard laesst durch (alle zehn)
--   C  member                                -> abgewiesen (alle zehn)
--   D  Konto gesperrt                        -> abgewiesen (alle zehn)
--   E  Lizenz abgelaufen                     -> abgewiesen (alle zehn)
--
-- Nacharbeit 1: 9 und 10 sind `cancel_workspace_invoice` und
-- `reopen_workspace_accounting_period` — die beiden Nachbarn, die der Recheck
-- als offen nachgewiesen hat.
--   F  Lizenz inaktiv / Konto nicht freigegeben -> abgewiesen
--   G  nicht angemeldet                      -> abgewiesen
--   H  fremder Workspace                     -> abgewiesen
--   I  Ablaufdatum in der Vergangenheit      -> abgewiesen
--   J  Fachlogik fuer owner bleibt erhalten  -> echter Geschaeftsvorfall laeuft durch
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/financial_action_authorization_r1sec01.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

/* ------------------------------------------------------------------ */
/* Beteiligte                                                          */
/* ------------------------------------------------------------------ */

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000a0001'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0002'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'admin-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0003'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0004'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'blocked-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0005'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'expired-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0006'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'pending-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0007'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'ablauf-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000a0008'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-r1sec@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

/*
 * Kontozustaende. Der erlaubte Zustand ist derselbe, den
 * `licenseService.isUserAllowedToUseApp` im Client verlangt.
 */
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
 where email in ('owner-r1sec@example.invalid', 'admin-r1sec@example.invalid',
                 'member-r1sec@example.invalid', 'fremd-r1sec@example.invalid');
update public.profiles set status = 'blocked',  license_status = 'active'
 where email = 'blocked-r1sec@example.invalid';
update public.profiles set status = 'approved', license_status = 'expired'
 where email = 'expired-r1sec@example.invalid';
-- Nie freigegeben, nie lizenziert — der Zustand direkt nach der Registrierung.
update public.profiles set status = 'pending',  license_status = 'inactive'
 where email = 'pending-r1sec@example.invalid';
-- Formal aktiv, aber das Ablaufdatum liegt hinter uns.
update public.profiles set status = 'approved', license_status = 'active',
       license_expires_at = now() - interval '1 day'
 where email = 'ablauf-r1sec@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000ec01'::uuid, 'R1-SEC Betrieb',  '00000000-0000-0000-0000-0000000a0001'::uuid),
       ('00000000-0000-0000-0000-00000000ec02'::uuid, 'R1-SEC Gesperrt', '00000000-0000-0000-0000-0000000a0004'::uuid),
       ('00000000-0000-0000-0000-00000000ec03'::uuid, 'R1-SEC Abgelaufen','00000000-0000-0000-0000-0000000a0005'::uuid),
       ('00000000-0000-0000-0000-00000000ec04'::uuid, 'R1-SEC Wartend',  '00000000-0000-0000-0000-0000000a0006'::uuid),
       ('00000000-0000-0000-0000-00000000ec05'::uuid, 'R1-SEC Ablauf',   '00000000-0000-0000-0000-0000000a0007'::uuid),
       ('00000000-0000-0000-0000-00000000ec09'::uuid, 'R1-SEC Fremd',    '00000000-0000-0000-0000-0000000a0008'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000ec01'::uuid, '00000000-0000-0000-0000-0000000a0001'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000ec01'::uuid, '00000000-0000-0000-0000-0000000a0002'::uuid, 'admin',  'active'),
       ('00000000-0000-0000-0000-00000000ec01'::uuid, '00000000-0000-0000-0000-0000000a0003'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000000ec02'::uuid, '00000000-0000-0000-0000-0000000a0004'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000ec03'::uuid, '00000000-0000-0000-0000-0000000a0005'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000ec04'::uuid, '00000000-0000-0000-0000-0000000a0006'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000ec05'::uuid, '00000000-0000-0000-0000-0000000a0007'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000ec09'::uuid, '00000000-0000-0000-0000-0000000a0008'::uuid, 'owner',  'active');

/* ------------------------------------------------------------------ */
/* Werkzeuge                                                           */
/* ------------------------------------------------------------------ */

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
$p$;

create function pg_temp.abmelden() returns void language sql as $p$
  select set_config('request.jwt.claims', '{"role":"anon"}', true)::void;
$p$;

/** Die acht Einstiegspunkte, jeder mit minimaler Nutzlast. */
create function pg_temp.ruf(p_nr integer, p_ws uuid) returns void language plpgsql as $p$
begin
  case p_nr
    when 1 then perform public.finalize_workspace_invoice(p_ws, 'v-sec', 'inv-sec', '{}'::jsonb);
    when 2 then perform public.add_workspace_invoice_payment(p_ws, 'inv-sec', 'pay-sec', 10, '2026-01-02');
    when 3 then perform public.reverse_workspace_invoice_payment(p_ws, 'inv-sec', 'pay-sec');
    when 4 then perform public.add_workspace_expense_payment(p_ws, 'exp-sec', 'pay-sec', 10, '2026-01-02');
    when 5 then perform public.reverse_workspace_expense_payment(p_ws, 'exp-sec', 'pay-sec');
    when 6 then perform public.upsert_workspace_expense(p_ws, '{}'::jsonb, 0);
    when 7 then perform public.upsert_workspace_accounting_assignment(p_ws, '{}'::jsonb, 0);
    when 8 then perform public.close_workspace_accounting_period(p_ws, '{}'::jsonb);
    -- Nacharbeit 1
    when 9 then perform public.cancel_workspace_invoice(p_ws, 'inv-sec', 'Grund');
    when 10 then perform public.reopen_workspace_accounting_period(p_ws, 2026, 9, 'Grund', 1);
  end case;
end;
$p$;

create function pg_temp.name(p_nr integer) returns text language sql as $p$
  select (array['finalize_workspace_invoice','add_workspace_invoice_payment',
                'reverse_workspace_invoice_payment','add_workspace_expense_payment',
                'reverse_workspace_expense_payment','upsert_workspace_expense',
                'upsert_workspace_accounting_assignment','close_workspace_accounting_period',
                'cancel_workspace_invoice','reopen_workspace_accounting_period'])[p_nr];
$p$;

/** Erwartet, dass der Guard mit genau diesem Code abweist. */
create function pg_temp.abgewiesen(p_label text, p_nr integer, p_ws uuid, p_code text)
returns void language plpgsql as $p$
begin
  begin
    perform pg_temp.ruf(p_nr, p_ws);
  exception when others then
    if position(p_code in sqlerrm) = 0 then
      raise exception '% / % -- falsche Abweisung: % (erwartet: %)',
        p_label, pg_temp.name(p_nr), sqlerrm, p_code;
    end if;
    return;
  end;
  raise exception '% / % -- NICHT abgewiesen, % erwartet',
    p_label, pg_temp.name(p_nr), p_code;
end;
$p$;

/**
 * Erwartet, dass der Guard **nicht** abweist. Ein Fachfehler danach ist in
 * Ordnung — er beweist sogar, dass der Aufruf die Fachlogik erreicht hat.
 */
create function pg_temp.durchgelassen(p_label text, p_nr integer, p_ws uuid)
returns void language plpgsql as $p$
begin
  begin
    perform pg_temp.ruf(p_nr, p_ws);
  exception when others then
    if sqlerrm like 'finance_%'
       or sqlerrm = 'Kein Zugriff auf Workspace'
       or sqlerrm = 'Nicht angemeldet' then
      raise exception '% / % -- vom Guard abgewiesen, obwohl erlaubt: %',
        p_label, pg_temp.name(p_nr), sqlerrm;
    end if;
    return;
  end;
end;
$p$;

/* ------------------------------------------------------------------ */
/* A/B — erlaubte Konten kommen durch                                  */
/* ------------------------------------------------------------------ */

do $$
declare i integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0001'::uuid);
  for i in 1..10 loop
    perform pg_temp.durchgelassen('A owner', i, '00000000-0000-0000-0000-00000000ec01'::uuid);
  end loop;
  raise notice 'OK  A -- owner (freigegeben, lizenziert) passiert alle zehn';

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0002'::uuid);
  for i in 1..10 loop
    perform pg_temp.durchgelassen('B admin', i, '00000000-0000-0000-0000-00000000ec01'::uuid);
  end loop;
  raise notice 'OK  B -- admin (freigegeben, lizenziert) passiert alle zehn';
end $$;

/* ------------------------------------------------------------------ */
/* C — member darf keine Finanzaktion                                  */
/* ------------------------------------------------------------------ */

do $$
declare i integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0003'::uuid);
  for i in 1..10 loop
    perform pg_temp.abgewiesen('C member', i, '00000000-0000-0000-0000-00000000ec01'::uuid,
      'finance_forbidden_role');
  end loop;
  raise notice 'OK  C -- member wird bei allen zehn abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* D/E/F/I — Kontozustand                                              */
/* ------------------------------------------------------------------ */

do $$
declare i integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0004'::uuid);
  for i in 1..10 loop
    perform pg_temp.abgewiesen('D gesperrt', i, '00000000-0000-0000-0000-00000000ec02'::uuid,
      'finance_account_blocked');
  end loop;
  raise notice 'OK  D -- gesperrtes Konto wird bei allen zehn abgewiesen';

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0005'::uuid);
  for i in 1..10 loop
    perform pg_temp.abgewiesen('E abgelaufen', i, '00000000-0000-0000-0000-00000000ec03'::uuid,
      'finance_license_expired');
  end loop;
  raise notice 'OK  E -- abgelaufene Lizenz wird bei allen zehn abgewiesen';

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0006'::uuid);
  for i in 1..10 loop
    perform pg_temp.abgewiesen('F wartend', i, '00000000-0000-0000-0000-00000000ec04'::uuid,
      'finance_account_not_approved');
  end loop;
  raise notice 'OK  F -- nicht freigegebenes Konto wird bei allen zehn abgewiesen';

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0007'::uuid);
  for i in 1..10 loop
    perform pg_temp.abgewiesen('I Ablaufdatum', i, '00000000-0000-0000-0000-00000000ec05'::uuid,
      'finance_license_expired');
  end loop;
  raise notice 'OK  I -- abgelaufenes Lizenzdatum wird bei allen zehn abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* G/H — ohne Anmeldung, fremder Workspace                             */
/* ------------------------------------------------------------------ */

do $$
declare i integer;
begin
  perform pg_temp.abmelden();
  for i in 1..10 loop
    perform pg_temp.abgewiesen('G nicht angemeldet', i, '00000000-0000-0000-0000-00000000ec01'::uuid,
      'Nicht angemeldet');
  end loop;
  raise notice 'OK  G -- ohne Anmeldung wird bei allen zehn abgewiesen';

  /*
   * Ein voll freigegebener owner eines **anderen** Betriebs. Rolle und
   * Kontozustand sind tadellos — nur gehoert ihm dieser Workspace nicht.
   */
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0008'::uuid);
  for i in 1..10 loop
    perform pg_temp.abgewiesen('H fremd', i, '00000000-0000-0000-0000-00000000ec01'::uuid,
      'Kein Zugriff auf Workspace');
  end loop;
  raise notice 'OK  H -- fremder Workspace wird bei allen zehn abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* J — die Fachlogik eines erlaubten Kontos bleibt unberuehrt          */
/* ------------------------------------------------------------------ */

do $$
declare v jsonb; v_zahlungen integer; v_ws uuid := '00000000-0000-0000-0000-00000000ec01'::uuid;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000a0001'::uuid);

  -- Ein echter Geschaeftsvorfall, kein Minimalaufruf: Ausgabe anlegen.
  v := public.upsert_workspace_expense(v_ws, jsonb_build_object(
        'client_expense_id', 'exp-r1sec-1',
        'payload', jsonb_build_object(
          'id', 'exp-r1sec-1', 'status', 'gebucht', 'category', 'material',
          'supplierName', 'Beispiel GmbH', 'invoiceNumber', 'RE-R1', 'title', 'Material',
          'issueDate', '2026-01-02', 'taxStatus', 'standard_19',
          'netAmount', 100, 'taxAmount', 19, 'grossAmount', 119),
        'deleted', false), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'J -- Ausgabe wurde nicht angelegt: %', v;
  end if;

  -- Und eine Zahlung darauf. Die Funktion liefert die angelegte Zahlzeile.
  select count(*) into v_zahlungen
  from public.add_workspace_expense_payment(v_ws, 'exp-r1sec-1', 'pay-r1sec-1', 119, '2026-01-03');
  if v_zahlungen <> 1 then raise exception 'J -- Zahlung wurde nicht gebucht (% Zeilen)', v_zahlungen; end if;

  raise notice 'OK  J -- owner arbeitet unveraendert weiter';
end $$;

/* ------------------------------------------------------------------ */

do $$
begin
  raise notice '--------------------------------------------------';
  raise notice 'R1-SEC-01: alle Zusicherungen erfuellt.';
  raise notice '--------------------------------------------------';
end $$;

rollback;
