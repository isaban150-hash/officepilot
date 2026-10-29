-- EINRICHTUNG-01 / AP4 -- Team, Einladungen, Uebergabe, Plattform-Verwaltung (Katalog V3, Abschnitte M und P; dazu
-- Z-09.5, K-02.4, N-M1.3 bis N-M1.5, N-M2.1/5/7, N-M3, N-P1.2, M-18.2). Paralleltests (Barrieren) laufen gesondert.
--
-- Als Rolle authenticated mit synthetischen Claims. Alles wird zurueckgerollt. Ausfuehren (nur lokal):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/einrichtung01_ap4_team.sql
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

create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text, p_code text default null)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    if p_code is not null and sqlstate <> p_code then
      raise exception '% -- falscher Fehlercode: % (erwartet: %)', p_label, sqlstate, p_code;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.pruefe(p_ok boolean, p_label text) returns void language plpgsql as $p$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FEHLER %', p_label;
  end if;
end;
$p$;

create temp table merk (k text primary key, v text);
grant all on merk to authenticated;

-- Konten (synthetisch). handle_new_user legt je Konto ein wartendes Profil an.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select v.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email, 'x',
       case when v.bestaetigt then now() end, now(), now(), '{}', jsonb_build_object('firstName', v.vorname, 'lastName', 'AP4')
from (values
  ('00000000-0000-0000-0000-0000000e4c01', 'o1-ap4@example.invalid', 'Olga', true),
  ('00000000-0000-0000-0000-0000000e4c02', 'a1-ap4@example.invalid', 'Anton', true),
  ('00000000-0000-0000-0000-0000000e4c03', 'al-ap4@example.invalid', 'Alma', true),
  ('00000000-0000-0000-0000-0000000e4c04', 'm1-ap4@example.invalid', 'Mira', true),
  ('00000000-0000-0000-0000-0000000e4c05', 'x1-ap4@example.invalid', 'Xaver', true),
  ('00000000-0000-0000-0000-0000000e4c06', 'x2-ap4@example.invalid', 'Xenia', false),
  ('00000000-0000-0000-0000-0000000e4c07', 'x3-ap4@example.invalid', 'Xorry', true),
  ('00000000-0000-0000-0000-0000000e4c08', 'b1-ap4@example.invalid', 'Bodo', true),
  ('00000000-0000-0000-0000-0000000e4c09', 'p1-ap4@example.invalid', 'Paula', true),
  ('00000000-0000-0000-0000-0000000e4c0a', 'n1-ap4@example.invalid', 'Nina', true),
  ('00000000-0000-0000-0000-0000000e4c0b', 'l1-ap4@example.invalid', 'Lars', true),
  ('00000000-0000-0000-0000-0000000e4c0c', 'a2-ap4@example.invalid', 'Arno', true),
  ('00000000-0000-0000-0000-0000000e4c0d', 'm2-ap4@example.invalid', 'Mona', true),
  ('00000000-0000-0000-0000-0000000e4c0e', 'pa1-ap4@example.invalid', 'Pia', true),
  ('00000000-0000-0000-0000-0000000e4c0f', 'pa2-ap4@example.invalid', 'Pit', true),
  ('00000000-0000-0000-0000-0000000e4c10', 'o6-ap4@example.invalid', 'Otto', true),
  ('00000000-0000-0000-0000-0000000e4c11', 'a6-ap4@example.invalid', 'Ada', true),
  ('00000000-0000-0000-0000-0000000e4c12', 'o8-ap4@example.invalid', 'Oda', true),
  ('00000000-0000-0000-0000-0000000e4c13', 'a8-ap4@example.invalid', 'Abel', true),
  ('00000000-0000-0000-0000-0000000e4c14', 'o7-ap4@example.invalid', 'Ole', true),
  ('00000000-0000-0000-0000-0000000e4c15', 'a7-ap4@example.invalid', 'Arne', true),
  ('00000000-0000-0000-0000-0000000e4c16', 'd1-ap4@example.invalid', 'Dora', true),
  ('00000000-0000-0000-0000-0000000e4c17', 'z1-ap4@example.invalid', 'Zora', true),
  ('00000000-0000-0000-0000-0000000e4c18', 'k-alt-ap4@example.invalid', 'Kai', true),
  -- M1b: zweites Mitglied in W1, Ziel der Matrixzeilen 5 und 8 (sonst traefe M1 in Spalte M1 sich selbst; M-19.2)
  ('00000000-0000-0000-0000-0000000e4c19', 'm1b-ap4@example.invalid', 'Milo', true),
  -- A2b: zweites Admin-Konto in W2, Ziel der Matrixzeilen 6 und 9 (sonst traefe A2 in Spalte A2 sich selbst; M-19.2)
  ('00000000-0000-0000-0000-0000000e4c1a', 'a2b-ap4@example.invalid', 'Alva', true)
) as v(id, email, vorname, bestaetigt);

-- Freigabe, Lizenz, Sperre, Plattformrolle
update public.profiles set status = 'approved' where id in (
  '00000000-0000-0000-0000-0000000e4c01', '00000000-0000-0000-0000-0000000e4c02', '00000000-0000-0000-0000-0000000e4c03',
  '00000000-0000-0000-0000-0000000e4c04', '00000000-0000-0000-0000-0000000e4c0a', '00000000-0000-0000-0000-0000000e4c0b',
  '00000000-0000-0000-0000-0000000e4c0c', '00000000-0000-0000-0000-0000000e4c0d', '00000000-0000-0000-0000-0000000e4c0e',
  '00000000-0000-0000-0000-0000000e4c0f', '00000000-0000-0000-0000-0000000e4c11', '00000000-0000-0000-0000-0000000e4c13',
  '00000000-0000-0000-0000-0000000e4c14', '00000000-0000-0000-0000-0000000e4c15', '00000000-0000-0000-0000-0000000e4c16',
  '00000000-0000-0000-0000-0000000e4c17', '00000000-0000-0000-0000-0000000e4c18', '00000000-0000-0000-0000-0000000e4c19',
  '00000000-0000-0000-0000-0000000e4c1a');
update public.profiles set license_status = 'active', license_expires_at = null where id in (
  '00000000-0000-0000-0000-0000000e4c01', '00000000-0000-0000-0000-0000000e4c03', '00000000-0000-0000-0000-0000000e4c0c',
  '00000000-0000-0000-0000-0000000e4c11', '00000000-0000-0000-0000-0000000e4c13', '00000000-0000-0000-0000-0000000e4c14',
  '00000000-0000-0000-0000-0000000e4c15', '00000000-0000-0000-0000-0000000e4c16');
update public.profiles set license_status = 'expired' where id = '00000000-0000-0000-0000-0000000e4c0b';
update public.profiles set status = 'blocked' where id in ('00000000-0000-0000-0000-0000000e4c08', '00000000-0000-0000-0000-0000000e4c10');
update public.profiles set role = 'admin' where id in ('00000000-0000-0000-0000-0000000e4c0e', '00000000-0000-0000-0000-0000000e4c0f');
-- Unbeteiligte Plattform-Admins aus Altbestaenden duerfen die Plattformfaelle nicht verfaelschen: nur PA1 und PA2 zaehlen.
update public.profiles set role = 'user' where role = 'admin' and id not in ('00000000-0000-0000-0000-0000000e4c0e', '00000000-0000-0000-0000-0000000e4c0f');

-- Betriebe
insert into public.workspaces (id, name, owner_user_id) values
  ('00000000-0000-0000-0000-0000000e4ca1', 'AP4 Alt', '00000000-0000-0000-0000-0000000e4c01'),
  ('00000000-0000-0000-0000-0000000e4ca2', 'AP4 W2', '00000000-0000-0000-0000-0000000e4c0b'),
  ('00000000-0000-0000-0000-0000000e4ca3', 'AP4 W3', '00000000-0000-0000-0000-0000000e4c16'),
  ('00000000-0000-0000-0000-0000000e4ca6', 'AP4 W6', '00000000-0000-0000-0000-0000000e4c10'),
  ('00000000-0000-0000-0000-0000000e4ca7', 'AP4 W7', '00000000-0000-0000-0000-0000000e4c14'),
  ('00000000-0000-0000-0000-0000000e4ca8', 'AP4 W8', '00000000-0000-0000-0000-0000000e4c12');
insert into public.workspace_members (workspace_id, user_id, role, status) values
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c01', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c02', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c03', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c04', 'member', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c19', 'member', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca2', '00000000-0000-0000-0000-0000000e4c0b', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca2', '00000000-0000-0000-0000-0000000e4c0c', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca2', '00000000-0000-0000-0000-0000000e4c0d', 'member', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca2', '00000000-0000-0000-0000-0000000e4c1a', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca3', '00000000-0000-0000-0000-0000000e4c16', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca6', '00000000-0000-0000-0000-0000000e4c10', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca6', '00000000-0000-0000-0000-0000000e4c11', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca7', '00000000-0000-0000-0000-0000000e4c14', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca7', '00000000-0000-0000-0000-0000000e4c15', 'admin', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca8', '00000000-0000-0000-0000-0000000e4c12', 'owner', 'active'),
  ('00000000-0000-0000-0000-0000000e4ca8', '00000000-0000-0000-0000-0000000e4c13', 'admin', 'active');
insert into public.workspace_company_profiles (workspace_id, payload, row_version)
values ('00000000-0000-0000-0000-0000000e4ca1', '{"companyName":"AP4 Alt","email":"info@ap4.example"}'::jsonb, 3);

-- Offene Einladungen fuer die Matrix (Zeilen 3 und 4)
insert into public.workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at) values
  ('00000000-0000-0000-0000-0000000e4e31', '00000000-0000-0000-0000-0000000e4ca1', 'matrix-m@example.invalid', 'member', extensions.digest('matrix-token-w1-member-0000000000', 'sha256'), '00000000-0000-0000-0000-0000000e4c01', now() + interval '7 days'),
  ('00000000-0000-0000-0000-0000000e4e41', '00000000-0000-0000-0000-0000000e4ca1', 'matrix-a@example.invalid', 'admin', extensions.digest('matrix-token-w1-admin-00000000000', 'sha256'), '00000000-0000-0000-0000-0000000e4c01', now() + interval '7 days'),
  ('00000000-0000-0000-0000-0000000e4e32', '00000000-0000-0000-0000-0000000e4ca2', 'matrix-m@example.invalid', 'member', extensions.digest('matrix-token-w2-member-0000000000', 'sha256'), '00000000-0000-0000-0000-0000000e4c0b', now() + interval '7 days'),
  ('00000000-0000-0000-0000-0000000e4e42', '00000000-0000-0000-0000-0000000e4ca2', 'matrix-a@example.invalid', 'admin', extensions.digest('matrix-token-w2-admin-00000000000', 'sha256'), '00000000-0000-0000-0000-0000000e4c0b', now() + interval '7 days');

