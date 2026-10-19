-- FC01A-P1-NACHARBEIT -- Abzugsangaben der Schlussrechnung und offener Betrag mit Skonto.
--
-- Nach der unabhaengigen Endabnahme (WEISS, 14.10.2026, FAIL mit zwei P1-Befunden).
-- NUR LOKAL angewendet. Remote ausschliesslich nach gesonderter Freigabe (eigener
-- Veroeffentlichungslauf, gemeinsam mit 20261114120000_fc01a_nacharbeit.sql).
--
-- Jede geaenderte Funktion ist wortgleich aus ihrer neuesten Fassung uebernommen;
-- geaendert ist allein die mit "FC01A-P1-NACHARBEIT" markierte Stelle. Keine
-- GO-LIVE-SECURITY-01-Regel wird abgeschwaecht: Autorisierung, Rollenpruefung und
-- Kontosperre stehen unveraendert vor jeder neuen Pruefung. "create or replace"
-- behaelt die Rechte der bestehenden Funktionen; die bisherigen Entzuege und
-- Freigaben werden wiederholt.
--
--   workspace_invoice_open_cents          (neu, nur fuer den Eigentuemer)
--       ZAH-04  Was eine Rechnung noch fordert: Betrag minus wirksame Zahlungen, und
--               nichts, wenn fristgerecht mit Skonto beglichen. Eine Rechnung fuer
--               Schlussrechnung, Bankabgleich und Zahlungsannahme -- dieselbe wie im
--               Client (getOpenAmount).
--   assert_workspace_invoice_integrity    (aus 20261114120000)
--       #8      Nummer, Datum, Netto und Abschlagsnummer jeder Abzugszeile sind die des
--               gespeicherten Abschlags desselben Betriebs.
--       ZAH-04  "beglichen" ueber workspace_invoice_open_cents (unveraenderte Regel).
--       Rechte  nur der Eigentuemer, wie in der Produktion (lokal bisher auch authenticated
--               und service_role aus den Standardrechten der lokalen Instanz).
--   confirm_workspace_bank_reconciliation (aus 20261026120000)
--       ZAH-04  Offener Betrag mit Skonto; Vorgang vor Rechnung gesperrt.
--   add_workspace_invoice_payment         (aus 20261110120000)
--       ZAH-04  Ueberzahlungsgrenze mit Skonto; ein durch eine wirksame Schlussrechnung
--               abgerechneter Abschlag nimmt keine Zahlung ueber den offenen Betrag an,
--               auch nicht bestaetigt. Vorgang vor Rechnung gesperrt.

/* ZAH-04 -- der offene Betrag einer Rechnung, mit Skonto */
/*
 * FC01A-P1-NACHARBEIT (ZAH-04) -- was eine Rechnung noch fordert, in Cent.
 *
 * Rechnungsbetrag minus wirksame (nicht zurueckgenommene) Zahlungen; nichts, wenn die
 * Zahlungen den Betrag erreichen -- oder wenn die bis zum Fristende gebuchten Zahlungen den
 * Betrag nach Skonto erreichen (Satz und Frist aus dem Skontotext des Belegs, Frist ab
 * Rechnungsdatum, ein Cent Spielraum). Das ist genau die Regel, nach der eine
 * Schlussrechnung einen Abschlag als beglichen abzieht (N02/N02-R2), und die des Clients
 * (getOpenAmount, resolveSkontoSettledAmount).
 *
 * Bisher rechneten Bankabgleich und Zahlungsannahme ohne Skonto: Ein mit 490 + 10 Skonto
 * ausgeglichener Abschlag galt dort als "10 offen", die Schlussrechnung aber als beglichen
 * (WEISS-Endabnahme ZAH-04). NULL, wenn die Rechnung fehlt oder keinen Betrag traegt.
 * Ohne eigene Sperre: Die Aufrufer halten die Sperre der Rechnung (und des Vorgangs).
 */
create or replace function public.workspace_invoice_open_cents(
  p_workspace_id uuid,
  p_client_invoice_id text
)
returns numeric
language sql
stable
set search_path = public
as $$
  select case
    when z.paid_cents >= i.total_cents then 0
    when s.pct is not null and s.pct > 0 and s.pct < 100 and f.deadline is not null
         and z.timely_cents + 1 >= round(i.total_cents * (100 - s.pct) / 100) then 0
    else i.total_cents - z.paid_cents
  end
  from (
    select wi.payload, round((wi.payload->>'amount')::numeric * 100) as total_cents
    from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id
      and wi.client_invoice_id = p_client_invoice_id
      and jsonb_typeof(wi.payload->'amount') = 'number'
  ) i
  left join lateral public.workspace_skonto_terms(i.payload->>'skontoText') s on true
  cross join lateral (
    select public.workspace_safe_date(
             case when jsonb_typeof(i.payload->'issueDate') = 'string'
                  then i.payload->>'issueDate'
                  else i.payload->>'date' end
           ) + s.days as deadline
  ) f
  cross join lateral (
    select coalesce(sum(round(p.amount * 100)), 0) as paid_cents,
           coalesce(sum(round(p.amount * 100)) filter (where f.deadline is not null and p.paid_on <= f.deadline), 0) as timely_cents
    from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id
      and p.client_invoice_id = p_client_invoice_id
      and p.reversed_at is null
  ) z;
