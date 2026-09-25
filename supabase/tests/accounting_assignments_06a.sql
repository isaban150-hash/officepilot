-- STEUERBERATER-06A — Laufzeittest der Kontierungstabelle und ihrer RPCs.
--
-- Prueft die **reale** SQL-Semantik gegen eine lokale Datenbank:
--
--   1. Eine Kontierung je Beleg, Grabsteine ausgenommen.
--   2. Bestaetigt nur mit Sachkonto und mit Zeitpunkt.
--   3. Der Beleg einer Kontierung ist unveraenderlich.
--   4. Versionskonflikt, Grabstein und No-op wie im uebrigen Sync.
--   5. Workspace-Isolation ueber RLS.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/accounting_assignments_06a.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, alles wird
-- zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000060a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'kontierung-06a@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-00000000060b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-06a@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000a0001', 'Kontierung-06A', '00000000-0000-0000-0000-00000000060a'),
       ('00000000-0000-0000-0000-0000000a0002', 'Fremder Betrieb', '00000000-0000-0000-0000-00000000060b');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000060a', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000060b', 'owner', 'active');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000060a","role":"authenticated"}', true);

/* ------------------------------------------------------------------ */
/* Hilfen                                                              */
/* ------------------------------------------------------------------ */

create function pg_temp.auftrag(
  p_id text,
  p_source_type text,
  p_source_id text,
  p_payload jsonb,
  p_deleted boolean default false
) returns jsonb language sql as $p$
  select jsonb_build_object(
    'client_assignment_id', p_id,
    'source_type', p_source_type,
    'source_id', p_source_id,
    'deleted', p_deleted,
    'payload', p_payload
  );
$p$;

/** Eine gueltige, noch nicht bestaetigte Kontierung. */
create function pg_temp.entwurf(p_overrides jsonb default '{}'::jsonb)
returns jsonb language sql as $p$
  select '{
    "chartOfAccounts": "SKR03",
    "accountNumber": "",
    "accountLabel": "",
    "taxTreatment": "standard_19",
    "bookingText": "Baustoff Sued GmbH RE-1",
    "status": "needs_review",
    "origin": "suggested"
  }'::jsonb || p_overrides;
$p$;

create function pg_temp.ok(p_label text, p_payload jsonb, p_version bigint)
returns bigint language plpgsql as $p$
declare v jsonb;
begin
  v := public.upsert_workspace_accounting_assignment(
         '00000000-0000-0000-0000-0000000a0001', p_payload, p_version);
  raise notice 'OK         %  -> row_version %', p_label, v->>'row_version';
  return (v->>'row_version')::bigint;
end;
$p$;

