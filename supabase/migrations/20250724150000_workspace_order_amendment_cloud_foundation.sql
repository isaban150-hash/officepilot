-- ORDER-AMENDMENT-01B1: Server-authoritative confirmed order amendments
-- Table + confirm RPC + pull RPC + shared vorgang lock + finalize_workspace_invoice hardening.
-- Does NOT alter previously applied migration files.

-- ---------------------------------------------------------------------------
-- 1) Table: confirmed amendments only (drafts stay local on Vorgang.orderAmendments)
-- ---------------------------------------------------------------------------
create table if not exists public.workspace_order_amendments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  vorgang_id text not null,
  client_amendment_id text not null,
  sequence_no integer not null,
  status text not null,
  content_fingerprint text not null,
  payload jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz not null default timezone('utc', now()),
  confirmed_by uuid not null references auth.users (id) on delete restrict,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_order_amendments_status_check check (status = 'bestaetigt'),
  constraint workspace_order_amendments_sequence_positive check (sequence_no > 0),
  constraint workspace_order_amendments_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint workspace_order_amendments_client_id_unique unique (workspace_id, client_amendment_id),
  constraint workspace_order_amendments_sequence_unique unique (workspace_id, vorgang_id, sequence_no),
  constraint workspace_order_amendments_vorgang_fk
    foreign key (workspace_id, vorgang_id)
    references public.workspace_vorgaenge (workspace_id, vorgang_id)
);

create index if not exists workspace_order_amendments_workspace_vorgang_idx
  on public.workspace_order_amendments (workspace_id, vorgang_id);

create index if not exists workspace_order_amendments_workspace_vorgang_sequence_idx
  on public.workspace_order_amendments (workspace_id, vorgang_id, sequence_no);

create index if not exists workspace_order_amendments_workspace_updated_idx
  on public.workspace_order_amendments (workspace_id, updated_at);

drop trigger if exists workspace_order_amendments_set_updated_at on public.workspace_order_amendments;
create trigger workspace_order_amendments_set_updated_at
before update on public.workspace_order_amendments
for each row
execute function public.set_workspace_updated_at();

-- Write-once: block direct mutation of confirmed rows (RPC inserts only).
create or replace function public.prevent_workspace_order_amendment_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'workspace_order_amendments are write-once';
end;
$$;

drop trigger if exists workspace_order_amendments_write_once on public.workspace_order_amendments;
create trigger workspace_order_amendments_write_once
before update or delete on public.workspace_order_amendments
for each row
execute function public.prevent_workspace_order_amendment_mutation();

alter table public.workspace_order_amendments enable row level security;

drop policy if exists workspace_order_amendments_select_member on public.workspace_order_amendments;
create policy workspace_order_amendments_select_member
on public.workspace_order_amendments for select to authenticated
using (public.is_active_workspace_member(workspace_id));

revoke all on public.workspace_order_amendments from public, anon;
grant select on public.workspace_order_amendments to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Canonical payload / fingerprint helpers
-- ---------------------------------------------------------------------------
create or replace function public.build_workspace_order_amendment_canonical_content(
  p_vorgang_id text,
  p_title text,
  p_reason text,
  p_positions jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'vorgang_id', p_vorgang_id,
    'title', p_title,
    'reason', to_jsonb(p_reason),
    'positions', coalesce(p_positions, '[]'::jsonb)
  );
$$;

