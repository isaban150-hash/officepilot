/*
 * FINANZCORE-05B2 — Geldintegritaet fuer Ausgaben an der Servergrenze.
 *
 * 05B hat die Regeln clientseitig durchgesetzt: `addExpense`, `updateExpense`
 * und der Push-Guard in `expenseCloudSyncService` lassen keine widerspruech-
 * lichen Geldwerte mehr durch. Serverseitig lag die Ausgabe dagegen als
 * Nutzlast-JSON ohne jede Betragspruefung; ein direkter RPC-Aufruf, ein alter
 * Client oder ein kuenftiger zweiter Schreibweg konnte weiterhin schreiben,
 * was er wollte.
 *
 * Diese Migration spiegelt genau die **harten** Regeln des Clients — nicht
 * mehr und nicht weniger:
 *
 *   1. netto + steuer = brutto, centgenau
 *   2. kein Steuerbetrag bei einem Status, der keine Umsatzsteuer kennt
 *   3. Steuer und Netto duerfen nicht gegenlaeufig sein
 *   4. Betraege muessen ueberhaupt verwertbar sein
 *
 * Ausdruecklich **nicht** geprueft wird der konkrete Steuersatz bei
 * `standard_19` / `standard_7`. Das Modell traegt einen Steuerstatus und einen
 * Steuerbetrag je Beleg; gemischte Saetze — Hotelrechnung mit 7 % und 19 %,
 * Baumarktbon mit zwei Saetzen — sind darin nicht darstellbar. Eine Satzregel
 * wuerde echte Belege unbuchbar machen. Der Client behandelt eine Abweichung
 * aus demselben Grund als Hinweis, nicht als Fehler; der Server tut es ihm
 * gleich.
 *
 * `unclear` bekommt keine Nullsteuer-Regel: Der Status sagt „unbekannt", nicht
 * „keine Steuer". Aus Unwissen einen Nullbetrag zu erzwingen waere eine
 * erfundene Steuerbehandlung.
 *
 * Zwei Dinge bleiben bewusst moeglich, damit der Guard keinen Altbestand
 * einsperrt — siehe die Kommentare an den jeweiligen Stellen:
 *
 *   - das **Loeschen** eines ungueltigen Altbelegs
 *   - der **unveraenderte Replay** eines ungueltigen Altbelegs
 *
 * Geaendert wird ausschliesslich `upsert_workspace_expense`. Keine
 * Schemaaenderung, keine Datenaenderung, kein Backfill.
 */

/* -------------------------------------------------------------------------- */
/* Geldwert aus JSONB in Cent                                                  */
/* -------------------------------------------------------------------------- */

/*
 * Gerechnet wird in Cent, wie im Client (`toCents`). NUMERIC ist exakte
 * Dezimalarithmetik — kein Gleitkomma, kein Epsilon, keine stille Toleranz.
 *
 * `null` heisst „kein verwertbarer Betrag": Feld fehlt, ist JSON-`null`, ist
 * kein Zahlwert oder laesst sich nicht als Zahl lesen. Der Aufrufer
 * entscheidet, was das bedeutet — hier wird nichts geraten und nichts auf 0
 * gesetzt.
 *
 * Zahl **und** Zeichenkette werden angenommen: Der heutige Client schickt
 * JSON-Zahlen, aber eine Zeichenkette `"119.00"` waere derselbe Betrag. Eine
 * bestehende gueltige Nutzlast soll an dieser Stelle nicht neu scheitern.
 */
create or replace function public.workspace_expense_money_cents(p_value jsonb)
returns bigint
language plpgsql
immutable
set search_path = public
as $$
declare
  v_kind text;
  v_num numeric;
begin
  if p_value is null then
    return null;
  end if;

  v_kind := jsonb_typeof(p_value);
  if v_kind not in ('number', 'string') then
    return null;
  end if;

  begin
    v_num := (p_value #>> '{}')::numeric;
  exception
    when others then
      return null;
  end;

  if v_num is null then
    return null;
  end if;

  return round(v_num * 100)::bigint;
end;
$$;

revoke all on function public.workspace_expense_money_cents(jsonb) from public;

/* -------------------------------------------------------------------------- */
/* Ausgabe anlegen / aendern / loeschen — mit Geldpruefung                     */
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
  v_net_cents bigint;
  v_tax_cents bigint;
  v_gross_cents bigint;
  v_tax_status text;
  v_money_unchanged boolean;
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

/*
 * Berechtigungen unveraendert wie in 20260917120000 — `create or replace`
 * behaelt sie zwar bei, aber sie stehen hier ausdruecklich noch einmal, damit
 * ein frischer Aufbau der Datenbank dieselbe Lage ergibt.
 */
revoke all on function public.upsert_workspace_expense(uuid, jsonb, bigint) from public;
grant execute on function public.upsert_workspace_expense(uuid, jsonb, bigint) to authenticated;
