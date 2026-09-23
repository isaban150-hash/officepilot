-- MANUELLE-RECHNUNG-03F — Laufzeittest der Serverintegritaet fuer die
-- Rechnung ohne Auftrag.
--
-- Prueft die **reale** SQL-Semantik gegen eine lokale Datenbank, nicht den
-- Migrationstext. Der Kontrollfall ist derselbe wie in der sichtbaren Abnahme:
--
--   Wartung   2 Stunden  x 80,00 EUR = 160,00 EUR
--   Anfahrt   1 Pauschal x 40,00 EUR =  40,00 EUR
--   Netto 200,00 EUR — bei 19 % : 38,00 Steuer, 238,00 gesamt
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/manual_invoice_integrity_03f.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000f03f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'integrity-03f@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

-- Zwei Workspaces: der eigene und ein fremder, um die Kundenbindung zu pruefen.
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000f001', 'Integritaet-03F', '00000000-0000-0000-0000-00000000f03f'),
       ('00000000-0000-0000-0000-00000000f002', 'Fremder Betrieb', '00000000-0000-0000-0000-00000000f03f');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f03f', 'owner', 'active'),
       ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000f03f', 'owner', 'active');

insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-00000000f001', 'cust-az', '{"name":"AZ Testbau GmbH"}'::jsonb),
       ('00000000-0000-0000-0000-00000000f002', 'cust-fremd', '{"name":"Fremdkunde GmbH"}'::jsonb);
insert into public.workspace_customers (workspace_id, customer_id, payload, deleted)
values ('00000000-0000-0000-0000-00000000f001', 'cust-geloescht', '{"name":"Ex-Kunde GmbH"}'::jsonb, true);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000f03f","role":"authenticated"}', true);

/* ------------------------------------------------------------------ */
/* Hilfen — temporaer, fallen mit dem Rollback weg.                    */
/* ------------------------------------------------------------------ */

-- Eine gueltige freie Rechnung; einzelne Felder koennen ueberschrieben werden.
create function pg_temp.beleg(p_overrides jsonb default '{}'::jsonb)
returns jsonb language sql as $p$
  select '{
    "type": "rechnung",
    "taxStatus": "standard_19",
    "customerId": "cust-az",
    "customerSnapshot": {"name": "AZ Testbau GmbH", "street": "Industriestrasse 12", "zip": "33602", "city": "Bielefeld"},
    "issueDate": "2026-09-23",
    "positions": [
      {"id":"p1","description":"Wartung","quantity":2,"unit":"Stunden","unitPrice":80,"lineTotal":160},
      {"id":"p2","description":"Anfahrt","quantity":1,"unit":"Pauschal","unitPrice":40,"lineTotal":40}
    ],
    "subtotal": 200,
    "amount": 238
  }'::jsonb || p_overrides;
$p$;

