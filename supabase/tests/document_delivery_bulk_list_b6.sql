-- E-MAIL-HALBZEIT-FIX B6 — Laufzeittest list_workspace_document_deliveries_for_documents.
--
-- Isoliert (Migrationen + Test in EINER Transaktion, am Ende Rollback):
--
--   { echo 'begin;'; \
--     cat supabase/migrations/20261010120000_workspace_document_delivery_send_hardening.sql; \
--     cat supabase/migrations/20261011120000_workspace_document_delivery_context.sql; \
--     cat supabase/migrations/20261013120000_workspace_document_delivery_bulk_list.sql; \
--     grep -v -x -e 'begin;' -e 'rollback;' supabase/tests/document_delivery_bulk_list_b6.sql; \
--     echo 'rollback;'; } \
--   | docker exec -i supabase_db_officepilot psql -U postgres -d postgres -v ON_ERROR_STOP=1
--
-- Nur lokal, niemals --linked oder remote. Exit-Code 0 = alle Zusicherungen erfuellt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'b6@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
       ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'b6-fremd@example.invalid', 'x', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.workspaces (id, name, owner_user_id)
values ('00000000-0000-0000-0000-0000000b6001', 'B6', '00000000-0000-0000-0000-0000000000b6'),
       ('00000000-0000-0000-0000-0000000b6002', 'B6-Fremd', '00000000-0000-0000-0000-0000000000b7');
insert into public.workspace_members (workspace_id, user_id, role, status)
values ('00000000-0000-0000-0000-0000000b6001', '00000000-0000-0000-0000-0000000000b6', 'owner', 'active'),
       ('00000000-0000-0000-0000-0000000b6002', '00000000-0000-0000-0000-0000000000b7', 'owner', 'active');

create function pg_temp.lieferung(
  p_ws text, p_id text, p_kind text, p_invoice text, p_document text,
  p_status text default 'failed', p_retry_of uuid default null, p_attempt integer default 1,
  p_customer text default null, p_vorgang text default null
) returns uuid language plpgsql as $p$
declare v_id uuid;
begin
  insert into public.workspace_document_deliveries (
    workspace_id, client_delivery_id, document_kind, linked_invoice_id, linked_document_id,
    recipient_email, subject, body_text, provider, status, requested_by, requested_at,
    provider_accepted_at, provider_message_id, failed_at, error_category,
    retry_of_delivery_id, attempt_number, customer_id, vorgang_id
  ) values (
    p_ws::uuid, p_id, p_kind, p_invoice, p_document,
    'kunde@example.invalid', 'S', 'B', 'stub', p_status, '00000000-0000-0000-0000-0000000000b6', now() - make_interval(mins => p_attempt),
    case when p_status = 'provider_accepted' then now() end, case when p_status = 'provider_accepted' then 'm-' || p_id end,
    case when p_status = 'failed' then now() end, case when p_status = 'failed' then 'provider' end,
    p_retry_of, p_attempt, p_customer, p_vorgang
  ) returning id into v_id;
  return v_id;
end;
$p$;

do $$
declare
  ws text := '00000000-0000-0000-0000-0000000b6001';
  fremd text := '00000000-0000-0000-0000-0000000b6002';
  a1 uuid; a2 uuid; a3 uuid; a4 uuid;
begin
  -- Mehrere Rechnungen (alt, ohne Kontext).
  perform pg_temp.lieferung(ws, 'r1', 'invoice', 'inv-1', null);
  perform pg_temp.lieferung(ws, 'r2', 'invoice', 'inv-2', null);
  perform pg_temp.lieferung(ws, 'r3', 'invoice_correction', 'inv-2', null);
  -- Mehrere Dokumente (alt, ohne customer_id/vorgang_id).
  perform pg_temp.lieferung(ws, 'd1', 'letter', null, 'doc-1');
  perform pg_temp.lieferung(ws, 'd2', 'offer', null, 'doc-2');
  -- 01J-artige Kette: vier Versuche, alt, ohne Kontext.
  a1 := pg_temp.lieferung(ws, '01j-1', 'letter', null, 'doc-01j', 'failed', null, 1);
  a2 := pg_temp.lieferung(ws, '01j-2', 'letter', null, 'doc-01j', 'failed', a1, 2);
  a3 := pg_temp.lieferung(ws, '01j-3', 'letter', null, 'doc-01j', 'failed', a2, 3);
  a4 := pg_temp.lieferung(ws, '01j-4', 'letter', null, 'doc-01j', 'provider_accepted', a3, 4);
  -- Neu (07C): mit gespeichertem Kontext.
  perform pg_temp.lieferung(ws, 'n1', 'letter', null, 'doc-neu', 'failed', null, 1, 'kunde-a', null);
  perform pg_temp.lieferung(ws, 'n2', 'invoice', 'inv-neu', null, 'failed', null, 1, null, 'vorgang-a');
  -- Nicht angefragte Dokumente desselben Workspaces.
  perform pg_temp.lieferung(ws, 'x1', 'letter', null, 'doc-anderes');
  -- Fremder Workspace mit GLEICHEN Kennungen.
  perform pg_temp.lieferung(fremd, 'f1', 'invoice', 'inv-1', null);
  perform pg_temp.lieferung(fremd, 'f2', 'letter', null, 'doc-01j');
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b6","role":"authenticated"}', true);

