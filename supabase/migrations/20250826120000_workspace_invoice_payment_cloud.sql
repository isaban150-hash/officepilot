-- OFFICEPILOT-PAYMENT-CLOUD-DURABILITY-04B2B
--
-- Zahlungen einer Rechnung waren bisher rein lokal: Der Finalize-Payload
-- entfernt `payments` ausdruecklich, der Pull-Mapper loescht sie, und
-- `VorgangCloudPayload` kennt keine Rechnungen. Ein Origin- oder Geraetewechsel
-- verlor deshalb jede Geldbewegung.
--
-- Bewusste Entwurfsentscheidungen dieser Migration:
--
--   * Eigene Tabelle statt eines `payments`-Arrays im Rechnungs-Payload.
--     Die Rechnung ist unveraenderlich, Zahlungen sind mehrfach und
--     veraenderlich. Ein Array im Payload waere Last-Write-Wins und wuerde bei
--     zwei Geraeten echte Geldbewegungen verlieren.
--
--   * Append-only mit Reversal statt physischer Loeschung. Eine gebuchte
--     Zahlung verschwindet nicht spurlos, und nur ein Grabstein ist zwischen
--     Geraeten replizierbar.
--
--   * `normalize_workspace_invoice_payload_for_idempotency`, die Finalize-RPCs
--     und `workspace_invoices` bleiben unangetastet.

create table if not exists public.workspace_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_invoice_id text not null,
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
  constraint workspace_invoice_payments_amount_check check (amount > 0),
  /*
   * Der Idempotenzschluessel enthaelt bewusst die Rechnung. Historische
   * Kennungen im Format `pay-<millis>` sind nicht global kollisionssicher;
   * mit der Rechnung im Schluessel bleibt eine Kollision auf dieselbe Rechnung
   * beschraenkt und wird dort als Konflikt sichtbar, statt still zu verschmelzen.
   */
  constraint workspace_invoice_payments_client_id_unique
    unique (workspace_id, client_invoice_id, client_payment_id)
);

create index if not exists workspace_invoice_payments_invoice_idx
  on public.workspace_invoice_payments (workspace_id, client_invoice_id);

create index if not exists workspace_invoice_payments_updated_idx
  on public.workspace_invoice_payments (workspace_id, updated_at desc);

drop trigger if exists workspace_invoice_payments_set_updated_at on public.workspace_invoice_payments;
create trigger workspace_invoice_payments_set_updated_at
before update on public.workspace_invoice_payments
for each row
execute function public.set_workspace_updated_at();

-- RLS: select fuer Mitglieder; Schreiben ausschliesslich ueber die RPCs unten.
alter table public.workspace_invoice_payments enable row level security;

drop policy if exists workspace_invoice_payments_select_member on public.workspace_invoice_payments;
create policy workspace_invoice_payments_select_member
on public.workspace_invoice_payments for select to authenticated
using (public.is_active_workspace_member(workspace_id));

revoke all on public.workspace_invoice_payments from public, anon;
grant select on public.workspace_invoice_payments to authenticated;

/* -------------------------------------------------------------------------- */
/* Add                                                                        */
/* -------------------------------------------------------------------------- */

