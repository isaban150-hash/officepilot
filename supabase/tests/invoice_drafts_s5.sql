-- CLOUD-SYNC S5 -- Laufzeittest des Rechnungsentwurfs als Sync-Entitaet und der
-- atomaren Finalisierung.
--
-- Geprueft wird der echte Weg: `upsert_workspace_sync_entity`,
-- `pull_workspace_sync_state` und `finalize_workspace_invoice`, angemeldet als
-- echte Rollen.
--
--   A  Anlage, Wiederholung, Konflikt bei Version 0
--   B  Aenderung mit bestaetigter Version, veraltete Version
--   C  Struktur: keine Nummer, nichts Abgeleitetes, nichts Geraetelokales
--   D  Slot-Vertrag: hoechstens ein aktiver Entwurf, Kollision als Konflikt
--   E  Grabstein „verworfen": bleibt stehen, reist mit, kein Wiederbeleben
--   F  Freigabe mit Bindung: Entwurfsverbrauch in derselben Transaktion
--   G  Doppelfreigabe A/B: genau eine Rechnung, genau eine Nummer
--   H  Wiederholung derselben clientInvoiceId
--   I  Versionsabweichung bei der Freigabe: nichts geschrieben, keine Nummer
--   J  Verworfener Entwurf wird keine Rechnung
--   K  Bindungsvertrag
--   L  R1 bleibt die erste Pruefung
--   M  Rollen und Isolation
--   N  RLS bei direktem Zugriff
--   O  Altbestand ohne Bindung unveraendert
--   P  Der Dispatcher ist sonst unveraendert
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/invoice_drafts_s5.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000d5501'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'owner-s5@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d5502'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'member-s5@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000d5503'::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fremd-s5@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

-- R1-SEC-01: freigegebene Konten mit aktiver Lizenz, wie in einem arbeitenden Betrieb.
update public.profiles
set status = 'approved', license_status = 'active', license_expires_at = null
where email like '%-s5@example.invalid';

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000d501'::uuid, 'S5 Betrieb', '00000000-0000-0000-0000-0000000d5501'::uuid),
       ('00000000-0000-0000-0000-00000000d502'::uuid, 'S5 Fremd',   '00000000-0000-0000-0000-0000000d5503'::uuid);

insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000d501'::uuid, '00000000-0000-0000-0000-0000000d5501'::uuid, 'owner',  'active'),
       ('00000000-0000-0000-0000-00000000d501'::uuid, '00000000-0000-0000-0000-0000000d5502'::uuid, 'member', 'active'),
       ('00000000-0000-0000-0000-00000000d502'::uuid, '00000000-0000-0000-0000-0000000d5503'::uuid, 'owner',  'active');

insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-00000000d501'::uuid, 'v-s5', '{}'::jsonb);
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000d501'::uuid, 'cust-s5', '{"name":"S5 Kunde GmbH"}'::jsonb);

create function pg_temp.anmelden(p_user uuid) returns void language sql as $p$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true)::void;
$p$;

create function pg_temp.abmelden() returns void language sql as $p$
  select set_config('request.jwt.claims', '{"role":"anon"}', true)::void;
$p$;

/** Der Push, wie ihn der Client baut: fachlicher Kern ohne Nummer, Projektion und Lokales. */
create function pg_temp.entwurf(p_id text, p_vorgang text default null, p_typ text default 'rechnung',
                                p_text text default 'Einleitung', p_deleted boolean default false,
                                p_kern_extra jsonb default '{}'::jsonb) returns jsonb language sql as $p$
  select jsonb_build_object(
    'draft_id', p_id,
    'vorgang_id', case when p_vorgang is null then 'null'::jsonb else to_jsonb(p_vorgang) end,
    'invoice_type', p_typ,
    'payload', jsonb_build_object(
      'id', p_id,
      'vorgangId', case when p_vorgang is null then 'null'::jsonb else to_jsonb(p_vorgang) end,
      'type', p_typ,
      'customer', 'S5 Kunde GmbH',
      'baustelle', '',
      'taxStatus', 'kleinunternehmer_19',
      'materialSource', 'betrieb',
      'positions', jsonb_build_array(jsonb_build_object(
        'id', 'pos-1', 'description', 'Leistung', 'quantity', 1, 'unit', 'Pauschal',
        'unitPrice', 100, 'billable', true)),
      'issueDate', '2026-10-06',
      'servicePeriodFrom', '', 'servicePeriodTo', '',
      'paymentDueDate', '2026-10-20', 'paymentTermsText', '14 Tage', 'skontoText', '',
      'customerBilling', jsonb_build_object('name', 'S5 Kunde GmbH', 'contactPerson', '', 'street', 'Testweg 5',
        'zip', '33602', 'city', 'Bielefeld', 'email', '', 'phone', ''),
      'companySnapshot', jsonb_build_object('companyName', 'S5 Betrieb', 'iban', 'DE00TEST'),
      'legalNotices', jsonb_build_array(),
      'introText', p_text,
      'closingText', ''
    ) || p_kern_extra,
    'deleted', p_deleted);
