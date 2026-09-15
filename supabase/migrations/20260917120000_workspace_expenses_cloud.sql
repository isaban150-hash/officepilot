-- FINANZ-CORE-DURABILITY-01C — Ausgaben in die Cloud.
--
-- Bewusste Entwurfsentscheidungen:
--
--   * `workspace_expenses` traegt den Beleg (Kopf + Positionen + Zuordnungen)
--     als versionierte Zeile mit Grabstein — dasselbe Muster wie Vorgang/Kunde.
--     Zahlungen sind NICHT Teil des Payloads.
--
--   * `workspace_expense_payments` ist append-only mit Reversal, analog zu
--     `workspace_invoice_payments`: Ein Zahlungsarray im Payload waere
--     Last-Write-Wins und wuerde bei zwei Geraeten echte Geldbewegungen
--     verlieren. `Expense.payments[]` ist lokal nur noch Projektion.
--
--   * Finanzdaten sind owner/admin-Sache: Mitglieder (`member`) buchen nicht
--     und lesen keine Ausgaben (01B: Intake ja, Finanz nein).
--
--   * `expense_id` am Eingang wird serverseitig aus der Ausgabenzeile
--     abgeleitet (linked_inbox_id) — eine Wahrheit, kein zweiter Schreibpfad.

create table if not exists public.workspace_expenses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_expense_id text not null,
  status text not null default 'gebucht',
  dedupe_key text not null default '',
  linked_inbox_id text null,
  archive_document_id text null,
  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  row_version bigint not null default 1,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_expenses_status_check check (status in ('entwurf', 'gebucht', 'storniert')),
  constraint workspace_expenses_client_id_unique unique (workspace_id, client_expense_id)
);

create index if not exists workspace_expenses_updated_idx
  on public.workspace_expenses (workspace_id, updated_at desc);
create index if not exists workspace_expenses_inbox_idx
  on public.workspace_expenses (workspace_id, linked_inbox_id);

drop trigger if exists workspace_expenses_set_updated_at on public.workspace_expenses;
create trigger workspace_expenses_set_updated_at
before update on public.workspace_expenses
for each row execute function public.set_workspace_updated_at();

create table if not exists public.workspace_expense_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_expense_id text not null,
  client_payment_id text not null,
  amount numeric(14, 2) not null,
  paid_on date not null,
  reference text null,
  note text null,
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  reversed_at timestamptz null,
  reversed_by uuid null references auth.users (id) on delete set null,
  constraint workspace_expense_payments_amount_check check (amount > 0),
  constraint workspace_expense_payments_client_id_unique
    unique (workspace_id, client_expense_id, client_payment_id)
);

create index if not exists workspace_expense_payments_expense_idx
  on public.workspace_expense_payments (workspace_id, client_expense_id);

drop trigger if exists workspace_expense_payments_set_updated_at on public.workspace_expense_payments;
create trigger workspace_expense_payments_set_updated_at
before update on public.workspace_expense_payments
for each row execute function public.set_workspace_updated_at();

-- RLS: Lesen nur owner/admin; Schreiben ausschliesslich ueber die RPCs.
alter table public.workspace_expenses enable row level security;
alter table public.workspace_expense_payments enable row level security;

drop policy if exists workspace_expenses_select_writer on public.workspace_expenses;
create policy workspace_expenses_select_writer
on public.workspace_expenses for select to authenticated
using (public.can_write_workspace(workspace_id));

drop policy if exists workspace_expense_payments_select_writer on public.workspace_expense_payments;
create policy workspace_expense_payments_select_writer
on public.workspace_expense_payments for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_expenses from public, anon;
revoke all on public.workspace_expense_payments from public, anon;
grant select on public.workspace_expenses to authenticated;
grant select on public.workspace_expense_payments to authenticated;

/* -------------------------------------------------------------------------- */
/* Ausgabe anlegen / aktualisieren / Grabstein                                 */
/* -------------------------------------------------------------------------- */