/* ======================================================================== */
/* M-02 -- Matrix Aktion x Rolle x Zielrolle                                 */
/* ======================================================================== */
create temp table matrix (zeile int, spalte text, akteur uuid, befehl text, erwartet text);
do $$
declare
  c record;
  r int;
  w1 uuid := '00000000-0000-0000-0000-0000000e4ca1';
  w2 uuid := '00000000-0000-0000-0000-0000000e4ca2';
begin
  for c in
    select * from (values
      ('O1',    '00000000-0000-0000-0000-0000000e4c01'::uuid, w1, '00000000-0000-0000-0000-0000000e4c19'::uuid, '00000000-0000-0000-0000-0000000e4c03'::uuid, '00000000-0000-0000-0000-0000000e4c01'::uuid, '00000000-0000-0000-0000-0000000e4e31'::uuid, '00000000-0000-0000-0000-0000000e4e41'::uuid, '00000000-0000-0000-0000-0000000e4c03'::uuid, 'E E E E E E A E E A A A E E E E E A A'),
      ('A1',    '00000000-0000-0000-0000-0000000e4c02'::uuid, w1, '00000000-0000-0000-0000-0000000e4c19'::uuid, '00000000-0000-0000-0000-0000000e4c03'::uuid, '00000000-0000-0000-0000-0000000e4c01'::uuid, '00000000-0000-0000-0000-0000000e4e31'::uuid, '00000000-0000-0000-0000-0000000e4e41'::uuid, '00000000-0000-0000-0000-0000000e4c03'::uuid, 'E A E A A A A E A A A E A E E E E A A'),
      ('M1',    '00000000-0000-0000-0000-0000000e4c04'::uuid, w1, '00000000-0000-0000-0000-0000000e4c19'::uuid, '00000000-0000-0000-0000-0000000e4c03'::uuid, '00000000-0000-0000-0000-0000000e4c01'::uuid, '00000000-0000-0000-0000-0000000e4e31'::uuid, '00000000-0000-0000-0000-0000000e4e41'::uuid, '00000000-0000-0000-0000-0000000e4c03'::uuid, 'A A A A A A A A A A A E A A E A A A A'),
      ('fremd', '00000000-0000-0000-0000-0000000e4c01'::uuid, w2, '00000000-0000-0000-0000-0000000e4c0d'::uuid, '00000000-0000-0000-0000-0000000e4c1a'::uuid, '00000000-0000-0000-0000-0000000e4c0b'::uuid, '00000000-0000-0000-0000-0000000e4e32'::uuid, '00000000-0000-0000-0000-0000000e4e42'::uuid, '00000000-0000-0000-0000-0000000e4c0c'::uuid, 'A A A A A A A A A A - - A A A A A A A'),
      ('L1',    '00000000-0000-0000-0000-0000000e4c0b'::uuid, w2, '00000000-0000-0000-0000-0000000e4c0d'::uuid, '00000000-0000-0000-0000-0000000e4c1a'::uuid, '00000000-0000-0000-0000-0000000e4c0b'::uuid, '00000000-0000-0000-0000-0000000e4e32'::uuid, '00000000-0000-0000-0000-0000000e4e42'::uuid, '00000000-0000-0000-0000-0000000e4c0c'::uuid, 'A A E E A E A E E A A A E A E E E A A'),
      ('A2',    '00000000-0000-0000-0000-0000000e4c0c'::uuid, w2, '00000000-0000-0000-0000-0000000e4c0d'::uuid, '00000000-0000-0000-0000-0000000e4c1a'::uuid, '00000000-0000-0000-0000-0000000e4c0b'::uuid, '00000000-0000-0000-0000-0000000e4e32'::uuid, '00000000-0000-0000-0000-0000000e4e42'::uuid, '00000000-0000-0000-0000-0000000e4c0c'::uuid, 'A A E A A A A E A A A E A A E E E A A')
    ) as t(spalte, akteur, ws, mitglied, admin_ziel, inhaber, inv_m, inv_a, uebergabe_ziel, erwartung)
  loop
    -- Zeilen 1-17 laut Katalog; Zeile 18 (direkte Tabellenwege) mit zwei Stichproben je Spalte (18, 19).
    insert into matrix values
      (1,  c.spalte, c.akteur, format('select public.team_invite(%L, %L, ''member'', gen_random_uuid())', c.ws, 'neu-m-' || c.spalte || '@example.invalid'), split_part(c.erwartung, ' ', 1)),
      (2,  c.spalte, c.akteur, format('select public.team_invite(%L, %L, ''admin'', gen_random_uuid())', c.ws, 'neu-a-' || c.spalte || '@example.invalid'), split_part(c.erwartung, ' ', 2)),
      (3,  c.spalte, c.akteur, format('select public.team_revoke_invitation(%L, gen_random_uuid())', c.inv_m), split_part(c.erwartung, ' ', 3)),
      (4,  c.spalte, c.akteur, format('select public.team_revoke_invitation(%L, gen_random_uuid())', c.inv_a), split_part(c.erwartung, ' ', 4)),
      (5,  c.spalte, c.akteur, format('select public.team_change_role(%L, %L, ''admin'', gen_random_uuid())', c.ws, c.mitglied), split_part(c.erwartung, ' ', 5)),
      (6,  c.spalte, c.akteur, format('select public.team_change_role(%L, %L, ''member'', gen_random_uuid())', c.ws, c.admin_ziel), split_part(c.erwartung, ' ', 6)),
      (7,  c.spalte, c.akteur, format('select public.team_change_role(%L, %L, ''member'', gen_random_uuid())', c.ws, c.inhaber), split_part(c.erwartung, ' ', 7)),
      (8,  c.spalte, c.akteur, format('select public.team_remove_member(%L, %L, gen_random_uuid())', c.ws, c.mitglied), split_part(c.erwartung, ' ', 8)),
      (9,  c.spalte, c.akteur, format('select public.team_remove_member(%L, %L, gen_random_uuid())', c.ws, c.admin_ziel), split_part(c.erwartung, ' ', 9)),
      (10, c.spalte, c.akteur, format('select public.team_remove_member(%L, %L, gen_random_uuid())', c.ws, c.inhaber), split_part(c.erwartung, ' ', 10)),
      (11, c.spalte, c.akteur, format('select public.team_remove_member(%L, %L, gen_random_uuid())', c.ws, c.akteur), split_part(c.erwartung, ' ', 11)),
      (12, c.spalte, c.akteur, format('select public.team_leave(%L, gen_random_uuid())', c.ws), split_part(c.erwartung, ' ', 12)),
      (13, c.spalte, c.akteur, format('select public.team_request_transfer(%L, %L, gen_random_uuid())', c.ws, c.uebergabe_ziel), split_part(c.erwartung, ' ', 13)),
      (14, c.spalte, c.akteur, format('select public.team_rename_workspace(%L, ''AP4 Matrix'', gen_random_uuid())', c.ws), split_part(c.erwartung, ' ', 14)),
      (15, c.spalte, c.akteur, format('select public.team_list_members(%L)', c.ws), split_part(c.erwartung, ' ', 15)),
      (16, c.spalte, c.akteur, format('select public.team_list_invitations(%L)', c.ws), split_part(c.erwartung, ' ', 16)),
      (17, c.spalte, c.akteur, format('select public.team_list_events(%L, 10)', c.ws), split_part(c.erwartung, ' ', 17)),
      (18, c.spalte, c.akteur, format('insert into public.workspace_members (workspace_id, user_id, role, status) values (%L, %L, ''admin'', ''active'')', c.ws, '00000000-0000-0000-0000-0000000e4c17'), split_part(c.erwartung, ' ', 18)),
      (19, c.spalte, c.akteur, format('update public.workspace_invitations set role = ''admin'' where id = %L', c.inv_m), split_part(c.erwartung, ' ', 19));
  end loop;
end $$;

-- Weitere direkte Tabellenwege (Zeile 18): Pruefspur und Uebergaben, fuer jede Spalte.
insert into matrix
select 18, spalte, akteur, 'delete from public.workspace_member_events', 'A' from (select distinct spalte, akteur from matrix) s
union all
select 18, spalte, akteur, 'update public.workspace_ownership_transfers set status = ''accepted''', 'A' from (select distinct spalte, akteur from matrix) s;

do $$
declare
  m record;
  v_ergebnis text;
  v_fehler text;
  v_code text;
  v_abweichungen text := '';
  v_zellen int := 0;
begin
  for m in select * from matrix where erwartet <> '-' order by zeile, spalte loop
    v_zellen := v_zellen + 1;
    begin
      perform pg_temp.als(m.akteur);
      execute m.befehl;
      raise exception 'ERLAUBT';
    exception when others then
      v_fehler := sqlerrm;
      v_code := sqlstate;
    end;
    v_ergebnis := case when v_fehler = 'ERLAUBT' then 'E' else 'A' end;
    if v_ergebnis <> m.erwartet then
      v_abweichungen := v_abweichungen || format(E'\n  Zeile %s / %s: erwartet %s, ist %s (%s)', m.zeile, m.spalte, m.erwartet, v_ergebnis, v_fehler);
    elsif v_ergebnis = 'A' and (v_code <> '42501' or v_fehler !~ '^(team_|license_not_effective|permission denied)') then
      v_abweichungen := v_abweichungen || format(E'\n  Zeile %s / %s: Abweisung ohne Vertragscode: %s %s', m.zeile, m.spalte, v_code, v_fehler);
    end if;
  end loop;
  if v_abweichungen <> '' then
    raise exception 'M-02 Matrix abweichend:%', v_abweichungen;
  end if;
  raise notice 'OK  M-02.1-M-02.18 Matrix: % Zellen wie erwartet (Abweisung 42501 mit Code, jede Zelle zurueckgerollt)', v_zellen;
end $$;

