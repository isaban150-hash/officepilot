/*
 * STEUERBERATER & BUCHFUEHRUNGSINTELLIGENZ 02B — optionale Zahlungsart.
 *
 * Additiv und rueckwaertskompatibel:
 *   - neue Spalte `method` (bank | cash | other) an beiden Zahlungstabellen,
 *     NULL = nicht erfasst. Bestehende Zahlungen bleiben unveraendert gueltig;
 *     es wird KEIN Altwert erfunden (kein automatisches `bank`).
 *   - `add_workspace_invoice_payment` / `add_workspace_expense_payment` nehmen
 *     einen optionalen Parameter `p_method` (Default NULL). Die bisherige
 *     7-Parameter-Signatur wird entfernt, damit PostgREST nicht zwischen zwei
 *     Ueberladungen waehlen muss; alte Clients ohne `p_method` treffen die neue
 *     Funktion ueber den Default.
 *   - die Pull-Funktionen liefern `method` mit.
 *
 * Fachlich unveraendert: Pruefungen, Sperren, Idempotenz und Grabsteinvorrang.
 * Die Zahlungsart gehoert zur fachlichen Identitaet einer Zahlung (dieselbe
 * Kennung mit abweichender Zahlungsart ist ein Konflikt, keine stille Aenderung).
 *
 * Kein Kassenbuch, kein Bankabgleich — nur die Angabe, wie gezahlt wurde.
 */

alter table public.workspace_invoice_payments
  add column if not exists method text null;

alter table public.workspace_expense_payments
  add column if not exists method text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_invoice_payments_method_check'
  ) then
    alter table public.workspace_invoice_payments
      add constraint workspace_invoice_payments_method_check
      check (method is null or method in ('bank', 'cash', 'other'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_expense_payments_method_check'
  ) then
    alter table public.workspace_expense_payments
      add constraint workspace_expense_payments_method_check
      check (method is null or method in ('bank', 'cash', 'other'));
  end if;
end;
$$;

/* ------------------------------------------------------------------------ */
/* Rechnungszahlung                                                          */
/* ------------------------------------------------------------------------ */

drop function if exists public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text);

create or replace function public.add_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null
)
returns setof public.workspace_invoice_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice public.workspace_invoices;
  v_existing public.workspace_invoice_payments;
  v_inserted public.workspace_invoice_payments;
  v_invoice_id text;
  v_payment_id text;
  v_paid_on text;
  v_reference text;
  v_note text;
  v_method text;
  v_attempt int;
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

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  -- Kein Formatzwang: `pay-<millis>` und UUID sind beide gueltig.
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null then
    raise exception 'client_payment_id fehlt';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount ungueltig';
  end if;

  v_paid_on := nullif(trim(coalesce(p_paid_on, '')), '');
  if v_paid_on is null or v_paid_on !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'paid_on ungueltig';
  end if;
  -- Der echte Kalender: '2026-02-29' und '2026-04-31' existieren nicht.
  begin
    perform v_paid_on::date;
  exception
    when others then
      raise exception 'paid_on ungueltig';
  end;

  v_reference := nullif(trim(coalesce(p_reference, '')), '');
  v_note := nullif(trim(coalesce(p_note, '')), '');

  -- 02B — optionale Zahlungsart; NULL bleibt NULL.
  v_method := nullif(trim(coalesce(p_method, '')), '');
  if v_method is not null and v_method not in ('bank', 'cash', 'other') then
    raise exception 'method ungueltig';
  end if;

  -- Die Rechnung muss in der Cloud existieren und finalisiert sein.
  -- 01C: `for update` — gemeinsamer Serialisierungspunkt mit dem Storno.
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;
  if v_invoice.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;
  -- 01C: autoritative Spalte statt Payload.
  if v_invoice.cancelled_at is not null then
    raise exception 'Rechnung storniert';
  end if;

  -- Insert zuerst, pruefen danach (PAYMENT-SQL-CONCURRENCY-04B2B3).
  for v_attempt in 1..2 loop
    insert into public.workspace_invoice_payments (
      workspace_id, client_invoice_id, client_payment_id,
      amount, paid_on, reference, note, method, created_by
    )
    values (
      p_workspace_id, v_invoice_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_method, v_user_id
    )
    on conflict (workspace_id, client_invoice_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      if v_inserted.workspace_id is distinct from p_workspace_id
        or v_inserted.client_invoice_id is distinct from v_invoice_id
        or v_inserted.client_payment_id is distinct from v_payment_id
        or v_inserted.amount is distinct from round(p_amount, 2)
        or v_inserted.paid_on is distinct from v_paid_on::date
        or v_inserted.reference is distinct from v_reference
        or v_inserted.note is distinct from v_note
        or v_inserted.method is distinct from v_method
        or v_inserted.reversed_at is not null
      then
        raise exception 'Zahlung Nachbedingung verletzt';
      end if;

      return next v_inserted;
      return;
    end if;

    select * into v_existing
    from public.workspace_invoice_payments
    where workspace_id = p_workspace_id
      and client_invoice_id = v_invoice_id
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
        or v_existing.method is distinct from v_method
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

create or replace function public.pull_workspace_invoice_payments(
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
          'id', p.id,
          'workspace_id', p.workspace_id,
          'client_invoice_id', p.client_invoice_id,
          'client_payment_id', p.client_payment_id,
          'amount', p.amount,
          'paid_on', to_char(p.paid_on, 'YYYY-MM-DD'),
          'reference', p.reference,
          'note', p.note,
          'method', p.method,
          'created_at', p.created_at,
          'updated_at', p.updated_at,
          'row_version', p.row_version,
          'reversed_at', p.reversed_at
        )
        order by p.created_at asc
      )
      from public.workspace_invoice_payments p
      where p.workspace_id = p_workspace_id
        and (p_since is null or p.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;

/* ------------------------------------------------------------------------ */
/* Ausgabenzahlung                                                           */
/* ------------------------------------------------------------------------ */

drop function if exists public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text);

create or replace function public.add_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null
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
  v_method text;
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

  -- 02B — optionale Zahlungsart; NULL bleibt NULL.
  v_method := nullif(trim(coalesce(p_method, '')), '');
  if v_method is not null and v_method not in ('bank', 'cash', 'other') then
    raise exception 'method ungueltig';
  end if;

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
      amount, paid_on, reference, note, method, created_by
    ) values (
      p_workspace_id, v_expense_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_method, v_user_id
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
        or v_existing.method is distinct from v_method
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
        'method', p.method,
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

revoke all on function public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text) from public;
revoke all on function public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text) from public;
grant execute on function public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text) to authenticated;
grant execute on function public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text) to authenticated;