create function pg_temp.ids(p_invoice text[], p_document text[], p_ws text default '00000000-0000-0000-0000-0000000b6001')
returns text[] language sql as $p$
  select coalesce(array_agg(client_delivery_id order by client_delivery_id), '{}')
  from public.list_workspace_document_deliveries_for_documents(p_ws::uuid, p_invoice, p_document);
$p$;

create function pg_temp.erwarte_fehler(p_sql text, p_fragment text) returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(lower(p_fragment) in lower(sqlerrm)) = 0 then
      raise exception 'Falsche Fehlermeldung: % (erwartet: %)', sqlerrm, p_fragment;
    end if;
    return;
  end;
  raise exception 'Kein Fehler, erwartet: %', p_fragment;
end;
$p$;

do $$
declare
  v text[];
begin
  -- A: mehrere Rechnungen (inkl. Korrekturbeleg derselben Rechnung).
  v := pg_temp.ids(array['inv-1', 'inv-2'], '{}');
  if v <> array['r1', 'r2', 'r3'] then raise exception 'A: %', v; end if;
  -- B: mehrere Dokumente.
  v := pg_temp.ids('{}', array['doc-1', 'doc-2']);
  if v <> array['d1', 'd2'] then raise exception 'B: %', v; end if;
  -- C: gemischt; D/E alte Zeilen ohne Kontext kommen mit; F/G neue mit Kontext ebenso.
  v := pg_temp.ids(array['inv-1', 'inv-neu'], array['doc-1', 'doc-neu']);
  if v <> array['d1', 'n1', 'n2', 'r1'] then raise exception 'C-G: %', v; end if;
  -- H/J: 01J-Kette genau einmal je Versuch, nicht vervielfacht.
  v := pg_temp.ids('{}', array['doc-01j']);
  if v <> array['01j-1', '01j-2', '01j-3', '01j-4'] then raise exception 'H/J: %', v; end if;
  -- K: doppelte und leere Eingaben erzeugen keine Duplikate.
  v := pg_temp.ids(array['inv-1', 'inv-1', ' inv-1 ', '', null], array['doc-01j', 'doc-01j']);
  if v <> array['01j-1', '01j-2', '01j-3', '01j-4', 'r1'] then raise exception 'K: %', v; end if;
  -- Nur angefragte Kennungen: doc-anderes fehlt; fremder Workspace liefert trotz gleicher Kennung nichts.
  if 'x1' = any (pg_temp.ids(array['inv-1'], array['doc-1'])) then raise exception 'ungefragte Zeile'; end if;
  if exists (select 1 from unnest(pg_temp.ids(array['inv-1'], array['doc-01j'])) x where x like 'f%') then
    raise exception 'Cross-Workspace-Leak';
  end if;
  -- O: leere Mengen → leeres Ergebnis (auch null).
  if cardinality(pg_temp.ids('{}', '{}')) <> 0 or cardinality(pg_temp.ids(null, null)) <> 0 then raise exception 'O'; end if;
  -- N: Grenze 250 je Art; 250 geht, 251 nicht.
  v := pg_temp.ids((select array_agg('inv-' || g) from generate_series(1, 250) g), '{}');
  if v <> array['r1', 'r2', 'r3'] then raise exception 'N 250: %', v; end if;
  perform pg_temp.erwarte_fehler($q$select pg_temp.ids((select array_agg('inv-' || g) from generate_series(1, 251) g), '{}')$q$, 'Zu viele Kennungen');
  perform pg_temp.erwarte_fehler($q$select pg_temp.ids('{}', (select array_agg('doc-' || g) from generate_series(1, 251) g))$q$, 'Zu viele Kennungen');
  -- 251 Einträge, die nach Entdoppeln 1 ergeben, sind erlaubt.
  v := pg_temp.ids((select array_agg('inv-1'::text) from generate_series(1, 400) g), '{}');
  if v <> array['r1'] then raise exception 'N dedupe: %', v; end if;
  -- L: fremder Workspace wird abgelehnt.
  perform pg_temp.erwarte_fehler($q$select pg_temp.ids(array['inv-1'], '{}', '00000000-0000-0000-0000-0000000b6002')$q$, 'Kein Zugriff');
end;
$$;

-- M: nicht angemeldet wird abgelehnt.
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  perform pg_temp.erwarte_fehler($q$select pg_temp.ids(array['inv-1'], '{}')$q$, 'Nicht angemeldet');
end;
$$;

-- Rechte: nur authenticated, nicht anon/public; keine Datenänderung.
do $$
begin
  if not has_function_privilege('authenticated', 'public.list_workspace_document_deliveries_for_documents(uuid, text[], text[])', 'execute') then
    raise exception 'authenticated darf nicht ausfuehren';
  end if;
  if has_function_privilege('anon', 'public.list_workspace_document_deliveries_for_documents(uuid, text[], text[])', 'execute') then
    raise exception 'anon darf ausfuehren';
  end if;
  if (select provolatile from pg_proc where proname = 'list_workspace_document_deliveries_for_documents') <> 's' then
    raise exception 'Funktion ist nicht als lesend (stable) markiert';
  end if;
  if (select count(*) from public.workspace_document_deliveries where customer_id is not null or vorgang_id is not null) <> 2 then
    raise exception 'Daten wurden veraendert';
  end if;
end;
$$;

select 'B6 BULK SQL OK';

rollback;