$p$;

create function pg_temp.push(p_ws uuid, p_payload jsonb, p_version bigint) returns jsonb language sql as $p$
  select public.upsert_workspace_sync_entity(p_ws, 'invoice_draft', p_payload, p_version);
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
  select coalesce(public.pull_workspace_sync_state(p_ws)->'invoice_drafts', 'null'::jsonb);
$p$;

create function pg_temp.zeile(p_ws uuid, p_id text) returns public.workspace_invoice_drafts language sql as $p$
  select * from public.workspace_invoice_drafts where workspace_id = p_ws and client_draft_id = p_id;
$p$;

/** Rechnungspayload einer freien Rechnung, wie ihn die Integritaetspruefung annimmt. */
create function pg_temp.rechnung(p_overrides jsonb default '{}'::jsonb) returns jsonb language sql as $p$
  select '{
    "type": "rechnung",
    "taxStatus": "kleinunternehmer_19",
    "customerId": "cust-s5",
    "customerSnapshot": {"name":"S5 Kunde GmbH","street":"Testweg 5","zip":"33602","city":"Bielefeld"},
    "positions": [{"id":"pos-1","description":"Leistung","quantity":1,"unit":"Pauschal","unitPrice":100,"lineTotal":100}],
    "subtotal": 100,
    "amount": 100,
    "issueDate": "2026-10-06"
  }'::jsonb || p_overrides;
$p$;

create function pg_temp.freigabe(p_ws uuid, p_vorgang text, p_client text, p_draft text, p_version bigint,
                                 p_invoice jsonb default null) returns jsonb language sql as $p$
  select public.finalize_workspace_invoice(p_ws, p_vorgang, p_client, coalesce(p_invoice, pg_temp.rechnung()),
                                           false, p_draft, p_version);
$p$;

create function pg_temp.freigabe_abgewiesen(p_label text, p_ws uuid, p_vorgang text, p_client text, p_draft text,
                                            p_version bigint, p_text text, p_invoice jsonb default null)
returns void language plpgsql as $p$
begin
  begin
    perform pg_temp.freigabe(p_ws, p_vorgang, p_client, p_draft, p_version, p_invoice);
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    return;
  end;
  raise exception '% -- Freigabe NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

create function pg_temp.nummernstand(p_ws uuid) returns integer language sql as $p$
  select coalesce((select last_sequence from public.workspace_invoice_sequences
                   where workspace_id = p_ws and invoice_year = 2026), 0);
$p$;

create function pg_temp.rechnungen(p_ws uuid, p_ids text[]) returns integer language sql as $p$
  select count(*)::integer from public.workspace_invoices where workspace_id = p_ws and client_invoice_id = any(p_ids);
$p$;

/* ------------------------------------------------------------------ */
/* A -- Anlage, Wiederholung, Konflikt                                 */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  r public.workspace_invoice_drafts;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-a', 'v-s5'), 0);
  if (v->>'row_version')::bigint <> 1 or (v->>'deleted')::boolean then
    raise exception 'A1 -- Anlage falsch: %', v;
  end if;
  r := pg_temp.zeile(v_ws, 'draft-a');
  if r.vorgang_id <> 'v-s5' or r.invoice_type <> 'rechnung' or r.status <> 'active'
     or r.finalized_client_invoice_id is not null
     or r.created_by <> '00000000-0000-0000-0000-0000000d5501'::uuid then
    raise exception 'A1 -- Zeile falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  A1 -- Anlage: Slot, Status aktiv, ohne Rechnung, Ersteller in der Zeile';

  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-a', 'v-s5'), 0);
  if coalesce((v->>'replayed')::boolean, false) is not true or (v->>'row_version')::bigint <> 1 then
    raise exception 'A2 -- Wiederholung nicht erkannt: %', v;
  end if;
  raise notice 'OK  A2 -- inhaltsgleiche Wiederholung aendert nichts (replayed)';

  perform pg_temp.abgewiesen('A3', v_ws, pg_temp.entwurf('draft-a', 'v-s5', 'rechnung', 'anders'), 0,
                             'Versionskonflikt invoice_draft:1');
  raise notice 'OK  A3 -- abweichender Inhalt mit Version 0 ist ein Konflikt';
