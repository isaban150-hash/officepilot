-- EINRICHTUNG-01 / AP7 -- Bestaetigungsnachweis, Kontoloeschung, Betriebsloeschung (Szenariopaket Fassung 2, Vertraege
-- 1.25, 1.25a, 1.26; Migration 20261203120000_einrichtung01_ap7_daten_loeschung.sql). S-Anteil von L-01 bis L-07.
-- Passwortpruefung, Admin-API und Storage-API sind Sache der Edge Functions (H); hier: die SQL-Seite und ihr Vertrag.
--
-- Nur in einer Wegwerf-Kopie nach Anwendung der Migrationen AP6 und AP7 ausfuehren (Werkzeug
-- pruefunterlagen/einrichtung-01/werkzeug/ap6/ap-sql-isoliert.mjs). Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

create function pg_temp.pruefe(p_ok boolean, p_label text) returns void language plpgsql as $p$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FEHLER %', p_label;
  end if;
end;
$p$;

create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text) returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

/** Ein Token in der Form der Edge Function (43 Zeichen base64url). */
create function pg_temp.token(p_saat text) returns text language sql immutable as $p$
  select left(translate(encode(extensions.digest(p_saat, 'sha256'), 'base64'), '+/=', '-_x') || repeat('a', 43), 43)
$p$;

/** Nachweis wie die Edge Function ihn nach erfolgreicher Passwortpruefung ausstellt. */
create function pg_temp.nachweis(p_user uuid, p_action text, p_ws uuid, p_request uuid, p_saat text) returns text language plpgsql as $p$
declare
  v jsonb;
begin
  v := public.destructive_action_issue(p_user, p_action, p_ws, p_request, encode(extensions.digest(pg_temp.token(p_saat), 'sha256'), 'hex'));
  if (v->>'ok')::boolean is not true then
    raise exception 'Nachweis nicht ausgestellt: %', v;
  end if;
  return pg_temp.token(p_saat);
end;
$p$;

/* Aufrufe als Nutzer; eine Abweisung nimmt Rolle und Claims mit der Subtransaktion zurueck. */
create function pg_temp.konto_loeschen(p_user uuid, p_request uuid, p_token text, p_email text) returns jsonb language plpgsql as $p$
declare v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.account_deletion_begin(p_request, p_token, p_email);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.betrieb_beantragen(p_user uuid, p_ws uuid, p_name text, p_fassung text, p_token text, p_request uuid) returns jsonb language plpgsql as $p$
declare v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.workspace_request_deletion(p_ws, p_name, p_fassung, p_token, p_request);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.betrieb_widerrufen(p_user uuid, p_ws uuid, p_request uuid) returns jsonb language plpgsql as $p$
declare v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.workspace_revoke_deletion(p_ws, p_request);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.sql_als(p_user uuid, p_sql text) returns void language plpgsql as $p$
begin
  perform pg_temp.als(p_user);
  execute p_sql;
  perform pg_temp.zurueck();
end;
$p$;

/** Interne Pruefhilfen (ohne Client-Rechte) mit den Claims eines Kontos, ohne Rollenwechsel. */
create function pg_temp.intern(p_user uuid, p_sql text) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  execute p_sql;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

/** L-06.3: ein Client setzt den Marker selbst (als authenticated) und versucht das DELETE. */
create function pg_temp.marker_und_loeschen(p_ws uuid) returns void language plpgsql as $p$
begin
  perform set_config('officetakt.loeschweg', pg_current_xact_id()::text, true);
  delete from public.workspace_documents where workspace_id = p_ws;
end;
$p$;

/** Inhaltspruefsumme aller Zeilen eines Betriebs je Tabelle (L-05.3). */
create function pg_temp.fingerabdruck(p_ws uuid) returns jsonb language plpgsql as $p$
declare
  v_tabelle text;
  v_wert text;
  v jsonb := '{}'::jsonb;
begin
  for v_tabelle in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'workspace_id' and t.table_type = 'BASE TABLE'
     order by c.table_name
  loop
    execute format('select count(*) || '':'' || coalesce(md5(string_agg(x::text, ''|'' order by x::text collate "C")), ''-'') from public.%I x where x.workspace_id = $1', v_tabelle)
      into v_wert using p_ws;
    v := v || jsonb_build_object(v_tabelle, v_wert);
  end loop;
  v := v || jsonb_build_object('workspace', (select md5(w::text) from public.workspaces w where w.id = p_ws));
  v := v || jsonb_build_object('storage', (select coalesce(md5(string_agg(o.bucket_id || '/' || o.name || ':' || coalesce(o.metadata::text, ''), '|' order by o.bucket_id, o.name)), '-')
    from storage.objects o where left(o.name, 37) = p_ws::text || '/'));
  return v;
end;
$p$;

create function pg_temp.u(p_n integer) returns uuid language sql immutable as $p$
  select ('00000000-0000-0000-0000-0000000e7c' || lpad(to_hex(p_n), 2, '0'))::uuid
$p$;
create function pg_temp.w(p_n integer) returns uuid language sql immutable as $p$
  select ('00000000-0000-0000-0000-0000000e7ca' || to_hex(p_n))::uuid
$p$;
create function pg_temp.r(p_n integer) returns uuid language sql immutable as $p$
  select ('00000000-0000-0000-0000-0000000e7d' || lpad(to_hex(p_n), 2, '0'))::uuid
$p$;

-- Konten: 1 O1, 2 A1, 3 M1, 4 M3 (Mitglied in W1 und W3), 5 O3 (Inhaber W3), 6 L1 (Inhaber W2, Lizenz abgelaufen),
-- 7 A2 (Admin in W2), 8 G1 (gesperrt), 9 PA1, 10 PA2 (Plattform-Admins), 11 O10, 12 A10, 13 M10, 14 O12, 15 P1 (wartend),
-- 16 X (fremd), 17 A1L (Admin in W1, Ziel einer Uebergabe).
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select pg_temp.u(v.n), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email, 'x', now(), now(), now(), '{}',
       jsonb_build_object('firstName', v.vorname, 'lastName', 'AP7')
from (values
  (1, 'o1-ap7@example.invalid', 'Olga'), (2, 'a1-ap7@example.invalid', 'Anton'), (3, 'm1-ap7@example.invalid', 'Mira'),
  (4, 'm3-ap7@example.invalid', 'Max'), (5, 'o3-ap7@example.invalid', 'Oda'), (6, 'l1-ap7@example.invalid', 'Lars'),
  (7, 'a2-ap7@example.invalid', 'Arno'), (8, 'g1-ap7@example.invalid', 'Gerd'), (9, 'pa1-ap7@example.invalid', 'Pia'),
  (10, 'pa2-ap7@example.invalid', 'Pit'), (11, 'o10-ap7@example.invalid', 'Otto'), (12, 'a10-ap7@example.invalid', 'Ada'),
  (13, 'm10-ap7@example.invalid', 'Mona'), (14, 'o12-ap7@example.invalid', 'Ole'), (15, 'p1-ap7@example.invalid', 'Paul'),
  (16, 'x-ap7@example.invalid', 'Xaver'), (17, 'a1l-ap7@example.invalid', 'Alma')
) as v(n, email, vorname);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
 where id in (select pg_temp.u(n) from generate_series(1, 17) n) and id <> pg_temp.u(15);
update public.profiles set license_status = 'expired' where id = pg_temp.u(6);
update public.profiles set status = 'blocked' where id = pg_temp.u(8);
update public.profiles set role = 'admin' where id in (pg_temp.u(9), pg_temp.u(10));
-- Unbeteiligte Plattform-Admins aus Altbestaenden duerfen die Faelle nicht verfaelschen.
update public.profiles set role = 'user' where role = 'admin' and id not in (pg_temp.u(9), pg_temp.u(10));

