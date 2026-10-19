/*
 * FINANZ-CORE-01A -- Gesamtnacharbeit Paket 2 (WEISS-Gesamtmaengelinventur vom 15.10.2026):
 * atomarer Ausgabenvertrag.
 *
 *  INV-08  Ausgabenzahlungen umgingen die Buchungsregeln: eine zweite Zahlung ueber den offenen Betrag
 *          ohne Bestaetigung, eine Zahlung auf einen Entwurf, eine positive Zahlung auf eine negative
 *          Gutschrift wurden angenommen. Neu in add_workspace_expense_payment: zahlbar ist nur eine
 *          gebuchte, nicht stornierte, nicht geloeschte Ausgabe mit positivem Betrag; ueber den offenen
 *          Betrag hinaus nur mit ausdruecklicher Bestaetigung (p_overpayment_acknowledged, wie bei
 *          Rechnungen). Altaufrufer ohne den Parameter bekommen keine implizite Bestaetigung. Die
 *          Wiederholung derselben Zahlungskennung bleibt (sie ist keine neue Zahlung).
 *  INV-09  Eine bezahlte Ausgabe blieb betragsaenderbar und stornierbar: upsert_workspace_expense pruefte
 *          aktive Zahlungen nur beim Loeschen. Neu: Mit aktiver Zahlung sind Netto, Steuer, Brutto,
 *          Steuerstatus und Gutschriftkennzeichen gebunden, und die Ausgabe laesst sich weder stornieren
 *          noch in einen Entwurf zuruecksetzen. Storniert wird nur eine gebuchte Ausgabe; eine stornierte
 *          bleibt storniert.
 *  INV-11  Zahlung gegen Loeschen/Storno/Betragsaenderung war nicht serialisiert: die Zahlung las die
 *          Ausgabe ohne Sperre. Neu sperren Zahlung, Ruecknahme und Upsert dieselbe Ausgabenzeile
 *          (for update) und pruefen erst danach; dieselbe Reihenfolge Ausgabe -> Zahlung ueberall. Der
 *          Bankabgleich sperrt die Ausgabe bereits vor dem Aufruf der Zahlung.
 *
 * Ersetzt: add_workspace_expense_payment (20261110, 8 Argumente -> 9 Argumente, die alte Fassung wird
 * entfernt, damit ein Aufruf mit 8 Argumenten eindeutig bleibt), upsert_workspace_expense (20261023),
 * reverse_workspace_expense_payment (20261027). Jede ersetzte Funktion ist wortgleich aus ihrer neuesten
 * Fassung uebernommen; geaendert sind allein die mit "INV-" markierten Stellen. Autorisierung,
 * Rollenpruefung und Kontosperre stehen unveraendert vor jeder neuen Pruefung.
 *
 * Setzt 20261114120000 bis 20261119120000 voraus und aendert keine davon. Nur lokal angewendet.
 */

/* ------------------------------------------------------------------------------------------------ */
/* 1) Zahlung auf eine Ausgabe (aus 20261110)                                                        */
/* ------------------------------------------------------------------------------------------------ */

drop function if exists public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text);

create or replace function public.add_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null,
  /* INV-08 -- die ausdrueckliche Bestaetigung einer Ueberzahlung, wie bei Rechnungen. */
  p_overpayment_acknowledged boolean default false
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
  /* INV-08 */
  v_gross_cents bigint;
  v_paid_cents numeric;
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
  /*
   * FINANZ-CORE-01A (N03/SQL-05) -- nur endliche, auf Cent gerundet positive
   * Betraege. 'NaN' gilt in PostgreSQL als groesser als jede Zahl und passierte
   * "<= 0"; die Summen wurden NaN, der Client verwarf die Zeile. Unendlich
   * ebenso. Ein Betrag unter einem halben Cent ergab eine Zahlung ueber
   * 0,00 EUR. Die Pruefung steht vor jeder Ueberzahlungsfrage: Eine
   * Bestaetigung macht keinen Betrag gueltig.
   */
  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount in ('Infinity'::numeric, '-Infinity'::numeric)
     or round(p_amount, 2) <= 0 then
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

  /*
   * INV-11 -- die Ausgabenzeile ist der gemeinsame Serialisierungspunkt mit Upsert (Betrag, Storno,
   * Loeschmarke), Ruecknahme und Bankabgleich. Geprueft wird erst nach der Sperre: Eine parallele
   * Loeschung oder ein paralleles Storno wartet hier bzw. sieht danach die Zahlung.
   */
  select * into v_expense
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
  for update;
  if v_expense.id is null then
    raise exception 'Ausgabe nicht gefunden';
  end if;
  if v_expense.deleted then
    raise exception 'Ausgabe geloescht';
  end if;
  if v_expense.status = 'storniert' then
    raise exception 'Ausgabe storniert';
  end if;

  /*
   * INV-08 -- eine neue Zahlung (nicht die Wiederholung derselben Kennung) nur auf eine gebuchte
   * Ausgabe mit positivem Betrag, und ueber den offenen Betrag hinaus nur bewusst bestaetigt.
   */
  if not exists (
       select 1
       from public.workspace_expense_payments p
       where p.workspace_id = p_workspace_id
         and p.client_expense_id = v_expense_id
         and p.client_payment_id = v_payment_id
     ) then
    if v_expense.status <> 'gebucht' then
      raise exception 'expense_payment_not_payable: Status %', v_expense.status using errcode = 'P0001';
    end if;
    v_gross_cents := public.workspace_expense_money_cents(v_expense.payload->'grossAmount');
    if v_gross_cents is null then
      raise exception 'expense_payment_not_payable: Betrag ungeklaert' using errcode = 'P0001';
    end if;
    if v_gross_cents <= 0 or coalesce(v_expense.payload->'isCreditNote' = 'true'::jsonb, false) then
      raise exception 'expense_payment_not_payable: Gutschrift' using errcode = 'P0001';
    end if;
    select coalesce(sum(round(p.amount * 100)), 0) into v_paid_cents
    from public.workspace_expense_payments p
    where p.workspace_id = p_workspace_id
      and p.client_expense_id = v_expense_id
      and p.reversed_at is null;
    if round(p_amount, 2) * 100 > v_gross_cents - v_paid_cents
       and not coalesce(p_overpayment_acknowledged, false) then
      raise exception 'expense_payment_overpayment_unconfirmed: offen %',
        round(greatest(v_gross_cents - v_paid_cents, 0) / 100.0, 2)
        using errcode = 'P0001';
    end if;
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