create or replace function public.fingerprint_workspace_order_amendment_canonical(p_canonical jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  -- jsonb::text sorts object keys; array order is preserved (contract content).
  select md5(coalesce(p_canonical, '{}'::jsonb)::text);
$$;

-- Strip RPC meta fields that must never become stored invoice content.
create or replace function public.normalize_workspace_invoice_payload_for_idempotency(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(p_payload, '{}'::jsonb)
    - 'number'
    - 'invoiceSequenceNumber'
    - 'invoice_sequence_number'
    - 'payments'
    - 'paymentStatus'
    - 'payment_status'
    - 'archiveDocumentId'
    - 'archive_document_id'
    - 'expectedAmendmentSequence'
    - 'expected_amendment_sequence';
$$;

-- ---------------------------------------------------------------------------
-- 3) confirm_workspace_order_amendment
-- ---------------------------------------------------------------------------
create or replace function public.confirm_workspace_order_amendment(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_amendment_id text,
  p_amendment jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_vorgang public.workspace_vorgaenge;
  v_existing public.workspace_order_amendments;
  v_vorgang_id text;
  v_client_id text;
  v_title text;
  v_reason text;
  v_positions jsonb;
  v_normalized_positions jsonb := '[]'::jsonb;
  v_canonical jsonb;
  v_fingerprint text;
  v_contract jsonb;
  v_snapshot_positions jsonb;
  v_snapshot_ids text[] := array[]::text[];
  v_existing_ids text[] := array[]::text[];
  v_seen_ids text[] := array[]::text[];
  v_pos jsonb;
  v_pos_id text;
  v_change_type text;
  v_parent_id text;
  v_description text;
  v_unit text;
  v_unit_label text;
  v_category text;
  v_planned_quantity numeric;
  v_unit_price numeric;
  v_billable boolean;
  v_normalized_pos jsonb;
  v_next_sequence integer;
  v_has_final_schluss boolean;
  v_has_existing boolean := false;
  v_allowed_units text[] := array['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
  i integer;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');
  if v_vorgang_id is null then
    raise exception 'order_amendment_vorgang_not_found';
  end if;

  v_client_id := nullif(trim(coalesce(p_client_amendment_id, '')), '');
  if v_client_id is null then
    raise exception 'order_amendment_invalid_position';
  end if;

  if p_amendment is null or jsonb_typeof(p_amendment) <> 'object' then
    raise exception 'order_amendment_invalid_position';
  end if;

  -- Lock order: workspace_vorgaenge first (shared with finalize_workspace_invoice).
  select *
  into v_vorgang
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id
    and v.vorgang_id = v_vorgang_id
  for update;

  if not found or v_vorgang.deleted then
    raise exception 'order_amendment_vorgang_not_found';
  end if;

  v_contract := v_vorgang.payload->'contractConfirmation';
  if v_contract is null or jsonb_typeof(v_contract) <> 'object' then
    raise exception 'order_amendment_contract_confirmation_missing';
  end if;

  v_snapshot_positions := coalesce(v_contract->'positions', '[]'::jsonb);
  if jsonb_typeof(v_snapshot_positions) <> 'array' then
    raise exception 'order_amendment_contract_confirmation_missing';
  end if;

  select coalesce(array_agg(nullif(trim(p->>'id'), '')), array[]::text[])
  into v_snapshot_ids
  from jsonb_array_elements(v_snapshot_positions) as p
  where nullif(trim(p->>'id'), '') is not null;

  -- Lock existing row early (idempotency before schluss guard).
  select *
  into v_existing
  from public.workspace_order_amendments a
  where a.workspace_id = p_workspace_id
    and a.client_amendment_id = v_client_id
  for update;
  v_has_existing := found;

  v_title := nullif(trim(coalesce(p_amendment->>'title', '')), '');
  v_reason := nullif(trim(coalesce(p_amendment->>'reason', '')), '');
  v_positions := p_amendment->'positions';

  if v_title is null then
    raise exception 'order_amendment_invalid_position';
  end if;
  if v_positions is null or jsonb_typeof(v_positions) <> 'array' or jsonb_array_length(v_positions) < 1 then
    raise exception 'order_amendment_invalid_position';
  end if;

  for i in 0 .. jsonb_array_length(v_positions) - 1 loop
    v_pos := v_positions->i;
    if v_pos is null or jsonb_typeof(v_pos) <> 'object' then
      raise exception 'order_amendment_invalid_position';
    end if;

    v_pos_id := nullif(trim(coalesce(v_pos->>'id', '')), '');
    v_change_type := nullif(trim(coalesce(v_pos->>'changeType', '')), '');
    v_parent_id := nullif(trim(coalesce(v_pos->>'parentPositionId', '')), '');
    v_description := nullif(trim(coalesce(v_pos->>'description', '')), '');
    v_unit := nullif(trim(coalesce(v_pos->>'unit', '')), '');
    v_unit_label := nullif(trim(coalesce(v_pos->>'unitLabel', '')), '');
    v_category := nullif(trim(coalesce(v_pos->>'category', '')), '');

    if v_pos_id is null or v_change_type is null or v_description is null or v_unit is null then
      raise exception 'order_amendment_invalid_position';
    end if;

    if v_change_type not in ('add', 'quantity_increase') then
      raise exception 'order_amendment_invalid_position';
    end if;

    if not (v_unit = any (v_allowed_units)) then
      raise exception 'order_amendment_invalid_position';
    end if;

    begin
      v_planned_quantity := (v_pos->>'plannedQuantity')::numeric;
    exception
      when others then
        raise exception 'order_amendment_invalid_position';
    end;
    if v_planned_quantity is null
       or v_planned_quantity <= 0
       or v_planned_quantity = 'NaN'::numeric
       or v_planned_quantity = 'Infinity'::numeric
       or v_planned_quantity = '-Infinity'::numeric then
      raise exception 'order_amendment_invalid_position';
    end if;

    begin
      v_unit_price := (v_pos->>'unitPrice')::numeric;
    exception
      when others then
        raise exception 'order_amendment_invalid_position';
    end;
    if v_unit_price is null
       or v_unit_price < 0
       or v_unit_price = 'NaN'::numeric
       or v_unit_price = 'Infinity'::numeric
       or v_unit_price = '-Infinity'::numeric then
      raise exception 'order_amendment_invalid_position';
    end if;

    if v_pos ? 'billable' and jsonb_typeof(v_pos->'billable') = 'boolean' then
      v_billable := (v_pos->>'billable')::boolean;
    else
      v_billable := null;
    end if;

    -- 01A rules: add forbids parentPositionId; quantity_increase requires parent in Hauptsnapshot.
    -- unit/category/billable are NOT required to match parent (01A only prefills, does not enforce).
    if v_change_type = 'add' then
      if v_parent_id is not null then
        raise exception 'order_amendment_invalid_position';
      end if;
    elsif v_change_type = 'quantity_increase' then
      if v_parent_id is null then
        raise exception 'order_amendment_parent_position_not_found';
      end if;
      if not (v_parent_id = any (v_snapshot_ids)) then
        raise exception 'order_amendment_parent_position_not_found';
      end if;
    end if;

    if v_pos_id = any (v_seen_ids) then
      raise exception 'order_amendment_position_id_conflict';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_pos_id);

    v_normalized_pos := jsonb_build_object(
      'id', v_pos_id,
      'changeType', v_change_type,
      'parentPositionId', to_jsonb(v_parent_id),
      'description', v_description,
      'plannedQuantity', v_planned_quantity,
      'unit', v_unit,
      'unitLabel', to_jsonb(v_unit_label),
      'unitPrice', v_unit_price,
      'category', to_jsonb(v_category),
      'billable', to_jsonb(v_billable)
    );
    v_normalized_positions := v_normalized_positions || jsonb_build_array(v_normalized_pos);
  end loop;

  v_canonical := public.build_workspace_order_amendment_canonical_content(
    v_vorgang_id,
    v_title,
    v_reason,
    v_normalized_positions
  );
  v_fingerprint := public.fingerprint_workspace_order_amendment_canonical(v_canonical);

  -- Idempotency before schluss guard (retry after lost response + later schluss).
  if v_has_existing then
    if v_existing.vorgang_id is distinct from v_vorgang_id
       or v_existing.content_fingerprint is distinct from v_fingerprint then
      raise exception 'order_amendment_idempotency_conflict';
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'amendment', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  -- Final Schlussrechnung blocks NEW confirms only (after idempotency).
  select exists (
    select 1
    from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id
      and wi.vorgang_id = v_vorgang_id
      and wi.invoice_type = 'schluss'
      and wi.invoice_status in ('vorbereitet', 'versendet')
  )
  into v_has_final_schluss;

  if coalesce(v_has_final_schluss, false) then
    raise exception 'order_amendment_final_invoice_exists';
  end if;

  -- Position id collisions against snapshot + previously confirmed amendments.
  select coalesce(array_agg(distinct nullif(trim(pos->>'id'), '')), array[]::text[])
  into v_existing_ids
  from public.workspace_order_amendments a
  cross join lateral jsonb_array_elements(coalesce(a.payload->'positions', '[]'::jsonb)) as pos
  where a.workspace_id = p_workspace_id
    and a.vorgang_id = v_vorgang_id
    and nullif(trim(pos->>'id'), '') is not null;

  for i in 1 .. coalesce(array_length(v_seen_ids, 1), 0) loop
    if v_seen_ids[i] = any (v_snapshot_ids) or v_seen_ids[i] = any (v_existing_ids) then
      raise exception 'order_amendment_position_id_conflict';
    end if;
  end loop;

  select coalesce(max(a.sequence_no), 0) + 1
  into v_next_sequence
  from public.workspace_order_amendments a
  where a.workspace_id = p_workspace_id
    and a.vorgang_id = v_vorgang_id;

  insert into public.workspace_order_amendments (
    workspace_id,
    vorgang_id,
    client_amendment_id,
    sequence_no,
    status,
    content_fingerprint,
    payload,
    confirmed_at,
    confirmed_by,
    row_version
  )
  values (
    p_workspace_id,
    v_vorgang_id,
    v_client_id,
    v_next_sequence,
    'bestaetigt',
    v_fingerprint,
    jsonb_build_object(
      'title', v_title,
      'reason', to_jsonb(v_reason),
      'positions', v_normalized_positions,
      'clientAmendmentId', v_client_id,
      'vorgangId', v_vorgang_id,
      'sequenceNo', v_next_sequence
    ),
    timezone('utc', now()),
    v_user_id,
    1
  )
  returning * into v_existing;

  return jsonb_build_object(
    'idempotent_replay', false,
    'amendment', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) pull_workspace_order_amendments
-- ---------------------------------------------------------------------------
create or replace function public.pull_workspace_order_amendments(
  p_workspace_id uuid,
  p_since timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'workspace_id', a.workspace_id,
          'vorgang_id', a.vorgang_id,
          'client_amendment_id', a.client_amendment_id,
          'sequence_no', a.sequence_no,
          'status', a.status,
          'content_fingerprint', a.content_fingerprint,
          'payload', a.payload,
          'confirmed_at', a.confirmed_at,
          'confirmed_by', a.confirmed_by,
          'row_version', a.row_version,
          'created_at', a.created_at,
          'updated_at', a.updated_at
        )
        order by a.vorgang_id asc, a.sequence_no asc, a.client_amendment_id asc
      )
      from public.workspace_order_amendments a
      where a.workspace_id = p_workspace_id
        and a.status = 'bestaetigt'
        and (p_since is null or a.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Harden finalize_workspace_invoice (same signature; no overloads)
-- Lock order: vorgang FOR UPDATE → invoice FOR UPDATE → sequence FOR UPDATE
-- Schluss: expectedAmendmentSequence meta (default 0) must match max(sequence_no)
-- ---------------------------------------------------------------------------
create or replace function public.finalize_workspace_invoice(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_year integer;
  v_next_sequence integer;
  v_invoice_number text;
  v_invoice_type text;
  v_payload jsonb;
  v_normalized_incoming jsonb;
  v_normalized_existing jsonb;
  v_issue_date text;
  v_vorgang_id text;
  v_vorgang public.workspace_vorgaenge;
  v_current_amendment_sequence integer;
  v_expected_amendment_sequence integer;
  v_expected_camel jsonb;
  v_expected_snake jsonb;
  v_has_expected_camel boolean := false;
  v_has_expected_snake boolean := false;
  v_parsed_camel integer;
  v_parsed_snake integer;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');
  if v_vorgang_id is null then
    raise exception 'vorgang_id fehlt';
  end if;

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  if p_invoice is null or jsonb_typeof(p_invoice) <> 'object' then
    raise exception 'invoice payload fehlt';
  end if;

  if jsonb_typeof(coalesce(p_invoice->'positions', 'null'::jsonb)) <> 'array' then
    raise exception 'invoice positions fehlen';
  end if;

  v_invoice_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  if v_invoice_type is null then
    raise exception 'invoice type fehlt';
  end if;

  -- Shared lock with confirm_workspace_order_amendment (first).
  select *
  into v_vorgang
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id
    and v.vorgang_id = v_vorgang_id
  for update;

  if not found or v_vorgang.deleted then
    raise exception 'Vorgang gehört nicht zum Workspace oder existiert nicht';
  end if;

  select *
  into v_existing
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id)
  for update;

  if found then
    v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
    v_normalized_incoming := public.normalize_workspace_invoice_payload_for_idempotency(
      coalesce(p_invoice, '{}'::jsonb)
      || jsonb_build_object(
        'id', trim(p_client_invoice_id),
        'status', 'vorbereitet'
      )
    );
    if v_normalized_existing is distinct from v_normalized_incoming then
      raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'invoice', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  -- New Schluss only: amendment revision must match client expectation (default 0).
  -- Meta fields must agree when both are present; invalid values → invoice_amendment_state_stale.
  -- Runs after idempotent replay and before sequence lock / invoice insert.
  if v_invoice_type = 'schluss' then
    select coalesce(max(a.sequence_no), 0)
    into v_current_amendment_sequence
    from public.workspace_order_amendments a
    where a.workspace_id = p_workspace_id
      and a.vorgang_id = v_vorgang_id;

    v_has_expected_camel :=
      (p_invoice ? 'expectedAmendmentSequence')
      and jsonb_typeof(p_invoice->'expectedAmendmentSequence') is distinct from 'null';
    v_has_expected_snake :=
      (p_invoice ? 'expected_amendment_sequence')
      and jsonb_typeof(p_invoice->'expected_amendment_sequence') is distinct from 'null';

    if v_has_expected_camel then
      v_expected_camel := p_invoice->'expectedAmendmentSequence';
      if jsonb_typeof(v_expected_camel) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_camel::text)::numeric < 0
         or (v_expected_camel::text)::numeric <> trunc((v_expected_camel::text)::numeric)
         or (v_expected_camel::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_camel := ((v_expected_camel::text)::numeric)::integer;
    end if;

    if v_has_expected_snake then
      v_expected_snake := p_invoice->'expected_amendment_sequence';
      if jsonb_typeof(v_expected_snake) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_snake::text)::numeric < 0
         or (v_expected_snake::text)::numeric <> trunc((v_expected_snake::text)::numeric)
         or (v_expected_snake::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_snake := ((v_expected_snake::text)::numeric)::integer;
    end if;

    if v_has_expected_camel and v_has_expected_snake then
      if v_parsed_camel is distinct from v_parsed_snake then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_camel then
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_snake then
      v_expected_amendment_sequence := v_parsed_snake;
    else
      v_expected_amendment_sequence := 0;
    end if;

    if v_current_amendment_sequence is distinct from v_expected_amendment_sequence then
      raise exception 'invoice_amendment_state_stale';
    end if;
  end if;

  v_issue_date := coalesce(
    nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''),
    nullif(trim(coalesce(p_invoice->>'date', '')), ''),
    to_char(timezone('utc', now()), 'YYYY-MM-DD')
  );
  begin
    v_year := extract(year from v_issue_date::date)::integer;
  exception
    when others then
      v_year := extract(year from timezone('utc', now()))::integer;
  end;

  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select s.last_sequence
  into v_next_sequence
  from public.workspace_invoice_sequences s
  where s.workspace_id = p_workspace_id
    and s.invoice_year = v_year
  for update;

  if v_next_sequence is null then
    raise exception 'Nummernkreis konnte nicht gesperrt werden';
  end if;

  v_next_sequence := v_next_sequence + 1;
  v_invoice_number := public.format_workspace_invoice_number(v_year, v_next_sequence);

  v_payload := public.normalize_workspace_invoice_payload_for_idempotency(p_invoice)
    || jsonb_build_object(
      'id', trim(p_client_invoice_id),
      'number', v_invoice_number,
      'invoiceSequenceNumber', v_next_sequence,
      'type', v_invoice_type,
      'status', 'vorbereitet',
      'date', v_issue_date,
      'issueDate', coalesce(nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''), v_issue_date)
    );

  begin
    insert into public.workspace_invoices (
      workspace_id,
      vorgang_id,
      client_invoice_id,
      invoice_number,
      invoice_year,
      invoice_sequence_number,
      invoice_type,
      invoice_status,
      payload,
      row_version,
      updated_by
    )
    values (
      p_workspace_id,
      v_vorgang_id,
      trim(p_client_invoice_id),
      v_invoice_number,
      v_year,
      v_next_sequence,
      v_invoice_type,
      'vorbereitet',
      v_payload,
      1,
      v_user_id
    )
    returning * into v_existing;
  exception
    when unique_violation then
      select *
      into v_existing
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.client_invoice_id = trim(p_client_invoice_id);

      if not found then
        raise;
      end if;

      v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
      v_normalized_incoming := public.normalize_workspace_invoice_payload_for_idempotency(
        coalesce(p_invoice, '{}'::jsonb)
        || jsonb_build_object(
          'id', trim(p_client_invoice_id),
          'status', 'vorbereitet'
        )
      );
      if v_normalized_existing is distinct from v_normalized_incoming then
        raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
      end if;

      return jsonb_build_object(
        'idempotent_replay', true,
        'invoice', v_existing.payload,
        'row', to_jsonb(v_existing)
      );
  end;

  update public.workspace_invoice_sequences
  set last_sequence = v_next_sequence
  where workspace_id = p_workspace_id
    and invoice_year = v_year
    and last_sequence = v_next_sequence - 1;

  if not found then
    raise exception 'Nummernkreis konnte nicht erhöht werden';
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'invoice', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

revoke all on function public.build_workspace_order_amendment_canonical_content(text, text, text, jsonb) from public;
revoke all on function public.fingerprint_workspace_order_amendment_canonical(jsonb) from public;
revoke all on function public.prevent_workspace_order_amendment_mutation() from public;
revoke all on function public.confirm_workspace_order_amendment(uuid, text, text, jsonb) from public;
revoke all on function public.pull_workspace_order_amendments(uuid, timestamptz) from public;
revoke all on function public.finalize_workspace_invoice(uuid, text, text, jsonb) from public;

grant execute on function public.confirm_workspace_order_amendment(uuid, text, text, jsonb) to authenticated;
grant execute on function public.pull_workspace_order_amendments(uuid, timestamptz) to authenticated;
grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb) to authenticated;