end $$;

/* ------------------------------------------------------------------ */
/* B -- Aenderung mit Version                                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-a', 'v-s5', 'rechnung', 'Zweite Fassung'), 1);
  if (v->>'row_version')::bigint <> 2 or v->'payload'->'payload'->>'introText' <> 'Zweite Fassung' then
    raise exception 'B1 -- Aenderung falsch: %', v;
  end if;
  raise notice 'OK  B1 -- Aenderung mit bestaetigter Version: Version 2';

  perform pg_temp.abgewiesen('B2', v_ws, pg_temp.entwurf('draft-a', 'v-s5', 'rechnung', 'Veraltet'), 1,
                             'Versionskonflikt invoice_draft:2');
  if (pg_temp.zeile(v_ws, 'draft-a')).payload->>'introText' <> 'Zweite Fassung' then
    raise exception 'B2 -- veraltete Fassung hat ueberschrieben';
  end if;
  raise notice 'OK  B2 -- veraltete Version ist ein Konflikt, kein Last-Write-Wins';
end $$;

/* ------------------------------------------------------------------ */
/* C -- Struktur                                                       */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  perform pg_temp.abgewiesen('C1 Nummer', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"number":"2026-0001"}'::jsonb), 0, 'Rechnungsnummer');
  perform pg_temp.abgewiesen('C1 Vorschau', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"invoiceNumberPreview":"ENTWURF"}'::jsonb), 0, 'Rechnungsnummer');
  raise notice 'OK  C1 -- ein Entwurf traegt keine Rechnungsnummer';

  perform pg_temp.abgewiesen('C2 Logo', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false,
      '{"companySnapshot":{"companyName":"S5","logoDataUrl":"data:image/png;base64,AAAA"}}'::jsonb), 0, 'logoDataUrl');
  raise notice 'OK  C2 -- das geraetelokale Legacy-Logo wird abgewiesen';

  perform pg_temp.abgewiesen('C3 Mengen', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false,
      '{"positions":[{"id":"p","description":"d","quantity":1,"unit":"Pauschal","unitPrice":1,"billable":true,"openQuantity":3}]}'::jsonb),
    0, 'abgeleitete Mengen');
  perform pg_temp.abgewiesen('C3 Abzuege', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"previousAbschlagDeductions":[]}'::jsonb), 0,
    'lokale oder abgeleitete Felder');
  perform pg_temp.abgewiesen('C3 Journal', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"finalization":{"clientInvoiceId":"x"}}'::jsonb), 0,
    'lokale oder abgeleitete Felder');
  raise notice 'OK  C3 -- abgeleitete Mengen, Abzuege und Freigabejournal werden abgewiesen';

  perform pg_temp.abgewiesen('C4 id', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"id":"anders"}'::jsonb), 0, 'Rechnungsentwurf ungueltig: id');
  perform pg_temp.abgewiesen('C4 type', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"type":"abschlag"}'::jsonb), 0, 'Rechnungsart');
  perform pg_temp.abgewiesen('C4 vorgangId', v_ws,
    pg_temp.entwurf('draft-c', 'v-c', 'rechnung', 'x', false, '{"vorgangId":"v-anders"}'::jsonb), 0, 'vorgangId');
  perform pg_temp.abgewiesen('C4 manuell abschlag', v_ws, pg_temp.entwurf('draft-c', null, 'abschlag'), 0, 'vorgang_id');
  perform pg_temp.abgewiesen('C4 leerer Bezug', v_ws,
    jsonb_set(pg_temp.entwurf('draft-c', 'v-c'), '{vorgang_id}', '""'::jsonb), 0, 'vorgang_id');
  perform pg_temp.abgewiesen('C4 Typ', v_ws, pg_temp.entwurf('draft-c', 'v-c', 'quittung'), 0, 'invoice_type');
  raise notice 'OK  C4 -- Kennung, Rechnungsart, Vorgangsbezug und Typ muessen zusammenpassen';

  perform pg_temp.abgewiesen('C5 Slotwechsel', v_ws, pg_temp.entwurf('draft-a', 'v-anders', 'rechnung', 'Zweite Fassung'), 2,
                             'Rechnungsentwurf ungueltig: Slot');
  raise notice 'OK  C5 -- ein Entwurf wechselt nie seinen Slot';

  if exists (select 1 from public.workspace_invoice_drafts where client_draft_id = 'draft-c') then
    raise exception 'C -- eine abgewiesene Fassung wurde geschrieben';
  end if;
