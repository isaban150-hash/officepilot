-- MANUAL-INVOICE-CLOUD-MIGRATION-01B2b-R1/R2 — Laufzeit-Regressionstest fuer
-- den Idempotenz-Replay von finalize_workspace_invoice.
--
-- Prueft die **reale** SQL-Semantik gegen eine lokale Datenbank, nicht den
-- Migrationstext. Vitest kann das nicht; deshalb liegt der Test hier.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   npx --yes supabase@latest db reset --local
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/manual_invoice_replay_01b2b.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Jede Abweichung wirft eine
-- Exception und bricht ab. Synthetischer Nutzer, keine Zugangsdaten, alles
-- wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'replay-test@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000000ff', 'Replay-Test', '00000000-0000-0000-0000-00000000aaaa');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000aaaa', 'owner', 'active');
insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-0000000000ff', 'v-1', '{}'::jsonb);
-- 03F2: Der Empfaenger der freien Rechnungen. Seit 03F verlangt der Server eine
-- Kundenkennung und eine vollstaendige Rechnungsanschrift.
insert into public.workspace_customers (workspace_id, customer_id, payload)
values ('00000000-0000-0000-0000-0000000000ff', 'cust-a', '{"name":"Replay Kunde GmbH"}'::jsonb),
       ('00000000-0000-0000-0000-0000000000ff', 'cust-b', '{"name":"Zweiter Kunde GmbH"}'::jsonb);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000aaaa","role":"authenticated"}', true);

-- Erwartet einen Fehler, dessen Text `p_expected` enthaelt. Temporaer; faellt
-- mit dem Rollback weg.
create function pg_temp.erwarte_fehler(p_label text, p_vorgang text, p_id text, p_invoice jsonb, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.finalize_workspace_invoice('00000000-0000-0000-0000-0000000000ff', p_vorgang, p_id, p_invoice);
  exception when others then
    if position(p_expected in sqlerrm) = 0 then
      raise exception '% — falscher Fehler: %', p_label, sqlerrm;
    end if;
    raise notice 'OK  %: %', p_label, sqlerrm;
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

/*
 * 03F2 — die Payloads entstehen aus einem Bauer, nicht mehr von Hand.
 *
 * Der Replay-Vergleich arbeitet auf dem gesamten Payload; entscheidend ist,
 * dass zwei Aufrufe desselben Falls denselben Text erzeugen. Der Bauer stellt
 * genau das sicher und bleibt trotzdem lesbar.
 */
create function pg_temp.frei(p_overrides jsonb default '{}'::jsonb)
returns jsonb language sql as $p$
  select '{
    "type": "rechnung",
    "taxStatus": "kleinunternehmer_19",
    "customerId": "cust-a",
    "customerSnapshot": {"name":"Replay Kunde GmbH","street":"Replayweg 1","zip":"33602","city":"Bielefeld"},
    "positions": [{"id":"p1","description":"Leistung","quantity":1,"unit":"Pauschal","unitPrice":100,"lineTotal":100}],
    "subtotal": 100,
    "amount": 100
  }'::jsonb || p_overrides;
$p$;

/* Der Auftragspfad: 'v-1' hat keine Auftragspositionen, also bleibt der Beleg leer. */
create function pg_temp.mit_auftrag(p_overrides jsonb default '{}'::jsonb)
returns jsonb language sql as $p$
  select '{
    "type": "rechnung",
    "taxStatus": "kleinunternehmer_19",
    "positions": [],
    "subtotal": 0,
    "amount": 0
  }'::jsonb || p_overrides;
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-0000000000ff';
  r jsonb;
  n integer;
