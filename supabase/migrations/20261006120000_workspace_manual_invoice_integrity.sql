/*
 * MANUELLE-RECHNUNG-03F -- die Rechnung ohne Auftrag bekommt dieselbe
 * serverseitige Wahrheit wie die Rechnung mit Auftrag.
 *
 * Realbefund aus der 03E-Analyse: `assert_workspace_invoice_integrity` kehrte
 * bei `p_vorgang_id is null` sofort zurueck -- direkt nach der Frage, ob der
 * Steuerstatus ueberhaupt ein bekannter ist. Fuer eine freie Rechnung war
 * damit nichts geprueft: nicht die Positionen, nicht die Zeilenbetraege, nicht
 * die Zwischensumme, nicht die Steuer, nicht der Gesamtbetrag und nicht der
 * Kunde. Der Server vergab dafuer trotzdem eine regulaere Rechnungsnummer aus
 * dem gemeinsamen Jahreskreis.
 *
 * Der frueh gesetzte `return` schaltete dabei mehr ab als noetig: Der
 * Summen- und Steuerblock am Ende der Funktion braucht keinen Auftrag. Nur die
 * Positionspruefung gegen den Auftragsplan und die Abschlagsabzuege brauchen
 * ihn. Diese Migration sortiert deshalb um, statt etwas zu erfinden:
 *
 *   TEIL 1  fuer jede Rechnung -- Typ, Steuerstatus, Positionen, Zeilenbetraege
 *   TEIL 2a ohne Auftrag       -- die Positionen tragen sich selbst
 *   TEIL 2b mit Auftrag        -- der unveraenderte 03B-Zweig
 *   TEIL 3  fuer jede Rechnung -- Zwischensumme, Steuer, Gesamtbetrag
 *
 * Teil 2b und Teil 3 sind aus der 03B-Migration **byte-genau** uebernommen.
 * Keine 03B-Regel wird abgeschwaecht, keine Signatur geaendert, kein Schema
 * angefasst. Die bereits remote angewendete 03B-Migration bleibt unberuehrt;
 * dies ist eine reine Follow-up-Fassung derselben Funktion.
 *
 * Bewusst **nicht** geaendert:
 *   - `finalize_workspace_invoice` (Nummernkreis, Idempotenz, Typsperre)
 *   - `cancel_workspace_invoice`
 *   - die Regel, dass ohne Auftrag nur `rechnung` erlaubt ist
 */

/*
 * Die gueltigen Einheiten einer frei erfassten Rechnungszeile.
 *
 * Zweite Fassung derselben Liste -- die erste ist `ORDER_UNITS` im Client
 * (`src/services/orderUnits.ts`). Der Server kann sie nicht importieren, und
 * eine ungeprueft uebernommene Einheit waere genau die Luecke, die dieser
 * Block schliesst. Gegen das Auseinanderlaufen steht ein Clienttest, der beide
 * Listen vergleicht (`manualInvoiceIntegrity03f.test.ts`).
 *
 * Bei einer Auftragsrechnung wird die Einheit weiterhin gegen die
 * Auftragsposition geprueft, nicht gegen diese Liste -- dort ist der Auftrag
 * die kaufmaennische Wahrheit.
 */
create or replace function public.workspace_invoice_unit_is_known(p_unit text)
returns boolean
language sql
immutable
as $$
  select p_unit in ('m²', 'Stück', 'Meter', 'Stunden', 'Pauschal');
$$;

