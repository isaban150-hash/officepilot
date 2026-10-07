-- CLOUD-SYNC S2 -- Laufzeittest des Kommunikationsverlaufs als Sync-Entitaet.
--
-- Geprueft wird der echte Weg: `upsert_workspace_sync_entity` und
-- `pull_workspace_sync_state`, angemeldet als echte Rollen.
--
--   A  Anlage und Wiederholung derselben Kennung: genau eine Zeile, unveraendert
--   B  Strukturpruefung; Loeschen wird abgewiesen
--   C  Abzug nach Ereigniszeit geordnet, Gleichstand nach Kennung
--   D  Isolation: fremder Betrieb liest und schreibt nichts
--   E  Rollen: Mitglied nur eigene Ereignisse, kein Replay fremder Zeilen
--   F  RLS bei direktem Lesen und Schreiben
--   G  Der Dispatcher ist sonst unveraendert (auch S1)
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/communication_events_s2.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000c5201'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-s2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000c5202'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-s2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000c5203'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-s2@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000c201'::uuid, 'S2 Betrieb', '00000000-0000-0000-0000-0000000c5201'::uuid),
       ('00000000-0000-0000-0000-00000000c202'::uuid, 'S2 Fremd',   '00000000-0000-0000-0000-0000000c5203'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000c201'::uuid, '00000000-0000-0000-0000-0000000c5201'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000c201'::uuid, '00000000-0000-0000-0000-0000000c5202'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000000c202'::uuid, '00000000-0000-0000-0000-0000000c5203'::uuid, 'owner',  'active');

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
$p$;

create function pg_temp.abmelden() returns void language sql as $p$
  select set_config('request.jwt.claims', '{"role":"anon"}', true)::void;
$p$;

/** Der Push, wie ihn der Client baut. */
create function pg_temp.ereignis(p_id text, p_zeit text, p_typ text default 'marked_answered',
                                 p_kontext text default 'document', p_kontext_id text default 'doc-1',
                                 p_text text default 'Als erledigt markiert') returns jsonb language sql as $p$
  select jsonb_build_object(
    'event_id', p_id,
    'context_type', p_kontext,
    'context_id', p_kontext_id,
    'event_type', p_typ,
    'event_at', p_zeit,
    'payload', jsonb_build_object(
      'id', p_id, 'timestamp', p_zeit, 'type', p_typ,
      'contextRef', jsonb_build_object('type', p_kontext, 'id', p_kontext_id),
      'status', 'complete', 'resultExcerpt', p_text, 'disclaimerShown', false));
$p$;

create function pg_temp.push(p_ws uuid, p_payload jsonb, p_version bigint default 0) returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(p_ws, 'communication_event', p_payload, p_version);
$p$;

/** Erwartet eine Abweisung mit genau diesem Text. */
create function pg_temp.abgewiesen(p_label text, p_ws uuid, p_payload jsonb, p_text text)
returns void language plpgsql as $p$
begin
  begin
    perform pg_temp.push(p_ws, p_payload, 0);
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.abzug(p_ws uuid) returns jsonb language sql as $p$
  select coalesce(public.pull_workspace_sync_state(p_ws)->'communication_events', 'null'::jsonb);
$p$;

/* ------------------------------------------------------------------ */
/* A -- Anlage und Wiederholung                                        */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000c201';
  v jsonb;
  r public.workspace_communication_events;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);

  v := pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-1', '2026-10-05T09:00:00.000Z'));
  if (v->>'row_version')::bigint <> 1 or (v->>'deleted')::boolean then
    raise exception 'A1 -- Anlage falsch: %', v;
  end if;
  select * into r from public.workspace_communication_events
   where workspace_id = v_ws and client_event_id = 'comm-evt-1';
  if r.context_type <> 'document' or r.context_id <> 'doc-1' or r.event_type <> 'marked_answered'
     or r.event_at <> '2026-10-05T09:00:00.000Z'::timestamptz
     or r.created_by <> '00000000-0000-0000-0000-0000000c5201'::uuid then
    raise exception 'A1 -- Zeile falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  A1 -- Anlage: Kontext, Art, Ereigniszeit und Ersteller stehen in der Zeile';

  -- Verlorene Bestaetigung: dieselbe Kennung, beliebige Versionsangabe.
  v := pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-1', '2026-10-05T09:00:00.000Z'), 1);
  if coalesce((v->>'replayed')::boolean, false) is not true or (v->>'row_version')::bigint <> 1 then
    raise exception 'A2 -- Wiederholung nicht erkannt: %', v;
  end if;

  -- Selbst ein abweichender Inhalt ueberschreibt das festgehaltene Ereignis nicht.
  v := pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-1', '2026-10-05T09:00:00.000Z', p_text => 'anders'));
  select * into r from public.workspace_communication_events
   where workspace_id = v_ws and client_event_id = 'comm-evt-1';
  if r.payload->>'resultExcerpt' <> 'Als erledigt markiert' or r.row_version <> 1 then
    raise exception 'A3 -- Ereignis wurde ueberschrieben: %', to_jsonb(r);
  end if;
  if (select count(*) from public.workspace_communication_events where workspace_id = v_ws) <> 1 then
    raise exception 'A3 -- Wiederholung hat eine zweite Zeile erzeugt';
  end if;
  raise notice 'OK  A2/A3 -- Wiederholung gibt die Zeile unveraendert zurueck: kein Duplikat, kein Ueberschreiben';
