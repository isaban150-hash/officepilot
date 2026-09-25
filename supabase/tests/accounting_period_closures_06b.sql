-- STEUERBERATER-06B — Laufzeittest der Monatsabschluesse.
--
-- Prueft die **reale** SQL-Semantik gegen eine lokale Datenbank:
--
--   1. Abschluss erzeugt Revision 1 mit Fingerprint und Manifest.
--   2. Derselbe Stand erneut = Replay, keine zweite Revision.
--   3. Ein **anderer** Stand ueberschreibt die aktive Revision nicht.
--   4. Wiederoeffnen mit Audit; danach entsteht Revision 2.
--   5. Revision 1 bleibt unveraendert — Fingerprint und Manifest.
--   6. Struktur- und Periodenpruefungen.
--   7. Workspace-Isolation ueber RLS.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/accounting_period_closures_06b.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000060b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'abschluss-06b@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000006bf', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-06b@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000b0001', 'Abschluss-06B', '00000000-0000-0000-0000-00000000060b'),
       ('00000000-0000-0000-0000-0000000b0002', 'Fremder Betrieb', '00000000-0000-0000-0000-0000000006bf');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000060b', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000006bf', 'owner', 'active');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000060b","role":"authenticated"}', true);

/* ------------------------------------------------------------------ */

create function pg_temp.manifest(p_month text, p_count integer default 2)
returns jsonb language sql as $p$
  select jsonb_build_object(
    'monthKey', p_month,
    'chartOfAccounts', 'SKR03',
    'documentCount', p_count,
    'entries', jsonb_build_array(
      jsonb_build_object('sourceType','expense','sourceId','exp-1','accountNumber','4930'),
      jsonb_build_object('sourceType','invoice','sourceId','inv-1','accountNumber','8400')
    )
  );
$p$;

create function pg_temp.abschluss(
  p_id text, p_year integer, p_month integer, p_fingerprint text, p_manifest jsonb default null
) returns jsonb language sql as $p$
  select jsonb_build_object(
    'client_closure_id', p_id,
    'period_year', p_year,
    'period_month', p_month,
    'fingerprint', p_fingerprint,
    'manifest', coalesce(p_manifest,
      pg_temp.manifest(lpad(p_year::text,4,'0') || '-' || lpad(p_month::text,2,'0')))
  );
$p$;

create function pg_temp.ok(p_label text, p_payload jsonb)
returns jsonb language plpgsql as $p$
declare v jsonb;
begin
  v := public.close_workspace_accounting_period('00000000-0000-0000-0000-0000000b0001', p_payload);
  raise notice 'OK         %  -> Revision %, noop %', p_label, v->>'revision', v->>'noop';
  return v;
end;
$p$;

