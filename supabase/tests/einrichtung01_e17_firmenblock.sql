-- EINRICHTUNG-01 / E17 -- Vertragstest Firmenblockpruefung bei der Rechnungsfreigabe (Katalog V3, Vertrag 1.2).
--
--   S-03.2  unbekannter Schluessel im Firmenblock: Abweisung invoice_company_snapshot_invalid:<Schluessel>
--           vor der Nummernvergabe -- kein Nummernverbrauch, keine neue Nummernkreiszeile, keine Rechnung,
--           kein Dokument, kein stilles Bereinigen
--   S-03.4  genau ein zusaetzlicher Pruefaufruf, nach assert_workspace_invoice_integrity und vor der
--           Nummernkreiszeile; Rechte der Funktion unveraendert
--   S-03.5  Replay einer bestaetigten Freigabe: idempotent_replay wie bisher, keine neue Pruefung
--   S-03.6  bestehende Vorpruefungsfehler behalten ihren Vorrang (Fehlerreihenfolge unveraendert)
--   S-03.7  erste Rechnung eines neuen Jahres mit unbekanntem Schluessel: keine Nummernkreiszeile
--   S-03.8  Firmenblock fehlt bzw. JSON null: bisheriges Verhalten; kein Objekt: abgewiesen
--   dazu    gueltiger Firmenblock mit allen Vertragsschluesseln wird freigegeben
--
-- Jede Freigabe laeuft als Rolle authenticated mit den Claims des Inhabers.
-- Ausfuehren (nur lokal):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/einrichtung01_e17_firmenblock.sql
-- Exit-Code 0 = alle Zusicherungen erfuellt. Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       u.email, 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from (values
  ('00000000-0000-0000-0000-0000000e1701'::uuid, 'inhaber-ein01-e17@example.invalid'),
  ('00000000-0000-0000-0000-0000000e1702'::uuid, 'mitglied-ein01-e17@example.invalid')
) as u(id, email);

update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in ('00000000-0000-0000-0000-0000000e1701'::uuid, '00000000-0000-0000-0000-0000000e1702'::uuid);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000e17a1'::uuid, 'EIN01 E17', '00000000-0000-0000-0000-0000000e1701'::uuid);
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000e17a1'::uuid, '00000000-0000-0000-0000-0000000e1701'::uuid, 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000e17a1'::uuid, '00000000-0000-0000-0000-0000000e1702'::uuid, 'member', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000e17a1'::uuid, 'cust-e17', '{"name":"Musterbau GmbH"}'::jsonb);

create function pg_temp.ws() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e17a1'::uuid $p$;
create function pg_temp.inhaber() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e1701'::uuid $p$;
create function pg_temp.mitglied() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e1702'::uuid $p$;

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

/** Ein Firmenblock mit allen 29 Vertragsschluesseln (COMPANY_SNAPSHOT_KEYS). */
create function pg_temp.firmenblock() returns jsonb language sql immutable as $p$
  select '{
    "companyName": "Beispiel Haustechnik", "legalForm": "GmbH", "logoDataUrl": "", "street": "Musterstrasse 5",
    "zip": "33602", "city": "Bielefeld", "country": "Deutschland", "countryCode": "DE", "contactPerson": "A. Beispiel",
    "phone": "0521 000000", "email": "info@example.invalid", "website": "", "taxNumber": "305/123/45678", "vatId": "",
    "registrationAuthority": "", "registrationNumber": "", "bankName": "Beispielbank", "iban": "DE89370400440532013000",
    "bic": "COBADEFFXXX", "accountHolder": "Beispiel Haustechnik GmbH", "defaultPaymentDays": 14,
    "defaultPaymentTerms": "Zahlbar innerhalb von 14 Tagen ohne Abzug.", "defaultSkonto": "", "skontoEnabled": false,
    "skontoPercent": 0, "skontoDays": 0, "managingDirector": "", "taxFreeNotice": "", "invoiceFooterNotes": ""
  }'::jsonb
$p$;

/** Eine gueltige freie Rechnung (wie MANUELLE-RECHNUNG-03F) mit Firmenblock. */
create function pg_temp.beleg(p_overrides jsonb default '{}'::jsonb) returns jsonb language sql as $p$
  select jsonb_build_object(
    'type', 'rechnung',
    'taxStatus', 'standard_19',
    'customerId', 'cust-e17',
    'customerSnapshot', jsonb_build_object('name', 'Musterbau GmbH', 'street', 'Industriestrasse 12', 'zip', '33602', 'city', 'Bielefeld'),
    'issueDate', '2026-09-23',
    'positions', jsonb_build_array(
      jsonb_build_object('id', 'p1', 'description', 'Wartung', 'quantity', 2, 'unit', 'Stunden', 'unitPrice', 80, 'lineTotal', 160),
      jsonb_build_object('id', 'p2', 'description', 'Anfahrt', 'quantity', 1, 'unit', 'Pauschal', 'unitPrice', 40, 'lineTotal', 40)),
    'subtotal', 200,
    'amount', 238,
    'companySnapshot', pg_temp.firmenblock()
  ) || p_overrides