begin
  /* ---------------- R1: Replay mit explizitem Datum ---------------- */
  r := public.finalize_workspace_invoice(ws, null, 'r1-001', pg_temp.frei('{"issueDate":"2026-09-12"}'::jsonb));
  if (r->>'idempotent_replay')::boolean or r->'row'->>'vorgang_id' is not null then
    raise exception 'R1 Erstlauf: unerwartet %', r;
  end if;

  r := public.finalize_workspace_invoice(ws, null, 'r1-001', pg_temp.frei('{"issueDate":"2026-09-12"}'::jsonb));
  if not (r->>'idempotent_replay')::boolean then raise exception 'R1: identischer Replay nicht idempotent'; end if;
  raise notice 'OK  R1: identischer Replay idempotent';

  r := public.finalize_workspace_invoice(ws, null, 'r1-001', pg_temp.frei('{"date":"2026-09-12"}'::jsonb));
  if not (r->>'idempotent_replay')::boolean then raise exception 'R1: Replay mit date statt issueDate nicht idempotent'; end if;
  raise notice 'OK  R1: date/issueDate gleich kanonisiert';

  perform pg_temp.erwarte_fehler('R1 Position geaendert', null, 'r1-001', pg_temp.frei('{"issueDate":"2026-09-12","positions":[{"id":"x"}]}'::jsonb), 'abweichender Rechnungsinhalt');
  perform pg_temp.erwarte_fehler('R1 Datum geaendert',    null, 'r1-001', pg_temp.frei('{"issueDate":"2026-09-13"}'::jsonb), 'abweichender Rechnungsinhalt');
  perform pg_temp.erwarte_fehler('R1 NULL -> Vorgang',    'v-1', 'r1-001', pg_temp.frei('{"issueDate":"2026-09-12"}'::jsonb), 'abweichender Vorgangsbezug');

  /* ---------------- R2: datumsloser Request ueber Tageswechsel ---------------- */
  r := public.finalize_workspace_invoice(ws, null, 'r2-001', pg_temp.frei());
  if (r->>'idempotent_replay')::boolean then raise exception 'R2 Erstlauf: unerwartet Replay'; end if;
  if r->'invoice'->>'date' <> to_char(timezone('utc', now()), 'YYYY-MM-DD') then
    raise exception 'R2 Erstlauf: Fallback nicht UTC-heute, sondern %', r->'invoice'->>'date';
  end if;
  raise notice 'OK  R2: datumsloser Erstlauf faellt auf UTC-heute zurueck';

  -- Tageswechsel simulieren: die gespeicherte Zeile traegt einen frueheren
  -- serverseitig vergebenen Fallback-Tag. Genau so saehe sie nach einem
  -- echten Erstlauf an jenem Tag aus.
  update public.workspace_invoices
  set payload = payload || '{"date":"2026-09-10","issueDate":"2026-09-10"}'::jsonb
  where workspace_id = ws and client_invoice_id = 'r2-001';

  r := public.finalize_workspace_invoice(ws, null, 'r2-001', pg_temp.frei());
  if not (r->>'idempotent_replay')::boolean then
    raise exception 'R2 KERN: datumsloser Replay am spaeteren Tag nicht idempotent';
  end if;
  if r->'invoice'->>'date' <> '2026-09-10' then
    raise exception 'R2: Replay lieferte anderes Datum: %', r->'invoice'->>'date';
  end if;
  raise notice 'OK  R2: datumsloser Cross-Day-Replay idempotent';

  r := public.finalize_workspace_invoice(ws, null, 'r2-001', pg_temp.frei('{"issueDate":"2026-09-10"}'::jsonb));
  if not (r->>'idempotent_replay')::boolean then raise exception 'R2: explizit gleiches Datum nicht idempotent'; end if;
  raise notice 'OK  R2: explizit gleiches Datum idempotent';

  perform pg_temp.erwarte_fehler('R2 explizit anderes Datum', null, 'r2-001', pg_temp.frei('{"issueDate":"2026-09-11"}'::jsonb), 'abweichender Rechnungsinhalt');

  -- Derselbe Fall ueber den Vorgangspfad (Auftragsrechnung).
  r := public.finalize_workspace_invoice(ws, 'v-1', 'r2-order', pg_temp.mit_auftrag());
  update public.workspace_invoices
  set payload = payload || '{"date":"2026-09-10","issueDate":"2026-09-10"}'::jsonb
  where workspace_id = ws and client_invoice_id = 'r2-order';
  r := public.finalize_workspace_invoice(ws, 'v-1', 'r2-order', pg_temp.mit_auftrag());
  if not (r->>'idempotent_replay')::boolean then raise exception 'R2 Vorgangspfad: Cross-Day-Replay nicht idempotent'; end if;
  raise notice 'OK  R2: Cross-Day-Replay auch ueber Vorgangspfad';

  /* ---------------- CUSTOMER-IDENTITY-01B: customerId im Payload ---------------- */
  -- Kein Schema, kein RPC: customerId reist im JSONB mit und ist Teil der
  -- serverseitigen Payload-Gleichheit. Derselbe Request replayt; ein anderer
  -- Kunde bei gleicher client_invoice_id ist ein Idempotenzkonflikt.
  r := public.finalize_workspace_invoice(ws, null, 'cid-001', pg_temp.frei('{"issueDate":"2026-09-12"}'::jsonb));
  if (r->>'idempotent_replay')::boolean then raise exception 'CID Erstlauf: unerwartet Replay'; end if;
  if r->'invoice'->>'customerId' <> 'cust-a' then raise exception 'CID: customerId nicht gespeichert: %', r->'invoice'; end if;
  raise notice 'OK  CID: freie Rechnung mit customerId gespeichert (%)', r->'row'->>'invoice_number';

  r := public.finalize_workspace_invoice(ws, null, 'cid-001', pg_temp.frei('{"issueDate":"2026-09-12"}'::jsonb));
  if not (r->>'idempotent_replay')::boolean then raise exception 'CID: identischer Replay nicht idempotent'; end if;
  raise notice 'OK  CID: identischer Replay idempotent';

  perform pg_temp.erwarte_fehler('CID anderer Kunde', null, 'cid-001', pg_temp.frei('{"issueDate":"2026-09-12","customerId":"cust-b","customerSnapshot":{"name":"Zweiter Kunde GmbH","street":"Anderer Weg 2","zip":"32052","city":"Herford"}}'::jsonb), 'abweichender Rechnungsinhalt');

  /* ---------------- Invarianten, die unveraendert bleiben muessen ---------------- */
  perform pg_temp.erwarte_fehler('abschlag + NULL', null, 'x-abschlag', '{"type":"abschlag","positions":[]}', 'invoice_requires_vorgang_for_type');
  perform pg_temp.erwarte_fehler('schluss + NULL',  null, 'x-schluss',  '{"type":"schluss","positions":[]}',  'invoice_requires_vorgang_for_type');
  perform pg_temp.erwarte_fehler('Leerstring',      '  ', 'x-leer',     '{"type":"rechnung","positions":[]}', 'vorgang_id fehlt');

  select count(*) into n from public.workspace_invoices where workspace_id = ws;
  if n <> 4 then raise exception 'Erwartet 4 Rechnungen (r1-001, r2-001, r2-order, cid-001), gefunden %', n; end if;
  -- Der Nummernkreis ist unveraendert fortlaufend: 0001..0004, keine Luecke, kein zweiter Kreis.
  select count(*) into n from public.workspace_invoices where workspace_id = ws and invoice_sequence_number between 1 and 4;
  if n <> 4 then raise exception 'Nummernkreis nicht fortlaufend'; end if;
  raise notice 'OK  keine Doppelbelege, gemeinsamer Nummernkreis';
end;
$$;

rollback;
\echo 'ALLE ZUSICHERUNGEN ERFUELLT'
