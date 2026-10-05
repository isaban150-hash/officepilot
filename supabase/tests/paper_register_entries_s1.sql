-- CLOUD-SYNC S1 -- Laufzeittest des Papierablage-Hakens als Sync-Entitaet.
--
-- Geprueft wird der echte Weg: `upsert_workspace_sync_entity` und
-- `pull_workspace_sync_state`, angemeldet als echte Rollen.
--
--   A  Anlage, Wiederholung, Konflikt bei Version 0 (CREATE-RETRY-CONFLICT-02)
--   B  Aenderung mit bestaetigter Version, veraltete Version ist ein Konflikt
--   C  Strukturpruefung (ID, Dokumentbezug, Haken, Ordner, Groesse)
--   D  Grabstein: bleibt stehen, reist im Abzug mit, kein Wiederbeleben
--   E  Isolation: fremder Betrieb liest und schreibt nichts
--   F  Rollen wie am Dokument: Mitglied nur eigene Zeilen, kein Grabstein
--   G  RLS bei direktem Lesen
--   H  Der Dispatcher ist sonst unveraendert
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/paper_register_entries_s1.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000b5101'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-s1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000b5102'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-s1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000b5103'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-s1@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000a501'::uuid, 'S1 Betrieb', '00000000-0000-0000-0000-0000000b5101'::uuid),
       ('00000000-0000-0000-0000-00000000a502'::uuid, 'S1 Fremd',   '00000000-0000-0000-0000-0000000b5103'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000a501'::uuid, '00000000-0000-0000-0000-0000000b5101'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000a501'::uuid, '00000000-0000-0000-0000-0000000b5102'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000000a502'::uuid, '00000000-0000-0000-0000-0000000b5103'::uuid, 'owner',  'active');

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
$p$;

create function pg_temp.abmelden() returns void language sql as $p$
  select set_config('request.jwt.claims', '{"role":"anon"}', true)::void;
$p$;

/** Der Push, wie ihn der Client baut. */
create function pg_temp.eintrag(p_id text, p_doc text, p_filed boolean, p_folder text default 'ordner-steuer',
                                p_deleted boolean default false) returns jsonb language sql as $p$
  select jsonb_build_object(
    'entry_id', p_id,
    'document_id', p_doc,
    'payload', jsonb_build_object(
      'id', p_id, 'documentId', p_doc, 'documentTitle', 'Bescheid ' || p_doc,
      'folderId', p_folder, 'register', 'Steuern', 'physicalFiled', p_filed,
      'createdAt', '2026-10-05T08:00:00.000Z', 'updatedAt', '2026-10-05T08:00:00.000Z'),
    'deleted', p_deleted);
$p$;

create function pg_temp.push(p_ws uuid, p_payload jsonb, p_version bigint) returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(p_ws, 'paper_register_entry', p_payload, p_version);
$p$;

/** Erwartet eine Abweisung mit genau diesem Text. */
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

/** Die Zeilen eines Abzugs fuer genau diesen Betrieb. */
create function pg_temp.abzug(p_ws uuid) returns jsonb language sql as $p$
  select coalesce(public.pull_workspace_sync_state(p_ws)->'paper_register_entries', 'null'::jsonb);
$p$;

/* ------------------------------------------------------------------ */
/* A -- Anlage, Wiederholung, Konflikt                                 */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  v jsonb;
  r public.workspace_paper_register_entries;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);

  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', false), 0);
  if (v->>'row_version')::bigint <> 1 or (v->>'deleted')::boolean then
    raise exception 'A1 -- Anlage falsch: %', v;
  end if;
  select * into r from public.workspace_paper_register_entries
   where workspace_id = v_ws and client_entry_id = 'paper-reg-doc-1';
  if r.client_document_id <> 'doc-1' or r.created_by <> '00000000-0000-0000-0000-0000000b5101'::uuid
     or (r.payload->>'physicalFiled')::boolean <> false then
    raise exception 'A1 -- Zeile falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  A1 -- Anlage mit Version 0 ergibt row_version 1';

  -- Verlorene Bestaetigung: derselbe Anlegevorgang noch einmal.
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', false), 0);
  if coalesce((v->>'replayed')::boolean, false) is not true or (v->>'row_version')::bigint <> 1 then
    raise exception 'A2 -- Wiederholung nicht erkannt: %', v;
  end if;
  raise notice 'OK  A2 -- inhaltsgleiche Wiederholung aendert nichts (replayed)';

  perform pg_temp.abgewiesen('A3', v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', true), 0,
                             'Versionskonflikt paper_register_entry:1');
  raise notice 'OK  A3 -- abweichender Inhalt mit Version 0 ist ein Konflikt';
end $$;