$$;

revoke all on function public.workspace_invoice_open_cents(uuid, text) from public, anon, authenticated, service_role;

/* #8 / ZAH-04 -- Schlussrechnung: Abzugsangaben und beglichene Abschlaege */
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
  /* FINANZ-CORE-01A (RE-04) */
  v_order_net_cents numeric;
  v_billed_net_cents numeric;
  v_customer_name text;
  v_order_customer text;
  v_master_customer text;
  /* 03F -- die Kundenrelation der freien Rechnung. */
  v_customer_id text;
  v_customer_workspace uuid;
  v_customer_deleted boolean;
  v_line_total numeric;
  /* FINANZ-CORE-01A (RE-09, SQL-09/12/15) */
  v_position_sums jsonb := '{}'::jsonb;
  v_position_sum numeric;
  v_notices text;
  v_date_text text;
  v_issue_date date;
  v_period_from date;
  v_period_to date;
begin
  /*
   * TEIL 1 -- gilt fuer jede Rechnung, mit und ohne Auftrag.
   */
  v_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  if v_type is null then
    raise exception 'invoice_type_invalid' using errcode = 'P0001';
  end if;
  /*
   * FINANZ-CORE-01A (SQL-08) -- nur die vier Belegarten, die der Client
   * ausstellt. Eine abweichende Schreibweise ('Schluss') oder eine fremde Art
   * ('gutschrift', 'storno') umging bisher jede typgebundene Regel: keine
   * Abzugspruefung der Schlussrechnung, keine Sperre nach ihr.
   */
  if v_type not in ('rechnung', 'abschlag', 'teilrechnung', 'schluss') then
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

  /*
   * FINANZ-CORE-01A (RE-09) -- Pflichtangaben des Ausstellers (§ 14 Abs. 4
   * Nr. 1 und 2 UStG) fuer jede Rechnungsart. Die Oberflaeche prueft Name und
   * Anschrift ('companyBlocks') und jetzt auch Steuernummer oder USt-IdNr.;
   * fehlte die Steuer-ID im Profil, entstand bisher ein nummerierter Beleg
   * ohne Pflichtangabe. Geprueft wird der Firmenstand, den der Beleg traegt
   * und druckt.
   */
  if jsonb_typeof(p_invoice->'companySnapshot') = 'object' then
    if nullif(trim(coalesce(p_invoice->'companySnapshot'->>'companyName', '')), '') is null
       or nullif(trim(coalesce(p_invoice->'companySnapshot'->>'street', '')), '') is null
       or nullif(trim(coalesce(p_invoice->'companySnapshot'->>'zip', '')), '') is null
       or nullif(trim(coalesce(p_invoice->'companySnapshot'->>'city', '')), '') is null then
      raise exception 'invoice_company_incomplete' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_invoice->'companySnapshot'->>'taxNumber', '')), '') is null
       and nullif(trim(coalesce(p_invoice->'companySnapshot'->>'vatId', '')), '') is null then
      raise exception 'invoice_company_tax_id_missing' using errcode = 'P0001';
    end if;
  end if;

  /*
   * FINANZ-CORE-01A (SQL-09) -- der Pflichthinweis folgt aus dem Steuerstatus
   * (§ 14a Abs. 5 UStG bei § 13b, § 19 Abs. 1 UStG, § 14 Abs. 4 Nr. 8 UStG bei
   * Steuerbefreiung). Gedruckt wird `legalNotices`; ein Entwurf, dessen
   * Steuerstatus nach dem Anlegen wechselte, trug sonst den alten Hinweis.
   */
  if jsonb_typeof(p_invoice->'legalNotices') = 'array'
     and v_tax_status in ('kleinunternehmer_19', 'reverse_charge_13b', 'tax_free') then
    select coalesce(string_agg(n.value, ' '), '')
    into v_notices
    from jsonb_array_elements_text(p_invoice->'legalNotices') n;
    if (v_tax_status = 'kleinunternehmer_19' and v_notices !~ '19\s*UStG')
       or (v_tax_status = 'reverse_charge_13b' and v_notices !~ '13b')
       or (v_tax_status = 'tax_free' and nullif(trim(v_notices), '') is null) then
      raise exception 'invoice_legal_notice_missing' using errcode = 'P0001';
    end if;
  end if;

  /*
   * FINANZ-CORE-01A (SQL-15/RE-17) -- die Daten, die der Beleg traegt.
   *
   * Das Rechnungsdatum ist das Ausstellungsdatum (§ 14 Abs. 4 Nr. 3 UStG): ein
   * gueltiger Kalendertag und nicht in der Zukunft (ein Tag Spielraum fuer
   * Geraeteuhren um Mitternacht). Bisher wurde ein ungueltiges Datum
   * gespeichert und das Jahr des Nummernkreises fiel still auf das UTC-Jahr;
   * ein kuenftiges Datum zog Nummern aus dem naechsten Jahreskreis. Ein
   * angegebener Leistungszeitraum muss gueltig sein und darf nicht rueckwaerts
   * laufen (wie 'service_period_order' in der Oberflaeche).
   */
  v_date_text := coalesce(
    nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''),
    nullif(trim(coalesce(p_invoice->>'date', '')), '')
  );
  if v_date_text is not null then
    if v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invoice_issue_date_invalid' using errcode = 'P0001';
    end if;
    begin
      v_issue_date := v_date_text::date;
    exception
      when others then
        raise exception 'invoice_issue_date_invalid' using errcode = 'P0001';
    end;
    if v_issue_date > (timezone('Europe/Berlin', now()))::date + 1 then
      raise exception 'invoice_issue_date_in_future' using errcode = 'P0001';
    end if;
  end if;

  v_date_text := nullif(trim(coalesce(p_invoice->>'servicePeriodFrom', '')), '');
  if v_date_text is not null then
    if v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invoice_service_period_invalid' using errcode = 'P0001';
    end if;
    begin
      v_period_from := v_date_text::date;
    exception
      when others then
        raise exception 'invoice_service_period_invalid' using errcode = 'P0001';
    end;
  end if;
  v_date_text := nullif(trim(coalesce(p_invoice->>'servicePeriodTo', '')), '');
  if v_date_text is not null then
    if v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'invoice_service_period_invalid' using errcode = 'P0001';
    end if;
    begin
      v_period_to := v_date_text::date;
    exception
      when others then
        raise exception 'invoice_service_period_invalid' using errcode = 'P0001';
    end;
  end if;
  if v_period_from is not null and v_period_to is not null and v_period_from > v_period_to then
    raise exception 'invoice_service_period_invalid' using errcode = 'P0001';
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

    /*
     * FINANZ-CORE-01A (SQL-10) -- "noch unklar" ist auch mit Auftrag keine
     * Steuerentscheidung. Die Oberflaeche verlangt sie fuer jede Rechnung
     * ('taxDecisionBlocker'); ein Beleg mit 0 % aus Unklarheit bekam bisher
     * trotzdem eine regulaere Nummer.
     */
    if v_tax_status = 'unclear' then
      raise exception 'invoice_tax_status_invalid' using errcode = 'P0001';
    end if;

    /*
     * Steuerstatus: Ein bestaetigter eigener Auftrag gibt ihn vor -- aber nur
     * eine getroffene Entscheidung. FINANZ-CORE-01A (SQL-10): Ein Auftrag mit
     * "unclear" (etwa aus einem frueher so freigegebenen Angebot) gibt nichts
     * vor. Bisher verlangte die Pruefung dann "unclear" auch auf der Rechnung,
     * die Oberflaeche verbietet genau das -- der Auftrag war nie abrechenbar.
     */
    if v_vorgang.payload ? 'taxStatus'
       and nullif(trim(coalesce(v_vorgang.payload->>'taxStatus', '')), '') is not null
       and trim(v_vorgang.payload->>'taxStatus') <> 'unclear'
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

    /*
     * FINANZ-CORE-01A (RE-09) -- Anschrift des Empfaengers wie bei der freien
     * Rechnung: `customerBlocks` gilt im Client fuer jede Rechnungsart.
     */
    v_customer_name := nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'name', '')), '');
    if v_customer_name is not null and (
         nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'street', '')), '') is null
      or nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'zip', '')), '') is null
      or nullif(trim(coalesce(p_invoice->'customerSnapshot'->>'city', '')), '') is null) then
      raise exception 'invoice_customer_address_incomplete' using errcode = 'P0001';
    end if;

    /*
     * FINANZ-CORE-01A (SQL-09) -- die Kundenakte. Traegt der Auftrag einen
     * Stammkunden, darf die Rechnung keinen anderen nennen; bisher wurde nur
     * der Name verglichen, und die Rechnung konnte in der falschen Akte landen.
     */
    if nullif(trim(coalesce(v_vorgang.payload->>'customerId', '')), '') is not null
       and nullif(trim(coalesce(p_invoice->>'customerId', '')), '') is not null
       and trim(p_invoice->>'customerId') <> trim(v_vorgang.payload->>'customerId') then
      raise exception 'invoice_customer_mismatch' using errcode = 'P0001';
    end if;

    /*
     * FINANZ-CORE-01A (SQL-09) -- "zwei Belege mit derselben Abschlagsnummer
     * darf es nie geben" (03D), jetzt auch serverseitig unter der
     * Vorgangssperre der Freigabe. Ein stornierter Abschlag behaelt seine
     * Nummer: vergeben ist vergeben.
     */
    if v_type = 'abschlag' and jsonb_typeof(p_invoice->'abschlagNumber') = 'number' then
      if exists (
        select 1
        from public.workspace_invoices wi
        where wi.workspace_id = p_workspace_id
          and wi.vorgang_id = p_vorgang_id
          and wi.invoice_type = 'abschlag'
          and wi.client_invoice_id is distinct from p_client_invoice_id
          and jsonb_typeof(wi.payload->'abschlagNumber') = 'number'
          and (wi.payload->>'abschlagNumber')::numeric = (p_invoice->>'abschlagNumber')::numeric
      ) then
        raise exception 'invoice_abschlag_number_taken: %', p_invoice->>'abschlagNumber' using errcode = 'P0001';
      end if;
    end if;

    /*
     * FINANZ-CORE-01A (RE-04) -- nach einem Pauschalabschlag rechnet die
     * Schlussrechnung ab, keine weitere "Rechnung": Der Pauschalbetrag
     * verbraucht keine Menge, nur die Schlussrechnung zieht ihn ab. Eine
     * Rechnung ueber die offene Leistung berechnete ihn doppelt.
     */
    if v_type = 'rechnung'
       and public.workspace_invoice_abschlag_deductions(p_workspace_id, p_vorgang_id, p_client_invoice_id) > 0 then
      raise exception 'invoice_requires_final_after_fixed_abschlag' using errcode = 'P0001';
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

      /*
       * FINANZ-CORE-01A (RE-04) -- Obergrenze wie im Client
       * (getRemainingFixedAmountBillableNetCents): abrechenbarer Planwert des
       * Auftrags minus alle wirksamen Abschlaege, Rechnungen und
       * Teilrechnungen. Bisher pruefte der Server nur "groesser 0".
       */
      select coalesce(sum(round(
               (pos.value->>'plannedQuantity')::numeric * (pos.value->>'unitPrice')::numeric * 100)), 0)
      into v_order_net_cents
      from jsonb_array_elements(coalesce(v_vorgang.payload->'orderPositions', '[]'::jsonb)) pos
      where jsonb_typeof(pos.value->'plannedQuantity') = 'number'
        and jsonb_typeof(pos.value->'unitPrice') = 'number'
        and case
          when coalesce(pos.value->>'category', '') <> 'material' then true
          when v_material_source = 'auftraggeber' then false
          when v_material_source = 'gemischt' then coalesce((pos.value->>'billable')::boolean, true)
          else true
        end;

      select coalesce(sum(round((wi.payload->>'subtotal')::numeric * 100)), 0)
      into v_billed_net_cents
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = p_vorgang_id
        and wi.invoice_type in ('abschlag', 'rechnung', 'teilrechnung')
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
        and coalesce(wi.payload->>'paymentStatus', '') <> 'storniert'
        and wi.client_invoice_id is distinct from p_client_invoice_id
        and jsonb_typeof(wi.payload->'subtotal') = 'number';

      if v_subtotal_cents > v_order_net_cents - v_billed_net_cents then
        raise exception 'invoice_fixed_amount_exceeds_remaining: % > %',
          v_subtotal_cents, v_order_net_cents - v_billed_net_cents using errcode = 'P0001';
      end if;
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

        /*
         * FINANZ-CORE-01A (SQL-12) -- die Grenze gilt je Auftragsposition, nicht
         * je Zeile: Zwei Zeilen derselben Position mit je 6 bei einem Rest von
         * 10 kamen bisher ohne Bestaetigung durch.
         */
        v_position_sum := coalesce((v_position_sums->>v_position_id)::numeric, 0) + v_quantity;
        v_position_sums := v_position_sums || jsonb_build_object(v_position_id, v_position_sum);
        if v_position_sum > v_reference and not coalesce(p_overbilling_acknowledged, false) then
          raise exception 'invoice_quantity_exceeds_available: % (%, offen %)', v_position_id, v_position_sum, v_reference using errcode = 'P0001';
        end if;

        /*
         * FINANZ-CORE-01A (SQL-09) -- der Zeilenbetrag steht im Beleg und wird
         * auch im Auftragspfad mitgeprueft, wie bei der freien Rechnung.
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

      /*
       * FINANZ-CORE-01A (SQL-14) -- kein Nullbeleg: Eine Auftragsrechnung ohne
       * eine einzige Zeile mit Menge bekam bisher eine Nummer. Die Oberflaeche
       * verlangt mindestens eine abrechenbare Position ('no_positions'). Erst
       * nach der Zeilenpruefung, damit eine ungueltige Zeile ihren eigenen
       * Fehler meldet. Eine Schlussrechnung, die erst durch Abzuege auf
       * 0,00 EUR kommt, hat Zeilen und bleibt zulaessig; die freie Rechnung
       * verlangt Menge > 0 je Zeile ohnehin (oben).
       */
      if not exists (
        select 1
        from jsonb_array_elements(coalesce(p_invoice->'positions', '[]'::jsonb)) l
        where jsonb_typeof(l.value->'quantity') = 'number'
          and (l.value->>'quantity')::numeric > 0
      ) then
        raise exception 'invoice_positions_missing' using errcode = 'P0001';
      end if;
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

    /*
     * FINANZ-CORE-01A (SQL-09) -- gedruckt wird jede Abzugszeile mit Nummer und
     * Betrag, nicht nur die Summe. Ein Geraet mit veraltetem Stand listete bei
     * gleicher Summe einen stornierten statt des neuen Abschlags. Deshalb als
     * Menge: jede Zeile genau ein wirksamer Pauschalabschlag mit seinem
     * Betrag, keiner doppelt, keiner fehlt.
     */
    if exists (
      select 1
      from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb)) d
      where not exists (
        select 1
        from public.workspace_invoice_abschlag_deduction_rows(p_workspace_id, p_vorgang_id, p_client_invoice_id) r
        where jsonb_typeof(d.value->'amount') = 'number'
          and r.client_invoice_id = d.value->>'invoiceId'
          and r.amount_cents = round((d.value->>'amount')::numeric * 100)
      )
    ) or (
      select count(*) <> count(distinct d.value->>'invoiceId')
      from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb)) d
    ) or (
      select count(*)
      from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb))
    ) <> (
      select count(*)
      from public.workspace_invoice_abschlag_deduction_rows(p_workspace_id, p_vorgang_id, p_client_invoice_id)
    ) then
      raise exception 'invoice_deductions_mismatch' using errcode = 'P0001';
    end if;

    /*
     * FC01A-P1-NACHARBEIT (#8) -- die Angaben jeder Abzugszeile sind die des Abschlags.
     *
     * Druck, E-Rechnung und Steuerberaterpaket lesen je Abzug Rechnungsnummer, Datum,
     * Netto und Abschlagsnummer aus der Schlussrechnung, nicht aus dem Abschlag. Bisher
     * prueften Summe und Menge oben nur Kennung und Betrag; ein veralteter oder
     * manipulierter Client konnte Netto 1, eine fremde Nummer und ein beliebiges Datum
     * einfrieren (WEISS-Endabnahme #8: Export mit Netto 9.999 und Steuer -499). Ein
     * fehlendes Netto verfaelschte ebenso: Ohne Netto gilt der Abzug in der Skonto-
     * Aufteilung als netto gleich brutto.
     *
     * Jede Angabe muss deshalb der gespeicherten Abschlagszeile desselben Betriebs
     * entsprechen (ueber die Mengenpruefung oben an Betrieb und Vorgang gebunden):
     *   - Rechnungsnummer: die vergebene Nummer (Spalte; Altbestand: Payload);
     *   - Datum: das Ausstellungsdatum des Abschlags (Altbestand: sein 'date');
     *     traegt der Abschlag keines, auch der Abzug nicht;
     *   - Netto: centgenau das des Abschlags; traegt der Abschlag keines (Altbestand),
     *     auch der Abzug nicht -- Export und Druck rechnen dann wie bisher ueber den Satz;
     *   - Abschlagsnummer: wie auf dem Abschlag, fehlt sie dort, fehlt sie auch hier.
     * Jeder Client seit Juni 2026 sendet genau diese Werte (getPreviousAbschlagDeductions);
     * ein abweichender Stand wird wie ein veralteter Abzug abgewiesen. Die Abweisung ist
     * dieselbe wie oben, damit auch ein alter Client "neu laden, neu aufbauen" zeigt.
     */
    if exists (
      select 1
      from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb)) d
      join public.workspace_invoices a
        on a.workspace_id = p_workspace_id
       and a.client_invoice_id = d.value->>'invoiceId'
      cross join lateral (
        select
          case when jsonb_typeof(d.value->'invoiceNumber') = 'string' then d.value->>'invoiceNumber' end as d_nummer,
          case when jsonb_typeof(a.payload->'number') = 'string' then a.payload->>'number' end as a_nummer,
          case when jsonb_typeof(d.value->'date') = 'string' then d.value->>'date' end as d_datum,
          case when jsonb_typeof(a.payload->'issueDate') = 'string' then a.payload->>'issueDate' end as a_ausgestellt,
          case when jsonb_typeof(a.payload->'date') = 'string' then a.payload->>'date' end as a_datum,
          case when jsonb_typeof(d.value->'subtotal') = 'number' then round((d.value->>'subtotal')::numeric * 100) end as d_netto,
          case when jsonb_typeof(a.payload->'subtotal') = 'number' then round((a.payload->>'subtotal')::numeric * 100) end as a_netto,
          case when jsonb_typeof(d.value->'abschlagNumber') = 'number' then (d.value->>'abschlagNumber')::numeric end as d_abschlag,
          case when jsonb_typeof(a.payload->'abschlagNumber') = 'number' then (a.payload->>'abschlagNumber')::numeric end as a_abschlag
      ) x
      where
        -- Eine vorhandene Angabe hat den Typ des Abschlags (kein Text statt Zahl, kein Objekt).
        coalesce(jsonb_typeof(d.value->'invoiceNumber'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(d.value->'date'), 'null') not in ('string', 'null')
        or coalesce(jsonb_typeof(d.value->'subtotal'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(d.value->'abschlagNumber'), 'null') not in ('number', 'null')
        -- Rechnungsnummer
        or x.d_nummer is null
        or not (x.d_nummer is not distinct from a.invoice_number or x.d_nummer is not distinct from x.a_nummer)
        -- Datum
        or not (
          (x.d_datum is not null
           and (x.d_datum is not distinct from x.a_ausgestellt or x.d_datum is not distinct from x.a_datum))
          or (x.d_datum is null and x.a_ausgestellt is null and x.a_datum is null)
        )
        -- Netto
        or x.d_netto is distinct from x.a_netto
        -- Abschlagsnummer
        or x.d_abschlag is distinct from x.a_abschlag
    ) then
      raise exception 'invoice_deductions_mismatch: angaben' using errcode = 'P0001';
    end if;

    /*
     * FC01A-NACHARBEIT (A3) -- abgezogen werden nur Abschlaege desselben Steuerfalls.
     * Ein Abschlag mit 19 % und eine Schlussrechnung nach Paragraf 13b (oder umgekehrt)
     * ergaeben einen falschen Restbetrag und eine falsch ausgewiesene oder doppelt
     * geschuldete Steuer; der Auftrag sperrt den Steuerstatus nicht immer (Vorgang ohne
     * Steuerstatus, etwa aus dem Eingang). Altbestand ohne Steuerstatus: wenigstens
     * Steuer ja/nein muss zum Satz der Schlussrechnung passen.
     */
    if exists (
      select 1
      from public.workspace_invoice_abschlag_deduction_rows(p_workspace_id, p_vorgang_id, p_client_invoice_id) r
      join public.workspace_invoices a
        on a.workspace_id = p_workspace_id
       and a.client_invoice_id = r.client_invoice_id
      where (
        coalesce(nullif(trim(coalesce(a.payload->>'taxStatus', '')), ''), 'unclear') <> 'unclear'
        and trim(a.payload->>'taxStatus') is distinct from v_tax_status
      ) or (
        coalesce(nullif(trim(coalesce(a.payload->>'taxStatus', '')), ''), 'unclear') = 'unclear'
        and jsonb_typeof(a.payload->'amount') = 'number'
        and jsonb_typeof(a.payload->'subtotal') = 'number'
        and (round((a.payload->>'amount')::numeric * 100) <> round((a.payload->>'subtotal')::numeric * 100)) <> (v_rate > 0)
      )
    ) then
      raise exception 'invoice_abschlag_tax_status_mismatch' using errcode = 'P0001';
    end if;

    /*
     * FINANZ-CORE-01A (SQL-13) -- Abzuege groesser als der Bruttobetrag werden
     * abgewiesen statt still auf 0 geklemmt; die Oberflaeche blockiert genau
     * das ('deductions_exceed_total'). Der Fehlbetrag existierte sonst nirgends.
     */
    if v_deduction_cents > v_gross_cents then
      raise exception 'invoice_deductions_exceed_total: % > %', v_deduction_cents, v_gross_cents using errcode = 'P0001';
    end if;
    /*
     * FINANZ-CORE-01A (N02/D1) -- abgezogen wird nur, was beglichen ist.
     *
     * Eine Schlussrechnung setzt die vereinnahmten Teilentgelte ab (Paragraf 14
     * Abs. 5 Satz 2 UStG). Beglichen ist ein Abschlag, wenn seine wirksamen
     * Zahlungen den Betrag erreichen -- oder, bei Skonto im Beleg, wenn die bis
     * zum Fristende gebuchten Zahlungen den Betrag nach Skonto erreichen
     * (dieselbe Regel wie im Client: Satz und Frist aus dem Skontotext, Frist ab
     * Rechnungsdatum, ein Cent Spielraum).
     *
     * WEISS-Recheck N02-R2: Bisher kannte der Server die Frist nicht; ein erst
     * nach Fristablauf zu 98 % bezahlter Abschlag galt als beglichen -- auch fuer
     * einen direkten Aufruf oder einen alten Client. Jetzt zaehlen fuer das
     * Skonto nur Zahlungen bis zum Fristende; ohne lesbare Frist gibt es kein
     * Skonto.
     */
    /*
     * FC01A-P1-NACHARBEIT (ZAH-04) -- dieselbe Regel, jetzt an einer Stelle:
     * workspace_invoice_open_cents rechnet auch fuer Bankabgleich und Zahlungsannahme.
     */
    if exists (
      select 1
      from public.workspace_invoice_abschlag_deduction_rows(p_workspace_id, p_vorgang_id, p_client_invoice_id) r
      where coalesce(public.workspace_invoice_open_cents(p_workspace_id, r.client_invoice_id), r.amount_cents) > 0
    ) then
      raise exception 'invoice_abschlag_unpaid' using errcode = 'P0001';
    end if;

    /*
     * WEISS-Recheck N02-R1 -- gezahlt und Skonto getrennt, und zwar wahr.
     *
     * Ein mit Skonto beglichener Abschlag ist nicht in voller Hoehe gezahlt: Die
     * E-Rechnung fuehrt in BT-113 nur das tatsaechlich Gezahlte, das gewaehrte
     * Skonto ist eine Entgeltminderung. Die Schlussrechnung friert deshalb je
     * Abzug ein, was gezahlt (paidAmount) und was als Skonto gewaehrt wurde
     * (skontoAmount); PDF, Ansicht und E-Rechnung lesen nur diese Werte. Hier
     * wird beides gegen die gebuchten Zahlungen geprueft. Fehlt die Aufteilung
     * bei einem nicht voll bezahlten Abschlag (direkter Aufruf, alter Client),
     * wird die Freigabe abgewiesen -- statt still 100 % als gezahlt zu fuehren.
     */
    if exists (
      select 1
      from public.workspace_invoice_abschlag_deduction_rows(p_workspace_id, p_vorgang_id, p_client_invoice_id) r
      join lateral (
        select x.value as v
        from jsonb_array_elements(coalesce(p_invoice->'previousAbschlagDeductions', '[]'::jsonb)) x
        where x.value->>'invoiceId' = r.client_invoice_id
        limit 1
      ) d on true
      cross join lateral (
        select least(r.amount_cents, coalesce(sum(round(p.amount * 100)), 0)) as paid_cents
        from public.workspace_invoice_payments p
        where p.workspace_id = p_workspace_id
          and p.client_invoice_id = r.client_invoice_id
          and p.reversed_at is null
      ) z
      where (d.v ? 'paidAmount') <> (d.v ? 'skontoAmount')
         or (d.v ? 'paidAmount' and jsonb_typeof(d.v->'paidAmount') <> 'number')
         or (d.v ? 'skontoAmount' and jsonb_typeof(d.v->'skontoAmount') <> 'number')
         or (z.paid_cents < r.amount_cents and not (d.v ? 'paidAmount'))
         or (jsonb_typeof(d.v->'paidAmount') = 'number'
             and round((d.v->>'paidAmount')::numeric * 100) is distinct from z.paid_cents)
         or (jsonb_typeof(d.v->'skontoAmount') = 'number'
             and round((d.v->>'skontoAmount')::numeric * 100) is distinct from r.amount_cents - z.paid_cents)
    ) then
      raise exception 'invoice_abschlag_settlement_mismatch' using errcode = 'P0001';
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

-- FC01A-P1-NACHARBEIT: nur der Eigentuemer, wie in der Produktion; aufgerufen allein aus
-- finalize_workspace_invoice (security definer). Lokal trugen authenticated und service_role
-- bisher EXECUTE aus den Standardrechten der lokalen Instanz.
revoke all on function public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean) from public, anon, authenticated, service_role;