$p$;

create function pg_temp.freigabe(p_user uuid, p_cid text, p_invoice jsonb) returns jsonb language plpgsql as $p$
declare
  r jsonb;
begin
  perform pg_temp.als(p_user);
  r := public.finalize_workspace_invoice(pg_temp.ws(), null, p_cid, p_invoice);
  perform pg_temp.zurueck();
  return r;
end;
$p$;

/** Zaehlerstand: Nummernkreiszeilen, letzte Nummern, Rechnungen, Dokumente des Betriebs. */
create function pg_temp.stand() returns jsonb language sql as $p$
  select jsonb_build_object(
    'sequences', (select coalesce(jsonb_agg(jsonb_build_object('jahr', invoice_year, 'letzte', last_sequence) order by invoice_year), '[]'::jsonb)
                  from public.workspace_invoice_sequences where workspace_id = pg_temp.ws()),
    'rechnungen', (select count(*) from public.workspace_invoices where workspace_id = pg_temp.ws()),
    'dokumente', (select count(*) from public.workspace_documents where workspace_id = pg_temp.ws())
  )
$p$;

/** Erwartet eine Abweisung mit diesem Text; der Zaehlerstand bleibt unveraendert. */
create function pg_temp.erwarte_abweisung(p_label text, p_user uuid, p_cid text, p_invoice jsonb, p_text text, p_code text default null)
returns void language plpgsql as $p$
declare
  v_vorher jsonb := pg_temp.stand();
begin
  begin
    perform pg_temp.freigabe(p_user, p_cid, p_invoice);
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    if p_code is not null and sqlstate <> p_code then
      raise exception '% -- falscher Fehlercode: % (erwartet: %)', p_label, sqlstate, p_code;
    end if;
    if pg_temp.stand() is distinct from v_vorher then
      raise exception '% -- abgewiesen, aber Zaehlerstand veraendert: % -> %', p_label, v_vorher, pg_temp.stand();
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

/* ------------------------------------------------------------------ */
/* S-03.4 Einbaustelle und Rechte                                      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_src text;
  v_aufruf integer;
  v_integritaet integer;
  v_nummernkreis integer;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_workspace_invoice';
  if (length(v_src) - length(replace(v_src, 'assert_workspace_invoice_company_snapshot(', ''))) / length('assert_workspace_invoice_company_snapshot(') <> 1 then
    raise exception 'S-03.4 nicht genau ein Pruefaufruf';
  end if;
  v_aufruf := position('perform public.assert_workspace_invoice_company_snapshot(p_invoice);' in v_src);
  v_integritaet := position('perform public.assert_workspace_invoice_integrity(' in v_src);
  v_nummernkreis := position('insert into public.workspace_invoice_sequences' in v_src);
  if not (v_integritaet > 0 and v_integritaet < v_aufruf and v_aufruf < v_nummernkreis) then
    raise exception 'S-03.4 Einbaustelle falsch: Integritaet %, Aufruf %, Nummernkreis %', v_integritaet, v_aufruf, v_nummernkreis;
  end if;
  if position('format_workspace_invoice_number' in v_src) < v_aufruf then
    raise exception 'S-03.4 Nummernvergabe vor der Pruefung';
  end if;
  if not has_function_privilege('authenticated', 'public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean, text, bigint)', 'execute')
     or not has_function_privilege('service_role', 'public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean, text, bigint)', 'execute')
     or has_function_privilege('anon', 'public.finalize_workspace_invoice(uuid, text, text, jsonb, boolean, text, bigint)', 'execute') then
    raise exception 'S-03.4 Rechte der Freigabefunktion veraendert';
  end if;
  if has_function_privilege('authenticated', 'public.assert_workspace_invoice_company_snapshot(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.assert_workspace_invoice_company_snapshot(jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.assert_workspace_invoice_company_snapshot(jsonb)', 'execute') then
    raise exception 'S-03.4 der Pruefhelfer darf fuer keine Client-Rolle ausfuehrbar sein';
  end if;
  raise notice 'OK  S-03.4 genau ein Pruefaufruf nach der Integritaetspruefung und vor Nummernkreis und Nummer; Rechte unveraendert';
end $$;

/* ------------------------------------------------------------------ */
/* Gueltig, S-03.2, S-03.5                                             */
/* ------------------------------------------------------------------ */

