-- CLOUD-SYNC S6 -- Laufzeittest der Auftrags- und Nachtragsentwuerfe als
-- Sync-Entitaeten und ihres atomaren Verbrauchs.
--
-- Geprueft wird der echte Weg: `upsert_workspace_sync_entity`,
-- `pull_workspace_sync_state`, `create_workspace_order` und
-- `confirm_workspace_order_amendment`, angemeldet als echte Rollen.
--
--   A  Tabellen, Constraints, Grants, RLS bei direktem Zugriff
--   B  Auftragsentwurf: Anlage, Wiederholung, Version, Struktur, Rechte
--   C  Auftragsentwurf: Grabstein ohne Inhalt, kein Wiederbeleben
--   D  Nachtragsentwurf: nur zu einem bestaetigten Auftrag, Struktur, Version
--   E  Nachtragsentwurf: Grabstein, kein Wiederbeleben, kein Auftragswechsel
--   F  Abzug: beide Schluessel, Endzustaende ohne Inhalt, Sichtbarkeit
--   G  Auftragsanlage mit Bindung: Vertrag, Version, atomarer Verbrauch
--   H  Auftrags-Replay: gleiche Bindung Erfolg, andere Bindung ehrlicher Befund
--   I  Genau ein Auftrag, genau eine Nummer; Ablehnungen verbrauchen nichts
--   J  Ohne Bindung wie bisher -- und kein aktiver Entwurf neben einem Auftrag
--   K  Nachtragsbestaetigung mit Bindung: Vertrag, Version, atomarer Verbrauch
--   L  Retry und Doppelbestaetigung: genau ein bestaetigter Nachtrag
--   M  sourceDraftId: im Nachtrag, ausserhalb des Fingerprints, eindeutig
--   N  Schlussrechnungs-Guard und Nachtragssequenz unveraendert
--   O  Rechte unveraendert: Anlage Inhaber/Admin, Bestaetigung aktives Mitglied, kein R1
--   P  Der Dispatcher ist sonst unveraendert; alte Signaturen gibt es nicht mehr
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/order_drafts_s6.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000d6601'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-s6@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d6602'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-s6@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d6603'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-s6@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