/* ------------------------------------------------------------------ */
/* B -- Aenderung mit bestaetigter Version                             */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', true), 1);
  if (v->>'row_version')::bigint <> 2 or (v->'payload'->'payload'->>'physicalFiled')::boolean is not true then
    raise exception 'B1 -- Haken nicht gesetzt: %', v;
  end if;
  raise notice 'OK  B1 -- abgeheftet mit Version 1 ergibt row_version 2';

  perform pg_temp.abgewiesen('B2', v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', true, 'anderer-ordner'), 1,
                             'Versionskonflikt paper_register_entry:2');
  raise notice 'OK  B2 -- veraltete Version ist ein Konflikt, kein stilles Ueberschreiben';
end $$;

/* ------------------------------------------------------------------ */
/* C -- Strukturpruefung                                               */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  p jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  p := pg_temp.eintrag('paper-reg-doc-2', 'doc-2', false);

  perform pg_temp.abgewiesen('C1', v_ws, jsonb_build_object('document_id', 'doc-2',
                             'payload', (p->'payload') - 'id', 'deleted', false), 0,
                             'entry_id fehlt');
  perform pg_temp.abgewiesen('C2', v_ws, jsonb_build_object('entry_id', 'paper-reg-doc-2',
                             'payload', (p->'payload') - 'documentId', 'deleted', false), 0,
                             'document_id fehlt');
  perform pg_temp.abgewiesen('C3', v_ws, jsonb_set(p, '{payload}', (p->'payload') - 'physicalFiled'), 0,
                             'Papierablage ungueltig: physicalFiled');
  perform pg_temp.abgewiesen('C4', v_ws, jsonb_set(p, '{payload,physicalFiled}', '"ja"'::jsonb), 0,
                             'Papierablage ungueltig: physicalFiled');
  perform pg_temp.abgewiesen('C5', v_ws, jsonb_set(p, '{payload,folderId}', '42'::jsonb), 0,
                             'Papierablage ungueltig: Ordner');
  perform pg_temp.abgewiesen('C6', v_ws, jsonb_set(p, '{payload,documentTitle}', to_jsonb(repeat('x', 20001))), 0,
                             'Papierablage ungueltig: zu gross');
  -- Ein vorhandener Eintrag wechselt nie sein Dokument.
  perform pg_temp.abgewiesen('C7', v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-anders', true), 2,
                             'Papierablage ungueltig: document_id');
  if exists (select 1 from public.workspace_paper_register_entries where client_entry_id = 'paper-reg-doc-2') then
    raise exception 'C -- eine abgewiesene Zeile wurde trotzdem geschrieben';
  end if;
  raise notice 'OK  C1-C7 -- fehlende ID, Bezug, Haken, Ordner, Groesse und Dokumentwechsel werden abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* D -- Grabstein                                                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  v jsonb;
  r public.workspace_paper_register_entries;
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', true, 'ordner-steuer', true), 2);
  if (v->>'row_version')::bigint <> 3 or (v->>'deleted')::boolean is not true then
    raise exception 'D1 -- Grabstein falsch: %', v;
  end if;
  select * into r from public.workspace_paper_register_entries
   where workspace_id = v_ws and client_entry_id = 'paper-reg-doc-1';
  if r.deleted_at is null or r.client_document_id <> 'doc-1' or (r.payload->>'physicalFiled')::boolean is not true then
    raise exception 'D1 -- Grabstein hat Inhalt oder Bezug verloren: %', to_jsonb(r);
  end if;
  raise notice 'OK  D1 -- Grabstein: Zeile bleibt, Bezug und Inhalt bleiben, deleted_at gesetzt';

  zeilen := pg_temp.abzug(v_ws);
  if jsonb_array_length(zeilen) <> 1 or (zeilen->0->>'deleted')::boolean is not true then
    raise exception 'D2 -- Grabstein fehlt im Abzug: %', zeilen;
  end if;
  raise notice 'OK  D2 -- der Abzug liefert den Grabstein mit';

  -- Wiederholung des Grabsteins nach verlorener Bestaetigung.
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', true, 'ordner-steuer', true), 0);
  if coalesce((v->>'replayed')::boolean, false) is not true or (v->>'row_version')::bigint <> 3 then
    raise exception 'D3 -- Grabstein-Wiederholung nicht erkannt: %', v;
  end if;
  raise notice 'OK  D3 -- wiederholter Grabstein ist ein Replay';

  perform pg_temp.abgewiesen('D4', v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', true), 3,
                             'Versionskonflikt paper_register_entry:3');
  perform pg_temp.abgewiesen('D5', v_ws, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', false), 0,
                             'Versionskonflikt paper_register_entry:3');
  raise notice 'OK  D4/D5 -- kein Wiederbeleben, weder mit passender Version noch mit 0';

  -- Ein Grabstein fuer einen Eintrag, den die Cloud nie gesehen hat.
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-3', 'doc-3', false, 'ordner-steuer', true), 0);
  select * into r from public.workspace_paper_register_entries
   where workspace_id = v_ws and client_entry_id = 'paper-reg-doc-3';
  if not r.deleted or r.payload <> '{}'::jsonb or r.client_document_id <> 'doc-3' then
    raise exception 'D6 -- Grabstein-Anlage falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  D6 -- Grabstein ohne Vorgaenger wird als Grabstein angelegt';