do $$
declare
  r jsonb;
begin
  r := pg_temp.freigabe(pg_temp.inhaber(), 'e17-gueltig', pg_temp.beleg());
  if (r->>'idempotent_replay')::boolean or nullif(r->'row'->>'invoice_number', '') is null then
    raise exception 'gueltiger Firmenblock nicht freigegeben: %', r;
  end if;
  if r->'invoice'->'companySnapshot' is distinct from pg_temp.firmenblock() then
    raise exception 'Firmenblock beim Freigeben veraendert';
  end if;
  raise notice 'OK  Firmenblock mit allen 29 Vertragsschluesseln: freigegeben als %', r->'row'->>'invoice_number';
end $$;

do $$
declare
  v_schluessel text;
begin
  foreach v_schluessel in array array['emailSignature', 'defaultOfferEmailSubject', 'senderDisplayName', 'replyToEmail', 'branding', 'zzUnbekannt'] loop
    perform pg_temp.erwarte_abweisung('S-03.2 ' || v_schluessel, pg_temp.inhaber(), 'e17-' || v_schluessel,
      pg_temp.beleg(jsonb_build_object('companySnapshot', pg_temp.firmenblock() || jsonb_build_object(v_schluessel, 'x'))),
      'invoice_company_snapshot_invalid:' || v_schluessel, 'P0001');
  end loop;
  -- Bei mehreren unbekannten Schluesseln nennt die Meldung den alphabetisch ersten.
  perform pg_temp.erwarte_abweisung('S-03.2 mehrere', pg_temp.inhaber(), 'e17-mehrere',
    pg_temp.beleg(jsonb_build_object('companySnapshot', pg_temp.firmenblock() || '{"zz": 1, "emailSignature": "x"}'::jsonb)),
    'invoice_company_snapshot_invalid:emailSignature', 'P0001');
  if exists (select 1 from public.workspace_invoices where workspace_id = pg_temp.ws() and client_invoice_id like 'e17-%' and client_invoice_id <> 'e17-gueltig') then
    raise exception 'S-03.2 abgewiesene Rechnung angelegt';
  end if;
  raise notice 'OK  S-03.2 unbekannte Schluessel abgewiesen vor der Nummernvergabe: keine Nummer, keine Zeile, keine Rechnung, kein Dokument';
end $$;

do $$
declare
  v_vorher jsonb := pg_temp.stand();
  r jsonb;
begin
  r := pg_temp.freigabe(pg_temp.inhaber(), 'e17-gueltig', pg_temp.beleg());
  if not (r->>'idempotent_replay')::boolean then raise exception 'S-03.5 kein Replay: %', r; end if;
  if pg_temp.stand() is distinct from v_vorher then raise exception 'S-03.5 Replay hat den Stand veraendert'; end if;

  -- Eine vor E17 freigegebene Rechnung mit Altschluessel: der Replay laeuft wie bisher, ohne neue Pruefung.
  update public.workspace_invoices
  set payload = jsonb_set(payload, '{companySnapshot,emailSignature}', '"Altbestand"', true)
  where workspace_id = pg_temp.ws() and client_invoice_id = 'e17-gueltig';
  r := pg_temp.freigabe(pg_temp.inhaber(), 'e17-gueltig',
    pg_temp.beleg(jsonb_build_object('companySnapshot', pg_temp.firmenblock() || '{"emailSignature": "Altbestand"}'::jsonb)));
  if not (r->>'idempotent_replay')::boolean then raise exception 'S-03.5 Altbestand-Replay abgewiesen: %', r; end if;
  if pg_temp.stand() is distinct from v_vorher then raise exception 'S-03.5 Altbestand-Replay hat den Stand veraendert'; end if;
  raise notice 'OK  S-03.5 Replay wie bisher (idempotent_replay), keine neue Nummer und keine neue Pruefung';
end $$;

/* ------------------------------------------------------------------ */
/* S-03.6 Fehlerreihenfolge, S-03.7 neues Jahr, S-03.8 Grenzfaelle      */
/* ------------------------------------------------------------------ */

do $$
declare
  v_unbekannt jsonb := jsonb_build_object('companySnapshot', pg_temp.firmenblock() || '{"emailSignature": "x"}'::jsonb);