create function pg_temp.nein(p_label text, p_payload jsonb, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.close_workspace_accounting_period('00000000-0000-0000-0000-0000000b0001', p_payload);
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
/* A — abschliessen                                                   */
/* ================================================================== */

do $$
declare v jsonb;
begin
  v := pg_temp.ok('A1 Revision 1', pg_temp.abschluss('c1', 2026, 9, 'p1:aaaa:100'));
  if (v->>'revision')::int <> 1 then raise exception 'A1 -- Revision ist nicht 1'; end if;
  if (v->>'noop')::boolean then raise exception 'A1 -- faelschlich als Replay gewertet'; end if;
end;
$$;

-- A2 Fingerprint, Manifest, Zeitpunkt und Benutzer sind festgehalten.
do $$
declare r public.workspace_accounting_period_closures;
begin
  select * into r from public.workspace_accounting_period_closures where client_closure_id = 'c1';
  if r.fingerprint <> 'p1:aaaa:100' then raise exception 'A2 -- Fingerprint fehlt'; end if;
  if jsonb_array_length(r.manifest->'entries') <> 2 then raise exception 'A2 -- Manifest fehlt'; end if;
  if r.closed_at is null or r.closed_by is null then raise exception 'A2 -- Abschlussspur fehlt'; end if;
  if r.reopened_at is not null then raise exception 'A2 -- faelschlich als geoeffnet'; end if;
  raise notice 'OK         A2 Fingerprint, Manifest, closedAt und closedBy gespeichert';
end;
$$;

/*
 * A3 — derselbe Stand noch einmal. Ein Replay nach Verbindungsabbruch darf
 * keine zweite Revision erzeugen.
 */
do $$
declare v jsonb; v_count integer;
begin
  v := pg_temp.ok('A3 identischer Abschluss', pg_temp.abschluss('c1', 2026, 9, 'p1:aaaa:100'));
  if (v->>'noop')::boolean is not true then raise exception 'A3 -- kein Replay erkannt'; end if;
  select count(*) into v_count from public.workspace_accounting_period_closures
   where period_year = 2026 and period_month = 9;
  if v_count <> 1 then raise exception 'A3 -- % Revisionen statt 1', v_count; end if;
end;
$$;

/*
 * A4 — ein **anderer** Stand waere ein stilles Ueberschreiben der aktiven
 * Revision. Dafuer muss der Monat erst bewusst wieder geoeffnet werden.
 */
select pg_temp.nein('A4 anderer Stand auf offenen Abschluss',
  pg_temp.abschluss('c2', 2026, 9, 'p1:bbbb:200'), 'period_already_closed');

/* ================================================================== */
/* B — Struktur- und Periodenpruefungen                               */
/* ================================================================== */

select pg_temp.nein('B1 ohne Fingerprint',
  jsonb_build_object('client_closure_id','c9','period_year',2026,'period_month',8,
                     'manifest', pg_temp.manifest('2026-08')),
  'closure_without_fingerprint');

select pg_temp.nein('B2 Manifest ohne entries',
  jsonb_build_object('client_closure_id','c9','period_year',2026,'period_month',8,
                     'fingerprint','p1:x:1','manifest', jsonb_build_object('monthKey','2026-08')),
  'closure_manifest_invalid');

-- B3 Das Manifest muss zu dem Monat gehoeren, der abgeschlossen wird.
select pg_temp.nein('B3 Manifest eines fremden Monats',
  pg_temp.abschluss('c9', 2026, 8, 'p1:x:1', pg_temp.manifest('2026-07')),
  'closure_manifest_period_mismatch');

select pg_temp.nein('B4 unmoeglicher Monat',
  pg_temp.abschluss('c9', 2026, 13, 'p1:x:1', pg_temp.manifest('2026-13')),
  'period_invalid');

/* ================================================================== */
/* C — wieder oeffnen und erneut abschliessen                         */
/* ================================================================== */

do $$
declare v jsonb;
begin
  v := public.reopen_workspace_accounting_period(
         '00000000-0000-0000-0000-0000000b0001', 2026, 9, 'Beleg nachgereicht', 1);
  if (v->>'revision')::int <> 1 then raise exception 'C1 -- falsche Revision geoeffnet'; end if;
  raise notice 'OK         C1 Revision 1 wieder geoeffnet';
end;
$$;

do $$
declare r public.workspace_accounting_period_closures;
begin
  select * into r from public.workspace_accounting_period_closures where client_closure_id = 'c1';
  if r.reopened_at is null or r.reopened_by is null then raise exception 'C2 -- Oeffnungsspur fehlt'; end if;
  if r.reopen_reason <> 'Beleg nachgereicht' then raise exception 'C2 -- Grund fehlt'; end if;
  raise notice 'OK         C2 reopenedAt, reopenedBy und Grund gespeichert';
end;
$$;

-- C3 Danach entsteht Revision 2 — mit dem neuen Stand.
do $$
declare v jsonb;
begin
  v := pg_temp.ok('C3 Revision 2', pg_temp.abschluss('c2', 2026, 9, 'p1:bbbb:200'));
  if (v->>'revision')::int <> 2 then raise exception 'C3 -- Revision ist nicht 2'; end if;
end;
$$;

/*
 * C4 — der Kern der Revisionsregel: Revision 1 ist unveraendert. Ihr
 * Fingerprint zeigt weiterhin auf den Stand, der damals geprueft wurde.
 */
do $$
declare r public.workspace_accounting_period_closures;
begin
  select * into r from public.workspace_accounting_period_closures where client_closure_id = 'c1';
  if r.fingerprint <> 'p1:aaaa:100' then
    raise exception 'C4 -- Revision 1 wurde umgeschrieben: %', r.fingerprint;
  end if;
  if r.revision <> 1 then raise exception 'C4 -- Revisionsnummer veraendert'; end if;
  if jsonb_array_length(r.manifest->'entries') <> 2 then raise exception 'C4 -- Manifest veraendert'; end if;
  raise notice 'OK         C4 Revision 1 unveraendert, Fingerprint und Manifest erhalten';
end;
$$;

-- C5 Ohne offenen Abschluss laesst sich nichts oeffnen.
do $$
begin
  begin
    perform public.reopen_workspace_accounting_period(
      '00000000-0000-0000-0000-0000000b0001', 2026, 7, null, null);
  exception when others then
    if position('period_not_closed' in sqlerrm) = 0 then
      raise exception 'C5 -- falscher Fehler: %', sqlerrm;
    end if;
    raise notice 'ABGELEHNT  C5 kein offener Abschluss'; return;
  end;
  raise exception 'C5 -- ein nicht abgeschlossener Monat liess sich oeffnen';
end;
$$;

-- C6 Versionskonflikt beim Oeffnen.
do $$
begin
  begin
    perform public.reopen_workspace_accounting_period(
      '00000000-0000-0000-0000-0000000b0001', 2026, 9, null, 1);
  exception when others then
    if position('Versionskonflikt' in sqlerrm) = 0 then
      raise exception 'C6 -- falscher Fehler: %', sqlerrm;
    end if;
    raise notice 'ABGELEHNT  C6 Versionskonflikt beim Oeffnen'; return;
  end;
  raise exception 'C6 -- die falsche Revision liess sich oeffnen';
end;
$$;

/* ================================================================== */
/* D — lesen und Isolation                                            */
/* ================================================================== */

do $$
declare v jsonb;
begin
  v := public.pull_workspace_accounting_period_closures('00000000-0000-0000-0000-0000000b0001');
  if jsonb_array_length(v->'closures') <> 2 then
    raise exception 'D1 -- erwartet 2 Revisionen, erhalten %', jsonb_array_length(v->'closures');
  end if;
  raise notice 'OK         D1 beide Revisionen lesbar';
end;
$$;

do $$
begin
  begin
    perform public.pull_workspace_accounting_period_closures('00000000-0000-0000-0000-0000000b0002');
  exception when others then
    if position('Kein Zugriff' in sqlerrm) = 0 then raise exception 'D2 -- falscher Fehler: %', sqlerrm; end if;
    raise notice 'ABGELEHNT  D2 fremder Workspace'; return;
  end;
  raise exception 'D2 -- fremder Workspace war lesbar';
end;
$$;

-- D3 Ein fremder Workspace kann den Monat nicht oeffnen.
do $$
begin
  begin
    perform public.reopen_workspace_accounting_period(
      '00000000-0000-0000-0000-0000000b0002', 2026, 9, null, null);
  exception when others then
    if position('Kein Zugriff' in sqlerrm) = 0 then raise exception 'D3 -- falscher Fehler: %', sqlerrm; end if;
    raise notice 'ABGELEHNT  D3 fremdes Oeffnen'; return;
  end;
  raise exception 'D3 -- ein fremder Workspace konnte oeffnen';
end;
$$;

-- D4 RLS zeigt nur den eigenen Workspace.
insert into public.workspace_accounting_period_closures
  (workspace_id, client_closure_id, period_year, period_month, revision, fingerprint, manifest, closed_at)
values ('00000000-0000-0000-0000-0000000b0002', 'fremd-1', 2026, 9, 1, 'p1:zzz:9', '{"entries":[]}'::jsonb, now());

do $$
declare v_count int;
begin
  set local role authenticated;
  select count(*) into v_count from public.workspace_accounting_period_closures;
  reset role;
  if v_count <> 2 then raise exception 'D4 -- RLS gibt % Zeilen heraus, erwartet 2', v_count; end if;
  raise notice 'OK         D4 RLS zeigt nur den eigenen Workspace';
end;
$$;

/*
 * D5 — die Funktionen behaupten keine Rechtssicherheit. Eine Zusage, die die
 * Software nicht einloest, waere schlimmer als keine.
 */
do $$
declare v_src text;
begin
  select string_agg(p.prosrc, ' ') into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('close_workspace_accounting_period', 'reopen_workspace_accounting_period');
  if v_src ~* 'gobd|rechtssicher|unveraenderbar|festgeschrieben' then
    raise exception 'D5 -- die Funktionen behaupten eine Compliance-Zusage';
  end if;
  raise notice 'OK         D5 keine GoBD-/Rechtssicherheitsbehauptung im Server';
end;
$$;

rollback;