end $$;

/* ------------------------------------------------------------------ */
/* E -- Isolation                                                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  v_fremd constant uuid := '00000000-0000-0000-0000-00000000a502';
  v jsonb;
  zeilen jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5103'::uuid);

  perform pg_temp.abgewiesen('E1', v_ws, pg_temp.eintrag('paper-reg-doc-9', 'doc-9', true), 0,
                             'Kein Zugriff auf Workspace');
  begin
    perform pg_temp.abzug(v_ws);
    raise exception 'E2 -- fremder Abzug NICHT abgewiesen';
  exception when others then
    if position('Kein Zugriff auf Workspace' in sqlerrm) = 0 then
      raise exception 'E2 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;
  raise notice 'OK  E1/E2 -- fremder Betrieb kann weder schreiben noch abziehen';

  -- Dieselbe Kennung im eigenen Betrieb ist eine eigene, unabhaengige Zeile.
  v := pg_temp.push(v_fremd, pg_temp.eintrag('paper-reg-doc-1', 'doc-1', false), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'E3 -- eigene Zeile nicht angelegt: %', v;
  end if;
  zeilen := pg_temp.abzug(v_fremd);
  if jsonb_array_length(zeilen) <> 1 or (zeilen->0->>'workspace_id')::uuid <> v_fremd
     or (zeilen->0->>'deleted')::boolean then
    raise exception 'E3 -- fremder Abzug enthaelt falsche Zeilen: %', zeilen;
  end if;

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  zeilen := pg_temp.abzug(v_ws);
  if exists (select 1 from jsonb_array_elements(zeilen) z where (z->>'workspace_id')::uuid <> v_ws) then
    raise exception 'E4 -- eigener Abzug enthaelt fremde Zeilen: %', zeilen;
  end if;
  if (select (z->>'deleted')::boolean from jsonb_array_elements(zeilen) z
       where z->>'client_entry_id' = 'paper-reg-doc-1') is not true then
    raise exception 'E4 -- der eigene Grabstein wurde vom fremden Betrieb beruehrt';
  end if;
  raise notice 'OK  E3/E4 -- gleiche Kennung in zwei Betrieben: zwei Zeilen, kein Uebersprechen';
end $$;

/* ------------------------------------------------------------------ */
/* F -- Rollen wie am Dokument                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  v jsonb;
  zeilen jsonb;
begin
  -- Inhaber legt einen aktiven Eintrag an.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  perform pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-4', 'doc-4', false), 0);

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5102'::uuid);
  -- Mitglied legt eigenen an und hakt ihn ab.
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-5', 'doc-5', false), 0);
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-5', 'doc-5', true), 1);
  if (v->>'row_version')::bigint <> 2 then
    raise exception 'F1 -- Mitglied konnte eigenen Eintrag nicht abhaken: %', v;
  end if;
  raise notice 'OK  F1 -- Mitglied legt an und hakt eigene Eintraege ab';

  perform pg_temp.abgewiesen('F2', v_ws, pg_temp.eintrag('paper-reg-doc-4', 'doc-4', true), 1,
                             'Keine Schreibberechtigung');
  perform pg_temp.abgewiesen('F3', v_ws, pg_temp.eintrag('paper-reg-doc-4', 'doc-4', false), 0,
                             'Keine Schreibberechtigung');
  perform pg_temp.abgewiesen('F4', v_ws, pg_temp.eintrag('paper-reg-doc-5', 'doc-5', true, 'ordner-steuer', true), 2,
                             'Keine Schreibberechtigung');
  raise notice 'OK  F2-F4 -- fremde Zeile weder aendern noch wiederholen; Grabstein nur Inhaber/Admin';

  zeilen := pg_temp.abzug(v_ws);
  if jsonb_array_length(zeilen) <> 1 or zeilen->0->>'client_entry_id' <> 'paper-reg-doc-5' then
    raise exception 'F5 -- Mitglied sieht fremde Eintraege: %', zeilen;
  end if;
  raise notice 'OK  F5 -- Mitglied zieht nur die selbst angelegten Zeilen ab';

  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  zeilen := pg_temp.abzug(v_ws);
  if jsonb_array_length(zeilen) <> 4 then
    raise exception 'F6 -- Inhaber sieht nicht alle Zeilen: %', zeilen;
  end if;
  -- Der Inhaber darf den Eintrag des Mitglieds aendern und loeschen.
  v := pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-5', 'doc-5', true, 'ordner-steuer', true), 2);
  if (v->>'deleted')::boolean is not true then
    raise exception 'F6 -- Inhaber konnte nicht loeschen: %', v;
  end if;
  raise notice 'OK  F6 -- Inhaber sieht alles und darf fremde Eintraege loeschen';

  perform pg_temp.abmelden();
  begin
    perform pg_temp.push(v_ws, pg_temp.eintrag('paper-reg-doc-6', 'doc-6', true), 0);
    raise exception 'F7 -- ohne Anmeldung NICHT abgewiesen';
  exception when others then
    if position('Nicht angemeldet' in sqlerrm) = 0 then
      raise exception 'F7 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;
  raise notice 'OK  F7 -- ohne Anmeldung kein Zugriff';
end $$;

/* ------------------------------------------------------------------ */
/* G -- RLS bei direktem Lesen                                         */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000b5103'::uuid);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_paper_register_entries
              where workspace_id = '00000000-0000-0000-0000-00000000a501'::uuid) then
    raise exception 'G1 -- fremder Nutzer liest Zeilen des Betriebs direkt';
  end if;
  begin
    insert into public.workspace_paper_register_entries (workspace_id, client_entry_id, payload)
    values ('00000000-0000-0000-0000-00000000a502'::uuid, 'direkt', '{}'::jsonb);
    raise exception 'G2 -- direktes Schreiben NICHT abgewiesen';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK  G1/G2 -- direkt: kein fremdes Lesen, kein Schreiben an der RPC vorbei';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000b5102'::uuid);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_paper_register_entries
              where workspace_id = '00000000-0000-0000-0000-00000000a501'::uuid
                and created_by <> '00000000-0000-0000-0000-0000000b5102'::uuid) then
    raise exception 'G3 -- Mitglied liest fremde Zeilen direkt';
  end if;
  if not exists (select 1 from public.workspace_paper_register_entries
                  where workspace_id = '00000000-0000-0000-0000-00000000a501'::uuid) then
    raise exception 'G3 -- Mitglied sieht nicht einmal die eigenen Zeilen';
  end if;
  raise notice 'OK  G3 -- Mitglied liest direkt nur eigene Zeilen';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