end $$;

/* ------------------------------------------------------------------ */
/* D -- Slot-Vertrag                                                   */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  -- Zwei offline erzeugte Entwuerfe fuer denselben Vorgang und dieselbe Rechnungsart.
  perform pg_temp.abgewiesen('D1', v_ws, pg_temp.entwurf('draft-offline-b', 'v-s5'), 0,
                             'Versionskonflikt invoice_draft_slot:draft-a');
  if exists (select 1 from public.workspace_invoice_drafts where client_draft_id = 'draft-offline-b') then
    raise exception 'D1 -- der zweite Entwurf wurde trotzdem angelegt';
  end if;
  if (pg_temp.zeile(v_ws, 'draft-a')).payload->>'introText' <> 'Zweite Fassung' then
    raise exception 'D1 -- der erste Entwurf wurde veraendert';
  end if;
  raise notice 'OK  D1 -- zweiter Entwurf im selben Slot: ausdruecklicher Konflikt, nichts zusammengefuehrt';

  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-abschlag', 'v-s5', 'abschlag'), 0);
  if (v->>'row_version')::bigint <> 1 then raise exception 'D2 -- anderer Slot abgewiesen: %', v; end if;
  raise notice 'OK  D2 -- andere Rechnungsart, anderer Slot';

  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-1', null), 0);
  if (v->>'row_version')::bigint <> 1 then raise exception 'D3 -- freier Entwurf abgewiesen: %', v; end if;
  perform pg_temp.abgewiesen('D3', v_ws, pg_temp.entwurf('draft-frei-2', null), 0,
                             'Versionskonflikt invoice_draft_slot:draft-frei-1');
  raise notice 'OK  D3 -- ohne Auftrag hoechstens ein Entwurf je Workspace';

  -- Der verworfene Entwurf gibt den Slot frei.
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-abschlag', 'v-s5', 'abschlag', 'Einleitung', true), 1);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-abschlag-2', 'v-s5', 'abschlag'), 0);
  if (v->>'row_version')::bigint <> 1 then raise exception 'D4 -- Slot nach Verwerfen nicht frei: %', v; end if;
  raise notice 'OK  D4 -- ein verworfener Entwurf gibt den Slot frei';
end $$;

/* ------------------------------------------------------------------ */
/* E -- Grabstein „verworfen"                                         */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  r public.workspace_invoice_drafts;
  e jsonb;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  r := pg_temp.zeile(v_ws, 'draft-abschlag');
  if not r.deleted or r.deleted_at is null or r.row_version <> 2 or r.payload->>'id' <> 'draft-abschlag' then
    raise exception 'E1 -- Grabstein falsch: %', to_jsonb(r);
  end if;
  raise notice 'OK  E1 -- Verwerfen hinterlaesst einen Grabstein, der Inhalt bleibt als Nachweis';

  perform pg_temp.abgewiesen('E2', v_ws, pg_temp.entwurf('draft-abschlag', 'v-s5', 'abschlag'), 2,
                             'Versionskonflikt invoice_draft:2');
  perform pg_temp.abgewiesen('E3', v_ws, pg_temp.entwurf('draft-abschlag', 'v-s5', 'abschlag'), 0,
                             'Versionskonflikt invoice_draft:2');
  raise notice 'OK  E2/E3 -- kein Wiederbeleben: weder mit passender Version noch als alter Client mit Version 0';

  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-abschlag', 'v-s5', 'abschlag', 'Einleitung', true), 0);
  if coalesce((v->>'replayed')::boolean, false) is not true or (v->>'row_version')::bigint <> 2 then
    raise exception 'E4 -- doppeltes Verwerfen veraendert: %', v;
  end if;
  raise notice 'OK  E4 -- doppeltes Verwerfen ist eine Wiederholung';

  select x into e from jsonb_array_elements(pg_temp.abzug(v_ws)) x where x->>'client_draft_id' = 'draft-abschlag';
  if e is null or (e->>'deleted')::boolean is not true then
    raise exception 'E5 -- Grabstein reist nicht mit: %', e;
  end if;
  if e ? 'payload' then
    raise exception 'E5 -- Grabstein reist mit Inhalt: %', e;
  end if;
  raise notice 'OK  E5 -- der Grabstein reist im Abzug mit, ohne Inhalt';
