-- CLOUD-SYNC S3 -- Laufzeittest des bestaetigten Wissens als Sync-Entitaet.
--
-- Geprueft wird der echte Weg: `upsert_workspace_sync_entity` und
-- `pull_workspace_sync_state`, angemeldet als echte Rollen.
--
--   A  Anlage, Wiederholung, Konflikt bei Version 0 (CREATE-RETRY-CONFLICT-02)
--   B  Aenderung und Deaktivieren mit bestaetigter Version, veraltete Version
--   C  Strukturpruefung
--   D  Grabstein: bleibt stehen, reist mit, kein Wiederbeleben
--   E  Isolation: fremder Betrieb liest und schreibt nichts
--   F  Rollen wie bei den Vorgangsnotizen: jedes aktive Mitglied
--   G  RLS bei direktem Zugriff
--   H  Der Dispatcher ist sonst unveraendert (auch S1 und S2)
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/knowledge_facts_s3.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000d5301'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-s3@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d5302'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-s3@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d5303'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-s3@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000d301'::uuid, 'S3 Betrieb', '00000000-0000-0000-0000-0000000d5301'::uuid),
       ('00000000-0000-0000-0000-00000000d302'::uuid, 'S3 Fremd',   '00000000-0000-0000-0000-0000000d5303'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000d301'::uuid, '00000000-0000-0000-0000-0000000d5301'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000d301'::uuid, '00000000-0000-0000-0000-0000000d5302'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000000d302'::uuid, '00000000-0000-0000-0000-0000000d5303'::uuid, 'owner',  'active');

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
$p$;

create function pg_temp.abmelden() returns void language sql as $p$
  select set_config('request.jwt.claims', '{"role":"anon"}', true)::void;
$p$;

/** Der Push, wie ihn der Client baut. */
create function pg_temp.fakt(p_id text, p_text text default 'Kunde bevorzugt Anruf', p_aktiv boolean default true,
                             p_deleted boolean default false) returns jsonb language sql as $p$
  select jsonb_build_object(
    'fact_id', p_id,
    'scope', 'customer',
    'payload', jsonb_build_object(
      'id', p_id, 'scope', 'customer', 'scopeId', 'kunde-1', 'scopeLabel', 'Muster GmbH',
      'category', 'communication_preference', 'key', 'kunde_bevorzugt_anruf', 'value', p_text,
      'displayText', p_text, 'sourceType', 'user', 'confirmedAt', '2026-10-06T08:00:00.000Z',
      'createdAt', '2026-10-06T08:00:00.000Z', 'active', p_aktiv),
    'deleted', p_deleted);
$p$;

create function pg_temp.push(p_ws uuid, p_payload jsonb, p_version bigint) returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(p_ws, 'knowledge_fact', p_payload, p_version);
$p$;

create function pg_temp.abgewiesen(p_label text, p_ws uuid, p_payload jsonb, p_version bigint, p_text text)
returns void language plpgsql as $p$
begin
  begin
    perform pg_temp.push(p_ws, p_payload, p_version);
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
  select coalesce(public.pull_workspace_sync_state(p_ws)->'knowledge_facts', 'null'::jsonb);
$p$;

/* ------------------------------------------------------------------ */
/* A -- Anlage, Wiederholung, Konflikt                                 */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v jsonb;
  r public.workspace_knowledge_facts;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-1'), 0);
  if (v->>'row_version')::bigint <> 1 or (v->>'deleted')::boolean then
    raise exception 'A1 -- Anlage falsch: %', v;
  end if;
  select * into r from public.workspace_knowledge_facts where workspace_id = v_ws and client_fact_id = 'knowledge-1';
  if r.scope <> 'customer' or r.scope_id <> 'kunde-1' or r.category <> 'communication_preference' or not r.active
     or r.created_by <> '00000000-0000-0000-0000-0000000d5301'::uuid then
    raise exception 'A1 -- Zeile falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  A1 -- Anlage: Scope, Kategorie, Aktiv-Kennzeichen und Ersteller stehen in der Zeile';

  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-1'), 0);
  if coalesce((v->>'replayed')::boolean, false) is not true or (v->>'row_version')::bigint <> 1 then
    raise exception 'A2 -- Wiederholung nicht erkannt: %', v;
  end if;
  raise notice 'OK  A2 -- inhaltsgleiche Wiederholung aendert nichts (replayed)';

  perform pg_temp.abgewiesen('A3', v_ws, pg_temp.fakt('knowledge-1', 'anders'), 0, 'Versionskonflikt knowledge_fact:1');
  raise notice 'OK  A3 -- abweichender Inhalt mit Version 0 ist ein Konflikt';
end $$;

/* ------------------------------------------------------------------ */
/* B -- Aenderung und Deaktivieren                                     */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v jsonb;
  r public.workspace_knowledge_facts;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-1', 'Kunde bevorzugt Anruf vormittags'), 1);
  if (v->>'row_version')::bigint <> 2 then
    raise exception 'B1 -- Aenderung falsch: %', v;
  end if;
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-1', 'Kunde bevorzugt Anruf vormittags', false), 2);
  select * into r from public.workspace_knowledge_facts where workspace_id = v_ws and client_fact_id = 'knowledge-1';
  if r.row_version <> 3 or r.active or r.payload->>'value' <> 'Kunde bevorzugt Anruf vormittags' then
    raise exception 'B2 -- Deaktivieren falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  B1/B2 -- Aendern und Deaktivieren mit bestaetigter Version';

  perform pg_temp.abgewiesen('B3', v_ws, pg_temp.fakt('knowledge-1', 'veraltet'), 2, 'Versionskonflikt knowledge_fact:3');
  raise notice 'OK  B3 -- veraltete Version ist ein Konflikt, kein stilles Ueberschreiben';
end $$;

/* ------------------------------------------------------------------ */
/* C -- Strukturpruefung                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  p jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  p := pg_temp.fakt('knowledge-c');
  perform pg_temp.abgewiesen('C1', v_ws, (p - 'fact_id') || jsonb_build_object('payload', (p->'payload') - 'id'), 0, 'fact_id fehlt');
  perform pg_temp.abgewiesen('C2', v_ws, jsonb_set(p - 'scope', '{payload,scope}', '"Kunde X"'::jsonb), 0, 'Wissen ungueltig: scope');
  perform pg_temp.abgewiesen('C3', v_ws, jsonb_set(p, '{payload,key}', '""'::jsonb), 0, 'Wissen ungueltig: key');
  perform pg_temp.abgewiesen('C4', v_ws, jsonb_set(p, '{payload}', (p->'payload') - 'value'), 0, 'Wissen ungueltig: value');
  perform pg_temp.abgewiesen('C5', v_ws, jsonb_set(p, '{payload,displayText}', '42'::jsonb), 0, 'Wissen ungueltig: displayText');
  perform pg_temp.abgewiesen('C6', v_ws, jsonb_set(p, '{payload,active}', '"ja"'::jsonb), 0, 'Wissen ungueltig: active');
  perform pg_temp.abgewiesen('C7', v_ws, jsonb_set(p, '{payload,value}', to_jsonb(repeat('x', 20001))), 0, 'Wissen ungueltig: zu gross');
  if exists (select 1 from public.workspace_knowledge_facts where client_fact_id = 'knowledge-c') then
    raise exception 'C -- eine abgewiesene Zeile wurde trotzdem geschrieben';
  end if;
  raise notice 'OK  C1-C7 -- fehlende Kennung, Scope, Schluessel, Wert, Anzeigetext, Aktiv-Kennzeichen und Groesse werden abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* D -- Grabstein                                                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v jsonb;
  r public.workspace_knowledge_facts;
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-1', 'Kunde bevorzugt Anruf vormittags', false, true), 3);
  select * into r from public.workspace_knowledge_facts where workspace_id = v_ws and client_fact_id = 'knowledge-1';
  if r.row_version <> 4 or not r.deleted or r.deleted_at is null or r.payload->>'value' <> 'Kunde bevorzugt Anruf vormittags' then
    raise exception 'D1 -- Grabstein falsch: %', to_jsonb(r);
  end if;
  zeilen := pg_temp.abzug(v_ws);
  if jsonb_array_length(zeilen) <> 1 or (zeilen->0->>'deleted')::boolean is not true then
    raise exception 'D2 -- Grabstein fehlt im Abzug: %', zeilen;
  end if;
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-1', 'x', false, true), 0);
  if coalesce((v->>'replayed')::boolean, false) is not true then
    raise exception 'D3 -- Grabstein-Wiederholung nicht erkannt: %', v;
  end if;
  perform pg_temp.abgewiesen('D4', v_ws, pg_temp.fakt('knowledge-1'), 4, 'Versionskonflikt knowledge_fact:4');
  perform pg_temp.abgewiesen('D5', v_ws, pg_temp.fakt('knowledge-1'), 0, 'Versionskonflikt knowledge_fact:4');
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-neu-weg', 'kurz', true, true), 0);
  select * into r from public.workspace_knowledge_facts where workspace_id = v_ws and client_fact_id = 'knowledge-neu-weg';
  if not r.deleted or r.payload <> '{}'::jsonb then
    raise exception 'D6 -- Grabstein-Anlage falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  D1-D6 -- Grabstein bleibt stehen, reist mit, Replay erkannt, kein Wiederbeleben';
end $$;

/* ------------------------------------------------------------------ */
/* E -- Isolation                                                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v_fremd constant uuid := '00000000-0000-0000-0000-00000000d302';
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5303'::uuid);
  perform pg_temp.abgewiesen('E1', v_ws, pg_temp.fakt('knowledge-9'), 0, 'Kein Zugriff auf Workspace');
  begin
    perform pg_temp.abzug(v_ws);
    raise exception 'E2 -- fremder Abzug NICHT abgewiesen';
  exception when others then
    if position('Kein Zugriff auf Workspace' in sqlerrm) = 0 then
      raise exception 'E2 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;
  perform pg_temp.push(v_fremd, pg_temp.fakt('knowledge-1', 'fremd'), 0);
  zeilen := pg_temp.abzug(v_fremd);
  if jsonb_array_length(zeilen) <> 1 or (zeilen->0->>'workspace_id')::uuid <> v_fremd then
    raise exception 'E3 -- fremder Abzug falsch: %', zeilen;
  end if;
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  zeilen := pg_temp.abzug(v_ws);
  if exists (select 1 from jsonb_array_elements(zeilen) z where (z->>'workspace_id')::uuid <> v_ws) then
    raise exception 'E4 -- eigener Abzug enthaelt fremde Zeilen';
  end if;
  if (select (z->>'deleted')::boolean from jsonb_array_elements(zeilen) z where z->>'client_fact_id' = 'knowledge-1') is not true then
    raise exception 'E4 -- der eigene Grabstein wurde vom fremden Betrieb beruehrt';
  end if;
  raise notice 'OK  E1-E4 -- fremder Betrieb kann weder schreiben noch abziehen; gleiche Kennung bleibt getrennt';
end $$;

/* ------------------------------------------------------------------ */
/* F -- Rollen wie bei den Vorgangsnotizen                             */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v jsonb;
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  perform pg_temp.push(v_ws, pg_temp.fakt('knowledge-inhaber', 'Material: nur Markenware'), 0);

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5302'::uuid);
  zeilen := pg_temp.abzug(v_ws);
  if not exists (select 1 from jsonb_array_elements(zeilen) z where z->>'client_fact_id' = 'knowledge-inhaber') then
    raise exception 'F1 -- Mitglied sieht das Betriebswissen des Inhabers nicht';
  end if;
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-inhaber', 'Material: nur Markenware, keine Billigware'), 1);
  if (v->>'row_version')::bigint <> 2 then
    raise exception 'F2 -- Mitglied kann Betriebswissen nicht pflegen: %', v;
  end if;
  v := pg_temp.push(v_ws, pg_temp.fakt('knowledge-mitglied', 'Anlieferung nur vormittags'), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'F3 -- Mitglied kann kein Wissen anlegen: %', v;
  end if;
  raise notice 'OK  F1-F3 -- Mitglied sieht, pflegt und legt Betriebswissen an (wie Vorgangsnotizen)';

  perform pg_temp.abmelden();
  begin
    perform pg_temp.push(v_ws, pg_temp.fakt('knowledge-x'), 0);
    raise exception 'F4 -- ohne Anmeldung NICHT abgewiesen';
  exception when others then
    if position('Nicht angemeldet' in sqlerrm) = 0 then
      raise exception 'F4 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;
  raise notice 'OK  F4 -- ohne Anmeldung kein Zugriff';
end $$;

/* ------------------------------------------------------------------ */
/* G -- RLS bei direktem Zugriff                                       */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d5303'::uuid);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_knowledge_facts
              where workspace_id = '00000000-0000-0000-0000-00000000d301'::uuid) then
    raise exception 'G1 -- fremder Nutzer liest Wissen des Betriebs direkt';
  end if;
  begin
    insert into public.workspace_knowledge_facts (workspace_id, client_fact_id, payload)
    values ('00000000-0000-0000-0000-00000000d302'::uuid, 'direkt', '{}'::jsonb);
    raise exception 'G2 -- direktes Schreiben NICHT abgewiesen';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK  G1/G2 -- direkt: kein fremdes Lesen, kein Schreiben an der RPC vorbei';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d5302'::uuid);
