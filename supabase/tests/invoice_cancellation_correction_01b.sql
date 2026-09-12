-- NORMAL-INVOICE-CANCELLATION-01B — Laufzeittest fuer cancel_workspace_invoice v2
-- (internes Storno, Korrekturbeleg, Idempotenz, Zahlungen, Pull).
--
-- Prueft die **reale** SQL-Semantik gegen die lokale Docker-Datenbank.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   npx --yes supabase@latest db reset --local
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/invoice_cancellation_correction_01b.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt. Der parallele Storno (zwei
-- Sessions) steht in invoice_cancellation_parallel_01b.sql.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'cancel-test@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000000cc', 'Cancel-Test', '00000000-0000-0000-0000-00000000bbbb');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-00000000bbbb', 'owner', 'active');
insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload)
values ('00000000-0000-0000-0000-0000000000cc', 'v-1', '{}'::jsonb);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000bbbb","role":"authenticated"}', true);

create function pg_temp.erwarte_storno_fehler(p_label text, p_id text, p_reason text, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.cancel_workspace_invoice('00000000-0000-0000-0000-0000000000cc', p_id, p_reason);
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

do $$
declare
  ws constant uuid := '00000000-0000-0000-0000-0000000000cc';
  r jsonb;
  row_before public.workspace_invoices;
  row_after public.workspace_invoices;
  c public.workspace_invoices;
  d public.workspace_documents;
  n integer;
  seq_before integer;
  seq_after integer;
  pulled jsonb;
  pos jsonb := '[{"id":"p1","description":"Anfahrt","quantity":2,"unit":"Std","unitPrice":50,"lineTotal":100}]';
  base_free jsonb;
  base_order jsonb;
begin
  base_free := jsonb_build_object('type','rechnung','issueDate','2026-09-01','positions',pos,'subtotal',100,'amount',119,'taxStatus','standard_19',
    'companySnapshot', jsonb_build_object('companyName','Muster GmbH'), 'customerSnapshot', jsonb_build_object('name','Beispiel Projektbau GmbH'),
    'customerId','cust-1','servicePeriodFrom','2026-08-20','servicePeriodTo','2026-08-28');
  base_order := base_free || jsonb_build_object('vorgangTitle','Dachsanierung');

  /* ---------- 1/2/5: vorbereitete freie Rechnung -> internal, kein Dokument ---------- */
  r := public.finalize_workspace_invoice(ws, null, 'inv-free-prep', base_free);
  select * into row_before from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-free-prep';
  select * into c from public.cancel_workspace_invoice(ws, 'inv-free-prep', 'Falscher Kunde');
  if c.cancelled_at is null or c.cancellation_kind <> 'internal' or c.correction_document_id is not null then
    raise exception 'T1: internes Storno nicht korrekt: kind=% doc=%', c.cancellation_kind, c.correction_document_id;
  end if;
  if c.cancelled_by <> '00000000-0000-0000-0000-00000000bbbb' or c.cancel_reason <> 'Falscher Kunde' then
    raise exception 'T1: cancelled_by/reason falsch';
  end if;
  select count(*) into n from public.workspace_documents where workspace_id = ws and linked_invoice_id = 'inv-free-prep';
  if n <> 0 then raise exception 'T2: internes Storno darf kein Dokument erzeugen, gefunden %', n; end if;
  if c.invoice_number <> row_before.invoice_number or c.invoice_status <> row_before.invoice_status
     or (c.payload - 'cancelledAt' - 'cancelReason') <> row_before.payload then
    raise exception 'T14: Originalpayload/Nummer/Status veraendert';
  end if;
  raise notice 'OK  T1/T2/T5/T14: vorbereitete freie Rechnung intern storniert, Original unveraendert';

  /* ---------- 3/4/5/13: versendete freie Rechnung -> correction, genau ein Beleg ---------- */
  r := public.finalize_workspace_invoice(ws, null, 'inv-free-sent', base_free);
  perform public.update_workspace_invoice_sent(ws, 'inv-free-sent', '2026-09-02', 'email', null);
  select * into row_before from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-free-sent';
  if row_before.invoice_status <> 'versendet' then raise exception 'Vorbedingung: nicht versendet'; end if;
  select coalesce(max(invoice_sequence_number),0) into seq_before from public.workspace_invoices where workspace_id = ws;

  select * into c from public.cancel_workspace_invoice(ws, 'inv-free-sent', 'Leistung nicht erbracht');
  if c.cancellation_kind <> 'correction' or c.correction_document_id <> 'corr-inv-free-sent' then
    raise exception 'T3: Korrektur nicht korrekt: kind=% doc=%', c.cancellation_kind, c.correction_document_id;
  end if;
  select count(*) into n from public.workspace_documents where workspace_id = ws and linked_invoice_id = 'inv-free-sent' and document_kind = 'generated_invoice_correction';
  if n <> 1 then raise exception 'T4: erwartet genau 1 Korrekturbeleg, gefunden %', n; end if;
  select * into d from public.workspace_documents where workspace_id = ws and client_document_id = 'corr-inv-free-sent';
  if d.linked_vorgang_id is not null then raise exception 'T5: freie Rechnung darf keinen Vorgang am Beleg tragen'; end if;
  if d.payload->>'documentType' <> 'rechnungskorrektur' or d.payload->>'correctionKind' <> 'storno'
     or d.payload->>'classifiedKind' <> 'rechnungskorrektur' or d.payload->>'category' <> 'ausgangsrechnung'
     or d.payload->>'originalClientInvoiceId' <> 'inv-free-sent'
     or d.payload->>'originalInvoiceNumber' <> row_before.invoice_number
     or d.payload->>'originalIssueDate' <> '2026-09-01'
     or d.payload->>'cancelReason' <> 'Leistung nicht erbracht'
     or d.payload->>'customerId' <> 'cust-1'
     or d.payload->'companySnapshot'->>'companyName' <> 'Muster GmbH'
     or d.payload->'customerSnapshot'->>'name' <> 'Beispiel Projektbau GmbH'
     or d.payload->>'taxStatus' <> 'standard_19'
     or d.payload->'originalInvoiceSnapshot' <> row_before.payload
     or d.payload->>'title' <> ('Rechnungskorrektur zu Rechnung ' || row_before.invoice_number) then
    raise exception 'T13: Korrekturbeleg-Payload unvollstaendig: %', d.payload;
  end if;
  -- Keine Berechnung in SQL: der Beleg traegt keine eigenen Summen.
  if d.payload ? 'summary' or d.payload ? 'positions' or d.payload ? 'amount' then
    raise exception 'T13: Korrekturbeleg darf keine eigene Berechnung tragen';
  end if;
  select * into row_after from public.workspace_invoices where workspace_id = ws and client_invoice_id = 'inv-free-sent';
  if (row_after.payload - 'cancelledAt' - 'cancelReason') <> row_before.payload or row_after.invoice_status <> 'versendet' then
    raise exception 'T14: Original nach Korrektur veraendert';
  end if;
  select coalesce(max(invoice_sequence_number),0) into seq_after from public.workspace_invoices where workspace_id = ws;
  if seq_after <> seq_before then raise exception 'T15: Nummernkreis verbraucht'; end if;
  if c.correction_number is not null then raise exception 'T15: correction_number darf nicht vergeben sein'; end if;
  raise notice 'OK  T3/T4/T5/T13/T14/T15: versendete freie Rechnung -> Korrekturbeleg, Original und Nummernkreis unveraendert';

  /* ---------- 11/12: identischer Replay, anderer Grund ---------- */
  select * into c from public.cancel_workspace_invoice(ws, 'inv-free-sent', 'Leistung nicht erbracht');
  if c.cancelled_at <> row_after.cancelled_at or c.row_version <> row_after.row_version then
    raise exception 'T11: Replay hat die Zeile veraendert';
  end if;
  select * into c from public.cancel_workspace_invoice(ws, 'inv-free-sent', 'GANZ ANDERER GRUND');
  if c.cancel_reason <> 'Leistung nicht erbracht' or c.row_version <> row_after.row_version then
    raise exception 'T12: anderer Grund hat still ueberschrieben';
  end if;
  select count(*) into n from public.workspace_documents where workspace_id = ws and linked_invoice_id = 'inv-free-sent';
  if n <> 1 then raise exception 'T11: Replay hat zweiten Korrekturbeleg erzeugt (%)', n; end if;
  raise notice 'OK  T11/T12: Replay idempotent, erster Grund bleibt, ein Beleg';

  /* ---------- 6: Vorgangsrechnung versendet -> correction mit Vorgang ---------- */
  r := public.finalize_workspace_invoice(ws, 'v-1', 'inv-order-sent', base_order);
  perform public.update_workspace_invoice_sent(ws, 'inv-order-sent', '2026-09-02', 'post', null);
  select * into c from public.cancel_workspace_invoice(ws, 'inv-order-sent', 'Doppelt gestellt');
  select * into d from public.workspace_documents where workspace_id = ws and client_document_id = 'corr-inv-order-sent';
  if c.cancellation_kind <> 'correction' or d.linked_vorgang_id <> 'v-1' or d.payload->>'linkedVorgangId' <> 'v-1' then
    raise exception 'T6: Vorgangsrechnung-Korrektur ohne Vorgangsrelation';
  end if;
  raise notice 'OK  T6: Vorgangsrechnung -> Korrekturbeleg mit Vorgangsrelation';

  /* ---------- 7: versendete Schlussrechnung nutzt dieselbe Architektur ---------- */
  r := public.finalize_workspace_invoice(ws, 'v-1', 'inv-schluss-sent', base_order || '{"type":"schluss"}'::jsonb);
  perform public.update_workspace_invoice_sent(ws, 'inv-schluss-sent', '2026-09-03', 'email', null);
  select * into c from public.cancel_workspace_invoice(ws, 'inv-schluss-sent', 'Schluss falsch');
  if c.cancellation_kind <> 'correction' or c.correction_document_id <> 'corr-inv-schluss-sent' then
    raise exception 'T7: Schlussrechnung ohne Korrekturbeleg';
  end if;
  -- Single-Final: nach dem Storno ist eine Ersatz-Schlussrechnung wieder moeglich.
  r := public.finalize_workspace_invoice(ws, 'v-1', 'inv-schluss-2', base_order || '{"type":"schluss"}'::jsonb);
  raise notice 'OK  T7: versendete Schlussrechnung -> Korrekturbeleg, Ersatz moeglich';

  /* ---------- 8: Abschlag abgewiesen ---------- */
  r := public.finalize_workspace_invoice(ws, 'v-1', 'inv-abschlag', base_order || '{"type":"abschlag","abschlagNumber":1}'::jsonb);
  perform pg_temp.erwarte_storno_fehler('T8 Abschlag', 'inv-abschlag', 'x', 'invoice_cancel_type_not_supported');

  /* ---------- 9/10: aktives Payment blockiert, nach Reversal stornierbar ---------- */
  r := public.finalize_workspace_invoice(ws, null, 'inv-paid', base_free);
  perform public.update_workspace_invoice_sent(ws, 'inv-paid', '2026-09-02', 'email', null);
  perform public.add_workspace_invoice_payment(ws, 'inv-paid', 'pay-1', 50, '2026-09-03');
  perform pg_temp.erwarte_storno_fehler('T9 aktive Zahlung', 'inv-paid', 'x', 'invoice_cancel_has_active_payments');
  select count(*) into n from public.workspace_documents where workspace_id = ws and linked_invoice_id = 'inv-paid';
  if n <> 0 then raise exception 'T9: abgewiesenes Storno hat ein Dokument hinterlassen'; end if;
  perform public.reverse_workspace_invoice_payment(ws, 'inv-paid', 'pay-1');
  select * into c from public.cancel_workspace_invoice(ws, 'inv-paid', 'Nach Rueckname');
  if c.cancelled_at is null or c.cancellation_kind <> 'correction' then raise exception 'T10: nach Reversal nicht stornierbar'; end if;
  select count(*) into n from public.workspace_invoice_payments where workspace_id = ws and client_invoice_id = 'inv-paid';
  if n <> 1 then raise exception 'T10: Zahlungshistorie verloren'; end if;
  raise notice 'OK  T9/T10: aktive Zahlung blockiert, nach Reversal stornierbar, Historie bleibt';

  /* ---------- Fehlerfaelle: Entwurf, unbekannt, ohne Grund ---------- */
  perform pg_temp.erwarte_storno_fehler('unbekannt', 'inv-nope', 'x', 'Rechnung nicht gefunden');
  perform pg_temp.erwarte_storno_fehler('ohne Grund', 'inv-free-prep', '  ', 'invoice_cancel_reason_required');

  /* ---------- 17: Pull liefert Cancellation-Felder ---------- */
  pulled := public.pull_workspace_invoices(ws, null);
  select count(*) into n from jsonb_array_elements(pulled) e
   where e->>'client_invoice_id' = 'inv-free-sent'
     and e->>'cancellation_kind' = 'correction'
     and e->>'correction_document_id' = 'corr-inv-free-sent'
     and e ? 'correction_number'
     and e->>'cancelled_at' is not null;
  if n <> 1 then raise exception 'T17: Pull liefert Cancellation-Felder nicht: %', pulled; end if;
  select count(*) into n from jsonb_array_elements(pulled) e
   where e->>'client_invoice_id' = 'inv-free-prep' and e->>'cancellation_kind' = 'internal' and e->'correction_document_id' = 'null'::jsonb;
  if n <> 1 then raise exception 'T17: internes Storno im Pull falsch'; end if;
  raise notice 'OK  T17: Pull liefert cancellation_kind/correction_document_id/correction_number';

  /* ---------- 18: Pull liefert beide Dokumentarten ---------- */
  insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, linked_vorgang_id, payload)
  values (ws, 'doc-orig-inv-free-sent', 'generated_invoice', 'inv-free-sent', null, '{"title":"Original"}'::jsonb);
  pulled := public.pull_workspace_documents(ws, null);
  select count(*) into n from jsonb_array_elements(pulled) e where e->>'linked_invoice_id' = 'inv-free-sent' and e->>'document_kind' = 'generated_invoice';
  if n <> 1 then raise exception 'T18: Original-Dokument fehlt im Pull'; end if;
  select count(*) into n from jsonb_array_elements(pulled) e where e->>'linked_invoice_id' = 'inv-free-sent' and e->>'document_kind' = 'generated_invoice_correction';
  if n <> 1 then raise exception 'T18: Korrekturbeleg fehlt im Pull'; end if;
  raise notice 'OK  T18: Original und Korrekturbeleg stehen nebeneinander im Pull';

  /* ---------- Constraint-Beweise ---------- */
  begin
    insert into public.workspace_documents (workspace_id, client_document_id, document_kind, linked_invoice_id, payload)
    values (ws, 'corr-zweit', 'generated_invoice_correction', 'inv-free-sent', '{}'::jsonb);
    raise exception 'Unique: zweiter Korrekturbeleg wurde angenommen';
  exception when unique_violation then
    raise notice 'OK  Unique: zweiter Korrekturbeleg je Rechnung abgewiesen';
  end;
  begin
    update public.workspace_invoices set correction_document_id = null where workspace_id = ws and client_invoice_id = 'inv-free-sent';
    raise exception 'Check: correction ohne Beleg wurde angenommen';
  exception when check_violation then
    raise notice 'OK  Check: correction ohne correction_document_id abgewiesen';
  end;
  begin
    update public.workspace_invoices set correction_document_id = 'x' where workspace_id = ws and client_invoice_id = 'inv-free-prep';
    raise exception 'Check: internal mit Beleg wurde angenommen';
  exception when check_violation then
    raise notice 'OK  Check: internal mit correction_document_id abgewiesen';
  end;
end;
$$;

rollback;
\echo 'ALLE ZUSICHERUNGEN ERFUELLT'