end $$;

/* ------------------------------------------------------------------ */
/* F -- Freigabe mit Bindung                                           */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  r public.workspace_invoice_drafts;
  e jsonb;
  vor integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  vor := pg_temp.nummernstand(v_ws);
  r := pg_temp.zeile(v_ws, 'draft-frei-1');
  v := pg_temp.freigabe(v_ws, null, 'inv-f1', 'draft-frei-1', r.row_version);
  if (v->>'idempotent_replay')::boolean or v->'row'->>'client_invoice_id' <> 'inv-f1' then
    raise exception 'F1 -- Freigabe falsch: %', v;
  end if;
  r := pg_temp.zeile(v_ws, 'draft-frei-1');
  if r.status <> 'finalized' or r.finalized_client_invoice_id <> 'inv-f1' or r.row_version <> 2 or r.deleted then
    raise exception 'F1 -- Entwurf nicht verbraucht: %', to_jsonb(r);
  end if;
  if pg_temp.nummernstand(v_ws) <> vor + 1 then
    raise exception 'F1 -- Nummernkreis falsch: % -> %', vor, pg_temp.nummernstand(v_ws);
  end if;
  raise notice 'OK  F1 -- Rechnung angelegt und Entwurf in derselben Transaktion finalisiert';

  perform pg_temp.abgewiesen('F2 aendern', v_ws, pg_temp.entwurf('draft-frei-1', null, 'rechnung', 'spaeter'), 2,
                             'Versionskonflikt invoice_draft:2');
  perform pg_temp.abgewiesen('F2 verwerfen', v_ws, pg_temp.entwurf('draft-frei-1', null, 'rechnung', 'Einleitung', true), 2,
                             'Versionskonflikt invoice_draft:2');
  perform pg_temp.abgewiesen('F2 alter Client', v_ws, pg_temp.entwurf('draft-frei-1', null), 0,
                             'Versionskonflikt invoice_draft:2');
  raise notice 'OK  F2 -- ein finalisierter Entwurf wird weder geaendert, verworfen noch wiederbelebt';

  select x into e from jsonb_array_elements(pg_temp.abzug(v_ws)) x where x->>'client_draft_id' = 'draft-frei-1';
  if e->>'status' <> 'finalized' or e->>'finalized_client_invoice_id' <> 'inv-f1' or e ? 'payload' then
    raise exception 'F3 -- Abzug zeigt den Abschluss nicht: %', e;
  end if;
  raise notice 'OK  F3 -- der Abzug traegt Status und Rechnungskennung, ohne Inhalt';

  -- Der freie Slot ist nach der Freigabe wieder frei (Rollover).
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-g', null), 0);
  if (v->>'row_version')::bigint <> 1 then raise exception 'F4 -- Slot nach Freigabe nicht frei: %', v; end if;
  raise notice 'OK  F4 -- nach der Freigabe ist der Slot fuer den naechsten Entwurf frei';
end $$;

