-- FINANZ-CORE-01A -- Gesamtnacharbeit Paket 3 (Migration 20261121120000): kanonische Rechnungsposition
-- und Angebotskette. Nachgestellt sind die Faelle der WEISS-Gesamtmaengelinventur vom 15.10.2026:
--   R  INV-06/07: 10 x 0,045 (S3) und Position ohne lineTotal (S4) werden vor der Nummernvergabe
--      abgewiesen, ohne eine Nummer zu verbrauchen; 10 x 0,05 = 0,50 geht; falscher Zeilenbetrag wie bisher
--      abgewiesen; Auftragsrechnung mit Untercentpreis abgewiesen; jede gespeicherte Position ist kanonisch.
--   O  INV-10: Angebot fuer einen Kunden mit Land, USt-IdNr., Kaeuferreferenz und Leitweg-ID: der Server
--      speichert alle Felder; der verlustbehaftete Archiv-Push (ohne Land) bleibt abgewiesen (Beleg
--      unveraenderlich), der vollstaendige wird angenommen; die Annahme erzeugt genau einen Auftrag mit
--      allen Kundenfeldern, eine Wiederholung keinen zweiten.
--
-- Setzt die Migrationen bis 20261121120000 voraus. Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/fc01a_inventur_paket3.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetische Nutzer, keine Zugangsdaten, alles wird
-- zurueckgerollt.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000fe601', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'fc01a-inventur3-inhaber@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where email = 'fc01a-inventur3-inhaber@example.invalid';
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-00000000fe60', 'FC01A Inventur Paket 3', '00000000-0000-0000-0000-0000000fe601');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-00000000fe60', '00000000-0000-0000-0000-0000000fe601', 'owner', 'active');
insert into public.workspace_customers (workspace_id, customer_id, payload, deleted)
values ('00000000-0000-0000-0000-00000000fe60', 'cust-nw', '{"id":"cust-nw","name":"Bielefeld GmbH"}'::jsonb, false);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000fe601","role":"authenticated"}', true);

create function pg_temp.erwarte_fehler(p_label text, p_sql text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_expected in sqlerrm) = 0 and position(p_expected in sqlstate) = 0 then
      raise exception '% — falscher Fehler: % (%)', p_label, sqlerrm, sqlstate;
    end if;
    raise notice 'OK  %: %', p_label, left(sqlerrm, 120);
    return;
  end;
  raise exception '% — kein Fehler, aber % erwartet', p_label, p_expected;
end;
$p$;

/* Freie Rechnung (WEISS S3/S4): eine Position; lineTotal nur, wenn angegeben. */
create function pg_temp.frei(p_id text, p_menge numeric, p_preis numeric, p_line numeric, p_subtotal numeric, p_amount numeric)
returns jsonb language sql as $p$
  select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fe60', null, p_id, jsonb_build_object(
    'type', 'rechnung', 'taxStatus', 'standard_19', 'customerId', 'cust-nw',
    'customerSnapshot', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld","contactPerson":"","email":"","phone":""}'::jsonb,
    'createdAt', '2026-09-23T08:00:00Z', 'issueDate', '2026-09-23',
    'positions', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('id', 'p1', 'description', 'Kleinteile', 'quantity', p_menge,
      'unit', 'Stück', 'unitPrice', p_preis, 'lineTotal', p_line))),
    'subtotal', p_subtotal, 'amount', p_amount));
$p$;

create function pg_temp.letzte_nummer() returns integer language sql stable as $p$
  select coalesce(max(last_sequence), 0) from public.workspace_invoice_sequences
  where workspace_id = '00000000-0000-0000-0000-00000000fe60';
$p$;

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-00000000fe60';
  r jsonb;
  vor integer;
  n integer;
  kunde constant jsonb := '{"name":"WEISS INVENTUR Testkunde","contactPerson":"","street":"Testweg 15","zip":"33100","city":"Paderborn","email":"inventur@example.invalid","phone":"","countryCode":"DE","vatId":"DE123456789","buyerReference":"REF-INV-3","leitwegId":"04011000-12345-67"}'::jsonb;
  angebot jsonb;
  gespeichert jsonb;
  version bigint;