end $$;

/* ------------------------------------------------------------------ */
/* B -- Strukturpruefung, kein Loeschen                                */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000c201';
  p jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);
  p := pg_temp.ereignis('comm-evt-b', '2026-10-05T10:00:00.000Z');

  perform pg_temp.abgewiesen('B1', v_ws, (p - 'event_id') || jsonb_build_object('payload', (p->'payload') - 'id'),
                             'event_id fehlt');
  perform pg_temp.abgewiesen('B2', v_ws, p || jsonb_build_object('deleted', true),
                             'Kommunikationsereignisse koennen nicht geloescht werden');
  perform pg_temp.abgewiesen('B3', v_ws, jsonb_set(p - 'context_type', '{payload,contextRef,type}', '"Dokument X"'::jsonb),
                             'Kommunikationsereignis ungueltig: contextRef');
  perform pg_temp.abgewiesen('B4', v_ws, jsonb_set(p - 'event_type', '{payload,type}', '"DROP TABLE"'::jsonb),
                             'Kommunikationsereignis ungueltig: type');
  perform pg_temp.abgewiesen('B5', v_ws, jsonb_set(p - 'event_at', '{payload,timestamp}', '"gestern"'::jsonb),
                             'Kommunikationsereignis ungueltig: timestamp');
  perform pg_temp.abgewiesen('B6', v_ws, jsonb_set(p, '{payload,resultExcerpt}', to_jsonb(repeat('x', 20001))),
                             'Kommunikationsereignis ungueltig: zu gross');
  if exists (select 1 from public.workspace_communication_events where client_event_id = 'comm-evt-b') then
    raise exception 'B -- eine abgewiesene Zeile wurde trotzdem geschrieben';
  end if;
  raise notice 'OK  B1-B6 -- fehlende Kennung, Loeschen, Kontext, Art, Zeit und Groesse werden abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* C -- Reihenfolge im Abzug                                           */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000c201';
  zeilen jsonb;
  ids text;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);
  -- Bewusst ausser der Reihe angelegt, zwei mit identischer Zeit.
  perform pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-4', '2026-10-05T12:00:00.000Z', 'draft_created'));
  perform pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-2', '2026-10-05T08:00:00.000Z', 'document_question'));
  perform pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-3b', '2026-10-05T10:30:00.000Z', 'draft_copied'));
  perform pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-3a', '2026-10-05T10:30:00.000Z', 'draft_channel_switched'));

  zeilen := pg_temp.abzug(v_ws);
  select string_agg(z->>'client_event_id', ',' order by n) into ids
    from jsonb_array_elements(zeilen) with ordinality as t(z, n);
  if ids <> 'comm-evt-2,comm-evt-1,comm-evt-3a,comm-evt-3b,comm-evt-4' then
    raise exception 'C1 -- Reihenfolge im Abzug falsch: %', ids;
  end if;
  raise notice 'OK  C1 -- Abzug nach Ereigniszeit, bei Gleichstand nach Kennung';