/* ======================================================================== */
/* M-01 -- Einladung erzeugen, wiederholen, neu senden, Ablauf               */
/* ======================================================================== */
do $$
declare
  r jsonb;
  r2 jsonb;
  v_token text;
  v_inv public.workspace_invitations;
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', '  X1-AP4@Example.INVALID ', 'member', '00000000-0000-0000-0000-0000000e4d01');
  perform pg_temp.zurueck();
  v_token := r->>'token';
  perform pg_temp.pruefe(r->>'status' = 'created' and length(v_token) >= 40, 'M-01.1 Einladung nicht erzeugt: ' || r::text);
  select * into v_inv from public.workspace_invitations where id = (r->>'invitation_id')::uuid;
  perform pg_temp.pruefe(v_inv.email = 'x1-ap4@example.invalid' and v_inv.role = 'member' and v_inv.workspace_id = '00000000-0000-0000-0000-0000000e4ca1', 'M-01.1 Bindung falsch');
  perform pg_temp.pruefe(v_inv.expires_at = v_inv.created_at + interval '7 days', 'M-01.1 Ablauf nicht +7 Tage');
  perform pg_temp.pruefe(v_inv.token_hash = extensions.digest(v_token, 'sha256'), 'M-01.1 Hash passt nicht');
  -- kein Klartext-Token in der Datenbank (Einladungen, Pruefspur, Idempotenzlog)
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_invitations i where strpos(i::text, v_token) > 0), 'M-01.1 Klartext in Einladungen');
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_member_events e where strpos(e::text, v_token) > 0), 'M-01.1 Klartext in Pruefspur');
  perform pg_temp.pruefe(not exists (select 1 from public.einrichtung_request_log l where strpos(l::text, v_token) > 0), 'M-01.1 Klartext im Anfrage-Log');
  insert into merk values ('x1_token', v_token), ('x1_inv', r->>'invitation_id');

  -- M-01.2: dieselbe E-Mail erneut -> dieselbe Einladung, kein neues Token
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r2 := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'x1-ap4@example.invalid', 'member', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r2->>'status' = 'already_invited' and r2->>'invitation_id' = r->>'invitation_id' and r2->'token' = 'null'::jsonb, 'M-01.2 ' || r2::text);
  perform pg_temp.pruefe((select token_hash from public.workspace_invitations where id = v_inv.id) = v_inv.token_hash, 'M-01.2 Token geaendert');
  -- M-01.4: Rolle aendert sich nur ueber Widerruf und neue Einladung
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r2 := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'x1-ap4@example.invalid', 'admin', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r2->>'status' = 'already_invited' and r2->>'role' = 'member', 'M-01.4 Rolle geaendert: ' || r2::text);
  perform pg_temp.pruefe((select count(*) from public.workspace_invitations where email = 'x1-ap4@example.invalid' and status = 'open') = 1, 'M-01.2 zweite Einladung');

  -- Idempotenz: Wiederholung mit derselben Anfrage-ID liefert das Ergebnis ohne Token und ohne zweiten Eintrag
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r2 := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'x1-ap4@example.invalid', 'member', '00000000-0000-0000-0000-0000000e4d01');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((r2->>'replayed')::boolean and r2->>'invitation_id' = r->>'invitation_id' and r2->'token' = 'null'::jsonb, 'M-16.2 Replay ' || r2::text);
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where invitation_id = v_inv.id and action = 'invitation_created') = 1, 'M-16.2 zweiter Eintrag');

  -- M-01.3: neu senden -- zu frueh abgewiesen; nach 10 Minuten neues Token, altes ungueltig, neuer Ablauf
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('M-01.3 zu frueh', format('select public.team_resend_invitation(%L, gen_random_uuid())', v_inv.id), 'invitation_resend_too_soon', '42501');
  perform pg_temp.zurueck();
  update public.workspace_invitations set last_sent_at = now() - interval '11 minutes', created_at = now() - interval '1 day', expires_at = now() + interval '6 days' where id = v_inv.id;
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r2 := public.team_resend_invitation(v_inv.id, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r2->>'token' is not null and r2->>'token' <> v_token and (r2->>'resend_count')::int = 1, 'M-01.3 neu senden ' || r2::text);
  perform pg_temp.pruefe((select expires_at from public.workspace_invitations where id = v_inv.id) = now() + interval '7 days', 'M-01.3 neuer Ablauf');
  perform pg_temp.pruefe((select count(*) from public.workspace_invitations where email = 'x1-ap4@example.invalid') = 1, 'M-01.3 zweite Einladung');
  -- das alte Token ist ungueltig
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c05');
  perform pg_temp.pruefe(public.invitation_preview(v_token)->>'code' = 'invitation_invalid', 'M-01.3 altes Token gilt noch');
  perform pg_temp.zurueck();
  update merk set v = r2->>'token' where k = 'x1_token';
  -- hoechstens fuenfmal
  update public.workspace_invitations set resend_count = 5, last_sent_at = now() - interval '11 minutes' where id = v_inv.id;
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('M-17.2 sechstes Senden', format('select public.team_resend_invitation(%L, gen_random_uuid())', v_inv.id), 'invitation_resend_limit', '42501');
  perform pg_temp.zurueck();
  update public.workspace_invitations set resend_count = 1 where id = v_inv.id;
  -- X1 hat inzwischen gezaehlte Fehlversuche (altes Token); fuer die folgenden Faelle leeren.
  delete from public.workspace_invitation_attempts where user_id = '00000000-0000-0000-0000-0000000e4c05';
  raise notice 'OK  M-01.1-M-01.4, M-16.2, M-17.2 Einladung: Hash statt Klartext, +7 Tage, gleiche Einladung, neu senden mit Abstand und Grenze';
end $$;

/* ======================================================================== */
/* M-03 bis M-07 -- Einladungsweg C                                          */
/* ======================================================================== */
do $$
declare
  r jsonb;
  v_inv_x2 uuid;
  v_inv_x3 uuid;
  v_inv_b1 uuid;
  v_tok_x2 text;
  v_tok_x3 text;
  v_tok_b1 text;
begin
  -- Einladungen fuer X2 (unbestaetigt), X3 (wartend), B1 (gesperrt) durch O1
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'x2-ap4@example.invalid', 'member', gen_random_uuid());
  v_inv_x2 := (r->>'invitation_id')::uuid; v_tok_x2 := r->>'token';
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'x3-ap4@example.invalid', 'member', gen_random_uuid());
  v_inv_x3 := (r->>'invitation_id')::uuid; v_tok_x3 := r->>'token';
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'b1-ap4@example.invalid', 'member', gen_random_uuid());
  v_inv_b1 := (r->>'invitation_id')::uuid; v_tok_b1 := r->>'token';
  perform pg_temp.zurueck();

  -- M-03.5: X3 vor der Annahme -- kein Pull, kein Sync-Schreiben, keine Finanzaktion fuer W1
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c07');
  perform pg_temp.erwarte_abweisung('M-03.5 Pull', 'select public.pull_workspace_sync_state(''00000000-0000-0000-0000-0000000e4ca1'')', 'Kein Zugriff');
  perform pg_temp.erwarte_abweisung('M-03.5 Team', 'select public.team_list_members(''00000000-0000-0000-0000-0000000e4ca1'')', 'account_not_approved', '42501');
  perform pg_temp.erwarte_abweisung('M-03.5 Finanz', 'select public.set_workspace_invoice_number_format(''00000000-0000-0000-0000-0000000e4ca1'', ''RE'', true, 4, 0)', 'Kein Zugriff');
  perform pg_temp.zurueck();

  -- M-03.2: unbestaetigte E-Mail -- abgewiesen bis zur Bestaetigung; M-07.2: kein Einladungshinweis
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c06');
  r := public.accept_invitation(null, v_tok_x2, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_email_unconfirmed', 'M-03.2 ' || r::text);
  perform pg_temp.pruefe(public.list_my_invitations() = '[]'::jsonb, 'M-07.2 Hinweis trotz unbestaetigter E-Mail');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c06'), 'M-03.2 Mitgliedschaft entstanden');

  -- M-03.3 / M-03.7: gesperrt -- Anzeigen und Annehmen abgewiesen; Status bleibt, Einladung offen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c08');
  perform pg_temp.erwarte_abweisung('M-03.3 Annahme', format('select public.accept_invitation(null, %L, gen_random_uuid())', v_tok_b1), 'account_blocked', '42501');
  perform pg_temp.erwarte_abweisung('M-03.7 Anzeigen', 'select public.list_my_invitations()', 'account_blocked', '42501');
  perform pg_temp.erwarte_abweisung('M-03.7 Ablehnen', format('select public.decline_invitation(null, %L, gen_random_uuid())', v_tok_b1), 'account_blocked', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c08') = 'blocked', 'M-03.3 Sperre aufgehoben');
  perform pg_temp.pruefe((select status from public.workspace_invitations where id = v_inv_b1) = 'open', 'M-03.3 Einladung nicht mehr offen');

  -- M-03.7: P1 ohne Einladung -- leere, neutrale Antworten
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c09');
  perform pg_temp.pruefe(public.list_my_invitations() = '[]'::jsonb, 'M-03.7 P1 Liste');
  r := public.invitation_preview('ein-unbekanntes-token-ohne-bedeutung-000000');
  perform pg_temp.pruefe(r = '{"ok": false, "code": "invitation_invalid"}'::jsonb, 'M-03.7 P1 Ansicht ' || r::text);
  perform pg_temp.zurueck();

  -- M-03.4 / M-03.1 / Z-01.4: X3 (wartend) nimmt an -> approved, member in W1, Pruefspur, keine eigene Lizenz, kein eigener Betrieb
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c07');
  r := public.list_my_invitations();
  perform pg_temp.pruefe(jsonb_array_length(r) = 1 and r->0->>'workspace_name' = 'AP4 Alt' and r->0->>'role' = 'member', 'M-07.1 Hinweis ' || r::text);
  r := public.accept_invitation(v_inv_x3, null, gen_random_uuid());
  perform pg_temp.pruefe(r->>'status' = 'accepted', 'M-03.4 Annahme ' || r::text);
  -- M-03.6: danach nur rollenberechtigt
  perform public.pull_workspace_sync_state('00000000-0000-0000-0000-0000000e4ca1');
  perform pg_temp.erwarte_abweisung('M-03.6 Finanz', 'select public.set_workspace_invoice_number_format(''00000000-0000-0000-0000-0000000e4ca1'', ''RE'', true, 4, 0)', 'finance_forbidden_role');
  perform pg_temp.erwarte_abweisung('M-03.6 Team', 'select public.team_invite(''00000000-0000-0000-0000-0000000e4ca1'', ''y@example.invalid'', ''member'', gen_random_uuid())', 'team_forbidden_role', '42501');
  r := public.ensure_personal_workspace(null);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c07') = 'approved', 'M-03.4 nicht approved');
  perform pg_temp.pruefe((select license_status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c07') = 'inactive', 'M-03.1 Lizenz vergeben');
  perform pg_temp.pruefe((select role from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c07' and workspace_id = '00000000-0000-0000-0000-0000000e4ca1' and status = 'active') = 'member', 'M-03.4 Mitgliedschaft');
  perform pg_temp.pruefe(r->'workspace'->>'id' = '00000000-0000-0000-0000-0000000e4ca1' and not (r->>'created')::boolean, 'Z-01.4 ensure bindet W1 ' || r::text);
  perform pg_temp.pruefe((select count(*) from public.workspaces where owner_user_id = '00000000-0000-0000-0000-0000000e4c07') = 0, 'M-03.1 eigener Betrieb');
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where target_user_id = '00000000-0000-0000-0000-0000000e4c07' and action = 'account_approved_by_invitation') = 1, 'M-03.4 Pruefspur approved_by_invitation');
  raise notice 'OK  M-03.1-M-03.7, M-07.1, M-07.2, Z-01.4 Einladungsweg C: Bestaetigung, Sperre, neutrale Antwort, Freigabe nur durch Annahme';
end $$;

do $$
declare
  r jsonb;
  v_tok text := (select v from merk where k = 'x1_token');
  v_inv uuid := (select v from merk where k = 'x1_inv')::uuid;
  v_events int;
begin
  -- M-04.1: falsches Konto nimmt an -> abgewiesen, Einladung bleibt offen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_invalid', 'M-04.1 ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.workspace_invitations where id = v_inv) = 'open', 'M-04.1 nicht mehr offen');
  -- M-04.2: X1 nimmt an
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c05');
  r := public.accept_invitation(null, v_tok, '00000000-0000-0000-0000-0000000e4d02');
  perform pg_temp.pruefe(r->>'status' = 'accepted', 'M-04.2 ' || r::text);
  perform pg_temp.zurueck();
  v_events := (select count(*) from public.workspace_member_events where invitation_id = v_inv);
  -- M-04.3: erneut annehmen -> bereits Mitglied, keine zweite Mitgliedschaft und Pruefspur (andere und gleiche Anfrage-ID)
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c05');
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'status' = 'already_member', 'M-04.3 ' || r::text);
  r := public.accept_invitation(null, v_tok, '00000000-0000-0000-0000-0000000e4d02');
  perform pg_temp.pruefe((r->>'replayed')::boolean and r->>'status' = 'accepted', 'M-04.3 Replay ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c05') = 1, 'M-04.3 zweite Mitgliedschaft');
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where invitation_id = v_inv) = v_events, 'M-04.3 zweite Pruefspur');
  -- M-04.4: verbrauchte Einladung, anderes Konto -> "Einladung ungueltig"
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r = '{"ok": false, "code": "invitation_invalid"}'::jsonb, 'M-04.4 ' || r::text);
  perform pg_temp.zurueck();
  raise notice 'OK  M-04.1-M-04.4 Annahme: falsches Konto abgewiesen, idempotent, verbraucht = ungueltig';
