/*
 * BANKABGLEICH-V1 BLOCK 5 — Storno und Bankzuordnung konsistent machen.
 *
 * NOCH NICHT REMOTE AUSGEROLLT.
 *
 * DIE LUECKE, IN DER ECHTEN ABNAHME NACHGEWIESEN
 *
 * Block 4 erzeugt zu einer bestaetigten Bankzuordnung eine Zahlung. Wird
 * diese Zahlung spaeter ueber den offiziellen Storno entfernt, blieb die
 * Zuordnung bisher stehen: Die Bankbewegung galt weiter als "Zugeordnet",
 * obwohl ihr kein aktives Geld mehr gegenuebersteht. Bei der Bereinigung der
 * Block-4-Abnahmedaten musste genau diese Luecke von Hand geschlossen werden.
 *
 * DIE LOESUNG
 *
 * Keine zweite Storno-Engine. Beide bestehenden Storno-RPCs werden woertlich
 * in ihrer geltenden Fassung neu angelegt und um **eine** Anweisung ergaenzt:
 * die Zuordnung, die auf genau diese Zahlung zeigt, wird mit entfernt.
 *
 * Dadurch ist die Aufhebung **atomar** — Storno und Freigabe der Bewegung
 * geschehen in derselben Transaktion. Ein getrennter zweiter Aufruf vom
 * Client aus koennte ausfallen und wieder einen halben Zustand hinterlassen.
 *
 * WAS SICH NICHT AENDERT
 *
 * Die Zahlungssemantik bleibt unangetastet: dieselbe Autorisierung
 * (`assert_financial_action_allowed`), dieselbe Mitgliedspruefung, dieselbe
 * Sperrreihenfolge, dieselbe Idempotenz, derselbe weiche Storno ueber
 * `reversed_at` und dieselbe Rueckgabe. Die Zahlungszeile bleibt als
 * Pruefspur bestehen; es wird nichts hart geloescht.
 *
 * Eine Zahlung **ohne** Bankbezug trifft die neue Anweisung nicht: Es gibt
 * keine Zuordnung mit ihrer Kennung, das `delete` entfernt null Zeilen, und
 * das Verhalten ist Zeile fuer Zeile das bisherige.
 *
 * WAS DIE BEWEGUNG DANACH IST
 *
 * Sie bleibt erhalten und ist wieder **offen**: Der Vorschlagsdienst darf
 * erneut Kandidaten berechnen, und eine neue Zahlung entsteht erst nach einer
 * erneuten ausdruecklichen Bestaetigung. Es wird nichts automatisch gebucht.
 */

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
  /*
   * R1-SEC-01 — Autorisierung vor allem anderen. Die bisherigen Pruefungen
   * darunter bleiben unveraendert stehen; dieser Aufruf ist zusaetzlich.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

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

  -- 01C: Rechnung vor Zahlung sperren — dieselbe Richtung wie Storno und Zahlung.
  perform 1
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  /*
   * BANKABGLEICH-V1 BLOCK 5 — die Bankzuordnung faellt mit der Zahlung.
   *
   * Eine Zuordnung behauptet: *genau diese* Bankbewegung ist durch *genau
   * diese* Zahlung erledigt. Gibt es die Zahlung fachlich nicht mehr, ist
   * die Behauptung falsch — und die Bewegung muss wieder offen sein.
   *
   * Bewusst **in dieser Funktion** und nicht als zweiter Client-Aufruf:
   * Storno und Aufhebung laufen damit in einer Transaktion. Ein
   * getrennter Aufruf koennte ausfallen und genau den Mischzustand
   * hinterlassen, den dieser Block beseitigt.
   *
   * Bewusst **vor** dem Rueckgabepunkt fuer bereits stornierte Zahlungen:
   * So raeumt ein erneuter Aufruf auch einen frueher entstandenen
   * Mischzustand auf. Die Anweisung ist fuer eine Zahlung ohne
   * Bankbezug wirkungslos — normale Zahlungen verhalten sich
   * unveraendert.
   */
  delete from public.workspace_bank_reconciliations
  where workspace_id = p_workspace_id
    and target_type = 'invoice'
    and client_target_id = v_invoice_id
    and client_payment_id = v_payment_id;


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
  /*
   * R1-SEC-01 — Autorisierung vor allem anderen. Die bisherigen Pruefungen
   * darunter bleiben unveraendert stehen; dieser Aufruf ist zusaetzlich.
   */
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

  /*
   * BANKABGLEICH-V1 BLOCK 5 — die Bankzuordnung faellt mit der Zahlung.
   *
   * Eine Zuordnung behauptet: *genau diese* Bankbewegung ist durch *genau
   * diese* Zahlung erledigt. Gibt es die Zahlung fachlich nicht mehr, ist
   * die Behauptung falsch — und die Bewegung muss wieder offen sein.
   *
   * Bewusst **in dieser Funktion** und nicht als zweiter Client-Aufruf:
   * Storno und Aufhebung laufen damit in einer Transaktion. Ein
   * getrennter Aufruf koennte ausfallen und genau den Mischzustand
   * hinterlassen, den dieser Block beseitigt.
   *
   * Bewusst **vor** dem Rueckgabepunkt fuer bereits stornierte Zahlungen:
   * So raeumt ein erneuter Aufruf auch einen frueher entstandenen
   * Mischzustand auf. Die Anweisung ist fuer eine Zahlung ohne
   * Bankbezug wirkungslos — normale Zahlungen verhalten sich
   * unveraendert.
   */
  delete from public.workspace_bank_reconciliations
  where workspace_id = p_workspace_id
    and target_type = 'expense'
    and client_target_id = v_expense_id
    and client_payment_id = v_payment_id;


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
