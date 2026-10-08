/*
 * P1 MITARBEITERZAHLUNGEN — Mitarbeiter und Zahlungen an Mitarbeiter.
 *
 * ZWEI WAHRHEITEN, ZWEI TABELLEN
 *
 *  - `workspace_employees` — schlanker Stammsatz: Name, optional Personalnummer,
 *    aktiv/inaktiv. Kein Benutzerkonto, kein Workspace-Mitglied, keine Rolle;
 *    es gibt bewusst keine Spalte, die dorthin verweist. Versionierte Zeile,
 *    kein Löschen: Ein Mitarbeiter mit Zahlungshistorie bleibt als Bezug
 *    erhalten und wird nur deaktiviert.
 *  - `workspace_employee_payments` — die einzige Wahrheit einer Zahlung an einen
 *    Mitarbeiter. Append-only mit weichem Storno (`reversed_at`). Die Geldfelder
 *    sind nach dem Anlegen unveränderlich; geändert werden nur der Nachweis
 *    (`proof_document_id`, geldfrei) und genau einmal die erzeugte Quittung
 *    (`receipt_document_id`). Die Zahlung erzeugt keine Ausgabe, keine
 *    Ausgabenzahlung, keine Buchung und keine Bankzuordnung.
 *
 * SICHERHEIT
 *
 *  - Lesen nur Inhaber/Verwaltung (`can_write_workspace`) — Personal- und
 *    Zahlungsdaten gehören nicht in den Blick eines Mitglieds.
 *  - Schreiben ausschliesslich über die Funktionen dieser Datei. Jede beginnt
 *    mit `assert_financial_action_allowed` (Rolle, Freigabe, Lizenz).
 *  - Bewusst **nicht** über den generischen Dispatcher und **nicht** im
 *    generischen Abzug: Jener kennt keinen Finanzschutz und liefert an alle
 *    Mitglieder aus.
 *
 * IDEMPOTENZ
 *
 *  - Zahlung: Kennung des Bestätigungsvorgangs (`client_payment_id`). Dieselbe
 *    Kennung mit denselben Werten ist ein Replay; mit anderen Werten ein
 *    `Zahlungskonflikt`. Insert zuerst, Prüfung danach.
 *  - Referenz `MZ-YYYYMMDD-XXXXXXXX`: vom Client deterministisch gebildet,
 *    hier auf Form und Datum geprüft und innerhalb des Workspace eindeutig.
 *  - Mitarbeiter: Basisversion. 0 ist die Anlage; trifft sie eine vorhandene
 *    Zeile mit identischem Inhalt, ist es ein Replay, sonst ein Konflikt.
 *
 * DOKUMENTSCHUTZ
 *
 * `assert_document_not_payment_proof` und `is_workspace_document_payment_proof`
 * werden wörtlich in ihrer geltenden Fassung (20261029120000) neu angelegt und
 * um die Mitarbeiterzahlungen ergänzt: Quittung und Nachweis sind geschützt —
 * auch bei stornierten Zahlungen, sie bleiben Prüfspur.
 *
 * DATENSCHUTZ DER BELEGE
 *
 * Quittung und unterschriebener Nachweis sind Personaldaten. Sobald ein
 * Dokument Quittung oder Nachweis einer Zahlung ist — oder dafür bestimmt:
 * `emp-receipt-<Zahlung>`, Ordner `/Mitarbeiter/Zahlungsnachweise/` —, lesen
 * es serverseitig nur noch Inhaber und Verwaltung, mit allem, was seinen
 * Inhalt trägt (Dateien, Zuordnungen, Eingang, Analyse, Papierregister,
 * Kommunikation, Versand), über Tabelle, Abzug, RPC und Dateispeicher. Ein
 * dauerhafter Schutzeintrag (`workspace_restricted_documents`) hält den
 * Schutz auch nach Storno und Nachweiswechsel. Abschnitt „Datenschutz" unten.
 */

/* ------------------------------------------------------------------------ */
/* Tabellen                                                                  */
/* ------------------------------------------------------------------------ */

create table if not exists public.workspace_employees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_employee_id text not null,
  name text not null,
  personnel_number text null,
  active boolean not null default true,
  row_version bigint not null default 1,
  created_by uuid null references auth.users (id) on delete set null,
  updated_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_employees_client_id_unique unique (workspace_id, client_employee_id),
  constraint workspace_employees_client_id_check check (char_length(client_employee_id) between 1 and 200),
  constraint workspace_employees_name_check check (char_length(btrim(name)) between 1 and 120),
  constraint workspace_employees_personnel_number_check
    check (personnel_number is null or char_length(btrim(personnel_number)) between 1 and 40)
);

create unique index if not exists workspace_employees_personnel_number_unique
  on public.workspace_employees (workspace_id, lower(personnel_number))
  where personnel_number is not null;

drop trigger if exists workspace_employees_set_updated_at on public.workspace_employees;
create trigger workspace_employees_set_updated_at
before update on public.workspace_employees
for each row execute function public.set_workspace_updated_at();

create table if not exists public.workspace_employee_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_payment_id text not null,
  client_employee_id text not null,
  employee_name text not null,
  personnel_number text null,
  kind text not null,
  amount numeric(14, 2) not null,
  paid_on date not null,
  method text not null,
  wage_month text null,
  purpose text null,
  note text null,
  receipt_reference text not null,
  paid_by_name text null,
  receipt_document_id text null,
  proof_document_id text null,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  reversed_at timestamptz null,
  reversed_by uuid null references auth.users (id) on delete set null,
  reversal_reason text null,
  constraint workspace_employee_payments_client_id_unique unique (workspace_id, client_payment_id),
  constraint workspace_employee_payments_reference_unique unique (workspace_id, receipt_reference),
  constraint workspace_employee_payments_employee_fk
    foreign key (workspace_id, client_employee_id)
    references public.workspace_employees (workspace_id, client_employee_id)
    on delete restrict,
  constraint workspace_employee_payments_client_id_check check (char_length(client_payment_id) between 1 and 200),
  constraint workspace_employee_payments_amount_check check (amount > 0 and amount <= 9999999.99),
  constraint workspace_employee_payments_kind_check
    check (kind in ('wage', 'advance', 'reimbursement', 'travel', 'other')),
  constraint workspace_employee_payments_method_check check (method in ('cash', 'bank', 'other')),
  constraint workspace_employee_payments_wage_month_check
    check (wage_month is null or (kind = 'wage' and wage_month ~ '^\d{4}-(0[1-9]|1[0-2])$')),
  constraint workspace_employee_payments_other_note_check
    check (kind <> 'other' or char_length(btrim(coalesce(note, ''))) > 0),
  constraint workspace_employee_payments_reference_check
    check (receipt_reference ~ '^MZ-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$'),
  constraint workspace_employee_payments_reversal_check
    check (
      (reversed_at is null and reversal_reason is null)
      or (reversed_at is not null and char_length(btrim(coalesce(reversal_reason, ''))) between 3 and 300)
    ),
  constraint workspace_employee_payments_receipt_cash_check
    check (receipt_document_id is null or method = 'cash')
);

create index if not exists workspace_employee_payments_employee_idx
  on public.workspace_employee_payments (workspace_id, client_employee_id);
create index if not exists workspace_employee_payments_receipt_doc_idx
  on public.workspace_employee_payments (workspace_id, receipt_document_id)
  where receipt_document_id is not null;
create index if not exists workspace_employee_payments_proof_doc_idx
  on public.workspace_employee_payments (workspace_id, proof_document_id)
  where proof_document_id is not null;

drop trigger if exists workspace_employee_payments_set_updated_at on public.workspace_employee_payments;
create trigger workspace_employee_payments_set_updated_at
before update on public.workspace_employee_payments
for each row execute function public.set_workspace_updated_at();

/* RLS: Lesen nur Inhaber/Verwaltung; Schreiben ausschliesslich über die Funktionen. */
alter table public.workspace_employees enable row level security;
alter table public.workspace_employee_payments enable row level security;

drop policy if exists workspace_employees_select_writer on public.workspace_employees;
create policy workspace_employees_select_writer
on public.workspace_employees for select to authenticated
using (public.can_write_workspace(workspace_id));

drop policy if exists workspace_employee_payments_select_writer on public.workspace_employee_payments;
create policy workspace_employee_payments_select_writer
on public.workspace_employee_payments for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_employees from public, anon;
revoke all on public.workspace_employees from authenticated;
grant select on public.workspace_employees to authenticated;
revoke all on public.workspace_employee_payments from public, anon;
revoke all on public.workspace_employee_payments from authenticated;
grant select on public.workspace_employee_payments to authenticated;

/* ------------------------------------------------------------------------ */
/* Antwortform einer Zahlung                                                 */
/* ------------------------------------------------------------------------ */

create or replace function public.workspace_employee_payment_json(p public.workspace_employee_payments)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'client_payment_id', p.client_payment_id,
    'client_employee_id', p.client_employee_id,
    'employee_name', p.employee_name,
    'personnel_number', p.personnel_number,
    'kind', p.kind,
    'amount', p.amount,
    'paid_on', to_char(p.paid_on, 'YYYY-MM-DD'),
    'method', p.method,
    'wage_month', p.wage_month,
    'purpose', p.purpose,
    'note', p.note,
    'receipt_reference', p.receipt_reference,
    'paid_by_name', p.paid_by_name,
    'receipt_document_id', p.receipt_document_id,
    'proof_document_id', p.proof_document_id,
    'created_at', p.created_at,
    'reversed_at', p.reversed_at,
    'reversal_reason', p.reversal_reason,
    'row_version', p.row_version
  );
$$;

/* ------------------------------------------------------------------------ */
/* Mitarbeiter anlegen / ändern / deaktivieren                               */
/* ------------------------------------------------------------------------ */