/* ------------------------------------------------------------------ */
/* G/H -- Doppelfreigabe A/B und Wiederholung                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  vorbereitet bigint;
  nach_a integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  -- A und B haben denselben Cloud-Entwurf in derselben Version vorbereitet.
  vorbereitet := (pg_temp.zeile(v_ws, 'draft-frei-g')).row_version;

  v := pg_temp.freigabe(v_ws, null, 'inv-geraet-a', 'draft-frei-g', vorbereitet);
  if (v->>'idempotent_replay')::boolean then raise exception 'G1 -- A ist kein Erstlauf: %', v; end if;
  nach_a := pg_temp.nummernstand(v_ws);
  raise notice 'OK  G1 -- Geraet A gewinnt: Rechnung %', v->'row'->>'invoice_number';

  perform pg_temp.freigabe_abgewiesen('G2', v_ws, null, 'inv-geraet-b', 'draft-frei-g', vorbereitet,
                                      'invoice_draft_already_finalized:inv-geraet-a');
  perform pg_temp.freigabe_abgewiesen('G2 neue Version', v_ws, null, 'inv-geraet-b', 'draft-frei-g', vorbereitet + 1,
                                      'invoice_draft_already_finalized:inv-geraet-a');
  if pg_temp.rechnungen(v_ws, array['inv-geraet-a', 'inv-geraet-b']) <> 1 then
    raise exception 'G3 -- nicht genau eine Rechnung';
  end if;
  if pg_temp.nummernstand(v_ws) <> nach_a then
    raise exception 'G3 -- Geraet B hat eine Nummer verbraucht: % -> %', nach_a, pg_temp.nummernstand(v_ws);
  end if;
  if (pg_temp.zeile(v_ws, 'draft-frei-g')).finalized_client_invoice_id <> 'inv-geraet-a' then
    raise exception 'G3 -- Entwurf zeigt nicht auf die Rechnung von A';
  end if;
  raise notice 'OK  G2/G3 -- Geraet B: keine zweite Rechnung, keine zweite Nummer, Aufloesung auf inv-geraet-a';

  v := pg_temp.freigabe(v_ws, null, 'inv-geraet-a', 'draft-frei-g', vorbereitet);
  if not (v->>'idempotent_replay')::boolean or v->'row'->>'client_invoice_id' <> 'inv-geraet-a' then
    raise exception 'H1 -- Wiederholung von A nicht idempotent: %', v;
  end if;
  if pg_temp.nummernstand(v_ws) <> nach_a or pg_temp.rechnungen(v_ws, array['inv-geraet-a']) <> 1 then
    raise exception 'H1 -- Wiederholung hat geschrieben';
  end if;
  raise notice 'OK  H1 -- Wiederholung derselben clientInvoiceId: derselbe Erfolg, nichts Neues';
end $$;

/* ------------------------------------------------------------------ */
/* I/J/K -- Ablehnungen vor jedem Schreiben                            */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  vor integer;
  r public.workspace_invoice_drafts;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-i', null), 0);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-i', null, 'rechnung', 'anderes Geraet'), 1);
  vor := pg_temp.nummernstand(v_ws);

  perform pg_temp.freigabe_abgewiesen('I1', v_ws, null, 'inv-i', 'draft-frei-i', 1,
                                      'invoice_draft_version_conflict:2');
  r := pg_temp.zeile(v_ws, 'draft-frei-i');
  if pg_temp.rechnungen(v_ws, array['inv-i']) <> 0 or pg_temp.nummernstand(v_ws) <> vor
     or r.status <> 'active' or r.row_version <> 2 then
    raise exception 'I1 -- Versionsabweichung hat geschrieben: %', to_jsonb(r);
  end if;
  raise notice 'OK  I1 -- veraltete Entwurfsversion: keine Rechnung, keine Nummer, Entwurf unveraendert aktiv';

  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-i', null, 'rechnung', 'anderes Geraet', true), 2);
  perform pg_temp.freigabe_abgewiesen('J1', v_ws, null, 'inv-j', 'draft-frei-i', 3, 'invoice_draft_discarded');
  if pg_temp.rechnungen(v_ws, array['inv-j']) <> 0 or pg_temp.nummernstand(v_ws) <> vor then
    raise exception 'J1 -- verworfener Entwurf wurde zur Rechnung';
  end if;
  raise notice 'OK  J1 -- ein verworfener Entwurf wird keine Rechnung';

  perform pg_temp.freigabe_abgewiesen('K1 ohne Version', v_ws, null, 'inv-k', 'draft-frei-i', null,
                                      'invoice_draft_binding_invalid');
  perform pg_temp.freigabe_abgewiesen('K1 ohne Kennung', v_ws, null, 'inv-k', null, 3,
                                      'invoice_draft_binding_invalid');
  perform pg_temp.freigabe_abgewiesen('K1 Version 0', v_ws, null, 'inv-k', 'draft-frei-i', 0,
                                      'invoice_draft_binding_invalid');
  perform pg_temp.freigabe_abgewiesen('K1 leere Kennung', v_ws, null, 'inv-k', '  ', 1,
                                      'invoice_draft_binding_invalid');
  perform pg_temp.freigabe_abgewiesen('K2 unbekannt', v_ws, null, 'inv-k', 'gibt-es-nicht', 1,
                                      'invoice_draft_not_found');
  -- draft-a gehoert zum Vorgang v-s5; freigegeben werden soll eine freie Rechnung.
  perform pg_temp.freigabe_abgewiesen('K3 Slot', v_ws, null, 'inv-k', 'draft-a', 2, 'invoice_draft_slot_mismatch');
  if pg_temp.rechnungen(v_ws, array['inv-k']) <> 0 or pg_temp.nummernstand(v_ws) <> vor then
    raise exception 'K -- eine ungueltige Bindung hat geschrieben';
  end if;
  raise notice 'OK  K1-K3 -- unvollstaendige, unbekannte oder slotfremde Bindung: nichts geschrieben';