insert into public.workspaces (id, name, owner_user_id) values
  (pg_temp.w(1), 'AP7 W1', pg_temp.u(1)), (pg_temp.w(2), 'AP7 W2', pg_temp.u(6)), (pg_temp.w(3), 'AP7 W3', pg_temp.u(5)),
  (pg_temp.w(10), 'AP7 W10', pg_temp.u(11)), (pg_temp.w(12), 'AP7 W12', pg_temp.u(14));
insert into public.workspace_members (workspace_id, user_id, role, status) values
  (pg_temp.w(1), pg_temp.u(1), 'owner', 'active'), (pg_temp.w(1), pg_temp.u(2), 'admin', 'active'),
  (pg_temp.w(1), pg_temp.u(3), 'member', 'active'), (pg_temp.w(1), pg_temp.u(4), 'member', 'active'),
  (pg_temp.w(1), pg_temp.u(17), 'admin', 'active'),
  (pg_temp.w(2), pg_temp.u(6), 'owner', 'active'), (pg_temp.w(2), pg_temp.u(7), 'admin', 'active'),
  (pg_temp.w(3), pg_temp.u(5), 'owner', 'active'), (pg_temp.w(3), pg_temp.u(4), 'member', 'active'),
  (pg_temp.w(10), pg_temp.u(11), 'owner', 'active'), (pg_temp.w(10), pg_temp.u(12), 'admin', 'active'),
  (pg_temp.w(10), pg_temp.u(13), 'member', 'active'),
  (pg_temp.w(12), pg_temp.u(14), 'owner', 'active');
insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
select w, jsonb_build_object('companyName', name), 1, owner
from (values (pg_temp.w(1), 'AP7 W1', pg_temp.u(1)), (pg_temp.w(10), 'AP7 W10', pg_temp.u(11)), (pg_temp.w(12), 'AP7 W12', pg_temp.u(14))) as x(w, name, owner);

/* ------------------------------------------------------------------ */
/* 1.25a Bestaetigungsnachweis                                         */
/* ------------------------------------------------------------------ */
do $t$
declare
  v jsonb;
  v_token text;
begin
  -- Vorpruefung: Anmelde-E-Mail aus der Datenbank, auch fuer ein wartendes Konto; gesperrt -> Sperrcode.
  perform pg_temp.als(pg_temp.u(15));
  v := public.destructive_action_precheck('account_delete', null);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(v->>'ok' = 'true' and v->>'email' = 'p1-ap7@example.invalid', 'Vorpruefung wartendes Konto: ' || v::text);
  perform pg_temp.erwarte_abweisung('Vorpruefung gesperrt',
    format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(8), 'select public.destructive_action_precheck(''account_delete'', null)'), 'account_blocked');
  -- Nur als Hash gespeichert; 5 Minuten.
  v_token := pg_temp.nachweis(pg_temp.u(3), 'account_delete', null, pg_temp.r(1), 'm1-1');
  perform pg_temp.pruefe((select count(*) = 1 and bool_and(c.token_hash <> v_token) and bool_and(c.expires_at - c.created_at = interval '5 minutes')
                            from public.destructive_action_confirmations c where c.user_id = pg_temp.u(3)), '1.25a Hash, 5 Minuten');
  -- Versuchslimit: nach 5 Fehlversuchen in 15 Minuten confirmation_rate_limited.
  for i in 1..5 loop
    perform public.destructive_action_record_failure(pg_temp.u(16));
  end loop;
  perform pg_temp.als(pg_temp.u(16));
  v := public.destructive_action_precheck('account_delete', null);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(v->>'code' = 'confirmation_rate_limited', 'L-01.11 Versuchslimit: ' || v::text);
  raise notice 'OK  1.25a Vorpruefung (wartend erlaubt, gesperrt abgewiesen), Nachweis nur als Hash mit 5 Minuten, Versuchslimit nach 5 Fehlversuchen';
end;
$t$;

do $t$
declare
  v_token text;
  v_anderer text;
begin
  -- L-01.7 bis L-01.9: ohne, falsch, abgelaufen, verbraucht, anderes Konto, andere Aktion, andere Anfrage-ID.
  perform pg_temp.erwarte_abweisung('L-01.7 ohne Nachweis',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, null, %L)', pg_temp.u(3), pg_temp.r(2), 'm1-ap7@example.invalid'), 'confirmation_invalid');
  v_token := pg_temp.nachweis(pg_temp.u(3), 'account_delete', null, pg_temp.r(3), 'm1-3');
  perform pg_temp.erwarte_abweisung('L-01.9 andere Anfrage-ID',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, %L, %L)', pg_temp.u(3), pg_temp.r(4), v_token, 'm1-ap7@example.invalid'), 'confirmation_invalid');
  v_anderer := pg_temp.nachweis(pg_temp.u(2), 'account_delete', null, pg_temp.r(5), 'a1-5');
  perform pg_temp.erwarte_abweisung('L-01.9 Nachweis eines anderen Kontos',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, %L, %L)', pg_temp.u(3), pg_temp.r(5), v_anderer, 'm1-ap7@example.invalid'), 'confirmation_invalid');
  v_anderer := pg_temp.nachweis(pg_temp.u(3), 'workspace_delete_request', pg_temp.w(1), pg_temp.r(6), 'm1-6');
  perform pg_temp.erwarte_abweisung('L-01.9 Nachweis fuer workspace_delete_request',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, %L, %L)', pg_temp.u(3), pg_temp.r(6), v_anderer, 'm1-ap7@example.invalid'), 'confirmation_invalid');
  update public.destructive_action_confirmations set expires_at = now() - interval '1 second', created_at = now() - interval '6 minutes'
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  perform pg_temp.erwarte_abweisung('L-01.8 abgelaufen',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, %L, %L)', pg_temp.u(3), pg_temp.r(3), v_token, 'm1-ap7@example.invalid'), 'confirmation_invalid');
  perform pg_temp.pruefe((select count(*) = 0 from public.account_deletion_jobs where user_id = pg_temp.u(3)), 'kein Auftrag nach Abweisungen');
  perform pg_temp.pruefe((select status = 'approved' from public.profiles where id = pg_temp.u(3)), 'Konto unveraendert');
  raise notice 'OK  L-01.7-L-01.9 ohne, abgelaufener, fremder, falsch gebundener Nachweis: confirmation_invalid, keine Aenderung';
end;
$t$;

/* ------------------------------------------------------------------ */
/* L-02 Voraussetzungen                                                */
/* ------------------------------------------------------------------ */
do $t$
declare
  v jsonb;