create function pg_temp.nein(p_label text, p_payload jsonb, p_version bigint, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.upsert_workspace_accounting_assignment(
      '00000000-0000-0000-0000-0000000a0001', p_payload, p_version);
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% -- falscher Fehler: % (erwartet: %)', p_label, sqlerrm, p_expected;
    end if;
    raise notice 'ABGELEHNT  %  -> %', p_label, p_expected;
    return;
  end;
  raise exception '% -- kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

/* ================================================================== */
/* A — der normale Weg                                                */
/* ================================================================== */

select pg_temp.ok('A1 Vorschlag anlegen',
  pg_temp.auftrag('k1', 'expense', 'exp-1', pg_temp.entwurf()), null);

-- A2 Der Nutzer traegt ein Konto ein — weiterhin ungeprueft.
select pg_temp.ok('A2 Konto ergaenzt, noch nicht bestaetigt',
  pg_temp.auftrag('k1', 'expense', 'exp-1',
    pg_temp.entwurf('{"accountNumber":"4930","accountLabel":"Buerobedarf","origin":"manual"}'::jsonb)), 1);

-- A3 Und bestaetigt.
select pg_temp.ok('A3 bestaetigt',
  pg_temp.auftrag('k1', 'expense', 'exp-1',
    pg_temp.entwurf('{"accountNumber":"4930","accountLabel":"Buerobedarf","origin":"manual",
                     "status":"confirmed","confirmedAt":"2026-09-24T10:00:00.000Z"}'::jsonb)), 2);

-- A4 Eine Ausgangsrechnung bekommt ihre eigene Kontierung.
select pg_temp.ok('A4 Ausgangsrechnung',
  pg_temp.auftrag('k2', 'invoice', 'inv-1',
    pg_temp.entwurf('{"bookingText":"AZ Testbau GmbH 2026-0001"}'::jsonb)), null);

/* ================================================================== */
/* B — die beiden harten Regeln                                       */
/* ================================================================== */

select pg_temp.nein('B1 bestaetigt ohne Sachkonto',
  pg_temp.auftrag('k3', 'expense', 'exp-3',
    pg_temp.entwurf('{"status":"confirmed","confirmedAt":"2026-09-24T10:00:00.000Z"}'::jsonb)), null,
  'accounting_confirmed_without_account');

select pg_temp.nein('B2 bestaetigt ohne Zeitpunkt',
  pg_temp.auftrag('k3', 'expense', 'exp-3',
    pg_temp.entwurf('{"status":"confirmed","accountNumber":"4930"}'::jsonb)), null,
  'accounting_confirmed_without_timestamp');

-- B3 Ein Konto aus lauter Leerzeichen ist kein Konto.
select pg_temp.nein('B3 bestaetigt mit leerem Konto',
  pg_temp.auftrag('k3', 'expense', 'exp-3',
    pg_temp.entwurf('{"status":"confirmed","accountNumber":"   ","confirmedAt":"2026-09-24T10:00:00.000Z"}'::jsonb)), null,
  'accounting_confirmed_without_account');

select pg_temp.nein('B4 unbekannter Status',
  pg_temp.auftrag('k3', 'expense', 'exp-3', pg_temp.entwurf('{"status":"erledigt"}'::jsonb)), null,
  'accounting_status_invalid');

select pg_temp.nein('B5 unbekannte Herkunft',
  pg_temp.auftrag('k3', 'expense', 'exp-3', pg_temp.entwurf('{"origin":"magie"}'::jsonb)), null,
  'accounting_origin_invalid');

select pg_temp.nein('B6 unbekannter Kontenrahmen',
  pg_temp.auftrag('k3', 'expense', 'exp-3', pg_temp.entwurf('{"chartOfAccounts":"SKR42"}'::jsonb)), null,
  'accounting_chart_invalid');

select pg_temp.nein('B7 unbekannter Belegtyp',
  pg_temp.auftrag('k3', 'angebot', 'off-1', pg_temp.entwurf()), null,
  'source_type ungueltig');

/* ================================================================== */
/* C — eine Kontierung je Beleg                                       */
/* ================================================================== */

select pg_temp.nein('C1 zweite Kontierung auf denselben Beleg',
  pg_temp.auftrag('k-doppelt', 'expense', 'exp-1', pg_temp.entwurf()), null,
  'workspace_accounting_assignments_source_unique');

-- C2 Der Beleg einer bestehenden Kontierung wechselt nicht.
select pg_temp.nein('C2 Beleg wechseln',
  pg_temp.auftrag('k2', 'invoice', 'inv-ANDERS', pg_temp.entwurf()), 1,
  'accounting_source_immutable');

/* ================================================================== */
/* D — Grabstein, Version, No-op                                      */
/* ================================================================== */

select pg_temp.nein('D1 Versionskonflikt',
  pg_temp.auftrag('k1', 'expense', 'exp-1', pg_temp.entwurf()), 99,
  'Versionskonflikt');

-- D2 Loeschen geht auch bei einer Nutzlast, die die Pruefung nicht bestuende.
select pg_temp.ok('D2 Grabstein',
  pg_temp.auftrag('k2', 'invoice', 'inv-1', '{"status":"kaputt"}'::jsonb, true), 1);

do $$
begin
  if not exists (select 1 from public.workspace_accounting_assignments
                 where client_assignment_id = 'k2' and deleted) then
    raise exception 'D2 -- der Grabstein wurde nicht gesetzt';
  end if;
  raise notice 'OK         D2b Grabstein gesetzt';
end;
$$;

-- D3 Nach dem Loeschen ist derselbe Beleg wieder frei.
select pg_temp.ok('D3 neue Kontierung nach Loeschen',
  pg_temp.auftrag('k2-neu', 'invoice', 'inv-1', pg_temp.entwurf()), null);

select pg_temp.nein('D4 geloeschte Kontierung wiederbeleben',
  pg_temp.auftrag('k2', 'invoice', 'inv-1', pg_temp.entwurf()), 2,
  'Kontierung bereits geloescht');

do $$
declare v jsonb;
begin
  v := public.upsert_workspace_accounting_assignment(
         '00000000-0000-0000-0000-0000000a0001',
         pg_temp.auftrag('k-nie', 'expense', 'exp-nie', '{}'::jsonb, true), null);
  if coalesce((v->>'noop')::boolean, false) is not true then
    raise exception 'D5 -- erwartet war ein No-op, erhalten: %', v;
  end if;
  raise notice 'OK         D5 unbekannter Grabstein bleibt No-op';
end;
$$;

/* ================================================================== */
/* E — Lesen und Isolation                                            */
/* ================================================================== */

do $$
declare v jsonb; v_count int;
begin
  v := public.pull_workspace_accounting_assignments('00000000-0000-0000-0000-0000000a0001');
  v_count := jsonb_array_length(v->'assignments');
  -- k1 (bestaetigt), k2 (Grabstein), k2-neu
  if v_count <> 3 then
    raise exception 'E1 -- erwartet 3 Zeilen, erhalten %', v_count;
  end if;
  raise notice 'OK         E1 pull liefert % Zeilen inklusive Grabstein', v_count;
end;
$$;

-- E2 Ein fremder Workspace ist nicht lesbar.
do $$
begin
  begin
    perform public.pull_workspace_accounting_assignments('00000000-0000-0000-0000-0000000a0002');
  exception when others then
    if position('Kein Zugriff' in sqlerrm) = 0 then
      raise exception 'E2 -- falscher Fehler: %', sqlerrm;
    end if;
    raise notice 'ABGELEHNT  E2 fremder Workspace';
    return;
  end;
  raise exception 'E2 -- fremder Workspace war lesbar';
end;
$$;

-- E3 RLS: die Tabelle selbst gibt nur den eigenen Workspace heraus.
insert into public.workspace_accounting_assignments
  (workspace_id, client_assignment_id, source_type, source_id, payload)
values ('00000000-0000-0000-0000-0000000a0002', 'fremd-1', 'expense', 'exp-fremd', '{}'::jsonb);

do $$
declare v_count int;
begin
  set local role authenticated;
  select count(*) into v_count from public.workspace_accounting_assignments;
  reset role;
  if v_count <> 3 then
    raise exception 'E3 -- RLS gibt % Zeilen heraus, erwartet 3', v_count;
  end if;
  raise notice 'OK         E3 RLS zeigt nur den eigenen Workspace';
end;
$$;

-- E4 Der Dienst behauptet keine doppelte Buchfuehrung.
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'upsert_workspace_accounting_assignment';
  if v_src ~* 'gegenkonto|buchungssatz|festschreib' then
    raise exception 'E4 -- die Funktion behauptet mehr als eine Kontierung';
  end if;
  raise notice 'OK         E4 kein Gegenkonto, kein Buchungssatz, keine Festschreibung';
end;
$$;

rollback;