-- R1-SEC-01: nur fuer die Schlussrechnung in N (finalize_workspace_invoice verlangt R1).
update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like '%-s6@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000d601'::uuid, 'S6 Betrieb', '00000000-0000-0000-0000-0000000d6601'::uuid),
       ('00000000-0000-0000-0000-00000000d602'::uuid, 'S6 Fremd',   '00000000-0000-0000-0000-0000000d6603'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000d601'::uuid, '00000000-0000-0000-0000-0000000d6601'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000d601'::uuid, '00000000-0000-0000-0000-0000000d6602'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000000d602'::uuid, '00000000-0000-0000-0000-0000000d6603'::uuid, 'owner',  'active');

insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000d601'::uuid, 'cust-s6', '{"id":"cust-s6","name":"S6 Kunde GmbH"}'::jsonb);

/* Ein Vorgang ohne bestaetigten Auftrag -- fuer den Nachtragsentwurf ungeeignet. */
insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-00000000d601'::uuid, 'v-s6-offen', '{"id":"v-s6-offen","title":"Offen"}'::jsonb);

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
$p$;

create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% -- falscher Fehler: %', p_label, sqlerrm;
    end if;
    return;
  end;
  raise exception '% -- kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

/** Der Push eines Auftragsentwurfs, wie ihn der Client baut. */
create function pg_temp.auftragsentwurf(p_id text, p_titel text default 'S6 Auftrag',
                                        p_deleted boolean default false,
                                        p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $p$
  select jsonb_build_object(
    'draft_id', p_id,
    'payload', case when p_deleted then '{}'::jsonb else jsonb_build_object(
      'id', p_id,
      'customerId', 'cust-s6',
      'customerBilling', jsonb_build_object('name', 'S6 Kunde GmbH', 'contactPerson', '', 'street', 'Weg 6',
        'zip', '33602', 'city', 'Bielefeld', 'email', '', 'phone', ''),
      'title', p_titel,
      'baustelle', 'Weg 6',
      'positions', jsonb_build_array(jsonb_build_object('id', 'p1', 'description', 'Montage',
        'plannedQuantity', 2, 'unit', 'Stunden', 'unitPrice', 100)),
      'taxStatus', 'standard_19',
      'paymentTermsText', '14 Tage',
      'createdAt', '2026-10-07T08:00:00.000Z',
      'updatedAt', '2026-10-07T08:00:00.000Z'
    ) || p_extra end,
    'deleted', p_deleted
  );
$p$;

/** Die Auftragsdaten fuer create_workspace_order (wie createOrderFromDraftWithCloud). */
create function pg_temp.auftragsdaten(p_titel text default 'S6 Auftrag') returns jsonb language sql as $p$
  select jsonb_build_object(
    'customerId', 'cust-s6',
    'customerBilling', jsonb_build_object('name', 'S6 Kunde GmbH', 'street', 'Weg 6', 'zip', '33602', 'city', 'Bielefeld'),
    'title', p_titel,
    'baustelle', 'Weg 6',
    'taxStatus', 'standard_19',
    'paymentTermsText', '14 Tage',
    'positions', jsonb_build_array(jsonb_build_object('id', 'p1', 'description', 'Montage',
      'plannedQuantity', 2, 'unit', 'Stunden', 'unitPrice', 100))
  );
$p$;

/** Der Push eines Nachtragsentwurfs, wie ihn der Client baut. */
create function pg_temp.nachtragsentwurf(p_id text, p_vorgang text, p_titel text default 'Nachtrag',
                                         p_deleted boolean default false,
                                         p_extra jsonb default '{}'::jsonb,
                                         p_pos_extra jsonb default '{}'::jsonb) returns jsonb language sql as $p$
  select jsonb_build_object(
    'draft_id', p_id,
    'vorgang_id', p_vorgang,
    'payload', case when p_deleted then '{}'::jsonb else jsonb_build_object(
      'id', p_id,
      'vorgangId', p_vorgang,
      'title', p_titel,
      'positions', jsonb_build_array(jsonb_build_object('id', 'oad-' || p_id, 'changeType', 'add',
        'description', 'Zusatz', 'quantity', 1, 'unit', 'Stunden', 'unitPrice', 50) || p_pos_extra),
      'createdAt', '2026-10-07T08:00:00.000Z',
      'updatedAt', '2026-10-07T08:00:00.000Z'
    ) || p_extra end,
    'deleted', p_deleted
  );
$p$;

/** Die Bestaetigungsdaten (wie buildOrderAmendmentConfirmRpcInput). */
create function pg_temp.nachtragsdaten(p_pos text, p_titel text default 'Nachtrag') returns jsonb language sql as $p$
  select jsonb_build_object('title', p_titel, 'positions', jsonb_build_array(jsonb_build_object(
    'id', p_pos, 'changeType', 'add', 'description', 'Zusatz', 'plannedQuantity', 1, 'unit', 'Stunden', 'unitPrice', 50)));
$p$;

create function pg_temp.push(p_ws uuid, p_type text, p_payload jsonb, p_version bigint) returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(p_ws, p_type, p_payload, p_version);
$p$;

create function pg_temp.od(p_id text) returns public.workspace_order_drafts language sql as $p$
  select d.* from public.workspace_order_drafts d
  where d.workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid and d.client_draft_id = p_id;
$p$;

create function pg_temp.ad(p_id text) returns public.workspace_order_amendment_drafts language sql as $p$
  select d.* from public.workspace_order_amendment_drafts d
  where d.workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid and d.client_draft_id = p_id;
$p$;

create function pg_temp.auftragsnummernstand() returns integer language sql as $p$
  select coalesce((select s.last_sequence from public.workspace_order_sequences s
    where s.workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid
      and s.order_year = extract(year from now())::integer), 0);
$p$;

create function pg_temp.nachtraege(p_vorgang text) returns integer language sql as $p$
  select count(*)::integer from public.workspace_order_amendments a
  where a.workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid and a.vorgang_id = p_vorgang;
$p$;

/* ------------------------------------------------------------------ */
/* A -- Tabellen, Constraints, Grants                                  */
/* ------------------------------------------------------------------ */

do $$
begin
  if has_table_privilege('authenticated', 'public.workspace_order_drafts', 'INSERT')
     or has_table_privilege('authenticated', 'public.workspace_order_drafts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.workspace_order_drafts', 'DELETE')
     or has_table_privilege('authenticated', 'public.workspace_order_amendment_drafts', 'INSERT')
     or has_table_privilege('authenticated', 'public.workspace_order_amendment_drafts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.workspace_order_amendment_drafts', 'DELETE') then
    raise exception 'A1 -- authenticated darf direkt schreiben';
  end if;
  if not has_table_privilege('authenticated', 'public.workspace_order_drafts', 'SELECT')
     or not has_table_privilege('authenticated', 'public.workspace_order_amendment_drafts', 'SELECT') then
    raise exception 'A1 -- authenticated darf nicht lesen';
  end if;
  if has_table_privilege('anon', 'public.workspace_order_drafts', 'SELECT')
     or has_table_privilege('anon', 'public.workspace_order_amendment_drafts', 'SELECT') then
    raise exception 'A1 -- anon darf lesen';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.workspace_order_drafts'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.workspace_order_amendment_drafts'::regclass) then
    raise exception 'A2 -- RLS nicht aktiv';
  end if;

  -- Endzustand ohne Inhalt, verbraucht nur mit Bezug, nie verbraucht und verworfen zugleich.
  begin
    insert into public.workspace_order_drafts (workspace_id, client_draft_id, payload, deleted)
    values ('00000000-0000-0000-0000-00000000d601', 'v-a3', '{"title":"x"}'::jsonb, true);
    raise exception 'A3 -- Grabstein mit Inhalt angenommen';
  exception when check_violation then null;
  end;
  begin
    insert into public.workspace_order_drafts (workspace_id, client_draft_id, status)
    values ('00000000-0000-0000-0000-00000000d601', 'v-a4', 'consumed');
    raise exception 'A4 -- verbraucht ohne Bezug angenommen';
  exception when check_violation then null;
  end;
  begin
    insert into public.workspace_order_drafts (workspace_id, client_draft_id, status, consumed_vorgang_id)
    values ('00000000-0000-0000-0000-00000000d601', 'v-a5', 'consumed', 'v-anderer');
    raise exception 'A5 -- verbraucht mit fremdem Bezug angenommen';
  exception when check_violation then null;
  end;
  begin
    insert into public.workspace_order_drafts (workspace_id, client_draft_id, status, consumed_vorgang_id)
    values ('00000000-0000-0000-0000-00000000d601', 'v-a6', 'consumed', 'v-a6');
    raise exception 'A6 -- verbraucht ohne existierenden Auftrag angenommen';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.workspace_order_amendment_drafts (workspace_id, client_draft_id, vorgang_id)
    values ('00000000-0000-0000-0000-00000000d601', 'oa-a7', 'v-gibt-es-nicht');
    raise exception 'A7 -- Nachtragsentwurf ohne Auftrag angenommen';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.workspace_order_amendment_drafts (workspace_id, client_draft_id, vorgang_id, status, consumed_client_amendment_id)
    values ('00000000-0000-0000-0000-00000000d601', 'oa-a8', 'v-s6-offen', 'consumed', 'oam-gibt-es-nicht');
    raise exception 'A8 -- verbrauchter Nachtragsentwurf ohne Nachtrag angenommen';
  exception when foreign_key_violation then null;
  end;
  raise notice 'OK  A1-A8 -- nur Lesen fuer authenticated, RLS aktiv, Endzustaende ohne Inhalt, Bezuege echt';
end $$;

/* ------------------------------------------------------------------ */
/* B -- Auftragsentwurf: Anlage, Wiederholung, Version, Struktur       */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6601'::uuid);
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
begin
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-b1'), 0);
  if (r->>'row_version')::bigint <> 1 or (r->>'deleted')::boolean then raise exception 'B1 -- Anlage: %', r; end if;
  if (pg_temp.od('v-b1')).status <> 'active' or (pg_temp.od('v-b1')).payload->>'title' <> 'S6 Auftrag' then
    raise exception 'B1 -- Zeile: %', to_jsonb(pg_temp.od('v-b1'));
  end if;

  -- B2: identische Wiederholung mit Version 0 (verlorene Bestaetigung) -> dieselbe Zeile.
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-b1'), 0);
  if (r->>'row_version')::bigint <> 1 or not coalesce((r->>'replayed')::boolean, false) then raise exception 'B2 -- %', r; end if;

  -- B3: anderer Inhalt mit Version 0 -> Konflikt, nichts geschrieben.
  perform pg_temp.erwarte_fehler('B3 Version 0 mit anderem Inhalt',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b1', 'Anders'), 0)$q$,
    'Versionskonflikt order_draft:1');

  -- B4/B5: Aenderung mit bestaetigter Version; die veraltete Version ist ein Konflikt.
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-b1', 'Geaendert'), 1);
  if (r->>'row_version')::bigint <> 2 then raise exception 'B4 -- %', r; end if;
  perform pg_temp.erwarte_fehler('B5 veraltete Version',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b1', 'Alt'), 1)$q$,
    'Versionskonflikt order_draft:2');
  if (pg_temp.od('v-b1')).payload->>'title' <> 'Geaendert' then raise exception 'B5 -- ueberschrieben'; end if;

  -- B6: Struktur -- keine Nummern, kein Bestaetigungsstand, kein Workspace, nichts Lokales.
  perform pg_temp.erwarte_fehler('B6a Auftragsnummer',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', 'x', false, '{"orderNumber":"AU-2026-0001"}'::jsonb), 0)$q$,
    'Auftragsentwurf ungueltig: Auftragsdaten');
  perform pg_temp.erwarte_fehler('B6b Vorgangsnummer',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', 'x', false, '{"vorgangNumber":"VG-1"}'::jsonb), 0)$q$,
    'Auftragsentwurf ungueltig: Auftragsdaten');
  perform pg_temp.erwarte_fehler('B6c Workspace im Inhalt',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', 'x', false, '{"workspaceId":"ws-x"}'::jsonb), 0)$q$,
    'Auftragsentwurf ungueltig: lokale Felder');
  perform pg_temp.erwarte_fehler('B6d Konflikt im Inhalt',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', 'x', false, '{"conflict":{"kind":"version"}}'::jsonb), 0)$q$,
    'Auftragsentwurf ungueltig: lokale Felder');
  perform pg_temp.erwarte_fehler('B6e Positionen kein Array',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', 'x', false, '{"positions":{}}'::jsonb), 0)$q$,
    'Auftragsentwurf ungueltig: Positionen');
  perform pg_temp.erwarte_fehler('B6f fremde Kennung im Inhalt',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', 'x', false, '{"id":"v-andere"}'::jsonb), 0)$q$,
    'Auftragsentwurf ungueltig: id');
  perform pg_temp.erwarte_fehler('B6g zu gross',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b6', repeat('x', 300000)), 0)$q$,
    'Auftragsentwurf ungueltig: zu gross');
  if (pg_temp.od('v-b6')).client_draft_id is not null then
    raise exception 'B6 -- ungueltiger Entwurf wurde gespeichert';
  end if;

  -- B7: Eine Kennung, die bereits ein Vorgang ist, wird kein neuer Entwurf.
  perform pg_temp.erwarte_fehler('B7 Kennung ist bereits Vorgang',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-s6-offen'), 0)$q$,
    'Versionskonflikt order_draft:0');
  raise notice 'OK  B1-B7 -- Anlage, Wiederholung, Versionsvertrag, Struktur, keine Neuanlage fuer bestehende Vorgaenge';
end $$;

-- B8: Rechte wie im Produkt -- jedes aktive Mitglied speichert; Fremde nicht.
select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6602'::uuid);
do $$
declare r jsonb;
begin
  r := pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b8', 'Mitglied'), 0);
  if (r->>'row_version')::bigint <> 1 then raise exception 'B8 -- Mitglied: %', r; end if;
  raise notice 'OK  B8 -- Mitglied (member) speichert einen Auftragsentwurf';
end $$;
select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6603'::uuid);
do $$
begin
  perform pg_temp.erwarte_fehler('B9 fremder Nutzer',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b9'), 0)$q$,
    'Kein Zugriff');
  raise notice 'OK  B9 -- fremder Nutzer abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* C -- Auftragsentwurf: Grabstein ohne Inhalt, kein Wiederbeleben     */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6601'::uuid);
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
begin
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-b1', null, true), 2);
  if (r->>'row_version')::bigint <> 3 or not (r->>'deleted')::boolean then raise exception 'C1 -- %', r; end if;
  if (pg_temp.od('v-b1')).payload <> '{}'::jsonb or (pg_temp.od('v-b1')).deleted_at is null then
    raise exception 'C1 -- Grabstein traegt Inhalt: %', to_jsonb(pg_temp.od('v-b1'));
  end if;
  -- C2: ein zweites Verwerfen ist eine Wiederholung, keine neue Version.
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-b1', null, true), 0);
  if (r->>'row_version')::bigint <> 3 or not coalesce((r->>'replayed')::boolean, false) then raise exception 'C2 -- %', r; end if;
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-b1', null, true), 3);
  if (r->>'row_version')::bigint <> 3 then raise exception 'C2b -- %', r; end if;
  -- C3: kein Wiederbeleben -- weder mit passender Version noch mit Version 0.
  perform pg_temp.erwarte_fehler('C3a Wiederbeleben mit passender Version',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b1', 'Zurueck'), 3)$q$,
    'Versionskonflikt order_draft:3');
  perform pg_temp.erwarte_fehler('C3b Wiederbeleben mit Version 0',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-b1', 'Zurueck'), 0)$q$,
    'Versionskonflikt order_draft:3');
  if not (pg_temp.od('v-b1')).deleted then raise exception 'C3 -- wiederbelebt'; end if;
  -- C4: Ein Grabstein fuer einen nie gesehenen Entwurf wird festgehalten (gegen spaeteres Wiederbeleben).
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-c4', null, true), 0);
  if (r->>'row_version')::bigint <> 1 or not (pg_temp.od('v-c4')).deleted or (pg_temp.od('v-c4')).payload <> '{}'::jsonb then
    raise exception 'C4 -- %', r;
  end if;
  raise notice 'OK  C1-C4 -- Grabstein ohne Inhalt, Wiederholung idempotent, kein Wiederbeleben';
