-- E-MAIL-07B — Laufzeittest Versandkern (Claim, haengender Claim, unklarer
-- Neuversuch, Missbrauchsschutz, Briefversand, Absenderkontext).
--
-- Setzt die Migration 20261010120000 voraus. Isolierte Pruefung, ohne den
-- lokalen Stand zu veraendern (Migration + Test in EINER Transaktion, am Ende
-- Rollback):
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261010120000_workspace_document_delivery_send_hardening.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/document_delivery_send_hardening_07b.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'versand-07b@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000007b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'kollege-07b@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000c07b1', 'Versand-07B', '00000000-0000-0000-0000-0000000007b1');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000c07b1', '00000000-0000-0000-0000-0000000007b1', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000c07b1', '00000000-0000-0000-0000-0000000007b2', 'admin', 'active');

insert into public.workspace_company_profiles (workspace_id, payload)
values ('00000000-0000-0000-0000-0000000c07b1', jsonb_build_object(
  'companyName', 'Muster Bau', 'legalForm', 'GmbH', 'email', 'info@muster-bau.example',
  'senderDisplayName', 'Muster Bau Buero', 'replyToEmail', 'buero@muster-bau.example'))
on conflict (workspace_id) do update set payload = excluded.payload;

-- Ein selbst verfasster Geschaeftsbrief im Archiv: klassifiziert als
-- Schriftverkehr, erkannt am linkedLetterId — mit gebundener PDF-Datei.
insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
values ('00000000-0000-0000-0000-0000000c07b1', 'doc-brief-07b', 'archived_document',
        jsonb_build_object('title', 'Brief an Kunde', 'classifiedKind', 'schriftverkehr', 'linkedLetterId', 'letter-07b'));
insert into public.workspace_files (workspace_id, client_file_ref_id, content_sha256, size_bytes, mime_type, storage_path)
values ('00000000-0000-0000-0000-0000000c07b1', 'file-brief-07b', repeat('a', 64), 1234, 'application/pdf',
        '00000000-0000-0000-0000-0000000c07b1/' || repeat('a', 64));
insert into public.workspace_document_file_bindings (workspace_id, client_document_id, client_file_ref_id, binding_kind)
values ('00000000-0000-0000-0000-0000000c07b1', 'doc-brief-07b', 'file-brief-07b', 'original');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}', true);

/* ------------------------------------------------------------------ */

create function pg_temp.lege_an(
  p_client_id text,
  p_kind text default 'letter',
  p_retry_of uuid default null,
  p_confirm boolean default false
) returns public.workspace_document_deliveries language plpgsql as $p$
declare
  v jsonb;
  r public.workspace_document_deliveries;
begin
  v := public.create_workspace_document_delivery(
    '00000000-0000-0000-0000-0000000c07b1', p_client_id, p_kind, null,
    'kunde@example.invalid', 'Brief', 'Guten Tag',
    '00000000-0000-0000-0000-0000000c07b1/letter-doc-brief-07b/' || repeat('a', 64) || '.pdf',
    repeat('a', 64), 1234, 'Brief an Kunde.pdf', 'application/pdf', 'stub',
    p_retry_of, 'doc-brief-07b', p_confirm);
  select * into r from public.workspace_document_deliveries where id = (v->'delivery'->>'id')::uuid;
  return r;
end;
$p$;