set local role authenticated;
do $$
begin
  if (select count(*) from public.workspace_paper_register_entries
       where workspace_id = '00000000-0000-0000-0000-00000000a501'::uuid) <> 4 then
    raise exception 'G4 -- Inhaber sieht direkt nicht alle Zeilen';
  end if;
  raise notice 'OK  G4 -- Inhaber liest direkt alle Zeilen des eigenen Betriebs';
end $$;
reset role;

/* ------------------------------------------------------------------ */
/* H -- der Dispatcher ist sonst unveraendert                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000a501';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000b5101'::uuid);
  begin
    perform public.upsert_workspace_sync_entity(v_ws, 'gibt_es_nicht', '{}'::jsonb, 0);
    raise exception 'H1 -- unbekannter Typ NICHT abgewiesen';
  exception when others then
    if position('Unbekannter Entity-Typ' in sqlerrm) = 0 then
      raise exception 'H1 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;

  -- Ein bestehender Zweig arbeitet wie zuvor.
  v := public.upsert_workspace_sync_entity(v_ws, 'vorgang_note', jsonb_build_object(
         'note_id', 'note-s1', 'vorgang_id', 'v-s1',
         'payload', jsonb_build_object('id', 'note-s1', 'vorgangId', 'v-s1', 'body', 'Notiz'),
         'deleted', false), 0);
  if (v->>'row_version')::bigint <> 1 then
    raise exception 'H2 -- Notiz-Zweig verhaelt sich anders: %', v;
  end if;

  -- Der Abzug liefert die bisherigen Schluessel unveraendert mit.
  if not (public.pull_workspace_sync_state(v_ws) ?& array['vorgaenge', 'customers', 'vorgang_notes',
          'tasks', 'dunning_documentations', 'business_letters', 'offers', 'bank_accounts',
          'bank_transactions', 'bank_reconciliations', 'paper_register_entries']) then
    raise exception 'H3 -- Abzug hat einen Schluessel verloren';
  end if;
  raise notice 'OK  H1-H3 -- unbekannter Typ, Notiz-Zweig und alle Abzugsschluessel unveraendert';
end $$;

do $$
begin
  raise notice '--------------------------------------------------';
  raise notice 'CLOUD-SYNC S1: alle Zusicherungen erfuellt.';
  raise notice '--------------------------------------------------';
end $$;

rollback;