set local role authenticated;
do $$
begin
  if (select count(*) from public.workspace_knowledge_facts
       where workspace_id = '00000000-0000-0000-0000-00000000d301'::uuid) <> 4 then
    raise exception 'G3 -- Mitglied liest direkt nicht das ganze Betriebswissen';
  end if;
  raise notice 'OK  G3 -- Mitglied liest direkt das Wissen des eigenen Betriebs';
end $$;
reset role;

/* ------------------------------------------------------------------ */
/* H -- der Dispatcher ist sonst unveraendert                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  begin
    perform public.upsert_workspace_sync_entity(v_ws, 'gibt_es_nicht', '{}'::jsonb, 0);
    raise exception 'H1 -- unbekannter Typ NICHT abgewiesen';
  exception when others then
    if position('Unbekannter Entity-Typ' in sqlerrm) = 0 then
      raise exception 'H1 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;

  v := public.upsert_workspace_sync_entity(v_ws, 'paper_register_entry', jsonb_build_object(
         'entry_id', 'paper-reg-doc-s3', 'document_id', 'doc-s3',
         'payload', jsonb_build_object('id', 'paper-reg-doc-s3', 'documentId', 'doc-s3', 'documentTitle', 'T',
           'folderId', 'f', 'register', 'A', 'physicalFiled', true,
           'createdAt', '2026-10-06T08:00:00.000Z', 'updatedAt', '2026-10-06T08:00:00.000Z'),
         'deleted', false), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'H2 -- Papierablage-Zweig (S1) verhaelt sich anders: %', v;
  end if;
end $$;

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d301';
  v jsonb;
  abzug jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5301'::uuid);
  v := public.upsert_workspace_sync_entity(v_ws, 'communication_event', jsonb_build_object(
         'event_id', 'comm-evt-s3', 'context_type', 'none', 'event_type', 'draft_created',
         'event_at', '2026-10-06T08:00:00.000Z',
         'payload', jsonb_build_object('id', 'comm-evt-s3', 'timestamp', '2026-10-06T08:00:00.000Z',
           'type', 'draft_created', 'contextRef', jsonb_build_object('type', 'none'),
           'status', 'complete', 'disclaimerShown', false)), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'H3 -- Kommunikations-Zweig (S2) verhaelt sich anders: %', v;
  end if;

  abzug := public.pull_workspace_sync_state(v_ws);
  if exists (select 1 from unnest(array['vorgaenge', 'customers', 'vorgang_notes', 'tasks',
               'dunning_documentations', 'business_letters', 'offers', 'bank_accounts',
               'bank_transactions', 'bank_reconciliations', 'paper_register_entries',
               'communication_events', 'knowledge_facts']) as schluessel
             where (abzug -> schluessel) is null) then
    raise exception 'H4 -- Abzug hat einen Schluessel verloren';
  end if;
  raise notice 'OK  H1-H4 -- unbekannter Typ, S1, S2 und alle Abzugsschluessel unveraendert';
end $$;

do $$
begin
  raise notice '--------------------------------------------------';
  raise notice 'CLOUD-SYNC S3: alle Zusicherungen erfuellt.';
  raise notice '--------------------------------------------------';
end $$;

rollback;