end $$;

/* ------------------------------------------------------------------ */
/* L -- R1 bleibt die erste Pruefung                                   */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  r public.workspace_invoice_drafts;
  vor integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-l', null), 0);
  vor := pg_temp.nummernstand(v_ws);

  -- Ein Mitglied darf den Entwurf bearbeiten, aber nicht freigeben.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5502'::uuid);
  perform pg_temp.freigabe_abgewiesen('L1', v_ws, null, 'inv-l', 'draft-frei-l', 1, 'finance_forbidden_role');
  -- Auch eine unbekannte Kennung verraet einem Mitglied nichts: R1 antwortet zuerst.
  perform pg_temp.freigabe_abgewiesen('L2', v_ws, null, 'inv-l', 'gibt-es-nicht', 1, 'finance_forbidden_role');
  r := pg_temp.zeile(v_ws, 'draft-frei-l');
  if r.status <> 'active' or r.row_version <> 1 or pg_temp.nummernstand(v_ws) <> vor then
    raise exception 'L -- R1-Ablehnung hat geschrieben: %', to_jsonb(r);
  end if;
  raise notice 'OK  L1/L2 -- R1 bleibt die erste Pruefung, vor jeder Entwurfspruefung';
end $$;

/* ------------------------------------------------------------------ */
/* M -- Rollen und Isolation                                           */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
begin
  -- Mitglied: Vorbereiten und Bearbeiten wie im Produkt.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5502'::uuid);
  v := pg_temp.push(v_ws, pg_temp.entwurf('draft-frei-l', null, 'rechnung', 'vom Mitglied'), 1);
  if (v->>'row_version')::bigint <> 2 then raise exception 'M1 -- Mitglied darf nicht bearbeiten: %', v; end if;
  if jsonb_array_length(pg_temp.abzug(v_ws)) < 5 then raise exception 'M1 -- Mitglied sieht die Entwuerfe nicht'; end if;
  raise notice 'OK  M1 -- jedes aktive Mitglied liest und bearbeitet Entwuerfe (wie Rechnung vorbereiten)';

  -- Fremder Betrieb: weder lesen noch schreiben.
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5503'::uuid);
  perform pg_temp.abgewiesen('M2 schreiben', v_ws, pg_temp.entwurf('draft-fremd', null), 0, 'Kein Zugriff');
  begin
    perform pg_temp.abzug(v_ws);
    raise exception 'M2 -- fremder Abzug NICHT abgewiesen';
  exception when others then
    if position('Kein Zugriff' in sqlerrm) = 0 then raise exception 'M2 -- falsche Abweisung: %', sqlerrm; end if;
  end;
  raise notice 'OK  M2 -- ein fremder Betrieb liest und schreibt nichts';

  perform pg_temp.abmelden();
  perform pg_temp.abgewiesen('M3', v_ws, pg_temp.entwurf('draft-anon', null), 0, 'Nicht angemeldet');
  raise notice 'OK  M3 -- ohne Anmeldung nichts';
end $$;

/* ------------------------------------------------------------------ */
/* N -- RLS bei direktem Zugriff                                       */
/* ------------------------------------------------------------------ */

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d5503'::uuid);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.workspace_invoice_drafts
              where workspace_id = '00000000-0000-0000-0000-00000000d501'::uuid) then
    raise exception 'N1 -- fremder Nutzer liest Entwuerfe des Betriebs direkt';
  end if;
  begin
    insert into public.workspace_invoice_drafts (workspace_id, client_draft_id, invoice_type)
    values ('00000000-0000-0000-0000-00000000d502'::uuid, 'direkt', 'rechnung');
    raise exception 'N2 -- direktes Schreiben NICHT abgewiesen';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK  N1/N2 -- direkt: kein fremdes Lesen, kein Schreiben an der RPC vorbei';