create or replace function public.upsert_workspace_expense(
  p_workspace_id uuid,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_expense_id text;
  v_status text;
  v_deleted boolean;
  v_dedupe text;
  v_inbox text;
  v_archive text;
  v_payload jsonb;
  v_existing public.workspace_expenses;
  v_row public.workspace_expenses;
  v_active_payments int;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_payload->>'client_expense_id', '')), '');
  if v_expense_id is null then
    raise exception 'client_expense_id fehlt';
  end if;

  v_status := coalesce(nullif(p_payload->>'status', ''), 'gebucht');
  if v_status not in ('entwurf', 'gebucht', 'storniert') then
    raise exception 'Status ungueltig';
  end if;
  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_dedupe := coalesce(p_payload->>'dedupe_key', '');
  v_inbox := nullif(trim(coalesce(p_payload->>'linked_inbox_id', '')), '');
  v_archive := nullif(trim(coalesce(p_payload->>'archive_document_id', '')), '');
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;
  -- Zahlungen reisen nie im Payload — getrennte Wahrheit.
  v_payload := v_payload - 'payments' - 'sync';

  select * into v_existing
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
  for update;

  if v_existing.id is null then
    if v_deleted then
      -- Grabstein fuer eine Zeile, die die Cloud nie sah: nichts anzulegen.
      return jsonb_build_object('row_version', 0, 'updated_at', now(), 'deleted', true, 'noop', true);
    end if;
    insert into public.workspace_expenses (
      workspace_id, client_expense_id, status, dedupe_key, linked_inbox_id,
      archive_document_id, payload, deleted, row_version, created_by
    ) values (
      p_workspace_id, v_expense_id, v_status, v_dedupe, v_inbox,
      v_archive, v_payload, false, 1, v_user_id
    )
    returning * into v_row;
  else
    if v_existing.row_version <> coalesce(p_row_version, -1) then
      raise exception 'Versionskonflikt: Ausgabe % hat Version %, erwartet %',
        v_expense_id, v_existing.row_version, p_row_version;
    end if;
    if v_existing.deleted then
      raise exception 'Ausgabe bereits geloescht';
    end if;
    if v_deleted then
      select count(*) into v_active_payments
      from public.workspace_expense_payments
      where workspace_id = p_workspace_id
        and client_expense_id = v_expense_id
        and reversed_at is null;
      if v_active_payments > 0 then
        raise exception 'Ausgabe hat gebuchte Zahlungen';
      end if;
      update public.workspace_expenses
      set deleted = true,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    else
      update public.workspace_expenses
      set status = v_status,
          dedupe_key = v_dedupe,
          linked_inbox_id = v_inbox,
          archive_document_id = v_archive,
          payload = v_payload,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    end if;
  end if;

  /*
   * `expense_id` am Eingang — eine Wahrheit: die Ausgabenzeile. Ein alter
   * Verweis auf diese Ausgabe wird geloest, der aktuelle gesetzt.
   */
  update public.workspace_inbox_items
  set expense_id = null,
      row_version = row_version + 1,
      updated_at = now()
  where workspace_id = p_workspace_id
    and expense_id = v_expense_id
    and (v_row.deleted or client_inbox_id is distinct from v_row.linked_inbox_id);
  if not v_row.deleted and v_row.linked_inbox_id is not null then
    update public.workspace_inbox_items
    set expense_id = v_expense_id,
        row_version = row_version + 1,
        updated_at = now()
    where workspace_id = p_workspace_id
      and client_inbox_id = v_row.linked_inbox_id
      and expense_id is distinct from v_expense_id;
  end if;

  return jsonb_build_object(
    'row_version', v_row.row_version,
    'updated_at', v_row.updated_at,
    'deleted', v_row.deleted
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* Zahlung anlegen (idempotent) / stornieren                                   */
/* -------------------------------------------------------------------------- */

create or replace function public.add_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null
)
returns setof public.workspace_expense_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_expense public.workspace_expenses;
  v_existing public.workspace_expense_payments;
  v_inserted public.workspace_expense_payments;
  v_expense_id text;
  v_payment_id text;
  v_paid_on text;
  v_reference text;
  v_note text;
  v_attempt int;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_client_expense_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_expense_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount ungueltig';
  end if;
  v_paid_on := nullif(trim(coalesce(p_paid_on, '')), '');
  if v_paid_on is null or v_paid_on !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'paid_on ungueltig';
  end if;
  begin
    perform v_paid_on::date;
  exception
    when others then
      raise exception 'paid_on ungueltig';
  end;
  v_reference := nullif(trim(coalesce(p_reference, '')), '');
  v_note := nullif(trim(coalesce(p_note, '')), '');

  select * into v_expense
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id;
  if v_expense.id is null then
    raise exception 'Ausgabe nicht gefunden';
  end if;
  if v_expense.deleted then
    raise exception 'Ausgabe geloescht';
  end if;
  if v_expense.status = 'storniert' then
    raise exception 'Ausgabe storniert';
  end if;

  -- Insert zuerst, pruefen danach (siehe PAYMENT-SQL-CONCURRENCY-04B2B3).
  for v_attempt in 1..2 loop
    insert into public.workspace_expense_payments (
      workspace_id, client_expense_id, client_payment_id,
      amount, paid_on, reference, note, created_by
    ) values (
      p_workspace_id, v_expense_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_user_id
    )
    on conflict (workspace_id, client_expense_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      return next v_inserted;
      return;
    end if;

    select * into v_existing
    from public.workspace_expense_payments
    where workspace_id = p_workspace_id
      and client_expense_id = v_expense_id
      and client_payment_id = v_payment_id
    for update;

    if v_existing.id is not null then
      if v_existing.reversed_at is not null then
        raise exception 'Zahlungskonflikt: diese Zahlung wurde storniert';
      end if;
      if v_existing.amount is distinct from round(p_amount, 2)
        or v_existing.paid_on is distinct from v_paid_on::date
        or v_existing.reference is distinct from v_reference
        or v_existing.note is distinct from v_note
      then
        raise exception 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten';
      end if;
      return next v_existing;
      return;
    end if;
  end loop;

  raise exception 'Zahlung nicht angelegt';
end;
$$;

create or replace function public.reverse_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text
)
returns setof public.workspace_expense_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_expense_payments;
  v_updated public.workspace_expense_payments;
  v_expense_id text;
  v_payment_id text;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_client_expense_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_expense_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  select * into v_existing
  from public.workspace_expense_payments
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
    and client_payment_id = v_payment_id
  for update;

  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;
  if v_existing.reversed_at is not null then
    return next v_existing;
    return;
  end if;

  update public.workspace_expense_payments
  set reversed_at = now(),
      reversed_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return next v_updated;