begin
  /* ------------------------------------------------------------------ R -- INV-06/07 */
  r := pg_temp.frei('iv-start', 1, 1, 1, 1, 1.19);
  vor := pg_temp.letzte_nummer();
  perform pg_temp.erwarte_fehler('R1 WEISS S3: 10 × 0,045 vor der Nummernvergabe abgewiesen',
    $q$select pg_temp.frei('iv-price-precision', 10, 0.045, 0.45, 0.45, 0.54)$q$, 'invoice_unit_price_precision');
  perform pg_temp.erwarte_fehler('R2 WEISS S4: Position ohne lineTotal vor der Nummernvergabe abgewiesen',
    $q$select pg_temp.frei('iv-missing-line', 1, 1, null, 1, 1.19)$q$, 'invoice_line_total_missing');
  if pg_temp.letzte_nummer() is distinct from vor
     or exists (select 1 from public.workspace_invoices where workspace_id = ws and client_invoice_id in ('iv-price-precision', 'iv-missing-line')) then
    raise exception 'R: abgewiesene Freigabe hat eine Nummer verbraucht oder eine Zeile hinterlassen';
  end if;
  raise notice 'OK  R3 keine Nummer verbraucht, keine Zeile (Sequenz bleibt %)', vor;
  r := pg_temp.frei('iv-cent', 10, 0.05, 0.50, 0.50, 0.60);
  if (r->'invoice'->>'invoiceSequenceNumber')::integer is distinct from vor + 1 or r->'invoice'->'positions'->0->'lineTotal' is null then
    raise exception 'R4: Centpreis nicht mit der nächsten Nummer angenommen: %', r;
  end if;
  raise notice 'OK  R4 10 × 0,05 = 0,50 angenommen, nächste Nummer %', vor + 1;
  perform pg_temp.erwarte_fehler('R5 falscher Zeilenbetrag (wie bisher)',
    $q$select pg_temp.frei('iv-line-falsch', 10, 0.05, 0.45, 0.45, 0.54)$q$, 'invoice_totals_mismatch');
  perform public.create_workspace_order(ws, 'v-r6', jsonb_build_object(
    'customerId', 'cust-nw', 'customerBilling', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb,
    'title', 'R6', 'baustelle', '', 'taxStatus', 'standard_19',
    'positions', '[{"id":"cp1","description":"Kleinteile","plannedQuantity":10,"unit":"Stück","unitPrice":0.05}]'::jsonb));
  perform pg_temp.erwarte_fehler('R6 Auftragsrechnung mit Untercentpreis',
    $q$select public.finalize_workspace_invoice('00000000-0000-0000-0000-00000000fe60', 'v-r6', 'iv-r6', jsonb_build_object(
      'type', 'rechnung', 'taxStatus', 'standard_19', 'issueDate', '2026-09-23', 'legalNotices', '[]'::jsonb,
      'customerId', 'cust-nw', 'customerSnapshot', '{"name":"Muster GmbH","street":"Weg 1","zip":"33602","city":"Bielefeld"}'::jsonb,
      'positions', '[{"id":"l1","orderPositionId":"cp1","description":"Kleinteile","quantity":10,"unit":"Stück","unitPrice":0.045,"lineTotal":0.45}]'::jsonb,
      'subtotal', 0.45, 'amount', 0.54))$q$, 'invoice_');
  select count(*) into n
  from public.workspace_invoices wi, jsonb_array_elements(coalesce(wi.payload->'positions', '[]'::jsonb)) p
  where wi.workspace_id = ws
    and (jsonb_typeof(p.value->'lineTotal') is distinct from 'number'
         or (p.value->>'unitPrice')::numeric is distinct from round((p.value->>'unitPrice')::numeric, 2));
  if n is distinct from 0 then raise exception 'R7: % gespeicherte Positionen nicht kanonisch', n; end if;
  raise notice 'OK  R7 jede gespeicherte Position: Centpreis und Zeilenbetrag';
  if has_function_privilege('authenticated', 'public.workspace_invoices_positions_canonical()', 'execute')
     or has_function_privilege('anon', 'public.workspace_invoices_positions_canonical()', 'execute') then
    raise exception 'R8: Triggerfunktion von aussen aufrufbar';
  end if;
  raise notice 'OK  R8 Triggerfunktion nur Eigentümer';

  /* ------------------------------------------------------------------ O -- INV-10 Angebotskette */
  angebot := jsonb_build_object('id', 'off-inv', 'customerId', 'cust-nw', 'customer', kunde, 'title', 'WEISS INVENTUR Finanzkette',
    'baustelle', '', 'offerDate', '2026-10-15', 'validUntil', '2026-11-14', 'introText', '', 'closingText', '',
    'paymentTermsText', 'Zahlbar innerhalb von 14 Tagen ohne Abzug.', 'legalNotices', '[]'::jsonb,
    'positions', '[{"id":"op1","description":"Synthetische Testleistung","quantity":1,"unit":"Stück","unitPrice":1000}]'::jsonb,
    'taxStatus', 'standard_19', 'totals', '{"subtotal":1000,"taxRate":19,"tax":190,"total":1190}'::jsonb,
    'createdAt', '2026-10-15T09:26:09.015Z');
  r := public.finalize_workspace_offer(ws, 'off-inv', angebot, 'fp-inv', 0);
  select payload, row_version into gespeichert, version from public.workspace_offers where workspace_id = ws and client_offer_id = 'off-inv';
  if gespeichert->'customer' is distinct from kunde then raise exception 'O1: Server hat den Kunden verändert: %', gespeichert->'customer'; end if;
  raise notice 'OK  O1 freigegeben (%), Kunde mit allen vier E-Rechnungsfeldern gespeichert', gespeichert->>'offerNumber';
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
  values (ws, 'offer-archive-off-inv', 'archived_document', '{"classifiedKind":"angebot","linkedOfferId":"off-inv"}'::jsonb);
  perform pg_temp.erwarte_fehler('O2 WEISS: verlustbehafteter Archiv-Push (Kunde ohne Land) bleibt abgewiesen',
    format($q$select public.upsert_workspace_sync_entity('00000000-0000-0000-0000-00000000fe60', 'offer', jsonb_build_object('offer_id', 'off-inv', 'status', 'freigegeben', 'payload', %L::jsonb), %s)$q$,
      (gespeichert || jsonb_build_object('customer', kunde - 'countryCode', 'archiveDocumentId', 'offer-archive-off-inv'))::text, version),
    'Angebot ist freigegeben und kann nicht mehr geaendert werden');
  r := public.upsert_workspace_sync_entity(ws, 'offer', jsonb_build_object('offer_id', 'off-inv', 'status', 'freigegeben',
    'payload', gespeichert || '{"archiveDocumentId":"offer-archive-off-inv"}'::jsonb), version);
  if r->'payload'->>'archiveDocumentId' is distinct from 'offer-archive-off-inv' then raise exception 'O3: Archivverweis nicht übernommen: %', r; end if;
  raise notice 'OK  O3 vollständiger Archiv-Push angenommen';
  select row_version into version from public.workspace_offers where workspace_id = ws and client_offer_id = 'off-inv';
  r := public.accept_workspace_offer(ws, 'off-inv', 'v-aus-angebot', version);
  if (r->>'replayed')::boolean or r->'offer'->>'status' is distinct from 'angenommen' then raise exception 'O4: Annahme %', r; end if;
  if r->'vorgang'->'payload'->'customerBilling' is distinct from kunde then
    raise exception 'O4: Auftrag ohne vollständigen Kunden: %', r->'vorgang'->'payload'->'customerBilling';
  end if;
  r := public.accept_workspace_offer(ws, 'off-inv', 'v-aus-angebot-2', 0);
  select count(*) into n from public.workspace_vorgaenge where workspace_id = ws and source_offer_id = 'off-inv';
  if not (r->>'replayed')::boolean or n is distinct from 1 then raise exception 'O5: zweite Annahme ergab % Aufträge', n; end if;
  select count(*) into n from public.workspace_offers where workspace_id = ws and payload->>'offerNumber' = gespeichert->>'offerNumber';
  if n is distinct from 1 then raise exception 'O5: Angebotsnummer % mal vergeben', n; end if;
  raise notice 'OK  O4/O5 genau ein Auftrag mit allen Kundenfeldern; Wiederholung ohne zweiten Auftrag, keine zweite Nummer';

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
