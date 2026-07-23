-- CLOUD-ORDER-CHAIN-03A: Invoice cloud foundation
-- Atomic finalize (number + invoice row in one transaction). No separate number reservation.

create table if not exists public.workspace_invoice_sequences (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  invoice_year integer not null,
  last_sequence integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, invoice_year),
  constraint workspace_invoice_sequences_year_check check (invoice_year >= 2000 and invoice_year <= 2100),
  constraint workspace_invoice_sequences_last_sequence_check check (last_sequence >= 0)
);

create table if not exists public.workspace_invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  vorgang_id text not null,
  client_invoice_id text not null,
  invoice_number text not null,
  invoice_year integer not null,
  invoice_sequence_number integer not null,
  invoice_type text not null,
  invoice_status text not null,
  payload jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  constraint workspace_invoices_year_check check (invoice_year >= 2000 and invoice_year <= 2100),
  constraint workspace_invoices_sequence_check check (invoice_sequence_number > 0),
  constraint workspace_invoices_status_check check (
    invoice_status in ('entwurf', 'vorbereitet', 'versendet')
  ),
  constraint workspace_invoices_number_unique unique (workspace_id, invoice_number),
  constraint workspace_invoices_client_id_unique unique (workspace_id, client_invoice_id)
);

create index if not exists workspace_invoices_workspace_vorgang_idx
  on public.workspace_invoices (workspace_id, vorgang_id);

create index if not exists workspace_invoices_workspace_created_idx
  on public.workspace_invoices (workspace_id, created_at desc);

drop trigger if exists workspace_invoice_sequences_set_updated_at on public.workspace_invoice_sequences;
create trigger workspace_invoice_sequences_set_updated_at
before update on public.workspace_invoice_sequences
for each row
execute function public.set_workspace_updated_at();

drop trigger if exists workspace_invoices_set_updated_at on public.workspace_invoices;
create trigger workspace_invoices_set_updated_at
before update on public.workspace_invoices
for each row
execute function public.set_workspace_updated_at();

-- Normalize invoice JSON for idempotent content comparison (ignore assigned number fields + payments/PDF).
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
    - 'archive_document_id';
$$;

create or replace function public.format_workspace_invoice_number(p_year integer, p_sequence integer)
returns text
language sql
immutable
set search_path = public
as $$
  select p_year::text || '-' || lpad(p_sequence::text, 4, '0');
$$;

-- Atomic finalize: membership → idempotency → lock sequence → insert invoice → bump sequence.
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

  if nullif(trim(coalesce(p_vorgang_id, '')), '') is null then
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

  -- Idempotency: same client id returns existing row when content matches.
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

  -- Persist finalized invoice without payments / archive blob links.
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
      trim(p_vorgang_id),
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
      -- Concurrent insert with same client id: re-read and treat as idempotent replay if content matches.
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

-- RLS: select for members; no direct writes
alter table public.workspace_invoice_sequences enable row level security;
alter table public.workspace_invoices enable row level security;

drop policy if exists workspace_invoice_sequences_select_member on public.workspace_invoice_sequences;
create policy workspace_invoice_sequences_select_member
on public.workspace_invoice_sequences for select to authenticated
using (public.is_active_workspace_member(workspace_id));

drop policy if exists workspace_invoices_select_member on public.workspace_invoices;
create policy workspace_invoices_select_member
on public.workspace_invoices for select to authenticated
using (public.is_active_workspace_member(workspace_id));

revoke all on public.workspace_invoice_sequences from public, anon;
revoke all on public.workspace_invoices from public, anon;

grant select on public.workspace_invoice_sequences to authenticated;
grant select on public.workspace_invoices to authenticated;

revoke all on function public.normalize_workspace_invoice_payload_for_idempotency(jsonb) from public;
revoke all on function public.format_workspace_invoice_number(integer, integer) from public;
revoke all on function public.finalize_workspace_invoice(uuid, text, text, jsonb) from public;

grant execute on function public.finalize_workspace_invoice(uuid, text, text, jsonb) to authenticated;