create function pg_temp.nein(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
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
/* K — eigener Geschaeftsbrief ist Versandart letter                  */
/* ================================================================== */

do $$
declare r public.workspace_document_deliveries;
begin
  r := pg_temp.lege_an('cd-07b-k1');
  if r.document_kind <> 'letter' or r.status <> 'queued' then
    raise exception 'K1 -- Brief nicht als letter/queued angelegt: % %', r.document_kind, r.status;
  end if;
  raise notice 'OK         K1 eigener Brief (schriftverkehr + linkedLetterId) -> letter';
end;
$$;

select pg_temp.nein('K2 eigener Brief als other',
  $q$select pg_temp.lege_an('cd-07b-k2', 'other')$q$, 'Dokumentart passt nicht zum Dokument');

/* ================================================================== */
/* B/C/D — atomarer Claim                                             */
/* ================================================================== */

do $$
declare
  r public.workspace_document_deliveries;
  v jsonb;
  w jsonb;
begin
  r := pg_temp.lege_an('cd-07b-b1');

  -- B1 normaler Claim
  v := public.claim_workspace_document_delivery_for_send(r.id, r.row_version);
  if not (v->>'claimed')::boolean then raise exception 'B1 -- Claim nicht erhalten'; end if;
  if v->'delivery'->>'status' <> 'sending' or v->'delivery'->>'sending_started_at' is null then
    raise exception 'B1 -- kein sending mit Zeitpunkt';
  end if;
  if (v->'delivery'->>'row_version')::bigint <> r.row_version + 1 then raise exception 'B1 -- row_version nicht erhoeht'; end if;
  raise notice 'OK         B1 queued -> sending (atomar, Version +1)';

  -- C1 zweiter Aufruf mit derselben (alten) Version: kein Claim
  w := public.claim_workspace_document_delivery_for_send(r.id, r.row_version);
  if (w->>'claimed')::boolean then raise exception 'C1 -- zweiter Claim erteilt'; end if;
  if w->'delivery'->>'status' <> 'sending' then raise exception 'C1 -- Zustand veraendert'; end if;
  raise notice 'OK         C1 zweiter Claim (alte Version) -> claimed=false';

  -- C2 zweiter Aufruf mit der aktuellen Version: trotzdem kein Claim (Status ist nicht queued)
  w := public.claim_workspace_document_delivery_for_send(r.id, (v->'delivery'->>'row_version')::bigint);
  if (w->>'claimed')::boolean then raise exception 'C2 -- Claim aus sending erteilt'; end if;
  raise notice 'OK         C2 Claim aus sending -> claimed=false';

  -- D1 Annahme aus sending
  perform public.mark_workspace_document_delivery_accepted(r.id, 'msg-07b-1', (v->'delivery'->>'row_version')::bigint);
  select * into r from public.workspace_document_deliveries where id = r.id;
  if r.status <> 'provider_accepted' or r.provider_message_id <> 'msg-07b-1' then
    raise exception 'D1 -- Annahme aus sending fehlgeschlagen';
  end if;
  raise notice 'OK         D1 sending -> provider_accepted';

  -- E1 Replay nach provider_accepted: kein Claim
  w := public.claim_workspace_document_delivery_for_send(r.id, r.row_version);
  if (w->>'claimed')::boolean then raise exception 'E1 -- Claim nach provider_accepted'; end if;
  raise notice 'OK         E1 Replay nach provider_accepted -> claimed=false';
end;
$$;

-- F1 falsche Version auf einer queued-Delivery: kein Claim, Zustand unveraendert.
do $$
declare
  r public.workspace_document_deliveries;
  v jsonb;
begin
  r := pg_temp.lege_an('cd-07b-f1');
  v := public.claim_workspace_document_delivery_for_send(r.id, r.row_version + 5);
  if (v->>'claimed')::boolean then raise exception 'F1 -- Claim trotz falscher Version'; end if;
  select * into r from public.workspace_document_deliveries where id = r.id;
  if r.status <> 'queued' then raise exception 'F1 -- Zustand veraendert'; end if;
  raise notice 'OK         F1 falsche row_version -> claimed=false, bleibt queued';
end;
$$;

/* ================================================================== */
/* S — haengender Claim wird unknown, nie erneut gesendet             */
/* ================================================================== */

do $$
declare
  r public.workspace_document_deliveries;
  v jsonb;
begin
  r := pg_temp.lege_an('cd-07b-s1');
  v := public.claim_workspace_document_delivery_for_send(r.id, r.row_version);

  -- S1 frischer Claim ist nicht haengend
  v := public.resolve_stale_workspace_document_delivery_claim(r.id, 600);
  if (v->>'resolved')::boolean then raise exception 'S1 -- frischer Claim als haengend gewertet'; end if;
  raise notice 'OK         S1 frischer Claim bleibt sending';

  -- S2 Untergrenze: auch mit 1 s Frist gilt ein 60 s alter Claim nicht als haengend
  update public.workspace_document_deliveries set sending_started_at = now() - interval '60 seconds' where id = r.id;
  v := public.resolve_stale_workspace_document_delivery_claim(r.id, 1);
  if (v->>'resolved')::boolean then raise exception 'S2 -- Untergrenze nicht eingehalten'; end if;
  raise notice 'OK         S2 Untergrenze 120 s schuetzt laufende Aufrufe';

  -- S3 alter Claim -> unknown (send_interrupted), kein Neuversand
  update public.workspace_document_deliveries set sending_started_at = now() - interval '20 minutes' where id = r.id;
  v := public.resolve_stale_workspace_document_delivery_claim(r.id, 600);
  if not (v->>'resolved')::boolean then raise exception 'S3 -- haengender Claim nicht aufgeloest'; end if;
  select * into r from public.workspace_document_deliveries where id = r.id;
  if r.status <> 'unknown' or r.error_code <> 'send_interrupted' then
    raise exception 'S3 -- erwartet unknown/send_interrupted, war %/%', r.status, r.error_code;
  end if;
  v := public.claim_workspace_document_delivery_for_send(r.id, r.row_version);
  if (v->>'claimed')::boolean then raise exception 'S3 -- unknown liess sich erneut claimen'; end if;
  raise notice 'OK         S3 haengender Claim -> unknown, kein erneuter Claim';
end;
$$;

/* ================================================================== */
/* U — unklarer Versuch: nur bestaetigter Neuversuch                  */
/* ================================================================== */

do $$
declare
  u public.workspace_document_deliveries;
  u_after public.workspace_document_deliveries;
  n1 public.workspace_document_deliveries;
  n2 public.workspace_document_deliveries;
begin
  select * into u from public.workspace_document_deliveries where client_delivery_id = 'cd-07b-s1';

  -- U1 ohne Bestaetigung weiterhin gesperrt
  perform pg_temp.nein('U1 Neuversuch unknown ohne Bestaetigung',
    format($q$select pg_temp.lege_an('cd-07b-u1', 'letter', %L::uuid, false)$q$, u.id),
    'Versandstatus unklar');

  -- U2 mit Bestaetigung: neue Zeile, Versuch 2, Bezug auf die unklare Zeile
  n1 := pg_temp.lege_an('cd-07b-u2', 'letter', u.id, true);
  if n1.retry_of_delivery_id <> u.id or n1.attempt_number <> u.attempt_number + 1 or n1.status <> 'queued' then
    raise exception 'U2 -- Neuversuch falsch angelegt';
  end if;
  select * into u_after from public.workspace_document_deliveries where id = u.id;
  if u_after.status <> 'unknown' or u_after.row_version <> u.row_version then
    raise exception 'U2 -- unklare Zeile wurde veraendert';
  end if;
  raise notice 'OK         U2 bestaetigter Neuversuch: attempt %, unklare Zeile unveraendert', n1.attempt_number;

  -- U3 zweiter bestaetigter Neuversuch, solange der erste laeuft: abgelehnt
  perform pg_temp.nein('U3 zweiter Neuversuch zu derselben unklaren Zeile',
    format($q$select pg_temp.lege_an('cd-07b-u3', 'letter', %L::uuid, true)$q$, u.id),
    'bereits angelegt');

  -- U4 ist der erste Neuversuch gescheitert, ist ein weiterer erlaubt
  perform public.update_workspace_document_delivery_status(n1.id, 'failed', null, 'provider', 'x', 'Fehler', n1.row_version);
  n2 := pg_temp.lege_an('cd-07b-u4', 'letter', u.id, true);
  if n2.status <> 'queued' then raise exception 'U4 -- Neuversuch nach Fehlschlag nicht angelegt'; end if;
  raise notice 'OK         U4 nach gescheitertem Neuversuch erneut moeglich';
end;
$$;

/* ================================================================== */
/* R — Missbrauchsschutz                                              */
/* ================================================================== */

do $$
declare i integer;
begin
  -- Den Nutzer an seine Grenze bringen (direkt eingefuegte Auftraege im Fenster).
  for i in 1..20 loop
    insert into public.workspace_document_deliveries (
      workspace_id, client_delivery_id, document_kind, linked_document_id, recipient_email, subject, body_text,
      provider, status, requested_by, requested_at, failed_at, error_category)
    values ('00000000-0000-0000-0000-0000000c07b1', 'cd-07b-rate-' || i, 'letter', 'doc-brief-07b',
            'kunde@example.invalid', 'x', 'x', 'stub', 'failed', '00000000-0000-0000-0000-0000000007b1', now(),
            now(), 'unknown');
  end loop;
end;
$$;

select pg_temp.nein('R1 Nutzergrenze', $q$select pg_temp.lege_an('cd-07b-r1')$q$, 'Versandlimit erreicht');

-- R2 Replay einer bestehenden Absicht zaehlt nicht und bleibt moeglich.
do $$
declare r public.workspace_document_deliveries;
begin
  r := pg_temp.lege_an('cd-07b-k1');
  if r.client_delivery_id <> 'cd-07b-k1' then raise exception 'R2 -- Replay nicht moeglich'; end if;
  raise notice 'OK         R2 Replay trotz Grenze moeglich (zaehlt nicht)';
end;
$$;

-- R3 Das Fenster gleitet: aeltere Auftraege zaehlen nicht mehr.
update public.workspace_document_deliveries
set requested_at = now() - interval '11 minutes'
where client_delivery_id like 'cd-07b-rate-%';
do $$
declare r public.workspace_document_deliveries;
begin
  r := pg_temp.lege_an('cd-07b-r3');
  if r.status <> 'queued' then raise exception 'R3 -- nach Ablauf des Fensters kein Versand moeglich'; end if;
  raise notice 'OK         R3 gleitendes Fenster, keine Dauersperre';
end;
$$;

-- R4 Workspace-Grenze greift auch fuer einen Kollegen.
insert into public.workspace_document_deliveries (
  workspace_id, client_delivery_id, document_kind, linked_document_id, recipient_email, subject, body_text,
  provider, status, requested_by, requested_at, failed_at, error_category)
select '00000000-0000-0000-0000-0000000c07b1', 'cd-07b-ws-' || i, 'letter', 'doc-brief-07b',
       'kunde@example.invalid', 'x', 'x', 'stub', 'failed', '00000000-0000-0000-0000-0000000007b1', now(), now(), 'unknown'
from generate_series(1, 60) as i;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007b2","role":"authenticated"}', true);
select pg_temp.nein('R4 Workspace-Grenze', $q$select pg_temp.lege_an('cd-07b-r4')$q$, 'Versandlimit erreicht');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007b1","role":"authenticated"}', true);

/* ================================================================== */
/* G/H — Absenderkontext fuer die Edge Function                       */
/* ================================================================== */

do $$
declare v jsonb;
begin
  v := public.get_workspace_document_delivery_for_send('00000000-0000-0000-0000-0000000c07b1', 'cd-07b-k1');
  if v->'company'->>'senderDisplayName' <> 'Muster Bau Buero' then raise exception 'G1 -- Anzeigename fehlt'; end if;
  if v->'company'->>'replyToEmail' <> 'buero@muster-bau.example' then raise exception 'H1 -- Reply-To fehlt'; end if;
  if v->'company'->>'companyName' <> 'Muster Bau' or v->'company'->>'email' <> 'info@muster-bau.example' then
    raise exception 'G1 -- Firmenname/E-Mail fehlen';
  end if;
  if v->'document'->>'attachment_bound' <> 'true' then raise exception 'G1 -- Anhang nicht gebunden'; end if;
  raise notice 'OK         G1/H1 for_send liefert Anzeigename und Reply-To';
end;
$$;

/* ================================================================== */
/* P — Rechte und Uebergaenge                                         */
/* ================================================================== */

do $$
begin
  if has_function_privilege('authenticated', 'public.claim_workspace_document_delivery_for_send(uuid, bigint)', 'execute') then
    raise exception 'P1 -- authenticated darf claimen';
  end if;
  if has_function_privilege('authenticated', 'public.resolve_stale_workspace_document_delivery_claim(uuid, integer)', 'execute') then
    raise exception 'P1 -- authenticated darf haengende Claims aufloesen';
  end if;
  if has_function_privilege('authenticated', 'public.get_workspace_document_delivery_for_send(uuid, text)', 'execute') then
    raise exception 'P1 -- authenticated darf for_send lesen';
  end if;
  if not has_function_privilege('service_role', 'public.claim_workspace_document_delivery_for_send(uuid, bigint)', 'execute') then
    raise exception 'P1 -- service_role darf nicht claimen';
  end if;
  raise notice 'OK         P1 Claim/Recovery/for_send nur service_role';

  if public.document_delivery_transition_allowed('sending', 'queued') then raise exception 'P2 -- sending -> queued erlaubt'; end if;
  if public.document_delivery_transition_allowed('unknown', 'sending') then raise exception 'P2 -- unknown -> sending erlaubt'; end if;
  if public.document_delivery_transition_allowed('provider_accepted', 'sending') then raise exception 'P2 -- accepted -> sending erlaubt'; end if;
  if not public.document_delivery_transition_allowed('sending', 'unknown') then raise exception 'P2 -- sending -> unknown verboten'; end if;
  if not public.document_delivery_transition_allowed('sending', 'failed') then raise exception 'P2 -- sending -> failed verboten'; end if;
  raise notice 'OK         P2 Statusuebergaenge';
end;
$$;

-- P3 Konsistenz: sending ohne Zeitpunkt ist unmoeglich.
select pg_temp.nein('P3 sending ohne sending_started_at',
  $q$update public.workspace_document_deliveries set status = 'sending', sending_started_at = null where client_delivery_id = 'cd-07b-f1'$q$,
  'workspace_document_deliveries_sending_fields_check');

-- P4 ein Fremder (nicht Mitglied) kann keinen Auftrag anlegen.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000007bf', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-07b@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000007bf","role":"authenticated"}', true);
select pg_temp.nein('P4 fremder Nutzer', $q$select pg_temp.lege_an('cd-07b-p4')$q$, 'Kein Zugriff auf Workspace');

rollback;
