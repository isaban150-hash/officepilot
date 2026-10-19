-- FC01A-NACHARBEIT -- Abschlag, Schlussrechnung, Zahlung und Skonto: Serververtraege.
--
-- NUR LOKAL angewendet. Remote ausschliesslich nach gesonderter Freigabe (eigener
-- Veroeffentlichungslauf).
--
-- Jede geaenderte Funktion ist wortgleich aus ihrer neuesten Fassung uebernommen;
-- geaendert ist allein die mit "FC01A-NACHARBEIT" markierte Stelle. Keine
-- GO-LIVE-SECURITY-01-Regel wird abgeschwaecht: Autorisierung, Rollenpruefung und
-- Kontosperre stehen unveraendert vor jeder neuen Pruefung. "create or replace"
-- behaelt die Rechte der bestehenden Funktionen; die bisherigen Entzuege werden
-- wiederholt.
--
--   workspace_skonto_terms             (aus 20261110120000)
--       A4  Die Skontofrist ist die Tagesangabe, die zum Skontosatz gehoert: im
--           selben Satz, keine Nettofrist, unter mehreren die naechstliegende.
--           Bisher galt die erste Tagesangabe nach dem Satz ("10 Tagen 2 % Skonto,
--           sonst 30 Tage netto" ergab 30 Tage). Dieselbe Lesart wie im Client.
--   reverse_workspace_invoice_payment  (aus 20261027120000)
--       A2  Die Zahlung eines Abschlags, den eine wirksame Schlussrechnung als
--           beglichen abzieht, ist erst nach deren Storno ruecknehmbar. Vorgang
--           vor Rechnung gesperrt (wie Storno und Freigabe).
--   assert_workspace_invoice_integrity (aus 20261110120000)
--       A3  Eine Schlussrechnung zieht nur Abschlaege desselben Steuerfalls ab.

/* A4 -- Skontosatz und Skontofrist */
create or replace function public.workspace_skonto_terms(p_text text)
returns table (pct numeric, days integer)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  -- Geschuetzte Leerzeichen (etwa aus einer Textverarbeitung) zaehlen wie normale (wie im Client).
  v_text text := translate(coalesce(p_text, ''), chr(160) || chr(8239), '  ');
  v_len integer;
  v_pct_re constant text := '([0-9]+([.,][0-9]+)?)[[:space:]]*%';
  v_days_re constant text := '([0-9]+)[[:space:]]*tag(e|en)?\M';
  v_pct_start integer;
  v_pct_end integer;
  v_pct_value numeric;
  v_s integer;
  v_e integer;
  v_n integer := 1;
  v_start integer;
  v_end integer;
  v_from integer;
  v_days_value numeric;
  v_distance integer;
  v_best_days integer;
  v_best_distance integer;
begin
  /*
   * FC01A-NACHARBEIT (A4) -- Skontosatz und Skontofrist gehoeren zusammen; dieselbe
   * Lesart wie im Client (parseSkontoFromText). Die Frist ist die Tagesangabe im
   * selben Satz wie der (erste) Satz, nicht als Nettofrist gekennzeichnet ("30 Tage
   * netto", "ohne Abzug", "Zahlungsziel 30 Tage"), unter mehreren die naechstliegende.
   * Bisher galt die erste Tagesangabe nach dem Satz -- bei "Bei Zahlung innerhalb von
   * 10 Tagen 2 % Skonto, sonst 30 Tage netto" also 30 Tage, und eine verspaetete
   * Zahlung galt als fristgerechtes Skonto. Satzgrenzen: ! ? ; und Zeilenumbruch, ein
   * Punkt nur, wenn er nicht zwischen zwei Ziffern steht (Dezimalpunkt, Datum). Ohne
   * Satz und passende Frist (oder mit absurden Werten) gibt es kein Skonto -- nie
   * geraten.
   */
  v_len := length(v_text);
  v_pct_start := regexp_instr(v_text, v_pct_re);
  if v_pct_start = 0 then
    return;
  end if;
  v_pct_end := regexp_instr(v_text, v_pct_re, 1, 1, 1);
  v_pct_value := replace(regexp_substr(v_text, v_pct_re, 1, 1, '', 1), ',', '.')::numeric;
  if v_pct_value is null or v_pct_value <= 0 then
    return;
  end if;

  -- Der Satz um den Skontosatz: [v_s, v_e) in Zeichenpositionen.
  v_s := v_pct_start;
  while v_s > 1 and not (
    substr(v_text, v_s - 1, 1) in ('!', '?', ';', chr(10), chr(13))
    or (substr(v_text, v_s - 1, 1) = '.'
        and not (substr(v_text, v_s - 2, 1) ~ '[0-9]' and substr(v_text, v_s, 1) ~ '[0-9]'))
  ) loop
    v_s := v_s - 1;
  end loop;
  v_e := v_pct_end;
  while v_e <= v_len and not (
    substr(v_text, v_e, 1) in ('!', '?', ';', chr(10), chr(13))
    or (substr(v_text, v_e, 1) = '.'
        and not (substr(v_text, v_e - 1, 1) ~ '[0-9]' and substr(v_text, v_e + 1, 1) ~ '[0-9]'))
  ) loop
    v_e := v_e + 1;
  end loop;

  loop
    v_start := regexp_instr(v_text, v_days_re, 1, v_n, 0, 'i');
    exit when v_start = 0;
    v_end := regexp_instr(v_text, v_days_re, 1, v_n, 1, 'i');
    v_days_value := regexp_substr(v_text, v_days_re, 1, v_n, 'i', 1)::numeric;
    v_n := v_n + 1;
    -- Nur im selben Satz.
    continue when v_start < v_s or v_end > v_e;
    -- Keine Nettofrist: "30 Tage netto", "30 Tagen ohne Abzug", "Zahlungsziel 30 Tage".
    continue when substr(v_text, v_end, least(20, v_e - v_end))
      ~* '^[[:space:],:]*((rein[[:space:]]+)?netto\M|ohne[[:space:]]+((jeden|jeglichen)[[:space:]]+)?abzug)';
    v_from := greatest(v_s, v_start - 25);
    continue when substr(v_text, v_from, v_start - v_from)
      ~* '(zahlungsziel|netto(zahlungsziel)?)[[:space:]]*(:|von|innerhalb([[:space:]]+von)?|bis[[:space:]]+zu)?[[:space:]]*$';
    continue when v_days_value is null or v_days_value <= 0 or v_days_value > 3660;
    v_distance := case when v_end <= v_pct_start then v_pct_start - v_end else v_start - v_pct_end end;
    if v_best_distance is null or v_distance < v_best_distance then
      v_best_distance := v_distance;
      v_best_days := v_days_value::integer;
    end if;
  end loop;

  if v_best_days is null then
    return;
  end if;
  pct := v_pct_value;
  days := v_best_days;
  return next;
end;
$$;

revoke all on function public.workspace_skonto_terms(text) from public, anon, authenticated, service_role;

/* A2 -- keine Ruecknahme einer Abschlagszahlung hinter einer wirksamen Schlussrechnung */
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
  -- FC01A-NACHARBEIT (A2)
  v_vorgang_id text;
  v_invoice_type text;
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

  /*
   * FC01A-NACHARBEIT (A2) -- erst der Vorgang, dann die Rechnung: dieselbe Reihenfolge
   * wie Storno und Freigabe. So ist die Pruefung unten gegen eine gleichzeitige
   * Schlussrechnung serialisiert (deren Freigabe sperrt denselben Vorgang).
   */
  select wi.vorgang_id, wi.invoice_type
  into v_vorgang_id, v_invoice_type
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

  /*
   * FC01A-NACHARBEIT (A2) -- eine wirksame Schlussrechnung zieht diesen Abschlag als
   * beglichen ab (Paragraf 14 Abs. 5 Satz 2 UStG: vereinnahmte Teilentgelte) und hat
   * die Zahlung eingefroren. Wuerde die Zahlung danach zurueckgenommen, staende der
   * Abschlag wieder offen (mahnbar), waehrend die Schlussrechnung ihn als bezahlt
   * ausweist; eine E-Rechnung zur Schlussrechnung waere nicht mehr erzeugbar.
   * Deshalb wie beim Storno (SQL-01): zuerst die Schlussrechnung stornieren.
   */
  if v_vorgang_id is not null and v_invoice_type = 'abschlag' and exists (
    select 1
    from public.workspace_invoices s
    where s.workspace_id = p_workspace_id
      and s.vorgang_id = v_vorgang_id
      and s.invoice_type = 'schluss'
      and s.invoice_status in ('vorbereitet', 'versendet')
      and s.cancelled_at is null
      and exists (
        select 1
        from jsonb_array_elements(coalesce(s.payload->'previousAbschlagDeductions', '[]'::jsonb)) d
        where d.value->>'invoiceId' = v_invoice_id
      )
  ) then
    raise exception 'invoice_payment_reverse_final_invoice_exists';
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

revoke all on function public.reverse_workspace_invoice_payment(uuid, text, text) from public, anon;
grant execute on function public.reverse_workspace_invoice_payment(uuid, text, text) to authenticated;

/* A3 -- Abschlag und Schlussrechnung im selben Steuerfall */
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
    if exists (
      select 1
      from public.workspace_invoice_abschlag_deduction_rows(p_workspace_id, p_vorgang_id, p_client_invoice_id) r
      join public.workspace_invoices a
        on a.workspace_id = p_workspace_id
       and a.client_invoice_id = r.client_invoice_id
      left join lateral public.workspace_skonto_terms(a.payload->>'skontoText') s on true
      cross join lateral (
        select public.workspace_safe_date(
                 case when jsonb_typeof(a.payload->'issueDate') = 'string'
                      then a.payload->>'issueDate'
                      else a.payload->>'date' end
               ) + s.days as deadline
      ) f
      cross join lateral (
        select coalesce(sum(round(p.amount * 100)), 0) as paid_cents,
               coalesce(sum(round(p.amount * 100)) filter (where f.deadline is not null and p.paid_on <= f.deadline), 0) as timely_cents
        from public.workspace_invoice_payments p
        where p.workspace_id = p_workspace_id
          and p.client_invoice_id = r.client_invoice_id
          and p.reversed_at is null
      ) z
      where z.paid_cents < r.amount_cents
        and not (
          s.pct is not null and s.pct > 0 and s.pct < 100 and f.deadline is not null
          and z.timely_cents + 1 >= round(r.amount_cents * (100 - s.pct) / 100)
        )
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

revoke all on function public.assert_workspace_invoice_integrity(uuid, text, text, jsonb, boolean) from public, anon;