end $$;

/* ------------------------------------------------------------------ */
/* D -- Isolation                                                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000c201';
  v_fremd constant uuid := '00000000-0000-0000-0000-00000000c202';
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5203'::uuid);
  perform pg_temp.abgewiesen('D1', v_ws, pg_temp.ereignis('comm-evt-9', '2026-10-05T11:00:00.000Z'),
                             'Kein Zugriff auf Workspace');
  begin
    perform pg_temp.abzug(v_ws);
    raise exception 'D2 -- fremder Abzug NICHT abgewiesen';
  exception when others then
    if position('Kein Zugriff auf Workspace' in sqlerrm) = 0 then
      raise exception 'D2 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;

  -- Dieselbe Kennung im eigenen Betrieb ist eine eigene Zeile.
  perform pg_temp.push(v_fremd, pg_temp.ereignis('comm-evt-1', '2026-10-05T07:00:00.000Z', p_text => 'fremd'));
  zeilen := pg_temp.abzug(v_fremd);
  if jsonb_array_length(zeilen) <> 1 or (zeilen->0->>'workspace_id')::uuid <> v_fremd then
    raise exception 'D3 -- fremder Abzug falsch: %', zeilen;
  end if;

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);
  zeilen := pg_temp.abzug(v_ws);
  if exists (select 1 from jsonb_array_elements(zeilen) z where (z->>'workspace_id')::uuid <> v_ws) then
    raise exception 'D4 -- eigener Abzug enthaelt fremde Zeilen';
  end if;
  if (select z->'payload'->>'resultExcerpt' from jsonb_array_elements(zeilen) z
       where z->>'client_event_id' = 'comm-evt-1') <> 'Als erledigt markiert' then
    raise exception 'D4 -- das eigene Ereignis wurde vom fremden Betrieb beruehrt';
  end if;
  raise notice 'OK  D1-D4 -- fremder Betrieb kann weder schreiben noch abziehen; gleiche Kennung bleibt getrennt';
end $$;

/* ------------------------------------------------------------------ */
/* E -- Rollen                                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000c201';
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5202'::uuid);
  perform pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-m1', '2026-10-05T13:00:00.000Z', 'marked_no_reply_needed',
                                              'vorgang', 'v-7', 'Kein Antwortbedarf'));
  zeilen := pg_temp.abzug(v_ws);
  if jsonb_array_length(zeilen) <> 1 or zeilen->0->>'client_event_id' <> 'comm-evt-m1' then
    raise exception 'E1 -- Mitglied sieht nicht genau sein eigenes Ereignis: %', zeilen;
  end if;
  raise notice 'OK  E1 -- Mitglied legt an und zieht nur eigene Ereignisse ab';

  perform pg_temp.abgewiesen('E2', v_ws, pg_temp.ereignis('comm-evt-1', '2026-10-05T09:00:00.000Z'),
                             'Keine Schreibberechtigung');
  raise notice 'OK  E2 -- ein Replay gibt einem Mitglied keine fremde Zeile zurueck';

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);
  zeilen := pg_temp.abzug(v_ws);
  if jsonb_array_length(zeilen) <> 6 then
    raise exception 'E3 -- Inhaber sieht nicht alle Ereignisse: %', jsonb_array_length(zeilen);
  end if;
  raise notice 'OK  E3 -- Inhaber sieht alle Ereignisse des Betriebs';

  perform pg_temp.abmelden();
  begin
    perform pg_temp.push(v_ws, pg_temp.ereignis('comm-evt-x', '2026-10-05T14:00:00.000Z'));
    raise exception 'E4 -- ohne Anmeldung NICHT abgewiesen';
  exception when others then
    if position('Nicht angemeldet' in sqlerrm) = 0 then
      raise exception 'E4 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;
  raise notice 'OK  E4 -- ohne Anmeldung kein Zugriff';
end $$;

/* ------------------------------------------------------------------ */
/* F -- RLS bei direktem Zugriff                                       */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000c5203'::uuid);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_communication_events
              where workspace_id = '00000000-0000-0000-0000-00000000c201'::uuid) then
    raise exception 'F1 -- fremder Nutzer liest Ereignisse des Betriebs direkt';
  end if;
  begin
    insert into public.workspace_communication_events
      (workspace_id, client_event_id, context_type, event_type, event_at, payload)
    values ('00000000-0000-0000-0000-00000000c202'::uuid, 'direkt', 'none', 'draft_created', now(), '{}'::jsonb);
    raise exception 'F2 -- direktes Schreiben NICHT abgewiesen';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK  F1/F2 -- direkt: kein fremdes Lesen, kein Schreiben an der RPC vorbei';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000c5202'::uuid);