/* ZAH-04 -- Bankabgleich: offener Betrag mit Skonto */
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
  -- FC01A-P1-NACHARBEIT (ZAH-04)
  v_vorgang_id text;
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
    /*
     * FC01A-P1-NACHARBEIT (ZAH-04) -- erst der Vorgang, dann die Rechnung: dieselbe
     * Reihenfolge wie Freigabe, Storno, Ruecknahme und Zahlungsannahme. So ist der offene
     * Betrag unten gegen eine gleichzeitige Schlussrechnung, Zahlung oder Ruecknahme
     * serialisiert.
     */
    select wi.vorgang_id into v_vorgang_id
    from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id
      and wi.client_invoice_id = p_client_target_id;
    if v_vorgang_id is not null then
      perform 1
      from public.workspace_vorgaenge v
      where v.workspace_id = p_workspace_id
        and v.vorgang_id = v_vorgang_id
      for update;
    end if;

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

    /*
     * FC01A-P1-NACHARBEIT (ZAH-04) -- offen ist, was die Rechnung noch fordert: nichts,
     * wenn sie fristgerecht mit Skonto beglichen ist. Bisher zaehlte nur Betrag minus
     * Zahlungen; ein mit 490 + 10 Skonto ausgeglichener Abschlag galt als "10 offen", und
     * eine Bankbewegung ueber 10 buchte eine zusaetzliche Zahlung -- auch hinter einer
     * Schlussrechnung, die Zahlung und Skonto eingefroren hat (WEISS-Endabnahme ZAH-04).
     * Dieselbe Rechnung wie Schlussrechnung, Zahlungsannahme und Client.
     */
    v_open := round(coalesce(public.workspace_invoice_open_cents(p_workspace_id, p_client_target_id), 0) / 100, 2);
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
    -- FC01A-P1-NACHARBEIT (ZAH-04): fuer Ausgaben unveraendert.
    v_open := round(v_total - v_paid, 2);
  end if;

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