create or replace function public.upsert_workspace_employee(
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
  v_version bigint := coalesce(p_row_version, 0);
  v_employee_id text;
  v_name text;
  v_number text;
  v_active boolean;
  v_existing public.workspace_employees;
  v_row public.workspace_employees;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'employee_payload_invalid: Nutzlast fehlt';
  end if;
  if v_version < 0 then
    raise exception 'employee_version_invalid: Version ungueltig';
  end if;

  v_employee_id := nullif(btrim(coalesce(p_payload->>'client_employee_id', '')), '');
  if v_employee_id is null or char_length(v_employee_id) > 200 then
    raise exception 'employee_id_invalid: Kennung fehlt';
  end if;
  v_name := nullif(regexp_replace(btrim(coalesce(p_payload->>'name', '')), '\s+', ' ', 'g'), '');
  if v_name is null or char_length(v_name) > 120 then
    raise exception 'employee_name_invalid: Name fehlt oder ist zu lang';
  end if;
  v_number := nullif(regexp_replace(btrim(coalesce(p_payload->>'personnel_number', '')), '\s+', ' ', 'g'), '');
  if v_number is not null and char_length(v_number) > 40 then
    raise exception 'employee_personnel_number_invalid: Personalnummer zu lang';
  end if;
  if p_payload ? 'active' and jsonb_typeof(p_payload->'active') <> 'boolean' then
    raise exception 'employee_active_invalid: aktiv muss ja oder nein sein';
  end if;
  v_active := coalesce((p_payload->>'active')::boolean, true);

  select * into v_existing
  from public.workspace_employees
  where workspace_id = p_workspace_id
    and client_employee_id = v_employee_id
  for update;

  if v_number is not null and exists (
    select 1
    from public.workspace_employees e
    where e.workspace_id = p_workspace_id
      and lower(e.personnel_number) = lower(v_number)
      and e.client_employee_id <> v_employee_id
  ) then
    raise exception 'employee_personnel_number_taken: Personalnummer bereits vergeben';
  end if;

  if v_existing.id is null then
    insert into public.workspace_employees (
      workspace_id, client_employee_id, name, personnel_number, active,
      row_version, created_by, updated_by
    ) values (
      p_workspace_id, v_employee_id, v_name, v_number, v_active,
      1, v_user_id, v_user_id
    )
    returning * into v_row;
    return jsonb_build_object(
      'entity_type', 'employee', 'entity_id', v_row.client_employee_id,
      'row_version', v_row.row_version, 'updated_at', v_row.updated_at, 'replayed', false
    );
  end if;

  /* Gleicher Inhalt ist nie eine Änderung: weder neue Version noch Konflikt. */
  if v_existing.name = v_name
    and v_existing.personnel_number is not distinct from v_number
    and v_existing.active = v_active
    and (v_version = 0 or v_version = v_existing.row_version)
  then
    return jsonb_build_object(
      'entity_type', 'employee', 'entity_id', v_existing.client_employee_id,
      'row_version', v_existing.row_version, 'updated_at', v_existing.updated_at, 'replayed', true
    );
  end if;

  if v_existing.row_version <> v_version then
    raise exception 'Versionskonflikt employee:%', v_existing.row_version;
  end if;

  update public.workspace_employees
  set name = v_name,
      personnel_number = v_number,
      active = v_active,
      row_version = row_version + 1,
      updated_by = v_user_id,
      updated_at = now()
  where id = v_existing.id
  returning * into v_row;

  return jsonb_build_object(
    'entity_type', 'employee', 'entity_id', v_row.client_employee_id,
    'row_version', v_row.row_version, 'updated_at', v_row.updated_at, 'replayed', false
  );
end;
$$;

/* ------------------------------------------------------------------------ */
/* Zahlung anlegen                                                           */
/* ------------------------------------------------------------------------ */

create or replace function public.add_workspace_employee_payment(
  p_workspace_id uuid,
  p_client_payment_id text,
  p_client_employee_id text,
  p_employee_name text,
  p_personnel_number text,
  p_kind text,
  p_amount numeric,
  p_paid_on text,
  p_method text,
  p_wage_month text,
  p_purpose text,
  p_note text,
  p_receipt_reference text,
  p_paid_by_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id text;
  v_employee_id text;
  v_employee public.workspace_employees;
  v_name text;
  v_number text;
  v_kind text;
  v_amount numeric(14, 2);
  v_paid_on date;
  v_method text;
  v_wage_month text;
  v_purpose text;
  v_note text;
  v_reference text;
  v_paid_by text;
  v_existing public.workspace_employee_payments;
  v_inserted public.workspace_employee_payments;
  v_attempt int;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_payment_id := nullif(btrim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null or char_length(v_payment_id) > 200 then
    raise exception 'employee_payment_id_invalid: Zahlungskennung fehlt';
  end if;
  v_employee_id := nullif(btrim(coalesce(p_client_employee_id, '')), '');
  if v_employee_id is null then
    raise exception 'employee_payment_employee_invalid: Mitarbeiter fehlt';
  end if;
  v_name := nullif(regexp_replace(btrim(coalesce(p_employee_name, '')), '\s+', ' ', 'g'), '');
  if v_name is null or char_length(v_name) > 120 then
    raise exception 'employee_payment_employee_name_invalid: Mitarbeitername fehlt';
  end if;
  v_number := nullif(btrim(coalesce(p_personnel_number, '')), '');
  if v_number is not null and char_length(v_number) > 40 then
    raise exception 'employee_payment_personnel_number_invalid: Personalnummer zu lang';
  end if;

  v_kind := btrim(coalesce(p_kind, ''));
  if v_kind not in ('wage', 'advance', 'reimbursement', 'travel', 'other') then
    raise exception 'employee_payment_kind_invalid: Art ungueltig';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > 9999999.99 or round(p_amount, 2) <> p_amount then
    raise exception 'employee_payment_amount_invalid: Betrag ungueltig';
  end if;
  v_amount := round(p_amount, 2);

  if coalesce(p_paid_on, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'employee_payment_date_invalid: Datum ungueltig';
  end if;
  begin
    v_paid_on := p_paid_on::date;
  exception
    when others then
      raise exception 'employee_payment_date_invalid: Datum ungueltig';
  end;
  /* Eine bestätigte Zahlung liegt nicht in der Zukunft; ein Tag Spielraum für Zeitzonen. */
  if v_paid_on > ((now() at time zone 'Europe/Berlin')::date + 1) then
    raise exception 'employee_payment_date_invalid: Datum liegt in der Zukunft';
  end if;

  v_method := btrim(coalesce(p_method, ''));
  if v_method not in ('cash', 'bank', 'other') then
    raise exception 'employee_payment_method_invalid: Zahlungsart fehlt';
  end if;

  v_wage_month := nullif(btrim(coalesce(p_wage_month, '')), '');
  if v_wage_month is not null and (v_kind <> 'wage' or v_wage_month !~ '^\d{4}-(0[1-9]|1[0-2])$') then
    raise exception 'employee_payment_wage_month_invalid: Lohnmonat ungueltig';
  end if;

  v_purpose := nullif(regexp_replace(btrim(coalesce(p_purpose, '')), '\s+', ' ', 'g'), '');
  v_note := nullif(regexp_replace(btrim(coalesce(p_note, '')), '\s+', ' ', 'g'), '');
  if char_length(coalesce(v_purpose, '')) > 500 or char_length(coalesce(v_note, '')) > 500 then
    raise exception 'employee_payment_text_invalid: Text zu lang';
  end if;
  if v_kind = 'other' and v_note is null then
    raise exception 'employee_payment_note_required: Notiz erforderlich';
  end if;
  v_paid_by := nullif(regexp_replace(btrim(coalesce(p_paid_by_name, '')), '\s+', ' ', 'g'), '');
  if char_length(coalesce(v_paid_by, '')) > 120 then
    raise exception 'employee_payment_text_invalid: Text zu lang';
  end if;

  v_reference := btrim(coalesce(p_receipt_reference, ''));
  if v_reference !~ '^MZ-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$'
    or substr(v_reference, 4, 8) <> to_char(v_paid_on, 'YYYYMMDD')
  then
    raise exception 'employee_payment_reference_invalid: Referenz ungueltig';
  end if;

  select * into v_employee
  from public.workspace_employees
  where workspace_id = p_workspace_id
    and client_employee_id = v_employee_id;
  if v_employee.id is null then
    raise exception 'Mitarbeiter nicht gefunden';
  end if;

  if exists (
    select 1
    from public.workspace_employee_payments p
    where p.workspace_id = p_workspace_id
      and p.receipt_reference = v_reference
      and p.client_payment_id <> v_payment_id
  ) then
    raise exception 'Referenzkonflikt: Referenz bereits vergeben';
  end if;

  -- Insert zuerst, prüfen danach — wie bei den übrigen Zahlungen.
  for v_attempt in 1..2 loop
    insert into public.workspace_employee_payments (
      workspace_id, client_payment_id, client_employee_id, employee_name, personnel_number,
      kind, amount, paid_on, method, wage_month, purpose, note,
      receipt_reference, paid_by_name, created_by
    ) values (
      p_workspace_id, v_payment_id, v_employee_id, v_name, v_number,
      v_kind, v_amount, v_paid_on, v_method, v_wage_month, v_purpose, v_note,
      v_reference, v_paid_by, v_user_id
    )
    on conflict (workspace_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      return public.workspace_employee_payment_json(v_inserted) || jsonb_build_object('replayed', false);
    end if;

    select * into v_existing
    from public.workspace_employee_payments
    where workspace_id = p_workspace_id
      and client_payment_id = v_payment_id
    for update;

    if v_existing.id is not null then
      if v_existing.client_employee_id is distinct from v_employee_id
        or v_existing.kind is distinct from v_kind
        or v_existing.amount is distinct from v_amount
        or v_existing.paid_on is distinct from v_paid_on
        or v_existing.method is distinct from v_method
        or v_existing.wage_month is distinct from v_wage_month
        or v_existing.purpose is distinct from v_purpose
        or v_existing.note is distinct from v_note
        or v_existing.receipt_reference is distinct from v_reference
      then
        raise exception 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten';
      end if;
      /* Replay — auch für eine inzwischen stornierte Zahlung; es bewegt kein Geld. */
      return public.workspace_employee_payment_json(v_existing) || jsonb_build_object('replayed', true);
    end if;
  end loop;

  raise exception 'Zahlung nicht angelegt';
end;
$$;

/* ------------------------------------------------------------------------ */
/* Storno                                                                    */
/* ------------------------------------------------------------------------ */

create or replace function public.reverse_workspace_employee_payment(
  p_workspace_id uuid,
  p_client_payment_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id text;
  v_reason text;
  v_existing public.workspace_employee_payments;
  v_updated public.workspace_employee_payments;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_payment_id := nullif(btrim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null then
    raise exception 'employee_payment_id_invalid: Zahlungskennung fehlt';
  end if;
  v_reason := regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g');
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'employee_payment_reversal_reason_invalid: Grund erforderlich';
  end if;

  select * into v_existing
  from public.workspace_employee_payments
  where workspace_id = p_workspace_id
    and client_payment_id = v_payment_id
  for update;
  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  /* Idempotent: der erste Storno bleibt, samt seinem Grund. */
  if v_existing.reversed_at is not null then
    return public.workspace_employee_payment_json(v_existing) || jsonb_build_object('replayed', true);
  end if;

  update public.workspace_employee_payments
  set reversed_at = now(),
      reversed_by = v_user_id,
      reversal_reason = v_reason,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return public.workspace_employee_payment_json(v_updated) || jsonb_build_object('replayed', false);
end;
$$;

/* ------------------------------------------------------------------------ */
/* Quittung (einmal) und Nachweis — geldfrei                                 */
/* ------------------------------------------------------------------------ */

create or replace function public.set_workspace_employee_payment_receipt(
  p_workspace_id uuid,
  p_client_payment_id text,
  p_client_document_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id text;
  v_document_id text;
  v_document_kind text;
  v_existing public.workspace_employee_payments;
  v_updated public.workspace_employee_payments;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_payment_id := nullif(btrim(coalesce(p_client_payment_id, '')), '');
  v_document_id := nullif(btrim(coalesce(p_client_document_id, '')), '');
  if v_payment_id is null or v_document_id is null then
    raise exception 'employee_payment_receipt_invalid: Kennung fehlt';
  end if;

  /* Dieselbe Dokumentzeile sperren, die auch die Löschwege sperren. */
  select d.document_kind into v_document_kind
  from public.workspace_documents d
  where d.workspace_id = p_workspace_id
    and d.client_document_id = v_document_id
    and coalesce(d.deleted, false) = false
  for update;
  if not found then
    raise exception 'Quittungsdokument nicht gefunden';
  end if;

  select * into v_existing
  from public.workspace_employee_payments
  where workspace_id = p_workspace_id
    and client_payment_id = v_payment_id
  for update;
  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  if v_existing.receipt_document_id is not null then
    if v_existing.receipt_document_id = v_document_id then
      /* Datenschutz: der Schutzeintrag besteht auch nach einem Replay. */
      insert into public.workspace_restricted_documents (workspace_id, client_document_id, reason, created_by)
      values (p_workspace_id, v_document_id, 'employee_payment_receipt', v_user_id)
      on conflict (workspace_id, client_document_id) do nothing;
      return public.workspace_employee_payment_json(v_existing) || jsonb_build_object('replayed', true);
    end if;
    raise exception 'Quittung bereits gesetzt';
  end if;
  if v_existing.reversed_at is not null then
    raise exception 'employee_payment_reversed: Zahlung ist storniert';
  end if;
  if v_existing.method <> 'cash' then
    raise exception 'employee_payment_receipt_cash_only: Quittung nur fuer Barzahlungen';
  end if;
  /*
   * Datenschutz: Die Quittung ist genau das erzeugte Archivdokument mit der
   * festen Kennung `emp-receipt-<payment>` — sie ist damit ab ihrer ersten
   * Zeile geschützt, nicht erst ab dieser Verknüpfung.
   */
  if v_document_id <> 'emp-receipt-' || v_payment_id then
    raise exception 'employee_payment_receipt_invalid: Quittung muss emp-receipt-<Zahlung> sein';
  end if;
  if v_document_kind <> 'archived_document' then
    raise exception 'employee_payment_document_kind: nur Archivdokumente';
  end if;
  if v_existing.proof_document_id is not distinct from v_document_id then
    raise exception 'employee_payment_receipt_is_proof: Quittung und Nachweis sind verschiedene Dokumente';
  end if;

  update public.workspace_employee_payments
  set receipt_document_id = v_document_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  /* Datenschutz: im selben Schritt dauerhaft geschützt — keine Zwischenphase. */
  insert into public.workspace_restricted_documents (workspace_id, client_document_id, reason, created_by)
  values (p_workspace_id, v_document_id, 'employee_payment_receipt', v_user_id)
  on conflict (workspace_id, client_document_id) do nothing;

  return public.workspace_employee_payment_json(v_updated) || jsonb_build_object('replayed', false);
end;
$$;

create or replace function public.set_workspace_employee_payment_proof(
  p_workspace_id uuid,
  p_client_payment_id text,
  p_client_document_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id text;
  v_document_id text;
  v_document_kind text;
  v_existing public.workspace_employee_payments;
  v_updated public.workspace_employee_payments;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_payment_id := nullif(btrim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null then
    raise exception 'employee_payment_id_invalid: Zahlungskennung fehlt';
  end if;
  v_document_id := nullif(btrim(coalesce(p_client_document_id, '')), '');

  if v_document_id is not null then
    select d.document_kind into v_document_kind
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id
      and d.client_document_id = v_document_id
      and coalesce(d.deleted, false) = false
    for update;
    if not found then
      raise exception 'Nachweisdokument nicht gefunden';
    end if;
    /* Datenschutz: nur Archivdokumente — Rechnungsdokumente reisen über einen eigenen Abzug. */
    if v_document_kind <> 'archived_document' then
      raise exception 'employee_payment_document_kind: nur Archivdokumente';
    end if;
  end if;

  select * into v_existing
  from public.workspace_employee_payments
  where workspace_id = p_workspace_id
    and client_payment_id = v_payment_id
  for update;
  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  /* Idempotent: derselbe Nachweis ein zweites Mal ändert nichts. */
  if v_existing.proof_document_id is not distinct from v_document_id then
    if v_document_id is not null then
      insert into public.workspace_restricted_documents (workspace_id, client_document_id, reason, created_by)
      values (p_workspace_id, v_document_id, 'employee_payment_proof', v_user_id)
      on conflict (workspace_id, client_document_id) do nothing;
    end if;
    return public.workspace_employee_payment_json(v_existing) || jsonb_build_object('replayed', true);
  end if;
  if v_existing.reversed_at is not null then
    raise exception 'employee_payment_reversed: Zahlung ist storniert';
  end if;
  if v_document_id is not null and v_document_id = v_existing.receipt_document_id then
    raise exception 'employee_payment_proof_is_receipt: Quittung und Nachweis sind verschiedene Dokumente';
  end if;

  update public.workspace_employee_payments
  set proof_document_id = v_document_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  /*
   * Datenschutz: im selben Schritt dauerhaft geschützt — keine Zwischenphase.
   * Der Eintrag bleibt auch, wenn der Nachweis später geändert wird: Ein einmal
   * verknüpfter Nachweis wird nicht wieder für Mitglieder sichtbar.
   */
  if v_document_id is not null then
    insert into public.workspace_restricted_documents (workspace_id, client_document_id, reason, created_by)
    values (p_workspace_id, v_document_id, 'employee_payment_proof', v_user_id)
    on conflict (workspace_id, client_document_id) do nothing;
  end if;

  return public.workspace_employee_payment_json(v_updated) || jsonb_build_object('replayed', false);
end;
$$;

/* ------------------------------------------------------------------------ */
/* Abzug — nur Inhaber/Verwaltung                                            */
/* ------------------------------------------------------------------------ */

create or replace function public.pull_workspace_employee_data(p_workspace_id uuid)
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
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_employee_id', e.client_employee_id,
        'name', e.name,
        'personnel_number', e.personnel_number,
        'active', e.active,
        'row_version', e.row_version,
        'created_at', e.created_at,
        'updated_at', e.updated_at
      ) order by e.created_at asc, e.client_employee_id asc)
      from public.workspace_employees e
      where e.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(public.workspace_employee_payment_json(p) order by p.created_at asc, p.client_payment_id asc)
      from public.workspace_employee_payments p
      where p.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
end;
$$;

/* ------------------------------------------------------------------------ */
/* Dokumentschutz — geltende Fassung (20261029120000) plus Mitarbeiterzahlung */
/* ------------------------------------------------------------------------ */

create or replace function public.assert_document_not_payment_proof(
  p_workspace_id uuid,
  p_client_document_id text
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document_id text := nullif(trim(coalesce(p_client_document_id, '')), '');
begin
  if v_document_id is null then
    return;
  end if;

  if exists (
    select 1
    from public.workspace_expense_payments p
    where p.workspace_id = p_workspace_id
      and p.proof_document_id = v_document_id
  ) or exists (
    select 1
    from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id
      and p.proof_document_id = v_document_id
  ) or exists (
    /* P1 MITARBEITERZAHLUNGEN — Quittung und Nachweis, auch storniert. */
    select 1
    from public.workspace_employee_payments p
    where p.workspace_id = p_workspace_id
      and (p.proof_document_id = v_document_id or p.receipt_document_id = v_document_id)
  ) then
    raise exception 'Dokument ist als Zahlungsnachweis verknuepft' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.is_workspace_document_payment_proof(
  p_workspace_id uuid,
  p_client_document_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document_id text := nullif(trim(coalesce(p_client_document_id, '')), '');
begin
  if v_document_id is null then
    return false;
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return exists (
    select 1 from public.workspace_expense_payments p
    where p.workspace_id = p_workspace_id and p.proof_document_id = v_document_id
  ) or exists (
    select 1 from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id and p.proof_document_id = v_document_id
  ) or exists (
    select 1 from public.workspace_employee_payments p
    where p.workspace_id = p_workspace_id
      and (p.proof_document_id = v_document_id or p.receipt_document_id = v_document_id)
  );
end;
$$;

/* ------------------------------------------------------------------------ */
/* Datenschutz — Belege von Mitarbeiterzahlungen nur für Inhaber/Verwaltung  */
/* ------------------------------------------------------------------------ */

/*
 * Eine Auszahlungsquittung und der unterschriebene Nachweis sind
 * Personaldaten. Sobald ein Dokument Quittung oder Nachweis einer
 * Mitarbeiterzahlung ist, lesen es serverseitig nur noch Inhaber und
 * Verwaltung (`can_write_workspace`). Das gilt auch, wenn
 *   - ein früherer Admin inzwischen Mitglied ist: Die Ausnahme „selbst
 *     angelegt" gilt für diese Belege nicht,
 *   - ein Mitglied das Dokument ursprünglich hochgeladen hat,
 *   - die Zahlung storniert ist,
 *   - ein Client direkt auf Tabelle, RPC oder Dateispeicher zugreift.
 *
 * Geschützt ist alles, was den Inhalt trägt: die Dokumentzeile, ihre Dateien
 * samt abgeleiteten Darstellungen, die Dateizuordnungen, der Eingang, die
 * Analyse, der Papierregister-Eintrag (er nennt den Titel), Kommunikations-
 * ereignisse im Kontext des Dokuments, Versandzeilen und Versandkopien — auf
 * allen Lesewegen: Tabellen-RLS, Abzüge, Versandlisten, Dateispeicher. Ein
 * Mitglied kann solche Zeilen auch nicht mehr schreiben; das Schreiben
 * lieferte sonst die Zeile zurück.
 *
 * KEINE UNGESCHÜTZTE ZWISCHENPHASE
 *  - Die erzeugte Quittung trägt die feste Kennung `emp-receipt-<payment>`
 *    und ist ab ihrer ersten Zeile geschützt, vor jeder Verknüpfung.
 *  - Dokumente und Eingänge im Ordner `/Mitarbeiter/Zahlungsnachweise/` (dort
 *    legt die App Quittung und unterschriebenen Nachweis ab) sind ab der
 *    ersten Zeile mit diesem Ordner geschützt.
 *  - Die Verknüpfung schreibt im selben Schritt einen dauerhaften
 *    Schutzeintrag. Er bleibt, wenn der Nachweis später geändert wird: Ein
 *    einmal verknüpfter Nachweis wird nicht wieder für Mitglieder sichtbar.
 *
 * NICHT EINGESCHRÄNKT
 *  - Inhaber und Verwaltung lesen und schreiben wie bisher.
 *  - Alle übrigen Dokumente, Dateien und Eingänge behalten ihre Regeln
 *    unverändert; Rechnungsdokumente sind von diesem Schutz nicht betroffen
 *    (Belege von Mitarbeiterzahlungen sind ausschliesslich Archivdokumente).
 */

create table if not exists public.workspace_restricted_documents (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_document_id text not null,
  reason text not null,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, client_document_id),
  constraint workspace_restricted_documents_reason_check
    check (reason in ('employee_payment_receipt', 'employee_payment_proof'))
);

/* Kein Client-Zugriff: keine Policy, keine Rechte. Gelesen nur von den Funktionen unten. */
alter table public.workspace_restricted_documents enable row level security;
revoke all on public.workspace_restricted_documents from public, anon;
revoke all on public.workspace_restricted_documents from authenticated;

/* Rückwege Datei -> Dokument/Eingang ohne Vollscan je Prüfung. */
create index if not exists workspace_inbox_items_file_ref_idx
  on public.workspace_inbox_items (workspace_id, client_file_ref_id)
  where client_file_ref_id is not null;
create index if not exists workspace_inbox_items_archive_document_idx
  on public.workspace_inbox_items (workspace_id, archive_document_id)
  where archive_document_id is not null;
create index if not exists workspace_document_deliveries_attachment_path_idx
  on public.workspace_document_deliveries (attachment_storage_path)
  where attachment_storage_path is not null;

/** Der Ordner, in dem die App Quittung und unterschriebenen Nachweis ablegt. */
create or replace function public.workspace_employee_payment_folder_path(p_payload jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_payload->'digitalFolder'->>'path', '') like '/Mitarbeiter/Zahlungsnachweise/%';
$$;

/**
 * Ist dieses Dokument Quittung oder Nachweis einer Mitarbeiterzahlung — oder
 * dafür bestimmt? Auch storniert, auch nach einer Änderung des Nachweises.
 */
create or replace function public.workspace_document_is_restricted(
  p_workspace_id uuid,
  p_client_document_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(btrim(coalesce(p_client_document_id, '')), '') is not null and (
    p_client_document_id like 'emp-receipt-%'
    or exists (
      select 1 from public.workspace_restricted_documents r
      where r.workspace_id = p_workspace_id and r.client_document_id = p_client_document_id
    )
    or exists (
      select 1 from public.workspace_employee_payments p
      where p.workspace_id = p_workspace_id
        and (p.receipt_document_id = p_client_document_id or p.proof_document_id = p_client_document_id)
    )
    or exists (
      select 1 from public.workspace_documents d
      where d.workspace_id = p_workspace_id
        and d.client_document_id = p_client_document_id
        and d.document_kind = 'archived_document'
        and public.workspace_employee_payment_folder_path(d.payload)
    )
  ), false);
$$;

/**
 * Trägt diese Datei den Inhalt eines geschützten Belegs? Geprüft wird die
 * Datei selbst und ihre Herkunft (abgeleitete Vorschauen und Archivfassungen
 * stammen vom Original): über Zuordnungen zum Dokument und über den Eingang.
 */
create or replace function public.workspace_file_is_restricted(
  p_workspace_id uuid,
  p_client_file_ref_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive herkunft(ref, tiefe) as (
    select nullif(btrim(coalesce(p_client_file_ref_id, '')), ''), 0
    union all
    select f.derived_from_client_file_ref_id, h.tiefe + 1
    from herkunft h
    join public.workspace_files f
      on f.workspace_id = p_workspace_id and f.client_file_ref_id = h.ref
    where f.derived_from_client_file_ref_id is not null
      and h.tiefe < 8
  )
  select exists (
    select 1
    from herkunft h
    where h.ref is not null
      and (
        exists (
          select 1 from public.workspace_document_file_bindings b
          where b.workspace_id = p_workspace_id
            and b.client_file_ref_id = h.ref
            and public.workspace_document_is_restricted(p_workspace_id, b.client_document_id)
        )
        or exists (
          select 1 from public.workspace_inbox_items i
          where i.workspace_id = p_workspace_id
            and i.client_file_ref_id = h.ref
            and (
              public.workspace_document_is_restricted(p_workspace_id, i.archive_document_id)
              or public.workspace_employee_payment_folder_path(i.payload)
            )
        )
      )
  );
$$;

/** Gehört dieser Eingang zu einem geschützten Beleg (Ablage, Ordner oder Datei)? */
create or replace function public.workspace_inbox_item_is_restricted(
  p_workspace_id uuid,
  p_client_inbox_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_inbox_items i
    where i.workspace_id = p_workspace_id
      and i.client_inbox_id = p_client_inbox_id
      and (
        public.workspace_document_is_restricted(p_workspace_id, i.archive_document_id)
        or public.workspace_employee_payment_folder_path(i.payload)
        or (i.client_file_ref_id is not null and public.workspace_file_is_restricted(p_workspace_id, i.client_file_ref_id))
      )
  );
$$;

/** Ein Kommunikationsereignis im Kontext eines geschützten Dokuments oder Eingangs. */
create or replace function public.workspace_communication_context_is_restricted(
  p_workspace_id uuid,
  p_context_type text,
  p_context_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_context_type = 'document' then public.workspace_document_is_restricted(p_workspace_id, p_context_id)
    when p_context_type = 'inbox' then public.workspace_inbox_item_is_restricted(p_workspace_id, p_context_id)
    else false
  end;
$$;

/* ---------------------------------------------------------------- RLS ---- */
/* Jede Policy: die geltende Fassung, nur der Belegschutz ergänzt.           */

-- Geltende Fassung aus 20260916120000.
drop policy if exists workspace_documents_select_member on public.workspace_documents;
create policy workspace_documents_select_member
on public.workspace_documents for select to authenticated
using (
  public.is_active_workspace_member(workspace_id)
  and (
    document_kind <> 'archived_document'
    or public.can_write_workspace(workspace_id)
    or created_by = auth.uid()
  )
  and (
    document_kind <> 'archived_document'
    or public.can_write_workspace(workspace_id)
    or not public.workspace_document_is_restricted(workspace_id, client_document_id)
  )
);

-- Geltende Fassung aus 20260916120000.
drop policy if exists workspace_files_select on public.workspace_files;
create policy workspace_files_select
on public.workspace_files for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (
    public.workspace_user_can_intake(workspace_id)
    and created_by = auth.uid()
    and not public.workspace_file_is_restricted(workspace_id, client_file_ref_id)
  )
);

-- Geltende Fassung aus 20260916120000.
drop policy if exists workspace_document_file_bindings_select on public.workspace_document_file_bindings;
create policy workspace_document_file_bindings_select
on public.workspace_document_file_bindings for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (
    public.workspace_user_can_intake(workspace_id)
    and created_by = auth.uid()
    and not public.workspace_document_is_restricted(workspace_id, client_document_id)
    and not public.workspace_file_is_restricted(workspace_id, client_file_ref_id)
  )
);

-- Geltende Fassung aus 20260916120000.
drop policy if exists workspace_inbox_items_select on public.workspace_inbox_items;
create policy workspace_inbox_items_select
on public.workspace_inbox_items for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (
    public.workspace_user_can_intake(workspace_id)
    and created_by = auth.uid()
    and not public.workspace_inbox_item_is_restricted(workspace_id, client_inbox_id)
  )
);

-- Geltende Fassung aus 20260916120000.
drop policy if exists workspace_document_work_results_select on public.workspace_document_work_results;
create policy workspace_document_work_results_select
on public.workspace_document_work_results for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (
    public.workspace_user_can_intake(workspace_id)
    and created_by = auth.uid()
    and not public.workspace_inbox_item_is_restricted(workspace_id, client_inbox_id)
  )
);

-- Geltende Fassung aus 20261030120000.
drop policy if exists workspace_paper_register_entries_select on public.workspace_paper_register_entries;
create policy workspace_paper_register_entries_select
on public.workspace_paper_register_entries for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (
    public.workspace_user_can_intake(workspace_id)
    and created_by = auth.uid()
    and not public.workspace_document_is_restricted(workspace_id, client_document_id)
  )
);

-- Geltende Fassung aus 20261031120000.
drop policy if exists workspace_communication_events_select on public.workspace_communication_events;
create policy workspace_communication_events_select
on public.workspace_communication_events for select to authenticated
using (
  public.can_write_workspace(workspace_id)
  or (
    public.workspace_user_can_intake(workspace_id)
    and created_by = auth.uid()
    and not public.workspace_communication_context_is_restricted(workspace_id, context_type, context_id)
  )
);

-- Geltende Fassung aus 20260914120000.
drop policy if exists workspace_document_deliveries_select_member on public.workspace_document_deliveries;
create policy workspace_document_deliveries_select_member
on public.workspace_document_deliveries for select to authenticated
using (
  public.is_active_workspace_member(workspace_id)
  and (
    public.can_write_workspace(workspace_id)
    or linked_document_id is null
    or not public.workspace_document_is_restricted(workspace_id, linked_document_id)
  )
);

/* ------------------------------------------------------- Schreibschutz ---- */

/**
 * Ein Mitglied schreibt keine Zeile, die einen geschützten Beleg trägt — weder
 * neu noch als Änderung. Das Schreiben über die Dispatcher gäbe die Zeile
 * sonst zurück, und eine Änderung könnte den Schutz (Ordner) entfernen.
 * Inhaber/Verwaltung und Serverpfade ohne Anmeldung sind nicht betroffen.
 */
create or replace function public.workspace_restricted_content_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_neu jsonb := to_jsonb(new);
  v_alt jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_zeile jsonb;
  v_ws uuid := new.workspace_id;
  v_geschuetzt boolean := false;
begin
  if auth.uid() is null or public.can_write_workspace(v_ws) then
    return new;
  end if;

  foreach v_zeile in array array_remove(array[v_neu, v_alt], null) loop
    if tg_table_name = 'workspace_documents' then
      v_geschuetzt := v_geschuetzt or (
        v_zeile->>'document_kind' = 'archived_document'
        and (
          public.workspace_document_is_restricted(v_ws, v_zeile->>'client_document_id')
          or public.workspace_employee_payment_folder_path(v_zeile->'payload')
        )
      );
    elsif tg_table_name = 'workspace_files' then
      v_geschuetzt := v_geschuetzt or public.workspace_file_is_restricted(v_ws, v_zeile->>'client_file_ref_id');
    elsif tg_table_name = 'workspace_document_file_bindings' then
      v_geschuetzt := v_geschuetzt
        or public.workspace_document_is_restricted(v_ws, v_zeile->>'client_document_id')
        or public.workspace_file_is_restricted(v_ws, v_zeile->>'client_file_ref_id');
    elsif tg_table_name = 'workspace_inbox_items' then
      v_geschuetzt := v_geschuetzt
        or public.workspace_document_is_restricted(v_ws, v_zeile->>'archive_document_id')
        or public.workspace_employee_payment_folder_path(v_zeile->'payload')
        or public.workspace_inbox_item_is_restricted(v_ws, v_zeile->>'client_inbox_id')
        or (v_zeile->>'client_file_ref_id' is not null
            and public.workspace_file_is_restricted(v_ws, v_zeile->>'client_file_ref_id'));
    elsif tg_table_name = 'workspace_document_work_results' then
      v_geschuetzt := v_geschuetzt or public.workspace_inbox_item_is_restricted(v_ws, v_zeile->>'client_inbox_id');
    elsif tg_table_name = 'workspace_paper_register_entries' then
      v_geschuetzt := v_geschuetzt or public.workspace_document_is_restricted(v_ws, v_zeile->>'client_document_id');
    elsif tg_table_name = 'workspace_communication_events' then
      v_geschuetzt := v_geschuetzt or public.workspace_communication_context_is_restricted(
        v_ws, v_zeile->>'context_type', v_zeile->>'context_id');
    end if;
  end loop;

  if coalesce(v_geschuetzt, false) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_documents_restricted_write_guard on public.workspace_documents;
create trigger workspace_documents_restricted_write_guard
before insert or update on public.workspace_documents
for each row execute function public.workspace_restricted_content_write_guard();

drop trigger if exists workspace_files_restricted_write_guard on public.workspace_files;
create trigger workspace_files_restricted_write_guard
before insert or update on public.workspace_files
for each row execute function public.workspace_restricted_content_write_guard();

drop trigger if exists workspace_document_file_bindings_restricted_write_guard on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_restricted_write_guard
before insert or update on public.workspace_document_file_bindings
for each row execute function public.workspace_restricted_content_write_guard();

drop trigger if exists workspace_inbox_items_restricted_write_guard on public.workspace_inbox_items;
create trigger workspace_inbox_items_restricted_write_guard
before insert or update on public.workspace_inbox_items
for each row execute function public.workspace_restricted_content_write_guard();

drop trigger if exists workspace_document_work_results_restricted_write_guard on public.workspace_document_work_results;
create trigger workspace_document_work_results_restricted_write_guard
before insert or update on public.workspace_document_work_results
for each row execute function public.workspace_restricted_content_write_guard();

drop trigger if exists workspace_paper_register_entries_restricted_write_guard on public.workspace_paper_register_entries;
create trigger workspace_paper_register_entries_restricted_write_guard
before insert or update on public.workspace_paper_register_entries
for each row execute function public.workspace_restricted_content_write_guard();

drop trigger if exists workspace_communication_events_restricted_write_guard on public.workspace_communication_events;
create trigger workspace_communication_events_restricted_write_guard
before insert or update on public.workspace_communication_events
for each row execute function public.workspace_restricted_content_write_guard();

/* ------------------------------------------------------ Dateispeicher ---- */

/**
 * Geltende Fassung aus 20260916120000, für Mitglieder um den Belegschutz
 * ergänzt: Auch eine selbst hochgeladene Datei ist nicht mehr lesbar, sobald
 * sie einen geschützten Beleg trägt.
 */
create or replace function public.workspace_file_object_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_files f
    where f.storage_path = p_name
      and f.deleted = false
      and (
        public.can_write_workspace(f.workspace_id)
        or (
          public.workspace_user_can_intake(f.workspace_id)
          and f.created_by = auth.uid()
          and not public.workspace_file_is_restricted(f.workspace_id, f.client_file_ref_id)
        )
      )
  );
$$;

/**
 * Versandkopien — geltende Fassung aus 20260914120000 erlaubte jedem Mitglied
 * jede Kopie. Mitglieder lesen jetzt nur noch Kopien, zu denen eine
 * Versandzeile besteht, deren Dokument nicht geschützt ist. Inhaber und
 * Verwaltung unverändert.
 */
create or replace function public.document_delivery_attachment_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.is_active_workspace_member(public.document_delivery_attachment_workspace_id(p_name))
    and (
      public.can_write_workspace(public.document_delivery_attachment_workspace_id(p_name))
      or exists (
        select 1
        from public.workspace_document_deliveries dd
        where dd.workspace_id = public.document_delivery_attachment_workspace_id(p_name)
          and dd.attachment_storage_path = p_name
          and (
            dd.linked_document_id is null
            or not public.workspace_document_is_restricted(dd.workspace_id, dd.linked_document_id)
          )
      )
    ),
    false
  );
$$;

/* Generischer Abzug — wörtlich aus 20261103120000, nur Papierregister und
 * Kommunikationsereignisse um den Belegschutz ergänzt. */
create or replace function public.pull_workspace_sync_state(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.workspace_settings;
  v_setup public.workspace_setup;
  v_profile public.workspace_company_profiles;
  v_workspace public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  select * into v_workspace from public.workspaces w where w.id = p_workspace_id;
  select * into v_settings from public.workspace_settings ws where ws.workspace_id = p_workspace_id;
  select * into v_setup from public.workspace_setup s where s.workspace_id = p_workspace_id;
  select * into v_profile from public.workspace_company_profiles cp where cp.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'members', coalesce(
      (select jsonb_agg(to_jsonb(wm)) from public.workspace_members wm where wm.workspace_id = p_workspace_id and wm.status = 'active'),
      '[]'::jsonb
    ),
    'settings', to_jsonb(v_settings),
    'setup', to_jsonb(v_setup),
    'company_profile', to_jsonb(v_profile),
    'vorgaenge', coalesce(
      (select jsonb_agg(to_jsonb(v)) from public.workspace_vorgaenge v where v.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * Ausdruecklich OHNE `deleted = false`. Der spaetere Backfill vergleicht
     * lokale Kunden-IDs gegen alle remote bekannten IDs; eine geloeschte ID
     * muss dabei als vorhanden gelten, sonst laedt ein zweites Geraet den
     * geloeschten Kunden wieder hoch. Der Vorgangs-Pull filtert aus demselben
     * Grund nicht.
     */
    'customers', coalesce(
      (select jsonb_agg(to_jsonb(c)) from public.workspace_customers c where c.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * Ebenfalls ausdruecklich OHNE `deleted = false`: Grabsteine muessen das
     * zweite Geraet erreichen, sonst taucht eine dort geloeschte Notiz wieder
     * auf, und der Backfill wuerde sie erneut hochladen.
     */
    'vorgang_notes', coalesce(
      (select jsonb_agg(to_jsonb(n)) from public.workspace_vorgang_notes n where n.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * CLOUD-DURABILITY-CORE-01C -- ebenfalls ohne `deleted = false`.
     * Ein Grabstein entsteht hier auch durch die Dedupe-Aufloesung; er muss
     * das zweite Geraet erreichen, sonst bliebe die unterlegene Aufgabe dort
     * sichtbar und der Backfill luede sie erneut hoch.
     */
    'tasks', coalesce(
      (select jsonb_agg(to_jsonb(t)) from public.workspace_tasks t where t.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * CLOUD-DURABILITY-CORE-01D -- Mahnnachweise. Kein Grabsteinfilter noetig:
     * Die Entitaet ist append-only, es gibt weder Loeschen noch Bearbeiten.
     */
    'dunning_documentations', coalesce(
      (select jsonb_agg(to_jsonb(d)) from public.workspace_invoice_dunning_documentations d
        where d.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * BRIEFE-01B -- Geschaeftsschreiben. Ebenfalls ohne `deleted = false`:
     * Grabsteine muessen das zweite Geraet erreichen, sonst taucht ein dort
     * geloeschter Brief wieder auf und der Altbestand luede ihn erneut hoch.
     */
    'business_letters', coalesce(
      (select jsonb_agg(to_jsonb(bl)) from public.workspace_business_letters bl
        where bl.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * ANGEBOT-01B -- eigene Angebote, ebenfalls inklusive Grabsteine.
     */
    'offers', coalesce(
      (select jsonb_agg(to_jsonb(o)) from public.workspace_offers o
        where o.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- Importkonten und Bankbewegungen.
     *
     * Beide reisen im selben Abzug mit wie jede andere Workspace-Entitaet.
     * Kein zweiter Pull-Pfad, keine Bank-Sonderfunktion.
     *
     * Grabsteine gibt es fuer Bankdaten nicht -- Block 2B bietet kein
     * Loeschen an, und beide Push-Zweige weisen es ausdruecklich ab. Die
     * Zeilen kommen deshalb vollstaendig und ohne Filter.
     */
    'bank_accounts', coalesce(
      (select jsonb_agg(to_jsonb(ba)) from public.workspace_bank_accounts ba
        where ba.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    'bank_transactions', coalesce(
      (select jsonb_agg(to_jsonb(bt)) from public.workspace_bank_transactions bt
        where bt.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * BANKABGLEICH-V1 BLOCK 4 — bestaetigte Zuordnungen.
     *
     * Nur Pull: Eine Zuordnung entsteht ausschliesslich in
     * `confirm_workspace_bank_reconciliation` und niemals durch einen
     * Client-Push. Deshalb gibt es fuer sie bewusst **keinen** Zweig im
     * Upsert-Dispatcher — ein Geraet soll eine Geldwirkung nicht
     * hochladen koennen, sondern nur erfahren.
     */
    'bank_reconciliations', coalesce(
      (select jsonb_agg(to_jsonb(br)) from public.workspace_bank_reconciliations br
        where br.workspace_id = p_workspace_id and br.deleted = false),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S1 -- Papierablage-Haken.
     *
     * Ausdruecklich OHNE `deleted = false`: Grabsteine muessen das zweite
     * Geraet erreichen, sonst bliebe dort der Haken eines geloeschten
     * Dokuments stehen, und der Altbestand luede ihn erneut hoch.
     *
     * Sichtbarkeit wie beim Dokument (siehe Kopfkommentar): Inhaber/Admin
     * alles, Mitglieder die selbst angelegten Zeilen.
     */
    'paper_register_entries', coalesce(
      (select jsonb_agg(to_jsonb(pr)) from public.workspace_paper_register_entries pr
        where pr.workspace_id = p_workspace_id
          and (public.can_write_workspace(p_workspace_id)
            or (pr.created_by = auth.uid()
              and not public.workspace_document_is_restricted(p_workspace_id, pr.client_document_id)))),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S2 -- Kommunikationsverlauf, nach Ereigniszeit geordnet.
     *
     * Sichtbarkeit wie bei Dokumenten und Eingang (siehe Kopfkommentar):
     * Inhaber/Admin alles, Mitglieder die selbst angelegten Ereignisse.
     */
    'communication_events', coalesce(
      (select jsonb_agg(to_jsonb(ce) order by ce.event_at, ce.client_event_id)
         from public.workspace_communication_events ce
        where ce.workspace_id = p_workspace_id
          and (public.can_write_workspace(p_workspace_id)
            or (ce.created_by = auth.uid()
              and not public.workspace_communication_context_is_restricted(p_workspace_id, ce.context_type, ce.context_id)))),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S3 -- bestaetigtes Wissen.
     *
     * Ausdruecklich OHNE `deleted = false`: Grabsteine muessen das zweite
     * Geraet erreichen, sonst bliebe dort ein geloeschter Eintrag stehen, und
     * der Altbestand luede ihn erneut hoch. Sichtbar fuer jedes aktive
     * Mitglied -- wie die Vorgangsnotizen (siehe Kopfkommentar).
     */
    'knowledge_facts', coalesce(
      (select jsonb_agg(to_jsonb(kf)) from public.workspace_knowledge_facts kf
        where kf.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S5 -- Rechnungsentwuerfe, fachlicher Kern.
     *
     * Ausdruecklich OHNE Filter auf `deleted` oder `status`: Verworfene und
     * finalisierte Entwuerfe muessen jedes Geraet erreichen, sonst bliebe dort
     * ein lokaler Entwurf stehen und wuerde erneut hochgeladen. Ein Grabstein
     * reist ohne Inhalt: Der Server bewahrt ihn als Nachweis, das Geraet braucht
     * nur das Ende. Sichtbar fuer jedes aktive Mitglied -- wie das Vorbereiten
     * einer Rechnung im Produkt.
     */
    'invoice_drafts', coalesce(
      (select jsonb_agg(
                case when d.deleted or d.status <> 'active' then to_jsonb(d) - 'payload' else to_jsonb(d) end
                order by d.updated_at, d.client_draft_id)
         from public.workspace_invoice_drafts d
        where d.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S6 -- Auftrags- und Nachtragsentwuerfe.
     *
     * Ausdruecklich OHNE Filter auf `deleted` oder `status`: Verworfene und
     * verbrauchte Entwuerfe muessen jedes Geraet erreichen, sonst bliebe dort
     * ein alter lokaler Entwurf stehen und wuerde erneut hochgeladen. Ein
     * Endzustand reist ohne Inhalt. Sichtbar fuer jedes aktive Mitglied -- wie
     * das Bearbeiten der Entwuerfe im Produkt.
     */
    'order_drafts', coalesce(
      (select jsonb_agg(
                case when od.deleted or od.status <> 'active' then to_jsonb(od) - 'payload' else to_jsonb(od) end
                order by od.updated_at, od.client_draft_id)
         from public.workspace_order_drafts od
        where od.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    'order_amendment_drafts', coalesce(
      (select jsonb_agg(
                case when ad.deleted or ad.status <> 'active' then to_jsonb(ad) - 'payload' else to_jsonb(ad) end
                order by ad.updated_at, ad.client_draft_id)
         from public.workspace_order_amendment_drafts ad
        where ad.workspace_id = p_workspace_id),
      '[]'::jsonb
    )
  );
end;
$$;

/* Eingangs-Abzug — wörtlich aus 20260916120000, für Mitglieder um den
 * Belegschutz ergänzt. Inhaber/Verwaltung (v_all) unverändert. */
create or replace function public.pull_workspace_intake_state(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_all boolean;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  v_all := public.can_write_workspace(p_workspace_id);

  return jsonb_build_object(
    'files', coalesce((
      select jsonb_agg(to_jsonb(f)) from public.workspace_files f
      where f.workspace_id = p_workspace_id and (v_all or (f.created_by = v_user_id
        and not public.workspace_file_is_restricted(p_workspace_id, f.client_file_ref_id)))
    ), '[]'::jsonb),
    'bindings', coalesce((
      select jsonb_agg(to_jsonb(b)) from public.workspace_document_file_bindings b
      where b.workspace_id = p_workspace_id and (v_all or (b.created_by = v_user_id
        and not public.workspace_document_is_restricted(p_workspace_id, b.client_document_id)
        and not public.workspace_file_is_restricted(p_workspace_id, b.client_file_ref_id)))
    ), '[]'::jsonb),
    'inbox_items', coalesce((
      select jsonb_agg(to_jsonb(i)) from public.workspace_inbox_items i
      where i.workspace_id = p_workspace_id and (v_all or (i.created_by = v_user_id
        and not public.workspace_inbox_item_is_restricted(p_workspace_id, i.client_inbox_id)))
    ), '[]'::jsonb),
    'work_results', coalesce((
      select jsonb_agg(to_jsonb(w)) from public.workspace_document_work_results w
      where w.workspace_id = p_workspace_id and (v_all or (w.created_by = v_user_id
        and not public.workspace_inbox_item_is_restricted(p_workspace_id, w.client_inbox_id)))
    ), '[]'::jsonb),
    'archived_documents', coalesce((
      select jsonb_agg(to_jsonb(d)) from public.workspace_documents d
      where d.workspace_id = p_workspace_id and d.document_kind = 'archived_document'
        and (v_all or (d.created_by = v_user_id
          and not public.workspace_document_is_restricted(p_workspace_id, d.client_document_id)))
    ), '[]'::jsonb)
  );
end;
$$;

/* Versand je Rechnung — wörtlich aus 20260914120000, ergänzt. */
create or replace function public.list_workspace_document_deliveries(
  p_workspace_id uuid,
  p_document_kind text,
  p_linked_invoice_id text
)
returns setof public.workspace_document_deliveries
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
  if nullif(btrim(coalesce(p_linked_invoice_id, '')), '') is null then
    raise exception 'linked_invoice_id fehlt';
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and d.linked_invoice_id = btrim(p_linked_invoice_id)
    and (nullif(btrim(coalesce(p_document_kind, '')), '') is null or d.document_kind = btrim(p_document_kind))
    and (public.can_write_workspace(p_workspace_id)
      or d.linked_document_id is null
      or not public.workspace_document_is_restricted(p_workspace_id, d.linked_document_id))
  order by d.requested_at desc, d.created_at desc;
end;
$$;

/* Versand je Dokument — wörtlich aus 20260922120000, ergänzt. */
create or replace function public.list_workspace_document_deliveries_for_document(
  p_workspace_id uuid,
  p_client_document_id text
)
returns setof public.workspace_document_deliveries
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
  if nullif(btrim(coalesce(p_client_document_id, '')), '') is null then
    raise exception 'client_document_id fehlt';
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and d.linked_document_id = btrim(p_client_document_id)
    and d.document_kind in ('letter', 'offer', 'other')
    and (public.can_write_workspace(p_workspace_id)
      or d.linked_document_id is null
      or not public.workspace_document_is_restricted(p_workspace_id, d.linked_document_id))
  order by d.requested_at desc, d.created_at desc;
end;
$$;

/* Versand je Kunde/Vorgang — wörtlich aus 20261011120000, ergänzt. */
create or replace function public.list_workspace_document_deliveries_for_context(
  p_workspace_id uuid,
  p_customer_id text default null,
  p_vorgang_id text default null
)
returns setof public.workspace_document_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if v_customer_id is null and v_vorgang_id is null then
    raise exception 'customer_id oder vorgang_id fehlt';
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and ((v_customer_id is not null and d.customer_id = v_customer_id)
      or (v_vorgang_id is not null and d.vorgang_id = v_vorgang_id))
    and (public.can_write_workspace(p_workspace_id)
      or d.linked_document_id is null
      or not public.workspace_document_is_restricted(p_workspace_id, d.linked_document_id))
  order by d.requested_at desc, d.created_at desc;
end;
$$;

/* Versand für mehrere Dokumente — wörtlich aus 20261013120000, ergänzt. */
create or replace function public.list_workspace_document_deliveries_for_documents(
  p_workspace_id uuid,
  p_invoice_ids text[],
  p_document_ids text[]
)
returns setof public.workspace_document_deliveries
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_invoice_ids text[];
  v_document_ids text[];
  v_limit constant integer := 250;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  -- Bereinigt: getrimmt, ohne Leere, ohne Dubletten.
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_invoice_ids
  from unnest(coalesce(p_invoice_ids, '{}')) as t(x)
  where nullif(btrim(coalesce(x, '')), '') is not null;
  select coalesce(array_agg(distinct btrim(x)), '{}') into v_document_ids
  from unnest(coalesce(p_document_ids, '{}')) as t(x)
  where nullif(btrim(coalesce(x, '')), '') is not null;

  if cardinality(v_invoice_ids) > v_limit or cardinality(v_document_ids) > v_limit then
    raise exception 'Zu viele Kennungen (hoechstens % je Art)', v_limit;
  end if;
  if cardinality(v_invoice_ids) = 0 and cardinality(v_document_ids) = 0 then
    return;
  end if;

  return query
  select d.*
  from public.workspace_document_deliveries d
  where d.workspace_id = p_workspace_id
    and (
      (d.linked_invoice_id is not null and d.linked_invoice_id = any (v_invoice_ids))
      or (d.linked_document_id is not null and d.linked_document_id = any (v_document_ids))
    )
    and (public.can_write_workspace(p_workspace_id)
      or d.linked_document_id is null
      or not public.workspace_document_is_restricted(p_workspace_id, d.linked_document_id))
  order by d.requested_at desc, d.created_at desc;
end;
$$;

/* Dokument löschen — wörtlich aus 20261029120000, nach dem Zahlungsnachweis-
 * Schutz um den Belegschutz ergänzt. */
create or replace function public.tombstone_workspace_document(
  p_workspace_id uuid,
  p_client_document_id text
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_documents;
  v_updated public.workspace_documents;
  v_document_id text;
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

  /*
   * BARZAHLUNG-V1 NACHTRAG 1 — auch der Rechnungsdokument-Weg kennt den
   * Zahlungsnachweis. Zwei Loeschwege, ein Schutz.
   */
  perform public.assert_document_not_payment_proof(p_workspace_id, p_client_document_id);

  /*
   * P1 MITARBEITERZAHLUNGEN — Datenschutz. Den Beleg einer Mitarbeiterzahlung
   * löschen und lesen nur Inhaber und Verwaltung. Ohne diese Prüfung gäbe die
   * Wiederholung an einem bereits gelöschten Beleg die Zeile jedem Mitglied
   * zurück.
   */
  if not public.can_write_workspace(p_workspace_id)
    and public.workspace_document_is_restricted(p_workspace_id, p_client_document_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_document_id := nullif(trim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;

  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and client_document_id = v_document_id
  for update;

  if v_existing.id is null then
    raise exception 'Dokument nicht gefunden';
  end if;

  -- Idempotent: ein bereits geloeschtes Dokument bleibt, wie es ist.
  if v_existing.deleted_at is not null then
    return next v_existing;
    return;
  end if;

  -- A1: Der archivierte Beleg einer festgeschriebenen Rechnung bleibt.
  if v_existing.document_kind in ('generated_invoice', 'generated_invoice_correction')
     and v_existing.linked_invoice_id is not null
     and exists (
       select 1
       from public.workspace_invoices wi
       where wi.workspace_id = p_workspace_id
         and wi.client_invoice_id = v_existing.linked_invoice_id
         and wi.invoice_status in ('vorbereitet', 'versendet')
     ) then
    raise exception 'Archivdokument einer festgeschriebenen Rechnung kann nicht geloescht werden';
  end if;

  update public.workspace_documents
  set deleted_at = now(),
      deleted_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.deleted_at is null then
    raise exception 'Loeschung nicht angewendet';
  end if;

  return next v_updated;
end;
$$;

/* Generisches Schreiben — wörtlich aus 20261103120000, nur die Wiederholungen
 * von Papierregister und Kommunikationsereignis um den Belegschutz ergänzt.
 * Neue und geänderte Zeilen deckt der Schreibschutz-Trigger ab. */
create or replace function public.upsert_workspace_sync_entity(
  p_workspace_id uuid,
  p_entity_type text,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version bigint;
  v_result jsonb;
  v_vorgang_id text;
  v_customer_id text;
  -- BRIEFE-01B: nur fuer den business_letter-Zweig.
  v_letter_id text;
  v_letter_customer_id text;
  v_letter_vorgang_id text;
  v_letter_status text;
  v_letter_payload jsonb;
  v_row_letter public.workspace_business_letters;
  -- ANGEBOT->AUFTRAG-02B: nur fuer den vorgang-Zweig.
  v_incoming_vorgang jsonb;
  v_key text;
  v_offer_result_vid text;
  -- EINGANG-01C-2: nur fuer den vorgang-Zweig.
  v_request_vorgang_number boolean;
  v_vorgang_number text;
  -- ANGEBOT-01B: nur fuer den offer-Zweig.
  v_offer_id text;
  v_offer_customer_id text;
  v_offer_status text;
  v_offer_payload jsonb;
  v_row_offer public.workspace_offers;
  v_offer_archive text;
  -- CLOUD-DURABILITY-01B: nur fuer den vorgang_note-Zweig.
  v_note_id text;
  v_note_vorgang_id text;
  v_note_payload jsonb;
  -- CLOUD-DURABILITY-01C: nur fuer den task-Zweig.
  v_task_id text;
  v_task_payload jsonb;
  v_task_status text;
  v_task_dedupe text;
  v_task_auto boolean;
  v_canonical public.workspace_tasks;
  -- SYNC-DURABILITY-HARDENING-01G: der gespeicherte Stand fuer den Version-0-Vertrag.
  v_row_vorgang public.workspace_vorgaenge;
  v_row_customer public.workspace_customers;
  v_row_note public.workspace_vorgang_notes;
  v_row_task public.workspace_tasks;
  v_incoming jsonb;
  -- CLOUD-DURABILITY-01D: nur fuer den dunning_documentation-Zweig.
  v_dun_id text;
  v_dun_invoice_id text;
  v_dun_vorgang_id text;
  v_dun_kind text;
  v_dun_documented_at date;
  v_dun_delivery text;
  v_dun_payload jsonb;
  v_dun_existing public.workspace_invoice_dunning_documentations;
  v_deleted boolean;
  -- BRANDING-01E-0 / FIRMENPROFIL-01B: nur fuer den company_profile-Zweig.
  v_existing_profile jsonb;
  v_incoming_profile jsonb;
  v_incoming_schema integer;
  v_field record;
  /* BANKABGLEICH-V1 BLOCK 2B: nur fuer die beiden Bank-Zweige. */
  v_bank_account_id text;
  v_bank_account_payload jsonb;
  v_bank_transaction_id text;
  v_bank_transaction_payload jsonb;
  v_row_bank_account public.workspace_bank_accounts;
  v_row_bank_transaction public.workspace_bank_transactions;
  /* CLOUD-SYNC S1: nur fuer den paper_register_entry-Zweig. */
  v_paper_entry_id text;
  v_paper_document_id text;
  v_paper_payload jsonb;
  v_row_paper public.workspace_paper_register_entries;
  /* CLOUD-SYNC S2: nur fuer den communication_event-Zweig. */
  v_comm_event_id text;
  v_comm_payload jsonb;
  v_comm_context jsonb;
  v_comm_context_type text;
  v_comm_event_type text;
  v_comm_event_at timestamptz;
  v_row_comm public.workspace_communication_events;
  /* CLOUD-SYNC S3: nur fuer den knowledge_fact-Zweig. */
  v_fact_id text;
  v_fact_payload jsonb;
  v_fact_scope text;
  v_row_fact public.workspace_knowledge_facts;
  /* CLOUD-SYNC S5: nur fuer den invoice_draft-Zweig. */
  v_draft_id text;
  v_draft_payload jsonb;
  v_draft_vorgang_id text;
  v_draft_type text;
  v_draft_slot_owner text;
  v_row_draft public.workspace_invoice_drafts;
  /* CLOUD-SYNC S6: nur fuer die Zweige order_draft und order_amendment_draft. */
  v_order_draft_id text;
  v_order_draft_payload jsonb;
  v_row_order_draft public.workspace_order_drafts;
  v_amend_draft_id text;
  v_amend_draft_vorgang_id text;
  v_amend_draft_payload jsonb;
  v_row_amend_draft public.workspace_order_amendment_drafts;
  v_amend_draft_vorgang public.workspace_vorgaenge;
begin
  /*
   * SYNC-DURABILITY-HARDENING-01G4 -- kein dritter Zustand.
   *
   * Alle folgenden Zweige vergleichen `p_row_version`. Waere der Wert `NULL`,
   * ergaebe jeder dieser Vergleiche `NULL` und damit nicht wahr -- die Zeile
   * wuerde ungeprueft ueberschrieben. Eine fehlende Angabe ist keine bestaetigte
   * Serverversion, also gilt sie hier als unbestaetigt.
   */
  p_row_version := coalesce(p_row_version, 0);

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if p_entity_type = 'vorgang' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_vorgang_id := coalesce(nullif(trim(p_payload->>'vorgang_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_vorgang_id is null then
      raise exception 'vorgang_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    -- EINGANG-01C-2: der Nummernwunsch zaehlt nur als ausdrueckliches JSON-true auf Push-Ebene.
    v_request_vorgang_number := coalesce(
      jsonb_typeof(p_payload->'request_vorgang_number') = 'boolean'
        and (p_payload->>'request_vorgang_number')::boolean,
      false
    );

    select v.* into v_row_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id
    for update;
    v_current_version := v_row_vorgang.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — Version 0 bei vorhandener Zeile.
     *
     * `p_row_version = 0` heisst ausschliesslich: Dieser Client hat **keine**
     * bestaetigte Serverversion. Bisher umging dieser Wert die Versionspruefung
     * vollstaendig und durfte deshalb eine neuere Fassung oder einen Grabstein
     * ueberschreiben. Zulaessig ist er jetzt nur noch in zwei Faellen: Es gibt
     * keine Zeile (CREATE), oder der Inhalt ist identisch — dann ist es die
     * Wiederholung eines Schreibvorgangs, dessen Bestaetigung verloren ging, und
     * die Zeile wird unveraendert zurueckgegeben.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_vorgang.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_vorgang.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * EINGANG-01C-2 -- die Vorgangsnummer schreibt der Server selbst in den
       * Payload. Ein sonst identischer Replay ohne sie ist dieselbe Absicht;
       * eine abweichende mitgesendete Nummer ist dagegen kein Replay.
       */
      if (v_row_vorgang.payload - 'vorgangNumber') = (v_incoming - 'vorgangNumber' - 'request_vorgang_number')
         and (not (v_incoming ? 'vorgangNumber') or v_incoming->>'vorgangNumber' is not distinct from v_row_vorgang.vorgang_number)
         and v_row_vorgang.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', v_row_vorgang.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- ANGEBOT->AUFTRAG-02B: Auftragsherkunft und -nummer vergibt nur accept_workspace_offer.
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if (not v_deleted) and (v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber') then
        raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
      end if;

      -- EINGANG-01C-2: Eine Vorgangsnummer vergibt ausschliesslich der Server.
      if v_incoming_vorgang ? 'vorgangNumber' then
        raise exception 'Vorgangsnummer vergibt ausschliesslich der Server' using errcode = 'P0001';
      end if;
      v_incoming_vorgang := v_incoming_vorgang - 'request_vorgang_number';
      /*
       * Nur auf ausdruecklichen Wunsch und nie fuer einen Grabstein. Ein
       * Erst-Upload ohne Wunsch -- Altbestand, Provisioning -- bleibt ohne
       * Nummer: kein Backfill. Vergabe und Einfuegen teilen die Transaktion;
       * scheitert das Einfuegen, rollt auch der Zaehler zurueck.
       */
      v_vorgang_number := null;
      if v_request_vorgang_number and not v_deleted then
        v_vorgang_number := public.allocate_workspace_vorgang_number(p_workspace_id);
        v_incoming_vorgang := v_incoming_vorgang || jsonb_build_object('vorgangNumber', v_vorgang_number);
      end if;

      insert into public.workspace_vorgaenge (
        workspace_id,
        vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by,
        vorgang_number
      )
      values (
        p_workspace_id,
        v_vorgang_id,
        v_incoming_vorgang,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        v_vorgang_number
      )
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * ANGEBOT->AUFTRAG-02B / AUFTRAG-02C -- Serverwahrheit fuer Auftraege.
       *
       * Ohne Auftragsnummer: Der Payload darf weder Herkunft noch Nummer
       * tragen (die setzen nur accept_workspace_offer und
       * create_workspace_order). Mit Auftragsnummer -- aus Angebot oder
       * manuell -- gilt fuer beide dasselbe Regelwerk: Die
       * kaufmaennischen Snapshot-Felder sind write-once, und Herkunft, Nummer,
       * Datum werden aus den Spalten bzw. dem gespeicherten Payload erzwungen --
       * ein abweichender Client-Wert erreicht die Zeile nie.
       */
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, v_row_vorgang.payload);
      if not v_deleted then
        -- AUFTRAG-02C: Die Frage ist "bestaetigter eigener Auftrag?", nicht "aus Angebot?".
        if v_row_vorgang.order_number is null then
          if v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber' then
            raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
          end if;
        else
          foreach v_key in array array['contractConfirmation', 'taxStatus', 'paymentTermsText', 'introText', 'closingText', 'contractTotals', 'customerId', 'customerBilling'] loop
            if v_row_vorgang.payload ? v_key and (v_row_vorgang.payload -> v_key) is distinct from (v_incoming_vorgang -> v_key) then
              raise exception 'Auftrag: % ist festgeschrieben', v_key using errcode = 'P0001';
            end if;
          end loop;
          -- Operativer Plan: nur Hauptsnapshot + bestaetigte Nachtraege (executedQuantity bleibt frei).
          perform public.assert_workspace_order_positions_frozen(
            p_workspace_id, v_vorgang_id, v_row_vorgang.payload->'contractConfirmation', v_incoming_vorgang->'orderPositions');
          if (v_incoming_vorgang ? 'sourceOfferId' and v_incoming_vorgang->>'sourceOfferId' is distinct from v_row_vorgang.source_offer_id)
             or (v_incoming_vorgang ? 'orderNumber' and v_incoming_vorgang->>'orderNumber' is distinct from v_row_vorgang.order_number) then
            raise exception 'Auftragsherkunft und Auftragsnummer koennen nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_strip_nulls(jsonb_build_object(
            'sourceOfferId', v_row_vorgang.source_offer_id,
            'orderNumber', v_row_vorgang.order_number,
            'sourceOfferNumber', v_row_vorgang.payload->'sourceOfferNumber',
            'orderDate', v_row_vorgang.payload->'orderDate'
          ));
        end if;

        /*
         * EINGANG-01C-2 -- unabhaengig vom Auftrag: Die Spalte ist die Wahrheit,
         * der Payload ihr Abbild. Ohne Nummer darf der Client keine setzen; mit
         * Nummer darf er sie weder aendern noch entfernen -- ein alter Stand
         * ohne Feld bekommt sie zurueckgeschrieben.
         */
        v_incoming_vorgang := v_incoming_vorgang - 'request_vorgang_number';
        if v_row_vorgang.vorgang_number is null then
          if v_incoming_vorgang ? 'vorgangNumber' then
            raise exception 'Vorgangsnummer vergibt ausschliesslich der Server' using errcode = 'P0001';
          end if;
        else
          if v_incoming_vorgang ? 'vorgangNumber'
             and v_incoming_vorgang->>'vorgangNumber' is distinct from v_row_vorgang.vorgang_number then
            raise exception 'Vorgangsnummer kann nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_build_object('vorgangNumber', v_row_vorgang.vorgang_number);
        end if;
      end if;

      update public.workspace_vorgaenge
      set
        payload = case when v_deleted then payload else v_incoming_vorgang end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and vorgang_id = v_vorgang_id
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_vorgang_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'customer' then
    /*
     * PRODUCT-FOUNDATION-03A-S1 -- strukturgleich zum Vorgangs-Zweig.
     *
     * Der Server prueft Berechtigung und Sync-Struktur, NICHT die
     * Customer-Fachlogik. Eigenfirmen-Guard, Namensvergleich und
     * Dublettenerkennung bleiben ausschliesslich im Client: der Guard braucht
     * das lokale Firmenprofil, das serverseitig gar nicht auswertbar ist.
     *
     * `deleted`/`deleted_at` werden bereits nach dem Vorgangs-Protokoll
     * behandelt, obwohl es noch keine Loeschfunktion gibt. Kein Client erzeugt
     * in diesem Stand `deleted = true`; die Semantik steht aber bereit, ohne
     * dass spaeter eine zweite Migration dieselbe RPC erneut anfassen muss.
     */
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_customer_id := coalesce(nullif(trim(p_payload->>'customer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_customer_id is null then
      raise exception 'customer_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    select c.* into v_row_customer
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
    for update;
    v_current_version := v_row_customer.row_version;

    -- 01G — siehe Vorgangs-Zweig: Version 0 ueberschreibt keine vorhandene Zeile.
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_customer.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_customer.deleted and not v_deleted then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_customer.payload = v_incoming and v_row_customer.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', v_row_customer.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_customers (
        workspace_id,
        customer_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_customer_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_customers.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_customers
      set
        payload = case when v_deleted then payload else coalesce(p_payload->'payload', p_payload, payload) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and customer_id = v_customer_id
      returning to_jsonb(public.workspace_customers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_customer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'business_letter' then
    /*
     * BRIEFE-01B — ausgehendes Geschaeftsschreiben.
     *
     * Schreibrecht wie bei Notizen und Aufgaben: Ein Brief ist normale
     * Bueroarbeit, keine Eigentuemerhandlung. Der Versionsvertrag ist
     * unveraendert der aus 01G -- einschliesslich der Regel, dass eine
     * unbestaetigte Version (<= 0) nur anlegen oder eine inhaltsgleiche
     * Wiederholung sein darf.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_letter_id := coalesce(nullif(trim(p_payload->>'letter_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_letter_id is null then
      raise exception 'letter_id fehlt';
    end if;

    v_letter_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_letter_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_letter_payload->>'customerId')), '');
    v_letter_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_letter_payload->>'vorgangId')), '');
    v_letter_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_letter_payload->>'status'), ''), 'draft');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_letter_status not in ('draft', 'finalized') then
      raise exception 'Brief ungueltig: status' using errcode = 'P0001';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_letter_payload->'subject') <> 'string' or length(trim(v_letter_payload->>'subject')) = 0 then
        raise exception 'Brief ungueltig: subject' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'subject') > 300 then
        raise exception 'Brief ungueltig: subject zu lang' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_letter_payload->'body') <> 'string' or length(trim(v_letter_payload->>'body')) = 0 then
        raise exception 'Brief ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'body') > 50000 then
        raise exception 'Brief ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select l.* into v_row_letter
    from public.workspace_business_letters l
    where l.workspace_id = p_workspace_id and l.client_letter_id = v_letter_id
    for update;
    v_current_version := v_row_letter.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — unbestaetigte Version bei vorhandener
     * Zeile. Wortgleich zu den uebrigen Zweigen: Anlegen ist erlaubt, eine
     * inhaltsgleiche Wiederholung wird unveraendert zurueckgegeben, alles
     * andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_letter.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_letter.deleted) and v_row_letter.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_business_letters (
        workspace_id,
        client_letter_id,
        client_customer_id,
        client_vorgang_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_letter_id,
        v_letter_customer_id,
        v_letter_vorgang_id,
        v_letter_status,
        case when v_deleted then '{}'::jsonb else v_letter_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * BRIEFE-01B -- ein fertiggestellter Brief ist ein Beleg.
       *
       * Die Unveraenderlichkeit darf nicht am Client haengen: Wer den Aufruf
       * nachbaut, koennte sonst Betreff, Text, Datum, Empfaenger oder den
       * eingefrorenen Absender-Schnappschuss nachtraeglich umschreiben -- und
       * das Dokument hiesse morgen etwas anderes als das, was der Empfaenger
       * bekommen hat. Deshalb steht der Guard hier, nicht nur im Fachdienst.
       *
       * Erlaubt bleiben ausdruecklich:
       *   * der Uebergang draft -> finalized (die Zeile ist dann noch draft),
       *   * die wortgleiche Wiederholung eines Schreibvorgangs, dessen
       *     Bestaetigung verloren ging -- sie aendert nichts,
       *   * der Grabstein: Loeschen ist kein Umschreiben, und der Loeschweg
       *     muss dem uebrigen Sync-Vertrag folgen.
       *
       * `documentId` bleibt vom Vergleich ausgenommen: Es benennt die spaeter
       * erzeugte Archivdatei, gehoert aber nicht zum fachlichen Inhalt des
       * Schreibens.
       */
      if v_row_letter.status = 'finalized' and not v_row_letter.deleted and not v_deleted then
        if v_letter_status <> 'finalized' then
          raise exception 'Brief ist fertiggestellt und kann nicht zurueckgesetzt werden'
            using errcode = 'P0001';
        end if;
        if (v_row_letter.payload - 'documentId') is distinct from (v_letter_payload - 'documentId') then
          raise exception 'Brief ist fertiggestellt und kann nicht mehr geaendert werden'
            using errcode = 'P0001';
        end if;
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso die Bezuege zu Kunde
       * und Auftrag -- sie sind die Ordnung, ueber die ein zweites Geraet den
       * Grabstein zuordnet.
       */
      update public.workspace_business_letters
      set
        payload = case when v_deleted then payload else coalesce(v_letter_payload, payload) end,
        client_customer_id = coalesce(v_letter_customer_id, client_customer_id),
        client_vorgang_id = coalesce(v_letter_vorgang_id, client_vorgang_id),
        status = case when v_deleted then status else v_letter_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_letter_id = v_letter_id
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_letter_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'offer' then
    /*
     * ANGEBOT-01B -- eigenes Angebot.
     *
     * Schreibrecht wie bei Briefen: normale Bueroarbeit, `workspace_user_can_intake`.
     * Versionsvertrag unveraendert aus 01G. Zusaetzlich:
     *   * Die Freigabe (Entwurf -> Nummer) laeuft NICHT hier, sondern nur ueber
     *     `finalize_workspace_offer`. Ein Client, der einen Entwurf mit einem
     *     anderen Status oder einer Nummer schreibt, wird abgewiesen.
     *   * Ein freigegebenes Angebot ist ein Beleg: Der eingefrorene Inhalt darf
     *     sich nicht aendern. Erlaubt sind nur die Zustandsfelder (status,
     *     sentAt, decidedAt, archiveDocumentId, resultingVorgangId, updatedAt)
     *     -- und nur entlang der erlaubten Uebergaenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_offer_id := coalesce(nullif(trim(p_payload->>'offer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_offer_id is null then
      raise exception 'offer_id fehlt';
    end if;

    v_offer_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_offer_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_offer_payload->>'customerId')), '');
    v_offer_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_offer_payload->>'status'), ''), 'entwurf');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_offer_status not in ('entwurf', 'freigegeben', 'versendet', 'angenommen', 'abgelehnt', 'storniert', 'ersetzt') then
      raise exception 'Angebot ungueltig: status' using errcode = 'P0001';
    end if;

    select o.* into v_row_offer
    from public.workspace_offers o
    where o.workspace_id = p_workspace_id and o.client_offer_id = v_offer_id
    for update;
    v_current_version := v_row_offer.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_offer.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) and v_row_offer.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- Neu anlegen darf nur ein Entwurf ohne Nummer: Nummern vergibt die Freigabe.
      if (not v_deleted) and (v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber') then
        raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
      end if;

      insert into public.workspace_offers (
        workspace_id,
        client_offer_id,
        client_customer_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_offer_id,
        v_offer_customer_id,
        case when v_deleted then 'entwurf' else v_offer_status end,
        case when v_deleted then '{}'::jsonb else v_offer_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_offers.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) then
        if v_row_offer.status = 'entwurf' then
          -- Ein Entwurf bleibt Entwurf: Freigabe und Nummer nur ueber die RPC.
          if v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber' then
            raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
          end if;
        else
          -- Beleg: nur Zustandsfelder duerfen sich aendern, und nur vorwaerts.
          if (v_row_offer.payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt')
             is distinct from
             (v_offer_payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt') then
            raise exception 'Angebot ist freigegeben und kann nicht mehr geaendert werden' using errcode = 'P0001';
          end if;
          if v_offer_status <> v_row_offer.status then
            -- ANGEBOT->AUFTRAG-02B: Annahme nur atomar mit dem Auftrag.
            if v_offer_status = 'angenommen' then
              raise exception 'Annahme nur ueber accept_workspace_offer' using errcode = 'P0001';
            end if;
            if not (
              (v_row_offer.status = 'freigegeben' and v_offer_status in ('versendet', 'abgelehnt', 'storniert', 'ersetzt'))
              or (v_row_offer.status = 'versendet' and v_offer_status in ('abgelehnt', 'storniert', 'ersetzt'))
            ) then
              raise exception 'Statuswechsel % -> % ist nicht erlaubt', v_row_offer.status, v_offer_status using errcode = 'P0001';
            end if;
          end if;
          -- ANGEBOT->AUFTRAG-02B: resultingVorgangId ist Serverwahrheit (write-once, nur ueber die RPC).
          v_offer_result_vid := nullif(trim(coalesce(v_offer_payload->>'resultingVorgangId', '')), '');
          if v_offer_result_vid is distinct from nullif(trim(coalesce(v_row_offer.payload->>'resultingVorgangId', '')), '') then
            raise exception 'Auftragsbezug eines Angebots nur ueber accept_workspace_offer' using errcode = 'P0001';
          end if;
          -- Die Serverwahrheit ueber Nummer und Fingerabdruck bleibt, was sie ist.
          v_offer_payload := v_offer_payload || jsonb_build_object(
            'offerNumber', v_row_offer.offer_number,
            'offerSequenceNumber', v_row_offer.offer_sequence_number,
            'contentFingerprint', v_row_offer.content_fingerprint
          );
        end if;
      end if;

      /*
       * ANGEBOT-01B (Pre-Acceptance) -- Archiv-Invariante, serverseitig.
       * Die Ablage ist write-once und darf nur auf ein Dokument desselben
       * Workspaces zeigen, das als eigenes Angebot (classifiedKind = angebot)
       * genau dieses Angebot referenziert (linkedOfferId). Ein Entwurf hat
       * keine Ablage; ein Fremddokument oder das Dokument eines anderen
       * Angebots wird abgewiesen.
       */
      if not v_deleted then
        v_offer_archive := nullif(trim(coalesce(v_offer_payload->>'archiveDocumentId', '')), '');
        if v_offer_archive is distinct from nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') then
          if v_row_offer.status = 'entwurf' then
            raise exception 'Ein Entwurf hat keine Archivablage' using errcode = 'P0001';
          end if;
          if nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') is not null then
            raise exception 'Archivdokument eines Angebots kann nicht gewechselt werden' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and not exists (
            select 1 from public.workspace_documents d
            where d.workspace_id = p_workspace_id
              and d.client_document_id = v_offer_archive
              and d.deleted = false
              and d.payload->>'classifiedKind' = 'angebot'
              and d.payload->>'linkedOfferId' = v_offer_id
          ) then
            raise exception 'Archivdokument gehoert nicht zu diesem Angebot' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and exists (
            select 1 from public.workspace_offers o2
            where o2.workspace_id = p_workspace_id
              and o2.client_offer_id <> v_offer_id
              and o2.payload->>'archiveDocumentId' = v_offer_archive
          ) then
            raise exception 'Archivdokument ist bereits einem anderen Angebot zugeordnet' using errcode = 'P0001';
          end if;
        end if;
      end if;

      -- Loeschen: nur Entwuerfe. Ein Beleg wird storniert, nicht entfernt.
      if v_deleted and v_row_offer.status <> 'entwurf' then
        raise exception 'Ein freigegebenes Angebot kann nicht geloescht werden' using errcode = 'P0001';
      end if;

      update public.workspace_offers
      set
        payload = case when v_deleted then payload else coalesce(v_offer_payload, payload) end,
        client_customer_id = coalesce(v_offer_customer_id, client_customer_id),
        status = case when v_deleted then status else v_offer_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_offer_id = v_offer_id
      returning to_jsonb(public.workspace_offers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_offer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'vorgang_note' then
    /*
     * CLOUD-DURABILITY-CORE-01B -- Vorgangsnotizen.
     *
     * Berechtigung bewusst NICHT `can_write_workspace` (Inhaber/Admin):
     * Die Notiz entsteht heute in `VorgangDetailPage` ueber `addVorgangNote`
     * ohne jede Rollenpruefung -- jedes aktive Mitglied darf sie lokal
     * schreiben. `can_write_workspace` wuerde genau diese Mitglieder beim
     * ersten Push aussperren und ihre Notizen dauerhaft in der Outbox
     * haengen lassen. Verwendet wird deshalb die vorhandene Funktion
     * `workspace_user_can_intake` -- dieselbe Berechtigung, die schon fuer
     * Eingang und Dokumente den Satz "aktives Mitglied" ausdrueckt.
     *
     * SELECT: jedes aktive Mitglied (`is_active_workspace_member`, Policy
     * unten) -- lokal sieht jedes Mitglied alle Notizen eines Vorgangs, die
     * Cloud darf daran nichts verengen.
     * INSERT/UPDATE/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese
     * Security-Definer-RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Notiz-ID, Vorgangsbezug und ein Textkoerper in vertretbarer Laenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_note_id := coalesce(nullif(trim(p_payload->>'note_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_note_id is null then
      raise exception 'note_id fehlt';
    end if;

    v_note_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_note_vorgang_id := coalesce(
      nullif(trim(p_payload->>'vorgang_id'), ''),
      nullif(trim(v_note_payload->>'vorgangId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Guard: der Vorgangsbezug ist die Ordnung dieser Tabelle und darf nur am
    -- Grabstein fehlen -- dort wird kein Fachinhalt mitgeschickt.
    if v_note_vorgang_id is null and not v_deleted then
      raise exception 'vorgang_id fehlt';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_note_payload->'body') <> 'string' or length(trim(v_note_payload->>'body')) = 0 then
        raise exception 'Notiz ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_note_payload->>'body') > 20000 then
        raise exception 'Notiz ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select n.* into v_row_note
    from public.workspace_vorgang_notes n
    where n.workspace_id = p_workspace_id and n.client_note_id = v_note_id
    for update;
    v_current_version := v_row_note.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Notiz.
     *
     * Der Grabsteinfall ist hier der wichtigste: Eine geloeschte Notiz durfte
     * bisher von einem unbestaetigten Schreibvorgang wiederbelebt werden. Jetzt
     * gilt auch fuer sie: identischer Inhalt = Wiederholung, alles andere =
     * Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_note.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * 01G2 -- derselbe Loeschvorgang, im Produkt beobachtet.
       *
       * Wird eine nie bestaetigte Notiz geloescht und geht die Antwort
       * verloren, schickt der Wiederanlauf den **vollen** Fachinhalt mit
       * `deleted = true`; die Serverzeile traegt aber `payload = {}`, weil ein
       * Grabstein beim Einfuegen keinen Inhalt speichert. Ein reiner
       * Inhaltsvergleich hielt das faelschlich fuer einen Konflikt -- der
       * Sendeauftrag blieb dauerhaft blockiert (im Browser reproduziert).
       *
       * Beide Seiten wollen dasselbe: geloescht. Das ist ein sicherer Replay.
       */
      if v_row_note.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_note.payload = v_note_payload and v_row_note.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', v_row_note.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_vorgang_notes (
        workspace_id,
        client_note_id,
        client_vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_note_id,
        v_note_vorgang_id,
        case when v_deleted then '{}'::jsonb else v_note_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: der Fachinhalt bleibt unveraendert stehen (wie im
       * Vorgangs-Zweig), der Vorgangsbezug ebenso -- er ist die einzige
       * Ordnung, ueber die ein zweites Geraet den Grabstein zuordnet.
       */
      update public.workspace_vorgang_notes
      set
        payload = case when v_deleted then payload else coalesce(v_note_payload, payload) end,
        client_vorgang_id = coalesce(v_note_vorgang_id, client_vorgang_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_note_id = v_note_id
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_note_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'task' then
    /*
     * CLOUD-DURABILITY-CORE-01C -- Aufgaben.
     *
     * Berechtigung wie bei den Vorgangsnotizen und aus demselben Grund:
     * Aufgaben entstehen heute ohne jede Rollenpruefung -- die Engine legt sie
     * beim blossen Oeffnen der Aufgabenseite an, und jedes aktive Mitglied darf
     * sie erledigen. `can_write_workspace` (Inhaber/Admin) wuerde genau diese
     * Mitglieder aussperren und ihre Aufgaben dauerhaft in der Outbox halten.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE/UPDATE/Statuswechsel/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_task_id := coalesce(nullif(trim(p_payload->>'task_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_task_id is null then
      raise exception 'task_id fehlt';
    end if;

    v_task_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    v_task_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_task_payload->>'status'), ''), 'open');
    v_task_dedupe := coalesce(p_payload->>'dedupe_key', '');
    v_task_auto := coalesce((p_payload->>'auto_created')::boolean, false);

    -- Guards: nur Sync-Struktur, keine Fachlogik.
    if v_task_status not in ('open', 'in_progress', 'done', 'archived') then
      raise exception 'Aufgabe ungueltig: status' using errcode = 'P0001';
    end if;
    if not v_deleted then
      if jsonb_typeof(v_task_payload->'title') <> 'string' or length(trim(v_task_payload->>'title')) = 0 then
        raise exception 'Aufgabe ungueltig: title' using errcode = 'P0001';
      end if;
      if length(v_task_payload->>'title') > 500 then
        raise exception 'Aufgabe ungueltig: title zu lang' using errcode = 'P0001';
      end if;
    end if;

    /*
     * Idempotenz fuer konkurrierende automatische Aufgaben.
     *
     * Zwei Geraete, die offline dieselbe automatische Aufgabe erzeugen, senden
     * zwei verschiedene `client_task_id` mit demselben `dedupe_key`. Der zweite
     * Push darf weder eine zweite Zeile anlegen noch an der Eindeutigkeit
     * sterben: Er ist fachlich ein Replay. Der Server gibt dann die bereits
     * vorhandene kanonische Zeile zurueck und markiert die Antwort mit
     * `deduped`; der Client uebernimmt sie und verwirft seine eigene Kennung.
     *
     * Die Pruefung gilt fuer jeden Write, der in einer aktiven automatischen
     * Aufgabe endet -- auch fuer ein Wiederoeffnen, das sonst am Index
     * scheitern wuerde. Manuelle Aufgaben (`auto_created = false`) und Aufgaben
     * ohne Dedupe-Identitaet (leerer Schluessel) sind ausgenommen.
     */
    if v_task_auto and v_task_dedupe <> '' and not v_deleted and v_task_status in ('open', 'in_progress') then
      select t.* into v_canonical
      from public.workspace_tasks t
      where t.workspace_id = p_workspace_id
        and t.dedupe_key = v_task_dedupe
        and t.auto_created
        and not t.deleted
        and t.status in ('open', 'in_progress')
        and t.client_task_id <> v_task_id
      order by t.created_at, t.client_task_id
      limit 1
      for update;

      if found then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_canonical.client_task_id,
          'requested_entity_id', v_task_id,
          'row_version', v_canonical.row_version,
          'payload', to_jsonb(v_canonical),
          'deleted', false,
          -- Zusatzfeld, rueckwaertskompatibel: aeltere Clients lesen es nicht.
          'deduped', true
        );
      end if;
    end if;

    select t.* into v_row_task
    from public.workspace_tasks t
    where t.workspace_id = p_workspace_id and t.client_task_id = v_task_id
    for update;
    v_current_version := v_row_task.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Aufgabe. Der Dedupe-Zweig oben ist
     * davon unberuehrt: Er beantwortet den fachlichen Wiederholungsfall zweier
     * Geraete und kommt vor dieser Pruefung.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_task.deleted and not v_deleted then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;
      -- 01G2 -- derselbe Loeschvorgang, siehe Notiz-Zweig.
      if v_row_task.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_task.payload = v_task_payload
         and v_row_task.deleted = v_deleted
         and v_row_task.status = v_task_status then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', v_row_task.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_tasks (
        workspace_id,
        client_task_id,
        status,
        dedupe_key,
        auto_created,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_task_id,
        v_task_status,
        v_task_dedupe,
        v_task_auto,
        case when v_deleted then '{}'::jsonb else v_task_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_tasks
      set
        payload = case when v_deleted then payload else coalesce(v_task_payload, payload) end,
        status = v_task_status,
        dedupe_key = v_task_dedupe,
        auto_created = v_task_auto,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_task_id = v_task_id
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_task_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'dunning_documentation' then
    /*
     * CLOUD-DURABILITY-CORE-01D -- Nachweis einer uebergebenen
     * Zahlungserinnerung oder Mahnung.
     *
     * Berechtigung wie bei Notizen und Aufgaben und aus demselben Grund: Das
     * Produkt kennt fuer das Dokumentieren keinerlei Rollenpruefung -- weder in
     * `DunningDocumentationPanel` noch in `dunningDocumentationService`. Jedes
     * aktive Mitglied darf es heute, und `can_write_workspace` (Inhaber/Admin)
     * wuerde genau diese Mitglieder beim ersten Push aussperren.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE und Wiederholung: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     *
     * **Append-only.** Es gibt kein Bearbeiten und kein Loeschen; entsprechend
     * kennt dieser Zweig keinen Update-Pfad und die Tabelle keine
     * Grabsteinspalten. Ein erneuter Push derselben Kennung ist ein Replay und
     * gibt die vorhandene Zeile unveraendert zurueck -- der Nachweis bleibt
     * genau so stehen, wie er festgehalten wurde.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_dun_id := coalesce(nullif(trim(p_payload->>'documentation_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_dun_id is null then
      raise exception 'documentation_id fehlt';
    end if;

    v_dun_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_dun_invoice_id := coalesce(nullif(trim(p_payload->>'invoice_id'), ''), nullif(trim(v_dun_payload->>'invoiceId'), ''));
    v_dun_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_dun_payload->>'vorgangId', '')), '');
    v_dun_kind := coalesce(nullif(trim(p_payload->>'kind'), ''), nullif(trim(v_dun_payload->>'kind'), ''));
    v_dun_delivery := coalesce(nullif(trim(p_payload->>'delivery_method'), ''), nullif(trim(v_dun_payload->>'deliveryMethod'), ''));

    -- Guards: nur Sync-Struktur und die Identitaetsfelder, keine Fachlogik.
    if v_dun_invoice_id is null then
      raise exception 'invoice_id fehlt';
    end if;
    if v_dun_kind is null or v_dun_kind not in ('payment_reminder', 'dunning_notice') then
      raise exception 'Mahnnachweis ungueltig: kind' using errcode = 'P0001';
    end if;
    if v_dun_delivery is null then
      raise exception 'Mahnnachweis ungueltig: delivery_method' using errcode = 'P0001';
    end if;
    begin
      v_dun_documented_at := (coalesce(nullif(trim(p_payload->>'documented_at'), ''), v_dun_payload->>'documentedAt'))::date;
    exception when others then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end;
    if v_dun_documented_at is null then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end if;

    /*
     * Wiederholung derselben Kennung: unveraendert zurueckgeben.
     *
     * Ein Nachweis wird nicht fortgeschrieben. Ein zweiter Push entsteht durch
     * einen wiederholten Sendeversuch oder einen Backfill, nicht durch eine
     * Aenderung -- und darf den festgehaltenen Inhalt niemals ueberschreiben.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id and d.client_documentation_id = v_dun_id
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false
      );
    end if;

    /*
     * Fachliche Identitaet aus dem Produkt: `documentDunningDelivery` weist
     * eine zweite Bestaetigung derselben Uebergabe ab -- gleiche Rechnung,
     * gleicher Auftragsbezug, gleiche Art, gleiches Datum, gleicher Weg -- und
     * meldet `alreadyDocumented`. Zwei Geraete, die offline dasselbe
     * festhalten, senden zwei Kennungen fuer denselben Vorgang; der zweite
     * Push ist deshalb ein fachliches Replay und bekommt die vorhandene Zeile
     * zurueck. Die Notiz gehoert bewusst nicht zur Identitaet -- lokal war sie
     * es nie.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id
      and d.client_invoice_id = v_dun_invoice_id
      and coalesce(d.client_vorgang_id, '') = coalesce(v_dun_vorgang_id, '')
      and d.kind = v_dun_kind
      and d.documented_at = v_dun_documented_at
      and d.delivery_method = v_dun_delivery
    order by d.created_at, d.client_documentation_id
    limit 1
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'requested_entity_id', v_dun_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false,
        'deduped', true
      );
    end if;

    insert into public.workspace_invoice_dunning_documentations (
      workspace_id,
      client_documentation_id,
      client_invoice_id,
      client_vorgang_id,
      kind,
      documented_at,
      delivery_method,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_dun_id,
      v_dun_invoice_id,
      v_dun_vorgang_id,
      v_dun_kind,
      v_dun_documented_at,
      v_dun_delivery,
      v_dun_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_invoice_dunning_documentations.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_dun_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'workspace' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select w.version into v_current_version from public.workspaces w where w.id = p_workspace_id for update;
    if v_current_version is null then
      raise exception 'Workspace nicht gefunden';
    end if;
    if p_row_version > 0 and p_row_version <> v_current_version then
      raise exception 'Versionskonflikt workspace:%', v_current_version using errcode = 'P0001';
    end if;

    update public.workspaces
    set
      name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
      version = version + 1
    where id = p_workspace_id
    returning to_jsonb(public.workspaces.*) into v_result;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'workspace_settings' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select ws.version into v_current_version from public.workspace_settings ws where ws.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_settings (workspace_id, settings, version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'settings', '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_settings.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt workspace_settings:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_settings
      set
        settings = coalesce(p_payload->'settings', settings),
        version = version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_settings.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_setup' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select s.row_version into v_current_version from public.workspace_setup s where s.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_setup (workspace_id, payload, setup_version, row_version, updated_by)
      values (
        p_workspace_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        coalesce((p_payload->>'setup_version')::integer, 1),
        1,
        auth.uid()
      )
      returning to_jsonb(public.workspace_setup.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_setup:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_setup
      set
        payload = coalesce(p_payload->'payload', p_payload, payload),
        setup_version = coalesce((p_payload->>'setup_version')::integer, setup_version),
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_setup.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_profile' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select cp.row_version, cp.payload into v_current_version, v_existing_profile
    from public.workspace_company_profiles cp
    where cp.workspace_id = p_workspace_id
    for update;

    /*
     * 01B3 -- profile_schema_version: fehlend = 0 (Altclient); sonst nur
     * plausible, bekannte Werte 0..2. Ein hoeherer oder negativer Wert koennte
     * die Preserve-/Loeschsemantik aushebeln und wird abgewiesen.
     */
    if p_payload ? 'profile_schema_version'
       and (jsonb_typeof(p_payload->'profile_schema_version') <> 'number'
            or (p_payload->>'profile_schema_version') !~ ('^[0-9]{1,3}' || chr(36))
            or (p_payload->>'profile_schema_version')::integer > 2) then
      raise exception 'Firmenprofil ungueltig: profile_schema_version' using errcode = 'P0001';
    end if;
    v_incoming_schema := coalesce(nullif(p_payload->>'profile_schema_version', '')::integer, 0);

    if v_current_version is null then
      v_incoming_profile := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if jsonb_typeof(v_incoming_profile) = 'object' and v_incoming_schema >= 2 then
        -- explizites null eines wissenden Clients = nicht gesetzt
        for v_field in select * from (values ('defaultTaxStatus'), ('currency'), ('replyToEmail'), ('senderDisplayName')) as catalog(key) loop
          if jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;
      end if;
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);
      insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
      values (p_workspace_id, v_incoming_profile, 1, auth.uid())
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_profile:%', v_current_version using errcode = 'P0001';
      end if;

      v_incoming_profile := coalesce(p_payload->'payload', p_payload, v_existing_profile);

      if jsonb_typeof(v_incoming_profile) = 'object' then
        /*
         * PRODUCT-BASIS-FIRMENPROFIL-01B -- schema-versionierter Altclient-Schutz.
         *
         * Der Katalog nennt jedes Profilfeld, das nach der ersten Ganzdokument-
         * Fassung eingefuehrt wurde, mit der Schema-Version seiner Einfuehrung.
         * Ein Client sendet seine Schema-Version mit (fehlend = 0, alle Clients
         * vor 01B). Regel je Feld:
         *
         *   Client-Version <  Einfuehrungsversion und Feld fehlt im Payload
         *     -> der Client kennt das Feld nachweislich nicht: bestehenden Wert bewahren
         *   Client-Version >= Einfuehrungsversion
         *     -> der Client kennt das Feld: fehlend oder null = bewusstes Loeschen
         *
         * Kein Deep-Merge, kein pauschales Konservieren: Alles, was nicht im
         * Katalog steht, wird weiterhin vollstaendig ersetzt. Ein neues Feld
         * braucht genau einen Eintrag hier und eine erhoehte Version im Client.
         */
        for v_field in
          select * from (values
            ('defaultTaxStatus', 2),
            ('currency', 2),
            ('replyToEmail', 2),
            ('senderDisplayName', 2)
          ) as catalog(key, introduced_in)
        loop
          if v_incoming_schema < v_field.introduced_in
             and not (v_incoming_profile ? v_field.key)
             and (v_existing_profile ? v_field.key) then
            v_incoming_profile := jsonb_set(
              v_incoming_profile,
              array[v_field.key],
              v_existing_profile -> v_field.key,
              true
            );
          elsif v_incoming_schema >= v_field.introduced_in
             and jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            -- explizites null eines wissenden Clients = Loeschen: Schluessel entfernen
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;

        /*
         * BRANDING-01E-0 -- Altclient-Schutz fuer `branding` bleibt unveraendert
         * (Asset-Referenz ist unveraenderlich; null ist kein Loeschsignal):
         * uebernommen wird nur ein echtes JSON-Objekt, sonst wird ein
         * vorhandenes Branding bewahrt. Kein Deep-Merge.
         */
        if jsonb_typeof(v_incoming_profile->'branding') is distinct from 'object'
           and jsonb_typeof(v_existing_profile->'branding') = 'object' then
          v_incoming_profile := jsonb_set(
            v_incoming_profile,
            '{branding}',
            v_existing_profile->'branding',
            true
          );
        end if;
      end if;

      /*
       * 01B3 -- Validierung des **endgueltigen** Dokuments (nach Preserve und
       * Loeschsemantik): Ein ungueltiger Wert bricht den Write atomar ab, der
       * bestehende Stand bleibt unveraendert (kein Teilupdate).
       */
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);

      update public.workspace_company_profiles
      set
        payload = v_incoming_profile,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'bank_account' then
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- das Konto, unter dem Kontoauszuege liegen.
     *
     * Berechtigung wie bei Vorgangsnotizen und Aufgaben und aus demselben
     * Grund: Ein Konto entsteht heute beilaeufig beim ersten Import, ohne
     * jede Rollenpruefung. `can_write_workspace` (Inhaber/Admin) wuerde
     * genau die Mitglieder aussperren, die den Auszug einlesen, und ihre
     * Konten dauerhaft in der Outbox halten.
     *
     * Kein Banking: kein Zugang, kein Saldo, kein Anbieter. Nur die stabile
     * Identitaet, unter der Bewegungen aufbewahrt werden.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_bank_account_id := coalesce(nullif(trim(p_payload->>'account_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_bank_account_id is null then
      raise exception 'account_id fehlt';
    end if;

    v_bank_account_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    /*
     * Loeschen ist in Block 2B fachlich nicht vorgesehen -- weder die
     * Oberflaeche noch der Store bieten es an. Ein Grabstein kann hier also
     * nur aus einem Fehler stammen, und ein Konto mit Bewegungen darf wegen
     * `on delete restrict` ohnehin nicht verschwinden. Lieber laut ablehnen
     * als still eine Loeschsemantik erfinden, die niemand entworfen hat.
     */
    if v_deleted then
      raise exception 'Bankkonten koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    /* Der Anzeigename ist Pflicht, die Kontokennung ausdruecklich nicht. */
    if jsonb_typeof(v_bank_account_payload->'displayName') <> 'string'
      or length(trim(v_bank_account_payload->>'displayName')) = 0 then
      raise exception 'Bankkonto ungueltig: displayName' using errcode = 'P0001';
    end if;
    if length(v_bank_account_payload->>'displayName') > 200 then
      raise exception 'Bankkonto ungueltig: displayName zu lang' using errcode = 'P0001';
    end if;

    select a.* into v_row_bank_account
    from public.workspace_bank_accounts a
    where a.workspace_id = p_workspace_id and a.client_account_id = v_bank_account_id
    for update;
    v_current_version := v_row_bank_account.row_version;

    /* CREATE-RETRY-CONFLICT-02: `0` heisst "diese Zeile darf noch nicht existieren". */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_bank_account.payload = v_bank_account_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_bank_account_id,
          'row_version', v_row_bank_account.row_version,
          'payload', to_jsonb(v_row_bank_account),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt bank_account:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_bank_accounts (
        workspace_id,
        client_account_id,
        display_name,
        identifier,
        payload,
        row_version,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_bank_account_id,
        trim(v_bank_account_payload->>'displayName'),
        coalesce(nullif(trim(v_bank_account_payload->>'identifier'), ''), ''),
        v_bank_account_payload,
        1,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_bank_accounts.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt bank_account:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Umbenennen ist ein Update derselben Zeile, keine neue.
       * `client_account_id` bleibt unberuehrt -- sie ist die Identitaet, an
       * der die Entdopplung der Bewegungen haengt.
       */
      update public.workspace_bank_accounts
      set
        display_name = trim(v_bank_account_payload->>'displayName'),
        identifier = coalesce(nullif(trim(v_bank_account_payload->>'identifier'), ''), identifier),
        payload = v_bank_account_payload,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_account_id = v_bank_account_id
      returning to_jsonb(public.workspace_bank_accounts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_bank_account_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'bank_transaction' then
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- eine importierte Bankbewegung.
     *
     * Sie ist ein **Nachweis**, keine Zahlung: kein invoice_id, kein
     * expense_id, kein payment_id, kein Abgleichstatus. Dieser Zweig ruft
     * keine Zahlungsfunktion auf und beruehrt keinen Zahlungsstatus.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_bank_transaction_id := coalesce(nullif(trim(p_payload->>'transaction_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_bank_transaction_id is null then
      raise exception 'transaction_id fehlt';
    end if;

    v_bank_transaction_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    /* Wie beim Konto: Block 2B kennt kein Loeschen von Bankbewegungen. */
    if v_deleted then
      raise exception 'Bankbewegungen koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    /* Die Felder, an denen die Entdopplung haengt, muessen dastehen. */
    if coalesce(nullif(trim(v_bank_transaction_payload->>'accountKey'), ''), '') = '' then
      raise exception 'Bankbewegung ungueltig: accountKey' using errcode = 'P0001';
    end if;
    if coalesce(nullif(trim(v_bank_transaction_payload->>'fingerprint'), ''), '') = '' then
      raise exception 'Bankbewegung ungueltig: fingerprint' using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_bank_transaction_payload->'amountCents') <> 'number'
      or (v_bank_transaction_payload->>'amountCents')::bigint = 0 then
      raise exception 'Bankbewegung ungueltig: amountCents' using errcode = 'P0001';
    end if;
    if coalesce((v_bank_transaction_payload->>'occurrence')::integer, 0) < 1 then
      raise exception 'Bankbewegung ungueltig: occurrence' using errcode = 'P0001';
    end if;

    /*
     * Das Konto muss serverseitig existieren, **bevor** seine Bewegung
     * geschrieben wird. Bewusst eine eigene, sprechende Pruefung statt der
     * rohen Fremdschluesselmeldung: Der Client soll erkennen koennen, dass
     * nur die Reihenfolge stimmen muss -- und es wird hier ausdruecklich
     * **kein** Konto angelegt. Das Konto ist eine eigene Entitaet mit
     * eigenem Push.
     */
    if not exists (
      select 1 from public.workspace_bank_accounts a
      where a.workspace_id = p_workspace_id
        and a.client_account_id = trim(v_bank_transaction_payload->>'accountKey')
    ) then
      raise exception 'Bankkonto fehlt: %', trim(v_bank_transaction_payload->>'accountKey') using errcode = 'P0001';
    end if;

    select t.* into v_row_bank_transaction
    from public.workspace_bank_transactions t
    where t.workspace_id = p_workspace_id and t.client_transaction_id = v_bank_transaction_id
    for update;
    v_current_version := v_row_bank_transaction.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      if v_row_bank_transaction.payload = v_bank_transaction_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_bank_transaction_id,
          'row_version', v_row_bank_transaction.row_version,
          'payload', to_jsonb(v_row_bank_transaction),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt bank_transaction:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_bank_transactions (
        workspace_id,
        client_transaction_id,
        account_key,
        import_id,
        file_name,
        imported_at,
        booking_date,
        value_date,
        amount_cents,
        currency,
        counterparty,
        counterparty_iban,
        purpose,
        bank_reference,
        fingerprint,
        occurrence,
        payload,
        row_version,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_bank_transaction_id,
        trim(v_bank_transaction_payload->>'accountKey'),
        coalesce(nullif(trim(v_bank_transaction_payload->>'importId'), ''), ''),
        coalesce(nullif(trim(v_bank_transaction_payload->>'fileName'), ''), ''),
        coalesce((v_bank_transaction_payload->>'importedAt')::timestamptz, now()),
        (v_bank_transaction_payload->>'bookingDate')::date,
        nullif(trim(coalesce(v_bank_transaction_payload->>'valueDate', '')), '')::date,
        (v_bank_transaction_payload->>'amountCents')::bigint,
        nullif(trim(coalesce(v_bank_transaction_payload->>'currency', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'counterparty', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'counterpartyIban', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'purpose', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'bankReference', '')), ''),
        trim(v_bank_transaction_payload->>'fingerprint'),
        (v_bank_transaction_payload->>'occurrence')::integer,
        v_bank_transaction_payload,
        1,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_bank_transactions.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt bank_transaction:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Eine Bankbewegung ist ein Nachweis und aendert sich fachlich nicht.
       * Der Update-Pfad existiert fuer den Wiederanlauf eines nicht
       * bestaetigten Pushes -- nicht, um einen Kontoauszug umzuschreiben.
       * Kontoschluessel, Fingerabdruck und laufende Nummer bleiben deshalb
       * bewusst stehen: Sie sind die Identitaet, an der die Entdopplung
       * haengt.
       */
      update public.workspace_bank_transactions
      set
        payload = v_bank_transaction_payload,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_transaction_id = v_bank_transaction_id
      returning to_jsonb(public.workspace_bank_transactions.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_bank_transaction_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'paper_register_entry' then
    /*
     * CLOUD-SYNC S1 -- der Papierablage-Haken eines Dokuments.
     *
     * Rechte wie beim Dokument, zu dem der Eintrag gehoert (Kopfkommentar
     * der Migration): anlegen jedes aktive Mitglied, aendern nur
     * Inhaber/Admin oder wer die Zeile angelegt hat, Grabstein nur
     * Inhaber/Admin.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Eintrag-ID, Dokumentbezug, Ordnerangaben, der Haken als Wahrheitswert
     * und eine vertretbare Groesse.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_paper_entry_id := coalesce(nullif(trim(p_payload->>'entry_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_paper_entry_id is null then
      raise exception 'entry_id fehlt';
    end if;

    v_paper_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_paper_document_id := coalesce(
      nullif(trim(p_payload->>'document_id'), ''),
      nullif(trim(v_paper_payload->>'documentId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Wie beim Dokument selbst: Grabsteine setzen nur Inhaber und Admin.
    if v_deleted and not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    -- Der Dokumentbezug darf nur am Grabstein fehlen.
    if v_paper_document_id is null and not v_deleted then
      raise exception 'document_id fehlt';
    end if;

    /*
     * coalesce um jsonb_typeof: Fehlt ein Feld, liefert jsonb_typeof NULL,
     * und ein Vergleich mit NULL waere nie wahr -- die Pruefung liefe ins
     * Leere.
     */
    if not v_deleted then
      if coalesce(jsonb_typeof(v_paper_payload->'physicalFiled'), '') <> 'boolean' then
        raise exception 'Papierablage ungueltig: physicalFiled' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_paper_payload->'folderId'), '') <> 'string'
        or coalesce(jsonb_typeof(v_paper_payload->'register'), '') <> 'string' then
        raise exception 'Papierablage ungueltig: Ordner' using errcode = 'P0001';
      end if;
      if length(v_paper_payload::text) > 20000 then
        raise exception 'Papierablage ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select e.* into v_row_paper
    from public.workspace_paper_register_entries e
    where e.workspace_id = p_workspace_id and e.client_entry_id = v_paper_entry_id
    for update;
    v_current_version := v_row_paper.row_version;

    if v_current_version is not null then
      /*
       * Eine fremde Zeile aendern nur Inhaber und Admin -- dieselbe Regel wie
       * am Dokument. Sie steht vor dem Replay, damit auch eine Wiederholung
       * keine Zeile zurueckgibt, die der Aufrufer nicht lesen darf.
       */
      if not public.can_write_workspace(p_workspace_id)
        and v_row_paper.created_by is distinct from auth.uid() then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- P1 MITARBEITERZAHLUNGEN: Der Eintrag eines geschuetzten Belegs gehoert
      -- nur Inhaber und Admin, auch als Wiederholung.
      if not public.can_write_workspace(p_workspace_id)
        and public.workspace_document_is_restricted(p_workspace_id, v_row_paper.client_document_id) then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- Ein Eintrag wechselt nie sein Dokument.
      if v_paper_document_id is not null
        and v_row_paper.client_document_id is not null
        and v_row_paper.client_document_id <> v_paper_document_id then
        raise exception 'Papierablage ungueltig: document_id' using errcode = 'P0001';
      end if;
    end if;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wortgleich zu
     * den Vorgangsnotizen: identischer Inhalt ist eine Wiederholung, beide
     * Seiten geloescht ebenfalls, alles andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_paper.deleted and not v_deleted then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_paper.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_paper_entry_id,
          'row_version', v_row_paper.row_version,
          'payload', to_jsonb(v_row_paper),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_paper.payload = v_paper_payload and v_row_paper.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_paper_entry_id,
          'row_version', v_row_paper.row_version,
          'payload', to_jsonb(v_row_paper),
          'deleted', v_row_paper.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_paper_register_entries (
        workspace_id,
        client_entry_id,
        client_document_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_paper_entry_id,
        v_paper_document_id,
        case when v_deleted then '{}'::jsonb else v_paper_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_paper_register_entries.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Kein Wiederbeleben: Der Grabstein gehoert zu einem geloeschten
       * Dokument. Auch mit passender Version wird er nicht wieder aktiv.
       */
      if v_row_paper.deleted and not v_deleted then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso der Dokumentbezug --
       * er ist die Ordnung, ueber die ein zweites Geraet den Grabstein
       * zuordnet.
       */
      update public.workspace_paper_register_entries
      set
        payload = case when v_deleted then payload else coalesce(v_paper_payload, payload) end,
        client_document_id = coalesce(client_document_id, v_paper_document_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_entry_id = v_paper_entry_id
      returning to_jsonb(public.workspace_paper_register_entries.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_paper_entry_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'communication_event' then
    /*
     * CLOUD-SYNC S2 -- ein Ereignis im Kommunikationsverlauf.
     *
     * Append-only wie der Mahnnachweis: Es gibt keinen Update-Pfad und kein
     * Loeschen. Eine vorhandene Kennung wird unveraendert zurueckgegeben --
     * das Ereignis bleibt genau so stehen, wie es festgehalten wurde.
     * `p_row_version` spielt hier deshalb keine Rolle.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Kennung, Kontextart, Ereignisart, Ereigniszeit und eine vertretbare
     * Groesse. Art und Kontext werden als Form geprueft, nicht gegen eine
     * feste Liste -- sie tragen keine Serverlogik.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_comm_event_id := coalesce(nullif(trim(p_payload->>'event_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_comm_event_id is null then
      raise exception 'event_id fehlt';
    end if;

    -- Loeschen gibt es fuer Kommunikationsereignisse nicht. Laut statt erfunden.
    if coalesce((p_payload->>'deleted')::boolean, false) then
      raise exception 'Kommunikationsereignisse koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    v_comm_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_comm_context := coalesce(v_comm_payload->'contextRef', '{}'::jsonb);
    v_comm_context_type := coalesce(nullif(trim(p_payload->>'context_type'), ''), nullif(trim(v_comm_context->>'type'), ''));
    v_comm_event_type := coalesce(nullif(trim(p_payload->>'event_type'), ''), nullif(trim(v_comm_payload->>'type'), ''));

    if v_comm_context_type is null or v_comm_context_type !~ '^[a-z_]{1,40}$' then
      raise exception 'Kommunikationsereignis ungueltig: contextRef' using errcode = 'P0001';
    end if;
    if v_comm_event_type is null or v_comm_event_type !~ '^[a-z_]{1,60}$' then
      raise exception 'Kommunikationsereignis ungueltig: type' using errcode = 'P0001';
    end if;
    begin
      v_comm_event_at := coalesce(nullif(trim(p_payload->>'event_at'), ''), v_comm_payload->>'timestamp')::timestamptz;
    exception when others then
      raise exception 'Kommunikationsereignis ungueltig: timestamp' using errcode = 'P0001';
    end;
    if v_comm_event_at is null then
      raise exception 'Kommunikationsereignis ungueltig: timestamp' using errcode = 'P0001';
    end if;
    if length(v_comm_payload::text) > 20000 then
      raise exception 'Kommunikationsereignis ungueltig: zu gross' using errcode = 'P0001';
    end if;

    select e.* into v_row_comm
    from public.workspace_communication_events e
    where e.workspace_id = p_workspace_id and e.client_event_id = v_comm_event_id
    for update;

    if found then
      /*
       * Wiederholung derselben Kennung. Eine fremde Zeile bekommen nur Inhaber
       * und Admin zurueck -- sonst laese ein Mitglied ueber ein Replay, was es
       * im Abzug nicht sehen darf.
       */
      if not public.can_write_workspace(p_workspace_id)
        and v_row_comm.created_by is distinct from auth.uid() then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- P1 MITARBEITERZAHLUNGEN: Ereignisse zu einem geschuetzten Beleg gibt
      -- die Wiederholung nur Inhaber und Admin zurueck.
      if not public.can_write_workspace(p_workspace_id)
        and public.workspace_communication_context_is_restricted(p_workspace_id, v_row_comm.context_type, v_row_comm.context_id) then
        raise exception 'Keine Schreibberechtigung';
      end if;
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_row_comm.client_event_id,
        'row_version', v_row_comm.row_version,
        'payload', to_jsonb(v_row_comm),
        'deleted', false,
        'replayed', true
      );
    end if;

    insert into public.workspace_communication_events (
      workspace_id,
      client_event_id,
      context_type,
      context_id,
      context_vorgang_id,
      event_type,
      event_at,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_comm_event_id,
      v_comm_context_type,
      coalesce(nullif(trim(p_payload->>'context_id'), ''), nullif(trim(v_comm_context->>'id'), '')),
      coalesce(nullif(trim(p_payload->>'context_vorgang_id'), ''), nullif(trim(v_comm_context->>'vorgangId'), '')),
      v_comm_event_type,
      v_comm_event_at,
      v_comm_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_communication_events.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_comm_event_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'knowledge_fact' then
    /*
     * CLOUD-SYNC S3 -- ein bestaetigter Wissenseintrag.
     *
     * Rechte wie bei den Vorgangsnotizen: Das Produkt kennt fuer das Anlegen,
     * Aendern und Loeschen von Wissen keine Rollenpruefung; jedes aktive
     * Mitglied darf es (`workspace_user_can_intake`), ausschliesslich ueber
     * diese RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Kennung, Scope als Form, Schluessel, Wert, Anzeigetext, das
     * Aktiv-Kennzeichen als Wahrheitswert und eine vertretbare Groesse.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_fact_id := coalesce(nullif(trim(p_payload->>'fact_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_fact_id is null then
      raise exception 'fact_id fehlt';
    end if;

    v_fact_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_fact_scope := coalesce(nullif(trim(p_payload->>'scope'), ''), nullif(trim(v_fact_payload->>'scope'), ''));
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if v_fact_scope is null or v_fact_scope !~ '^[a-z_]{1,40}$' then
        raise exception 'Wissen ungueltig: scope' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'key'), '') <> 'string' or length(trim(v_fact_payload->>'key')) = 0 then
        raise exception 'Wissen ungueltig: key' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'value'), '') <> 'string' or length(trim(v_fact_payload->>'value')) = 0 then
        raise exception 'Wissen ungueltig: value' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'displayText'), '') <> 'string'
        or length(trim(v_fact_payload->>'displayText')) = 0 then
        raise exception 'Wissen ungueltig: displayText' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'active'), '') <> 'boolean' then
        raise exception 'Wissen ungueltig: active' using errcode = 'P0001';
      end if;
      if length(v_fact_payload::text) > 20000 then
        raise exception 'Wissen ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select f.* into v_row_fact
    from public.workspace_knowledge_facts f
    where f.workspace_id = p_workspace_id and f.client_fact_id = v_fact_id
    for update;
    v_current_version := v_row_fact.row_version;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wortgleich zu
     * den Vorgangsnotizen: identischer Inhalt ist eine Wiederholung, beide
     * Seiten geloescht ebenfalls, alles andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_fact.deleted and not v_deleted then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_fact.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_fact_id,
          'row_version', v_row_fact.row_version,
          'payload', to_jsonb(v_row_fact),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_fact.payload = v_fact_payload and v_row_fact.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_fact_id,
          'row_version', v_row_fact.row_version,
          'payload', to_jsonb(v_row_fact),
          'deleted', v_row_fact.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_knowledge_facts (
        workspace_id,
        client_fact_id,
        scope,
        scope_id,
        category,
        active,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_fact_id,
        v_fact_scope,
        nullif(trim(v_fact_payload->>'scopeId'), ''),
        nullif(trim(v_fact_payload->>'category'), ''),
        case when v_deleted then false else coalesce((v_fact_payload->>'active')::boolean, true) end,
        case when v_deleted then '{}'::jsonb else v_fact_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_knowledge_facts.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Kein Wiederbeleben: Das Produkt kennt kein Wiederherstellen eines
       * geloeschten Eintrags -- ein neuer Eintrag bekommt eine neue Kennung.
       */
      if v_row_fact.deleted and not v_deleted then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;

      /* Grabstein: der Fachinhalt bleibt als Nachweis stehen. */
      update public.workspace_knowledge_facts
      set
        payload = case when v_deleted then payload else coalesce(v_fact_payload, payload) end,
        scope = case when v_deleted then scope else coalesce(v_fact_scope, scope) end,
        scope_id = case when v_deleted then scope_id else nullif(trim(v_fact_payload->>'scopeId'), '') end,
        category = case when v_deleted then category else coalesce(nullif(trim(v_fact_payload->>'category'), ''), category) end,
        active = case when v_deleted then false else coalesce((v_fact_payload->>'active')::boolean, active) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_fact_id = v_fact_id
      returning to_jsonb(public.workspace_knowledge_facts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_fact_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'invoice_draft' then
    /*
     * CLOUD-SYNC S5 -- der fachliche Kern eines Rechnungsentwurfs.
     *
     * Rechte wie beim Vorbereiten einer Rechnung im Produkt: jedes aktive
     * Mitglied (`workspace_user_can_intake`). Die finanzielle Freigabe bleibt
     * R1 in `finalize_workspace_invoice` -- hier wird nie finalisiert.
     *
     * Versionsvertrag wortgleich zu 01G/S3. Zusaetzlich: keine
     * Rechnungsnummer, keine ableitbaren oder geraetelokalen Felder, kein
     * Slotwechsel, hoechstens ein aktiver Entwurf je Slot, und ein
     * verworfener oder finalisierter Entwurf wird weder geaendert noch
     * wiederbelebt.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_draft_id := coalesce(nullif(trim(p_payload->>'draft_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_draft_id is null then
      raise exception 'draft_id fehlt';
    end if;

    v_draft_type := nullif(trim(coalesce(p_payload->>'invoice_type', '')), '');
    if v_draft_type is null
       or v_draft_type not in ('rechnung', 'abschlag', 'teilrechnung', 'schluss', 'gutschrift', 'storno') then
      raise exception 'Rechnungsentwurf ungueltig: invoice_type' using errcode = 'P0001';
    end if;

    /* NULL heisst „ohne Auftrag" und gilt nur fuer die normale Rechnung; '' ist kein Bezug. */
    if p_payload ? 'vorgang_id' and jsonb_typeof(p_payload->'vorgang_id') not in ('null', 'string') then
      raise exception 'Rechnungsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;
    v_draft_vorgang_id := case
      when jsonb_typeof(p_payload->'vorgang_id') = 'string' then p_payload->>'vorgang_id'
      else null
    end;
    if v_draft_vorgang_id is not null
       and (length(trim(v_draft_vorgang_id)) = 0 or v_draft_vorgang_id <> trim(v_draft_vorgang_id)) then
      raise exception 'Rechnungsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;
    if v_draft_vorgang_id is null and v_draft_type <> 'rechnung' then
      raise exception 'Rechnungsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;

    v_draft_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if jsonb_typeof(v_draft_payload) <> 'object' then
        raise exception 'Rechnungsentwurf ungueltig: payload' using errcode = 'P0001';
      end if;
      if v_draft_payload->>'id' is distinct from v_draft_id then
        raise exception 'Rechnungsentwurf ungueltig: id' using errcode = 'P0001';
      end if;
      if v_draft_payload->>'type' is distinct from v_draft_type then
        raise exception 'Rechnungsentwurf ungueltig: Rechnungsart' using errcode = 'P0001';
      end if;
      if coalesce(v_draft_payload->'vorgangId', 'null'::jsonb)
         is distinct from coalesce(to_jsonb(v_draft_vorgang_id), 'null'::jsonb) then
        raise exception 'Rechnungsentwurf ungueltig: vorgangId' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_draft_payload->'positions') is distinct from 'array' then
        raise exception 'Rechnungsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      /* Keine Rechnungsnummer: sie entsteht ausschliesslich in finalize_workspace_invoice. */
      if v_draft_payload ?| array['number', 'invoiceNumber', 'invoiceSequenceNumber', 'invoiceNumberPreview'] then
        raise exception 'Rechnungsentwurf ungueltig: Rechnungsnummer' using errcode = 'P0001';
      end if;
      /* Ableitbares wird nicht dupliziert, Geraetelokales reist nie. */
      if v_draft_payload ?| array['previousAbschlagDeductions', 'draftRawJson', 'draftSha256', 'finalization',
                                  'preparationRawJson', 'preparationSha256', 'approvalContext', 'revision', 'status'] then
        raise exception 'Rechnungsentwurf ungueltig: lokale oder abgeleitete Felder' using errcode = 'P0001';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_draft_payload->'positions') p
        where jsonb_typeof(p) <> 'object'
           or p ?| array['plannedQuantity', 'executedQuantity', 'billedQuantity', 'openQuantity']
      ) then
        raise exception 'Rechnungsentwurf ungueltig: abgeleitete Mengen' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_draft_payload->'companySnapshot') = 'object'
         and (v_draft_payload->'companySnapshot') ? 'logoDataUrl' then
        raise exception 'Rechnungsentwurf ungueltig: logoDataUrl' using errcode = 'P0001';
      end if;
      if length(v_draft_payload::text) > 262144 then
        raise exception 'Rechnungsentwurf ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select d.* into v_row_draft
    from public.workspace_invoice_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_draft_id
    for update;
    v_current_version := v_row_draft.row_version;

    /* Ein Entwurf wechselt nie seinen Slot. */
    if v_current_version is not null
       and (v_row_draft.vorgang_id is distinct from v_draft_vorgang_id
            or v_row_draft.invoice_type <> v_draft_type) then
      raise exception 'Rechnungsentwurf ungueltig: Slot' using errcode = 'P0001';
    end if;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wie bei S3:
     * identischer Inhalt ist eine Wiederholung, beide Seiten verworfen
     * ebenfalls, alles andere ist ein Konflikt. Ein finalisierter Entwurf ist
     * nie die Wiederholung eines Schreibvorgangs.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_draft_id,
          'row_version', v_row_draft.row_version,
          'payload', to_jsonb(v_row_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_draft.status = 'active' and not v_row_draft.deleted and not v_deleted
         and v_row_draft.payload = v_draft_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_draft_id,
          'row_version', v_row_draft.row_version,
          'payload', to_jsonb(v_row_draft),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt invoice_draft:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      begin
        insert into public.workspace_invoice_drafts (
          workspace_id,
          client_draft_id,
          vorgang_id,
          invoice_type,
          status,
          payload,
          row_version,
          deleted,
          deleted_at,
          created_by,
          updated_by
        )
        values (
          p_workspace_id,
          v_draft_id,
          v_draft_vorgang_id,
          v_draft_type,
          'active',
          case when v_deleted then '{}'::jsonb else v_draft_payload end,
          1,
          v_deleted,
          case when v_deleted then now() else null end,
          auth.uid(),
          auth.uid()
        )
        returning to_jsonb(public.workspace_invoice_drafts.*) into v_result;
      exception
        when unique_violation then
          /*
           * Zwei Ursachen, beide ein ausdruecklicher Konflikt: Der Slot gehoert
           * bereits einem anderen aktiven Entwurf -- typischerweise zwei
           * offline angelegte Entwuerfe fuer denselben Vorgang --, oder derselbe
           * Entwurf wurde gleichzeitig angelegt. Nichts wird zusammengefuehrt
           * oder ueberschrieben.
           */
          select d.client_draft_id into v_draft_slot_owner
          from public.workspace_invoice_drafts d
          where d.workspace_id = p_workspace_id
            and coalesce(d.vorgang_id, '') = coalesce(v_draft_vorgang_id, '')
            and d.invoice_type = v_draft_type
            and d.status = 'active'
            and not d.deleted
            and d.client_draft_id <> v_draft_id
          limit 1;
          if v_draft_slot_owner is not null then
            raise exception 'Versionskonflikt invoice_draft_slot:%', v_draft_slot_owner using errcode = 'P0001';
          end if;
          raise exception 'Versionskonflikt invoice_draft:0' using errcode = 'P0001';
      end;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt invoice_draft:%', v_current_version using errcode = 'P0001';
      end if;
      /* Ein zweites Verwerfen desselben Grabsteins aendert nichts. */
      if v_row_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_draft_id,
          'row_version', v_row_draft.row_version,
          'payload', to_jsonb(v_row_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      /*
       * Kein Wiederbeleben und keine Aenderung nach dem Ende: Verworfen bleibt
       * verworfen, finalisiert bleibt finalisiert -- auch mit passender Version.
       * Wer weiterarbeiten will, beginnt einen neuen Entwurf mit neuer Kennung.
       */
      if v_row_draft.deleted or v_row_draft.status <> 'active' then
        raise exception 'Versionskonflikt invoice_draft:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_invoice_drafts
      set
        payload = case when v_deleted then payload else v_draft_payload end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = v_draft_id
      returning to_jsonb(public.workspace_invoice_drafts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_draft_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'order_draft' then
    /*
     * CLOUD-SYNC S6 -- der Auftragsentwurf.
     *
     * Rechte wie beim Bearbeiten im Produkt: Das Speichern eines Entwurfs
     * prueft keine Rolle (`workspace_user_can_intake`); erst die verbindliche
     * Anlage prueft `can_write_workspace` -- in create_workspace_order,
     * unveraendert. Hier wird nie ein Auftrag angelegt.
     *
     * Versionsvertrag wortgleich zu S5. Zusaetzlich: keine Auftrags- oder
     * Vorgangsnummer und kein eingefrorener Stand im Inhalt, keine
     * Workspace-Angabe (der Workspace ist der Scope dieser Zeile), nichts
     * Geraetelokales; ein verworfener oder verbrauchter Entwurf wird weder
     * geaendert noch wiederbelebt, und eine Kennung, die bereits ein Vorgang
     * ist, wird kein neuer Entwurf.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_order_draft_id := coalesce(nullif(trim(p_payload->>'draft_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_order_draft_id is null then
      raise exception 'draft_id fehlt';
    end if;

    v_order_draft_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if jsonb_typeof(v_order_draft_payload) <> 'object' then
        raise exception 'Auftragsentwurf ungueltig: payload' using errcode = 'P0001';
      end if;
      if v_order_draft_payload->>'id' is distinct from v_order_draft_id then
        raise exception 'Auftragsentwurf ungueltig: id' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_order_draft_payload->'customerBilling') is distinct from 'object' then
        raise exception 'Auftragsentwurf ungueltig: Rechnungsanschrift' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_order_draft_payload->'positions') is distinct from 'array' then
        raise exception 'Auftragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_order_draft_payload->'positions') p
        where jsonb_typeof(p) <> 'object' or nullif(trim(coalesce(p->>'id', '')), '') is null
      ) then
        raise exception 'Auftragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      /* Nummern und eingefrorener Stand entstehen ausschliesslich in create_workspace_order. */
      if v_order_draft_payload ?| array['orderNumber', 'vorgangNumber', 'contractConfirmation', 'orderPositions',
                                        'orderDate', 'contractTotals'] then
        raise exception 'Auftragsentwurf ungueltig: Auftragsdaten' using errcode = 'P0001';
      end if;
      /* Der Workspace ist der Scope dieser Zeile; Geraetelokales reist nie. */
      if v_order_draft_payload ?| array['workspaceId', 'sync', 'conflict', 'status'] then
        raise exception 'Auftragsentwurf ungueltig: lokale Felder' using errcode = 'P0001';
      end if;
      if length(v_order_draft_payload::text) > 262144 then
        raise exception 'Auftragsentwurf ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select d.* into v_row_order_draft
    from public.workspace_order_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_order_draft_id
    for update;
    v_current_version := v_row_order_draft.row_version;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wie bei S5:
     * identischer Inhalt ist eine Wiederholung, beide Seiten verworfen
     * ebenfalls, alles andere ist ein Konflikt. Ein verbrauchter Entwurf ist
     * nie die Wiederholung eines Schreibvorgangs.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_order_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_order_draft_id,
          'row_version', v_row_order_draft.row_version,
          'payload', to_jsonb(v_row_order_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_order_draft.status = 'active' and not v_row_order_draft.deleted and not v_deleted
         and v_row_order_draft.payload = v_order_draft_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_order_draft_id,
          'row_version', v_row_order_draft.row_version,
          'payload', to_jsonb(v_row_order_draft),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt order_draft:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      /*
       * Eine Kennung, die bereits ein Vorgang ist, ist ein erledigter Entwurf --
       * auch ohne eigene Zeile (Anlage vor S6 oder ohne Bindung). Sie wird
       * nicht als neuer Entwurf angelegt.
       */
      if not v_deleted and exists (
        select 1 from public.workspace_vorgaenge v
        where v.workspace_id = p_workspace_id and v.vorgang_id = v_order_draft_id
      ) then
        raise exception 'Versionskonflikt order_draft:0' using errcode = 'P0001';
      end if;
      begin
        insert into public.workspace_order_drafts (
          workspace_id,
          client_draft_id,
          status,
          payload,
          row_version,
          deleted,
          deleted_at,
          created_by,
          updated_by
        )
        values (
          p_workspace_id,
          v_order_draft_id,
          'active',
          case when v_deleted then '{}'::jsonb else v_order_draft_payload end,
          1,
          v_deleted,
          case when v_deleted then now() else null end,
          auth.uid(),
          auth.uid()
        )
        returning to_jsonb(public.workspace_order_drafts.*) into v_result;
      exception
        when unique_violation then
          -- Derselbe Entwurf wurde gleichzeitig angelegt: ein Konflikt, kein Ueberschreiben.
          raise exception 'Versionskonflikt order_draft:0' using errcode = 'P0001';
      end;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt order_draft:%', v_current_version using errcode = 'P0001';
      end if;
      /* Ein zweites Verwerfen desselben Grabsteins aendert nichts. */
      if v_row_order_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_order_draft_id,
          'row_version', v_row_order_draft.row_version,
          'payload', to_jsonb(v_row_order_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      /*
       * Kein Wiederbeleben und keine Aenderung nach dem Ende: Verworfen bleibt
       * verworfen, verbraucht bleibt verbraucht -- auch mit passender Version.
       * Wer weiterarbeiten will, beginnt einen neuen Entwurf mit neuer Kennung.
       */
      if v_row_order_draft.deleted or v_row_order_draft.status <> 'active' then
        raise exception 'Versionskonflikt order_draft:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_order_drafts
      set
        payload = case when v_deleted then '{}'::jsonb else v_order_draft_payload end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = v_order_draft_id
      returning to_jsonb(public.workspace_order_drafts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_order_draft_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'order_amendment_draft' then
    /*
     * CLOUD-SYNC S6 -- der Nachtragsentwurf.
     *
     * Rechte wie im Produkt: Vorbereiten und Bearbeiten eines Nachtrags prueft
     * keine Rolle (`workspace_user_can_intake`). Die Bestaetigung bleibt
     * unveraendert in confirm_workspace_order_amendment.
     *
     * Ein Nachtragsentwurf gehoert genau einem bestaetigten Auftrag und
     * wechselt ihn nie. Keine Sequenz, kein Fingerprint, keine Intent- oder
     * Bestaetigungsdaten: Die Sequenz entsteht erst bei der Bestaetigung,
     * Intent und Wiederanlauf bleiben geraetelokal.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_amend_draft_id := coalesce(nullif(trim(p_payload->>'draft_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_amend_draft_id is null then
      raise exception 'draft_id fehlt';
    end if;
    v_amend_draft_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', '')), '');
    if v_amend_draft_vorgang_id is null or v_amend_draft_vorgang_id <> (p_payload->>'vorgang_id') then
      raise exception 'Nachtragsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;

    v_amend_draft_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if jsonb_typeof(v_amend_draft_payload) <> 'object' then
        raise exception 'Nachtragsentwurf ungueltig: payload' using errcode = 'P0001';
      end if;
      if v_amend_draft_payload->>'id' is distinct from v_amend_draft_id then
        raise exception 'Nachtragsentwurf ungueltig: id' using errcode = 'P0001';
      end if;
      if v_amend_draft_payload->>'vorgangId' is distinct from v_amend_draft_vorgang_id then
        raise exception 'Nachtragsentwurf ungueltig: vorgangId' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_amend_draft_payload->'title') is distinct from 'string' then
        raise exception 'Nachtragsentwurf ungueltig: Titel' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_amend_draft_payload->'positions') is distinct from 'array' then
        raise exception 'Nachtragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_amend_draft_payload->'positions') p
        where jsonb_typeof(p) <> 'object'
           or nullif(trim(coalesce(p->>'id', '')), '') is null
           or p ?| array['sourceAmendmentId', 'sourceAmendmentSequence', 'executedQuantity', 'plannedQuantity']
      ) then
        raise exception 'Nachtragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      /* Sequenz, Fingerprint und Bestaetigung entstehen erst bei der Bestaetigung; Intent und Wiederanlauf bleiben geraetelokal. */
      if v_amend_draft_payload ?| array['sequence', 'sequenceNo', 'expectedAmendmentSequence', 'clientAmendmentId',
                                        'contentFingerprint', 'fingerprint', 'rpcInput', 'intent', 'state',
                                        'confirmedAt', 'confirmedBy', 'sourceDraftId', 'localSourceDraftId'] then
        raise exception 'Nachtragsentwurf ungueltig: Bestaetigungsdaten' using errcode = 'P0001';
      end if;
      if v_amend_draft_payload ?| array['workspaceId', 'sync', 'conflict', 'status'] then
        raise exception 'Nachtragsentwurf ungueltig: lokale Felder' using errcode = 'P0001';
      end if;
      if length(v_amend_draft_payload::text) > 262144 then
        raise exception 'Nachtragsentwurf ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    /*
     * Der Auftrag wird nur gelesen, nicht gesperrt: Die Bestaetigung sperrt
     * zuerst den Vorgang und danach diesen Entwurf. Hielte dieser Zweig den
     * Entwurf und wartete auf den Vorgang, entstuende eine Sperrkette. Die
     * Bestaetigung prueft den Auftrag ohnehin selbst unter Sperre.
     */
    select v.* into v_amend_draft_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_amend_draft_vorgang_id;

    select d.* into v_row_amend_draft
    from public.workspace_order_amendment_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_amend_draft_id
    for update;
    v_current_version := v_row_amend_draft.row_version;

    /* Ein Nachtragsentwurf wechselt nie seinen Auftrag. */
    if v_current_version is not null and v_row_amend_draft.vorgang_id is distinct from v_amend_draft_vorgang_id then
      raise exception 'Nachtragsentwurf ungueltig: Auftrag' using errcode = 'P0001';
    end if;

    /* 01G/01G2 -- wie beim Auftragsentwurf. */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_amend_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_amend_draft_id,
          'row_version', v_row_amend_draft.row_version,
          'payload', to_jsonb(v_row_amend_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_amend_draft.status = 'active' and not v_row_amend_draft.deleted and not v_deleted
         and v_row_amend_draft.payload = v_amend_draft_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_amend_draft_id,
          'row_version', v_row_amend_draft.row_version,
          'payload', to_jsonb(v_row_amend_draft),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt order_amendment_draft:%', v_current_version using errcode = 'P0001';
    end if;

    /*
     * Ein Grabstein fuer einen Entwurf, den die Cloud nie gesehen hat, zu einem
     * Auftrag, den sie nicht kennt, ist gegenstandslos: Es gibt nichts
     * wiederzubeleben und nichts festzuhalten.
     */
    if v_current_version is null and v_deleted and v_amend_draft_vorgang.vorgang_id is null then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_amend_draft_id,
        'row_version', 0,
        'payload', '{}'::jsonb,
        'deleted', true,
        'replayed', true
      );
    end if;

    /* Nur zu einem bestehenden, bestaetigten Auftrag -- wie im Produkt. */
    if not v_deleted then
      if v_amend_draft_vorgang.vorgang_id is null or v_amend_draft_vorgang.deleted then
        raise exception 'Nachtragsentwurf ungueltig: Auftrag fehlt' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_amend_draft_vorgang.payload->'contractConfirmation') is distinct from 'object' then
        raise exception 'Nachtragsentwurf ungueltig: Auftrag nicht bestaetigt' using errcode = 'P0001';
      end if;
    end if;

    if v_current_version is null then
      begin
        insert into public.workspace_order_amendment_drafts (
          workspace_id,
          client_draft_id,
          vorgang_id,
          status,
          payload,
          row_version,
          deleted,
          deleted_at,
          created_by,
          updated_by
        )
        values (
          p_workspace_id,
          v_amend_draft_id,
          v_amend_draft_vorgang_id,
          'active',
          case when v_deleted then '{}'::jsonb else v_amend_draft_payload end,
          1,
          v_deleted,
          case when v_deleted then now() else null end,
          auth.uid(),
          auth.uid()
        )
        returning to_jsonb(public.workspace_order_amendment_drafts.*) into v_result;
      exception
        when unique_violation then
          raise exception 'Versionskonflikt order_amendment_draft:0' using errcode = 'P0001';
      end;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt order_amendment_draft:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_amend_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_amend_draft_id,
          'row_version', v_row_amend_draft.row_version,
          'payload', to_jsonb(v_row_amend_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      /* Verworfen bleibt verworfen, bestaetigt bleibt bestaetigt -- auch mit passender Version. */
      if v_row_amend_draft.deleted or v_row_amend_draft.status <> 'active' then
        raise exception 'Versionskonflikt order_amendment_draft:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_order_amendment_drafts
      set
        payload = case when v_deleted then '{}'::jsonb else v_amend_draft_payload end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = v_amend_draft_id
      returning to_jsonb(public.workspace_order_amendment_drafts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_amend_draft_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  else
    raise exception 'Unbekannter Entity-Typ: %', p_entity_type;
  end if;
end;
$$;

/* ------------------------------------------------------------------------ */
/* Rechte                                                                    */
/* ------------------------------------------------------------------------ */

revoke all on function public.workspace_employee_payment_json(public.workspace_employee_payments) from public, anon;
revoke all on function public.upsert_workspace_employee(uuid, jsonb, bigint) from public, anon;
revoke all on function public.add_workspace_employee_payment(uuid, text, text, text, text, text, numeric, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.reverse_workspace_employee_payment(uuid, text, text) from public, anon;
revoke all on function public.set_workspace_employee_payment_receipt(uuid, text, text) from public, anon;
revoke all on function public.set_workspace_employee_payment_proof(uuid, text, text) from public, anon;
revoke all on function public.pull_workspace_employee_data(uuid) from public, anon;
revoke all on function public.assert_document_not_payment_proof(uuid, text) from public;
revoke all on function public.is_workspace_document_payment_proof(uuid, text) from public;

grant execute on function public.upsert_workspace_employee(uuid, jsonb, bigint) to authenticated;
grant execute on function public.add_workspace_employee_payment(uuid, text, text, text, text, text, numeric, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.reverse_workspace_employee_payment(uuid, text, text) to authenticated;
grant execute on function public.set_workspace_employee_payment_receipt(uuid, text, text) to authenticated;
grant execute on function public.set_workspace_employee_payment_proof(uuid, text, text) to authenticated;
grant execute on function public.pull_workspace_employee_data(uuid) to authenticated;
grant execute on function public.assert_document_not_payment_proof(uuid, text) to authenticated;
grant execute on function public.is_workspace_document_payment_proof(uuid, text) to authenticated;

/* Datenschutz der Belege — die Prüfungen brauchen Mitglieder in den Policies. */
revoke all on function public.workspace_employee_payment_folder_path(jsonb) from public, anon, authenticated;
revoke all on function public.workspace_document_is_restricted(uuid, text) from public, anon;
revoke all on function public.workspace_file_is_restricted(uuid, text) from public, anon;
revoke all on function public.workspace_inbox_item_is_restricted(uuid, text) from public, anon;
revoke all on function public.workspace_communication_context_is_restricted(uuid, text, text) from public, anon;
revoke all on function public.workspace_restricted_content_write_guard() from public, anon, authenticated;

grant execute on function public.workspace_document_is_restricted(uuid, text) to authenticated;
grant execute on function public.workspace_file_is_restricted(uuid, text) to authenticated;
grant execute on function public.workspace_inbox_item_is_restricted(uuid, text) to authenticated;
grant execute on function public.workspace_communication_context_is_restricted(uuid, text, text) to authenticated;

/*
 * Versanddienst. Diese Funktionen sind nur für den Dienst (service_role)
 * gedacht; frühere Migrationen entzogen `public` und `authenticated`, die
 * Supabase-Standardrechte liessen `anon` aber EXECUTE. Ohne Anmeldung wären
 * so Titel, Empfänger und Text eines verschickten Belegs lesbar. Nur `anon`
 * wird entzogen; der Dienst behält sein Recht.
 */
revoke all on function public.get_workspace_document_delivery_for_send(uuid, text) from anon;
revoke all on function public.update_workspace_document_delivery_status(uuid, text, text, text, text, text, bigint) from anon;
revoke all on function public.mark_workspace_document_delivery_accepted(uuid, text, bigint) from anon;
revoke all on function public.claim_workspace_document_delivery_for_send(uuid, bigint) from anon;
revoke all on function public.resolve_stale_workspace_document_delivery_claim(uuid, integer) from anon;