set local role authenticated;
do $$
begin
  if (select count(*) from public.workspace_communication_events
       where workspace_id = '00000000-0000-0000-0000-00000000c201'::uuid) <> 1 then
    raise exception 'F3 -- Mitglied liest direkt mehr oder weniger als sein eigenes Ereignis';
  end if;
  raise notice 'OK  F3 -- Mitglied liest direkt nur das eigene Ereignis';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);
set local role authenticated;
do $$
begin
  if (select count(*) from public.workspace_communication_events
       where workspace_id = '00000000-0000-0000-0000-00000000c201'::uuid) <> 6 then
    raise exception 'F4 -- Inhaber liest direkt nicht alle Ereignisse';
  end if;
  raise notice 'OK  F4 -- Inhaber liest direkt alle Ereignisse des eigenen Betriebs';
end $$;
reset role;

/* ------------------------------------------------------------------ */
/* G -- der Dispatcher ist sonst unveraendert                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000c201';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000c5201'::uuid);
  begin
    perform public.upsert_workspace_sync_entity(v_ws, 'gibt_es_nicht', '{}'::jsonb, 0);
    raise exception 'G1 -- unbekannter Typ NICHT abgewiesen';
  exception when others then
    if position('Unbekannter Entity-Typ' in sqlerrm) = 0 then
      raise exception 'G1 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;

  -- S1 arbeitet unveraendert weiter.
  v := public.upsert_workspace_sync_entity(v_ws, 'paper_register_entry', jsonb_build_object(
         'entry_id', 'paper-reg-doc-s2', 'document_id', 'doc-s2',
         'payload', jsonb_build_object('id', 'paper-reg-doc-s2', 'documentId', 'doc-s2', 'documentTitle', 'T',
           'folderId', 'f', 'register', 'A', 'physicalFiled', true,
           'createdAt', '2026-10-05T08:00:00.000Z', 'updatedAt', '2026-10-05T08:00:00.000Z'),
         'deleted', false), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'G2 -- Papierablage-Zweig verhaelt sich anders: %', v;
  end if;

  v := public.upsert_workspace_sync_entity(v_ws, 'vorgang_note', jsonb_build_object(
         'note_id', 'note-s2', 'vorgang_id', 'v-s2',
         'payload', jsonb_build_object('id', 'note-s2', 'vorgangId', 'v-s2', 'body', 'Notiz'),
         'deleted', false), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'G3 -- Notiz-Zweig verhaelt sich anders: %', v;
  end if;

  if not (public.pull_workspace_sync_state(v_ws) ?& array['vorgaenge', 'customers', 'vorgang_notes',
          'tasks', 'dunning_documentations', 'business_letters', 'offers', 'bank_accounts',
          'bank_transactions', 'bank_reconciliations', 'paper_register_entries', 'communication_events']) then
    raise exception 'G4 -- Abzug hat einen Schluessel verloren';
  end if;
  raise notice 'OK  G1-G4 -- unbekannter Typ, Papierablage, Notiz und alle Abzugsschluessel unveraendert';
end $$;

do $$
begin
  raise notice '--------------------------------------------------';
  raise notice 'CLOUD-SYNC S2: alle Zusicherungen erfuellt.';
  raise notice '--------------------------------------------------';
end $$;

rollback;