create or replace function public.assert_workspace_invoice_integrity(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb,
  p_overbilling_acknowledged boolean
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_vorgang public.workspace_vorgaenge;
  v_type text;
  v_tax_status text;
  v_rate numeric;
  v_mode text;
  v_line jsonb;
  v_order_position jsonb;
  v_position_id text;
  v_quantity numeric;
  v_unit_price numeric;
  v_billed numeric;
  v_reference numeric;
  v_executed numeric;
  v_planned numeric;
  v_material_source text;
  v_billable boolean;
  v_subtotal_cents numeric := 0;
  v_tax_cents numeric;
  v_gross_cents numeric;
  v_deduction_cents numeric := 0;
  v_client_deduction_cents numeric := 0;
  v_amount_cents numeric;
  v_client_subtotal_cents numeric;
  v_client_amount_cents numeric;
  v_fixed_net numeric;
  v_customer_name text;
  v_order_customer text;
  v_master_customer text;
  /* 03F -- die Kundenrelation der freien Rechnung. */
  v_customer_id text;
  v_customer_workspace uuid;
  v_customer_deleted boolean;
  v_line_total numeric;
begin
  /*
   * TEIL 1 -- gilt fuer jede Rechnung, mit und ohne Auftrag.
   */
  v_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  if v_type is null then
    raise exception 'invoice_type_invalid' using errcode = 'P0001';
  end if;
  v_tax_status := nullif(trim(coalesce(p_invoice->>'taxStatus', '')), '');
  v_rate := public.workspace_tax_rate_for_status(coalesce(v_tax_status, ''));
  if v_rate is null then
    raise exception 'invoice_tax_status_invalid' using errcode = 'P0001';
  end if;

  if jsonb_typeof(coalesce(p_invoice->'positions', 'null'::jsonb)) <> 'array' then
    raise exception 'invoice_positions_missing' using errcode = 'P0001';
  end if;

  if p_vorgang_id is null then
    /*
     * TEIL 2a -- die freie Rechnung. Es gibt keinen Auftragsplan, gegen den
     * geprueft werden koennte; die Zeile muss sich deshalb selbst tragen.
     *
     * Ohne Auftrag ist nur `rechnung` definiert. `finalize_workspace_invoice`
     * weist die uebrigen Typen bereits vorher ab; die Wiederholung hier macht
     * die Funktion allein lauffaehig und verhindert, dass ein direkter Aufruf
     * an den Abschlagsabzuegen mit NULL-Vorgang vorbeikommt.
     */
    if v_type <> 'rechnung' then
      raise exception 'invoice_requires_vorgang_for_type' using errcode = 'P0001';
    end if;

    /*
     * 03F2 — "noch unklar" ist keine Steuerentscheidung.
     *
     * 'workspace_tax_rate_for_status' liefert fuer 'unclear' einen Satz von 0
     * und meldet damit einen **gueltigen** Status; der Server haette eine
     * Rechnung mit ungeklaerter Umsatzsteuer angenommen. Die Oberflaeche laesst
     * das nicht zu ('taxDecisionBlocker') — ein manipulierter Client soll die
     * bewusste Entscheidung aber ebensowenig umgehen koennen.
     *
     * Bewusst **nur** ohne Auftrag: Eine Auftragsrechnung erbt ihren Status vom
     * bestaetigten Auftrag, und Altbestand darf hier nicht nachtraeglich
     * unfreigebbar werden. Fuer die freie Rechnung gibt es keinen Auftrag, von
     * dem sich etwas erben liesse — die Entscheidung trifft allein der Nutzer,
     * und sie muss getroffen sein.
     */
    if v_tax_status = 'unclear' then
      raise exception 'invoice_tax_status_invalid' using errcode = 'P0001';
    end if;

    /*
     * Kundenintegritaet -- und ihre bewusste Grenze.
     *
     * `customerSnapshot` ist historische Belegwahrheit: was auf dem Papier
     * steht. Der Nutzer darf die Rechnungsanschrift vor der Freigabe aendern,
     * und ein spaeter geaenderter Kundenstamm darf einen bereits erstellten
     * Entwurf nicht nachtraeglich unfreigebbar machen. Ein Namensvergleich
     * gegen den aktuellen Stammsatz wuerde genau diese Semantik zerstoeren und
     * steht deshalb hier **nicht**.
     *
     * Serverseitig gebunden wird stattdessen die relationale Identitaet:
     *   - ein Empfaengername muss ueberhaupt dastehen,
     *   - `customerId` muss vorhanden sein,
     *   - und wenn diese Kennung aufloesbar ist, muss sie zu **diesem**
     *     Workspace gehoeren und darf nicht geloescht sein.
     *
     * Eine nirgends aufloesbare Kennung wird angenommen: Ein gerade erst
     * angelegter Kunde erreicht `workspace_customers` erst mit dem naechsten
     * Sync-Lauf, waehrend die Freigabe sofort moeglich ist. Serverseitig sind
     * "noch nicht gepusht" und "erfunden" nicht unterscheidbar; die Freigabe
     * einer echten Rechnung zu verweigern waere der groessere Schaden. Die
     * Kennung ist keine Belegaussage -- sie steht auf keinem Papier.
     */
    v_customer_name := nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'name', '')), '');
    if v_customer_name is null then
      raise exception 'invoice_customer_mismatch' using errcode = 'P0001';
    end if;

    /*
     * 03F2 — dieselben Mindestfelder, die die Oberflaeche verlangt.
     *
     * 'customerBlocks' in 'invoiceValidationService' blockiert die Freigabe
     * ueber 'hasUsableAddress': Strasse, PLZ und Ort muessen dastehen. Ein
     * direkter RPC-Aufruf kam daran bisher vorbei und haette fuer einen Beleg
     * ohne Anschrift eine regulaere Rechnungsnummer bekommen.
     *
     * Geprueft wird **Vollstaendigkeit**, nicht Uebereinstimmung: Welche
     * Anschrift dort steht, entscheidet der Nutzer. Ein Land wird nicht
     * verlangt — die Clientregel verlangt es auch nicht, und der Server soll
     * hier nicht strenger sein als die Oberflaeche.
     */
    if nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'street', '')), '') is null
       or nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'zip', '')), '') is null
       or nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'city', '')), '') is null then
      raise exception 'invoice_customer_address_incomplete' using errcode = 'P0001';
    end if;

    v_customer_id := nullif(trim(coalesce(p_invoice->>'customerId', '')), '');
    if v_customer_id is null then
      raise exception 'invoice_customer_mismatch' using errcode = 'P0001';
    end if;

    select c.workspace_id, c.deleted
    into v_customer_workspace, v_customer_deleted
    from public.workspace_customers c
    where c.customer_id = v_customer_id
    order by (c.workspace_id = p_workspace_id) desc
    limit 1;

    if v_customer_workspace is not null
       and (v_customer_workspace is distinct from p_workspace_id or coalesce(v_customer_deleted, false)) then
      raise exception 'invoice_customer_mismatch' using errcode = 'P0001';
    end if;

    /* Ein Pauschalabschlag ist ohne Auftrag nicht definiert -- oben abgewiesen. */
    if jsonb_array_length(coalesce(p_invoice->'positions', '[]'::jsonb)) = 0 then
      raise exception 'invoice_positions_missing' using errcode = 'P0001';
    end if;

    /*
     * Jede Zeile traegt sich selbst. Mengen- und Preisregel sind dieselben wie
     * im Client (`validateManualPosition`): Die Menge muss groesser als null
     * sein, der Preis darf null sein (kostenlose Zeile), aber nicht negativ.
     *
     * JSON kennt weder NaN noch Infinity -- ein Zahlentyptest
     * schliesst sie bereits aus. Der real erreichbare Manipulationsfall ist
     * deshalb der Textwert oder die fehlende Eigenschaft, und genau der wird
     * hier abgewiesen.
     */
    for v_line in select value from jsonb_array_elements(coalesce(p_invoice->'positions', '[]'::jsonb)) loop
      if nullif(trim(coalesce(v_line->>'description', '')), '') is null then
        raise exception 'invoice_position_description_missing' using errcode = 'P0001';
      end if;

      if jsonb_typeof(v_line->'quantity') <> 'number' then
        raise exception 'invoice_quantity_invalid' using errcode = 'P0001';
      end if;
      v_quantity := (v_line->>'quantity')::numeric;
      if v_quantity is null or v_quantity <= 0 or v_quantity = 'NaN'::numeric then
        raise exception 'invoice_quantity_invalid' using errcode = 'P0001';
      end if;

      if jsonb_typeof(v_line->'unitPrice') <> 'number' then
        raise exception 'invoice_position_mismatch' using errcode = 'P0001';
      end if;
      v_unit_price := (v_line->>'unitPrice')::numeric;
      if v_unit_price is null or v_unit_price < 0 or v_unit_price = 'NaN'::numeric then
        raise exception 'invoice_position_mismatch' using errcode = 'P0001';
      end if;

      if not public.workspace_invoice_unit_is_known(coalesce(v_line->>'unit', '')) then
        raise exception 'invoice_position_unit_invalid' using errcode = 'P0001';
      end if;

      /*
       * Der Zeilenbetrag steht im Beleg und wird deshalb mitgeprueft -- nicht
       * uebernommen. Fehlt er, wird er gerechnet; steht er falsch da, ist der
       * Beleg in sich widerspruechlich.
       */
      if jsonb_typeof(v_line->'lineTotal') = 'number' then
        v_line_total := (v_line->>'lineTotal')::numeric;
        if round(v_line_total * 100) is distinct from round(v_quantity * v_unit_price * 100) then
          raise exception 'invoice_totals_mismatch: Zeile % (% x %)',
            coalesce(v_line->>'description', ''), v_quantity, v_unit_price using errcode = 'P0001';
        end if;
      end if;

      v_subtotal_cents := v_subtotal_cents + round(v_quantity * v_unit_price * 100);
    end loop;
  else
    select * into v_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = p_vorgang_id;
    if not found then
      raise exception 'Vorgang gehört nicht zum Workspace oder existiert nicht' using errcode = 'P0001';
    end if;

    v_material_source := coalesce(v_vorgang.payload->>'materialSource', 'unclear');
    v_mode := coalesce(p_invoice->>'calculationMode', 'quantity_based');

    /* Steuerstatus: Ein bestaetigter eigener Auftrag gibt ihn vor. */
    if v_vorgang.payload ? 'taxStatus'
       and nullif(trim(coalesce(v_vorgang.payload->>'taxStatus', '')), '') is not null
       and v_tax_status is distinct from v_vorgang.payload->>'taxStatus' then
      raise exception 'invoice_tax_status_mismatch' using errcode = 'P0001';
    end if;

    /* Kundenbeleg: Name muss zum Auftrag oder zum Kundenstamm passen. */
    v_order_customer := nullif(trim(coalesce(v_vorgang.payload->'customerBilling'->>'name', v_vorgang.payload->>'customer', '')), '');
    if v_order_customer is not null then
      v_customer_name := nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'name', '')), '');
      select nullif(trim(coalesce(c.payload->>'name', '')), '') into v_master_customer
      from public.workspace_customers c
      where c.workspace_id = p_workspace_id
        and c.customer_id = nullif(trim(coalesce(v_vorgang.payload->>'customerId', '')), '')
        and c.deleted = false;
      if v_customer_name is null
         or (v_customer_name is distinct from v_order_customer
             and (v_master_customer is null or v_customer_name is distinct from v_master_customer)) then
        raise exception 'invoice_customer_mismatch' using errcode = 'P0001';
      end if;
    end if;

    /* Pauschaler Abschlag: keine Menge, nur ein gueltiger Betrag. */
    if v_type = 'abschlag' and v_mode = 'fixed_amount' then
      if jsonb_array_length(coalesce(p_invoice->'positions', '[]'::jsonb)) <> 0 then
        raise exception 'invoice_fixed_amount_with_positions' using errcode = 'P0001';
      end if;
      if jsonb_typeof(p_invoice->'fixedAmountNet') <> 'number' then
        raise exception 'invoice_fixed_amount_invalid' using errcode = 'P0001';
      end if;
      v_fixed_net := (p_invoice->>'fixedAmountNet')::numeric;
      if v_fixed_net is null or v_fixed_net <= 0 or v_fixed_net = 'NaN'::numeric then
        raise exception 'invoice_fixed_amount_invalid' using errcode = 'P0001';
      end if;
      v_subtotal_cents := round(v_fixed_net * 100);
    else
      /* Jede Rechnungszeile gegen den autoritativen Auftragsplan. */
      for v_line in select value from jsonb_array_elements(coalesce(p_invoice->'positions', '[]'::jsonb)) loop
        v_position_id := nullif(trim(coalesce(v_line->>'orderPositionId', '')), '');
        if v_position_id is null then
          raise exception 'invoice_position_not_found' using errcode = 'P0001';
        end if;

        select pos.value into v_order_position
        from jsonb_array_elements(coalesce(v_vorgang.payload->'orderPositions', '[]'::jsonb)) pos
        where pos.value->>'id' = v_position_id
        limit 1;
        if v_order_position is null then
          raise exception 'invoice_position_not_found' using errcode = 'P0001';
        end if;

        if jsonb_typeof(v_line->'quantity') <> 'number' then
          raise exception 'invoice_quantity_invalid' using errcode = 'P0001';
        end if;
        v_quantity := (v_line->>'quantity')::numeric;
        if v_quantity is null or v_quantity < 0 or v_quantity = 'NaN'::numeric then
          raise exception 'invoice_quantity_invalid' using errcode = 'P0001';
        end if;

        /* Abrechenbarkeit wie `isPositionBillable` im Client. */
        v_billable := case
          when coalesce(v_order_position->>'category', '') <> 'material' then true
          when v_material_source = 'auftraggeber' then false
          when v_material_source = 'betrieb' then true
          when v_material_source = 'gemischt' then coalesce((v_order_position->>'billable')::boolean, true)
          else coalesce((v_order_position->>'billable')::boolean, true)
        end;
        if not v_billable and v_quantity > 0 then
          raise exception 'invoice_position_not_billable' using errcode = 'P0001';
        end if;

        /* Einheit und Einzelpreis sind kaufmaennische Wahrheit des Auftrags. */
        if (v_line->>'unit') is distinct from (v_order_position->>'unit') then
          raise exception 'invoice_position_mismatch' using errcode = 'P0001';
        end if;
        if jsonb_typeof(v_line->'unitPrice') <> 'number' then
          raise exception 'invoice_position_mismatch' using errcode = 'P0001';
        end if;
        v_unit_price := (v_line->>'unitPrice')::numeric;
        if round(v_unit_price * 100) is distinct from round((v_order_position->>'unitPrice')::numeric * 100) then
          raise exception 'invoice_position_mismatch' using errcode = 'P0001';
        end if;

        /*
         * Grenze wie im Client (`getOverbillingReference`): Ist ein Aufmass
         * erfasst, gilt der dokumentierte Ist-Rest, sonst der offene Planrest.
         */
        v_billed := public.workspace_invoice_billed_quantity(p_workspace_id, p_vorgang_id, v_position_id, p_client_invoice_id);
        v_planned := coalesce((v_order_position->>'plannedQuantity')::numeric, 0);
        if jsonb_typeof(v_order_position->'executedQuantity') = 'number' then
          v_executed := (v_order_position->>'executedQuantity')::numeric;
          v_reference := greatest(0, v_executed - v_billed);
        else
          v_reference := greatest(0, v_planned - v_billed);
        end if;

        if v_quantity > v_reference and not coalesce(p_overbilling_acknowledged, false) then
          raise exception 'invoice_quantity_exceeds_available: % (%, offen %)', v_position_id, v_quantity, v_reference using errcode = 'P0001';
        end if;

        v_subtotal_cents := v_subtotal_cents + round(v_quantity * v_unit_price * 100);
      end loop;
    end if;
  end if;

  /*
   * Summen: dieselbe Reihenfolge wie `calculateInvoiceTotals` -- je Zeile auf
   * Cent runden, summieren, Steuer einmal runden, Abschlaege abziehen; nur die
   * Schlussrechnung klemmt bei 0.
   */
  v_tax_cents := case when v_rate > 0 then round(v_subtotal_cents * v_rate / 100) else 0 end;
  v_gross_cents := v_subtotal_cents + v_tax_cents;

  if v_type = 'schluss' then
    v_deduction_cents := round(public.workspace_invoice_abschlag_deductions(p_workspace_id, p_vorgang_id, p_client_invoice_id) * 100);
    select coalesce(sum(round((d.value->>'amount')::numeric * 100)), 0)
    into v_client_deduction_cents
    from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb)) d
    where jsonb_typeof(d.value->'amount') = 'number';
    if v_client_deduction_cents is distinct from v_deduction_cents then
      raise exception 'invoice_deductions_mismatch' using errcode = 'P0001';
    end if;
    v_amount_cents := greatest(0, v_gross_cents - v_deduction_cents);
  else
    v_amount_cents := v_gross_cents;
  end if;

  if jsonb_typeof(p_invoice->'subtotal') <> 'number' or jsonb_typeof(p_invoice->'amount') <> 'number' then
    raise exception 'invoice_totals_mismatch' using errcode = 'P0001';
  end if;
  v_client_subtotal_cents := round((p_invoice->>'subtotal')::numeric * 100);
  v_client_amount_cents := round((p_invoice->>'amount')::numeric * 100);
  if v_client_subtotal_cents is distinct from v_subtotal_cents
     or v_client_amount_cents is distinct from v_amount_cents then
    raise exception 'invoice_totals_mismatch: netto % / % , brutto % / %',
      v_client_subtotal_cents, v_subtotal_cents, v_client_amount_cents, v_amount_cents using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.workspace_invoice_unit_is_known(text) from public, anon;
revoke all on function public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean) from public, anon;
