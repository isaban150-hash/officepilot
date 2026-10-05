/*
 * BARZAHLUNG-V1 BLOCK 1 — der Zahlungsnachweis an der einzelnen Zahlung.
 *
 * NOCH NICHT REMOTE AUSGEROLLT.
 *
 * DAS PROBLEM
 *
 * Eine Ausgabe kann heute bar bezahlt werden (`method = 'cash'`), und ein
 * Dokument kann einer Ausgabe zugeordnet werden. Was fehlt, ist die Aussage
 * "diese Quittung beweist **genau diese** Zahlung". Bei Teilzahlungen ist das
 * kein Feinschliff, sondern der eigentliche Punkt: 40 EUR bar mit Quittung A
 * und 60 EUR bar mit Quittung B sind zwei Nachweise, die auf Belegebene
 * unweigerlich zu einem Haufen verschmelzen.
 *
 * WARUM EINE EIGENE SPALTE UND KEIN PAYLOAD
 *
 * Die beiden Zahlungstabellen sind bewusst rein spaltenbasiert; ein
 * `payload` gibt es dort nicht. `workspace_expenses` traegt zwar einen
 * Payload, doch dort stehen Zahlungen ausdruecklich **nicht** drin (siehe
 * 20260917120000: "Ein Zahlungsarray im Payload waere Last-Write-Wins").
 * Der Nachweis gehoert zur Zahlung, also an die Zahlungszeile.
 *
 * WARUM EINE EIGENE FUNKTION UND NICHT `add_workspace_*_payment`
 *
 * Die `add_`-Funktionen sind append-only und behandeln ihre Felder als
 * **Identitaet** der Zahlung: Dieselbe Kennung mit abweichendem Wert ist ein
 * Konflikt, keine stille Aenderung (so eingefuehrt mit der Zahlungsart in
 * 20261020120000). Ein Zahlungsnachweis ist aber genau das Gegenteil — die
 * Quittung wird oft erst am naechsten Tag fotografiert. Haetten wir ihn in
 * `add_` gelegt, waere er entweder unveraenderlich (und damit unbrauchbar)
 * oder die Identitaetsregel waere aufgeweicht worden.
 *
 * Deshalb eine getrennte Funktion — mit drei weiteren Vorteilen:
 *
 *   1. Die geldwirksamen Funktionen werden **gar nicht angefasst**. Nach den
 *      Haerteschritten der letzten Bloecke ist das den Umweg wert.
 *   2. Geldwirkung und Belegzuordnung bleiben getrennt pruefbar.
 *   3. Das Dokument ist moeglicherweise noch nicht hochgeladen, wenn die
 *      Zahlung gepusht wird. Scheiterte deshalb die Zahlung, waere das ein
 *      schlechter Tausch. So scheitert hoechstens die Zuordnung und wird
 *      wiederholt — die Zahlung ist laengst sicher.
 *
 * WAS GEPRUEFT WIRD
 *
 * Das Dokument muss im **selben** Workspace existieren und darf kein
 * Grabstein sein. Die Pruefung steht hier und nicht im Client: Eine
 * clientseitige Pruefung ist keine Sicherheitsgrenze, und ein Verweis auf
 * ein fremdes Dokument waere ein Datenleck ueber Betriebsgrenzen hinweg.
 *
 * `null` loescht den Nachweis wieder — ein Fehlgriff muss korrigierbar sein,
 * ohne die Zahlung zu stornieren.
 *
 * WAS SICH NICHT AENDERT
 *
 * Keine Zahlungssemantik, keine Betraege, kein Zahlungsstatus, kein Storno.
 * Diese Funktion bewegt kein Geld. Sie bekommt trotzdem denselben Guard
 * `assert_financial_action_allowed` wie die geldwirksamen Funktionen: Der
 * Zahlungsnachweis ist Teil der Finanzakte, und eine gesperrte Lizenz soll
 * daran nichts aendern duerfen. Keine Rechteausweitung — jede Funktion
 * behaelt zusaetzlich die Mitgliedspruefung ihrer eigenen Tabelle.
 */