begin
  v := pg_temp.konto_loeschen(pg_temp.u(1), pg_temp.r(10), pg_temp.nachweis(pg_temp.u(1), 'account_delete', null, pg_temp.r(10), 'o1-10'), 'o1-ap7@example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'account_owner' and v->'workspaces'->0->>'name' = 'AP7 W1'
                         and v->'ways' = '["ownership_transfer", "workspace_delete"]'::jsonb, 'L-02.1 Inhaber mit Mitgliedern: ' || v::text);
  v := pg_temp.konto_loeschen(pg_temp.u(14), pg_temp.r(11), pg_temp.nachweis(pg_temp.u(14), 'account_delete', null, pg_temp.r(11), 'o12-11'), 'o12-ap7@example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'account_owner', 'L-02.2 Inhaber ohne Mitglieder (E20): ' || v::text);
  v := pg_temp.konto_loeschen(pg_temp.u(6), pg_temp.r(12), pg_temp.nachweis(pg_temp.u(6), 'account_delete', null, pg_temp.r(12), 'l1-12'), 'l1-ap7@example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'account_owner', 'L-02.4 Inhaber mit abgelaufener Lizenz (E20): ' || v::text);
  update public.profiles set status = 'blocked' where id = pg_temp.u(10);
  v := pg_temp.konto_loeschen(pg_temp.u(9), pg_temp.r(13), pg_temp.nachweis(pg_temp.u(9), 'account_delete', null, pg_temp.r(13), 'pa1-13'), 'pa1-ap7@example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'last_platform_admin', 'L-02.3 letzter Plattform-Admin: ' || v::text);
  update public.profiles set status = 'approved' where id = pg_temp.u(10);
  v := pg_temp.konto_loeschen(pg_temp.u(2), pg_temp.r(14), pg_temp.nachweis(pg_temp.u(2), 'account_delete', null, pg_temp.r(14), 'a1-14'), 'falsch@example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'email_mismatch', 'L-01.5 falsche E-Mail: ' || v::text);
  perform pg_temp.erwarte_abweisung('L-01.13 gesperrtes Konto',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, %L, %L)', pg_temp.u(8), pg_temp.r(15), 'x', 'g1-ap7@example.invalid'), 'account_blocked');
  perform pg_temp.pruefe((select count(*) = 0 from public.account_deletion_jobs), 'keine Auftraege nach den Abweisungen');
  -- Der Nachweis bleibt nach einer fachlichen Abweisung unverbraucht (nur fuer dieselbe Aktion und Anfrage-ID).
  perform pg_temp.pruefe((select consumed_at is null from public.destructive_action_confirmations
                           where user_id = pg_temp.u(1) and request_id = pg_temp.r(10)), 'Nachweis nach Abweisung unverbraucht');
  raise notice 'OK  L-02.1-L-02.4/L-01.5/L-01.13 Inhaber (auch ohne Mitglieder, auch abgelaufen), letzter Admin, falsche E-Mail, gesperrt: abgewiesen ohne Aenderung';
end;
$t$;

/* ------------------------------------------------------------------ */
/* L-01 Kontoloeschung                                                  */
/* ------------------------------------------------------------------ */
create temp table merk (schluessel text primary key, wert text);

do $t$
declare
  v jsonb;
  v_token text := pg_temp.nachweis(pg_temp.u(4), 'account_delete', null, pg_temp.r(20), 'm3-20');
  v_job uuid;
begin
  -- L-01.4a: ein Fehler im SQL-Teil nimmt alles zurueck (kein Auftrag, Konto unveraendert, Nachweis unverbraucht).
  create function pg_temp.stoer() returns trigger language plpgsql as $f$ begin raise exception 'Stoerung im Test'; end; $f$;
  create trigger ap7_stoer before update on public.account_deletion_jobs for each row execute function pg_temp.stoer();
  perform pg_temp.erwarte_abweisung('L-01.4a Fehler im SQL-Teil',
    format('select pg_temp.konto_loeschen(%L::uuid, %L::uuid, %L, %L)', pg_temp.u(4), pg_temp.r(20), v_token, 'M3-AP7@example.invalid'), 'Stoerung im Test');
  drop trigger ap7_stoer on public.account_deletion_jobs;
  perform pg_temp.pruefe((select count(*) = 0 from public.account_deletion_jobs where user_id = pg_temp.u(4)), 'L-01.4a kein Auftrag');
  perform pg_temp.pruefe((select count(*) = 2 from public.workspace_members where user_id = pg_temp.u(4) and status = 'active'), 'L-01.4a Mitgliedschaften unveraendert');
  perform pg_temp.pruefe((select consumed_at is null from public.destructive_action_confirmations where request_id = pg_temp.r(20)), 'L-01.4a Nachweis unverbraucht');

  -- L-01.1: Mitglied in W1 und W3 loescht sein Konto (E-Mail ohne Gross/klein-Unterschied).
  v := pg_temp.konto_loeschen(pg_temp.u(4), pg_temp.r(20), v_token, 'M3-AP7@example.invalid');
  perform pg_temp.pruefe(v->>'ok' = 'true' and v->>'state' = 'sql_done', 'L-01.1 Beginn: ' || v::text);
  v_job := (v->>'job_id')::uuid;
  insert into merk values ('job_m3', v_job::text);
  perform pg_temp.pruefe((select count(*) = 0 from public.workspace_members where user_id = pg_temp.u(4) and status = 'active'), 'L-01.1 keine aktive Mitgliedschaft');
  perform pg_temp.pruefe((select count(*) = 2 and bool_and(details->>'reason' = 'account_deleted') from public.workspace_member_events
                           where target_user_id = pg_temp.u(4) and action = 'member_left'), 'L-01.1 Pruefspur je Betrieb');
  perform pg_temp.pruefe((select first_name = 'Gelöschtes' and last_name = 'Konto' and company_name = '' and phone is null
                                 and email = 'geloescht-' || pg_temp.u(4)::text || '@invalid.officetakt' and status = 'blocked' and deleted_at is not null
                            from public.profiles where id = pg_temp.u(4)), 'L-01.1 Profil pseudonymisiert und gesperrt');
  perform pg_temp.pruefe(public.einrichtung01_display_name(pg_temp.u(4)) = 'Gelöschtes Konto', 'L-01.2 Anzeige „Gelöschtes Konto“: ' || coalesce(public.einrichtung01_display_name(pg_temp.u(4)), 'null'));
  perform pg_temp.pruefe((select count(*) = 1 from public.platform_admin_events where target_user_id = pg_temp.u(4) and action = 'account_deletion_started'), 'L-01.1 Pruefspur Beginn genau einmal');
  raise notice 'OK  L-01.4a/L-01.1/L-01.2 Fehler im SQL-Teil zurueckgenommen; danach Mitgliedschaften beendet (Pruefspur je Betrieb), Profil pseudonymisiert und gesperrt, Beginn genau einmal protokolliert';
end;
$t$;

do $t$
declare
  v jsonb;
  v_job uuid := (select wert::uuid from merk where schluessel = 'job_m3');
begin
  -- L-01.4/L-01.4f: Wiederholung mit derselben Anfrage-ID liefert den Stand ohne neuen Nachweis; andere Anfrage-ID nicht.
  v := pg_temp.konto_loeschen(pg_temp.u(4), pg_temp.r(20), null, null);
  perform pg_temp.pruefe(v->>'replayed' = 'true' and v->>'state' = 'sql_done' and (v->>'job_id')::uuid = v_job, 'L-01.4 Wiederholung: ' || v::text);
  v := pg_temp.konto_loeschen(pg_temp.u(4), pg_temp.r(21), null, null);
  perform pg_temp.pruefe(v->>'code' = 'deletion_request_mismatch', 'L-01.4f andere Anfrage-ID: ' || v::text);
  perform pg_temp.pruefe((select count(*) = 1 from public.platform_admin_events where target_user_id = pg_temp.u(4) and action = 'account_deletion_started'), 'L-01.4 keine doppelte Pruefspur');
  -- L-01.4e: das alte Konto arbeitet nicht weiter (gesperrt, ohne Mitgliedschaft) — auch mit gueltigem altem JWT.
  perform pg_temp.erwarte_abweisung('L-01.4e Schreiben in W1', format('select pg_temp.intern(%L::uuid, %L)', pg_temp.u(4),
    format('select public.assert_workspace_write_access(%L::uuid, false)', pg_temp.w(1))), 'account_blocked');
  perform pg_temp.erwarte_abweisung('L-01.4e Zugriffsauskunft W3', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(4),
    format('select public.get_workspace_access(%L::uuid)', pg_temp.w(3))), 'Kein Zugriff');
  perform pg_temp.pruefe(public.workspace_user_access_denial(pg_temp.w(1), pg_temp.u(4), 'member') = 'account_blocked', 'L-01.4e Edge-Zugang');
  -- Schritt 2: Teilschritte einzeln idempotent; Sitzungen und Identitaeten werden entfernt.
  insert into auth.sessions (id, user_id, created_at, updated_at) values (gen_random_uuid(), pg_temp.u(4), now(), now());
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.u(4)::text, pg_temp.u(4), jsonb_build_object('sub', pg_temp.u(4)::text), 'email', now(), now());
  v := public.account_deletion_auth_step(v_job, 'email');
  v := public.account_deletion_auth_step(v_job, 'email');
  v := public.account_deletion_auth_step(v_job, 'sessions');
  perform pg_temp.pruefe(v->>'state' = 'sql_done' and (select count(*) = 0 from auth.sessions where user_id = pg_temp.u(4)), 'L-01.4d Sitzungen entfernt, noch sql_done');
  v := public.account_deletion_complete(v_job);
  perform pg_temp.pruefe(v->>'code' = 'job_state_invalid', 'Abschluss erst nach auth_done: ' || v::text);
  v := public.account_deletion_auth_step(v_job, 'error', 'auth_identities_failed');
  perform pg_temp.pruefe(v->>'last_error_code' = 'auth_identities_failed', 'L-01.4b Fehlercode vermerkt');
  v := public.account_deletion_auth_step(v_job, 'identities');
  perform pg_temp.pruefe(v->>'state' = 'auth_done' and (select count(*) = 0 from auth.identities where user_id = pg_temp.u(4)), 'L-01.4c auth_done, Identitaeten entfernt');
  perform pg_temp.pruefe((select count(*) = 1 from public.account_deletion_pending_jobs(10) j where (j->>'job_id')::uuid = v_job), 'Dienstweg findet den Auftrag');
  v := public.account_deletion_complete(v_job);
  v := public.account_deletion_complete(v_job);
  perform pg_temp.pruefe(v->>'state' = 'completed', 'L-01.4c completed: ' || v::text);
  perform pg_temp.pruefe((select count(*) = 1 from public.platform_admin_events where target_user_id = pg_temp.u(4) and action = 'account_deleted'), 'L-01.4c account_deleted genau einmal');
  perform pg_temp.pruefe((select count(*) = 0 from public.account_deletion_pending_jobs(10) j where (j->>'job_id')::uuid = v_job), 'Dienstweg: nichts mehr offen');
  raise notice 'OK  L-01.4/L-01.4b-f Wiederholung idempotent, fremde Anfrage-ID abgewiesen, altes JWT ohne Zugang; Auth-Teilschritte je einmal; completed und account_deleted genau einmal';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- L-01.12 (E19): Admin eines Betriebs mit nicht wirksamer Lizenz darf sein eigenes Konto loeschen; W2 bleibt Nur-Lesen.
  v := pg_temp.konto_loeschen(pg_temp.u(7), pg_temp.r(30), pg_temp.nachweis(pg_temp.u(7), 'account_delete', null, pg_temp.r(30), 'a2-30'), 'a2-ap7@example.invalid');
  perform pg_temp.pruefe(v->>'state' = 'sql_done', 'L-01.12 E19: ' || v::text);
  perform pg_temp.pruefe(public.workspace_license_state(pg_temp.w(2)) <> 'effective', 'L-01.12 W2 bleibt ohne wirksame Lizenz');
  -- L-01.6: ein wartendes Konto darf sich loeschen.
  v := pg_temp.konto_loeschen(pg_temp.u(15), pg_temp.r(31), pg_temp.nachweis(pg_temp.u(15), 'account_delete', null, pg_temp.r(31), 'p1-31'), 'p1-ap7@example.invalid');
  perform pg_temp.pruefe(v->>'state' = 'sql_done', 'L-01.6 wartend: ' || v::text);
  raise notice 'OK  L-01.12/L-01.6 Admin bei nicht wirksamer Betriebslizenz und wartendes Konto: Loeschung beginnt (E19), ohne Geschaeftszugang';
end;
$t$;

/* ------------------------------------------------------------------ */
/* L-03 Antrag auf Betriebsloeschung                                    */
/* ------------------------------------------------------------------ */
do $t$
declare
  v jsonb;
  v_fassung text := public.workspace_deletion_notice_version();
begin
  insert into public.workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
  values ('00000000-0000-0000-0000-0000000e7e01', pg_temp.w(1), 'neu-ap7@example.invalid', 'member', extensions.digest('ap7-einladung', 'sha256'), pg_temp.u(1), now() + interval '7 days');
  insert into public.workspace_ownership_transfers (id, workspace_id, kind, from_user_id, to_user_id, requested_by, status, expires_at)
  values ('00000000-0000-0000-0000-0000000e7f01', pg_temp.w(1), 'owner', pg_temp.u(1), pg_temp.u(17), pg_temp.u(1), 'open', now() + interval '7 days');

  -- L-03.2/L-03.9: Admin und Mitglied — auch mit eigenem gueltigem Nachweis — abgewiesen; fremdes Konto ebenso.
  perform pg_temp.erwarte_abweisung('L-03.2 Admin', format('select pg_temp.betrieb_beantragen(%L::uuid, %L::uuid, %L, %L, %L, %L::uuid)',
    pg_temp.u(2), pg_temp.w(1), 'AP7 W1', v_fassung, pg_temp.nachweis(pg_temp.u(2), 'workspace_delete_request', pg_temp.w(1), pg_temp.r(40), 'a1-40'), pg_temp.r(40)), 'team_forbidden_role');
  perform pg_temp.erwarte_abweisung('L-03.2 Mitglied', format('select pg_temp.betrieb_beantragen(%L::uuid, %L::uuid, %L, %L, %L, %L::uuid)',
    pg_temp.u(3), pg_temp.w(1), 'AP7 W1', v_fassung, pg_temp.nachweis(pg_temp.u(3), 'workspace_delete_request', pg_temp.w(1), pg_temp.r(41), 'm1-41'), pg_temp.r(41)), 'team_forbidden_role');
  perform pg_temp.erwarte_abweisung('L-03.9 fremdes Konto', format('select pg_temp.betrieb_beantragen(%L::uuid, %L::uuid, %L, %L, %L, %L::uuid)',
    pg_temp.u(16), pg_temp.w(1), 'AP7 W1', v_fassung, 'x', pg_temp.r(42)), 'team_not_member');
  -- L-03.3/L-03.10: falscher Name, veraltete Fassung (vor dem Verbrauch des Nachweises).
  v := pg_temp.betrieb_beantragen(pg_temp.u(1), pg_temp.w(1), 'AP7 W2', v_fassung, null, pg_temp.r(43));
  perform pg_temp.pruefe(v->>'code' = 'name_mismatch', 'L-03.3 falscher Name: ' || v::text);
  v := pg_temp.betrieb_beantragen(pg_temp.u(1), pg_temp.w(1), 'AP7 W1', '2026-01-01', null, pg_temp.r(44));
  perform pg_temp.pruefe(v->>'code' = 'notice_outdated', 'L-03.10 veraltete Hinweisfassung: ' || v::text);
  -- L-03.6/L-03.7: ohne Nachweis; Nachweis fuer W1 an W2; andere Anfrage-ID.
  perform pg_temp.erwarte_abweisung('L-03.6 ohne Nachweis', format('select pg_temp.betrieb_beantragen(%L::uuid, %L::uuid, %L, %L, null, %L::uuid)',
    pg_temp.u(1), pg_temp.w(1), 'AP7 W1', v_fassung, pg_temp.r(45)), 'confirmation_invalid');
  insert into merk values ('w1_nachweis', pg_temp.nachweis(pg_temp.u(1), 'workspace_delete_request', pg_temp.w(1), pg_temp.r(46), 'o1-46'));
  perform pg_temp.erwarte_abweisung('L-03.7 andere Anfrage-ID', format('select pg_temp.betrieb_beantragen(%L::uuid, %L::uuid, %L, %L, %L, %L::uuid)',
    pg_temp.u(1), pg_temp.w(1), 'AP7 W1', v_fassung, (select wert from merk where schluessel = 'w1_nachweis'), pg_temp.r(47)), 'confirmation_invalid');
  perform pg_temp.pruefe((select count(*) = 0 from public.workspace_deletion_requests), 'keine Antraege nach den Abweisungen');
  raise notice 'OK  L-03.2/L-03.3/L-03.6/L-03.7/L-03.9/L-03.10 Admin, Mitglied, fremdes Konto, falscher Name, veraltete Fassung, fehlender oder falsch gebundener Nachweis: abgewiesen';
end;
$t$;

do $t$
declare
  v jsonb;
  v_fassung text := public.workspace_deletion_notice_version();
begin
  -- L-03.8 (E19): Inhaber mit abgelaufener Lizenz darf beantragen.
  v := pg_temp.betrieb_beantragen(pg_temp.u(6), pg_temp.w(2), 'AP7 W2', v_fassung,
    pg_temp.nachweis(pg_temp.u(6), 'workspace_delete_request', pg_temp.w(2), pg_temp.r(50), 'l1-50'), pg_temp.r(50));
  perform pg_temp.pruefe(v->>'ok' = 'true' and v->>'state' = 'open', 'L-03.8 E19: ' || v::text);
  -- L-03.1: Antrag fuer W1 mit Name (ohne Rand-Leerzeichen), Fassung und Nachweis.
  v := pg_temp.betrieb_beantragen(pg_temp.u(1), pg_temp.w(1), '  AP7 W1  ', v_fassung, (select wert from merk where schluessel = 'w1_nachweis'), pg_temp.r(46));
  perform pg_temp.pruefe(v->>'ok' = 'true' and v->>'state' = 'open'
                         and (v->>'execute_after')::timestamptz between now() + interval '30 days' - interval '1 minute' and now() + interval '30 days' + interval '1 minute',
                         'L-03.1 Antrag: ' || v::text);
  perform pg_temp.pruefe((select status = 'revoked' from public.workspace_invitations where id = '00000000-0000-0000-0000-0000000e7e01'), 'L-03.1 Einladung beendet');
  perform pg_temp.pruefe((select status = 'revoked' from public.workspace_ownership_transfers where id = '00000000-0000-0000-0000-0000000e7f01'), 'L-03.1 Uebergabe beendet');
  perform pg_temp.pruefe((select count(*) = 1 and bool_and(details->>'retention_notice_version' = v_fassung) from public.workspace_member_events
                           where workspace_id = pg_temp.w(1) and action = 'deletion_requested'), 'L-03.1 Pruefspur mit Hinweisfassung');
  -- L-03.5: Wiederholung mit derselben Anfrage-ID; eine neue Anfrage erzeugt keinen zweiten Antrag.
  v := pg_temp.betrieb_beantragen(pg_temp.u(1), pg_temp.w(1), 'AP7 W1', v_fassung, null, pg_temp.r(46));
  perform pg_temp.pruefe(v->>'replayed' = 'true', 'L-03.5 Wiederholung: ' || v::text);
  v := pg_temp.betrieb_beantragen(pg_temp.u(1), pg_temp.w(1), 'AP7 W1', v_fassung, null, pg_temp.r(48));
  perform pg_temp.pruefe(v->>'already' = 'true', 'L-03.5 kein zweiter Antrag: ' || v::text);
  perform pg_temp.pruefe((select count(*) = 1 from public.workspace_deletion_requests where workspace_id = pg_temp.w(1)), 'L-03.5 genau ein Antrag');
  raise notice 'OK  L-03.1/L-03.5/L-03.8 Antrag offen mit 30 Tagen, Einladungen und Uebergaben beendet, Pruefspur mit Fassung; idempotent; E19';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- L-03.11: Nachweis gueltig, aber zwischenzeitlich uebergeben -> die Rolle wird aktuell geprueft.
  insert into merk values ('w3_nachweis', pg_temp.nachweis(pg_temp.u(5), 'workspace_delete_request', pg_temp.w(3), pg_temp.r(51), 'o3-51'));
  update public.workspaces set owner_user_id = pg_temp.u(4) where id = pg_temp.w(3);
  update public.workspace_members set role = 'admin' where workspace_id = pg_temp.w(3) and user_id = pg_temp.u(5);
  perform pg_temp.erwarte_abweisung('L-03.11 frueherer Inhaber', format('select pg_temp.betrieb_beantragen(%L::uuid, %L::uuid, %L, %L, %L, %L::uuid)',
    pg_temp.u(5), pg_temp.w(3), 'AP7 W3', public.workspace_deletion_notice_version(), (select wert from merk where schluessel = 'w3_nachweis'), pg_temp.r(51)), 'team_forbidden_role');
  update public.workspace_members set role = 'owner' where workspace_id = pg_temp.w(3) and user_id = pg_temp.u(5);
  update public.workspaces set owner_user_id = pg_temp.u(5) where id = pg_temp.w(3);
  raise notice 'OK  L-03.11 Nachweis des frueheren Inhabers nach der Uebergabe: team_forbidden_role';
end;
$t$;

/* ------------------------------------------------------------------ */
/* L-04 Wartefrist                                                      */
/* ------------------------------------------------------------------ */
do $t$
declare
  v jsonb;
begin
  -- L-04.1: Nur-Lesen mit eigenem Grund; Lesen bleibt.
  perform pg_temp.als(pg_temp.u(2));
  v := public.get_workspace_access(pg_temp.w(1));
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(v->'deletion'->>'state' = 'open' and v->'deletion' ? 'execute_after', 'L-04.1 Zugriffsauskunft: ' || v::text);
  perform pg_temp.erwarte_abweisung('L-04.1 Schreiben', format('select pg_temp.intern(%L::uuid, %L)', pg_temp.u(2),
    format('select public.assert_workspace_write_access(%L::uuid, true)', pg_temp.w(1))), 'deletion_pending');
  perform pg_temp.erwarte_abweisung('L-04.1 Finanz', format('select pg_temp.intern(%L::uuid, %L)', pg_temp.u(1),
    format('select public.assert_financial_action_allowed(%L::uuid)', pg_temp.w(1))), 'deletion_pending');
  perform pg_temp.pruefe(public.workspace_user_access_denial(pg_temp.w(1), pg_temp.u(1), 'write') = 'deletion_pending', 'L-04.1 Versand und Postfach');
  perform pg_temp.pruefe(public.workspace_user_access_denial(pg_temp.w(1), pg_temp.u(3), 'member') = 'deletion_pending', 'L-04.1 KI');
  perform pg_temp.pruefe(not public.workspace_user_can_write(pg_temp.w(1), pg_temp.u(1)), 'L-04.1 Schreibrecht der Edge Functions');
  perform pg_temp.als(pg_temp.u(1));
  perform pg_temp.pruefe(not public.branding_asset_can_write(pg_temp.w(1)::text || '/logo.png'), 'L-04.1 Speicher');
  perform pg_temp.zurueck();
  -- L-04.7: Uebergabe und Plattform-Reparatur abgewiesen (deletion_pending).
  perform pg_temp.erwarte_abweisung('L-04.7 Uebergabe', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(1),
    format('select public.team_request_transfer(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.w(1), pg_temp.u(17))), 'deletion_pending');
  perform pg_temp.erwarte_abweisung('L-04.7 Plattform-Reparatur', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(9),
    format('select public.platform_request_ownership_repair(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.w(1), pg_temp.u(17))), 'deletion_pending');
  -- L-04.8: Einladen, Aufstufen, Umbenennen gesperrt; Herabstufen und Entfernen erlaubt (E16).
  perform pg_temp.erwarte_abweisung('L-04.8 Einladen', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(1),
    format('select public.team_invite(%L::uuid, %L, %L, gen_random_uuid())', pg_temp.w(1), 'zwei-ap7@example.invalid', 'member')), 'deletion_pending');
  perform pg_temp.erwarte_abweisung('L-04.8 Aufstufen', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(1),
    format('select public.team_change_role(%L::uuid, %L::uuid, %L, gen_random_uuid())', pg_temp.w(1), pg_temp.u(3), 'admin')), 'deletion_pending');
  perform pg_temp.erwarte_abweisung('L-04.8 Umbenennen', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(1),
    format('select public.team_rename_workspace(%L::uuid, %L, gen_random_uuid())', pg_temp.w(1), 'AP7 neu')), 'deletion_pending');
  perform pg_temp.sql_als(pg_temp.u(1), format('select public.team_change_role(%L::uuid, %L::uuid, %L, gen_random_uuid())', pg_temp.w(1), pg_temp.u(2), 'member'));
  perform pg_temp.sql_als(pg_temp.u(1), format('select public.team_remove_member(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.w(1), pg_temp.u(3)));
  perform pg_temp.pruefe((select role = 'member' from public.workspace_members where workspace_id = pg_temp.w(1) and user_id = pg_temp.u(2)), 'L-04.8 Herabstufen erlaubt');
  perform pg_temp.pruefe((select status = 'removed' from public.workspace_members where workspace_id = pg_temp.w(1) and user_id = pg_temp.u(3)), 'L-04.8 Entfernen erlaubt');
  -- L-04.1 (Postfach): kein automatischer Abruf fuer einen Betrieb mit Loeschantrag (Gegenstueck nach dem Widerruf unten).
  insert into public.mailbox_provider_types (provider_type, auth_modes, source_kinds, description)
  values ('microsoft_graph', array['application', 'delegated'], array['folder'], 'Microsoft Graph')
  on conflict (provider_type) do nothing;
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_address, status, created_by)
  values (pg_temp.w(1), 'microsoft_graph', 'application', 'abruf-ap7@example.invalid', 'connected', pg_temp.u(1));
  insert into merk select 'abruf', c.id::text from public.workspace_mailbox_connections c
   where c.workspace_id = pg_temp.w(1) and c.mailbox_address = 'abruf-ap7@example.invalid';
  perform pg_temp.pruefe(position((select wert from merk where schluessel = 'abruf') in public.list_workspace_mailbox_auto_sync_candidates(1000)::text) = 0,
    'L-04.1 kein automatischer Postfachabruf waehrend des Loeschantrags');
  raise notice 'OK  L-04.1/L-04.7/L-04.8 deletion_pending fuer Schreiben, Finanz, Versand, Postfach (auch kein automatischer Abruf), KI, Speicher, Uebergabe, Reparatur, Einladen, Aufstufen, Umbenennen; Herabstufen und Entfernen erlaubt';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- L-04.3: Admin widerruft nicht; L-04.2: Inhaber widerruft.
  perform pg_temp.erwarte_abweisung('L-04.3 Admin widerruft', format('select pg_temp.betrieb_widerrufen(%L::uuid, %L::uuid, gen_random_uuid())',
    pg_temp.u(17), pg_temp.w(1)), 'team_forbidden_role');
  v := pg_temp.betrieb_widerrufen(pg_temp.u(1), pg_temp.w(1), pg_temp.r(60));
  perform pg_temp.pruefe(v->>'state' = 'revoked', 'L-04.2 Widerruf: ' || v::text);
  perform pg_temp.pruefe(not public.workspace_deletion_pending(pg_temp.w(1)), 'L-04.2 normaler Zustand');
  perform pg_temp.pruefe((select count(*) = 1 from public.workspace_member_events where workspace_id = pg_temp.w(1) and action = 'deletion_revoked'), 'L-04.2 Pruefspur');
  perform pg_temp.pruefe(position((select wert from merk where schluessel = 'abruf') in public.list_workspace_mailbox_auto_sync_candidates(1000)::text) > 0,
    'L-04.2 nach dem Widerruf wieder Kandidat fuer den automatischen Abruf');
  -- L-04.4: Frist nicht abgelaufen -> Ausfuehrung abgewiesen.
  v := public.workspace_deletion_begin(pg_temp.w(2), gen_random_uuid(), 600);
  perform pg_temp.pruefe(v->>'code' = 'deletion_not_due', 'L-04.4 vor Ablauf: ' || v::text);
  -- L-04.6: im Zustand deleting kein Widerruf.
  update public.workspace_deletion_requests set execute_after = now() - interval '1 minute' where workspace_id = pg_temp.w(2) and state = 'open';
  v := public.workspace_deletion_begin(pg_temp.w(2), pg_temp.r(61), 600);
  perform pg_temp.pruefe(v->>'state' = 'deleting', 'Beginn nach Ablauf: ' || v::text);
  perform pg_temp.erwarte_abweisung('L-04.6 Widerruf waehrend deleting', format('select pg_temp.betrieb_widerrufen(%L::uuid, %L::uuid, gen_random_uuid())',
    pg_temp.u(6), pg_temp.w(2)), 'deletion_in_progress');
  -- L-05.5: ein zweiter Lauf mit gueltiger fremder Sperre tut nichts.
  v := public.workspace_deletion_begin(pg_temp.w(2), pg_temp.r(62), 600);
  perform pg_temp.pruefe(v->>'code' = 'deletion_locked', 'L-05.5 zweiter Lauf: ' || v::text);
  raise notice 'OK  L-04.2-L-04.4/L-04.6/L-05.5 Widerruf nur durch den Inhaber und nur im Zustand open; vor Ablauf keine Ausfuehrung; zweiter Lauf ohne Wirkung';
end;
$t$;

/* ------------------------------------------------------------------ */
/* L-05/L-06 Ausfuehrung ueber den Loeschweg                            */
/* ------------------------------------------------------------------ */
do $t$
declare
  v_vault uuid;
begin
  -- W10 mit Geschaeftsdaten: geschuetztes Dokument (Rechnung, Frist laeuft), Nachtrag, Postfach mit Vault-Geheimnis.
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload, row_version, deleted)
  values (pg_temp.w(10), 'doc-ap7', 'archived_document', jsonb_build_object('id', 'doc-ap7', 'classifiedKind', 'rechnung', 'documentDate', to_char(now(), 'YYYY-MM-DD')), 1, false);
  perform pg_temp.pruefe((select r.frist_status = 'laeuft' from public.workspace_documents d, lateral public.workspace_document_retention(d) r
                           where d.workspace_id = pg_temp.w(10) and d.client_document_id = 'doc-ap7'), 'Aufbau: Aufbewahrungsfrist laeuft');
  insert into public.workspace_setup (workspace_id, payload, row_version) values (pg_temp.w(10), '{}'::jsonb, 1);
  -- Einmal beschreibbarer Nachtrag (write-once): nur der Loeschweg darf ihn entfernen.
  insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload) values (pg_temp.w(10), 'vg-ap7', '{}'::jsonb);
  insert into public.workspace_order_amendments (workspace_id, vorgang_id, client_amendment_id, sequence_no, status, content_fingerprint, confirmed_by)
  values (pg_temp.w(10), 'vg-ap7', 'na-ap7', 1, 'bestaetigt', repeat('b', 64), pg_temp.u(11));
  perform pg_temp.erwarte_abweisung('Nachtrag ausserhalb des Loeschwegs', format('delete from public.workspace_order_amendments where workspace_id = %L::uuid', pg_temp.w(10)), 'write-once');
  -- Eine datenfreie Prüfkopie kennt die Buckets nicht; im lokalen Stand bestehen sie (nur innerhalb dieser Transaktion).
  insert into storage.buckets (id, name, public) values ('workspace-files', 'workspace-files', false), ('branding-assets', 'branding-assets', false)
  on conflict (id) do nothing;
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('workspace-files', pg_temp.w(10)::text || '/' || repeat('a', 64), pg_temp.u(11), '{"size": 10}'),
         ('branding-assets', pg_temp.w(10)::text || '/logo.png', pg_temp.u(11), '{"size": 5}'),
         ('branding-assets', pg_temp.w(12)::text || '/logo.png', pg_temp.u(14), '{"size": 7}');
  select vault.create_secret('ap7-geheimnis', 'ap7-test-postfach-' || gen_random_uuid()::text) into v_vault;
  insert into merk values ('vault', v_vault::text);
  -- Stammzeile des Anbieters: in der datenfreien Prüfkopie nicht vorhanden, im lokalen Stand schon.
  insert into public.mailbox_provider_types (provider_type, auth_modes, source_kinds, description)
  values ('microsoft_graph', array['application', 'delegated'], array['folder'], 'Microsoft Graph')
  on conflict (provider_type) do nothing;
  insert into public.workspace_mailbox_connections (workspace_id, provider_type, auth_mode, mailbox_address, status, created_by)
  values (pg_temp.w(10), 'microsoft_graph', 'application', 'postfach-ap7@example.invalid', 'disconnected', pg_temp.u(11));
  insert into public.workspace_mailbox_credentials (connection_id, vault_secret_id)
  select c.id, v_vault from public.workspace_mailbox_connections c where c.workspace_id = pg_temp.w(10);
  insert into merk values ('w12', pg_temp.fingerabdruck(pg_temp.w(12))::text);
  raise notice 'OK  Aufbau W10 (Dokument, Speicherobjekte, Postfach mit Vault-Geheimnis) und Fingerabdruck von W12';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- L-06.1: DELETE eines geschuetzten Dokuments und die Kaskade von workspaces scheitern ausserhalb des Loeschwegs.
  if exists (select 1 from public.workspace_documents where workspace_id = pg_temp.w(10)) then
    perform pg_temp.erwarte_abweisung('L-06.1 direktes DELETE', format('delete from public.workspace_documents where workspace_id = %L::uuid', pg_temp.w(10)), 'Aufbewahrungsfrist');
    perform pg_temp.erwarte_abweisung('L-06.1 Kaskade', format('delete from public.workspaces where id = %L::uuid', pg_temp.w(10)), 'Aufbewahrungsfrist');
  end if;
  -- L-06.3: ein selbst gesetzter Marker ohne Auftrag deleting aendert nichts.
  perform pg_temp.erwarte_abweisung('L-06.3 Marker ohne Auftrag', format('select pg_temp.marker_und_loeschen(%L::uuid)', pg_temp.w(10)), 'Aufbewahrungsfrist');
  -- Antrag fuer W10 (Inhaber O10), Frist im Test abgelaufen.
  v := pg_temp.betrieb_beantragen(pg_temp.u(11), pg_temp.w(10), 'AP7 W10', public.workspace_deletion_notice_version(),
    pg_temp.nachweis(pg_temp.u(11), 'workspace_delete_request', pg_temp.w(10), pg_temp.r(70), 'o10-70'), pg_temp.r(70));
  update public.workspace_deletion_requests set execute_after = now() - interval '1 minute' where workspace_id = pg_temp.w(10);
  -- L-05.9: Mitglied, Admin, Inhaber, fremdes Konto, anon: keine Ausfuehrungsrechte.
  perform pg_temp.pruefe(not has_function_privilege('authenticated', 'public.workspace_deletion_begin(uuid, uuid, integer)', 'execute')
                         and not has_function_privilege('anon', 'public.workspace_deletion_begin(uuid, uuid, integer)', 'execute')
                         and not has_function_privilege('authenticated', 'public.workspace_deletion_execute(uuid, uuid)', 'execute')
                         and not has_function_privilege('anon', 'public.workspace_deletion_execute(uuid, uuid)', 'execute')
                         and not has_function_privilege('authenticated', 'public.workspace_deletion_mark_objects(uuid, uuid, jsonb)', 'execute')
                         and has_function_privilege('service_role', 'public.workspace_deletion_execute(uuid, uuid)', 'execute'), 'L-05.9 Rechte');
  perform pg_temp.erwarte_abweisung('L-05.9 Inhaber ruft execute direkt', format('select pg_temp.sql_als(%L::uuid, %L)', pg_temp.u(11),
    format('select public.workspace_deletion_execute(%L::uuid, gen_random_uuid())', pg_temp.w(10))), 'permission denied');
  -- Beginn: Arbeitsliste nur aus storage.objects unter dem Praefix von W10.
  v := public.workspace_deletion_begin(pg_temp.w(10), pg_temp.r(71), 600);
  perform pg_temp.pruefe(v->>'state' = 'deleting' and jsonb_array_length(v->'objects') = 2
                         and not (v->'objects')::text like '%' || pg_temp.w(12)::text || '%', 'L-05.10 Arbeitsliste: ' || v::text);
  -- L-05.10: untergeschobene Pfade (fremder Betrieb, ..) werden nicht markiert.
  v := public.workspace_deletion_mark_objects(pg_temp.w(10), pg_temp.r(71), jsonb_build_array(
    jsonb_build_object('bucket', 'branding-assets', 'name', pg_temp.w(12)::text || '/logo.png'),
    jsonb_build_object('bucket', 'branding-assets', 'name', pg_temp.w(10)::text || '/../' || pg_temp.w(12)::text || '/logo.png')));
  perform pg_temp.pruefe((v->>'marked')::int = 0, 'L-05.10 nichts Fremdes markiert');
  -- L-05.6: Objekte noch vorhanden -> execute weist ab, keine Zeile geloescht.
  v := public.workspace_deletion_execute(pg_temp.w(10), pg_temp.r(71));
  perform pg_temp.pruefe(v->>'code' = 'objects_remaining' and exists (select 1 from public.workspaces where id = pg_temp.w(10)), 'L-05.6 Restobjekte: ' || v::text);
  -- Speicher-API (simuliert): ein Objekt geloescht und vermerkt; das zweite fehlt noch.
  set local storage.allow_delete_query = 'true';
  delete from storage.objects where bucket_id = 'workspace-files' and name = pg_temp.w(10)::text || '/' || repeat('a', 64);
  v := public.workspace_deletion_mark_objects(pg_temp.w(10), pg_temp.r(71), jsonb_build_array(jsonb_build_object('bucket', 'workspace-files', 'name', pg_temp.w(10)::text || '/' || repeat('a', 64))));
  v := public.workspace_deletion_execute(pg_temp.w(10), pg_temp.r(71));
  perform pg_temp.pruefe(v->>'code' = 'objects_remaining', 'L-05.6 erster Lauf unvollstaendig: ' || v::text);
  -- Fremde Sperre: ein anderer Lauf darf weder vermerken noch ausfuehren.
  v := public.workspace_deletion_execute(pg_temp.w(10), gen_random_uuid());
  perform pg_temp.pruefe(v->>'code' = 'deletion_locked', 'L-05.5 fremder Lauf: ' || v::text);
  delete from storage.objects where bucket_id = 'branding-assets' and name = pg_temp.w(10)::text || '/logo.png';
  v := public.workspace_deletion_mark_objects(pg_temp.w(10), pg_temp.r(71), jsonb_build_array(jsonb_build_object('bucket', 'branding-assets', 'name', pg_temp.w(10)::text || '/logo.png')));
  set local storage.allow_delete_query = 'false';
  raise notice 'OK  L-06.1/L-06.3/L-05.9/L-05.10/L-05.6 Loeschschutz ausserhalb des Loeschwegs, Marker ohne Auftrag wirkungslos, keine Client-Rechte, Arbeitsliste nur unter dem Praefix, Restobjekte sperren die Ausfuehrung';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- L-05.7: ein Fehler in workspace_deletion_execute nimmt alles zurueck; der Auftrag bleibt deleting.
  create function pg_temp.stoer2() returns trigger language plpgsql as $f$ begin raise exception 'Stoerung im Loeschweg'; end; $f$;
  create trigger ap7_stoer2 before delete on public.workspace_setup for each row execute function pg_temp.stoer2();
  perform pg_temp.erwarte_abweisung('L-05.7 Fehler im Loeschweg', format('select public.workspace_deletion_execute(%L::uuid, %L::uuid)', pg_temp.w(10), pg_temp.r(71)), 'Stoerung im Loeschweg');
  perform pg_temp.pruefe(exists (select 1 from public.workspaces where id = pg_temp.w(10))
                         and exists (select 1 from public.workspace_documents where workspace_id = pg_temp.w(10))
                         and (select state = 'deleting' from public.workspace_deletion_requests where workspace_id = pg_temp.w(10)), 'L-05.7 zurueckgenommen, deleting');
  drop trigger ap7_stoer2 on public.workspace_setup;
  -- L-05.1/L-06.2: vollstaendige Ausfuehrung.
  v := public.workspace_deletion_execute(pg_temp.w(10), pg_temp.r(71));
  perform pg_temp.pruefe(v->>'state' = 'completed', 'L-05.1 Ausfuehrung: ' || v::text);
  perform pg_temp.pruefe(not exists (select 1 from public.workspaces where id = pg_temp.w(10)), 'L-05.1 Betrieb weg');
  perform pg_temp.pruefe(not exists (
      select 1 from jsonb_each_text(pg_temp.fingerabdruck(pg_temp.w(10)) - 'workspace' - 'storage') e
       where e.key not in ('workspace_deletion_requests', 'workspace_deletion_objects', 'workspace_deletion_log', 'platform_admin_events')
         and e.value <> '0:-'
    ), 'L-05.1 keine Zeile mit workspace_id von W10');
  perform pg_temp.pruefe((v->'table_counts' ? 'workspace_documents') and (v->'table_counts' ? 'workspace_members')
                         and (v->'table_counts' ? 'workspace_order_amendments') and (v->'table_counts' ? 'workspace_member_events'),
                         'L-05.1 Zaehlung je Tabelle (auch Nachtrag und Pruefspur): ' || (v->'table_counts')::text);
  perform pg_temp.pruefe(not exists (select 1 from storage.objects where left(name, 37) = pg_temp.w(10)::text || '/'), 'L-05.1 keine Objekte');
  perform pg_temp.pruefe(not exists (select 1 from vault.secrets where id = (select wert::uuid from merk where schluessel = 'vault')), 'L-05.1 Vault-Geheimnis weg');
  perform pg_temp.pruefe((select count(*) = 1 and bool_and(object_count = 2) and bool_and(not (table_counts::text ilike '%AP7%'))
                            from public.workspace_deletion_log where workspace_id = pg_temp.w(10)), 'L-05.1 Protokoll ohne Geschaeftsdaten');
  -- L-05.8: Wiederholung nach completed: keine zweite Wirkung, ein Protokolleintrag.
  v := public.workspace_deletion_execute(pg_temp.w(10), pg_temp.r(71));
  perform pg_temp.pruefe(v->>'replayed' = 'true' and (select count(*) = 1 from public.workspace_deletion_log where workspace_id = pg_temp.w(10)), 'L-05.8 Wiederholung: ' || v::text);
  -- L-05.4: Konten bestehen, ohne Mitgliedschaft.
  perform pg_temp.pruefe((select count(*) = 3 from public.profiles where id in (pg_temp.u(11), pg_temp.u(12), pg_temp.u(13)))
                         and not exists (select 1 from public.workspace_members where user_id in (pg_temp.u(12), pg_temp.u(13))), 'L-05.4 Konten bleiben');
  -- L-05.3: W12 inhaltlich unveraendert (Zeilen, Inhaltspruefsumme, Objekte).
  perform pg_temp.pruefe(pg_temp.fingerabdruck(pg_temp.w(12))::text = (select wert from merk where schluessel = 'w12'), 'L-05.3 andere Betriebe unveraendert');
  raise notice 'OK  L-05.1/L-05.3/L-05.4/L-05.7/L-05.8/L-06.2 Fehler zurueckgenommen; danach alle Zeilen, Objekte und Vault-Geheimnis weg, Protokoll ohne Geschaeftsdaten, Wiederholung ohne Wirkung, Konten bleiben, W12 unveraendert';
end;
$t$;

/* ------------------------------------------------------------------ */
/* Rechte und Planer                                                    */
/* ------------------------------------------------------------------ */
do $t$
declare
  v_tab text;
  v_fn text;
begin
  foreach v_tab in array array['public.destructive_action_confirmations', 'public.destructive_action_attempts', 'public.account_deletion_jobs',
                                'public.workspace_deletion_requests', 'public.workspace_deletion_objects', 'public.workspace_deletion_log'] loop
    perform pg_temp.pruefe(not has_table_privilege('authenticated', v_tab, 'select') and not has_table_privilege('anon', v_tab, 'select')
                           and not has_table_privilege('authenticated', v_tab, 'insert') and (select relrowsecurity from pg_class where oid = v_tab::regclass), v_tab);
  end loop;
  foreach v_fn in array array['public.destructive_action_issue(uuid, text, uuid, uuid, text)', 'public.destructive_action_record_failure(uuid)',
                               'public.account_deletion_auth_step(uuid, text, text)', 'public.account_deletion_complete(uuid)',
                               'public.account_deletion_pending_jobs(integer)', 'public.workspace_deletion_due(integer)'] loop
    perform pg_temp.pruefe(has_function_privilege('service_role', v_fn, 'execute') and not has_function_privilege('authenticated', v_fn, 'execute')
                           and not has_function_privilege('anon', v_fn, 'execute'), v_fn);
  end loop;
  foreach v_fn in array array['public.destructive_action_precheck(text, uuid)', 'public.account_deletion_begin(uuid, text, text)',
                               'public.workspace_request_deletion(uuid, text, text, text, uuid)', 'public.workspace_revoke_deletion(uuid, uuid)'] loop
    perform pg_temp.pruefe(has_function_privilege('authenticated', v_fn, 'execute') and not has_function_privilege('anon', v_fn, 'execute'), v_fn);
  end loop;
  foreach v_fn in array array['public.einrichtung01_consume_confirmation(uuid, text, uuid, uuid, text)', 'public.einrichtung01_deletion_path_active(uuid)',
                               'public.workspace_deletion_pending(uuid)', 'public.einrichtung01_scheduler_dispatch(text, text)'] loop
    perform pg_temp.pruefe(not has_function_privilege('authenticated', v_fn, 'execute') and not has_function_privilege('anon', v_fn, 'execute')
                           and not has_function_privilege('service_role', v_fn, 'execute'), v_fn);
  end loop;
  -- L-07.1: neue Planer vorhanden und inaktiv; Jobs 1 und 2 inaktiv.
  perform pg_temp.pruefe((select count(*) = 2 and bool_and(not active) from cron.job
                           where jobname in ('officetakt-workspace-deletion', 'officetakt-account-deletion-resume')), 'L-07.1 neue Planer inaktiv');
  perform pg_temp.pruefe(not exists (select 1 from cron.job where jobid in (1, 2) and active), 'L-07.1 Jobs 1 und 2 inaktiv');
  raise notice 'OK  Rechte (Tabellen ohne Client-Zugriff mit RLS, Dienstwege nur service_role, interne Helfer ohne Rechte) und L-07.1 Planer inaktiv';
end;
$t$;

rollback;