begin
  -- Integritaetspruefung (unmittelbar davor): ihr Fehler gewinnt.
  perform pg_temp.erwarte_abweisung('S-03.6 Integritaet zuerst', pg_temp.inhaber(), 'e17-s36a',
    pg_temp.beleg('{"positions": [], "subtotal": 0, "amount": 0}'::jsonb || v_unbekannt), 'invoice_positions_missing');
  -- Summenfehler aus der Integritaetspruefung.
  perform pg_temp.erwarte_abweisung('S-03.6 Summenfehler zuerst', pg_temp.inhaber(), 'e17-s36b',
    pg_temp.beleg('{"amount": 999}'::jsonb || v_unbekannt), 'invoice_totals_mismatch');
  -- Rollenpruefung (Finanzaktion) ganz am Anfang.
  perform pg_temp.erwarte_abweisung('S-03.6 Rolle zuerst', pg_temp.mitglied(), 'e17-s36c', pg_temp.beleg(v_unbekannt), 'finance_forbidden_role', null);
  -- Idempotenzkonflikt einer bestehenden client_invoice_id mit abweichendem Inhalt.
  perform pg_temp.erwarte_abweisung('S-03.6 Idempotenzkonflikt zuerst', pg_temp.inhaber(), 'e17-gueltig',
    pg_temp.beleg('{"issueDate": "2026-09-24"}'::jsonb || v_unbekannt), 'Idempotenzkonflikt');
  raise notice 'OK  S-03.6 bestehende Vorpruefungen behalten ihren Vorrang (Integritaet, Summen, Rolle, Idempotenz)';
end $$;

do $$
begin
  perform pg_temp.erwarte_abweisung('S-03.7 erstes Jahr ohne Nummernkreis', pg_temp.inhaber(), 'e17-2025',
    pg_temp.beleg(jsonb_build_object('issueDate', '2025-06-02',
      'companySnapshot', pg_temp.firmenblock() || '{"defaultLetterEmailBody": "x"}'::jsonb)),
    'invoice_company_snapshot_invalid:defaultLetterEmailBody', 'P0001');
  if exists (select 1 from public.workspace_invoice_sequences where workspace_id = pg_temp.ws() and invoice_year = 2025) then
    raise exception 'S-03.7 Nummernkreiszeile fuer 2025 angelegt';
  end if;
  -- Gegenprobe: dieselbe Rechnung ohne den Schluessel legt die Zeile an (das Jahr ist zulaessig).
  perform pg_temp.freigabe(pg_temp.inhaber(), 'e17-2025-ok', pg_temp.beleg('{"issueDate": "2025-06-02"}'::jsonb));
  if not exists (select 1 from public.workspace_invoice_sequences where workspace_id = pg_temp.ws() and invoice_year = 2025) then
    raise exception 'S-03.7 Gegenprobe: Jahr 2025 nicht angelegt';
  end if;
  raise notice 'OK  S-03.7 erste Rechnung eines Jahres ohne Nummernkreiszeile abgewiesen, keine Zeile angelegt (Gegenprobe ohne Schluessel legt sie an)';
end $$;

do $$
declare
  r jsonb;
begin
  r := pg_temp.freigabe(pg_temp.inhaber(), 'e17-ohne-block', pg_temp.beleg() - 'companySnapshot');
  if (r->>'idempotent_replay')::boolean or nullif(r->'row'->>'invoice_number', '') is null then
    raise exception 'S-03.8 ohne Firmenblock nicht wie bisher freigegeben: %', r;
  end if;
  r := pg_temp.freigabe(pg_temp.inhaber(), 'e17-block-null', pg_temp.beleg('{"companySnapshot": null}'::jsonb));
  if nullif(r->'row'->>'invoice_number', '') is null then
    raise exception 'S-03.8 Firmenblock null nicht wie bisher freigegeben: %', r;
  end if;
  perform pg_temp.erwarte_abweisung('S-03.8 Text', pg_temp.inhaber(), 'e17-block-text',
    pg_temp.beleg('{"companySnapshot": "Beispiel"}'::jsonb), 'invoice_company_snapshot_invalid:companySnapshot', 'P0001');
  perform pg_temp.erwarte_abweisung('S-03.8 Liste', pg_temp.inhaber(), 'e17-block-liste',
    pg_temp.beleg('{"companySnapshot": []}'::jsonb), 'invoice_company_snapshot_invalid:companySnapshot', 'P0001');
  raise notice 'OK  S-03.8 fehlender Firmenblock wie bisher; kein Objekt wird abgewiesen';
end $$;

rollback;