end;
$$;

/* -------------------------------------------------------------------------- */
/* Pull                                                                       */
/* -------------------------------------------------------------------------- */

create or replace function public.pull_workspace_expenses(p_workspace_id uuid)
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return jsonb_build_object(
    'expenses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_expense_id', e.client_expense_id,
        'status', e.status,
        'dedupe_key', e.dedupe_key,
        'linked_inbox_id', e.linked_inbox_id,
        'archive_document_id', e.archive_document_id,
        'payload', e.payload,
        'deleted', e.deleted,
        'row_version', e.row_version,
        'updated_at', e.updated_at
      ) order by e.updated_at asc)
      from public.workspace_expenses e
      where e.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_expense_id', p.client_expense_id,
        'client_payment_id', p.client_payment_id,
        'amount', p.amount,
        'paid_on', to_char(p.paid_on, 'YYYY-MM-DD'),
        'reference', p.reference,
        'note', p.note,
        'created_at', p.created_at,
        'row_version', p.row_version,
        'reversed_at', p.reversed_at
      ) order by p.created_at asc)
      from public.workspace_expense_payments p
      where p.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.upsert_workspace_expense(uuid, jsonb, bigint) from public;
revoke all on function public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text) from public;
revoke all on function public.reverse_workspace_expense_payment(uuid, text, text) from public;
revoke all on function public.pull_workspace_expenses(uuid) from public;

grant execute on function public.upsert_workspace_expense(uuid, jsonb, bigint) to authenticated;
grant execute on function public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.reverse_workspace_expense_payment(uuid, text, text) to authenticated;
grant execute on function public.pull_workspace_expenses(uuid) to authenticated;
