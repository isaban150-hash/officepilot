-- ANGEBOT-01B (Pre-Acceptance) — Laufzeit-Regressionstest fuer die
-- Archiv-Invariante und die Freigabe-Idempotenz von Angeboten.
--
-- Prueft die **reale** SQL-Semantik gegen eine lokale Datenbank:
--   * finalize_workspace_offer: Nummer vom Server, identischer Fingerabdruck
--     ist ein Replay, anderer Fingerabdruck wird abgewiesen.
--   * upsert_workspace_sync_entity('offer'): archiveDocumentId ist write-once
--     und darf nur auf ein Dokument desselben Workspaces zeigen, das
--     classifiedKind = 'angebot' traegt und genau dieses Angebot referenziert.
--     Fremdworkspace, falsche Art, fremdes Angebot, Wechsel und Entwurf werden
--     abgewiesen.
--
-- Ausfuehren (nur lokal, niemals --linked oder remote):
--   docker exec -i supabase_db_officepilot psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/offer_archive_invariant_01b.sql
--
-- Exit-Code 0 = alle Zusicherungen erfuellt. Synthetischer Nutzer, keine
-- Zugangsdaten, alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-00000000abcd', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'offer-test@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);
insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-000000000f01', 'Angebot-Test', '00000000-0000-0000-0000-00000000abcd'),
       ('00000000-0000-0000-0000-000000000f02', 'Fremd', '00000000-0000-0000-0000-00000000abcd');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-00000000abcd', 'owner', 'active');

insert into public.workspace_documents (workspace_id, client_document_id, document_kind, payload)
values
  ('00000000-0000-0000-0000-000000000f01', 'doc-eigen', 'archived_document', '{"classifiedKind":"angebot","linkedOfferId":"o-1"}'::jsonb),
  ('00000000-0000-0000-0000-000000000f01', 'doc-fremdart', 'archived_document', '{"classifiedKind":"rechnung","linkedOfferId":"o-1"}'::jsonb),
  ('00000000-0000-0000-0000-000000000f01', 'doc-o2', 'archived_document', '{"classifiedKind":"angebot","linkedOfferId":"o-2"}'::jsonb),
  ('00000000-0000-0000-0000-000000000f02', 'doc-fremdws', 'archived_document', '{"classifiedKind":"angebot","linkedOfferId":"o-1"}'::jsonb);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000abcd","role":"authenticated"}', true);

create function pg_temp.erwarte_fehler(p_label text, p_offer text, p_payload jsonb, p_version bigint, p_expected text)
returns void language plpgsql as $p$
begin
  begin
    perform public.upsert_workspace_sync_entity('00000000-0000-0000-0000-000000000f01', 'offer',
      jsonb_build_object('offer_id', p_offer, 'status', p_payload->>'status', 'payload', p_payload), p_version);
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
  ws constant uuid := '00000000-0000-0000-0000-000000000f01';
  basis constant jsonb := '{"customer":{"name":"K"},"title":"T","offerDate":"2026-09-21","validUntil":"2026-10-21","positions":[{"id":"p","description":"x","quantity":1,"unit":"Stück","unitPrice":10}],"taxStatus":"standard_19","totals":{"subtotal":10,"taxRate":19,"tax":1.9,"total":11.9},"createdAt":"2026-09-21T10:00:00.000Z"}'::jsonb;
  r jsonb;
  p1 jsonb;
  v1 bigint;
  p2 jsonb;
  v2 bigint;
begin
  /* ---------------- Freigabe ---------------- */
  r := public.finalize_workspace_offer(ws, 'o-1', basis || '{"id":"o-1"}', 'fp-1', 0);
  if r->'row'->>'offer_number' <> 'AN-2026-0001' or (r->>'replayed')::boolean then raise exception 'F1: %', r; end if;
  r := public.finalize_workspace_offer(ws, 'o-1', basis || '{"id":"o-1"}', 'fp-1', 0);
  if not (r->>'replayed')::boolean or r->'row'->>'offer_number' <> 'AN-2026-0001' then raise exception 'F2 Replay: %', r; end if;
  raise notice 'OK  F: Replay ohne zweite Nummer';
  begin
    perform public.finalize_workspace_offer(ws, 'o-1', basis || '{"id":"o-1"}', 'fp-anders', 0);
    raise exception 'F3 — kein Fehler bei anderem Fingerabdruck';
  exception when others then
    if position('bereits freigegeben' in sqlerrm) = 0 then raise; end if;
    raise notice 'OK  F3: %', sqlerrm;
  end;
  r := public.finalize_workspace_offer(ws, 'o-2', basis || '{"id":"o-2","title":"T2"}', 'fp-2', 0);
  if r->'row'->>'offer_number' <> 'AN-2026-0002' then raise exception 'F4: %', r; end if;

  select payload, row_version into p1, v1 from public.workspace_offers where workspace_id = ws and client_offer_id = 'o-1';
  select payload, row_version into p2, v2 from public.workspace_offers where workspace_id = ws and client_offer_id = 'o-2';

  /* ---------------- Archiv-Invariante ---------------- */
  perform pg_temp.erwarte_fehler('A1 unbekanntes Dokument', 'o-1', p1 || '{"archiveDocumentId":"doc-nix"}', v1, 'gehoert nicht zu diesem Angebot');
  perform pg_temp.erwarte_fehler('A2 Fremdworkspace',      'o-1', p1 || '{"archiveDocumentId":"doc-fremdws"}', v1, 'gehoert nicht zu diesem Angebot');
  perform pg_temp.erwarte_fehler('A3 falsche Art',         'o-1', p1 || '{"archiveDocumentId":"doc-fremdart"}', v1, 'gehoert nicht zu diesem Angebot');
  perform pg_temp.erwarte_fehler('A4 Dokument von o-2',    'o-1', p1 || '{"archiveDocumentId":"doc-o2"}', v1, 'gehoert nicht zu diesem Angebot');

  r := public.upsert_workspace_sync_entity(ws, 'offer', jsonb_build_object('offer_id', 'o-1', 'status', 'freigegeben', 'payload', p1 || '{"archiveDocumentId":"doc-eigen"}'), v1);
  if r->'payload'->>'archiveDocumentId' <> 'doc-eigen' then raise exception 'A5: Ablage nicht uebernommen %', r; end if;
  raise notice 'OK  A5: eigenes Dokument angenommen';
  select payload, row_version into p1, v1 from public.workspace_offers where workspace_id = ws and client_offer_id = 'o-1';

  perform pg_temp.erwarte_fehler('A6 Wechsel',            'o-1', p1 || '{"archiveDocumentId":"doc-o2"}', v1, 'kann nicht gewechselt werden');
  perform pg_temp.erwarte_fehler('A7 o-2 uebernimmt',     'o-2', p2 || '{"archiveDocumentId":"doc-eigen"}', v2, 'gehoert nicht zu diesem Angebot');

  perform public.upsert_workspace_sync_entity(ws, 'offer', '{"offer_id":"o-3","status":"entwurf","payload":{"id":"o-3","status":"entwurf"}}'::jsonb, 0);
  perform pg_temp.erwarte_fehler('A8 Entwurf mit Ablage', 'o-3', '{"id":"o-3","status":"entwurf","archiveDocumentId":"doc-eigen"}'::jsonb, 1, 'Entwurf hat keine Archivablage');

  raise notice 'ALLE ZUSICHERUNGEN ERFUELLT';
end $$;

rollback;