/* ZAH-04 -- Zahlungsannahme: Ueberzahlung mit Skonto, Abschlag hinter Schlussrechnung */
create or replace function public.add_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null,
  /* FINANZ-CORE-01A (SQL-05) -- die ausdrueckliche Bestaetigung einer Ueberzahlung. */
  p_overpayment_acknowledged boolean default false
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
  /* FINANZ-CORE-01A (SQL-05) */
  v_total numeric;
  v_paid numeric;
  /* FC01A-P1-NACHARBEIT (ZAH-04) */
  v_vorgang_id text;
  v_open_cents numeric;
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
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  -- Kein Formatzwang: `pay-<millis>` und UUID sind beide gueltig.
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null then
    raise exception 'client_payment_id fehlt';
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
  -- Der echte Kalender: '2026-02-29' und '2026-04-31' existieren nicht.
  begin
    perform v_paid_on::date;
  exception
    when others then
      raise exception 'paid_on ungueltig';
  end;
  /*
   * FINANZ-CORE-01A (SQL-15) -- ein Zahlungseingang liegt nicht in der Zukunft
   * (ein Tag Spielraum fuer Geraeteuhren um Mitternacht).
   */
  if v_paid_on::date > (timezone('Europe/Berlin', now()))::date + 1 then
    raise exception 'paid_on ungueltig: Zukunft';
  end if;

  v_reference := nullif(trim(coalesce(p_reference, '')), '');
  v_note := nullif(trim(coalesce(p_note, '')), '');

  -- 02B — optionale Zahlungsart; NULL bleibt NULL.
  v_method := nullif(trim(coalesce(p_method, '')), '');
  if v_method is not null and v_method not in ('bank', 'cash', 'other') then
    raise exception 'method ungueltig';
  end if;

  /*
   * FC01A-P1-NACHARBEIT (ZAH-04) -- erst der Vorgang, dann die Rechnung: dieselbe
   * Reihenfolge wie Freigabe, Storno und Ruecknahme. So ist die Pruefung unten gegen eine
   * gleichzeitige Schlussrechnung serialisiert, deren Freigabe Zahlung und Skonto der
   * Abschlaege einfriert.
   */
  select wi.vorgang_id into v_vorgang_id
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = v_invoice_id;
  if v_vorgang_id is not null then
    perform 1
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;
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

  /*
   * FINANZ-CORE-01A (SQL-05/ZAH-02) -- Ueberzahlung nur mit ausdruecklicher
   * Bestaetigung, jetzt auch auf dem Server.
   *
   * Bisher pruefte allein der Client den offenen Betrag. Zwei Geraete oder
   * Personen, die denselben Eingang erfassten, erzeugten zwei Zahlungen; die
   * Rechnung galt als ueberbezahlt, OP-Liste und Export stimmten nicht. Unter
   * der Rechnungssperre (oben) wird der offene Betrag jetzt aus der
   * Cloud-Wahrheit gerechnet -- wie in confirm_workspace_bank_reconciliation:
   * Rechnungsbetrag minus wirksame Zahlungen. Skonto kennt der Server nicht;
   * die Grenze ist damit nie strenger als die des Clients.
   *
   * Eine Wiederholung derselben Kennung ist keine neue Zahlung und wird nicht
   * erneut geprueft: Sie bekommt ihre Zeile (oder ihren Konflikt) darunter.
   */
  /*
   * FC01A-P1-NACHARBEIT (ZAH-04) -- der offene Betrag kennt jetzt Skonto, wie im Client
   * (getOpenAmount): Eine fristgerecht mit Skonto beglichene Rechnung fordert nichts mehr,
   * jede weitere Zahlung ist eine Ueberzahlung und braucht die ausdrueckliche Bestaetigung.
   *
   * Ein Abschlag, den eine wirksame Schlussrechnung abzieht, nimmt ueber seinen offenen
   * Betrag hinaus gar keine Zahlung an, auch nicht bestaetigt: Die Schlussrechnung hat
   * Zahlung und Skonto eingefroren (N02-R1); eine weitere Zahlung machte diese Aufteilung
   * falsch und waere wegen A2 nicht einmal ruecknehmbar. Geld nach der Schlussrechnung
   * gehoert auf die Schlussrechnung.
   *
   * Eine Wiederholung derselben Kennung ist weiterhin keine neue Zahlung und wird nicht
   * erneut geprueft: Sie bekommt ihre Zeile (oder ihren Konflikt) darunter.
   */
  if not exists (
       select 1
       from public.workspace_invoice_payments p
       where p.workspace_id = p_workspace_id
         and p.client_invoice_id = v_invoice_id
         and p.client_payment_id = v_payment_id
     ) then
    v_open_cents := public.workspace_invoice_open_cents(p_workspace_id, v_invoice_id);
    if v_open_cents is not null and round(p_amount, 2) * 100 > v_open_cents then
      if v_invoice.invoice_type = 'abschlag' and v_invoice.vorgang_id is not null and exists (
        select 1
        from public.workspace_invoices s
        where s.workspace_id = p_workspace_id
          and s.vorgang_id = v_invoice.vorgang_id
          and s.invoice_type = 'schluss'
          and s.invoice_status in ('vorbereitet', 'versendet')
          and s.cancelled_at is null
          and exists (
            select 1
            from jsonb_array_elements(coalesce(s.payload->'previousAbschlagDeductions', '[]'::jsonb)) d
            where d.value->>'invoiceId' = v_invoice_id
          )
      ) then
        raise exception 'invoice_payment_final_invoice_exists: offen %', round(v_open_cents / 100, 2)
          using errcode = 'P0001';
      end if;
      if not coalesce(p_overpayment_acknowledged, false) then
        raise exception 'invoice_payment_overpayment_unconfirmed: offen %', round(v_open_cents / 100, 2)
          using errcode = 'P0001';
      end if;
    end if;
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

revoke all on function public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text, boolean) from public, anon;
grant execute on function public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text, boolean) to authenticated;