end $$;

do $$
declare
  r jsonb;
  v_tok text;
  v_inv uuid;
  i int;
begin
  -- M-05.1 / M-01.5 / N-M1.3: Ablauf = jetzt -> abgelaufen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'z1-ap4@example.invalid', 'member', gen_random_uuid());
  perform pg_temp.zurueck();
  v_tok := r->>'token'; v_inv := (r->>'invitation_id')::uuid;
  update public.workspace_invitations set created_at = now() - interval '7 days', expires_at = now() where id = v_inv;
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_expired', 'M-05.1 ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c17'), 'M-05.1 Mitgliedschaft');
  -- M-05.2: widerrufen -> Ablehnung
  update public.workspace_invitations set expires_at = now() + interval '1 day' where id = v_inv;
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform public.team_revoke_invitation(v_inv, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_revoked', 'M-05.2 ' || r::text);
  perform pg_temp.zurueck();

  -- M-06.1: 10 Fehlversuche in 60 Minuten -> der 11. wird ohne Tokenpruefung abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'z1-ap4@example.invalid', 'member', gen_random_uuid());
  perform pg_temp.zurueck();
  v_tok := r->>'token';
  delete from public.workspace_invitation_attempts where user_id = '00000000-0000-0000-0000-0000000e4c17';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  for i in 1..10 loop
    r := public.invitation_preview('falsches-token-' || i || '-0000000000000000000000');
    perform pg_temp.pruefe(r->>'code' = 'invitation_invalid', 'M-06.4 unbekanntes Token ' || i);
  end loop;
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_rate_limited', 'M-06.1 11. Versuch ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspace_invitation_attempts where user_id = '00000000-0000-0000-0000-0000000e4c17') = 10, 'M-06.1 elfter gezaehlt');
  -- M-06.2: nach Fensterende wieder geprueft
  update public.workspace_invitation_attempts set attempted_at = now() - interval '61 minutes' where user_id = '00000000-0000-0000-0000-0000000e4c17';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  r := public.accept_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'status' = 'accepted', 'M-06.2 ' || r::text);
  perform pg_temp.zurueck();
  -- M-06.4 / N-M1.5: unbekanntes und fremdes Token -> dieselbe Meldung
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c09');
  perform pg_temp.pruefe(public.invitation_preview('matrix-token-w2-member-0000000000') = public.invitation_preview('nicht-vorhanden-0000000000000000000000'), 'M-06.4 unterscheidbar');
  perform pg_temp.zurueck();
  raise notice 'OK  M-01.5, M-05.1, M-05.2, M-06.1, M-06.2, M-06.4, N-M1.3, N-M1.5 Ablauf, Widerruf, Ratenlimit, keine Existenzangabe';
end $$;

do $$
declare
  r jsonb;
  v_tok text;