alter table public.workspace_invoice_payments
  add column if not exists proof_document_id text null;

alter table public.workspace_expense_payments
  add column if not exists proof_document_id text null;

/* ------------------------------------------------------------------------ */
/* Ausgabenzahlung — der Pflichtfall dieses Blocks                           */
/* ------------------------------------------------------------------------ */

create or replace function public.set_workspace_expense_payment_proof(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_proof_document_id text default null
)
returns setof public.workspace_expense_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_expense_id text;
  v_payment_id text;
  v_document_id text;
  v_existing public.workspace_expense_payments;
  v_updated public.workspace_expense_payments;
begin
  /* R1-SEC-01 — wie bei jeder Aktion an der Finanzakte, vor allem anderen. */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  /* Dieselbe Mitgliedspruefung wie die uebrigen Ausgabenfunktionen. */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_expense_id := nullif(trim(coalesce(p_client_expense_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_expense_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  v_document_id := nullif(trim(coalesce(p_proof_document_id, '')), '');

  /*
   * Workspace-Isolation: Das Dokument muss hier liegen. Ein Verweis auf ein
   * fremdes Dokument wird abgewiesen, nicht stillschweigend gespeichert.
   */
  if v_document_id is not null then
    if not exists (
      select 1
      from public.workspace_documents d
      where d.workspace_id = p_workspace_id
        and d.client_document_id = v_document_id
        and coalesce(d.deleted, false) = false
    ) then
      raise exception 'Zahlungsnachweis nicht gefunden';
    end if;
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

  /* Idempotent: derselbe Nachweis ein zweites Mal aendert nichts. */
  if v_existing.proof_document_id is not distinct from v_document_id then
    return next v_existing;
    return;
  end if;

  update public.workspace_expense_payments
  set proof_document_id = v_document_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return next v_updated;
end;
$$;

/* ------------------------------------------------------------------------ */
/* Rechnungszahlung — symmetrisch, damit spaeter keine zweite Migration      */
/* noetig ist. Auch eine bar kassierte Kundenzahlung hat eine Quittung.      */
/* ------------------------------------------------------------------------ */

create or replace function public.set_workspace_invoice_payment_proof(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_proof_document_id text default null
)
returns setof public.workspace_invoice_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_payment_id text;
  v_document_id text;
  v_existing public.workspace_invoice_payments;
  v_updated public.workspace_invoice_payments;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  /* Dieselbe Mitgliedspruefung wie die uebrigen Rechnungszahlungsfunktionen. */
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_invoice_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  v_document_id := nullif(trim(coalesce(p_proof_document_id, '')), '');

  if v_document_id is not null then
    if not exists (
      select 1
      from public.workspace_documents d
      where d.workspace_id = p_workspace_id
        and d.client_document_id = v_document_id
        and coalesce(d.deleted, false) = false
    ) then
      raise exception 'Zahlungsnachweis nicht gefunden';
    end if;
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

  if v_existing.proof_document_id is not distinct from v_document_id then
    return next v_existing;
    return;
  end if;

  update public.workspace_invoice_payments
  set proof_document_id = v_document_id,
      row_version = row_version + 1,
      updated_at = now()
  where id = v_existing.id
  returning * into v_updated;

  return next v_updated;
end;
$$;

/* ------------------------------------------------------------------------ */
/* Pull — der Nachweis muss zurueckkommen, sonst ist er nach dem naechsten   */
/* Neuaufbau verschwunden.                                                   */
/* ------------------------------------------------------------------------ */

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
        'proof_document_id', p.proof_document_id,
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
          'proof_document_id', p.proof_document_id,
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
/* Rechte — wie bei den uebrigen Finanzfunktionen.                           */
/* ------------------------------------------------------------------------ */

revoke all on function public.set_workspace_expense_payment_proof(uuid, text, text, text) from public;
revoke all on function public.set_workspace_invoice_payment_proof(uuid, text, text, text) from public;
grant execute on function public.set_workspace_expense_payment_proof(uuid, text, text, text) to authenticated;
grant execute on function public.set_workspace_invoice_payment_proof(uuid, text, text, text) to authenticated;
