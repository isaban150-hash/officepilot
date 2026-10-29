-- P1-KORREKTUR A-04 -- WEISS-A04-01: Steuersperre nicht mehr durch taxSplit: null (oder ein fehlendes/ungueltiges
-- Kennzeichen) umgehbar. Folgemigration zu 20261204120000_p1_a04_steueraufteilung_server (diese bleibt unveraendert).
--
-- ENTWURF -- erzeugt von pruefunterlagen/p1-korrektur-a04-a02/werkzeug/erzeuge-migration-weiss-a04-01.mjs aus der
-- Fassung von upsert_workspace_expense in 20261204120000 (sha256 c370623d31954320efecac9e4debb8032de8a841819fc79eb32bb4e4c34a98a7). Ersetzt nur diese eine Funktion mit
-- unveraenderter Signatur; Rechte bleiben (create or replace). Keine Datenaenderung, kein DDL an Tabellen.
--
-- Befund (WEISS, 27.10.2026): Ein berechtigter Aufrufer sendet zu einem offenen Beleg dieselben Geldwerte, aber
-- "taxSplit": null. Der Server uebernahm die gespeicherte Aufteilung nur bei FEHLENDEM Schluessel, die Pruefung
-- uebersprang null, gespeichert wurde null -> Zustand altbestand_pruefen -> Zahlung, Kontierungsbestaetigung und
-- Monatsabschluss (alle sperren genau "offen") waren frei.
--
-- Korrektur in upsert_workspace_expense:
--   (0) JSON-null bei taxSplit, inputTaxDeduction, deductibleTaxAmount und taxSplitSchema heisst "nicht angegeben";
--       taxSplitSchema nur mit dem Wert 1, sonst expense_tax_split_schema_invalid.
--   (b) Platzhalter ohne Aufteilung werden bei neuer Zeile oder Geldaenderung fuer JEDEN Schreibstand "offen"
--       (bisher nur ohne Kennzeichen).
--   (e) Uebergangsregel: ein offener Beleg wird nur "belegt"/"gemischt" (ausdruecklich, Steuer ungleich 0) oder
--       "steuerfrei"; alles andere -> expense_tax_split_open_unresolved (endgueltige Abweisung im Client, Praefix
--       expense_tax_split_).
-- Unveraendert: Altbestand (bleibt exakt, auch bei Titelaenderungen), Uebernahme fuer Schreibstaende ohne Kennzeichen,
-- alle Pruefregeln aus 20261204, Abschlussfassung 6, Sperre in Monaten aelterer Fassungen, Berechtigungen
-- (assert_financial_action_allowed, can_write_workspace) und Mandantentrennung.

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
  /* P1-KORREKTUR A04-WEISS-R1/R2 */
  v_schema boolean;
  v_split_changed boolean;
  v_alte_fassung text;
  /* WEISS-A04-01 */
  v_aufteilung_alt text;
  v_aufteilung_neu text;
  v_betraege record;
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

  /* ---------------------------------------------------------------- */
  /* P1-KORREKTUR A04-WEISS-R1/R2 — die Steueraufteilung               */
  /* ---------------------------------------------------------------- */
  if not v_deleted then
    /*
     * (0) WEISS-A04-01 -- JSON-null heisst "nicht angegeben", genau wie ein fehlender Schluessel. Bisher setzte ein
     *     ausdrueckliches null den Schluessel: (a) uebernahm die gespeicherte Aufteilung dann nicht, (b) setzte kein
     *     "offen", die Pruefung (c) uebersprang null -- ein offener Beleg wurde zu altbestand_pruefen und fiel aus den
     *     Sperren fuer Zahlung, Kontierung und Abschluss.
     *     Das Kennzeichen taxSplitSchema gilt nur mit dem einzigen bekannten Wert 1. null zaehlt als fehlend; jeder
     *     andere Wert wird abgewiesen (bisher schaltete jeder Wert, auch null, die Uebernahme (a) ab).
     */
    if v_payload ? 'taxSplitSchema' then
      if jsonb_typeof(v_payload->'taxSplitSchema') = 'null' then
        v_payload := v_payload - 'taxSplitSchema';
      elsif jsonb_typeof(v_payload->'taxSplitSchema') <> 'number' or v_payload->>'taxSplitSchema' <> '1' then
        raise exception 'expense_tax_split_schema_invalid: taxSplitSchema % ist unbekannt (erlaubt: 1)', v_payload->'taxSplitSchema'
          using errcode = 'P0001';
      end if;
    end if;
    if jsonb_typeof(v_payload->'taxSplit') = 'null' then
      v_payload := v_payload - 'taxSplit';
    end if;
    if jsonb_typeof(v_payload->'inputTaxDeduction') = 'null' then
      v_payload := v_payload - 'inputTaxDeduction';
    end if;
    if jsonb_typeof(v_payload->'deductibleTaxAmount') = 'null' then
      v_payload := v_payload - 'deductibleTaxAmount';
    end if;

    v_schema := v_payload ? 'taxSplitSchema';

    /*
     * (a) Ein Schreibstand ohne Kennzeichen (Altclient, alter direkter Aufruf) kennt die Steueraufteilung nicht. Er
     *     darf sie nicht still entfernen: Fehlende Felder werden aus dem gespeicherten Stand uebernommen.
     */
    if not v_schema and v_existing.id is not null and not v_existing.deleted then
      if not (v_payload ? 'taxSplit') and v_existing.payload ? 'taxSplit' then
        v_payload := v_payload || jsonb_build_object('taxSplit', v_existing.payload->'taxSplit');
      end if;
      if not (v_payload ? 'inputTaxDeduction') and v_existing.payload ? 'inputTaxDeduction' then
        v_payload := v_payload || jsonb_build_object('inputTaxDeduction', v_existing.payload->'inputTaxDeduction');
      end if;
      if not (v_payload ? 'deductibleTaxAmount') and v_existing.payload ? 'deductibleTaxAmount' then
        v_payload := v_payload || jsonb_build_object('deductibleTaxAmount', v_existing.payload->'deductibleTaxAmount');
      end if;
      if v_existing.payload ? 'taxSplitSchema' then
        v_payload := v_payload || jsonb_build_object('taxSplitSchema', v_existing.payload->'taxSplitSchema');
      end if;
    end if;

    /*
     * (b) Neue Geldangaben ohne Aufteilung: Platzhalter (Netto = Brutto, 0 Steuer) bei Regel- oder unklarem
     *     Steuerstatus sind ungeklaert -- "offen", nie eine bestaetigte Nullsteuer. WEISS-A04-01: fuer jeden
     *     Schreibstand, auch mit Kennzeichen (bisher nur ohne; mit Kennzeichen entstand so altbestand_pruefen ohne
     *     Sperre, auch auf dem Umweg ueber einen Steuerstatus ohne Umsatzsteuer). Wiederholungen ohne Geldaenderung und
     *     unveraenderter Altbestand bleiben exakt, wie sie sind.
     */
    if not (v_payload ? 'taxSplit')
       and (v_existing.id is null or v_existing.deleted or not coalesce(v_money_unchanged, false))
       and public.workspace_expense_steueraufteilung(v_payload) = 'altbestand_pruefen' then
      v_payload := v_payload || jsonb_build_object('taxSplit', 'offen');
    end if;

    /* (c) Fachliche Pruefung bei neuer Zeile, Geldaenderung oder geaenderter Aufteilung; Replays bleiben unberuehrt. */
    v_split_changed := v_existing.id is null
      or (v_existing.payload->'taxSplit') is distinct from (v_payload->'taxSplit')
      or (v_existing.payload->'inputTaxDeduction') is distinct from (v_payload->'inputTaxDeduction')
      or (v_existing.payload->'deductibleTaxAmount') is distinct from (v_payload->'deductibleTaxAmount')
      or (v_existing.payload->'allocations') is distinct from (v_payload->'allocations');
    if v_existing.id is null or not coalesce(v_money_unchanged, false) or v_split_changed then
      perform public.workspace_expense_steueraufteilung_pruefen(v_payload);
    end if;

    /*
     * (e) WEISS-A04-01 -- ein offener Beleg verlaesst "offen" nur durch eine fachliche Klaerung:
     *       * ausdruecklich "belegt" oder "gemischt" mit echten Werten (Steuer ungleich 0; bei 19 %/7 % weist die
     *         Pruefung (c) 0 Steuer ohnehin ab, hier gilt es auch fuer den Steuerstatus "unklar"), oder
     *       * ein Steuerstatus ohne Umsatzsteuer (steuerfrei, Kleinunternehmer, 13b).
     *     Jeder andere Folgezustand -- insbesondere altbestand_pruefen durch Weglassen oder Nullsetzen des Kennzeichens
     *     und "belegt" ohne ausdrueckliche Angabe -- wird endgueltig abgewiesen. Die Sperren fuer Zahlung, Kontierung und
     *     Abschluss haengen am Zustand "offen"; er bleibt, bis eine solche Klaerung gespeichert ist. (coalesce: Ein
     *     fehlender Schluessel ergaebe sonst NULL statt false, und die Abweisung griffe nicht -- Wegwerf-Lauf 2, W24.)
     */
    if v_existing.id is not null and not v_existing.deleted then
      v_aufteilung_alt := public.workspace_expense_steueraufteilung(v_existing.payload);
      if v_aufteilung_alt = 'offen' then
        v_aufteilung_neu := public.workspace_expense_steueraufteilung(v_payload);
        select x.brutto, x.netto, x.steuer into v_betraege from public.workspace_expense_betraege_cent(v_payload) x;
        if not (
             v_aufteilung_neu in ('offen', 'steuerfrei')
          or (v_aufteilung_neu in ('belegt', 'gemischt')
              and coalesce(jsonb_typeof(v_payload->'taxSplit'), '') = 'string'
              and coalesce(v_payload->>'taxSplit', '') in ('belegt', 'gemischt')
              and coalesce(v_betraege.steuer, 0) <> 0)
        ) then
          raise exception 'expense_tax_split_open_unresolved: offene Steueraufteilung nur mit belegter Steuer ("belegt"/"gemischt", Steuer ungleich 0) oder Steuerstatus ohne Umsatzsteuer aufloesbar (Folgezustand %, Steuer % Cent)',
            v_aufteilung_neu, v_betraege.steuer using errcode = 'P0001';
        end if;
      end if;
    end if;

    /*
     * (d) Abschlussfassung 1-5 bindet Aufteilungsart, Vorsteuerabzug und abziehbaren Betrag nicht. Liegt der alte oder
     *     neue Belegmonat in einer solchen aktiven Revision, ist eine Aenderung daran gesperrt (Korrekturweg:
     *     Monat wieder oeffnen, neue Revision in Fassung 6).
     */
    if v_existing.id is not null and not v_existing.deleted and (
         public.workspace_expense_steueraufteilung(v_existing.payload) is distinct from public.workspace_expense_steueraufteilung(v_payload)
      or public.workspace_expense_vorsteuerabzug(v_existing.payload) is distinct from public.workspace_expense_vorsteuerabzug(v_payload)
      or public.workspace_expense_abziehbar_cent(v_existing.payload) is distinct from public.workspace_expense_abziehbar_cent(v_payload)
    ) then
      select string_agg(lpad(c.period_year::text, 4, '0') || '-' || lpad(c.period_month::text, 2, '0') || ' Rev. ' || c.revision, ', ')
        into v_alte_fassung
      from public.workspace_accounting_period_closures c
      where c.workspace_id = p_workspace_id
        and c.reopened_at is null
        and coalesce(c.validated_version, 0) < 6
        and lpad(c.period_year::text, 4, '0') || '-' || lpad(c.period_month::text, 2, '0') in (
          left(coalesce(v_existing.payload->>'issueDate', v_existing.payload->>'createdAt', ''), 7),
          left(coalesce(v_payload->>'issueDate', v_payload->>'createdAt', ''), 7)
        );
      if v_alte_fassung is not null then
        raise exception 'expense_tax_split_closed_period: Monat mit aelterer Abschlussfassung abgeschlossen (%); Steueraufteilung und Vorsteuerabzug nur nach Wiederoeffnen aenderbar',
          v_alte_fassung using errcode = 'P0001';
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