begin
  -- M-07.4 / Z-09.5: offene Einladung -> ensure meldet invitation_pending, auch mit eigener Lizenz kein eigener Betrieb
  update public.profiles set license_status = 'active', license_expires_at = null where id = '00000000-0000-0000-0000-0000000e4c0a';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'n1-ap4@example.invalid', 'member', gen_random_uuid());
  perform pg_temp.zurueck();
  v_tok := r->>'token';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0a');
  r := public.ensure_personal_workspace('Eigener');
  perform pg_temp.pruefe(r->>'reason' = 'invitation_pending' and r->'workspace' = 'null'::jsonb, 'M-07.4 ' || r::text);
  -- M-07.3: ablehnen -> declined; danach eigener Betrieb nur mit Lizenz
  r := public.decline_invitation(null, v_tok, gen_random_uuid());
  perform pg_temp.pruefe(r->>'status' = 'declined', 'M-07.3 ' || r::text);
  perform pg_temp.zurueck();
  update public.profiles set license_status = 'inactive' where id = '00000000-0000-0000-0000-0000000e4c0a';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0a');
  r := public.ensure_personal_workspace('Eigener');
  perform pg_temp.pruefe(r->>'reason' = 'no_license', 'M-07.3 ohne Lizenz ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspaces where owner_user_id = '00000000-0000-0000-0000-0000000e4c0a') = 0, 'M-07.4 eigener Betrieb entstanden');
  raise notice 'OK  M-07.3, M-07.4, Z-09.5 (ohne Parallelitaet) Einladungsvorrang in ensure';
end $$;

/* K-02.4 -- Einladung an die neue Adresse erst nach vollstaendigem Wechsel; die alte Adresse danach nicht mehr */
do $$
declare
  r jsonb;
  v_neu text;
  v_alt text;
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c16');
  v_neu := public.team_invite('00000000-0000-0000-0000-0000000e4ca3', 'k-neu-ap4@example.invalid', 'member', gen_random_uuid())->>'token';
  v_alt := public.team_invite('00000000-0000-0000-0000-0000000e4ca3', 'k-alt-ap4@example.invalid', 'member', gen_random_uuid())->>'token';
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c18');
  r := public.accept_invitation(null, v_neu, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_invalid', 'K-02.4 vor dem Wechsel ' || r::text);
  perform pg_temp.zurueck();
  -- Supabase Auth schreibt die neue Adresse erst nach beiden Bestaetigungen nach auth.users.email.
  update auth.users set email = 'k-neu-ap4@example.invalid' where id = '00000000-0000-0000-0000-0000000e4c18';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c18');
  r := public.accept_invitation(null, v_alt, gen_random_uuid());
  perform pg_temp.pruefe(r->>'code' = 'invitation_invalid', 'K-02.4 alte Adresse ' || r::text);
  r := public.accept_invitation(null, v_neu, gen_random_uuid());
  perform pg_temp.pruefe(r->>'status' = 'accepted', 'K-02.4 nach dem Wechsel ' || r::text);
  perform pg_temp.zurueck();
  raise notice 'OK  K-02.4 Einladung folgt der bestaetigten Adresse';
end $$;

/* ======================================================================== */
/* M-08 -- Sichtbarkeit; N-M3.1                                              */
/* ======================================================================== */
do $$
declare
  r jsonb;
  v_text text;
begin
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c04');
  r := public.team_list_members('00000000-0000-0000-0000-0000000e4ca1');
  perform pg_temp.pruefe(not exists (select 1 from jsonb_array_elements(r) e where e ? 'email' or e ? 'transfer_eligible'), 'M-08.1 Mitglied sieht E-Mail');
  perform pg_temp.pruefe(exists (select 1 from jsonb_array_elements(r) e where e->>'name' = 'Olga AP4' and e->>'role' = 'owner'), 'M-08.1 Name/Rolle fehlt');
  v_text := public.pull_workspace_sync_state('00000000-0000-0000-0000-0000000e4ca1')::text;
  perform pg_temp.pruefe(v_text not like '%a1-ap4@example.invalid%' and v_text not like '%o1-ap4@example.invalid%', 'M-08.3 Pull mit E-Mails');
  perform pg_temp.pruefe((select count(*) from public.profiles where id <> '00000000-0000-0000-0000-0000000e4c04') = 0, 'M-08.4 fremde Profile lesbar');
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c02');
  r := public.team_list_members('00000000-0000-0000-0000-0000000e4ca1');
  perform pg_temp.pruefe((select count(*) from jsonb_array_elements(r) e where e ? 'email') = jsonb_array_length(r), 'M-08.2 Admin ohne E-Mails');
  perform pg_temp.pruefe(not exists (select 1 from jsonb_array_elements(r) e where e ? 'transfer_eligible'), 'M-08.2 Admin sieht Uebergabeziele');
  r := public.team_list_invitations('00000000-0000-0000-0000-0000000e4ca1');
  perform pg_temp.pruefe(r::text not like '%token%' and r::text not like '%hash%', 'M-08.2 Token/Hash in der Liste');
  perform pg_temp.zurueck();
  raise notice 'OK  M-08.1-M-08.4, N-M3.1 Sichtbarkeit: Mitglieder ohne E-Mails, Tokens und fremde Profile';
end $$;

/* ======================================================================== */
/* M-09 bis M-11, M-18.2 -- Rollenwechsel, Entzug, Verlassen                 */
/* ======================================================================== */
do $$
declare
  r jsonb;
begin
  -- M-09.1: O1 macht M1 zum Admin -> naechster Serveraufruf mit Admin-Rechten
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_change_role('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c04', 'admin', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c04');
  perform public.team_list_invitations('00000000-0000-0000-0000-0000000e4ca1');
  perform pg_temp.zurueck();
  -- M-09.2: Herabstufung wirkt sofort (Einstellungen schreiben nur owner/admin)
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_change_role('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c04', 'member', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c04');
  perform pg_temp.erwarte_abweisung('M-09.2 Schreiben nach Herabstufung', 'select public.team_list_invitations(''00000000-0000-0000-0000-0000000e4ca1'')', 'team_forbidden_role', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where target_user_id = '00000000-0000-0000-0000-0000000e4c04' and action = 'member_role_changed') = 2, 'M-16.1 Rollenwechsel-Eintraege');

  -- M-10.1: entfernt -> RPC und Pull abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_remove_member('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c05', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c05');
  perform pg_temp.erwarte_abweisung('M-10.1 Pull', 'select public.pull_workspace_sync_state(''00000000-0000-0000-0000-0000000e4ca1'')', 'Kein Zugriff');
  perform pg_temp.erwarte_abweisung('M-10.1 RPC', 'select public.team_list_members(''00000000-0000-0000-0000-0000000e4ca1'')', 'team_not_member', '42501');
  -- M-11.2: verbrauchte Einladung nach dem Ausscheiden erneut -> abgewiesen (keine Wiederbelebung)
  r := public.accept_invitation(null, (select v from merk where k = 'x1_token'), gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r = '{"ok": false, "code": "invitation_invalid"}'::jsonb, 'M-11.2 Wiederbelebung ' || r::text);
  perform pg_temp.pruefe((select status from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c05') = 'removed', 'M-11.2 wieder aktiv');

  -- M-11.1: M1 verlaesst W1; M-11.4: O1 kann nicht verlassen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c07');
  r := public.team_leave('00000000-0000-0000-0000-0000000e4ca1', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c07') = 'removed', 'M-11.1 nicht beendet');
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where target_user_id = '00000000-0000-0000-0000-0000000e4c07' and action = 'member_left') = 1, 'M-11.1 Pruefspur');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('M-11.4', 'select public.team_leave(''00000000-0000-0000-0000-0000000e4ca1'', gen_random_uuid())', 'team_owner_protected', '42501');
  perform pg_temp.zurueck();

  -- M-18.2: Mitgliedschaft entzogen, owner_user_id zeigt noch auf das Konto -> Schreiben abgewiesen
  update public.workspace_members set status = 'removed' where workspace_id = '00000000-0000-0000-0000-0000000e4ca3' and user_id = '00000000-0000-0000-0000-0000000e4c16';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c16');
  perform pg_temp.erwarte_abweisung('M-18.2 Team', 'select public.team_rename_workspace(''00000000-0000-0000-0000-0000000e4ca3'', ''X'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-18.2 Sync', 'select public.upsert_workspace_sync_entity(''00000000-0000-0000-0000-0000000e4ca3'', ''workspace_settings'', ''{}''::jsonb, 0)', 'Kein');
  perform pg_temp.zurueck();
  update public.workspace_members set status = 'active' where workspace_id = '00000000-0000-0000-0000-0000000e4ca3' and user_id = '00000000-0000-0000-0000-0000000e4c16';
  raise notice 'OK  M-09.1, M-09.2, M-10.1, M-11.1, M-11.2, M-11.4, M-18.2 Rechte wirken beim naechsten Serveraufruf';
end $$;

/* ======================================================================== */
/* M-12, N-M1.4, N-M2.1/5/7 -- Inhaberuebergabe                              */
/* ======================================================================== */
do $$
declare
  r jsonb;
  v_t1 uuid;
  v_t2 uuid;
  v_admin_inv text;
  v_events int;
begin
  -- N-M1.4 vorbereiten: admin-Einladung von O1, die nach der Uebergabe ungueltig sein muss
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  v_admin_inv := public.team_invite('00000000-0000-0000-0000-0000000e4ca1', 'p1-ap4@example.invalid', 'admin', gen_random_uuid())->>'token';
  -- M-12.5: Ziel A1 ohne Lizenz -> abgewiesen, kein Antrag
  perform pg_temp.erwarte_abweisung('M-12.5', 'select public.team_request_transfer(''00000000-0000-0000-0000-0000000e4ca1'', ''00000000-0000-0000-0000-0000000e4c02'', gen_random_uuid())', 'team_target_invalid', '42501');
  -- M-12.1 + N-M2.1: zwei Antraege -> der erste wird widerrufen
  v_t1 := (public.team_request_transfer('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c03', gen_random_uuid())->>'transfer_id')::uuid;
  r := public.team_request_transfer('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c03', gen_random_uuid());
  v_t2 := (r->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.workspace_ownership_transfers where id = v_t1) = 'revoked', 'N-M2.1 alter Antrag offen');
  perform pg_temp.pruefe((select count(*) from public.workspace_ownership_transfers where workspace_id = '00000000-0000-0000-0000-0000000e4ca1' and status = 'open') = 1, 'N-M2.1 mehr als ein offener');
  perform pg_temp.pruefe((select expires_at = created_at + interval '72 hours' and to_user_id = '00000000-0000-0000-0000-0000000e4c03' from public.workspace_ownership_transfers where id = v_t2), 'M-12.1 Antrag');
  -- M-12.4: widerrufener Antrag -> abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  perform pg_temp.erwarte_abweisung('M-12.4 widerrufen', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t1), 'transfer_not_open', '42501');
  perform pg_temp.zurueck();
  -- M-12.3: anderes Konto -> abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c02');
  perform pg_temp.erwarte_abweisung('M-12.3', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t2), 'team_target_invalid', '42501');
  perform pg_temp.zurueck();
  -- M-12.2: A1-L nimmt an -> atomar, genau ein owner, eine Pruefspur
  v_events := (select count(*) from public.workspace_member_events where transfer_id = v_t2);
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  r := public.team_accept_transfer(v_t2, '00000000-0000-0000-0000-0000000e4d12');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'status' = 'accepted', 'M-12.2 ' || r::text);
  perform pg_temp.pruefe((select owner_user_id from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca1') = '00000000-0000-0000-0000-0000000e4c03', 'M-12.2 owner_user_id');
  perform pg_temp.pruefe((select role from public.workspace_members where workspace_id = '00000000-0000-0000-0000-0000000e4ca1' and user_id = '00000000-0000-0000-0000-0000000e4c03') = 'owner', 'M-12.2 Ziel nicht owner');
  perform pg_temp.pruefe((select role from public.workspace_members where workspace_id = '00000000-0000-0000-0000-0000000e4ca1' and user_id = '00000000-0000-0000-0000-0000000e4c01') = 'admin', 'M-12.2 alter Inhaber nicht admin');
  perform pg_temp.pruefe((select count(*) from public.workspace_members where workspace_id = '00000000-0000-0000-0000-0000000e4ca1' and role = 'owner' and status = 'active') = 1, 'M-12.2 nicht genau ein owner');
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where transfer_id = v_t2) = v_events + 1, 'M-12.2/N-M2.7 Pruefspur');
  -- M-12.8: Lizenz des neuen Inhabers massgeblich
  update public.profiles set license_status = 'expired' where id = '00000000-0000-0000-0000-0000000e4c01';
  perform pg_temp.pruefe(public.workspace_license_state('00000000-0000-0000-0000-0000000e4ca1') = 'effective', 'M-12.8 Lizenzquelle');
  update public.profiles set license_status = 'active' where id = '00000000-0000-0000-0000-0000000e4c01';
  -- M-12.9 / N-M2.5: Wiederholung idempotent (gleiche und andere Anfrage-ID)
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  r := public.team_accept_transfer(v_t2, '00000000-0000-0000-0000-0000000e4d12');
  perform pg_temp.pruefe((r->>'replayed')::boolean, 'M-12.9 Replay ' || r::text);
  r := public.team_accept_transfer(v_t2, gen_random_uuid());
  perform pg_temp.pruefe(r->>'status' = 'accepted' and not (r->>'changed')::boolean, 'N-M2.5 ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where transfer_id = v_t2) = v_events + 1, 'M-12.9 zweite Pruefspur');
  -- N-M2.2 (Folge): Widerruf nach der Annahme. Der fruehere Inhaber (jetzt admin) erfaehrt den Stand statt einer
  -- Rollenmeldung; ein anderes Mitglied wird abgewiesen. Der Antrag bleibt angenommen, keine weitere Pruefspur.
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_revoke_transfer(v_t2, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'status' = 'accepted' and not (r->>'changed')::boolean, 'N-M2.2 Widerruf nach Annahme ' || r::text);
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c02');
  perform pg_temp.erwarte_abweisung('N-M2.2 fremder Widerruf', format('select public.team_revoke_transfer(%L, gen_random_uuid())', v_t2), 'team_forbidden_role', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.workspace_ownership_transfers where id = v_t2) = 'accepted', 'N-M2.2 Antrag nach Widerruf veraendert');
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where transfer_id = v_t2) = v_events + 1, 'N-M2.2 weitere Pruefspur');
  -- N-M1.4: admin-Einladung von O1, der jetzt nur admin ist -> ungueltig
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c09');
  r := public.accept_invitation(null, v_admin_inv, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'code' = 'invitation_invalid', 'N-M1.4 ' || r::text);
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_members where user_id = '00000000-0000-0000-0000-0000000e4c09'), 'N-M1.4 Mitgliedschaft ueber veraltete Einladung');
  perform pg_temp.pruefe((select status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c09') = 'pending', 'N-M1.4 Freigabe ueber veraltete Einladung');
  raise notice 'OK  M-12.1-M-12.5, M-12.8, M-12.9, N-M1.4, N-M2.1, N-M2.2 (Widerruf nach Annahme), N-M2.5, N-M2.7 Uebergabe atomar, idempotent, ohne Zwischenrecht';
end $$;

do $$
declare
  r jsonb;
  v_t uuid;
begin
  -- Ab hier ist AL (e4c03) Inhaber von W1, O1 admin.
  -- M-12.6: Ziellizenz laeuft zwischen Antrag und Annahme ab
  update public.profiles set license_status = 'active' where id = '00000000-0000-0000-0000-0000000e4c0a';
  insert into public.workspace_members (workspace_id, user_id, role, status) values ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c0a', 'member', 'active');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  v_t := (public.team_request_transfer('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c0a', gen_random_uuid())->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  update public.profiles set license_status = 'expired' where id = '00000000-0000-0000-0000-0000000e4c0a';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0a');
  perform pg_temp.erwarte_abweisung('M-12.6', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'team_target_invalid', '42501');
  perform pg_temp.zurueck();
  -- M-12.7: Ziel verliert vor der Annahme die Mitgliedschaft -> Antrag endet, Annahme abgewiesen
  update public.profiles set license_status = 'active' where id = '00000000-0000-0000-0000-0000000e4c0a';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  r := public.team_remove_member('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c0a', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.workspace_ownership_transfers where id = v_t) = 'revoked', 'M-12.7 Antrag offen');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0a');
  perform pg_temp.erwarte_abweisung('M-12.7', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'transfer_not_open', '42501');
  perform pg_temp.zurueck();
  -- M-12.4: abgelaufen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  v_t := (public.team_request_transfer('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c01', gen_random_uuid())->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  update public.workspace_ownership_transfers set created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour' where id = v_t;
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('M-12.4 abgelaufen', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'transfer_expired', '42501');
  perform pg_temp.zurueck();
  -- M-12 Widerruf durch den Inhaber: offener Antrag -> widerrufen, genau ein Eintrag; Wiederholung mit gleicher Anfrage-ID
  -- liefert die gespeicherte Antwort; der Empfaenger kann danach nicht mehr annehmen.
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c03');
  v_t := (public.team_request_transfer('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4c01', gen_random_uuid())->>'transfer_id')::uuid;
  r := public.team_revoke_transfer(v_t, '00000000-0000-0000-0000-0000000e4d31');
  perform pg_temp.pruefe(r->>'status' = 'revoked' and (r->>'changed')::boolean, 'M-12 Widerruf ' || r::text);
  r := public.team_revoke_transfer(v_t, '00000000-0000-0000-0000-0000000e4d31');
  perform pg_temp.pruefe((r->>'replayed')::boolean, 'M-12 Widerruf Replay ' || r::text);
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where transfer_id = v_t and action = 'ownership_transfer_revoked') = 1, 'M-12 Widerruf Pruefspur');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('M-12 nach Widerruf', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'transfer_not_open', '42501');
  perform pg_temp.zurueck();

  -- M-12.10 (E16): L1 (Lizenz abgelaufen, regulaer) uebergibt an A2 -> gelingt, W2 wieder wirksam, ohne Plattform
  perform pg_temp.pruefe(public.workspace_license_state('00000000-0000-0000-0000-0000000e4ca2') = 'expired', 'M-12.10 Ausgang');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0b');
  v_t := (public.team_request_transfer('00000000-0000-0000-0000-0000000e4ca2', '00000000-0000-0000-0000-0000000e4c0c', gen_random_uuid())->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0c');
  r := public.team_accept_transfer(v_t, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'status' = 'accepted' and (select owner_user_id from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca2') = '00000000-0000-0000-0000-0000000e4c0c', 'M-12.10 ' || r::text);
  perform pg_temp.pruefe(public.workspace_license_state('00000000-0000-0000-0000-0000000e4ca2') = 'effective', 'M-12.10 W2 nicht wirksam');
  perform pg_temp.pruefe(not exists (select 1 from public.platform_admin_events where workspace_id = '00000000-0000-0000-0000-0000000e4ca2'), 'M-12.10 Plattform beteiligt');
  raise notice 'OK  M-12.4, M-12.6, M-12.7, M-12.10, Widerruf durch den Inhaber (idempotent) Neupruefung bei der Annahme; normale Uebergabe im Nur-Lesen-Betrieb (E16)';
end $$;

/* ======================================================================== */
/* M-14, M-15, M-16 -- Umbenennen, fremde IDs, Pruefspur                     */
/* ======================================================================== */
do $$
declare
  r jsonb;
  v_vorher int;
begin
  -- M-14.1 / O-03: Umbenennen durch Admin (O1 ist jetzt admin in W1); Firmenname folgt
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  r := public.team_rename_workspace('00000000-0000-0000-0000-0000000e4ca1', 'AP4 Neu GmbH', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'name' = 'AP4 Neu GmbH' and (select name from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca1') = 'AP4 Neu GmbH', 'M-14.1 Name');
  perform pg_temp.pruefe((select payload->>'companyName' from public.workspace_company_profiles where workspace_id = '00000000-0000-0000-0000-0000000e4ca1') = 'AP4 Neu GmbH', 'M-14.1 Firmenname folgt nicht');
  perform pg_temp.pruefe((select row_version from public.workspace_company_profiles where workspace_id = '00000000-0000-0000-0000-0000000e4ca1') = 4, 'M-14.1 Zeilenversion');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  perform pg_temp.erwarte_abweisung('M-14.1 Mitglied', 'select public.team_rename_workspace(''00000000-0000-0000-0000-0000000e4ca1'', ''Nein'', gen_random_uuid())', 'team_forbidden_role', '42501');
  perform pg_temp.zurueck();

  -- M-15.1: O1 mit bekannten IDs aus W2 -> jede neue RPC abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('M-15.1 Einladung', 'select public.team_invite(''00000000-0000-0000-0000-0000000e4ca2'', ''q@example.invalid'', ''member'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Widerruf', 'select public.team_revoke_invitation(''00000000-0000-0000-0000-0000000e4e32'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Neu senden', 'select public.team_resend_invitation(''00000000-0000-0000-0000-0000000e4e32'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Mitglied', 'select public.team_remove_member(''00000000-0000-0000-0000-0000000e4ca2'', ''00000000-0000-0000-0000-0000000e4c0d'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Rolle', 'select public.team_change_role(''00000000-0000-0000-0000-0000000e4ca2'', ''00000000-0000-0000-0000-0000000e4c0d'', ''admin'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Uebergabe', 'select public.team_request_transfer(''00000000-0000-0000-0000-0000000e4ca2'', ''00000000-0000-0000-0000-0000000e4c0d'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Pruefspur', 'select public.team_list_events(''00000000-0000-0000-0000-0000000e4ca2'', 5)', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Umbenennen', 'select public.team_rename_workspace(''00000000-0000-0000-0000-0000000e4ca2'', ''Fremd'', gen_random_uuid())', 'team_not_member', '42501');
  perform pg_temp.erwarte_abweisung('M-15.1 Antrag', 'select public.team_open_transfer(''00000000-0000-0000-0000-0000000e4ca2'')', 'team_not_member', '42501');
  -- M-15.2 / M-16.3 / N-M3.3: direkte Tabellenwege
  perform pg_temp.erwarte_abweisung('M-15.2 Einladungen lesen', 'select count(*) from public.workspace_invitations', 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('M-16.3 Pruefspur aendern', 'update public.workspace_member_events set action = ''workspace_renamed''', 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('M-16.3 Pruefspur lesen direkt', 'select count(*) from public.workspace_member_events', 'permission denied', '42501');
  perform pg_temp.erwarte_abweisung('M-15.2 Mitgliedschaft loeschen', 'delete from public.workspace_members where workspace_id = ''00000000-0000-0000-0000-0000000e4ca2''', 'permission denied', '42501');
  perform pg_temp.zurueck();
  -- auch als Eigentuemer der Tabelle unveraenderlich (Trigger)
  perform pg_temp.erwarte_abweisung('M-16.3 Trigger', 'update public.workspace_member_events set details = ''{}''', 'audit_immutable');

  -- M-16.4: abgewiesene Versuche stehen nicht in der Aenderungsspur
  v_vorher := (select count(*) from public.workspace_member_events);
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  perform pg_temp.erwarte_abweisung('M-16.4', 'select public.team_invite(''00000000-0000-0000-0000-0000000e4ca1'', ''w@example.invalid'', ''member'', gen_random_uuid())', 'team_forbidden_role');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events) = v_vorher, 'M-16.4 Eintrag fuer Abweisung');
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_member_events e where e.details::text ~* '(token|hash|password|passwort)'), 'M-16.4 Geheimnis in der Pruefspur');
  -- M-16.5: O1 (admin) liest, Mitglied nicht
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.pruefe(jsonb_array_length(public.team_list_events('00000000-0000-0000-0000-0000000e4ca1', 500)) > 5, 'M-16.5 Admin liest nicht');
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c17');
  perform pg_temp.erwarte_abweisung('M-16.5 Mitglied', 'select public.team_list_events(''00000000-0000-0000-0000-0000000e4ca1'', 5)', 'team_forbidden_role', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  M-14.1, M-15.1, M-15.2, M-16.3-M-16.5, N-M3.3 Umbenennen mit Firmenname, fremde IDs und direkte Wege abgewiesen, Pruefspur geschuetzt';
end $$;

/* ======================================================================== */
/* P -- Plattform-Verwaltung                                                 */
/* ======================================================================== */
do $$
declare
  r public.profiles;
  v_vorher int;
  v_seen timestamptz;
  v_neu timestamptz;
begin
  -- P-01.2: Nicht-Admin -> Admin-RPCs abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('P-01.2 Liste', 'select public.admin_list_profiles()', 'Keine Admin-Berechtigung');
  perform pg_temp.erwarte_abweisung('P-01.2 Sperre', 'select public.admin_block_user(''00000000-0000-0000-0000-0000000e4c17'')', 'Keine Admin-Berechtigung');
  perform pg_temp.erwarte_abweisung('P-01.2 Reparatur', 'select public.admin_list_ownership_repair_cases()', 'Keine Admin-Berechtigung');
  perform pg_temp.zurueck();
  -- P-01.3 / N-M3.2: PA1 ohne Mitgliedschaft -> kein Zugriff auf W1
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  perform pg_temp.erwarte_abweisung('P-01.3 Pull', 'select public.pull_workspace_sync_state(''00000000-0000-0000-0000-0000000e4ca1'')', 'Kein Zugriff');
  perform pg_temp.erwarte_abweisung('P-01.3 Team', 'select public.team_list_members(''00000000-0000-0000-0000-0000000e4ca1'')', 'team_not_member');
  perform pg_temp.erwarte_abweisung('P-01.3 Finanz', 'select public.set_workspace_invoice_number_format(''00000000-0000-0000-0000-0000000e4ca1'', ''RE'', true, 4, 0)', 'Kein Zugriff');
  perform pg_temp.pruefe((select count(*) from public.workspace_customers where workspace_id = '00000000-0000-0000-0000-0000000e4ca1') = 0, 'P-01.3 Geschaeftsdaten lesbar');
  -- P-02.1 / P-02.3: sich selbst sperren, auch mit anderer Schreibweise der ID
  perform pg_temp.erwarte_abweisung('P-02.1', 'select public.admin_block_user(''00000000-0000-0000-0000-0000000e4c0e'')', 'admin_self_action', '42501');
  perform pg_temp.erwarte_abweisung('P-02.3', 'select public.admin_block_user(''00000000-0000-0000-0000-0000000E4C0E'')', 'admin_self_action', '42501');
  -- P-02.2: eigene Lizenz aendern
  perform pg_temp.erwarte_abweisung('P-02.2 aktivieren', 'select public.admin_activate_license(''00000000-0000-0000-0000-0000000e4c0e'', null)', 'admin_self_action', '42501');
  perform pg_temp.erwarte_abweisung('P-02.2 verlaengern', 'select public.admin_extend_license(''00000000-0000-0000-0000-0000000e4c0e'', null, gen_random_uuid())', 'admin_self_action', '42501');
  perform pg_temp.zurueck();
  -- P-02.4: PA2 aendert die Lizenz von PA1 -> erlaubt, mit Pruefspur (P-07.1)
  v_vorher := (select count(*) from public.platform_admin_events);
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0f');
  r := public.admin_activate_license('00000000-0000-0000-0000-0000000e4c0e', now() + interval '10 days', '00000000-0000-0000-0000-0000000e4d21');
  -- P-07.2: Wiederholung mit derselben Anfrage-ID -> kein zweiter Eintrag
  r := public.admin_activate_license('00000000-0000-0000-0000-0000000e4c0e', now() + interval '10 days', '00000000-0000-0000-0000-0000000e4d21');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.platform_admin_events) = v_vorher + 1, 'P-07.2 zweiter Eintrag');
  perform pg_temp.pruefe((select actor_user_id = '00000000-0000-0000-0000-0000000e4c0f' and target_user_id = '00000000-0000-0000-0000-0000000e4c0e' and action = 'activate_license' and before ? 'license_status' and after->>'license_status' = 'active' and created_at is not null from public.platform_admin_events where request_id = '00000000-0000-0000-0000-0000000e4d21'), 'P-07.1 Eintrag unvollstaendig');

  -- P-03.2: PA1 sperrt PA2 -> erlaubt; PA1 bleibt
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  r := public.admin_block_user('00000000-0000-0000-0000-0000000e4c0f', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r.status = 'blocked', 'P-03.2');
  -- PA2 (gesperrt) kann nichts mehr
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0f');
  perform pg_temp.erwarte_abweisung('P-03.2 gesperrter Admin', 'select public.admin_block_user(''00000000-0000-0000-0000-0000000e4c0e'')', 'Keine Admin-Berechtigung');
  perform pg_temp.zurueck();
  update public.profiles set status = 'approved' where id = '00000000-0000-0000-0000-0000000e4c0f';
  -- P-03.1: die letzte Sicherung (Schutz unabhaengig von der Selbstpruefung): PA2 sperrt PA1, solange PA2 selbst gesperrt markiert ist, scheitert schon an assert_is_admin; direkt geprueft wird die Regel ueber den Helfer
  perform pg_temp.pruefe((select count(*) from public.profiles where role = 'admin' and status is distinct from 'blocked') = 2, 'P-03 Ausgang');

  -- P-05.1 / P-05.2: Freischalten mit Lizenz bis ... (Zukunft); Vergangenheit abgewiesen ohne Teilfreigabe
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  perform pg_temp.erwarte_abweisung('P-05.2', 'select public.admin_approve_with_license(''00000000-0000-0000-0000-0000000e4c09'', now() - interval ''1 day'', gen_random_uuid())', 'admin_expiry_in_past');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status = 'pending' and license_status = 'inactive' from public.profiles where id = '00000000-0000-0000-0000-0000000e4c09'), 'P-05.2 Teilfreigabe');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  r := public.admin_approve_with_license('00000000-0000-0000-0000-0000000e4c09', now() + interval '30 days', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r.status = 'approved' and r.license_status = 'active' and r.license_expires_at = now() + interval '30 days', 'P-05.1');

  -- P-06.1 / P-06.2: verlaengern mit gesehenem Ablauf; Wiederholung ohne zweite Addition; veraltetes T -> Konflikt
  v_seen := (select license_expires_at from public.profiles where id = '00000000-0000-0000-0000-0000000e4c09');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  r := public.admin_extend_license('00000000-0000-0000-0000-0000000e4c09', v_seen, '00000000-0000-0000-0000-0000000e4d22');
  v_neu := r.license_expires_at;
  r := public.admin_extend_license('00000000-0000-0000-0000-0000000e4c09', v_seen, '00000000-0000-0000-0000-0000000e4d22');
  perform pg_temp.pruefe(r.license_expires_at = v_neu, 'P-06.2 doppelt addiert');
  perform pg_temp.erwarte_abweisung('P-06.3 Konflikt', format('select public.admin_extend_license(''00000000-0000-0000-0000-0000000e4c09'', %L, gen_random_uuid())', v_seen), 'admin_license_conflict', '40001');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(v_neu = greatest(now(), v_seen) + interval '30 days', 'P-06.1 Ablauf falsch');

  -- P-07.3: Plattform-Pruefspur nicht aenderbar; P-07.4 ohne Geheimnisse
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  perform pg_temp.erwarte_abweisung('P-07.3', 'update public.platform_admin_events set action = ''x''', 'permission denied', '42501');
  perform pg_temp.pruefe(jsonb_array_length(public.admin_list_events(50)) > 0, 'P-07 Liste leer');
  perform pg_temp.zurueck();
  perform pg_temp.erwarte_abweisung('P-07.3 Trigger', 'delete from public.platform_admin_events', 'audit_immutable');
  perform pg_temp.pruefe(not exists (select 1 from public.platform_admin_events e where (coalesce(e.before, '{}') || coalesce(e.after, '{}'))::text ~* '(token|hash|password|passwort)'), 'P-07.4 Geheimnis');

  -- N-P1.2: abgewiesene Plattformaktion -> keine Teilaenderung, kein Eintrag
  v_vorher := (select count(*) from public.platform_admin_events);
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  perform pg_temp.erwarte_abweisung('N-P1.2', 'select public.admin_extend_license(''00000000-0000-0000-0000-0000000e4c09'', ''2000-01-01''::timestamptz, gen_random_uuid())', 'admin_license_conflict');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select count(*) from public.platform_admin_events) = v_vorher, 'N-P1.2 Eintrag');
  raise notice 'OK  P-01.2, P-01.3, P-02.1-P-02.4, P-03.2, P-05.1, P-05.2, P-06.1, P-06.2, P-07.1-P-07.4, N-M3.2, N-P1.2 Plattform-Verwaltung';
end $$;

/* P-03.1 -- nur PA1 ist ein nicht gesperrter Admin: seine Sperre ist nicht moeglich (gegenseitig: Barrieretreiber P-03.3) */
do $$
begin
  update public.profiles set status = 'blocked' where id = '00000000-0000-0000-0000-0000000e4c0f';
  perform pg_temp.pruefe((select count(*) from public.profiles where role = 'admin' and status is distinct from 'blocked') = 1, 'P-03.1 Ausgang');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  perform pg_temp.erwarte_abweisung('P-03.1', 'select public.admin_block_user(''00000000-0000-0000-0000-0000000e4c0e'', gen_random_uuid())', 'admin_self_action', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0f');
  perform pg_temp.erwarte_abweisung('P-03.1 gesperrter Admin', 'select public.admin_block_user(''00000000-0000-0000-0000-0000000e4c0e'', gen_random_uuid())', 'Keine Admin-Berechtigung');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((select status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c0e') = 'approved', 'P-03.1 letzter Admin gesperrt');
  update public.profiles set status = 'approved' where id = '00000000-0000-0000-0000-0000000e4c0f';
  raise notice 'OK  P-03.1 der einzige nicht gesperrte Admin bleibt';
end $$;

/* ======================================================================== */
/* P-09 -- Reparatur ohne handlungsfaehigen Inhaber (E15, 1.6a)              */
/* ======================================================================== */
do $$
declare
  r jsonb;
  v_t uuid;
  v_team int;
  v_plattform int;
  v_faelle jsonb;
begin
  -- Faelle: W6 (O6 gesperrt) und W8 (O8 wartend); W2 (jetzt A2 regulaer) nicht
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  v_faelle := public.admin_list_ownership_repair_cases();
  perform pg_temp.pruefe(exists (select 1 from jsonb_array_elements(v_faelle) f where f->>'workspace_id' = '00000000-0000-0000-0000-0000000e4ca6' and f->>'owner_state' = 'blocked' and jsonb_array_length(f->'candidates') = 1), 'P-09 Fall W6');
  perform pg_temp.pruefe(not exists (select 1 from jsonb_array_elements(v_faelle) f where f->>'workspace_id' in ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4ca2')), 'P-09 regulaere Betriebe gelistet');
  perform pg_temp.pruefe(v_faelle::text not like '%payload%', 'P-01.4 Geschaeftsdaten');
  -- P-09.2: Ziel ohne Lizenz bzw. ohne Mitgliedschaft -> abgewiesen, kein Antrag
  perform pg_temp.erwarte_abweisung('P-09.2 ohne Mitgliedschaft', 'select public.platform_request_ownership_repair(''00000000-0000-0000-0000-0000000e4ca6'', ''00000000-0000-0000-0000-0000000e4c03'', gen_random_uuid())', 'team_target_invalid', '42501');
  -- P-09.6: W2 mit regulaerem Inhaber (Lizenz egal) -> abgewiesen
  perform pg_temp.erwarte_abweisung('P-09.6', 'select public.platform_request_ownership_repair(''00000000-0000-0000-0000-0000000e4ca2'', ''00000000-0000-0000-0000-0000000e4c0d'', gen_random_uuid())', 'repair_not_applicable', '42501');
  -- P-09.1a: Antrag auf A6
  v_t := (public.platform_request_ownership_repair('00000000-0000-0000-0000-0000000e4ca6', '00000000-0000-0000-0000-0000000e4c11', gen_random_uuid())->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_ownership_transfers where workspace_id = '00000000-0000-0000-0000-0000000e4ca2' and kind = 'platform_repair'), 'P-09.2/P-09.6 Antrag entstanden');
  -- P-09.4: ein anderes Konto bzw. PA1 stellvertretend -> abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  perform pg_temp.erwarte_abweisung('P-09.4 PA1', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'team_target_invalid', '42501');
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c01');
  perform pg_temp.erwarte_abweisung('P-09.4 anderes Konto', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'team_target_invalid', '42501');
  perform pg_temp.zurueck();
  -- P-09.7: O6 wird vor der Annahme entsperrt -> abgewiesen
  update public.profiles set status = 'approved' where id = '00000000-0000-0000-0000-0000000e4c10';
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c11');
  perform pg_temp.erwarte_abweisung('P-09.7', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'transfer_not_open', '42501');
  perform pg_temp.zurueck();
  update public.profiles set status = 'blocked' where id = '00000000-0000-0000-0000-0000000e4c10';
  -- P-09.5: PA1 wird vor der Annahme gesperrt (durch PA2) -> abgewiesen
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0f');
  perform public.admin_block_user('00000000-0000-0000-0000-0000000e4c0e', gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c11');
  perform pg_temp.erwarte_abweisung('P-09.5', format('select public.team_accept_transfer(%L, gen_random_uuid())', v_t), 'Plattformrecht', '42501');
  perform pg_temp.zurueck();
  update public.profiles set status = 'approved' where id = '00000000-0000-0000-0000-0000000e4c0e';
  -- P-09.1a: A6 nimmt an -> atomar; Team- und Plattformspur je einmal; O6 bleibt gesperrt; PA1 ohne Rechte in W6
  v_team := (select count(*) from public.workspace_member_events where workspace_id = '00000000-0000-0000-0000-0000000e4ca6');
  v_plattform := (select count(*) from public.platform_admin_events where workspace_id = '00000000-0000-0000-0000-0000000e4ca6');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c11');
  r := public.team_accept_transfer(v_t, '00000000-0000-0000-0000-0000000e4d31');
  -- P-09.8: Wiederholung mit gleicher Anfrage-ID -> idempotent
  r := public.team_accept_transfer(v_t, '00000000-0000-0000-0000-0000000e4d31');
  perform pg_temp.zurueck();
  perform pg_temp.pruefe((r->>'replayed')::boolean, 'P-09.8 ' || r::text);
  perform pg_temp.pruefe((select owner_user_id from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca6') = '00000000-0000-0000-0000-0000000e4c11', 'P-09.1a Inhaber');
  perform pg_temp.pruefe((select role from public.workspace_members where workspace_id = '00000000-0000-0000-0000-0000000e4ca6' and user_id = '00000000-0000-0000-0000-0000000e4c10') = 'admin', 'P-09.1a O6 nicht admin');
  perform pg_temp.pruefe((select count(*) from public.workspace_member_events where workspace_id = '00000000-0000-0000-0000-0000000e4ca6') = v_team + 1, 'P-09.1a Teamspur');
  perform pg_temp.pruefe((select count(*) from public.platform_admin_events where workspace_id = '00000000-0000-0000-0000-0000000e4ca6') = v_plattform + 1, 'P-09.1a Plattformspur');
  perform pg_temp.pruefe((select status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c10') = 'blocked', 'P-09.1a O6 entsperrt');
  perform pg_temp.pruefe(public.workspace_license_state('00000000-0000-0000-0000-0000000e4ca6') = 'effective', 'P-09.1a W6 nicht wirksam');
  perform pg_temp.pruefe(not exists (select 1 from public.workspace_members where workspace_id = '00000000-0000-0000-0000-0000000e4ca6' and user_id = '00000000-0000-0000-0000-0000000e4c0e'), 'P-09.1a PA1 Mitglied');
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c10');
  perform pg_temp.erwarte_abweisung('P-09.1a O6 ohne Leserechte', 'select public.team_list_members(''00000000-0000-0000-0000-0000000e4ca6'')', 'account_blocked', '42501');
  perform pg_temp.zurueck();
  raise notice 'OK  P-09.1a, P-09.2, P-09.4-P-09.8, P-01.4 Reparatur bei gesperrtem Inhaber: Zustimmung nur durch das Ziel, Neupruefung, idempotent';
end $$;

do $$
declare
  r jsonb;
  v_t uuid;
begin
  -- P-09.3: Ablehnen durch das Ziel (W8, O8 wartend)
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  v_t := (public.platform_request_ownership_repair('00000000-0000-0000-0000-0000000e4ca8', '00000000-0000-0000-0000-0000000e4c13', gen_random_uuid())->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c13');
  r := public.team_decline_transfer(v_t, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'status' = 'declined' and (select owner_user_id from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca8') = '00000000-0000-0000-0000-0000000e4c12', 'P-09.3 ' || r::text);
  -- P-09.1b: neuer Antrag, A8 nimmt an; O8 bleibt pending
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
  v_t := (public.platform_request_ownership_repair('00000000-0000-0000-0000-0000000e4ca8', '00000000-0000-0000-0000-0000000e4c13', gen_random_uuid())->>'transfer_id')::uuid;
  perform pg_temp.zurueck();
  perform pg_temp.als('00000000-0000-0000-0000-0000000e4c13');
  r := public.team_accept_transfer(v_t, gen_random_uuid());
  perform pg_temp.zurueck();
  perform pg_temp.pruefe(r->>'status' = 'accepted' and (select owner_user_id from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca8') = '00000000-0000-0000-0000-0000000e4c13', 'P-09.1b ' || r::text);
  perform pg_temp.pruefe((select status from public.profiles where id = '00000000-0000-0000-0000-0000000e4c12') = 'pending', 'P-09.1b O8 freigegeben');
  raise notice 'OK  P-09.1b, P-09.3 Reparatur bei nicht freigegebenem Inhaber; Ablehnen ohne Aenderung';
end $$;

/* P-09.1c -- Inhaberprofil fehlt (W7), in eigener, zurueckgerollter Teiltransaktion */
do $$
declare
  r jsonb;
  v_t uuid;
begin
  begin
    delete from public.profiles where id = '00000000-0000-0000-0000-0000000e4c14';
    perform pg_temp.als('00000000-0000-0000-0000-0000000e4c0e');
    v_t := (public.platform_request_ownership_repair('00000000-0000-0000-0000-0000000e4ca7', '00000000-0000-0000-0000-0000000e4c15', gen_random_uuid())->>'transfer_id')::uuid;
    perform pg_temp.zurueck();
    -- Claim-Wechsel PA1 -> A7
    perform pg_temp.als('00000000-0000-0000-0000-0000000e4c15');
    r := public.team_accept_transfer(v_t, gen_random_uuid());
    perform pg_temp.zurueck();
    perform pg_temp.pruefe(r->>'status' = 'accepted' and (select owner_user_id from public.workspaces where id = '00000000-0000-0000-0000-0000000e4ca7') = '00000000-0000-0000-0000-0000000e4c15', 'P-09.1c ' || r::text);
    perform pg_temp.pruefe(not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000e4c14'), 'P-09.1c Profil angelegt');
    raise exception 'ZURUECK';
  exception when others then
    if sqlerrm <> 'ZURUECK' then
      raise;
    end if;
  end;
  raise notice 'OK  P-09.1c Reparatur bei fehlendem Inhaberprofil (zurueckgerollt), kein Profil angelegt';
end $$;

/* Rechte der neuen Funktionen und Tabellen (R): nur authenticated fuehrt RPCs aus; Helfer und Tabellen ohne Client */
do $$
declare
  f record;
  v_fehler text := '';
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'team\_%' or p.proname in ('accept_invitation', 'decline_invitation', 'list_my_invitations', 'invitation_preview',
        'select_active_workspace', 'list_my_transfers', 'admin_approve_with_license', 'admin_extend_license', 'admin_list_events',
        'admin_list_ownership_repair_cases', 'platform_request_ownership_repair', 'platform_revoke_ownership_repair'))
  loop
    if has_function_privilege('anon', f.sig, 'execute') then v_fehler := v_fehler || ' anon:' || f.proname; end if;
    if not has_function_privilege('authenticated', f.sig, 'execute') then v_fehler := v_fehler || ' fehlt:' || f.proname; end if;
  end loop;
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'einrichtung01\_%'
      and p.proname in ('einrichtung01_team_actor', 'einrichtung01_request_begin', 'einrichtung01_request_finish', 'einrichtung01_team_event',
        'einrichtung01_platform_event', 'einrichtung01_invitation_failure', 'einrichtung01_invitation_find', 'einrichtung01_admin_target',
        'einrichtung01_new_invitation_token', 'einrichtung01_revoke_transfers_to')
  loop
    if has_function_privilege('authenticated', f.sig, 'execute') or has_function_privilege('anon', f.sig, 'execute') then
      v_fehler := v_fehler || ' Helfer:' || f.proname;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.workspace_invitations', 'select')
     or has_table_privilege('authenticated', 'public.workspace_member_events', 'select')
     or has_table_privilege('authenticated', 'public.workspace_ownership_transfers', 'select')
     or has_table_privilege('authenticated', 'public.platform_admin_events', 'select')
     or has_table_privilege('authenticated', 'public.einrichtung_request_log', 'select')
     or has_table_privilege('authenticated', 'public.workspace_members', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_members', 'update')
     or has_table_privilege('authenticated', 'public.workspace_members', 'delete') then
    v_fehler := v_fehler || ' Tabellenrechte';
  end if;
  if v_fehler <> '' then
    raise exception 'R Rechte:%', v_fehler;
  end if;
  raise notice 'OK  R Rechte: RPCs nur fuer authenticated, Helfer und Tabellen ohne Clientrecht';
end $$;

rollback;