end $$;

/* ------------------------------------------------------------------ */
/* D/E -- Nachtragsentwurf                                             */
/* ------------------------------------------------------------------ */

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
begin
  -- Ein bestaetigter Auftrag als Grundlage (mit Bindung angelegt, siehe G).
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-auftrag'), 0);
  r := public.create_workspace_order(ws, 'v-auftrag', pg_temp.auftragsdaten(), 'v-auftrag', 1);
  if r->'vorgang'->>'order_number' is null then raise exception 'D0 -- Auftrag: %', r; end if;

  -- D1: nur zu einem bestehenden, bestaetigten Auftrag.
  perform pg_temp.erwarte_fehler('D1a Auftrag fehlt',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d1', 'v-gibt-es-nicht'), 0)$q$,
    'Nachtragsentwurf ungueltig: Auftrag fehlt');
  perform pg_temp.erwarte_fehler('D1b Auftrag nicht bestaetigt',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d1', 'v-s6-offen'), 0)$q$,
    'Nachtragsentwurf ungueltig: Auftrag nicht bestaetigt');

  -- D2: Anlage, Wiederholung, Version.
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag'), 0);
  if (r->>'row_version')::bigint <> 1 then raise exception 'D2 -- %', r; end if;
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag'), 0);
  if not coalesce((r->>'replayed')::boolean, false) then raise exception 'D2b -- %', r; end if;
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag', 'Nachtrag geaendert'), 1);
  if (r->>'row_version')::bigint <> 2 then raise exception 'D2c -- %', r; end if;
  perform pg_temp.erwarte_fehler('D2d veraltete Version',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag', 'Alt'), 1)$q$,
    'Versionskonflikt order_amendment_draft:2');

  -- D3: Struktur -- keine Sequenz, kein Fingerprint, keine Intent-Daten, nichts Lokales.
  perform pg_temp.erwarte_fehler('D3a Sequenz',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{"sequenceNo":1}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: Bestaetigungsdaten');
  perform pg_temp.erwarte_fehler('D3b Intent-Kennung',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{"clientAmendmentId":"oam-1"}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: Bestaetigungsdaten');
  perform pg_temp.erwarte_fehler('D3c Fingerprint',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{"contentFingerprint":"abc"}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: Bestaetigungsdaten');
  perform pg_temp.erwarte_fehler('D3d rpcInput',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{"rpcInput":{}}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: Bestaetigungsdaten');
  perform pg_temp.erwarte_fehler('D3e Status',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{"status":"entwurf"}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: lokale Felder');
  perform pg_temp.erwarte_fehler('D3f bestaetigte Positionsmenge',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{}'::jsonb, '{"plannedQuantity":1}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: Positionen');
  perform pg_temp.erwarte_fehler('D3g vorgangId abweichend',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d3', 'v-auftrag', 'x', false, '{"vorgangId":"v-s6-offen"}'::jsonb), 0)$q$,
    'Nachtragsentwurf ungueltig: vorgangId');

  -- E1: kein Auftragswechsel.
  perform pg_temp.erwarte_fehler('E1 Auftragswechsel',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-s6-offen'), 2)$q$,
    'Nachtragsentwurf ungueltig: Auftrag');

  -- E2: Grabstein ohne Inhalt, Wiederholung, kein Wiederbeleben.
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag', null, true), 2);
  if (r->>'row_version')::bigint <> 3 or (pg_temp.ad('oa-d2')).payload <> '{}'::jsonb then raise exception 'E2 -- %', r; end if;
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag', null, true), 0);
  if not coalesce((r->>'replayed')::boolean, false) then raise exception 'E2b -- %', r; end if;
  perform pg_temp.erwarte_fehler('E2c Wiederbeleben',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-d2', 'v-auftrag'), 3)$q$,
    'Versionskonflikt order_amendment_draft:3');

  -- E3: Grabstein eines nie gesehenen Entwurfs zu einem unbekannten Auftrag ist gegenstandslos.
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-e3', 'v-gibt-es-nicht', null, true), 0);
  if (r->>'row_version')::bigint <> 0 or not (r->>'deleted')::boolean then raise exception 'E3 -- %', r; end if;
  if exists (select 1 from public.workspace_order_amendment_drafts where client_draft_id = 'oa-e3') then
    raise exception 'E3 -- Zeile angelegt';
  end if;
  raise notice 'OK  D1-D3, E1-E3 -- Nachtragsentwurf nur zum bestaetigten Auftrag, Struktur, Version, Grabstein, kein Wechsel';
end $$;

-- E4: Mitglied speichert einen Nachtragsentwurf (wie im Produkt).
select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6602'::uuid);
do $$
declare r jsonb;
begin
  r := pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-e4', 'v-auftrag'), 0);
  if (r->>'row_version')::bigint <> 1 then raise exception 'E4 -- %', r; end if;
  raise notice 'OK  E4 -- Mitglied speichert einen Nachtragsentwurf';
end $$;

/* ------------------------------------------------------------------ */
/* F -- Abzug                                                          */
/* ------------------------------------------------------------------ */

do $$
declare
  p jsonb;
  od jsonb;
  ad jsonb;
begin
  p := public.pull_workspace_sync_state('00000000-0000-0000-0000-00000000d601');
  if not (p ? 'order_drafts') or not (p ? 'order_amendment_drafts') then raise exception 'F1 -- Schluessel fehlen'; end if;
  select x into od from jsonb_array_elements(p->'order_drafts') x where x->>'client_draft_id' = 'v-b1';
  if od is null or (od ? 'payload') or not (od->>'deleted')::boolean then raise exception 'F2 -- Grabstein im Abzug: %', od; end if;
  select x into od from jsonb_array_elements(p->'order_drafts') x where x->>'client_draft_id' = 'v-auftrag';
  if od is null or (od ? 'payload') or od->>'status' <> 'consumed' then raise exception 'F3 -- verbraucht im Abzug: %', od; end if;
  select x into od from jsonb_array_elements(p->'order_drafts') x where x->>'client_draft_id' = 'v-b8';
  if od is null or od->'payload'->>'title' <> 'Mitglied' then raise exception 'F4 -- aktiver Entwurf mit Inhalt: %', od; end if;
  select x into ad from jsonb_array_elements(p->'order_amendment_drafts') x where x->>'client_draft_id' = 'oa-e4';
  if ad is null or ad->'payload'->>'title' <> 'Nachtrag' or ad->>'vorgang_id' <> 'v-auftrag' then raise exception 'F5 -- %', ad; end if;
  select x into ad from jsonb_array_elements(p->'order_amendment_drafts') x where x->>'client_draft_id' = 'oa-d2';
  if ad is null or (ad ? 'payload') then raise exception 'F6 -- %', ad; end if;
  raise notice 'OK  F1-F6 -- beide Schluessel, Endzustaende ohne Inhalt, aktive mit Inhalt, Mitglied sieht alles';
end $$;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6603'::uuid);
do $$
begin
  perform pg_temp.erwarte_fehler('F7 fremder Abzug',
    $q$select public.pull_workspace_sync_state('00000000-0000-0000-0000-00000000d601')$q$, 'Kein Zugriff');
end $$;
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_order_drafts where workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid)
     or exists (select 1 from public.workspace_order_amendment_drafts where workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid) then
    raise exception 'F8 -- fremder Nutzer liest Entwuerfe direkt';
  end if;
  begin
    insert into public.workspace_order_drafts (workspace_id, client_draft_id)
    values ('00000000-0000-0000-0000-00000000d602'::uuid, 'v-direkt');
    raise exception 'F9 -- direktes Schreiben NICHT abgewiesen';
  exception when insufficient_privilege then null;
  end;
  raise notice 'OK  F7-F9 -- kein fremder Abzug, kein fremdes Lesen, kein Schreiben an der RPC vorbei';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6602'::uuid);
set local role authenticated;
do $$
begin
  if (select count(*) from public.workspace_order_drafts where workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid) < 3 then
    raise exception 'F10 -- Mitglied liest direkt nicht';
  end if;
  begin
    update public.workspace_order_amendment_drafts set payload = '{}'::jsonb
    where workspace_id = '00000000-0000-0000-0000-00000000d601'::uuid;
    raise exception 'F11 -- direktes Aendern NICHT abgewiesen';
  exception when insufficient_privilege then null;
  end;
  raise notice 'OK  F10/F11 -- Mitglied liest direkt, aendert aber nur ueber die RPC';
end $$;
reset role;

/* ------------------------------------------------------------------ */
/* G/H/I -- Auftragsanlage mit Bindung                                 */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6601'::uuid);
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
  n integer;
  nummer text;
begin
  -- G1: Bindungsvertrag.
  perform pg_temp.erwarte_fehler('G1a nur Version',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten(), null, 1)$q$,
    'order_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('G1b nur Kennung',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten(), 'v-g', null)$q$,
    'order_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('G1c Version 0',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten(), 'v-g', 0)$q$,
    'order_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('G1d fremde Entwurfskennung',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten(), 'v-anders', 1)$q$,
    'order_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('G2 unbekannter Entwurf',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten(), 'v-g', 1)$q$,
    'order_draft_not_found');

  -- G3: veraltete Bindung -> kein Auftrag, keine Nummer.
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-g'), 0);
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-g', 'Neuere Fassung'), 1);
  n := pg_temp.auftragsnummernstand();
  perform pg_temp.erwarte_fehler('G3 veraltete Entwurfsversion',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten(), 'v-g', 1)$q$,
    'order_draft_version_conflict:2');
  if exists (select 1 from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-g') then
    raise exception 'G3 -- Auftrag trotz Versionskonflikt angelegt';
  end if;
  if pg_temp.auftragsnummernstand() <> n or (pg_temp.od('v-g')).status <> 'active' then
    raise exception 'G3 -- Nummer verbraucht oder Entwurf veraendert';
  end if;

  -- G4: passende Bindung -> Auftrag und Verbrauch in derselben Transaktion.
  r := public.create_workspace_order(ws, 'v-g', pg_temp.auftragsdaten('Neuere Fassung'), 'v-g', 2);
  nummer := r->'vorgang'->>'order_number';
  if nummer is null or coalesce((r->>'replayed')::boolean, false) then raise exception 'G4 -- %', r; end if;
  if (pg_temp.od('v-g')).status <> 'consumed' or (pg_temp.od('v-g')).consumed_vorgang_id <> 'v-g'
     or (pg_temp.od('v-g')).row_version <> 3 or (pg_temp.od('v-g')).payload <> '{}'::jsonb then
    raise exception 'G4 -- Entwurf nicht atomar verbraucht: %', to_jsonb(pg_temp.od('v-g'));
  end if;
  if pg_temp.auftragsnummernstand() <> n + 1 then raise exception 'G4 -- Nummernstand %', pg_temp.auftragsnummernstand(); end if;

  -- H1: Wiederholung mit genau derselben Bindung -> derselbe Auftrag, keine neue Nummer.
  r := public.create_workspace_order(ws, 'v-g', pg_temp.auftragsdaten('Neuere Fassung'), 'v-g', 2);
  if not coalesce((r->>'replayed')::boolean, false) or r->'vorgang'->>'order_number' <> nummer then raise exception 'H1 -- %', r; end if;

  -- H2: Wiederholung mit anderer Bindung -> kein Erfolg, der ehrliche Befund.
  perform pg_temp.erwarte_fehler('H2a andere Version',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten('Alte Fassung'), 'v-g', 1)$q$,
    'order_draft_already_consumed');
  perform pg_temp.erwarte_fehler('H2b spaetere Version',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-g', pg_temp.auftragsdaten('Spaeter'), 'v-g', 3)$q$,
    'order_draft_already_consumed');

  -- H3: Ein verbrauchter Entwurf wird weder geaendert noch verworfen noch wiederbelebt.
  perform pg_temp.erwarte_fehler('H3a Aenderung',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-g', 'Danach'), 3)$q$,
    'Versionskonflikt order_draft:3');
  perform pg_temp.erwarte_fehler('H3b Verwerfen',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-g', null, true), 3)$q$,
    'Versionskonflikt order_draft:3');
  perform pg_temp.erwarte_fehler('H3c Version 0',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_draft', pg_temp.auftragsentwurf('v-g', 'Danach'), 0)$q$,
    'Versionskonflikt order_draft:3');

  -- H4: ein verworfener Entwurf wird kein Auftrag.
  perform pg_temp.erwarte_fehler('H4 verworfener Entwurf',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-b1', pg_temp.auftragsdaten(), 'v-b1', 3)$q$,
    'order_draft_discarded');

  -- I1: genau ein Auftrag, genau eine Nummer.
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws and vorgang_id = 'v-g';
  if n <> 1 then raise exception 'I1 -- % Auftraege', n; end if;
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws and order_number = nummer;
  if n <> 1 then raise exception 'I1 -- Nummer % mal vergeben', n; end if;
  raise notice 'OK  G1-G4, H1-H4, I1 -- Bindungsvertrag, atomarer Verbrauch, ehrlicher Replay, genau ein Auftrag und eine Nummer (%)', nummer;
end $$;

/* ------------------------------------------------------------------ */
/* J -- Ohne Bindung wie bisher                                        */
/* ------------------------------------------------------------------ */

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
begin
  -- J1: alter Client ohne Cloud-Entwurf -> Anlage und Wiederholung wie bisher.
  r := public.create_workspace_order(ws, 'v-j1', pg_temp.auftragsdaten());
  if r->'vorgang'->>'order_number' is null or coalesce((r->>'replayed')::boolean, false) then raise exception 'J1 -- %', r; end if;
  r := public.create_workspace_order(ws, 'v-j1', pg_temp.auftragsdaten());
  if not coalesce((r->>'replayed')::boolean, false) then raise exception 'J1b -- %', r; end if;

  -- J2: ohne Bindung, aber mit aktivem Cloud-Entwurf derselben Kennung -> dieser bleibt nicht aktiv.
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-j2'), 0);
  r := public.create_workspace_order(ws, 'v-j2', pg_temp.auftragsdaten());
  if (pg_temp.od('v-j2')).status <> 'consumed' or (pg_temp.od('v-j2')).payload <> '{}'::jsonb then
    raise exception 'J2 -- Entwurf neben Auftrag aktiv: %', to_jsonb(pg_temp.od('v-j2'));
  end if;
  raise notice 'OK  J1/J2 -- ohne Bindung wie bisher; kein aktiver Entwurf neben einem Auftrag';
end $$;

/* ------------------------------------------------------------------ */
/* K/L/M -- Nachtragsbestaetigung mit Bindung                          */
/* ------------------------------------------------------------------ */

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
  n integer;
  row_amd public.workspace_order_amendments;
begin
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-k', 'v-auftrag'), 0);
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-k', 'v-auftrag', 'Nachtrag K'), 1);

  -- K1: Bindungsvertrag.
  perform pg_temp.erwarte_fehler('K1a nur Version',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), null, 2)$q$,
    'order_amendment_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('K1b Version 0',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-k', 0)$q$,
    'order_amendment_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('K1c fremder Auftrag',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-g', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-k', 2)$q$,
    'order_amendment_draft_binding_invalid');
  perform pg_temp.erwarte_fehler('K2 unbekannter Entwurf',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-gibt-es-nicht', 1)$q$,
    'order_amendment_draft_not_found');

  -- K3: veraltete Bindung -> kein Nachtrag, keine Sequenz.
  perform pg_temp.erwarte_fehler('K3 veraltete Entwurfsversion',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k'), 'oa-k', 1)$q$,
    'order_amendment_draft_version_conflict:2');
  if pg_temp.nachtraege('v-auftrag') <> 0 or (pg_temp.ad('oa-k')).status <> 'active' then
    raise exception 'K3 -- Nachtrag oder Verbrauch trotz Versionskonflikt';
  end if;

  -- K4: passende Bindung -> bestaetigter Nachtrag und Verbrauch in derselben Transaktion.
  r := public.confirm_workspace_order_amendment(ws, 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-k', 2);
  if coalesce((r->>'idempotent_replay')::boolean, true) or (r->'row'->>'sequence_no')::integer <> 1 then raise exception 'K4 -- %', r; end if;
  if (pg_temp.ad('oa-k')).status <> 'consumed' or (pg_temp.ad('oa-k')).consumed_client_amendment_id <> 'oam-k'
     or (pg_temp.ad('oa-k')).row_version <> 3 or (pg_temp.ad('oa-k')).payload <> '{}'::jsonb then
    raise exception 'K4 -- Entwurf nicht atomar verbraucht: %', to_jsonb(pg_temp.ad('oa-k'));
  end if;

  -- M1: sourceDraftId im Nachtrag; Fingerprint unveraendert (gleicher Inhalt ohne Bindung -> gleicher Fingerprint).
  select a.* into row_amd from public.workspace_order_amendments a where a.workspace_id = ws and a.client_amendment_id = 'oam-k';
  if row_amd.payload->>'sourceDraftId' <> 'oa-k' then raise exception 'M1 -- sourceDraftId fehlt: %', row_amd.payload; end if;
  if row_amd.content_fingerprint <> public.fingerprint_workspace_order_amendment_canonical(
       public.build_workspace_order_amendment_canonical_content('v-auftrag', 'Nachtrag K', null,
         jsonb_build_array(jsonb_build_object('id', 'oad-oa-k', 'changeType', 'add', 'parentPositionId', null,
           'description', 'Zusatz', 'plannedQuantity', 1, 'unit', 'Stunden', 'unitLabel', null, 'unitPrice', 50,
           'category', null, 'billable', null)))) then
    raise exception 'M1 -- Fingerprint durch sourceDraftId veraendert';
  end if;

  -- L1: Retry mit derselben Kennung und derselben Bindung -> Wiederholung, genau ein Nachtrag.
  r := public.confirm_workspace_order_amendment(ws, 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-k', 2);
  if not coalesce((r->>'idempotent_replay')::boolean, false) then raise exception 'L1 -- %', r; end if;

  -- L2: ein anderes Geraet mit eigener Kennung -> kein zweiter Nachtrag.
  perform pg_temp.erwarte_fehler('L2 Doppelbestaetigung',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-k-b', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-k', 2)$q$,
    'order_amendment_draft_already_consumed');
  if pg_temp.nachtraege('v-auftrag') <> 1 then raise exception 'L2 -- % Nachtraege', pg_temp.nachtraege('v-auftrag'); end if;

  -- L3: verbrauchter Entwurf wird nicht wiederbelebt; verworfener nicht bestaetigt.
  perform pg_temp.erwarte_fehler('L3a Wiederbeleben',
    $q$select pg_temp.push('00000000-0000-0000-0000-00000000d601', 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-k', 'v-auftrag', 'Danach'), 3)$q$,
    'Versionskonflikt order_amendment_draft:3');
  perform pg_temp.erwarte_fehler('L3b verworfener Entwurf',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-d2', pg_temp.nachtragsdaten('oad-oa-d2'), 'oa-d2', 3)$q$,
    'order_amendment_draft_discarded');

  -- M2: hoechstens ein Nachtrag je Entwurf -- auch an der RPC vorbei.
  begin
    insert into public.workspace_order_amendments (workspace_id, vorgang_id, client_amendment_id, sequence_no, status,
      content_fingerprint, payload, confirmed_by)
    values (ws, 'v-auftrag', 'oam-direkt', 9, 'bestaetigt', 'x', jsonb_build_object('sourceDraftId', 'oa-k'),
      '00000000-0000-0000-0000-0000000d6601');
    raise exception 'M2 -- zweiter Nachtrag zum selben Entwurf angenommen';
  exception when unique_violation then null;
  end;

  -- K5: ohne Bindung wie bisher -- ohne sourceDraftId.
  r := public.confirm_workspace_order_amendment(ws, 'v-auftrag', 'oam-ohne', pg_temp.nachtragsdaten('oad-ohne'));
  if (r->'row'->>'sequence_no')::integer <> 2 or (r->'amendment') ? 'sourceDraftId' then raise exception 'K5 -- %', r; end if;
  raise notice 'OK  K1-K5, L1-L3, M1/M2 -- Bindung, atomarer Verbrauch, Retry, keine Doppelbestaetigung, sourceDraftId ausserhalb des Fingerprints';
end $$;

/* ------------------------------------------------------------------ */
/* O -- Rechte unveraendert                                            */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6602'::uuid);
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
begin
  -- O1: Mitglied legt keinen Auftrag an -- auch nicht mit Bindung; der Entwurf bleibt aktiv.
  r := pg_temp.push(ws, 'order_draft', pg_temp.auftragsentwurf('v-o1'), 0);
  perform pg_temp.erwarte_fehler('O1 Mitglied legt Auftrag an',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-o1', pg_temp.auftragsdaten(), 'v-o1', 1)$q$,
    'Keine Schreibberechtigung');
  if (pg_temp.od('v-o1')).status <> 'active' then raise exception 'O1 -- Entwurf veraendert'; end if;

  -- O2: Mitglied bestaetigt einen Nachtrag mit Bindung -- wie bisher jedes aktive Mitglied.
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-o2', 'v-auftrag'), 0);
  r := public.confirm_workspace_order_amendment(ws, 'v-auftrag', 'oam-o2', pg_temp.nachtragsdaten('oad-oa-o2'), 'oa-o2', 1);
  if (r->'row'->>'sequence_no')::integer <> 3 or (pg_temp.ad('oa-o2')).status <> 'consumed' then raise exception 'O2 -- %', r; end if;
  raise notice 'OK  O1/O2 -- Auftragsanlage bleibt Inhaber/Admin, Nachtragsbestaetigung jedes aktive Mitglied';
end $$;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6603'::uuid);
do $$
begin
  perform pg_temp.erwarte_fehler('O3 fremder Nutzer bestaetigt',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-fremd', pg_temp.nachtragsdaten('oad-fremd'), 'oa-e4', 1)$q$,
    'Kein Zugriff');
  perform pg_temp.erwarte_fehler('O4 fremder Nutzer legt Auftrag an',
    $q$select public.create_workspace_order('00000000-0000-0000-0000-00000000d601', 'v-b8', pg_temp.auftragsdaten(), 'v-b8', 1)$q$,
    'Kein Zugriff');
  raise notice 'OK  O3/O4 -- fremde Nutzer abgewiesen';
end $$;

/* ------------------------------------------------------------------ */
/* N -- Schlussrechnungs-Guard und Nachtragssequenz unveraendert       */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d6601'::uuid);
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
  beleg jsonb := jsonb_build_object(
    'type', 'schluss',
    'positions', jsonb_build_array(jsonb_build_object('id', 'line-p1', 'orderPositionId', 'p1', 'description', 'Montage',
      'quantity', 2, 'unit', 'Stunden', 'unitPrice', 100, 'lineTotal', 200)),
    'taxStatus', 'standard_19',
    'subtotal', 200,
    'amount', 238,
    'issueDate', '2026-10-07',
    'customerSnapshot', jsonb_build_object('name', 'S6 Kunde GmbH', 'street', 'Weg 6', 'zip', '33602', 'city', 'Bielefeld'));
begin
  -- N1: Die Schlussrechnung erwartet den aktuellen Nachtragsstand (3); ein alter Stand ist veraltet.
  perform pg_temp.erwarte_fehler('N1 veralteter Nachtragsstand',
    format($q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'inv-s6-alt', %L::jsonb)$q$,
      beleg || '{"expectedAmendmentSequence":2}'::jsonb),
    'invoice_amendment_state_stale');
  r := public.finalize_workspace_invoice(ws, 'v-auftrag', 'inv-s6-schluss', beleg || '{"expectedAmendmentSequence":3}'::jsonb);
  if r->'row'->>'invoice_number' is null then raise exception 'N1 -- Schlussrechnung: %', r; end if;

  -- N2: Nach der Schlussrechnung keine neue Bestaetigung -- der gebundene Entwurf bleibt aktiv.
  r := pg_temp.push(ws, 'order_amendment_draft', pg_temp.nachtragsentwurf('oa-n2', 'v-auftrag'), 0);
  perform pg_temp.erwarte_fehler('N2 Schluss-Guard',
    $q$select public.confirm_workspace_order_amendment('00000000-0000-0000-0000-00000000d601', 'v-auftrag', 'oam-n2', pg_temp.nachtragsdaten('oad-oa-n2'), 'oa-n2', 1)$q$,
    'order_amendment_final_invoice_exists');
  if (pg_temp.ad('oa-n2')).status <> 'active' or pg_temp.nachtraege('v-auftrag') <> 3 then
    raise exception 'N2 -- Verbrauch oder Nachtrag trotz Schlussrechnung';
  end if;
  -- N3: Die Wiederholung einer bereits bestaetigten Bindung bleibt auch danach eine Wiederholung.
  r := public.confirm_workspace_order_amendment(ws, 'v-auftrag', 'oam-k', pg_temp.nachtragsdaten('oad-oa-k', 'Nachtrag K'), 'oa-k', 2);
  if not coalesce((r->>'idempotent_replay')::boolean, false) then raise exception 'N3 -- %', r; end if;
  raise notice 'OK  N1-N3 -- Nachtragsstand der Schlussrechnung, Schluss-Guard und Wiederholung unveraendert';
end $$;

/* ------------------------------------------------------------------ */
/* P -- Dispatcher sonst unveraendert, alte Signaturen entfernt         */
/* ------------------------------------------------------------------ */

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000d601';
  r jsonb;
  n integer;
begin
  perform pg_temp.erwarte_fehler('P1 unbekannter Typ',
    $q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000d601', 'gibt_es_nicht', '{}'::jsonb, 0)$q$,
    'Unbekannter Entity-Typ');
  r := public.upsert_workspace_sync_entity(ws, 'knowledge_fact', jsonb_build_object(
         'fact_id', 'knowledge-s6', 'scope', 'company',
         'payload', jsonb_build_object('id', 'knowledge-s6', 'scope', 'company', 'category', 'other',
           'key', 'k', 'value', 'v', 'displayText', 'Wissen', 'sourceType', 'user',
           'confirmedAt', '2026-10-07T08:00:00.000Z', 'createdAt', '2026-10-07T08:00:00.000Z', 'active', true),
         'deleted', false), 0);
  if (r->>'row_version')::bigint <> 1 then raise exception 'P2 -- S3-Zweig veraendert: %', r; end if;
  r := public.upsert_workspace_sync_entity(ws, 'invoice_draft', jsonb_build_object(
         'draft_id', 'draft-s6', 'vorgang_id', 'null'::jsonb, 'invoice_type', 'rechnung',
         'payload', jsonb_build_object('id', 'draft-s6', 'vorgangId', 'null'::jsonb, 'type', 'rechnung',
           'positions', jsonb_build_array(), 'introText', 'S6'),
         'deleted', false), 0);
  if (r->>'row_version')::bigint <> 1 then raise exception 'P3 -- S5-Zweig veraendert: %', r; end if;

  select count(*) into n from jsonb_object_keys(public.pull_workspace_sync_state(ws));
  if n <> 21 then raise exception 'P4 -- Abzug hat % statt 21 Schluessel', n; end if;

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in ('create_workspace_order', 'confirm_workspace_order_amendment');
  if n <> 2 then raise exception 'P5 -- % Fassungen statt 2 (Overload?)', n; end if;
  if to_regprocedure('public.create_workspace_order(uuid, text, jsonb)') is not null
     or to_regprocedure('public.confirm_workspace_order_amendment(uuid, text, text, jsonb)') is not null then
    raise exception 'P5 -- alte Signatur existiert noch';
  end if;
  if not has_function_privilege('authenticated', 'public.create_workspace_order(uuid, text, jsonb, text, bigint)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.confirm_workspace_order_amendment(uuid, text, text, jsonb, text, bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_workspace_order(uuid, text, jsonb, text, bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.confirm_workspace_order_amendment(uuid, text, text, jsonb, text, bigint)', 'EXECUTE') then
    raise exception 'P6 -- Ausfuehrungsrechte falsch';
  end if;
  raise notice 'OK  P1-P6 -- Dispatcher sonst unveraendert (S3, S5), Abzug 21 Schluessel, keine alten Signaturen, Rechte wie bisher';
end $$;

select 'S6 order_drafts: alle Zusicherungen erfuellt';

rollback;