create or replace function public.add_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null
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

  -- Die Rechnung muss in der Cloud existieren und finalisiert sein.
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id;

  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;
  if v_invoice.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;
  if coalesce(v_invoice.payload->>'cancelledAt', '') <> '' then
    raise exception 'Rechnung storniert';
  end if;

  /*
   * PAYMENT-SQL-CONCURRENCY-04B2B3 — Insert zuerst, pruefen danach.
   *
   * Vorher stand hier ein sperrendes Select und erst dann der Insert. Zwischen
   * beiden Schritten passt ein zweiter Request: Eine Sperre kann keine Zeile
   * halten, die es noch nicht gibt. Zwei gleichzeitige Aufrufe derselben
   * Kennung sahen beide nichts, fuegten beide ein — einer bekam eine
   * Unique-Violation statt des zugesagten idempotenten Erfolgs.
   *
   * Jetzt traegt der Eindeutigkeitsschluessel selbst die Serialisierung. Der
   * Verlierer bekommt kein Ergebnis zurueck, laedt die fremde Zeile mit Sperre
   * und bewertet sie fachlich. `do nothing` allein waere gefaehrlich: Es wuerde
   * eine abweichende Geldbewegung still verschlucken. Deshalb folgt auf den
   * leeren Insert immer eine Pruefung, nie ein pauschaler Erfolg.
   *
   * Zweimal versucht: Faellt der konkurrierende Request zurueck (Rollback),
   * verschwindet die Zeile wieder und der zweite Anlauf kann sie regulaer
   * anlegen. Danach ist Schweigen keine Option mehr.
   */
  for v_attempt in 1..2 loop
    insert into public.workspace_invoice_payments (
      workspace_id, client_invoice_id, client_payment_id,
      amount, paid_on, reference, note, created_by
    )
    values (
      p_workspace_id, v_invoice_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_user_id
    )
    on conflict (workspace_id, client_invoice_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      /*
       * Nachbedingung: Die zurueckgegebene Zeile muss den **vollstaendigen**
       * Request abbilden — Schluessel, Betrag, Datum, Referenz, Notiz. Erfolg
       * fuer etwas anderes als das Gesendete waere eine Luege.
       */
      if v_inserted.workspace_id is distinct from p_workspace_id
        or v_inserted.client_invoice_id is distinct from v_invoice_id
        or v_inserted.client_payment_id is distinct from v_payment_id
        or v_inserted.amount is distinct from round(p_amount, 2)
        or v_inserted.paid_on is distinct from v_paid_on::date
        or v_inserted.reference is distinct from v_reference
        or v_inserted.note is distinct from v_note
        or v_inserted.reversed_at is not null
      then
        raise exception 'Zahlung Nachbedingung verletzt';
      end if;

      return next v_inserted;
      return;
    end if;

    -- Kein Ergebnis: Die Kennung ist bereits vergeben. Zeile sperren und pruefen.
    select * into v_existing
    from public.workspace_invoice_payments
    where workspace_id = p_workspace_id
      and client_invoice_id = v_invoice_id
      and client_payment_id = v_payment_id
    for update;

    if v_existing.id is not null then
      /*
       * Grabsteinvorrang — bewusst **vor** dem Inhaltsvergleich: Eine
       * inhaltlich identische Wiederholung wuerde die Stornierung sonst als
       * stillen Erfolg ueberspielen. Reversal gewinnt, die Zeile bleibt
       * unveraendert, es wird nichts wiederbelebt.
       */
      if v_existing.reversed_at is not null then
        raise exception 'Zahlungskonflikt: diese Zahlung wurde storniert';
      end if;

      /*
       * Fachliche Identitaet, exakt und ausschliesslich ueber diese vier
       * Felder. Keine Deduplizierung anhand Betrag oder Datum: Zwei echte
       * Zahlungen ueber denselben Betrag am selben Tag bleiben zwei Zahlungen.
       */
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

  -- Weder eingefuegt noch auffindbar: kein Erfolg, keine Vermutung.
  raise exception 'Zahlung nicht angelegt';
end;
$$;

/* -------------------------------------------------------------------------- */
/* Reversal                                                                   */
/* -------------------------------------------------------------------------- */

create or replace function public.reverse_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text
)
returns setof public.workspace_invoice_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoice_payments;
  v_updated public.workspace_invoice_payments;
  v_invoice_id text;
  v_payment_id text;
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
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_invoice_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  select * into v_existing
  from public.workspace_invoice_payments
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
    and client_payment_id = v_payment_id
  for update;

  if v_existing.id is null then
    raise exception 'Zahlung nicht gefunden';
  end if;

  -- Idempotent: eine bereits reversierte Zahlung bleibt, wie sie ist.
  if v_existing.reversed_at is not null then
    return next v_existing;
    return;
  end if;

  update public.workspace_invoice_payments
  set reversed_at = now(),
      reversed_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.reversed_at is null then
    raise exception 'Reversal nicht angewendet';
  end if;

  return next v_updated;
end;
$$;

/* -------------------------------------------------------------------------- */
/* Pull                                                                       */
/* -------------------------------------------------------------------------- */

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

  /*
   * Reversierte Zahlungen werden ausdruecklich mitgeliefert. Wuerde der Pull
   * sie verschweigen, behielte ein Geraet mit alter lokaler Kopie die Zahlung
   * fuer gueltig und wuerde sie beim Zusammenfuehren wiederbeleben.
   */
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

revoke all on function public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text) from public;
revoke all on function public.reverse_workspace_invoice_payment(uuid, text, text) from public;
revoke all on function public.pull_workspace_invoice_payments(uuid, timestamptz) from public;

grant execute on function public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text) to authenticated;
grant execute on function public.reverse_workspace_invoice_payment(uuid, text, text) to authenticated;
grant execute on function public.pull_workspace_invoice_payments(uuid, timestamptz) to authenticated;