revoke all on function public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text, boolean) from public, anon;
grant execute on function public.add_workspace_expense_payment(uuid, text, text, numeric, text, text, text, text, boolean) to authenticated;

/* ------------------------------------------------------------------------------------------------ */
/* 2) Ausgabe anlegen, aendern, stornieren, loeschen (aus 20261023)                                  */
/* ------------------------------------------------------------------------------------------------ */

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
  v_net_cents bigint;
  v_tax_cents bigint;
  v_gross_cents bigint;
  v_tax_status text;
  v_money_unchanged boolean;
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

  /* ---------------------------------------------------------------- */
  /* FINANZCORE-05B2 — die Geldpruefung                                */
  /* ---------------------------------------------------------------- */

  /*
   * Ein Grabstein traegt keine Betraege und schreibt keine Nutzlast: Beim
   * Loeschen wird nur `deleted` gesetzt, `payload` bleibt unangetastet.
   *
   * Deshalb wird hier **nicht** geprueft. Genau das erlaubt der Client-Guard
   * ebenfalls ausdruecklich: Ein ungueltiger Altbeleg muss loeschbar bleiben,
   * sonst haenge er fuer immer in der Cloud fest, ohne dass ihn jemand
   * entfernen koennte.
   */
  if not v_deleted then
    /*
     * Aendern sich die Geldfelder gar nicht, ist dies ein Replay derselben
     * Zeile — etwa beim erstmaligen Sync eines Geraets oder nach einem
     * Verbindungsabbruch.
     *
     * Ein solcher Aufruf schreibt nichts Neues an Geld und darf deshalb nicht
     * scheitern: Ein ungueltiger Altbeleg wuerde sonst bei jedem Sync erneut
     * abgelehnt und der Auftrag endlos wiederholt. Der Bestand bleibt lesbar,
     * er wird nur nicht besser.
     *
     * Sobald aber **ein** Geldfeld oder der Steuerstatus abweicht, ist es eine
     * fachliche Aenderung — und die muss gueltig sein.
     *
     * `jsonb`-Vergleich statt Textvergleich: `100.00` und `100` sind derselbe
     * Zahlwert und sollen nicht als Aenderung gelten.
     */
    v_money_unchanged := v_existing.id is not null
      and not v_existing.deleted
      and (v_existing.payload->'netAmount')   is not distinct from (v_payload->'netAmount')
      and (v_existing.payload->'taxAmount')   is not distinct from (v_payload->'taxAmount')
      and (v_existing.payload->'grossAmount') is not distinct from (v_payload->'grossAmount')
      and (v_existing.payload->'taxStatus')   is not distinct from (v_payload->'taxStatus');

    if not coalesce(v_money_unchanged, false) then
      v_net_cents   := public.workspace_expense_money_cents(v_payload->'netAmount');
      v_tax_cents   := public.workspace_expense_money_cents(v_payload->'taxAmount');
      v_gross_cents := public.workspace_expense_money_cents(v_payload->'grossAmount');
      v_tax_status  := nullif(trim(coalesce(v_payload->>'taxStatus', '')), '');

      if v_net_cents is null or v_tax_cents is null or v_gross_cents is null then
        raise exception 'expense_money_invalid_amount: netAmount/taxAmount/grossAmount fehlen oder sind unbrauchbar';
      end if;

      -- Die Gleichung. Gilt fuer jedes Vorzeichen: -100 + -19 = -119.
      if v_net_cents + v_tax_cents <> v_gross_cents then
        raise exception 'expense_money_equation_mismatch: % + % ergibt %, erwartet %',
          v_net_cents, v_tax_cents, v_net_cents + v_tax_cents, v_gross_cents;
      end if;

      /*
       * Sagt der Status, dass keine Umsatzsteuer anfaellt, ist ein
       * Steuerbetrag ein Widerspruch zum Status selbst. `unclear` steht
       * bewusst nicht in dieser Liste.
       */
      if v_tax_cents <> 0
        and v_tax_status in ('reverse_charge_13b', 'tax_free', 'kleinunternehmer_19') then
        raise exception 'expense_money_tax_on_zero_rate_status: % erlaubt keinen Steuerbetrag, erhalten % Cent',
          v_tax_status, v_tax_cents;
      end if;

      -- Ein positiver Steuerbetrag auf negativem Netto ist kein Beleg, sondern ein Tippfehler.
      if (v_net_cents > 0 and v_tax_cents < 0) or (v_net_cents < 0 and v_tax_cents > 0) then
        raise exception 'expense_money_tax_sign_mismatch: netto % Cent, steuer % Cent',
          v_net_cents, v_tax_cents;
      end if;
    end if;
  end if;

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
    /*
     * INV-09/11 -- nach der Sperre (oben) gezaehlt: Eine parallele Zahlung ist entweder schon
     * festgeschrieben und zaehlt hier, oder sie wartet auf diese Sperre und sieht danach das Ergebnis.
     */
    select count(*) into v_active_payments
    from public.workspace_expense_payments
    where workspace_id = p_workspace_id
      and client_expense_id = v_expense_id
      and reversed_at is null;
    if v_deleted then
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
      /*
       * INV-09 -- dieselben Uebergaenge wie im Client (cancelExpense, updateExpense), fuer jeden
       * Aufrufer: Eine stornierte Ausgabe bleibt storniert. Storniert wird nur eine gebuchte. Mit
       * aktiver Zahlung kein Storno, kein Zuruecksetzen in einen Entwurf und keine Aenderung an
       * Netto, Steuer, Brutto, Steuerstatus oder Gutschriftkennzeichen -- die Zahlung bindet sie.
       */
      if v_existing.status = 'storniert' and v_status <> 'storniert' then
        raise exception 'expense_cancelled_immutable: storniert bleibt storniert' using errcode = 'P0001';
      end if;
      if v_status = 'storniert' and v_existing.status not in ('gebucht', 'storniert') then
        raise exception 'expense_cancel_not_booked: nur eine gebuchte Ausgabe wird storniert' using errcode = 'P0001';
      end if;
      if v_active_payments > 0 then
        if v_status = 'storniert' and v_existing.status <> 'storniert' then
          raise exception 'expense_cancel_has_payments: % aktive Zahlung(en)', v_active_payments using errcode = 'P0001';
        end if;
        if v_status = 'entwurf' and v_existing.status <> 'entwurf' then
          raise exception 'expense_status_locked_after_payment: % aktive Zahlung(en)', v_active_payments using errcode = 'P0001';
        end if;
        if not coalesce(v_money_unchanged, false)
           or coalesce(v_existing.payload->'isCreditNote', 'false'::jsonb) is distinct from coalesce(v_payload->'isCreditNote', 'false'::jsonb) then
          raise exception 'expense_amount_locked_after_payment: % aktive Zahlung(en)', v_active_payments using errcode = 'P0001';
        end if;
      end if;
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
      updated_at = now()
  where workspace_id = p_workspace_id
    and expense_id = v_expense_id
    and (v_row.deleted or client_inbox_id is distinct from v_row.linked_inbox_id);
  if not v_row.deleted and v_row.linked_inbox_id is not null then
    update public.workspace_inbox_items
    set expense_id = v_expense_id,
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

revoke all on function public.upsert_workspace_expense(uuid, jsonb, bigint) from public, anon;
grant execute on function public.upsert_workspace_expense(uuid, jsonb, bigint) to authenticated;

/* ------------------------------------------------------------------------------------------------ */
/* 3) Ruecknahme einer Ausgabenzahlung (aus 20261027)                                                */
/* ------------------------------------------------------------------------------------------------ */

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

  /*
   * INV-11 -- dieselbe Sperrfolge wie Zahlung, Upsert und Bankabgleich: erst die Ausgabenzeile, dann
   * die Zahlung. Sonst konnte ein Upsert die Zahlungen zaehlen, waehrend die Ruecknahme noch lief.
   */
  perform 1
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id
  for update;

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

revoke all on function public.reverse_workspace_expense_payment(uuid, text, text) from public, anon;
grant execute on function public.reverse_workspace_expense_payment(uuid, text, text) to authenticated;
