/*
 * BANKABGLEICH-V1 BLOCK 4 — die bestaetigte Zuordnung einer Bankbewegung.
 *
 * NOCH NICHT REMOTE AUSGEROLLT.
 *
 * WARUM UEBERHAUPT SERVERSEITIG
 *
 * Block 4 erzeugt zum ersten Mal im Bankbereich **Geldwirkung**. Zwei Dinge
 * muessen dabei zusammen gelingen oder gar nicht: die Zahlung und der
 * Nachweis, dass diese Bankbewegung damit erledigt ist. Zwei unabhaengige
 * Schreibvorgaenge vom Client waeren genau der Zustand, den der Auftrag
 * verbietet — "Zahlung gebucht, Bankbewegung weiterhin offen und erneut
 * buchbar". In einer Funktion laeuft beides in **einer** Transaktion: Scheitert
 * der zweite Schritt, ist auch der erste nicht geschehen.
 *
 * WARUM KEINE ZWEITE ZAHLUNGSLOGIK
 *
 * Die Funktion bucht nicht selbst. Sie ruft
 * `add_workspace_invoice_payment` bzw. `add_workspace_expense_payment` auf —
 * dieselben RPCs, die die Oberflaeche seit jeher benutzt. Damit gelten
 * unveraendert deren Pruefungen, deren Idempotenz ueber
 * `client_payment_id`, deren Nachbedingungen und deren Audit. Es entsteht
 * keine abweichende zweite Wahrheit, und die bestehende Zahlungssemantik
 * wird an **keiner** Stelle veraendert.
 *
 * WAS DIESE FUNKTION ZUSAETZLICH LEISTET
 *
 * Der bestehende Zahlungs-RPC prueft bewusst **keinen offenen Betrag** — das
 * tut heute der Client. Fuer einen Kontoauszug genuegt das nicht: Zwischen
 * Vorschlag und Bestaetigung kann eine andere Zahlung eingegangen sein. Diese
 * Funktion rechnet den offenen Betrag deshalb **im Moment der Bestaetigung**
 * neu aus der Cloud-Wahrheit aus und entscheidet danach. Der Client kann den
 * Betrag nicht vorgeben: Er stammt aus der gespeicherten Bankbewegung.
 */

/* -------------------------------------------------------------------------- */
/* 1. Die bestaetigte Zuordnung                                                */
/* -------------------------------------------------------------------------- */

create table if not exists public.workspace_bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_reconciliation_id text not null,

  /*
   * Die Bankbewegung. Der Unique-Index darauf ist das Herz dieses Blocks:
   * Er ist der Grund, warum Doppelklick, Reload, Retry, zwei Browser und ein
   * wiederholter Sync **niemals** eine zweite Zahlung erzeugen koennen. Der
   * Schutz liegt damit in der Datenbank und nicht in der Oberflaeche.
   */
  bank_transaction_id text not null,

  target_type text not null,
  client_target_id text not null,
  /* Die Zahlung, die aus dieser Bestaetigung entstanden ist. */
  client_payment_id text not null,
  amount_cents bigint not null,
  paid_on date not null,

  confirmed_at timestamptz not null default now(),
  confirmed_by uuid null references auth.users (id) on delete set null,

  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  row_version bigint not null default 1,

  constraint workspace_bank_reconciliations_target_check
    check (target_type in ('invoice', 'expense')),
  /* Eine Zuordnung ueber 0 oder negativ gibt es nicht — gebucht wird ein Betrag. */
  constraint workspace_bank_reconciliations_amount_check check (amount_cents > 0),
  constraint workspace_bank_reconciliations_client_id_unique
    unique (workspace_id, client_reconciliation_id),
  /* Je Bankbewegung hoechstens **eine** Zuordnung. */
  constraint workspace_bank_reconciliations_transaction_unique
    unique (workspace_id, bank_transaction_id),
  constraint workspace_bank_reconciliations_transaction_fk
    foreign key (workspace_id, bank_transaction_id)
    references public.workspace_bank_transactions (workspace_id, client_transaction_id)
    on delete restrict
);

create index if not exists workspace_bank_reconciliations_target_idx
  on public.workspace_bank_reconciliations (workspace_id, target_type, client_target_id);

drop trigger if exists workspace_bank_reconciliations_set_updated_at on public.workspace_bank_reconciliations;
create trigger workspace_bank_reconciliations_set_updated_at
before update on public.workspace_bank_reconciliations
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_bank_reconciliations enable row level security;