end $$;
reset role;

select pg_temp.anmelden('00000000-0000-0000-0000-0000000d5502'::uuid);
set local role authenticated;
do $$
begin
  if (select count(*) from public.workspace_invoice_drafts
       where workspace_id = '00000000-0000-0000-0000-00000000d501'::uuid) < 5 then
    raise exception 'N3 -- Mitglied liest direkt nicht die Entwuerfe des Betriebs';
  end if;
  begin
    update public.workspace_invoice_drafts set payload = '{}'::jsonb
    where workspace_id = '00000000-0000-0000-0000-00000000d501'::uuid;
    raise exception 'N4 -- direktes Aendern NICHT abgewiesen';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK  N3/N4 -- Mitglied liest direkt, aendert aber nur ueber die RPC';
end $$;
reset role;

/* ------------------------------------------------------------------ */
/* O -- Altbestand ohne Bindung                                        */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  vor integer;
  r public.workspace_invoice_drafts;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  vor := pg_temp.nummernstand(v_ws);
  r := pg_temp.zeile(v_ws, 'draft-frei-l');
  v := public.finalize_workspace_invoice(v_ws, null, 'inv-ohne-bindung', pg_temp.rechnung());
  if (v->>'idempotent_replay')::boolean or pg_temp.nummernstand(v_ws) <> vor + 1 then
    raise exception 'O1 -- Freigabe ohne Bindung veraendert: %', v;
  end if;
  if (pg_temp.zeile(v_ws, 'draft-frei-l')).row_version <> r.row_version
     or (pg_temp.zeile(v_ws, 'draft-frei-l')).status <> 'active' then
    raise exception 'O1 -- Freigabe ohne Bindung hat einen Entwurf beruehrt';
  end if;
  v := public.finalize_workspace_invoice(v_ws, null, 'inv-ohne-bindung', pg_temp.rechnung());
  if not (v->>'idempotent_replay')::boolean then raise exception 'O2 -- Replay ohne Bindung nicht idempotent'; end if;
  raise notice 'OK  O1/O2 -- ohne Bindung bleibt die Freigabe wie bisher (Erstlauf und Replay)';
end $$;

/* ------------------------------------------------------------------ */
/* P -- der Dispatcher ist sonst unveraendert                          */
/* ------------------------------------------------------------------ */

do $$
declare
  v_ws constant uuid := '00000000-0000-0000-0000-00000000d501';
  v jsonb;
  n integer;
begin
  perform pg_temp.anmelden('00000000-0000-0000-0000-0000000d5501'::uuid);
  begin
    perform public.upsert_workspace_sync_entity(v_ws, 'gibt_es_nicht', '{}'::jsonb, 0);
    raise exception 'P1 -- unbekannter Typ NICHT abgewiesen';
  exception when others then
    if position('Unbekannter Entity-Typ' in sqlerrm) = 0 then
      raise exception 'P1 -- falsche Abweisung: %', sqlerrm;
    end if;
  end;

  v := public.upsert_workspace_sync_entity(v_ws, 'knowledge_fact', jsonb_build_object(
         'fact_id', 'knowledge-s5', 'scope', 'company',
         'payload', jsonb_build_object('id', 'knowledge-s5', 'scope', 'company', 'category', 'other',
           'key', 'k', 'value', 'v', 'displayText', 'Wissen', 'sourceType', 'user',
           'confirmedAt', '2026-10-06T08:00:00.000Z', 'createdAt', '2026-10-06T08:00:00.000Z', 'active', true),
         'deleted', false), 0);
  if (v->>'row_version')::bigint <> 1 then raise exception 'P2 -- S3-Zweig veraendert: %', v; end if;

  select count(*) into n from jsonb_object_keys(public.pull_workspace_sync_state(v_ws));
  -- CLOUD-SYNC S6 -- zwei Schluessel mehr (order_drafts, order_amendment_drafts), Migration 20261103120000.
  if n <> 21 then raise exception 'P3 -- Abzug hat % statt 21 Schluessel', n; end if;
  raise notice 'OK  P1-P3 -- unbekannter Typ abgewiesen, S3-Zweig unveraendert, Abzug mit genau einem Schluessel mehr';
end $$;

select 'S5 invoice_drafts: alle Zusicherungen erfuellt';

rollback;