create function pg_temp.erwarte_fehler(p_label text, p_vorgang text, p_cid text, p_invoice jsonb, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000f001', p_vorgang, p_cid, p_invoice);
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% — falscher Fehler: % (erwartet: %)', p_label, sqlerrm, p_expected;
    end if;
    raise notice 'OK  %: %', p_label, p_expected;
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

create function pg_temp.erwarte_erfolg(p_label text, p_cid text, p_invoice jsonb, p_netto numeric, p_brutto numeric)
returns void language plpgsql as $p$
declare r jsonb;
begin
  r := public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000f001', null, p_cid, p_invoice);
  if (r->>'idempotent_replay')::boolean then
    raise exception '% — unerwarteter Replay', p_label;
  end if;
  if r->'row'->>'vorgang_id' is not null then
    raise exception '% — Rechnung haengt an einem Vorgang: %', p_label, r->'row'->>'vorgang_id';
  end if;
  if nullif(trim(coalesce(r->'row'->>'invoice_number', '')), '') is null then
    raise exception '% — keine Rechnungsnummer', p_label;
  end if;
  if round((r->'invoice'->>'subtotal')::numeric, 2) is distinct from p_netto
     or round((r->'invoice'->>'amount')::numeric, 2) is distinct from p_brutto then
    raise exception '% — Summen falsch: netto % / brutto %', p_label,
      r->'invoice'->>'subtotal', r->'invoice'->>'amount';
  end if;
  raise notice 'OK  %: % (netto %, brutto %)', p_label, r->'row'->>'invoice_number', p_netto, p_brutto;
end;
$p$;

/* ------------------------------------------------------------------ */
do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000f001';
  r jsonb;
  n_vorher integer;
  n_nachher integer;
  nummer text;
begin
  /* ============ A — gueltige freie Rechnungen ============ */

  -- 1: 19 % Regelbesteuerung
  perform pg_temp.erwarte_erfolg('T1 freie Rechnung 19 %', 'f-19', pg_temp.beleg(), 200.00, 238.00);

  -- 2: §13b Reverse Charge — Steuer 0
  perform pg_temp.erwarte_erfolg('T2 freie Rechnung §13b', 'f-13b',
    pg_temp.beleg('{"taxStatus":"reverse_charge_13b","amount":200}'::jsonb), 200.00, 200.00);

  -- 3: Kleinunternehmer — Steuer 0
  perform pg_temp.erwarte_erfolg('T3 freie Rechnung §19', 'f-klein',
    pg_temp.beleg('{"taxStatus":"kleinunternehmer_19","amount":200}'::jsonb), 200.00, 200.00);

  /* ============ B — Positionen ============ */

  -- 4: keine Positionen
  perform pg_temp.erwarte_fehler('T4 positions = []', null, 'x-leer',
    pg_temp.beleg('{"positions":[],"subtotal":0,"amount":0}'::jsonb), 'invoice_positions_missing');

  -- 5: Beschreibung leer
  perform pg_temp.erwarte_fehler('T5 Beschreibung leer', null, 'x-desc',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"   ","quantity":2,"unit":"Stunden","unitPrice":80,"lineTotal":160}],"subtotal":160,"amount":190.4}'::jsonb),
    'invoice_position_description_missing');

  -- 6: Menge 0
  perform pg_temp.erwarte_fehler('T6 quantity = 0', null, 'x-q0',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Wartung","quantity":0,"unit":"Stunden","unitPrice":80,"lineTotal":0}],"subtotal":0,"amount":0}'::jsonb),
    'invoice_quantity_invalid');

  -- 7: Menge negativ
  perform pg_temp.erwarte_fehler('T7 quantity < 0', null, 'x-qneg',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Wartung","quantity":-2,"unit":"Stunden","unitPrice":80,"lineTotal":-160}],"subtotal":-160,"amount":-190.4}'::jsonb),
    'invoice_quantity_invalid');

  -- 7b: Menge als Text statt Zahl — der real erreichbare Manipulationsfall,
  -- weil JSON kein NaN/Infinity kennt.
  perform pg_temp.erwarte_fehler('T7b quantity als Text', null, 'x-qtext',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Wartung","quantity":"2","unit":"Stunden","unitPrice":80,"lineTotal":160}],"subtotal":160,"amount":190.4}'::jsonb),
    'invoice_quantity_invalid');

  -- 8: Einzelpreis negativ
  perform pg_temp.erwarte_fehler('T8 unitPrice < 0', null, 'x-pneg',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Wartung","quantity":2,"unit":"Stunden","unitPrice":-80,"lineTotal":-160}],"subtotal":-160,"amount":-190.4}'::jsonb),
    'invoice_position_mismatch');

  -- 8b: Einzelpreis 0 ist erlaubt — kostenlose Zeile, wie im Auftragsweg.
  perform pg_temp.erwarte_erfolg('T8b unitPrice = 0 erlaubt', 'f-frei0',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Kulanz","quantity":1,"unit":"Pauschal","unitPrice":0,"lineTotal":0}],"subtotal":0,"amount":0}'::jsonb),
    0.00, 0.00);

  -- 9: unbekannte Einheit
  perform pg_temp.erwarte_fehler('T9 unbekannte Einheit', null, 'x-unit',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Wartung","quantity":2,"unit":"Fuhre","unitPrice":80,"lineTotal":160}],"subtotal":160,"amount":190.4}'::jsonb),
    'invoice_position_unit_invalid');

  -- 9b: Zeilenbetrag passt nicht zu Menge x Preis
  perform pg_temp.erwarte_fehler('T9b lineTotal manipuliert', null, 'x-line',
    pg_temp.beleg('{"positions":[{"id":"p1","description":"Wartung","quantity":2,"unit":"Stunden","unitPrice":80,"lineTotal":999}],"subtotal":160,"amount":190.4}'::jsonb),
    'invoice_totals_mismatch');

  /* ============ C — Summen und Steuer ============ */

  -- 10: Zwischensumme manipuliert
  perform pg_temp.erwarte_fehler('T10 subtotal manipuliert', null, 'x-sub',
    pg_temp.beleg('{"subtotal":100}'::jsonb), 'invoice_totals_mismatch');

  -- 11: Steuerbetrag manipuliert. `VorgangInvoice` traegt kein eigenes
  -- `taxAmount`; die Steuer ist die Differenz amount - subtotal. Ein falscher
  -- Steuerbetrag ist deshalb genau ein falscher `amount` bei richtigem `subtotal`.
  perform pg_temp.erwarte_fehler('T11 Steuerbetrag manipuliert', null, 'x-tax',
    pg_temp.beleg('{"amount":200}'::jsonb), 'invoice_totals_mismatch');

  -- 11b: Steuersatz gewechselt, Betraege stehen gelassen
  perform pg_temp.erwarte_fehler('T11b Steuersatz gewechselt', null, 'x-rate',
    pg_temp.beleg('{"taxStatus":"standard_7"}'::jsonb), 'invoice_totals_mismatch');

  -- 12: Gesamtbetrag manipuliert
  perform pg_temp.erwarte_fehler('T12 amount manipuliert', null, 'x-amt',
    pg_temp.beleg('{"amount":23.8}'::jsonb), 'invoice_totals_mismatch');

  -- 13: ungueltiger Steuerstatus
  perform pg_temp.erwarte_fehler('T13 taxStatus unbekannt', null, 'x-status',
    pg_temp.beleg('{"taxStatus":"phantasie"}'::jsonb), 'invoice_tax_status_invalid');

  -- 13b (03F2): "noch unklar" ist keine Steuerentscheidung. Ohne Auftrag gibt
  -- es keinen Auftrag, von dem sie geerbt werden koennte.
  perform pg_temp.erwarte_fehler('T13b taxStatus unclear', null, 'x-unclear',
    pg_temp.beleg('{"taxStatus":"unclear","amount":200}'::jsonb), 'invoice_tax_status_invalid');

  -- 13c: Die uebrigen bewussten Entscheidungen bleiben zulaessig.
  perform pg_temp.erwarte_erfolg('T13c tax_free bleibt erlaubt', 'f-frei',
    pg_temp.beleg('{"taxStatus":"tax_free","amount":200}'::jsonb), 200.00, 200.00);
  perform pg_temp.erwarte_erfolg('T13d 7 % bleibt erlaubt', 'f-sieben',
    pg_temp.beleg('{"taxStatus":"standard_7","amount":214}'::jsonb), 200.00, 214.00);

  /* ============ D — Kundenintegritaet ============ */

  -- 14: Kunde eines fremden Workspace
  perform pg_temp.erwarte_fehler('T14 fremde customerId', null, 'x-fremd',
    pg_temp.beleg('{"customerId":"cust-fremd"}'::jsonb), 'invoice_customer_mismatch');

  -- 14b: geloeschter Kunde
  perform pg_temp.erwarte_fehler('T14b geloeschte customerId', null, 'x-weg',
    pg_temp.beleg('{"customerId":"cust-geloescht"}'::jsonb), 'invoice_customer_mismatch');

  -- 14c: customerId fehlt ganz
  perform pg_temp.erwarte_fehler('T14c customerId fehlt', null, 'x-ohneid',
    pg_temp.beleg() - 'customerId', 'invoice_customer_mismatch');

  -- 15: Empfaenger ohne Namen — der Beleg haette keinen Adressaten
  perform pg_temp.erwarte_fehler('T15 Empfaengername leer', null, 'x-noname',
    pg_temp.beleg('{"customerSnapshot":{"name":"  ","street":"Industriestrasse 12","zip":"33602","city":"Bielefeld"}}'::jsonb),
    'invoice_customer_mismatch');

  /* ============ D2 (03F2) — Mindestfelder der Rechnungsanschrift ============ */

  -- Die Oberflaeche blockiert denselben Zustand ueber `hasUsableAddress`;
  -- ein direkter RPC-Aufruf darf daran nicht vorbeikommen.
  perform pg_temp.erwarte_fehler('T15c Strasse fehlt', null, 'x-nostreet',
    pg_temp.beleg('{"customerSnapshot":{"name":"AZ Testbau GmbH","zip":"33602","city":"Bielefeld"}}'::jsonb),
    'invoice_customer_address_incomplete');
  perform pg_temp.erwarte_fehler('T15d PLZ fehlt', null, 'x-nozip',
    pg_temp.beleg('{"customerSnapshot":{"name":"AZ Testbau GmbH","street":"Industriestrasse 12","city":"Bielefeld"}}'::jsonb),
    'invoice_customer_address_incomplete');
  perform pg_temp.erwarte_fehler('T15e Ort fehlt', null, 'x-nocity',
    pg_temp.beleg('{"customerSnapshot":{"name":"AZ Testbau GmbH","street":"Industriestrasse 12","zip":"33602"}}'::jsonb),
    'invoice_customer_address_incomplete');
  perform pg_temp.erwarte_fehler('T15f Anschrift nur aus Leerzeichen', null, 'x-blank',
    pg_temp.beleg('{"customerSnapshot":{"name":"AZ Testbau GmbH","street":"  ","zip":"  ","city":"  "}}'::jsonb),
    'invoice_customer_address_incomplete');

  -- Ein Land wird bewusst nicht verlangt — die Clientregel verlangt es auch nicht.
  perform pg_temp.erwarte_erfolg('T15g ohne Land weiterhin erlaubt', 'f-ohneland', pg_temp.beleg(), 200.00, 238.00);

  -- 15b: Der eingefrorene Snapshot darf bewusst vom Stammsatz abweichen.
  -- Das ist Belegwahrheit, kein Angriff — und muss erlaubt bleiben.
  perform pg_temp.erwarte_erfolg('T15b abweichender Snapshot erlaubt', 'f-snap',
    pg_temp.beleg('{"customerSnapshot":{"name":"AZ Testbau GmbH, Niederlassung Nord","street":"Andere Strasse 9","zip":"32052","city":"Herford"}}'::jsonb),
    200.00, 238.00);

  /* ============ E — Typen ohne Auftrag ============ */

  -- 16/17/18: unveraendert verboten
  perform pg_temp.erwarte_fehler('T16 teilrechnung ohne Auftrag', null, 'x-teil',
    pg_temp.beleg('{"type":"teilrechnung"}'::jsonb), 'invoice_requires_vorgang_for_type');
  perform pg_temp.erwarte_fehler('T17 abschlag ohne Auftrag', null, 'x-ab',
    pg_temp.beleg('{"type":"abschlag"}'::jsonb), 'invoice_requires_vorgang_for_type');
  perform pg_temp.erwarte_fehler('T18 schluss ohne Auftrag', null, 'x-schluss',
    pg_temp.beleg('{"type":"schluss"}'::jsonb), 'invoice_requires_vorgang_for_type');

  /* ============ F — Nummernkreis und Idempotenz ============ */

  -- 19: Ein abgelehnter Versuch darf keine Rechnungsnummer verbrauchen.
  select last_sequence into n_vorher
  from public.workspace_invoice_sequences
  where workspace_id = ws and invoice_year = 2026;

  perform pg_temp.erwarte_fehler('T19 Vorbereitung: abgelehnter Versuch', null, 'f-retry',
    pg_temp.beleg('{"amount":1}'::jsonb), 'invoice_totals_mismatch');

  select last_sequence into n_nachher
  from public.workspace_invoice_sequences
  where workspace_id = ws and invoice_year = 2026;

  if n_vorher is distinct from n_nachher then
    raise exception 'T19 — der abgelehnte Versuch hat eine Nummer verbraucht: % -> %', n_vorher, n_nachher;
  end if;
  raise notice 'OK  T19: abgelehnter Versuch verbraucht keine Nummer (Stand %)', n_nachher;

  -- 20: Derselbe Entwurf, korrigiert, mit derselben client_invoice_id.
  r := public.finalize_workspace_invoice(ws, null, 'f-retry', pg_temp.beleg());
  if (r->>'idempotent_replay')::boolean then
    raise exception 'T20 — der korrigierte Versuch galt als Replay';
  end if;
  nummer := r->'row'->>'invoice_number';
  if nummer is null then raise exception 'T20 — keine Rechnungsnummer'; end if;
  raise notice 'OK  T20: korrigierter Retry erfolgreich (%)', nummer;

  -- 21: Bestehende Idempotenz unveraendert — bytegleicher zweiter Aufruf.
  r := public.finalize_workspace_invoice(ws, null, 'f-retry', pg_temp.beleg());
  if not (r->>'idempotent_replay')::boolean then
    raise exception 'T21 — identischer Aufruf war kein Replay';
  end if;
  if r->'row'->>'invoice_number' is distinct from nummer then
    raise exception 'T21 — der Replay hat eine neue Nummer vergeben';
  end if;
  raise notice 'OK  T21: identischer Aufruf bleibt idempotent, Nummer %', nummer;

  -- 21b: Abweichender Inhalt unter derselben Kennung bleibt ein Konflikt.
  perform pg_temp.erwarte_fehler('T21b abweichender Inhalt', null, 'f-retry',
    pg_temp.beleg('{"issueDate":"2026-09-24"}'::jsonb), 'abweichender Rechnungsinhalt');

  -- 22: Die freie Rechnung bleibt stornierbar — kein Mengenbezug.
  perform public.cancel_workspace_invoice(ws, 'f-retry', 'Teststorno 03F');
  if not exists (
    select 1 from public.workspace_invoices
    where workspace_id = ws and client_invoice_id = 'f-retry'
      and vorgang_id is null and cancelled_at is not null
  ) then
    raise exception 'T22 — freie Rechnung wurde nicht storniert';
  end if;
  raise notice 'OK  T22: freie Rechnung storniert, weiterhin ohne Vorgangsbezug';

  raise notice '--- 03F: alle Zusicherungen erfuellt ---';
end;
$$;

rollback;