drop policy if exists workspace_bank_reconciliations_select_writer on public.workspace_bank_reconciliations;
create policy workspace_bank_reconciliations_select_writer
on public.workspace_bank_reconciliations for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_bank_reconciliations from public, anon;
grant select on public.workspace_bank_reconciliations to authenticated;

/*
 * Der Fremdschluessel der Bewegungstabelle braucht die Gegenseite als
 * eindeutig. `client_transaction_id` ist bereits je Betrieb unique — die
 * Bedingung oben nutzt genau diesen bestehenden Index.
 */

/* -------------------------------------------------------------------------- */
/* 2. Die eine atomare Aktion                                                  */
/* -------------------------------------------------------------------------- */

create or replace function public.confirm_workspace_bank_reconciliation(
  p_workspace_id uuid,
  p_bank_transaction_id text,
  p_target_type text,
  p_client_target_id text,
  p_client_payment_id text,
  p_client_reconciliation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_transaction public.workspace_bank_transactions;
  v_existing public.workspace_bank_reconciliations;
  v_inserted public.workspace_bank_reconciliations;
  v_invoice public.workspace_invoices;
  v_expense public.workspace_expenses;
  v_amount_cents bigint;
  v_total numeric;
  v_paid numeric;
  v_open numeric;
  v_amount numeric;
  v_paid_on date;
begin
  /*
   * R1-SEC-01 zuerst — dieselbe Autorisierung wie jede andere
   * finanzwirksame Aktion. Keine Umgehung, kein eigener Guard.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if p_target_type not in ('invoice', 'expense') then
    raise exception 'target_type ungueltig';
  end if;
  if nullif(trim(coalesce(p_client_payment_id, '')), '') is null then
    raise exception 'client_payment_id fehlt';
  end if;
  if nullif(trim(coalesce(p_client_reconciliation_id, '')), '') is null then
    raise exception 'client_reconciliation_id fehlt';
  end if;

  /*
   * Die Bankbewegung sperren. Ab hier koennen zwei gleichzeitige
   * Bestaetigungen derselben Bewegung nicht mehr nebeneinander laufen —
   * die zweite wartet und findet anschliessend die fertige Zuordnung vor.
   */
  select * into v_transaction
  from public.workspace_bank_transactions
  where workspace_id = p_workspace_id
    and client_transaction_id = p_bank_transaction_id
  for update;

  if v_transaction.id is null then
    raise exception 'Bankbewegung nicht gefunden';
  end if;

  /* Der Betrag kommt aus der Bank, nicht vom Client. */
  v_amount_cents := abs(v_transaction.amount_cents);
  v_paid_on := v_transaction.booking_date;
  v_amount := round(v_amount_cents::numeric / 100, 2);

  /* Richtung ist verbindlich: Eingang zahlt Rechnung, Ausgang zahlt Ausgabe. */
  if p_target_type = 'invoice' and v_transaction.amount_cents <= 0 then
    raise exception 'Falsche Richtung: eine Ausgangsrechnung braucht einen Zahlungseingang';
  end if;
  if p_target_type = 'expense' and v_transaction.amount_cents >= 0 then
    raise exception 'Falsche Richtung: eine Ausgabe braucht einen Zahlungsausgang';
  end if;

  /*
   * Schon zugeordnet? Dieselbe Entscheidung noch einmal ist ein Replay und
   * darf nicht scheitern; eine **andere** Entscheidung auf derselben
   * Bewegung ist ein Konflikt.
   */
  select * into v_existing
  from public.workspace_bank_reconciliations
  where workspace_id = p_workspace_id
    and bank_transaction_id = p_bank_transaction_id
  for update;

  if v_existing.id is not null then
    if v_existing.target_type = p_target_type
      and v_existing.client_target_id = p_client_target_id
      and v_existing.client_payment_id = p_client_payment_id
    then
      return jsonb_build_object('reconciliation', to_jsonb(v_existing), 'replayed', true);
    end if;
    raise exception 'Bankbewegung bereits zugeordnet';
  end if;

  /*
   * Der offene Betrag wird **jetzt** neu berechnet, nicht aus dem Vorschlag
   * uebernommen. Zwischen Anzeige und Bestaetigung kann eine andere Zahlung
   * eingegangen sein; der alte Stand waere dann eine Ueberzahlung.
   */
  if p_target_type = 'invoice' then
    select * into v_invoice
    from public.workspace_invoices
    where workspace_id = p_workspace_id and client_invoice_id = p_client_target_id
    for update;

    if v_invoice.id is null then
      raise exception 'Rechnung nicht gefunden';
    end if;
    if v_invoice.invoice_status = 'entwurf' then
      raise exception 'Rechnung nicht finalisiert';
    end if;
    if v_invoice.cancelled_at is not null then
      raise exception 'Rechnung storniert';
    end if;

    v_total := coalesce((v_invoice.payload->>'amount')::numeric, 0);
    select coalesce(sum(amount), 0) into v_paid
    from public.workspace_invoice_payments
    where workspace_id = p_workspace_id
      and client_invoice_id = p_client_target_id
      and reversed_at is null;
  else
    select * into v_expense
    from public.workspace_expenses
    where workspace_id = p_workspace_id and client_expense_id = p_client_target_id
    for update;

    if v_expense.id is null then
      raise exception 'Ausgabe nicht gefunden';
    end if;
    if v_expense.deleted then
      raise exception 'Ausgabe geloescht';
    end if;

    v_total := coalesce((v_expense.payload->>'grossAmount')::numeric, 0);
    select coalesce(sum(amount), 0) into v_paid
    from public.workspace_expense_payments
    where workspace_id = p_workspace_id
      and client_expense_id = p_client_target_id
      and reversed_at is null;
  end if;

  v_open := round(v_total - v_paid, 2);

  /*
   * Eine Gutschrift traegt einen negativen Bruttobetrag, ein bereits
   * bezahlter Posten erwartet nichts mehr. Beides ist kein Ziel.
   */
  if v_open <= 0 then
    raise exception 'Kein offener Betrag';
  end if;

  /*
   * Ueberzahlung: in V1 ausdruecklich **blockieren** statt zu kuerzen. Eine
   * stille Kuerzung waere eine erfundene Fachentscheidung, und eine
   * Ueberzahlung hat in OfficeTakt eine eigene, bewusste Bestaetigung.
   */
  if v_amount > v_open then
    raise exception 'Bankbetrag hoeher als offener Betrag: % > %', v_amount, v_open;
  end if;

  /*
   * Die Zuordnung zuerst. Der Unique-Index auf der Bankbewegung ist damit
   * der Serialisierungspunkt: Gewinnt hier ein paralleler Aufruf, kommt der
   * zweite gar nicht erst zur Zahlung.
   */
  insert into public.workspace_bank_reconciliations (
    workspace_id, client_reconciliation_id, bank_transaction_id,
    target_type, client_target_id, client_payment_id,
    amount_cents, paid_on, confirmed_by, created_by, updated_by, payload
  )
  values (
    p_workspace_id, p_client_reconciliation_id, p_bank_transaction_id,
    p_target_type, p_client_target_id, p_client_payment_id,
    v_amount_cents, v_paid_on, v_user_id, v_user_id, v_user_id,
    jsonb_build_object(
      'bankTransactionId', p_bank_transaction_id,
      'targetType', p_target_type,
      'targetId', p_client_target_id,
      'paymentId', p_client_payment_id,
      'amountCents', v_amount_cents,
      'paidOn', v_paid_on
    )
  )
  returning * into v_inserted;

  /*
   * Und jetzt die Zahlung — ueber den bestehenden, autorisierten Weg.
   * `method = 'bank'`: Eine bestaetigte Bankbewegung ist per Definition eine
   * Banküberweisung. Keine neue Zahlungsart.
   */
  if p_target_type = 'invoice' then
    perform public.add_workspace_invoice_payment(
      p_workspace_id,
      p_client_target_id,
      p_client_payment_id,
      v_amount,
      to_char(v_paid_on, 'YYYY-MM-DD'),
      nullif(trim(coalesce(v_transaction.bank_reference, '')), ''),
      null,
      'bank'
    );
  else
    perform public.add_workspace_expense_payment(
      p_workspace_id,
      p_client_target_id,
      p_client_payment_id,
      v_amount,
      to_char(v_paid_on, 'YYYY-MM-DD'),
      nullif(trim(coalesce(v_transaction.bank_reference, '')), ''),
      null,
      'bank'
    );
  end if;

  return jsonb_build_object('reconciliation', to_jsonb(v_inserted), 'replayed', false);
end;
$$;

revoke all on function public.confirm_workspace_bank_reconciliation(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.confirm_workspace_bank_reconciliation(uuid, text, text, text, text, text) to authenticated;

/* -------------------------------------------------------------------------- */
/* 3. Pull: dieselbe Sammelfunktion, ein Schluessel mehr                       */
/* -------------------------------------------------------------------------- */

/*
 * Woertlich die geltende Fassung aus 20261025120000, ergaenzt um
 * `bank_reconciliations`. Kein zweiter Pull-Pfad.
 */
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
    )
  );
end;
$$;
