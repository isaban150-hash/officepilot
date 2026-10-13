-- FINANZ-CORE-01A -- Angebote, Rechnungen, Zahlungen: Serververtraege.
--
-- NUR LOKAL angewendet. Remote ausschliesslich nach gesonderter Freigabe.
--
-- Jede geaenderte Funktion ist wortgleich aus ihrer neuesten Fassung
-- uebernommen; geaendert ist allein die mit "FINANZ-CORE-01A" markierte
-- Stelle. Keine GO-LIVE-SECURITY-01-Regel wird abgeschwaecht: Autorisierung,
-- Rollenpruefung und Kontosperre stehen unveraendert vor jeder neuen Pruefung.
-- `create or replace` behaelt die Rechte der bestehenden Funktionen; die zwei
-- neuen Funktionen setzen sie ausdruecklich (remote vergibt Standardrechte
-- anders als lokal).
--
--   cancel_workspace_invoice           (aus 20261023120000)
--       SQL-01  Nach wirksamer Schlussrechnung ist ein frueherer Beleg
--               desselben Vorgangs erst nach ihrem Storno stornierbar.
--       STO-05  Das Datum des Korrekturbelegs ist der Geschaeftstag
--               (Europe/Berlin), nicht der UTC-Tag.
--   finalize_workspace_invoice         (aus 20261102120000)
--       SQL-04  Nach wirksamer Schlussrechnung keine weitere Rechnung.
--       SQL-03  Nummernformat ohne Jahreszahl zaehlt jahresuebergreifend.
--   confirm_workspace_order_amendment  (aus 20261105120000)
--       SQL-06  Eine stornierte Schlussrechnung sperrt keinen Nachtrag.
--   assert_workspace_invoice_integrity (aus 20261006120000)
--       SQL-10  "unclear" auf keiner Rechnung; ein Auftrag mit "unclear"
--               gibt keinen Steuerstatus vor.
--       RE-04   Pauschalabschlag nur bis zum Rest nach allen wirksamen
--               Abschlaegen, Rechnungen und Teilrechnungen; nach einem
--               Pauschalabschlag keine "Rechnung" mehr (Schlussrechnung).
--       SQL-08  Nur die Rechnungsarten rechnung, abschlag, teilrechnung und
--               schluss; andere Schreibweisen umgingen typgebundene Regeln.
--   finalize_workspace_offer           (aus 20261105120000)
--       ANG-01  Angebotsfreigabe nur mit Steuerentscheidung.
--   workspace_invoice_sequence_floor   (neu, intern)
--   set_workspace_invoice_number_start (neu)
--       RE-02   Die Startnummer aus der Einrichtung erreicht den Server.
--
-- Fortsetzung (Fachabschluss, 2026-10-12):
--   cancel_workspace_invoice
--       SQL-11  Der Korrekturbeleg bekommt eine eigene fortlaufende Nummer aus
--               dem Rechnungskreis (Spalte correction_number, eindeutig).
--       SQL-07  Kein Storno waehrend eines laufenden E-Mail-Versands; kein
--               internes Storno bei unklarem Versandausgang.
--   claim_workspace_document_delivery_for_send (aus 20261010120000)
--       SQL-07  Sperrt die Rechnung und sendet keine stornierte Rechnung.
--       ANG-09  Sendet kein abgelehntes, storniertes oder ersetztes Angebot.
--   mark_workspace_document_delivery_accepted  (aus 20260915120000)
--       SQL-07  Keine stille Kopplung einer intern stornierten Rechnung.
--       AUS-15  Versanddatum als Geschaeftstag (Europe/Berlin).
--   add_workspace_invoice_payment (9 Argumente, ersetzt die 8-Argument-Fassung)
--       SQL-05  Ueberzahlung nur mit ausdruecklicher Bestaetigung.
--       SQL-15  Kein Zahlungsdatum in der Zukunft.
--   assert_workspace_invoice_integrity
--       RE-09   Aussteller mit Anschrift und Steuernummer/USt-IdNr.;
--               Empfaengeranschrift fuer jede Rechnungsart.
--       SQL-09  Zeilenbetrag auch im Auftragspfad, Abzuege als Menge,
--               Abschlagsnummer eindeutig, Pflichthinweis zum Steuerstatus,
--               Stammkunde wie im Auftrag.
--       SQL-12  Ueberabrechnung je Auftragsposition.
--       SQL-13  Abzuege groesser als brutto werden abgewiesen.
--       SQL-14  Kein Nullbeleg (Auftragsrechnung mit mindestens einer Menge).
--       SQL-15  Gueltiges Rechnungsdatum, nicht in der Zukunft; gueltiger
--               Leistungszeitraum.
--   finalize_workspace_offer
--       SQL-10  Summen muessen zu den Positionen passen.
--       ANG-15  Nummernjahr ohne Angebotsdatum als Geschaeftsjahr.
--   accept_workspace_offer / create_workspace_order / build_workspace_order_totals
--       ANG-15  Auftragsnummer im Jahr des Geschaeftstags.
--       SQL-10  Auftragssumme aus den Positionen, je Zeile mit Centpreis.
--   normalize_workspace_invoice_payload_for_idempotency
--       SQL-18  Versand- und Korrekturstand sind kein Belegtext.
--   create_workspace_document_delivery
--       ANG-09  Kein Versandauftrag fuer ein Angebot im Endzustand.
--   update_workspace_invoice_sent
--       SQL-15  Kein Versanddatum in der Zukunft.
--       AUS-19  Abweichender manueller Vermerk nach OfficeTakt-Versand = manuell.
--   set_workspace_invoice_number_format
--       SQL-16  Finanzautorisierung (Rolle, Kontosperre, Lizenz).
--   format_workspace_invoice_number(uuid, integer, integer)
--       SQL-16  Nur noch intern ausfuehrbar (schreibt das eingefrorene Format).
--   workspace_invoices
--       SQL-08  Werteliste der Rechnungsart, nur wenn der Bestand es zulaesst
--               (sonst NOTICE); bewusst kein Fremdschluessel der Zahlungen.
--   workspace_invoice_dunning_documentations
--       SQL-17  Versandweg, Datum und Rechnungsstand des Mahnnachweises.
--   link_workspace_bank_reconciliation (neu)
--       ZAH-03  Bankbewegung mit einer bereits erfassten, betragsgleichen Zahlung
--               verknuepfen -- ohne zweite Zahlung.
--
-- Nacharbeit nach der WEISS-Pruefung (2026-10-12):
--   add_workspace_invoice_payment / add_workspace_expense_payment
--       N03     Nur endliche, auf Cent gerundet positive Betraege (kein NaN,
--               kein Unendlich) -- auch mit Ueberzahlungsbestaetigung.
--   create_workspace_order
--       N03     Auch "Infinity" ist keine Menge und kein Preis.
--   assert_workspace_invoice_integrity
--       N02     Eine Schlussrechnung zieht nur beglichene Abschlaege ab
--               (invoice_abschlag_unpaid).
--
-- WEISS-Recheck (2026-10-12):
--   workspace_skonto_terms / workspace_safe_date (neu, intern)
--       N02-R2  Skontosatz und -frist aus dem Belegtext wie im Client.
--   assert_workspace_invoice_integrity
--       N02-R2  Skonto nur bei Zahlung bis zum Fristende.
--       N02-R1  Die eingefrorene Aufteilung je Abzug (gezahlt / Skonto) muss den
--               gebuchten Zahlungen entsprechen; fehlt sie bei einem nicht voll
--               bezahlten Abschlag, wird abgewiesen
--               (invoice_abschlag_settlement_mismatch).
--   validate_workspace_accounting_payload (aus 20261008120000)
--       N06     Bestaetigte Kontierung nur mit geklaerter Steuerbehandlung
--               (accounting_confirmed_without_tax).

/* 0 -- SQL-11: Eindeutigkeit der Korrekturnummer */
/*
 * FINANZ-CORE-01A (SQL-11) -- eine Korrekturnummer gehoert genau einem Beleg.
 * Altbestand traegt keine (null) und bleibt unberuehrt.
 */
create unique index if not exists workspace_invoices_correction_number_unique
  on public.workspace_invoices (workspace_id, correction_number)
  where correction_number is not null;

/* 1 -- SQL-01 / SQL-11 / SQL-07 */
create or replace function public.cancel_workspace_invoice(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_reason text
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_reason text;
  v_vorgang_id text;
  v_existing public.workspace_invoices;
  v_updated public.workspace_invoices;
  v_active_payments integer;
  v_now timestamptz := now();
  v_kind text;
  v_document_id text;
  v_document public.workspace_documents;
  v_payload jsonb;
  /* FINANZ-CORE-01A (SQL-11) -- die eigene Nummer des Korrekturbelegs. */
  v_correction_year integer;
  v_correction_locked integer;
  v_correction_sequence integer;
  v_correction_number text;
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

  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'invoice_cancel_reason_required';
  end if;

  /*
   * Lock-Reihenfolge Vorgang -> Rechnung -> Zahlungen, wie in allen
   * rechnungsschreibenden Funktionen. Der Auftragsbezug einer Rechnung ist
   * unveraenderlich; er darf deshalb ohne Sperre gelesen werden, bevor der
   * Vorgang gesperrt wird.
   *
   * 01B — ausdruecklich gekoppelt statt eines Joins, der bei NULL still keine
   * Zeile sperrt: Ohne Auftrag ist nur die normale Rechnung zulaessig, und es
   * gibt keinen Vorgang, an dem eine Serialisierung haengen koennte.
   */
  select wi.vorgang_id
  into v_vorgang_id
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = v_invoice_id;

  if not found then
    raise exception 'Rechnung nicht gefunden';
  end if;

  if v_vorgang_id is not null then
    perform 1
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;
  end if;

  select *
  into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  /*
   * Idempotenz vor jeder Pruefung: Ein zweiter Aufruf ist kein Ereignis.
   * Grund, Zeitpunkt, Art und Korrekturbeleg bleiben, wie sie waren — auch
   * bei abweichender zweiter Begruendung.
   */
  if v_existing.cancelled_at is not null then
    return next v_existing;
    return;
  end if;

  if v_existing.vorgang_id is null and v_existing.invoice_type is distinct from 'rechnung' then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  /*
   * TEILRECHNUNG-03C -- eine Teilrechnung ist eine echte Forderung ueber einen
   * abgegrenzten Teil der Auftragsleistung. Sie verbraucht Menge wie jede
   * Rechnung, also muss sie sich auch wie jede Rechnung zurueckholen lassen --
   * sonst bliebe ein Fehlbeleg dauerhaft stehen und seine Menge verbraucht.
   * Alles andere bleibt: Abschlaege sind hier weiterhin nicht vorgesehen, und
   * eine Rechnung ohne Auftrag (oben) bleibt auf 'rechnung' beschraenkt.
   */
  /*
   * RECHNUNGSBEREICH-03D -- auch die Abschlagsrechnung ist stornierbar.
   *
   * Sie ist eine echte Forderung: Der mengenbasierte Abschlag verbraucht
   * Auftragsmenge, der pauschale nimmt Geld vorweg, das die Schlussrechnung
   * abzieht. Bleibt ein Fehlbeleg stehen, bleibt beides verbraucht. Die
   * Wirkung des Stornos steht bereits: `isBillingEffective` (Client) und die
   * 03B/03B2-Funktionen lesen `cancelled_at`, also faellt ein stornierter
   * Abschlag ohne weiteres Zutun aus Menge **und** Abzug heraus. Hier fehlt
   * nur die Erlaubnis.
   *
   * Die Abschlagsnummer bleibt vergeben -- vergeben ist vergeben
   * (`getNextAbschlagNumber`); zwei Belege mit derselben Nummer darf es nie
   * geben.
   */
  if v_existing.invoice_type not in ('rechnung', 'teilrechnung', 'abschlag', 'schluss') then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  if v_existing.invoice_status not in ('vorbereitet', 'versendet') then
    raise exception 'invoice_cancel_not_finalized';
  end if;

  /*
   * FINANZ-CORE-01A (SQL-01) -- nach einer wirksamen Schlussrechnung ist jede
   * fruehere Rechnung desselben Vorgangs in ihr abgerechnet: Ein Pauschal-
   * abschlag steht als Abzug darin, ein mengenbasierter Abschlag, eine
   * Teilrechnung oder eine Rechnung hat Menge verbraucht, die die
   * Schlussrechnung nicht mehr berechnet. Wuerde der fruehere Beleg danach
   * storniert, waere die Schlussrechnung falsch -- zu viel abgezogen oder
   * Leistung nirgends mehr berechnet --, und ein neuer Beleg ist nach der
   * Schlussrechnung ausgeschlossen. Deshalb zuerst die Schlussrechnung
   * stornieren; danach ist der fruehere Beleg wieder stornierbar.
   *
   * Der Vorgang ist oben gesperrt; die Pruefung ist damit gegen eine
   * gleichzeitige Schlussrechnung serialisiert. Dieselbe Definition von
   * "wirksame Schlussrechnung" wie in finalize_workspace_invoice (01C/01D).
   */
  if v_existing.vorgang_id is not null and v_existing.invoice_type <> 'schluss' then
    if exists (
      select 1
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = v_existing.vorgang_id
        and wi.invoice_type = 'schluss'
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
    ) then
      raise exception 'invoice_cancel_final_invoice_exists';
    end if;
  end if;

  -- D1: aktive Zahlung -> keine Stornierung, nichts wird zurueckgebucht.
  select count(*)
  into v_active_payments
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = v_invoice_id
    and p.reversed_at is null;

  if coalesce(v_active_payments, 0) > 0 then
    raise exception 'invoice_cancel_has_active_payments';
  end if;

  v_kind := case when v_existing.invoice_status = 'versendet' then 'correction' else 'internal' end;

  /*
   * FINANZ-CORE-01A (SQL-07) -- kein Storno, waehrend die Rechnung per E-Mail
   * unterwegs ist.
   *
   * Der Versand sperrt die Rechnungszeile, bevor er seinen Auftrag auf
   * `sending` setzt (claim_workspace_document_delivery_for_send); dieser
   * Storno haelt dieselbe Sperre (oben). Beide sind damit serialisiert:
   * Entweder sieht der Storno den laufenden Versand, oder der Versand sieht
   * den Storno und sendet nicht.
   *
   *   sending -- der Provider-Aufruf laeuft, sein Ausgang steht gleich fest:
   *              erst danach stornieren (fuer beide Stornoarten).
   *   unknown -- ob der Kunde die Rechnung hat, ist offen. Ein internes Storno
   *              ohne Korrekturbeleg waere falsch, wenn sie angekommen ist
   *              (§ 14c UStG). Wer die Rechnung als versendet vermerkt,
   *              storniert danach mit Korrekturbeleg. Eine bereits versendete
   *              Rechnung bekommt ohnehin einen -- dort sperrt `unknown` nicht.
   *
   * `queued` sperrt nicht: Dieser Auftrag war sicher noch nicht beim
   * Provider, und der Claim weist eine stornierte Rechnung ab.
   */
  if exists (
    select 1
    from public.workspace_document_deliveries d
    where d.workspace_id = p_workspace_id
      and d.linked_invoice_id = v_invoice_id
      and d.document_kind = 'invoice'
      and d.status = 'sending'
  ) then
    raise exception 'invoice_cancel_delivery_in_progress';
  end if;
  if v_kind = 'internal' and exists (
    select 1
    from public.workspace_document_deliveries d
    where d.workspace_id = p_workspace_id
      and d.linked_invoice_id = v_invoice_id
      and d.document_kind = 'invoice'
      and d.status = 'unknown'
  ) then
    raise exception 'invoice_cancel_delivery_uncertain';
  end if;

  if v_kind = 'correction' then
    /*
     * D2/B — der Korrekturbeleg entsteht hier, in derselben Transaktion.
     * Deterministische Kennung: derselbe Retry trifft dieselbe Zeile.
     *
     * Der Payload ist ein selbstbeschreibender Datensatz. Er traegt den
     * finalen Original-Payload unveraendert als Snapshot; nichts wird hier
     * gerechnet. Ordner, Tags und Suchtext bildet der Client deterministisch.
     */
    v_document_id := 'corr-' || v_invoice_id;

    select *
    into v_document
    from public.workspace_documents d
    where d.workspace_id = p_workspace_id
      and d.client_document_id = v_document_id
    for update;

    if v_document.id is not null then
      if v_document.document_kind is distinct from 'generated_invoice_correction'
         or v_document.linked_invoice_id is distinct from v_invoice_id then
        raise exception 'Dokumentkonflikt: Kennung gehoert zu einem anderen Dokument';
      end if;
      if v_document.deleted_at is not null then
        raise exception 'Dokumentkonflikt: Korrekturbeleg wurde geloescht';
      end if;
      v_correction_number := nullif(trim(coalesce(v_document.payload->>'correctionNumber', '')), '');
    end if;

    if v_correction_number is null then
      /*
       * FINANZ-CORE-01A (SQL-11/RE-11) -- der Korrekturbeleg bekommt eine
       * eigene, fortlaufende Nummer aus dem Rechnungskreis (§ 14 Abs. 4 Nr. 4
       * UStG; GoBD: jeder Beleg eindeutig). Derselbe Kreis wie die Rechnungen:
       * Ein eigenes Korrekturformat gibt es im Produkt nicht, und ein zweiter
       * Kreis mit demselben Format erzeugte doppelte Nummern. Jahr, Sperre,
       * Untergrenze und Format genau wie in finalize_workspace_invoice; das
       * Jahr ist das des Korrekturdatums (Geschaeftstag, STO-05).
       *
       * Lock-Reihenfolge Vorgang -> Rechnung -> Jahreszeile. Die Freigabe nimmt
       * Vorgang -> Jahreszeile und sperrt danach keine bestehende Rechnung:
       * kein Verklemmen.
       */
      v_correction_year := extract(year from timezone('Europe/Berlin', v_now))::integer;

      insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
      values (p_workspace_id, v_correction_year, 0)
      on conflict (workspace_id, invoice_year) do nothing;

      select s.last_sequence
      into v_correction_locked
      from public.workspace_invoice_sequences s
      where s.workspace_id = p_workspace_id
        and s.invoice_year = v_correction_year
      for update;

      if v_correction_locked is null then
        raise exception 'Nummernkreis konnte nicht gesperrt werden';
      end if;

      v_correction_sequence := public.workspace_invoice_sequence_floor(p_workspace_id, v_correction_year, v_correction_locked) + 1;
      v_correction_number := public.format_workspace_invoice_number(p_workspace_id, v_correction_year, v_correction_sequence);

      /*
       * Eine Nummer gehoert genau einem Beleg -- auch nach einem Formatwechsel
       * oder einer gesetzten Startnummer. Eine Kollision ist ein benannter
       * Fehler, nie ein doppelter Beleg.
       */
      if exists (
        select 1
        from public.workspace_invoices wi
        where wi.workspace_id = p_workspace_id
          and (wi.invoice_number = v_correction_number or wi.correction_number = v_correction_number)
      ) then
        raise exception 'invoice_correction_number_conflict: %', v_correction_number;
      end if;

      update public.workspace_invoice_sequences
      set last_sequence = v_correction_sequence
      where workspace_id = p_workspace_id
        and invoice_year = v_correction_year
        and last_sequence = v_correction_locked;

      if not found then
        raise exception 'Nummernkreis konnte nicht erhöht werden';
      end if;

      if v_document.id is not null then
        update public.workspace_documents
        set payload = payload || jsonb_build_object(
              'correctionNumber', v_correction_number,
              'correctionSequenceNumber', v_correction_sequence
            ),
            row_version = row_version + 1,
            updated_at = v_now,
            updated_by = v_user_id
        where id = v_document.id
        returning * into v_document;
      end if;
    end if;

    if v_document.id is null then
      v_payload := jsonb_build_object(
        'id', v_document_id,
        'documentType', 'rechnungskorrektur',
        'correctionKind', 'storno',
        'correctionNumber', v_correction_number,
        'correctionSequenceNumber', v_correction_sequence,
        'category', 'ausgangsrechnung',
        'classifiedKind', 'rechnungskorrektur',
        'archived', true,
        'title', 'Rechnungskorrektur zu Rechnung ' || v_existing.invoice_number,
        'issuer', coalesce(v_existing.payload->'companySnapshot'->>'companyName', ''),
        'linkedInvoiceId', v_invoice_id,
        'linkedVorgangId', v_existing.vorgang_id,
        'originalClientInvoiceId', v_invoice_id,
        'originalInvoiceNumber', v_existing.invoice_number,
        'originalInvoiceType', v_existing.invoice_type,
        'originalIssueDate', coalesce(v_existing.payload->>'issueDate', v_existing.payload->>'date'),
        'cancelledAt', to_char(timezone('utc', v_now), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        -- FINANZ-CORE-01A (STO-05) -- der Geschaeftstag (Europe/Berlin), nicht der UTC-Tag.
        'correctionIssueDate', to_char(timezone('Europe/Berlin', v_now), 'YYYY-MM-DD'),
        'cancelReason', v_reason,
        'customerId', v_existing.payload->>'customerId',
        'companySnapshot', v_existing.payload->'companySnapshot',
        'customerSnapshot', v_existing.payload->'customerSnapshot',
        'servicePeriodFrom', v_existing.payload->>'servicePeriodFrom',
        'servicePeriodTo', v_existing.payload->>'servicePeriodTo',
        'taxStatus', v_existing.payload->>'taxStatus',
        'originalInvoiceSnapshot', v_existing.payload
      );

      insert into public.workspace_documents (
        workspace_id, client_document_id, document_kind,
        linked_invoice_id, linked_vorgang_id, payload, created_by, updated_by
      )
      values (
        p_workspace_id, v_document_id, 'generated_invoice_correction',
        v_invoice_id, v_existing.vorgang_id, v_payload, v_user_id, v_user_id
      )
      returning * into v_document;

      if v_document.id is null then
        raise exception 'Korrekturbeleg nicht angelegt';
      end if;
    end if;
  end if;

  /*
   * `invoice_status`, Nummer, Positionen, Betraege, Snapshots, Versandangaben,
   * Zahlungsdatensaetze und Archivhistorie bleiben unangetastet. Der
   * Payload-Spiegel dient aelteren Clients.
   */
  update public.workspace_invoices
  set cancelled_at = v_now,
      cancelled_by = v_user_id,
      cancel_reason = v_reason,
      cancellation_kind = v_kind,
      correction_document_id = v_document_id,
      -- FINANZ-CORE-01A (SQL-11) -- intern ohne Beleg: keine Nummer.
      correction_number = v_correction_number,
      payload = payload || jsonb_build_object(
        'cancelledAt', to_char(timezone('utc', v_now), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'cancelReason', v_reason
      ),
      row_version = row_version + 1,
      updated_at = v_now,
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.cancelled_at is null then
    raise exception 'Stornierung nicht angewendet';
  end if;

  if v_kind = 'correction' and v_updated.correction_document_id is null then
    raise exception 'Stornierung ohne Korrekturbeleg';
  end if;

  if v_kind = 'correction' and v_updated.correction_number is null then
    raise exception 'Stornierung ohne Korrekturnummer';
  end if;

  return next v_updated;
end;
$$;

/* 2 -- SQL-04 / SQL-03: zuerst die neue Hilfsfunktion, dann die Freigabe */
/*
 * FINANZ-CORE-01A (SQL-03) -- die Untergrenze des Nummernkreises.
 *
 * Mit Jahreszahl in der Nummer ist jedes Jahr ein eigener Kreis: Rueckgabe
 * unveraendert. Ohne Jahreszahl ist der Kreis jahresuebergreifend -- die Nummer
 * muss ueber allen bisher vergebenen Nummern gleichen Praefixes liegen, die
 * ebenfalls ohne Jahreszahl gebildet wurden. Massgeblich ist das Format, das
 * dieses Jahr traegt oder (beim ersten Beleg) gleich einfrieren wird.
 *
 * Nur aus finalize_workspace_invoice, nachdem die Jahreszeile gesperrt ist.
 * Die Transaktionssperre je Workspace serialisiert zwei gleichzeitige
 * Freigaben verschiedener Jahre; sie wird nach der Zeilensperre genommen und
 * haelt selbst keine weitere Zeilensperre an -- kein Verklemmen.
 */
create or replace function public.workspace_invoice_sequence_floor(
  p_workspace_id uuid,
  p_year integer,
  p_current integer
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_seq public.workspace_invoice_sequences;
  v_year_in_number boolean;
  v_prefix text;
  v_floor integer;
begin
  select * into v_seq
  from public.workspace_invoice_sequences
  where workspace_id = p_workspace_id and invoice_year = p_year;

  if v_seq.format_locked_at is not null then
    v_year_in_number := v_seq.year_in_number;
    v_prefix := v_seq.number_prefix;
  else
    select f.year_in_number, f.number_prefix
    into v_year_in_number, v_prefix
    from public.workspace_invoice_number_formats f
    where f.workspace_id = p_workspace_id;
  end if;
  v_year_in_number := coalesce(v_year_in_number, true);
  v_prefix := coalesce(v_prefix, '');

  if v_year_in_number then
    return p_current;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workspace_invoice_number_continuous:' || p_workspace_id::text, 0));

  select coalesce(max(s.last_sequence), 0)
  into v_floor
  from public.workspace_invoice_sequences s
  where s.workspace_id = p_workspace_id
    and s.invoice_year <> p_year
    and s.format_locked_at is not null
    and s.year_in_number = false
    and s.number_prefix = v_prefix;

  return greatest(coalesce(p_current, 0), v_floor);
end;
$$;

revoke all on function public.workspace_invoice_sequence_floor(uuid, integer, integer) from public, anon, authenticated, service_role;

create or replace function public.finalize_workspace_invoice(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb,
  /*
   * RECHNUNGSINTEGRITAET-03B -- die bewusste Entscheidung des Nutzers, ueber
   * den dokumentierten Rest hinaus abzurechnen. Sie ersetzt keine Pruefung:
   * Der Server stellt die Ueberschreitung weiterhin selbst fest und laesst sie
   * nur mit diesem Flag zu. Vorgabewert false -- wer nichts sagt, bestaetigt
   * nichts.
   */
  p_overbilling_acknowledged boolean default false,
  /*
   * CLOUD-SYNC S5 -- die Bindung an den Cloud-Entwurf. Beide Angaben gehoeren
   * zusammen: die Kennung des Entwurfs und die Version, auf der die Freigabe
   * vorbereitet wurde. Fehlen beide, bleibt alles wie bisher -- ein Altbestand
   * ohne Cloud-Entwurf.
   */
  p_client_draft_id text default null,
  p_expected_draft_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_year integer;
  v_next_sequence integer;
  /* FINANZ-CORE-01A (SQL-03) -- der gesperrte Stand der Jahreszeile. */
  v_locked_sequence integer;
  v_invoice_number text;
  v_invoice_type text;
  v_payload jsonb;
  v_normalized_incoming jsonb;
  v_normalized_existing jsonb;
  v_issue_date text;
  v_vorgang_id text;
  v_vorgang public.workspace_vorgaenge;
  v_current_amendment_sequence integer;
  v_expected_amendment_sequence integer;
  v_expected_camel jsonb;
  v_expected_snake jsonb;
  v_has_expected_camel boolean := false;
  v_has_expected_snake boolean := false;
  v_parsed_camel integer;
  v_parsed_snake integer;
  v_has_other_final boolean;
  /* CLOUD-SYNC S5 -- Entwurfsbindung. */
  v_draft public.workspace_invoice_drafts;
  v_draft_id text;
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

  -- 01B2b (b): NULL heisst „kein Auftrag", '' heisst „kaputt".
  if p_vorgang_id is not null and nullif(trim(p_vorgang_id), '') is null then
    raise exception 'vorgang_id fehlt';
  end if;
  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  if p_invoice is null or jsonb_typeof(p_invoice) <> 'object' then
    raise exception 'invoice payload fehlt';
  end if;

  if jsonb_typeof(coalesce(p_invoice->'positions', 'null'::jsonb)) <> 'array' then
    raise exception 'invoice positions fehlen';
  end if;

  v_invoice_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  if v_invoice_type is null then
    raise exception 'invoice type fehlt';
  end if;

  /*
   * 01B2b (a) — der eine Zweig. Links die Rechnung ohne Auftrag, rechts der
   * unveraenderte Auftragspfad mit dem gemeinsamen Lock.
   */
  if v_vorgang_id is null then
    if v_invoice_type <> 'rechnung' then
      raise exception 'invoice_requires_vorgang_for_type';
    end if;
  else
    -- Shared lock with confirm_workspace_order_amendment (first).
    select *
    into v_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;

    if not found or v_vorgang.deleted then
      raise exception 'Vorgang gehört nicht zum Workspace oder existiert nicht';
    end if;
  end if;

  /*
   * 01B2b-R1 — Laufzeitfund auf lokaler PostgreSQL: Der erste Lauf speichert
   * den Payload mit serverseitig kanonisiertem `date`/`issueDate`/`type`; der
   * Replay-Kandidat wurde bisher nur um `id`/`status` ergaenzt. Schickt der
   * Client kein `date`, fehlt es im Kandidaten, und ein bytegleicher zweiter
   * Aufruf scheiterte als „abweichender Rechnungsinhalt". Derselbe Fehler
   * steckt in jeder Vorgaengerfassung seit 03A.
   *
   * Der Kandidat wird deshalb mit derselben Ergaenzung gebildet wie der
   * Insert — seit R2 in `workspace_invoice_replay_candidate`, weil er fuer
   * einen datumslosen Request das Datum der gespeicherten Zeile braucht. Die
   * Insert-Regel hier bleibt: `issueDate` vor `date` vor UTC-heute. `date`
   * bleibt Teil der Invariante — ein anderes Rechnungsdatum ist eine andere
   * Rechnung.
   */
  v_issue_date := coalesce(
    nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''),
    nullif(trim(coalesce(p_invoice->>'date', '')), ''),
    to_char(timezone('utc', now()), 'YYYY-MM-DD')
  );
  begin
    v_year := extract(year from v_issue_date::date)::integer;
  exception
    when others then
      v_year := extract(year from timezone('utc', now()))::integer;
  end;

  /*
   * 01B2b-R2 — der Replay-Kandidat entsteht in beiden Replay-Ausgaengen ueber
   * `workspace_invoice_replay_candidate`, weil er die gespeicherte Zeile
   * kennen muss: Ein datumsloser Request bekommt sein Datum von ihr, nicht
   * vom heutigen Tag. Hier steht deshalb keine zweite Definition.
   */

  select *
  into v_existing
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id)
  for update;

  if found then
    /*
     * 01B2b (c) — kein stilles Umhaengen. Die Rechnungsidentitaet bleibt
     * `workspace_id + client_invoice_id`; der Auftragsbezug ist eine
     * zusaetzliche Replay-Invariante und wandert nicht in den Payload.
     */
    if v_existing.vorgang_id is distinct from v_vorgang_id then
      raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
    end if;

    v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
    v_normalized_incoming := public.workspace_invoice_replay_candidate(
      p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
    );
    if v_normalized_existing is distinct from v_normalized_incoming then
      raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'invoice', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  /*
   * CLOUD-SYNC S5 -- Bindung an den Cloud-Entwurf.
   *
   * Steht bewusst NACH dem Idempotenz-Replay: Eine Wiederholung derselben
   * `client_invoice_id` bekommt ihren bestehenden Erfolg zurueck, auch wenn
   * der Entwurf inzwischen finalisiert ist -- durch eben diese Rechnung.
   *
   * Und VOR jeder Rechnungspruefung, der Nummernvergabe und dem Insert: Der
   * Entwurf wird gesperrt und muss genau in der vorbereiteten Version aktiv
   * sein. Ein zweites Geraet, das denselben Entwurf mit einer eigenen
   * `client_invoice_id` freigeben will, wartet an dieser Sperre und findet
   * danach `finalized` vor -- es entsteht keine zweite Rechnung und keine
   * zweite Nummer. Jede Ablehnung hier rollt die ganze Transaktion zurueck:
   * Es wurde nichts geschrieben und keine Nummer verbraucht.
   */
  v_draft_id := nullif(trim(coalesce(p_client_draft_id, '')), '');
  if (p_client_draft_id is not null and v_draft_id is null)
     or ((v_draft_id is null) <> (p_expected_draft_row_version is null))
     or coalesce(p_expected_draft_row_version, 1) < 1 then
    raise exception 'invoice_draft_binding_invalid';
  end if;

  if v_draft_id is not null then
    select d.*
    into v_draft
    from public.workspace_invoice_drafts d
    where d.workspace_id = p_workspace_id
      and d.client_draft_id = v_draft_id
    for update;

    if not found then
      raise exception 'invoice_draft_not_found';
    end if;

    if v_draft.status = 'finalized' then
      /*
       * Gleichzeitige Wiederholung derselben Kennung: Der Replay oben lief,
       * bevor der erste Aufruf festgeschrieben war; die Sperre hat bis dahin
       * gewartet. Das ist der eigene Erfolg und wird genau wie ein Replay
       * beantwortet -- mit denselben Invarianten.
       */
      if v_draft.finalized_client_invoice_id = trim(p_client_invoice_id) then
        select *
        into v_existing
        from public.workspace_invoices wi
        where wi.workspace_id = p_workspace_id
          and wi.client_invoice_id = trim(p_client_invoice_id);

        if not found then
          raise exception 'invoice_draft_already_finalized:%', v_draft.finalized_client_invoice_id;
        end if;

        if v_existing.vorgang_id is distinct from v_vorgang_id then
          raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
        end if;

        v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
        v_normalized_incoming := public.workspace_invoice_replay_candidate(
          p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
        );
        if v_normalized_existing is distinct from v_normalized_incoming then
          raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
        end if;

        return jsonb_build_object(
          'idempotent_replay', true,
          'invoice', v_existing.payload,
          'row', to_jsonb(v_existing)
        );
      end if;

      -- Ein anderes Geraet hat diesen Entwurf bereits zur Rechnung gemacht.
      raise exception 'invoice_draft_already_finalized:%', v_draft.finalized_client_invoice_id;
    end if;

    if v_draft.deleted then
      raise exception 'invoice_draft_discarded';
    end if;

    if v_draft.vorgang_id is distinct from v_vorgang_id or v_draft.invoice_type <> v_invoice_type then
      raise exception 'invoice_draft_slot_mismatch';
    end if;

    if v_draft.row_version <> p_expected_draft_row_version then
      raise exception 'invoice_draft_version_conflict:%', v_draft.row_version;
    end if;
  end if;

  /*
   * 01D — Single-Final-Invoice-Guard.
   *
   * Steht bewusst **nach** dem Idempotenz-Replay: Ein Wiederholungslauf nach
   * verlorener Antwort traegt dieselbe `client_invoice_id` und muss den
   * bestehenden Erfolg zurueckbekommen, nicht diesen Fehler. Die eigene
   * Kennung ist deshalb ausdruecklich ausgenommen.
   *
   * Der Vorgang ist an dieser Stelle bereits gesperrt; die Pruefung ist damit
   * gegen parallele Transaktionen desselben Vorgangs serialisiert. Ohne
   * Vorgang wird dieser Zweig nie betreten — `schluss` ist dort abgewiesen.
   *
   * 01C — `cancelled_at is null`: Eine stornierte Schlussrechnung bleibt
   * historisch stehen, blockiert aber die notwendige Ersatzrechnung nicht
   * mehr. Der partielle Unique-Index traegt dieselbe Bedingung; beide
   * Definitionen von „wirksame Schlussrechnung" duerfen nie auseinanderlaufen.
   */
  if v_invoice_type = 'schluss' then
    select exists (
      select 1
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = v_vorgang_id
        and wi.invoice_type = 'schluss'
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
        and wi.client_invoice_id <> trim(p_client_invoice_id)
    )
    into v_has_other_final;

    if coalesce(v_has_other_final, false) then
      raise exception 'invoice_final_already_exists';
    end if;
  end if;

  /*
   * FINANZ-CORE-01A (SQL-04) -- nach einer wirksamen Schlussrechnung entsteht
   * fuer diesen Vorgang keine weitere Rechnung. Die Oberflaeche bietet das
   * nicht an; ein Geraet mit veraltetem Stand kennt die Schlussrechnung aber
   * womoeglich noch nicht. Ein weiterer Abschlag wuerde von keiner
   * Schlussrechnung mehr abgezogen, eine weitere Teilrechnung berechnete
   * Leistung neben der Schlussabrechnung.
   *
   * Wie der 01D-Guard nach dem Idempotenz-Replay (eine Wiederholung bekommt
   * ihren Erfolg) und vor jeder Nummernvergabe; der Vorgang ist gesperrt.
   * Nach einem Storno der Schlussrechnung ist wieder alles erlaubt (01C).
   */
  if v_vorgang_id is not null and v_invoice_type <> 'schluss' then
    if exists (
      select 1
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = v_vorgang_id
        and wi.invoice_type = 'schluss'
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
        and wi.client_invoice_id <> trim(p_client_invoice_id)
    ) then
      raise exception 'invoice_after_final_invoice';
    end if;
  end if;

  -- New Schluss only: amendment revision must match client expectation (default 0).
  -- Meta fields must agree when both are present; invalid values → invoice_amendment_state_stale.
  -- Runs after idempotent replay and before sequence lock / invoice insert.
  if v_invoice_type = 'schluss' then
    select coalesce(max(a.sequence_no), 0)
    into v_current_amendment_sequence
    from public.workspace_order_amendments a
    where a.workspace_id = p_workspace_id
      and a.vorgang_id = v_vorgang_id;

    v_has_expected_camel :=
      (p_invoice ? 'expectedAmendmentSequence')
      and jsonb_typeof(p_invoice->'expectedAmendmentSequence') is distinct from 'null';
    v_has_expected_snake :=
      (p_invoice ? 'expected_amendment_sequence')
      and jsonb_typeof(p_invoice->'expected_amendment_sequence') is distinct from 'null';

    if v_has_expected_camel then
      v_expected_camel := p_invoice->'expectedAmendmentSequence';
      if jsonb_typeof(v_expected_camel) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_camel::text)::numeric < 0
         or (v_expected_camel::text)::numeric <> trunc((v_expected_camel::text)::numeric)
         or (v_expected_camel::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_camel := ((v_expected_camel::text)::numeric)::integer;
    end if;

    if v_has_expected_snake then
      v_expected_snake := p_invoice->'expected_amendment_sequence';
      if jsonb_typeof(v_expected_snake) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_snake::text)::numeric < 0
         or (v_expected_snake::text)::numeric <> trunc((v_expected_snake::text)::numeric)
         or (v_expected_snake::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_snake := ((v_expected_snake::text)::numeric)::integer;
    end if;

    if v_has_expected_camel and v_has_expected_snake then
      if v_parsed_camel is distinct from v_parsed_snake then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_camel then
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_snake then
      v_expected_amendment_sequence := v_parsed_snake;
    else
      v_expected_amendment_sequence := 0;
    end if;

    if v_current_amendment_sequence is distinct from v_expected_amendment_sequence then
      raise exception 'invoice_amendment_state_stale';
    end if;
  end if;

  /*
   * RECHNUNGSINTEGRITAET-03B -- ab hier entsteht eine **neue** Rechnung.
   *
   * Der Vorgang ist oben bereits mit `for update` gesperrt; die Pruefung liest
   * den Abrechnungsstand in derselben Transaktion und ist damit gegen ein
   * zweites Geraet serialisiert. Ein Replay ist oben schon zurueckgekehrt.
   */
  perform public.assert_workspace_invoice_integrity(
    p_workspace_id,
    v_vorgang_id,
    trim(p_client_invoice_id),
    p_invoice,
    coalesce(p_overbilling_acknowledged, false)
  );

  -- 01B2b-R1: v_issue_date und v_year sind oben, vor dem Replay, abgeleitet.

  /*
   * Ein gemeinsamer Nummernkreis fuer alle Rechnungen eines Workspace-Jahres.
   * Er kennt den Vorgang nicht und darf ihn nie kennenlernen — eine freie
   * Rechnung zaehlt genauso mit wie eine auftragsgebundene.
   */
  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select s.last_sequence
  into v_next_sequence
  from public.workspace_invoice_sequences s
  where s.workspace_id = p_workspace_id
    and s.invoice_year = v_year
  for update;

  if v_next_sequence is null then
    raise exception 'Nummernkreis konnte nicht gesperrt werden';
  end if;

  /*
   * FINANZ-CORE-01A (SQL-03) -- ein Format ohne Jahreszahl zaehlt
   * jahresuebergreifend weiter. Bisher begann jedes Jahr bei 1, und "RE-0001"
   * des Folgejahres kollidierte mit "RE-0001" des Vorjahres: Jede Freigabe
   * scheiterte dauerhaft am Unique-Index. Mit Jahreszahl bleibt alles wie
   * bisher.
   */
  v_locked_sequence := v_next_sequence;
  v_next_sequence := public.workspace_invoice_sequence_floor(p_workspace_id, v_year, v_next_sequence);
  v_next_sequence := v_next_sequence + 1;
  /*
   * FIRMENPROFIL-01C -- Format des Nummernkreises: beim ersten Vergeben eines
   * Jahres wird das Workspace-Standardformat auf der (hier bereits gesperrten)
   * Sequenzzeile eingefroren; danach zaehlt nur noch die eingefrorene Kopie.
   */
  v_invoice_number := public.format_workspace_invoice_number(p_workspace_id, v_year, v_next_sequence);

  v_payload := public.normalize_workspace_invoice_payload_for_idempotency(p_invoice)
    || jsonb_build_object(
      'id', trim(p_client_invoice_id),
      'number', v_invoice_number,
      'invoiceSequenceNumber', v_next_sequence,
      'type', v_invoice_type,
      'status', 'vorbereitet',
      'date', v_issue_date,
      'issueDate', coalesce(nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''), v_issue_date)
    );

  begin
    insert into public.workspace_invoices (
      workspace_id,
      vorgang_id,
      client_invoice_id,
      invoice_number,
      invoice_year,
      invoice_sequence_number,
      invoice_type,
      invoice_status,
      payload,
      row_version,
      updated_by
    )
    values (
      p_workspace_id,
      v_vorgang_id,
      trim(p_client_invoice_id),
      v_invoice_number,
      v_year,
      v_next_sequence,
      v_invoice_type,
      'vorbereitet',
      v_payload,
      1,
      v_user_id
    )
    returning * into v_existing;
  exception
    when unique_violation then
      select *
      into v_existing
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.client_invoice_id = trim(p_client_invoice_id);

      if not found then
        /*
         * 01D — Backstop des partiellen Unique-Index.
         *
         * Die eigene Kennung existiert nicht, trotzdem kollidierte der Insert:
         * Bei einer Schlussrechnung kann das nur die Single-Final-Invariante
         * sein. Statt einer rohen Constraint-Meldung derselbe benennbare
         * Fehler wie oben — sonst waere der Race-Ausgang fuer den Aufrufer
         * ununterscheidbar von einem beliebigen Datenbankfehler.
         */
        if v_invoice_type = 'schluss' then
          raise exception 'invoice_final_already_exists';
        end if;
        raise;
      end if;

      -- 01B2b (c) — dieselbe Replay-Invariante auch im Race-Ausgang.
      if v_existing.vorgang_id is distinct from v_vorgang_id then
        raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
      end if;

      -- 01B2b-R2: dieselbe Kandidatenfunktion wie im regulaeren Replay.
      v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
      v_normalized_incoming := public.workspace_invoice_replay_candidate(
        p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
      );
      if v_normalized_existing is distinct from v_normalized_incoming then
        raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
      end if;

      return jsonb_build_object(
        'idempotent_replay', true,
        'invoice', v_existing.payload,
        'row', to_jsonb(v_existing)
      );
  end;

  update public.workspace_invoice_sequences
  set last_sequence = v_next_sequence
  where workspace_id = p_workspace_id
    and invoice_year = v_year
    and last_sequence = v_locked_sequence;

  if not found then
    raise exception 'Nummernkreis konnte nicht erhöht werden';
  end if;

  /*
   * CLOUD-SYNC S5 -- der Entwurf wird in derselben Transaktion verbraucht.
   * Es gibt keinen Zwischenstand, in dem die Rechnung existiert und der
   * Entwurf noch aktiv ist. Scheitert das, rollt die ganze Freigabe zurueck.
   */
  if v_draft_id is not null then
    update public.workspace_invoice_drafts
    set
      status = 'finalized',
      finalized_client_invoice_id = trim(p_client_invoice_id),
      row_version = row_version + 1,
      updated_by = v_user_id
    where workspace_id = p_workspace_id
      and client_draft_id = v_draft_id
      and status = 'active'
      and not deleted
      and row_version = p_expected_draft_row_version;

    if not found then
      raise exception 'invoice_draft_consume_failed';
    end if;
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'invoice', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

/* 3 -- SQL-06 */
create or replace function public.confirm_workspace_order_amendment(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_amendment_id text,
  p_amendment jsonb,
  p_source_draft_id text default null,
  p_expected_draft_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_vorgang public.workspace_vorgaenge;
  v_existing public.workspace_order_amendments;
  v_vorgang_id text;
  v_client_id text;
  v_title text;
  v_reason text;
  v_positions jsonb;
  v_normalized_positions jsonb := '[]'::jsonb;
  v_canonical jsonb;
  v_fingerprint text;
  v_contract jsonb;
  v_snapshot_positions jsonb;
  v_snapshot_ids text[] := array[]::text[];
  v_existing_ids text[] := array[]::text[];
  v_seen_ids text[] := array[]::text[];
  v_pos jsonb;
  v_pos_id text;
  v_change_type text;
  v_parent_id text;
  v_description text;
  v_unit text;
  v_unit_label text;
  v_category text;
  v_planned_quantity numeric;
  v_unit_price numeric;
  v_billable boolean;
  v_normalized_pos jsonb;
  v_next_sequence integer;
  v_has_final_schluss boolean;
  v_has_existing boolean := false;
  v_allowed_units text[] := array['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
  i integer;
  -- CLOUD-SYNC S6: nur fuer die Entwurfsbindung.
  v_source_draft_id text;
  v_amend_draft public.workspace_order_amendment_drafts;
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
   * GO-LIVE-SECURITY-01 — Produktentscheidung vom 2026-10-09: Mitglieder
   * bereiten Nachträge vor (order_amendment_draft, unverändert). Die
   * verbindliche Bestätigung geben nur Inhaber und Admin, wie die
   * Auftragsanlage (create_workspace_order). Fehlercode 42501: Der Client
   * stuft das als endgültig ein und sperrt keinen Entwurf.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');
  if v_vorgang_id is null then
    raise exception 'order_amendment_vorgang_not_found';
  end if;

  v_client_id := nullif(trim(coalesce(p_client_amendment_id, '')), '');
  if v_client_id is null then
    raise exception 'order_amendment_invalid_position';
  end if;

  if p_amendment is null or jsonb_typeof(p_amendment) <> 'object' then
    raise exception 'order_amendment_invalid_position';
  end if;

  -- Lock order: workspace_vorgaenge first (shared with finalize_workspace_invoice).
  select *
  into v_vorgang
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id
    and v.vorgang_id = v_vorgang_id
  for update;

  if not found or v_vorgang.deleted then
    raise exception 'order_amendment_vorgang_not_found';
  end if;

  v_contract := v_vorgang.payload->'contractConfirmation';
  if v_contract is null or jsonb_typeof(v_contract) <> 'object' then
    raise exception 'order_amendment_contract_confirmation_missing';
  end if;

  v_snapshot_positions := coalesce(v_contract->'positions', '[]'::jsonb);
  if jsonb_typeof(v_snapshot_positions) <> 'array' then
    raise exception 'order_amendment_contract_confirmation_missing';
  end if;

  select coalesce(array_agg(nullif(trim(p->>'id'), '')), array[]::text[])
  into v_snapshot_ids
  from jsonb_array_elements(v_snapshot_positions) as p
  where nullif(trim(p->>'id'), '') is not null;

  /*
   * CLOUD-SYNC S6 -- die Bindung an den Cloud-Nachtragsentwurf.
   *
   * Sperrreihenfolge wie bisher, nur verlaengert: zuerst der Vorgang (oben,
   * gemeinsam mit finalize_workspace_invoice), dann der Entwurf, dann die
   * Nachtragszeile. finalize_workspace_invoice beruehrt keinen
   * Nachtragsentwurf; das Speichern eines Nachtragsentwurfs sperrt nur dessen
   * eigene Zeile und liest den Vorgang ohne Sperre. Es entsteht keine
   * Sperrkette.
   */
  v_source_draft_id := nullif(trim(coalesce(p_source_draft_id, '')), '');
  if (p_source_draft_id is not null and v_source_draft_id is null)
     or ((v_source_draft_id is null) <> (p_expected_draft_row_version is null))
     or coalesce(p_expected_draft_row_version, 1) < 1 then
    raise exception 'order_amendment_draft_binding_invalid';
  end if;

  if v_source_draft_id is not null then
    select d.* into v_amend_draft
    from public.workspace_order_amendment_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_source_draft_id
    for update;
    if not found then
      raise exception 'order_amendment_draft_not_found';
    end if;
    if v_amend_draft.vorgang_id is distinct from v_vorgang_id then
      raise exception 'order_amendment_draft_binding_invalid';
    end if;
    if v_amend_draft.deleted then
      raise exception 'order_amendment_draft_discarded';
    end if;
    if v_amend_draft.status = 'consumed' then
      /*
       * Nur der eigene Verbrauch ist eine Wiederholung: derselbe Nachtrag und
       * genau die gebundene Version (+ 1). Alles andere -- ein anderes Geraet
       * mit eigener Kennung, eine andere Version -- ist kein Erfolg.
       */
      if v_amend_draft.consumed_client_amendment_id is distinct from v_client_id
         or v_amend_draft.row_version <> p_expected_draft_row_version + 1 then
        raise exception 'order_amendment_draft_already_consumed';
      end if;
    elsif v_amend_draft.row_version <> p_expected_draft_row_version then
      raise exception 'order_amendment_draft_version_conflict:%', v_amend_draft.row_version;
    end if;
  end if;

  -- Lock existing row early (idempotency before schluss guard).
  select *
  into v_existing
  from public.workspace_order_amendments a
  where a.workspace_id = p_workspace_id
    and a.client_amendment_id = v_client_id
  for update;
  v_has_existing := found;

  v_title := nullif(trim(coalesce(p_amendment->>'title', '')), '');
  v_reason := nullif(trim(coalesce(p_amendment->>'reason', '')), '');
  v_positions := p_amendment->'positions';

  if v_title is null then
    raise exception 'order_amendment_invalid_position';
  end if;
  if v_positions is null or jsonb_typeof(v_positions) <> 'array' or jsonb_array_length(v_positions) < 1 then
    raise exception 'order_amendment_invalid_position';
  end if;

  for i in 0 .. jsonb_array_length(v_positions) - 1 loop
    v_pos := v_positions->i;
    if v_pos is null or jsonb_typeof(v_pos) <> 'object' then
      raise exception 'order_amendment_invalid_position';
    end if;

    v_pos_id := nullif(trim(coalesce(v_pos->>'id', '')), '');
    v_change_type := nullif(trim(coalesce(v_pos->>'changeType', '')), '');
    v_parent_id := nullif(trim(coalesce(v_pos->>'parentPositionId', '')), '');
    v_description := nullif(trim(coalesce(v_pos->>'description', '')), '');
    v_unit := nullif(trim(coalesce(v_pos->>'unit', '')), '');
    v_unit_label := nullif(trim(coalesce(v_pos->>'unitLabel', '')), '');
    v_category := nullif(trim(coalesce(v_pos->>'category', '')), '');

    if v_pos_id is null or v_change_type is null or v_description is null or v_unit is null then
      raise exception 'order_amendment_invalid_position';
    end if;

    if v_change_type not in ('add', 'quantity_increase') then
      raise exception 'order_amendment_invalid_position';
    end if;

    if not (v_unit = any (v_allowed_units)) then
      raise exception 'order_amendment_invalid_position';
    end if;

    begin
      v_planned_quantity := (v_pos->>'plannedQuantity')::numeric;
    exception
      when others then
        raise exception 'order_amendment_invalid_position';
    end;
    if v_planned_quantity is null
       or v_planned_quantity <= 0
       or v_planned_quantity = 'NaN'::numeric
       or v_planned_quantity = 'Infinity'::numeric
       or v_planned_quantity = '-Infinity'::numeric then
      raise exception 'order_amendment_invalid_position';
    end if;

    begin
      v_unit_price := (v_pos->>'unitPrice')::numeric;
    exception
      when others then
        raise exception 'order_amendment_invalid_position';
    end;
    if v_unit_price is null
       or v_unit_price < 0
       or v_unit_price = 'NaN'::numeric
       or v_unit_price = 'Infinity'::numeric
       or v_unit_price = '-Infinity'::numeric then
      raise exception 'order_amendment_invalid_position';
    end if;

    if v_pos ? 'billable' and jsonb_typeof(v_pos->'billable') = 'boolean' then
      v_billable := (v_pos->>'billable')::boolean;
    else
      v_billable := null;
    end if;

    -- 01A rules: add forbids parentPositionId; quantity_increase requires parent in Hauptsnapshot.
    -- unit/category/billable are NOT required to match parent (01A only prefills, does not enforce).
    if v_change_type = 'add' then
      if v_parent_id is not null then
        raise exception 'order_amendment_invalid_position';
      end if;
    elsif v_change_type = 'quantity_increase' then
      if v_parent_id is null then
        raise exception 'order_amendment_parent_position_not_found';
      end if;
      if not (v_parent_id = any (v_snapshot_ids)) then
        raise exception 'order_amendment_parent_position_not_found';
      end if;
    end if;

    if v_pos_id = any (v_seen_ids) then
      raise exception 'order_amendment_position_id_conflict';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_pos_id);

    v_normalized_pos := jsonb_build_object(
      'id', v_pos_id,
      'changeType', v_change_type,
      'parentPositionId', to_jsonb(v_parent_id),
      'description', v_description,
      'plannedQuantity', v_planned_quantity,
      'unit', v_unit,
      'unitLabel', to_jsonb(v_unit_label),
      'unitPrice', v_unit_price,
      'category', to_jsonb(v_category),
      'billable', to_jsonb(v_billable)
    );
    v_normalized_positions := v_normalized_positions || jsonb_build_array(v_normalized_pos);
  end loop;

  v_canonical := public.build_workspace_order_amendment_canonical_content(
    v_vorgang_id,
    v_title,
    v_reason,
    v_normalized_positions
  );
  v_fingerprint := public.fingerprint_workspace_order_amendment_canonical(v_canonical);

  -- Idempotency before schluss guard (retry after lost response + later schluss).
  if v_has_existing then
    if v_existing.vorgang_id is distinct from v_vorgang_id
       or v_existing.content_fingerprint is distinct from v_fingerprint then
      raise exception 'order_amendment_idempotency_conflict';
    end if;

    /*
     * CLOUD-SYNC S6 -- gebundene Wiederholung. Ist der Entwurf noch aktiv,
     * lief die erste Bestaetigung ohne Bindung; der Verbrauch wird jetzt in
     * genau der gebundenen Version nachgeholt. Inhalt (Fingerprint, oben
     * geprueft) und Entwurfsversion stimmen dann nachweislich ueberein.
     */
    if v_source_draft_id is not null and v_amend_draft.status = 'active' then
      update public.workspace_order_amendment_drafts
      set
        status = 'consumed',
        consumed_client_amendment_id = v_client_id,
        payload = '{}'::jsonb,
        row_version = row_version + 1,
        updated_by = v_user_id
      where workspace_id = p_workspace_id and client_draft_id = v_source_draft_id
        and status = 'active' and not deleted
        and row_version = p_expected_draft_row_version;
      if not found then
        raise exception 'order_amendment_draft_consume_failed';
      end if;
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'amendment', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  -- Final Schlussrechnung blocks NEW confirms only (after idempotency).
  select exists (
    select 1
    from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id
      and wi.vorgang_id = v_vorgang_id
      and wi.invoice_type = 'schluss'
      and wi.invoice_status in ('vorbereitet', 'versendet')
      /*
       * FINANZ-CORE-01A (SQL-06) -- eine stornierte Schlussrechnung schliesst
       * den Auftrag nicht ab. Ohne diese Bedingung blieb nach dem Storno jeder
       * Nachtrag gesperrt, obwohl genau dann die Ersatzrechnung folgt.
       */
      and wi.cancelled_at is null
  )
  into v_has_final_schluss;

  if coalesce(v_has_final_schluss, false) then
    raise exception 'order_amendment_final_invoice_exists';
  end if;

  -- Position id collisions against snapshot + previously confirmed amendments.
  select coalesce(array_agg(distinct nullif(trim(pos->>'id'), '')), array[]::text[])
  into v_existing_ids
  from public.workspace_order_amendments a
  cross join lateral jsonb_array_elements(coalesce(a.payload->'positions', '[]'::jsonb)) as pos
  where a.workspace_id = p_workspace_id
    and a.vorgang_id = v_vorgang_id
    and nullif(trim(pos->>'id'), '') is not null;

  for i in 1 .. coalesce(array_length(v_seen_ids, 1), 0) loop
    if v_seen_ids[i] = any (v_snapshot_ids) or v_seen_ids[i] = any (v_existing_ids) then
      raise exception 'order_amendment_position_id_conflict';
    end if;
  end loop;

  select coalesce(max(a.sequence_no), 0) + 1
  into v_next_sequence
  from public.workspace_order_amendments a
  where a.workspace_id = p_workspace_id
    and a.vorgang_id = v_vorgang_id;

  insert into public.workspace_order_amendments (
    workspace_id,
    vorgang_id,
    client_amendment_id,
    sequence_no,
    status,
    content_fingerprint,
    payload,
    confirmed_at,
    confirmed_by,
    row_version
  )
  values (
    p_workspace_id,
    v_vorgang_id,
    v_client_id,
    v_next_sequence,
    'bestaetigt',
    v_fingerprint,
    jsonb_build_object(
      'title', v_title,
      'reason', to_jsonb(v_reason),
      'positions', v_normalized_positions,
      'clientAmendmentId', v_client_id,
      'vorgangId', v_vorgang_id,
      'sequenceNo', v_next_sequence
    ) || case when v_source_draft_id is not null
           then jsonb_build_object('sourceDraftId', v_source_draft_id)
           else '{}'::jsonb end,
    timezone('utc', now()),
    v_user_id,
    1
  )
  returning * into v_existing;

  /*
   * CLOUD-SYNC S6 -- der Entwurf wird in derselben Transaktion verbraucht: Es
   * gibt keinen Zwischenstand, in dem der Nachtrag bestaetigt ist und sein
   * Entwurf noch aktiv. Der Bezug auf den Nachtrag ist ein Fremdschluessel;
   * der verbrauchte Entwurf traegt keinen Inhalt mehr. Scheitert das, rollt
   * die ganze Bestaetigung zurueck, die Sequenz eingeschlossen.
   */
  if v_source_draft_id is not null then
    update public.workspace_order_amendment_drafts
    set
      status = 'consumed',
      consumed_client_amendment_id = v_client_id,
      payload = '{}'::jsonb,
      row_version = row_version + 1,
      updated_by = v_user_id
    where workspace_id = p_workspace_id and client_draft_id = v_source_draft_id
      and status = 'active' and not deleted
      and row_version = p_expected_draft_row_version;
    if not found then
      raise exception 'order_amendment_draft_consume_failed';
    end if;
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'amendment', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

/* 4 -- SQL-10 / RE-04 / SQL-08 / RE-09 / SQL-09 / SQL-12 bis SQL-15 */
create or replace function public.workspace_skonto_terms(p_text text)
returns table (pct numeric, days integer)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_text text := coalesce(p_text, '');
  v_end integer;
  v_pct text[];
  v_days text[];
  v_pct_value numeric;
  v_days_value numeric;
begin
  /*
   * FINANZ-CORE-01A (WEISS-Recheck N02-R2) -- Skontosatz und -frist aus dem Text des
   * Belegs, dieselbe Lesart wie im Client (parseSkontoFromText): zuerst der Satz, dann
   * die erste Tagesangabe danach; sonst die Tagesangabe, dann der erste Satz danach.
   * Wie im Client nur innerhalb derselben Zeile. Ohne beides (oder mit absurden
   * Werten) gibt es kein Skonto -- nie geraten.
   */
  v_end := regexp_instr(v_text, '[0-9]+([.,][0-9]+)?[[:space:]]*%', 1, 1, 1);
  if v_end > 0 then
    v_pct := regexp_match(v_text, '([0-9]+(?:[.,][0-9]+)?)[[:space:]]*%');
    v_days := regexp_match(split_part(split_part(substr(v_text, v_end), chr(10), 1), chr(13), 1), '([0-9]+)[[:space:]]*tag(?:e|en)?(?:[^[:alnum:]_]|$)', 'i');
    if v_days is not null then
      v_pct_value := replace(v_pct[1], ',', '.')::numeric;
      v_days_value := v_days[1]::numeric;
      if v_pct_value > 0 and v_days_value > 0 and v_days_value <= 3660 then
        pct := v_pct_value;
        days := v_days_value::integer;
        return next;
        return;
      end if;
    end if;
  end if;
  v_end := regexp_instr(v_text, '[0-9]+[[:space:]]*tag(?:e|en)?(?:[^[:alnum:]_]|$)', 1, 1, 1, 'i');
  if v_end > 0 then
    v_days := regexp_match(v_text, '([0-9]+)[[:space:]]*tag(?:e|en)?(?:[^[:alnum:]_]|$)', 'i');
    v_pct := regexp_match(split_part(split_part(substr(v_text, v_end - 1), chr(10), 1), chr(13), 1), '([0-9]+(?:[.,][0-9]+)?)[[:space:]]*%');
    if v_pct is not null then
      v_pct_value := replace(v_pct[1], ',', '.')::numeric;
      v_days_value := v_days[1]::numeric;
      if v_pct_value > 0 and v_days_value > 0 and v_days_value <= 3660 then
        pct := v_pct_value;
        days := v_days_value::integer;
        return next;
        return;
      end if;
    end if;
  end if;
  return;
end;
$$;

revoke all on function public.workspace_skonto_terms(text) from public, anon, authenticated, service_role;

create or replace function public.workspace_safe_date(p_text text)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  /* WEISS-Recheck N02-R2 -- ein unlesbares Datum ist kein Fristbeginn (und kein Abbruch der Freigabe). */
  if p_text is null or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
    return null;
  end if;
  return left(p_text, 10)::date;
exception when others then
  return null;
end;
$$;

revoke all on function public.workspace_safe_date(text) from public, anon, authenticated, service_role;

/*
 * FINANZ-CORE-01A (SQL-09) -- die einzelnen wirksamen Pauschalabzuege eines
 * Vorgangs. Dieselbe Auswahl wie workspace_invoice_abschlag_deductions (die
 * Summe), hier je Beleg mit Kennung und Betrag in Cent: Die Schlussrechnung
 * druckt jede Zeile, also prueft der Server jede Zeile.
 */
create or replace function public.workspace_invoice_abschlag_deduction_rows(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_exclude_client_invoice_id text
)
returns table (client_invoice_id text, amount_cents numeric)
language sql
stable
set search_path = public
as $$
  select wi.client_invoice_id, round((wi.payload->>'amount')::numeric * 100)
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.vorgang_id = p_vorgang_id
    and wi.invoice_type = 'abschlag'
    and wi.invoice_status in ('vorbereitet', 'versendet')
    and wi.cancelled_at is null
    and coalesce(wi.payload->>'paymentStatus', '') <> 'storniert'
    and wi.client_invoice_id is distinct from p_exclude_client_invoice_id
    and jsonb_typeof(wi.payload->'amount') = 'number'
    and (
      coalesce(wi.payload->>'calculationMode', '') = 'fixed_amount'
      or not exists (
        select 1
        from jsonb_array_elements(coalesce(wi.payload->'positions', '[]'::jsonb)) pos
        where jsonb_typeof(pos.value->'quantity') = 'number'
          and (pos.value->>'quantity')::numeric > 0
      )
    );
$$;

revoke all on function public.workspace_invoice_abschlag_deduction_rows(uuid, text, text) from public, anon, authenticated, service_role;

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

/* 5 -- ANG-01 / SQL-10 / ANG-15 */
create or replace function public.finalize_workspace_offer(
  p_workspace_id uuid,
  p_offer_id text,
  p_payload jsonb,
  p_fingerprint text,
  p_row_version bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_offers;
  v_year integer;
  v_seq integer;
  v_number text;
  v_customer_id text;
  v_payload jsonb;
  v_positions jsonb;
  /* FINANZ-CORE-01A (SQL-10) */
  v_server_totals jsonb;
  v_has_position boolean := false;
  v_pos jsonb;
  v_now timestamptz := now();
begin
  p_row_version := coalesce(p_row_version, 0);

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if not public.workspace_user_can_intake(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  /*
   * GO-LIVE-SECURITY-01 — Produktentscheidung vom 2026-10-09: Mitglieder
   * bereiten Angebote vor (Entwurf über den generischen Schreibweg,
   * unverändert). Die verbindliche Freigabe mit Nummernvergabe geben nur
   * Inhaber und Admin. Die Prüfung steht vor dem Anlegen der Zeile.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;
  if p_offer_id is null or length(trim(p_offer_id)) = 0 then
    raise exception 'offer_id fehlt';
  end if;
  if p_fingerprint is null or length(trim(p_fingerprint)) = 0 then
    raise exception 'fingerprint fehlt';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Angebot ungueltig: payload';
  end if;

  -- Zeile anlegen, falls der Entwurf nie gesendet wurde; dann sperren.
  insert into public.workspace_offers (workspace_id, client_offer_id, client_customer_id, status, payload, row_version, created_by, updated_by)
  values (p_workspace_id, p_offer_id, nullif(trim(p_payload->>'customerId'), ''), 'entwurf', p_payload, 1, auth.uid(), auth.uid())
  on conflict (workspace_id, client_offer_id) do nothing;

  select o.* into v_row
  from public.workspace_offers o
  where o.workspace_id = p_workspace_id and o.client_offer_id = p_offer_id
  for update;

  if v_row.deleted then
    raise exception 'Angebot ist geloescht' using errcode = 'P0001';
  end if;

  if v_row.status <> 'entwurf' then
    if v_row.content_fingerprint = p_fingerprint then
      return jsonb_build_object('row', to_jsonb(v_row), 'row_version', v_row.row_version, 'replayed', true);
    end if;
    raise exception 'Angebot ist bereits freigegeben (%)', v_row.offer_number using errcode = 'P0001';
  end if;

  -- Versionsvertrag wie in der generischen Schreibfunktion: bestaetigt muss passen.
  if p_row_version > 0 and p_row_version <> v_row.row_version then
    raise exception 'Versionskonflikt offer:%', v_row.row_version using errcode = 'P0001';
  end if;

  -- Fachliche Pflichten.
  /*
   * FINANZ-CORE-01A (ANG-01/SQL-10) -- ein verbindliches Angebot braucht eine
   * Steuerentscheidung. "unclear" rechnet mit 0 %, der Ausdruck zeigte bisher
   * trotzdem 19 %, und die Annahme trug den ungeklaerten Status in den
   * Auftrag. Nach dem Replay oben: Ein bereits freigegebenes Angebot bekommt
   * seinen Erfolg unveraendert zurueck.
   */
  if coalesce(nullif(trim(coalesce(p_payload->>'taxStatus', '')), ''), 'unclear') = 'unclear'
     or public.workspace_tax_rate_for_status(trim(p_payload->>'taxStatus')) is null then
    raise exception 'Angebot ungueltig: Steuerstatus unklar' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(p_payload->'customer'->>'name', ''))) = 0 then
    raise exception 'Angebot ungueltig: Kunde fehlt' using errcode = 'P0001';
  end if;
  if length(trim(coalesce(p_payload->>'title', ''))) = 0 then
    raise exception 'Angebot ungueltig: Betreff fehlt' using errcode = 'P0001';
  end if;
  if coalesce(p_payload->>'validUntil', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Angebot ungueltig: Gueltigkeit fehlt' using errcode = 'P0001';
  end if;
  v_positions := p_payload->'positions';
  if v_positions is null or jsonb_typeof(v_positions) <> 'array' then
    raise exception 'Angebot ungueltig: Positionen fehlen' using errcode = 'P0001';
  end if;
  for v_pos in select * from jsonb_array_elements(v_positions) loop
    if jsonb_typeof(v_pos->'quantity') = 'number' and (v_pos->>'quantity')::numeric > 0 then
      v_has_position := true;
    end if;
    if jsonb_typeof(v_pos->'unitPrice') = 'number' and (v_pos->>'unitPrice')::numeric < 0 then
      raise exception 'Angebot ungueltig: negativer Preis' using errcode = 'P0001';
    end if;
  end loop;
  if not v_has_position then
    raise exception 'Angebot ungueltig: keine Position mit Menge' using errcode = 'P0001';
  end if;
  if p_payload->'totals' is null or jsonb_typeof(p_payload->'totals') <> 'object' then
    raise exception 'Angebot ungueltig: Summen fehlen' using errcode = 'P0001';
  end if;

  /*
   * FINANZ-CORE-01A (SQL-10) -- die Summen folgen aus den Positionen. Bisher
   * pruefte der Server nur, dass ein Summenobjekt da ist; der Ausdruck und
   * spaeter der Auftrag trugen jede gesendete Summe. Gerechnet wird wie im
   * Client (computeOfferTotals): Positionen mit Menge > 0, je Zeile mit dem
   * Einzelpreis auf Cent, Steuer einmal gerundet (build_workspace_order_totals).
   */
  if jsonb_typeof(p_payload->'totals'->'subtotal') is distinct from 'number'
     or jsonb_typeof(p_payload->'totals'->'tax') is distinct from 'number'
     or jsonb_typeof(p_payload->'totals'->'total') is distinct from 'number' then
    raise exception 'Angebot ungueltig: Summen fehlen' using errcode = 'P0001';
  end if;
  v_server_totals := public.build_workspace_order_totals(
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'plannedQuantity', (p->>'quantity')::numeric,
        'unitPrice', (p->>'unitPrice')::numeric
      )), '[]'::jsonb)
      from jsonb_array_elements(v_positions) p
      where jsonb_typeof(p->'quantity') = 'number'
        and jsonb_typeof(p->'unitPrice') = 'number'
    ),
    trim(p_payload->>'taxStatus')
  );
  if round((p_payload->'totals'->>'subtotal')::numeric * 100) is distinct from round((v_server_totals->>'subtotal')::numeric * 100)
     or round((p_payload->'totals'->>'tax')::numeric * 100) is distinct from round((v_server_totals->>'tax')::numeric * 100)
     or round((p_payload->'totals'->>'total')::numeric * 100) is distinct from round((v_server_totals->>'total')::numeric * 100) then
    raise exception 'Angebot ungueltig: Summen passen nicht zu den Positionen' using errcode = 'P0001';
  end if;

  -- Fremdworkspace-Kunde: Ist ein Kunde referenziert, muss er zu diesem Workspace gehoeren.
  v_customer_id := nullif(trim(coalesce(p_payload->>'customerId', '')), '');
  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
  ) then
    -- Der Kunde kann lokal angelegt und noch nicht synchronisiert sein; das
    -- Angebot traegt seinen Schnappschuss ohnehin selbst. Deshalb kein Abbruch,
    -- aber der Bezug wird nicht als Serverwahrheit uebernommen.
    v_customer_id := null;
  end if;

  -- Nummer: Jahr aus dem Angebotsdatum, sonst heute.
  -- FINANZ-CORE-01A (ANG-15) -- ohne Angebotsdatum das Jahr des Geschaeftstags, nicht das UTC-Jahr.
  v_year := coalesce(nullif(substr(coalesce(p_payload->>'offerDate', ''), 1, 4), '')::integer, public.workspace_vorgang_year(v_now));
  insert into public.workspace_offer_sequences (workspace_id, offer_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, offer_year) do nothing;

  select s.last_sequence + 1 into v_seq
  from public.workspace_offer_sequences s
  where s.workspace_id = p_workspace_id and s.offer_year = v_year
  for update;

  update public.workspace_offer_sequences
  set last_sequence = v_seq
  where workspace_id = p_workspace_id and offer_year = v_year;

  v_number := public.format_workspace_offer_number(v_year, v_seq);

  v_payload := p_payload
    || jsonb_build_object(
      'status', 'freigegeben',
      'offerNumber', v_number,
      'offerSequenceNumber', v_seq,
      'contentFingerprint', p_fingerprint,
      'finalizedAt', to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );

  update public.workspace_offers
  set
    status = 'freigegeben',
    offer_number = v_number,
    offer_sequence_number = v_seq,
    offer_year = v_year,
    content_fingerprint = p_fingerprint,
    client_customer_id = coalesce(nullif(trim(coalesce(p_payload->>'customerId', '')), ''), client_customer_id),
    payload = v_payload,
    row_version = row_version + 1,
    updated_by = auth.uid()
  where workspace_id = p_workspace_id and client_offer_id = p_offer_id
  returning * into v_row;

  return jsonb_build_object('row', to_jsonb(v_row), 'row_version', v_row.row_version, 'replayed', false);
end;
$$;

/* 6 -- RE-02 */
/*
 * FINANZ-CORE-01A (RE-02) -- die Startnummer aus der Einrichtung.
 *
 * Der Assistent fragt nach der zuletzt vergebenen Rechnungsnummer ("die
 * naechste Rechnung erhaelt die folgende Nummer"). Bisher blieb sie lokal; der
 * Server vergab trotzdem ab 1 -- wer aus einer anderen Software umstieg,
 * bekam doppelte Nummern (§ 14 Abs. 4 Nr. 4 UStG).
 *
 * Nur fuer ein Jahr ohne vergebene Nummer: Ein benutzter Kreis wird nie
 * verschoben ('invoice_number_start_locked'). Derselbe Wert erneut ist kein
 * Fehler (idempotent). Rollen- und Kontopruefung wie beim Versandvermerk
 * (GO-LIVE-SECURITY-01 R6): zuerst die Rolle (42501 fuer Mitglieder), dann
 * die Finanzberechtigung.
 */
create or replace function public.set_workspace_invoice_number_start(
  p_workspace_id uuid,
  p_year integer,
  p_last_sequence integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq public.workspace_invoice_sequences;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;
  perform public.assert_financial_action_allowed(p_workspace_id);

  if p_year is null or p_year < 2000 or p_year > 2999 then
    raise exception 'invoice_number_start_invalid: year';
  end if;
  if p_last_sequence is null or p_last_sequence < 0 or p_last_sequence > 99999999 then
    raise exception 'invoice_number_start_invalid: sequence';
  end if;

  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, p_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select * into v_seq
  from public.workspace_invoice_sequences
  where workspace_id = p_workspace_id and invoice_year = p_year
  for update;

  if v_seq.last_sequence = p_last_sequence then
    return jsonb_build_object('applied', false, 'year', p_year, 'last_sequence', v_seq.last_sequence);
  end if;

  if v_seq.last_sequence <> 0 or exists (
    select 1 from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id and wi.invoice_year = p_year
  ) then
    raise exception 'invoice_number_start_locked: %', v_seq.last_sequence;
  end if;

  update public.workspace_invoice_sequences
  set last_sequence = p_last_sequence
  where workspace_id = p_workspace_id and invoice_year = p_year and last_sequence = 0
  returning * into v_seq;

  if v_seq.last_sequence is distinct from p_last_sequence then
    raise exception 'invoice_number_start_not_applied';
  end if;

  return jsonb_build_object('applied', true, 'year', p_year, 'last_sequence', v_seq.last_sequence);
end;
$$;

revoke all on function public.set_workspace_invoice_number_start(uuid, integer, integer) from public, anon, service_role;
grant execute on function public.set_workspace_invoice_number_start(uuid, integer, integer) to authenticated;

/* 7 -- SQL-07 / ANG-09: Versand-Claim */
create or replace function public.claim_workspace_document_delivery_for_send(
  p_delivery_id uuid,
  p_expected_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_document_deliveries;
  /* FINANZ-CORE-01A (SQL-07/ANG-09) */
  v_invoice public.workspace_invoices;
  v_blocked_code text;
  v_blocked_message text;
begin
  if p_delivery_id is null or p_expected_row_version is null then
    raise exception 'delivery_id/row_version fehlt';
  end if;

  /*
   * FINANZ-CORE-01A (SQL-07/ANG-09) -- der Versand prueft seinen Gegenstand
   * unter Sperre, unmittelbar vor dem Provider-Aufruf.
   *
   * Die Edge Function prueft den Storno nur vor dem Claim. Jetzt sperrt der
   * Claim die Rechnungszeile (dieselbe Sperre wie cancel_workspace_invoice)
   * und weist eine stornierte Rechnung ab: Der Auftrag wird 'failed', es geht
   * keine E-Mail hinaus. Ein abgelehntes, storniertes oder ersetztes Angebot
   * geht ebenso nicht mehr an den Kunden.
   *
   * Abgewiesen wird nur ein Auftrag, den dieser Aufruf auch claimen duerfte
   * (queued, erwartete Version); alles andere entscheidet unveraendert das
   * UPDATE darunter.
   */
  select * into v_row from public.workspace_document_deliveries where id = p_delivery_id;
  if v_row.id is not null and v_row.status = 'queued' and v_row.row_version = p_expected_row_version then
    if v_row.document_kind = 'invoice' then
      select * into v_invoice
      from public.workspace_invoices wi
      where wi.workspace_id = v_row.workspace_id
        and wi.client_invoice_id = v_row.linked_invoice_id
      for update;
      if v_invoice.id is not null and v_invoice.cancelled_at is not null then
        v_blocked_code := 'invoice_cancelled';
        v_blocked_message := 'Die Rechnung wurde storniert. Es wurde nichts gesendet.';
      end if;
    elsif v_row.document_kind = 'offer' and exists (
      select 1
      from public.workspace_documents doc
      join public.workspace_offers o
        on o.workspace_id = doc.workspace_id
       and o.client_offer_id = nullif(btrim(coalesce(doc.payload->>'linkedOfferId', '')), '')
      where doc.workspace_id = v_row.workspace_id
        and doc.client_document_id = v_row.linked_document_id
        and (o.deleted or o.status in ('abgelehnt', 'storniert', 'ersetzt'))
    ) then
      v_blocked_code := 'offer_not_sendable';
      v_blocked_message := 'Das Angebot ist abgelehnt, storniert oder ersetzt. Es wurde nichts gesendet.';
    end if;

    if v_blocked_code is not null then
      update public.workspace_document_deliveries
      set
        status = 'failed',
        failed_at = now(),
        error_category = 'unknown',
        error_code = v_blocked_code,
        error_message_safe = v_blocked_message,
        row_version = row_version + 1,
        updated_at = now()
      where id = p_delivery_id
        and status = 'queued'
        and row_version = p_expected_row_version
      returning * into v_row;
      if v_row.id is null then
        select * into v_row from public.workspace_document_deliveries where id = p_delivery_id;
      end if;
      return jsonb_build_object('claimed', false, 'delivery', to_jsonb(v_row));
    end if;
  end if;

  -- Ein einziges UPDATE: Zustand und Version werden unter der Zeilensperre
  -- geprueft. Ein paralleler zweiter Aufruf wartet auf die Sperre, sieht danach
  -- `sending` und aendert nichts.
  update public.workspace_document_deliveries
  set
    status = 'sending',
    sending_started_at = now(),
    row_version = row_version + 1,
    updated_at = now()
  where id = p_delivery_id
    and status = 'queued'
    and row_version = p_expected_row_version
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object('claimed', true, 'delivery', to_jsonb(v_row));
  end if;

  select * into v_row from public.workspace_document_deliveries where id = p_delivery_id;
  if v_row.id is null then
    raise exception 'Delivery nicht gefunden';
  end if;
  return jsonb_build_object('claimed', false, 'delivery', to_jsonb(v_row));
end;
$$;

/* 8 -- SQL-07 / AUS-15: Annahme des Providers */
create or replace function public.mark_workspace_document_delivery_accepted(
  p_delivery_id uuid,
  p_provider_message_id text,
  p_expected_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.workspace_document_deliveries;
  v_invoice public.workspace_invoices;
  v_linked public.workspace_document_deliveries;
  v_message_id text;
  -- FINANZ-CORE-01A (AUS-15) -- das Versanddatum ist der Geschaeftstag (Europe/Berlin), nicht der UTC-Tag.
  v_today text := to_char(timezone('Europe/Berlin', now()), 'YYYY-MM-DD');
  v_coupling text := 'none';
  v_prior jsonb;
begin
  if p_delivery_id is null then
    raise exception 'delivery_id fehlt';
  end if;
  v_message_id := nullif(btrim(coalesce(p_provider_message_id, '')), '');
  if v_message_id is null or length(v_message_id) > 255 then
    raise exception 'provider_message_id fehlt';
  end if;

  select * into v_delivery from public.workspace_document_deliveries where id = p_delivery_id for update;
  if v_delivery.id is null then
    raise exception 'Delivery nicht gefunden';
  end if;
  if p_expected_row_version is not null and v_delivery.row_version <> p_expected_row_version then
    raise exception 'row_version veraltet';
  end if;

  -- Bereits angenommen (auch spaetere Webhook-Zustaende): nur die Kopplung bestaetigen, nie zurueck.
  if v_delivery.status not in ('provider_accepted', 'delivered', 'bounced', 'complained') then
    if not public.document_delivery_transition_allowed(v_delivery.status, 'provider_accepted') then
      raise exception 'Statusuebergang % -> provider_accepted nicht erlaubt', v_delivery.status;
    end if;
    update public.workspace_document_deliveries
    set
      status = 'provider_accepted',
      provider_message_id = v_message_id,
      provider_accepted_at = now(),
      error_category = null,
      error_code = null,
      error_message_safe = null,
      row_version = row_version + 1,
      updated_at = now()
    where id = v_delivery.id
    returning * into v_delivery;
  elsif v_delivery.provider_message_id is distinct from v_message_id then
    -- Replay mit anderer Provider-ID: die erste bleibt die Wahrheit.
    raise exception 'Delivery bereits mit anderer provider_message_id angenommen';
  end if;

  -- Kopplung nur fuer die Rechnung selbst; der Korrekturbeleg laesst das Original in Ruhe.
  if v_delivery.document_kind = 'invoice' then
    select * into v_invoice
    from public.workspace_invoices
    where workspace_id = v_delivery.workspace_id
      and client_invoice_id = v_delivery.linked_invoice_id
    for update;
    if v_invoice.id is null then
      raise exception 'Rechnung nicht gefunden';
    end if;
    if v_invoice.invoice_status = 'entwurf' then
      raise exception 'Rechnung nicht finalisiert';
    end if;

    /*
     * FINANZ-CORE-01A (SQL-07) -- eine intern stornierte Rechnung wird nicht
     * still auf "versendet" gesetzt. Die Annahme des Providers ist Tatsache und
     * bleibt am Versandauftrag stehen; die Rechnung bleibt, wie sie ist, und
     * die Antwort benennt den Konflikt. Mit Claim-Sperre und Stornoregel ist
     * das nur noch fuer Auftraege einer aelteren Edge Function erreichbar
     * (queued -> provider_accepted ohne Claim).
     */
    if v_invoice.cancelled_at is not null and v_invoice.cancellation_kind is distinct from 'correction' then
      v_coupling := 'invoice_cancelled_conflict';
    elsif v_invoice.sent_delivery_id = v_delivery.id then
      v_coupling := 'already_linked';
    elsif v_invoice.sent_source = 'officepilot' and v_invoice.sent_delivery_id is not null then
      select * into v_linked from public.workspace_document_deliveries where id = v_invoice.sent_delivery_id;
      if v_linked.id is not null and v_linked.status in ('provider_accepted', 'delivered', 'bounced', 'complained') then
        -- Erste erfolgreiche Delivery bleibt Referenz; Rechnung ist bereits versendet.
        v_coupling := 'kept_existing';
      else
        v_coupling := 'relinked';
      end if;
    elsif v_invoice.sent_source = 'manual' then
      v_coupling := 'upgraded_from_manual';
      v_prior := jsonb_strip_nulls(jsonb_build_object(
        'sentAt', v_invoice.payload->>'sentAt',
        'sentVia', v_invoice.payload->>'sentVia',
        'sentNote', v_invoice.payload->>'sentNote'
      ));
    else
      v_coupling := 'linked';
    end if;

    if v_coupling in ('linked', 'relinked', 'upgraded_from_manual') then
      update public.workspace_invoices
      set
        invoice_status = 'versendet',
        sent_source = 'officepilot',
        sent_delivery_id = v_delivery.id,
        payload = (payload - 'sentNote')
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_today,
            'sentVia', 'email',
            'sentSource', 'officepilot',
            'sentDeliveryId', v_delivery.id::text
          )
          || case when v_prior is null or v_prior = '{}'::jsonb then '{}'::jsonb
                  else jsonb_build_object('sentManualPrior', v_prior) end,
        row_version = row_version + 1,
        updated_at = now()
      where id = v_invoice.id
      returning * into v_invoice;
    elsif v_coupling = 'kept_existing' and v_invoice.invoice_status <> 'versendet' then
      -- Defensiv: eine verknuepfte, angenommene Delivery bedeutet immer versendet.
      update public.workspace_invoices
      set invoice_status = 'versendet',
          payload = payload || jsonb_build_object('status', 'versendet'),
          row_version = row_version + 1,
          updated_at = now()
      where id = v_invoice.id
      returning * into v_invoice;
    end if;

    if v_coupling <> 'invoice_cancelled_conflict' and v_invoice.invoice_status is distinct from 'versendet' then
      raise exception 'Sent-Kopplung Nachbedingung verletzt: invoice_status';
    end if;
  end if;

  return jsonb_build_object(
    'delivery', to_jsonb(v_delivery),
    'coupling', v_coupling,
    'invoice', case when v_invoice.id is null then null else jsonb_build_object(
      'invoice_status', v_invoice.invoice_status,
      'sent_source', v_invoice.sent_source,
      'sent_delivery_id', v_invoice.sent_delivery_id,
      'row_version', v_invoice.row_version
    ) end
  );
end;
$$;

/* 9 -- SQL-05 / SQL-15: Zahlung (ersetzt die 8-Argument-Fassung) */
drop function if exists public.add_workspace_invoice_payment(uuid, text, text, numeric, text, text, text, text);

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
  if not coalesce(p_overpayment_acknowledged, false)
     and not exists (
       select 1
       from public.workspace_invoice_payments p
       where p.workspace_id = p_workspace_id
         and p.client_invoice_id = v_invoice_id
         and p.client_payment_id = v_payment_id
     ) then
    v_total := case
      when jsonb_typeof(v_invoice.payload->'amount') = 'number' then (v_invoice.payload->>'amount')::numeric
    end;
    select coalesce(sum(p.amount), 0)
    into v_paid
    from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id
      and p.client_invoice_id = v_invoice_id
      and p.reversed_at is null;
    if v_total is not null and round(v_paid + round(p_amount, 2), 2) > round(v_total, 2) then
      raise exception 'invoice_payment_overpayment_unconfirmed: offen %', greatest(round(v_total - v_paid, 2), 0)
        using errcode = 'P0001';
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

/* 9b -- N03: Ausgabenzahlung, nur endliche Betraege */
create or replace function public.add_workspace_expense_payment(
  p_workspace_id uuid,
  p_client_expense_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null,
  p_method text default null
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

  select * into v_expense
  from public.workspace_expenses
  where workspace_id = p_workspace_id
    and client_expense_id = v_expense_id;
  if v_expense.id is null then
    raise exception 'Ausgabe nicht gefunden';
  end if;
  if v_expense.deleted then
    raise exception 'Ausgabe geloescht';
  end if;
  if v_expense.status = 'storniert' then
    raise exception 'Ausgabe storniert';
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

/* 10 -- ANG-15 / SQL-10: Auftraege */
create or replace function public.build_workspace_order_totals(p_positions jsonb, p_tax_status text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_rate numeric;
  v_subtotal_cents numeric := 0;
  v_tax_cents numeric;
begin
  v_rate := public.workspace_tax_rate_for_status(p_tax_status);
  if v_rate is null then
    raise exception 'Auftrag: unbekannter Steuerstatus %', p_tax_status using errcode = 'P0001';
  end if;
  /*
   * FINANZ-CORE-01A (SQL-10/RE-06) -- je Zeile mit dem Einzelpreis auf Cent,
   * wie billingLineTotalCents im Client: Gedruckt und abgerechnet wird der
   * Centpreis; ein feinerer Preis (0,045 EUR) ergab sonst eine andere Summe
   * als Beleg und Oberflaeche.
   */
  select coalesce(sum(round((p->>'plannedQuantity')::numeric * round((p->>'unitPrice')::numeric, 2) * 100)), 0)
  into v_subtotal_cents
  from jsonb_array_elements(p_positions) p
  where (p->>'plannedQuantity')::numeric > 0;

  v_tax_cents := case when v_rate > 0 then round(v_subtotal_cents * v_rate / 100) else 0 end;

  return jsonb_build_object(
    'subtotal', v_subtotal_cents / 100,
    'taxRate', v_rate,
    'tax', v_tax_cents / 100,
    'total', (v_subtotal_cents + v_tax_cents) / 100
  );
end;
$$;

create or replace function public.accept_workspace_offer(
  p_workspace_id uuid,
  p_offer_id text,
  p_vorgang_id text,
  p_row_version bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer public.workspace_offers;
  v_vorgang public.workspace_vorgaenge;
  v_existing_vid text;
  v_year integer;
  v_seq integer;
  v_number text;
  -- EINGANG-01C-2
  v_vorgang_number text;
  v_now timestamptz := now();
  v_now_iso text;
  v_today text;
  v_pl jsonb;
  v_positions jsonb;
  v_conf jsonb;
  v_vorgang_payload jsonb;
begin
  p_row_version := coalesce(p_row_version, 0);
  v_now_iso := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- RECHNUNGSBEREICH-03D: das Auftragsdatum ist der Geschaeftstag des Betriebs.
  v_today := to_char(v_now at time zone 'Europe/Berlin', 'YYYY-MM-DD');

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  -- Auftraege sind Vorgaenge: dieselbe Rolle wie fuer jeden Vorgangs-Write.
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if p_offer_id is null or length(trim(p_offer_id)) = 0 then
    raise exception 'offer_id fehlt';
  end if;
  if p_vorgang_id is null or length(trim(p_vorgang_id)) = 0 then
    raise exception 'vorgang_id fehlt';
  end if;

  select o.* into v_offer
  from public.workspace_offers o
  where o.workspace_id = p_workspace_id and o.client_offer_id = p_offer_id
  for update;
  if not found then
    raise exception 'Angebot nicht gefunden' using errcode = 'P0001';
  end if;
  if v_offer.deleted then
    raise exception 'Angebot ist geloescht' using errcode = 'P0001';
  end if;

  -- Wiederholung: bereits angenommen -> denselben Auftrag zurueckgeben.
  if v_offer.status = 'angenommen' then
    v_existing_vid := nullif(trim(coalesce(v_offer.payload->>'resultingVorgangId', '')), '');
    select v.* into v_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_existing_vid and v.deleted = false;
    if not found then
      raise exception 'Angebot ist angenommen, aber der Auftrag fehlt' using errcode = 'P0001';
    end if;
    return jsonb_build_object('offer', to_jsonb(v_offer), 'vorgang', to_jsonb(v_vorgang), 'replayed', true);
  end if;

  if v_offer.status not in ('freigegeben', 'versendet') then
    raise exception 'Angebot kann im Zustand % nicht angenommen werden', v_offer.status using errcode = 'P0001';
  end if;
  if p_row_version > 0 and p_row_version <> v_offer.row_version then
    raise exception 'Versionskonflikt offer:%', v_offer.row_version using errcode = 'P0001';
  end if;
  if v_offer.offer_number is null then
    raise exception 'Angebot ohne Nummer kann nicht angenommen werden' using errcode = 'P0001';
  end if;
  -- Die Vorgangskennung kommt vom Client; sie darf noch nicht vergeben sein.
  if exists (select 1 from public.workspace_vorgaenge v where v.workspace_id = p_workspace_id and v.vorgang_id = p_vorgang_id) then
    raise exception 'Vorgangskennung bereits vergeben' using errcode = 'P0001';
  end if;

  v_pl := v_offer.payload;
  if length(trim(coalesce(v_pl->'customer'->>'name', ''))) = 0 then
    raise exception 'Angebot ohne Kunden kann nicht angenommen werden' using errcode = 'P0001';
  end if;

  -- Auftragsnummer, unter Sperre der Jahressequenz.
  -- FINANZ-CORE-01A (ANG-15) -- dasselbe Jahr wie Auftragsdatum und Vorgangsnummer (Europe/Berlin).
  v_year := public.workspace_vorgang_year(v_now);
  insert into public.workspace_order_sequences (workspace_id, order_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, order_year) do nothing;

  select s.last_sequence + 1 into v_seq
  from public.workspace_order_sequences s
  where s.workspace_id = p_workspace_id and s.order_year = v_year
  for update;

  update public.workspace_order_sequences
  set last_sequence = v_seq
  where workspace_id = p_workspace_id and order_year = v_year;

  v_number := public.format_workspace_order_number(v_year, v_seq);

  -- EINGANG-01C-2: Vorgangsnummer aus der eigenen Jahressequenz, dieselbe Transaktion.
  v_vorgang_number := public.allocate_workspace_vorgang_number(p_workspace_id);

  -- Positionen: Angebotsposition -> Auftragsposition (Plan = angebotene Menge).
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', p->>'id',
    'description', p->>'description',
    'plannedQuantity', (p->>'quantity')::numeric,
    'unit', p->>'unit',
    'unitLabel', p->'unitLabel',
    'unitPrice', (p->>'unitPrice')::numeric,
    'category', p->'category',
    'billable', true
  ))), '[]'::jsonb)
  into v_positions
  from jsonb_array_elements(coalesce(v_pl->'positions', '[]'::jsonb)) p
  where jsonb_typeof(p->'quantity') = 'number' and (p->>'quantity')::numeric > 0;

  if jsonb_array_length(v_positions) = 0 then
    raise exception 'Angebot ohne Positionen kann nicht angenommen werden' using errcode = 'P0001';
  end if;

  -- Der eingefrorene kaufmaennische Stand -- dieselbe Struktur wie beim Werkvertrag.
  v_conf := jsonb_build_object(
    'id', 'conf-' || p_vorgang_id,
    'confirmedAt', v_now_iso,
    'customer', v_pl->'customer'->>'name',
    'auftraggeber', v_pl->'customer'->>'name',
    'baustelle', coalesce(v_pl->>'baustelle', ''),
    'title', coalesce(v_pl->>'title', ''),
    'positions', v_positions,
    'negotiation', jsonb_build_object(
      'conducted', false,
      'notes', '[]'::jsonb,
      'generalHints', '[]'::jsonb,
      'priceProposals', '[]'::jsonb,
      'positionProposals', '[]'::jsonb,
      'drafts', '[]'::jsonb
    ),
    'immutable', true
  );

  v_vorgang_payload := jsonb_strip_nulls(jsonb_build_object(
    'id', p_vorgang_id,
    'title', coalesce(v_pl->>'title', ''),
    'customer', v_pl->'customer'->>'name',
    'baustelle', coalesce(v_pl->>'baustelle', ''),
    'status', 'beauftragt',
    'materialSource', 'unclear',
    'customerBilling', v_pl->'customer',
    'customerId', v_pl->'customerId',
    'orderPositions', v_positions,
    'contractConfirmation', v_conf,
    'sourceOfferId', p_offer_id,
    'sourceOfferNumber', v_offer.offer_number,
    'orderNumber', v_number,
    'vorgangNumber', v_vorgang_number,
    'orderDate', v_today,
    'taxStatus', v_pl->'taxStatus',
    'paymentTermsText', v_pl->'paymentTermsText',
    'introText', v_pl->'introText',
    'closingText', v_pl->'closingText',
    /*
     * FINANZ-CORE-01A (SQL-10) -- die Auftragssumme aus den uebernommenen
     * Positionen, nicht die ungepruefte Angebotssumme. Ein Altangebot mit
     * unbekanntem Steuerstatus behaelt seine Summe (nichts zu rechnen).
     */
    'contractTotals', case
      when public.workspace_tax_rate_for_status(coalesce(v_pl->>'taxStatus', '')) is not null
        then public.build_workspace_order_totals(v_positions, v_pl->>'taxStatus')
      else v_pl->'totals'
    end
  ));

  insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload, row_version, deleted, updated_by, source_offer_id, order_number, vorgang_number)
  values (p_workspace_id, p_vorgang_id, v_vorgang_payload, 1, false, auth.uid(), p_offer_id, v_number, v_vorgang_number)
  returning * into v_vorgang;

  update public.workspace_offers
  set
    status = 'angenommen',
    payload = payload || jsonb_build_object('status', 'angenommen', 'resultingVorgangId', p_vorgang_id, 'decidedAt', v_now_iso),
    row_version = row_version + 1,
    updated_by = auth.uid()
  where workspace_id = p_workspace_id and client_offer_id = p_offer_id
  returning * into v_offer;

  return jsonb_build_object('offer', to_jsonb(v_offer), 'vorgang', to_jsonb(v_vorgang), 'replayed', false);
end;
$$;

create or replace function public.create_workspace_order(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_order jsonb,
  p_client_draft_id text default null,
  p_expected_draft_row_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vorgang public.workspace_vorgaenge;
  v_existing public.workspace_vorgaenge;
  v_year integer;
  v_seq integer;
  v_number text;
  -- EINGANG-01C-2
  v_vorgang_number text;
  v_now timestamptz := now();
  v_now_iso text;
  v_today text;
  v_customer_id text;
  v_customer_name text;
  v_title text;
  v_baustelle text;
  v_tax_status text;
  v_positions jsonb := '[]'::jsonb;
  v_pos jsonb;
  v_norm jsonb;
  v_ids text[] := '{}';
  v_id text;
  v_qty numeric;
  v_price numeric;
  v_unit text;
  v_allowed_units text[] := array['m²', 'Stück', 'Meter', 'Stunden', 'Pauschal'];
  v_totals jsonb;
  v_conf jsonb;
  v_payload jsonb;
  -- CLOUD-SYNC S6: nur fuer die Entwurfsbindung.
  v_draft_id text;
  v_order_draft public.workspace_order_drafts;
  v_has_order_draft boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  -- Ein Auftrag ist ein Vorgang: dieselbe Rolle wie fuer jeden Vorgangs-Write.
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if p_vorgang_id is null or length(trim(p_vorgang_id)) = 0 then
    raise exception 'vorgang_id fehlt' using errcode = 'P0001';
  end if;
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'Auftragsdaten fehlen' using errcode = 'P0001';
  end if;

  /*
   * CLOUD-SYNC S6 -- die Bindung an den Cloud-Auftragsentwurf.
   *
   * Die Entwurfskennung ist die Vorgangskennung; die Bindung nennt sie
   * ausdruecklich und dazu die Entwurfsversion, aus der dieser Auftrag
   * entstehen soll. Beide Angaben gemeinsam oder keine.
   *
   * Die Entwurfszeile dieser Kennung wird VOR allem anderen gesperrt -- mit
   * oder ohne Bindung, damit die Sperrreihenfolge immer dieselbe ist
   * (Entwurf -> Vorgang -> Nummernkreise). Eine zweite Anlage desselben
   * Entwurfs wartet an dieser Sperre und findet danach den verbrauchten
   * Entwurf vor; ein Speichern desselben Entwurfs ebenso.
   */
  v_draft_id := nullif(trim(coalesce(p_client_draft_id, '')), '');
  if (p_client_draft_id is not null and v_draft_id is null)
     or ((v_draft_id is null) <> (p_expected_draft_row_version is null))
     or coalesce(p_expected_draft_row_version, 1) < 1
     or (v_draft_id is not null and v_draft_id is distinct from p_vorgang_id) then
    raise exception 'order_draft_binding_invalid' using errcode = 'P0001';
  end if;

  select d.* into v_order_draft
  from public.workspace_order_drafts d
  where d.workspace_id = p_workspace_id and d.client_draft_id = p_vorgang_id
  for update;
  v_has_order_draft := found;

  if v_draft_id is not null then
    if not v_has_order_draft then
      raise exception 'order_draft_not_found' using errcode = 'P0001';
    end if;
    if v_order_draft.deleted then
      raise exception 'order_draft_discarded' using errcode = 'P0001';
    end if;
    if v_order_draft.status = 'consumed' then
      /*
       * Verbraucht ist er nur dann durch genau diese Bindung, wenn genau diese
       * Version zum Auftrag wurde: Der Verbrauch hebt die Version um genau
       * eins, danach aendert sich die Zeile nie mehr. Jede andere Version ist
       * ein anderer Inhalt -- dann gibt es keinen Erfolg, sondern den
       * ehrlichen Befund.
       */
      if v_order_draft.row_version <> p_expected_draft_row_version + 1 then
        raise exception 'order_draft_already_consumed' using errcode = 'P0001';
      end if;
    elsif v_order_draft.row_version <> p_expected_draft_row_version then
      raise exception 'order_draft_version_conflict:%', v_order_draft.row_version using errcode = 'P0001';
    end if;
  end if;

  /*
   * Wiederholung: Dieselbe Entwurfskennung darf nie einen zweiten Auftrag
   * erzeugen -- aber auch nie einen fremden Vorgang als "meinen Auftrag"
   * ausgeben. Replay gilt nur fuer eine Zeile, die selbst ein manueller,
   * bestaetigter Auftrag ist.
   */
  select * into v_existing
  from public.workspace_vorgaenge v
  where v.workspace_id = p_workspace_id and v.vorgang_id = p_vorgang_id
  for update;
  if found then
    if v_existing.deleted
       or v_existing.order_number is null
       or v_existing.source_offer_id is not null
       or v_existing.payload->'contractConfirmation' is null then
      raise exception 'Vorgangskennung bereits vergeben' using errcode = 'P0001';
    end if;
    /*
     * CLOUD-SYNC S6 -- eine gebundene Wiederholung ist nur dann ein Erfolg,
     * wenn genau dieser Entwurf in genau dieser Version den Auftrag erzeugt
     * hat (oben geprueft: verbraucht, Version + 1). Ein noch aktiver
     * gebundener Entwurf neben einem bestehenden Auftrag hat ihn nicht
     * erzeugt -- dann kein Erfolg, sondern der ehrliche Befund.
     */
    if v_draft_id is not null and v_order_draft.status <> 'consumed' then
      raise exception 'order_draft_already_consumed' using errcode = 'P0001';
    end if;
    /*
     * Ungebundene Wiederholung (Client ohne Cloud-Entwurf): Ein noch aktiver
     * Cloud-Entwurf derselben Kennung bleibt neben dem Auftrag nicht aktiv --
     * er wird als verbraucht festgehalten (oben bereits gesperrt).
     */
    if v_draft_id is null and v_has_order_draft and v_order_draft.status = 'active' and not v_order_draft.deleted then
      update public.workspace_order_drafts
      set
        status = 'consumed',
        consumed_vorgang_id = p_vorgang_id,
        payload = '{}'::jsonb,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = p_vorgang_id
        and status = 'active' and not deleted;
    end if;
    return jsonb_build_object('vorgang', to_jsonb(v_existing), 'replayed', true);
  end if;

  /* Gebunden und verbraucht, aber ohne Auftrag: kann es wegen des Fremdschluessels nicht geben -- kein Erfolg. */
  if v_draft_id is not null and v_order_draft.status = 'consumed' then
    raise exception 'order_draft_already_consumed' using errcode = 'P0001';
  end if;

  v_now_iso := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- RECHNUNGSBEREICH-03D: das Auftragsdatum ist der Geschaeftstag des Betriebs.
  v_today := to_char(v_now at time zone 'Europe/Berlin', 'YYYY-MM-DD');

  v_customer_id := nullif(trim(coalesce(p_order->>'customerId', '')), '');
  v_customer_name := nullif(trim(coalesce(p_order->'customerBilling'->>'name', '')), '');
  v_title := nullif(trim(coalesce(p_order->>'title', '')), '');
  v_baustelle := coalesce(p_order->>'baustelle', '');
  v_tax_status := nullif(trim(coalesce(p_order->>'taxStatus', '')), '');

  if v_customer_name is null then
    raise exception 'Auftrag ohne Kunden kann nicht angelegt werden' using errcode = 'P0001';
  end if;
  if v_title is null then
    raise exception 'Auftrag ohne Bezeichnung kann nicht angelegt werden' using errcode = 'P0001';
  end if;
  if v_tax_status is null or public.workspace_tax_rate_for_status(v_tax_status) is null then
    raise exception 'Auftrag: unbekannter Steuerstatus %', coalesce(v_tax_status, '') using errcode = 'P0001';
  end if;
  -- Der Kunde muss ein Kunde dieses Arbeitsbereichs sein; eine fremde Kennung
  -- wuerde die Kundenakte still falsch verknuepfen.
  if v_customer_id is not null then
    if not exists (
      select 1 from public.workspace_customers c
      where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and c.deleted = false
    ) then
      raise exception 'Kunde gehoert nicht zu diesem Arbeitsbereich' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_typeof(coalesce(p_order->'positions', 'null'::jsonb)) <> 'array'
     or jsonb_array_length(p_order->'positions') < 1 then
    raise exception 'Auftrag ohne Positionen kann nicht angelegt werden' using errcode = 'P0001';
  end if;

  for v_pos in select value from jsonb_array_elements(p_order->'positions') loop
    if jsonb_typeof(v_pos) <> 'object' then
      raise exception 'Auftragsposition ist ungueltig' using errcode = 'P0001';
    end if;
    v_id := nullif(trim(coalesce(v_pos->>'id', '')), '');
    v_unit := nullif(trim(coalesce(v_pos->>'unit', '')), '');
    if v_id is null or nullif(trim(coalesce(v_pos->>'description', '')), '') is null or v_unit is null then
      raise exception 'Auftragsposition ist unvollstaendig' using errcode = 'P0001';
    end if;
    if v_id = any (v_ids) then
      raise exception 'Doppelte Positionskennung %', v_id using errcode = 'P0001';
    end if;
    v_ids := array_append(v_ids, v_id);
    if not (v_unit = any (v_allowed_units)) then
      raise exception 'Unbekannte Einheit %', v_unit using errcode = 'P0001';
    end if;
    begin
      v_qty := (v_pos->>'plannedQuantity')::numeric;
      v_price := (v_pos->>'unitPrice')::numeric;
    exception when others then
      raise exception 'Auftragsposition hat ungueltige Zahlen' using errcode = 'P0001';
    end;
    /*
     * FINANZ-CORE-01A (N03) -- der Text "Infinity" wird seit PostgreSQL 14 zu
     * einer unendlichen Zahl; sie ist weder Menge noch Preis.
     */
    if v_qty is null or v_qty <= 0 or v_qty = 'NaN'::numeric or v_qty = 'Infinity'::numeric
       or v_price is null or v_price < 0 or v_price = 'NaN'::numeric or v_price = 'Infinity'::numeric then
      raise exception 'Auftragsposition hat ungueltige Mengen oder Preise' using errcode = 'P0001';
    end if;
    v_norm := jsonb_strip_nulls(jsonb_build_object(
      'id', v_id,
      'description', trim(v_pos->>'description'),
      'plannedQuantity', v_qty,
      'unit', v_unit,
      'unitLabel', v_pos->'unitLabel',
      'unitPrice', v_price,
      'category', v_pos->'category',
      'billable', true
    ));
    v_positions := v_positions || jsonb_build_array(v_norm);
  end loop;

  v_totals := public.build_workspace_order_totals(v_positions, v_tax_status);

  -- Auftragsnummer aus derselben Jahressequenz wie Auftraege aus Angeboten.
  -- FINANZ-CORE-01A (ANG-15) -- dasselbe Jahr wie Auftragsdatum und Vorgangsnummer (Europe/Berlin).
  v_year := public.workspace_vorgang_year(v_now);
  insert into public.workspace_order_sequences (workspace_id, order_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, order_year) do nothing;

  select s.last_sequence + 1 into v_seq
  from public.workspace_order_sequences s
  where s.workspace_id = p_workspace_id and s.order_year = v_year
  for update;

  update public.workspace_order_sequences
  set last_sequence = v_seq
  where workspace_id = p_workspace_id and order_year = v_year;

  v_number := public.format_workspace_order_number(v_year, v_seq);

  -- EINGANG-01C-2: Vorgangsnummer aus der eigenen Jahressequenz, dieselbe Transaktion.
  v_vorgang_number := public.allocate_workspace_vorgang_number(p_workspace_id);

  -- Derselbe eingefrorene Stand wie beim Auftrag aus Angebot.
  v_conf := jsonb_build_object(
    'id', 'conf-' || p_vorgang_id,
    'confirmedAt', v_now_iso,
    'customer', v_customer_name,
    'auftraggeber', v_customer_name,
    'baustelle', v_baustelle,
    'title', v_title,
    'positions', v_positions,
    'negotiation', jsonb_build_object(
      'conducted', false,
      'notes', '[]'::jsonb,
      'generalHints', '[]'::jsonb,
      'priceProposals', '[]'::jsonb,
      'positionProposals', '[]'::jsonb,
      'drafts', '[]'::jsonb
    ),
    'immutable', true
  );

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'id', p_vorgang_id,
    'title', v_title,
    'customer', v_customer_name,
    'baustelle', v_baustelle,
    'status', 'beauftragt',
    'materialSource', 'unclear',
    'customerBilling', p_order->'customerBilling',
    'customerId', to_jsonb(v_customer_id),
    'orderPositions', v_positions,
    'contractConfirmation', v_conf,
    'orderNumber', v_number,
    'vorgangNumber', v_vorgang_number,
    'orderDate', v_today,
    'taxStatus', v_tax_status,
    'paymentTermsText', p_order->'paymentTermsText',
    'introText', p_order->'introText',
    'closingText', p_order->'closingText',
    'contractTotals', v_totals
  ));

  insert into public.workspace_vorgaenge (workspace_id, vorgang_id, payload, row_version, deleted, updated_by, source_offer_id, order_number, vorgang_number)
  values (p_workspace_id, p_vorgang_id, v_payload, 1, false, auth.uid(), null, v_number, v_vorgang_number)
  returning * into v_vorgang;

  /*
   * CLOUD-SYNC S6 -- der Entwurf wird in derselben Transaktion verbraucht: Es
   * gibt keinen Zwischenstand, in dem der Auftrag existiert und sein Entwurf
   * noch aktiv ist. Gebunden nur genau in der erwarteten Version; ungebunden
   * (Client ohne Cloud-Entwurf) jede noch aktive Zeile dieser Kennung. Der
   * verbrauchte Entwurf traegt keinen Inhalt mehr -- der Auftrag ist jetzt
   * die Wahrheit. Scheitert das, rollt die ganze Anlage zurueck, die Nummer
   * eingeschlossen.
   */
  if v_has_order_draft and v_order_draft.status = 'active' and not v_order_draft.deleted then
    update public.workspace_order_drafts
    set
      status = 'consumed',
      consumed_vorgang_id = p_vorgang_id,
      payload = '{}'::jsonb,
      row_version = row_version + 1,
      updated_by = auth.uid()
    where workspace_id = p_workspace_id and client_draft_id = p_vorgang_id
      and status = 'active' and not deleted
      and (v_draft_id is null or row_version = p_expected_draft_row_version);
    if not found then
      raise exception 'order_draft_consume_failed' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object('vorgang', to_jsonb(v_vorgang), 'replayed', false);
end;
$$;

/* 11 -- SQL-18 */
create or replace function public.normalize_workspace_invoice_payload_for_idempotency(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(p_payload, '{}'::jsonb)
    - 'number'
    - 'invoiceSequenceNumber'
    - 'invoice_sequence_number'
    - 'payments'
    - 'paymentStatus'
    - 'payment_status'
    - 'archiveDocumentId'
    - 'archive_document_id'
    - 'expectedAmendmentSequence'
    - 'expected_amendment_sequence'
    - 'cancelledAt'
    - 'cancelled_at'
    - 'cancelReason'
    - 'cancel_reason'
    - 'cancelledBy'
    - 'cancelled_by'
    /*
     * FINANZ-CORE-01A (SQL-18) -- auch Versand- und Korrekturstand entstehen
     * erst nach der Freigabe. Nach einem Versandvermerk scheiterte die
     * Wiederholung derselben Freigabe als Idempotenzkonflikt, weil `status`
     * und `sentAt` mitverglichen wurden. Die Freigabe setzt `status` selbst
     * ("vorbereitet"); ein Client kann darueber keinen Versandstand einschleusen.
     */
    - 'status'
    - 'sentAt'
    - 'sentVia'
    - 'sentNote'
    - 'sentSource'
    - 'sentDeliveryId'
    - 'sentManualPrior'
    - 'cancellationKind'
    - 'correctionDocumentId'
    - 'correctionNumber';
$$;

/* 12 -- ANG-09: Versandauftrag */
create or replace function public.create_workspace_document_delivery(
  p_workspace_id uuid,
  p_client_delivery_id text,
  p_document_kind text,
  p_linked_invoice_id text,
  p_recipient_email text,
  p_subject text,
  p_body_text text,
  p_attachment_storage_path text,
  p_attachment_sha256 text,
  p_attachment_size_bytes bigint,
  p_attachment_filename text,
  p_attachment_mime_type text,
  p_provider text,
  p_retry_of_delivery_id uuid default null,
  p_linked_document_id text default null,
  p_confirm_uncertain_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_delivery_id text;
  v_document_kind text;
  v_linked_invoice_id text;
  v_linked_document_id text;
  v_recipient text;
  v_subject text;
  v_body text;
  v_path text;
  v_sha text;
  v_filename text;
  v_mime text;
  v_provider text;
  v_invoice public.workspace_invoices;
  v_document public.workspace_documents;
  v_document_classified text;
  v_expected_kind text;
  v_existing public.workspace_document_deliveries;
  v_retry_of public.workspace_document_deliveries;
  v_attempt integer := 1;
  v_row public.workspace_document_deliveries;
  -- Missbrauchsschutz: neue Versandauftraege im gleitenden Fenster.
  v_rate_window interval := interval '10 minutes';
  v_rate_limit_user integer := 20;
  v_rate_limit_workspace integer := 60;
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
  -- Versand ist Aussenkommunikation im Namen des Betriebs: Schreibrecht (owner/admin).
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_client_delivery_id := nullif(btrim(coalesce(p_client_delivery_id, '')), '');
  if v_client_delivery_id is null or length(v_client_delivery_id) > 128 then
    raise exception 'client_delivery_id ungueltig';
  end if;

  v_document_kind := nullif(btrim(coalesce(p_document_kind, '')), '');
  if v_document_kind is null or v_document_kind not in ('invoice', 'invoice_correction', 'letter', 'offer', 'other') then
    raise exception 'document_kind nicht unterstuetzt';
  end if;

  v_linked_invoice_id := nullif(btrim(coalesce(p_linked_invoice_id, '')), '');
  v_linked_document_id := nullif(btrim(coalesce(p_linked_document_id, '')), '');
  if v_document_kind in ('invoice', 'invoice_correction') then
    if v_linked_invoice_id is null then
      raise exception 'linked_invoice_id fehlt';
    end if;
  else
    -- V1-B2: normales Dokument — Bezug ist das archivierte Dokument, nie eine Rechnung.
    if v_linked_document_id is null then
      raise exception 'linked_document_id fehlt';
    end if;
    if v_linked_invoice_id is not null then
      raise exception 'linked_invoice_id nicht zulaessig';
    end if;
  end if;

  v_recipient := lower(btrim(coalesce(p_recipient_email, '')));
  if v_recipient = '' or length(v_recipient) > 254
     or v_recipient !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'recipient_email ungueltig';
  end if;

  v_subject := nullif(btrim(coalesce(p_subject, '')), '');
  if v_subject is null or length(v_subject) > 255 then
    raise exception 'subject ungueltig';
  end if;
  v_body := coalesce(p_body_text, '');
  if btrim(v_body) = '' or length(v_body) > 20000 then
    raise exception 'body_text ungueltig';
  end if;

  v_provider := nullif(btrim(coalesce(p_provider, '')), '');
  if v_provider is null or v_provider not in ('brevo', 'stub') then
    raise exception 'provider ungueltig';
  end if;

  -- Anhang: Pflicht fuer Rechnungsdokumente, Pfad im eigenen Workspace, Hash + Groesse + PDF.
  v_path := nullif(btrim(coalesce(p_attachment_storage_path, '')), '');
  v_sha := lower(nullif(btrim(coalesce(p_attachment_sha256, '')), ''));
  v_filename := nullif(btrim(coalesce(p_attachment_filename, '')), '');
  v_mime := nullif(btrim(coalesce(p_attachment_mime_type, '')), '');
  if v_path is null or v_sha is null or v_filename is null or v_mime is null or p_attachment_size_bytes is null then
    raise exception 'attachment unvollstaendig';
  end if;
  if public.document_delivery_attachment_workspace_id(v_path) is distinct from p_workspace_id then
    raise exception 'attachment_storage_path ungueltig';
  end if;
  if split_part(v_path, '/', 3) <> v_sha || '.pdf' then
    raise exception 'attachment_sha256 passt nicht zum Pfad';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'attachment_sha256 ungueltig';
  end if;
  if p_attachment_size_bytes <= 0 or p_attachment_size_bytes > 10485760 then
    raise exception 'attachment_size_bytes ungueltig';
  end if;
  if v_mime <> 'application/pdf' or v_filename !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}\.pdf$' then
    raise exception 'attachment_filename/mime ungueltig';
  end if;

  if v_document_kind in ('invoice', 'invoice_correction') then
    -- Dokument: Rechnung dieses Workspaces, finalisiert; frei oder mit Vorgang gleich.
    select * into v_invoice
    from public.workspace_invoices
    where workspace_id = p_workspace_id
      and client_invoice_id = v_linked_invoice_id;
    if v_invoice.id is null then
      raise exception 'Rechnung nicht gefunden';
    end if;
    if v_invoice.invoice_status not in ('vorbereitet', 'versendet') then
      raise exception 'Rechnung nicht finalisiert';
    end if;
    if v_document_kind = 'invoice' and v_invoice.cancelled_at is not null then
      raise exception 'Rechnung storniert';
    end if;
    if v_document_kind = 'invoice_correction'
       and (v_invoice.cancellation_kind is distinct from 'correction'
            or nullif(btrim(coalesce(v_invoice.correction_document_id, '')), '') is null) then
      raise exception 'Kein Korrekturbeleg vorhanden';
    end if;
  else
    -- V1-B2: archiviertes Dokument dieses Workspaces, nicht geloescht.
    select * into v_document
    from public.workspace_documents
    where workspace_id = p_workspace_id
      and client_document_id = v_linked_document_id
      and document_kind = 'archived_document';
    if v_document.id is null or v_document.deleted or v_document.deleted_at is not null then
      raise exception 'Dokument nicht gefunden';
    end if;
    -- Versandart muss zum Dokument passen. 07B: ein selbst verfasster
    -- Geschaeftsbrief (linkedLetterId) ist ein Brief, gleich wie er klassifiziert ist.
    v_document_classified := lower(coalesce(v_document.payload->>'classifiedKind', ''));
    v_expected_kind := case
      when nullif(btrim(coalesce(v_document.payload->>'linkedLetterId', '')), '') is not null then 'letter'
      when v_document_classified = 'brief' then 'letter'
      when v_document_classified = 'angebot' then 'offer'
      else 'other'
    end;
    if v_document_kind <> v_expected_kind then
      raise exception 'Dokumentart passt nicht zum Dokument';
    end if;
    /*
     * FINANZ-CORE-01A (ANG-09) -- ein abgelehntes, storniertes oder ersetztes
     * Angebot geht nicht mehr an den Kunden. Bisher pruefte der Versand nur die
     * Dokumentart; der Kunde erhielt ein storniertes Angebot ohne Kennzeichnung.
     */
    if v_document_kind = 'offer' and exists (
      select 1
      from public.workspace_offers o
      where o.workspace_id = p_workspace_id
        and o.client_offer_id = nullif(btrim(coalesce(v_document.payload->>'linkedOfferId', '')), '')
        and (o.deleted or o.status in ('abgelehnt', 'storniert', 'ersetzt'))
    ) then
      raise exception 'offer_not_sendable' using errcode = 'P0001';
    end if;
    -- Der Anhang muss eine an dieses Dokument gebundene PDF-Datei sein (Original oder Archiv-PDF).
    if not exists (
      select 1
      from public.workspace_document_file_bindings b
      join public.workspace_files f
        on f.workspace_id = b.workspace_id and f.client_file_ref_id = b.client_file_ref_id
      where b.workspace_id = p_workspace_id
        and b.client_document_id = v_linked_document_id
        and b.binding_kind in ('original', 'archive')
        and not b.deleted
        and not f.deleted
        and f.mime_type = 'application/pdf'
        and f.content_sha256 = v_sha
    ) then
      raise exception 'Anhang gehoert nicht zu diesem Dokument';
    end if;
  end if;

  -- Idempotenz: dieselbe Absicht -> dieselbe Delivery; abweichende Absicht -> Konflikt.
  select * into v_existing
  from public.workspace_document_deliveries
  where workspace_id = p_workspace_id
    and client_delivery_id = v_client_delivery_id
  for update;
  if v_existing.id is not null then
    if v_existing.document_kind <> v_document_kind
       or v_existing.linked_invoice_id is distinct from v_linked_invoice_id
       or v_existing.linked_document_id is distinct from v_linked_document_id
       or v_existing.recipient_email <> v_recipient
       or v_existing.subject <> v_subject
       or v_existing.body_text <> v_body
       or v_existing.attachment_sha256 is distinct from v_sha then
      raise exception 'Idempotenzkonflikt: client_delivery_id mit abweichendem Inhalt';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'delivery', to_jsonb(v_existing));
  end if;

  -- Bewusster Retry: nach serverseitig bestaetigtem Fehlschlag, oder — 07B —
  -- nach `unknown` nur mit ausdruecklicher Bestaetigung der moeglichen Doppelzustellung.
  if p_retry_of_delivery_id is not null then
    select * into v_retry_of
    from public.workspace_document_deliveries
    where id = p_retry_of_delivery_id
      and workspace_id = p_workspace_id;
    if v_retry_of.id is null then
      raise exception 'retry_of_delivery_id nicht gefunden';
    end if;
    if v_retry_of.document_kind <> v_document_kind
       or v_retry_of.linked_invoice_id is distinct from v_linked_invoice_id
       or v_retry_of.linked_document_id is distinct from v_linked_document_id then
      raise exception 'retry_of_delivery_id gehoert zu einem anderen Dokument';
    end if;
    if v_retry_of.status = 'unknown' then
      if not coalesce(p_confirm_uncertain_retry, false) then
        -- V1-B1: ohne Bestaetigung weiterhin gesperrt (moegliche Doppelzustellung).
        raise exception 'Erneuter Versand nicht moeglich: Versandstatus unklar';
      end if;
      -- Hoechstens ein laufender bestaetigter Neuversuch je unklarem Versuch.
      if exists (
        select 1
        from public.workspace_document_deliveries c
        where c.workspace_id = p_workspace_id
          and c.retry_of_delivery_id = v_retry_of.id
          and c.status not in ('failed', 'rejected')
      ) then
        raise exception 'Erneuter Versand zu diesem unklaren Versuch wurde bereits angelegt';
      end if;
    elsif v_retry_of.status not in ('failed', 'rejected', 'bounced') then
      raise exception 'Erneuter Versand nur nach Fehlschlag';
    end if;
    v_attempt := v_retry_of.attempt_number + 1;
  end if;

  -- 07B — Missbrauchsschutz. Replays sind oben bereits zurueckgekehrt und
  -- zaehlen nicht. Keine dauerhafte Sperre: das Fenster gleitet.
  if (
    select count(*)
    from public.workspace_document_deliveries d
    where d.workspace_id = p_workspace_id
      and d.requested_by = v_user_id
      and d.requested_at > now() - v_rate_window
  ) >= v_rate_limit_user
  or (
    select count(*)
    from public.workspace_document_deliveries d
    where d.workspace_id = p_workspace_id
      and d.requested_at > now() - v_rate_window
  ) >= v_rate_limit_workspace then
    raise exception 'Versandlimit erreicht: bitte in einigen Minuten erneut versuchen';
  end if;

  insert into public.workspace_document_deliveries (
    workspace_id, client_delivery_id, document_kind, linked_invoice_id, linked_document_id,
    recipient_email, subject, body_text,
    attachment_storage_path, attachment_sha256, attachment_size_bytes, attachment_filename, attachment_mime_type,
    provider, status, requested_by, requested_at, retry_of_delivery_id, attempt_number
  ) values (
    p_workspace_id, v_client_delivery_id, v_document_kind, v_linked_invoice_id, v_linked_document_id,
    v_recipient, v_subject, v_body,
    v_path, v_sha, p_attachment_size_bytes, v_filename, v_mime,
    v_provider, 'queued', v_user_id, now(), p_retry_of_delivery_id, v_attempt
  )
  returning * into v_row;

  return jsonb_build_object('outcome', 'created', 'delivery', to_jsonb(v_row));
end;
$$;

/* 13 -- SQL-15: Versandvermerk */
CREATE OR REPLACE FUNCTION public.update_workspace_invoice_sent(p_workspace_id uuid, p_client_invoice_id text, p_sent_at text, p_sent_via text, p_sent_note text DEFAULT NULL::text)
 RETURNS SETOF workspace_invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_sent_at text;
  v_sent_via text;
  v_sent_note text;
  v_sent_source text;
  v_updated public.workspace_invoices;
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
   * GO-LIVE-SECURITY-01 — Der Versandvermerk setzt eine festgeschriebene
   * Rechnung auf "versendet" und bewegt damit Fristen und Archivschutz. Das ist
   * Verwaltung wie Finalisieren (R1-SEC-01) und der Versand selbst
   * (send-document): Inhaber oder Admin, nicht jedes Mitglied.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS R6 — gueltige Berechtigung wie beim
   * Festschreiben: freigegebenes, nicht gesperrtes Konto mit aktiver Lizenz.
   * Nach der Rollenpruefung, damit ein Mitglied weiterhin 42501 erhaelt.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_sent_at := nullif(trim(coalesce(p_sent_at, '')), '');
  if v_sent_at is null then
    raise exception 'sent_at fehlt';
  end if;
  if v_sent_at !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'sent_at ungueltig';
  end if;
  begin
    perform v_sent_at::date;
  exception
    when others then
      raise exception 'sent_at ungueltig';
  end;

  /*
   * FINANZ-CORE-01A (SQL-15) -- ein Versanddatum liegt nicht in der Zukunft
   * (ein Tag Spielraum fuer Geraeteuhren um Mitternacht).
   */
  if v_sent_at::date > (timezone('Europe/Berlin', now()))::date + 1 then
    raise exception 'sent_at ungueltig: Zukunft';
  end if;

  v_sent_via := nullif(trim(coalesce(p_sent_via, '')), '');
  if v_sent_via is null or v_sent_via not in ('email', 'post', 'persoenlich', 'portal', 'sonstige') then
    raise exception 'sent_via ungueltig';
  end if;

  v_sent_note := nullif(trim(coalesce(p_sent_note, '')), '');

  select * into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = trim(p_client_invoice_id)
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  if v_existing.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS R5 — eine stornierte Rechnung, die nicht
   * versendet war (interne Stornierung ohne Korrekturbeleg), wird nicht
   * nachtraeglich versendet. Sonst entstuende "versendet und storniert" ohne
   * Korrekturbeleg. Versandangaben einer bereits versendeten Rechnung bleiben
   * korrigierbar.
   */
  if v_existing.cancelled_at is not null and v_existing.invoice_status is distinct from 'versendet' then
    raise exception 'invoice_cancelled: Eine stornierte Rechnung wird nicht mehr als versendet vermerkt'
      using errcode = '22023';
  end if;

  -- Herkunft: bleibt officepilot, wenn ein OfficePilot-Versand die Wahrheit gesetzt hat.
  /*
   * FINANZ-CORE-01A (AUS-19) -- weicht ein manueller Vermerk von einem OfficeTakt-Versand ab
   * (etwa per Post nach einem Ruecklauf), ist die neue Wahrheit manuell. Bisher blieb die
   * Herkunft "officepilot", waehrend Datum und Weg schon manuell waren. Der E-Mail-Versand
   * bleibt in der Versandhistorie belegt. Dieselben Daten (Wiederholung, Abgleich) aendern
   * die Herkunft nicht.
   */
  if v_existing.sent_source = 'officepilot'
     and (v_existing.payload->>'sentAt' is distinct from v_sent_at
          or v_existing.payload->>'sentVia' is distinct from v_sent_via) then
    v_sent_source := 'manual';
  else
    v_sent_source := coalesce(v_existing.sent_source, 'manual');
  end if;

  /*
   * Monotonie unveraendert (04B1-Hardening): 'versendet' ist ein Endzustand,
   * Versandangaben duerfen korrigiert werden; RETURNING + Nachbedingungen wie
   * bisher. Neu ist ausschliesslich die Herkunft (sent_source / sentSource).
   */
  update public.workspace_invoices
  set
    invoice_status = 'versendet',
    sent_source = v_sent_source,
    payload = case
      when v_sent_note is null then
        (payload - 'sentNote')
          || jsonb_build_object('status', 'versendet', 'sentAt', v_sent_at, 'sentVia', v_sent_via, 'sentSource', v_sent_source)
      else
        payload
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_sent_at,
            'sentVia', v_sent_via,
            'sentNote', v_sent_note,
            'sentSource', v_sent_source
          )
    end,
    row_version = row_version + 1,
    updated_at = now(),
    updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null then
    raise exception 'Sent-Update nicht angewendet';
  end if;

  if v_updated.invoice_status is distinct from 'versendet' then
    raise exception 'Sent-Update Nachbedingung verletzt: invoice_status';
  end if;
  if v_updated.payload->>'status' is distinct from 'versendet' then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.status';
  end if;
  if v_updated.payload->>'sentAt' is distinct from v_sent_at then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.sentAt';
  end if;
  if v_updated.payload->>'sentVia' is distinct from v_sent_via then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.sentVia';
  end if;
  if v_sent_note is null then
    if v_updated.payload ? 'sentNote' then
      raise exception 'Sent-Update Nachbedingung verletzt: sentNote vorhanden';
    end if;
  else
    if v_updated.payload->>'sentNote' is distinct from v_sent_note then
      raise exception 'Sent-Update Nachbedingung verletzt: payload.sentNote';
    end if;
  end if;

  return next v_updated;
end;
$function$;

/* 14 -- SQL-16 */
create or replace function public.set_workspace_invoice_number_format(
  p_workspace_id uuid,
  p_prefix text,
  p_year_in_number boolean,
  p_padding integer,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  -- FINANZ-CORE-01A (ANG-15/SQL-15) -- das laufende Jahr ist das des Geschaeftstags.
  v_year integer := extract(year from timezone('Europe/Berlin', now()))::integer;
  v_seq public.workspace_invoice_sequences;
  v_current bigint;
  v_row public.workspace_invoice_number_formats;
begin
  /*
   * FINANZ-CORE-01A (SQL-16) -- dieselbe Autorisierung wie jede andere
   * Finanzaktion (R1-SEC-01): Rolle, Kontosperre und Lizenz vor allem anderen.
   * Das Nummernformat bestimmt jede kuenftige Rechnungsnummer.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  perform public.validate_workspace_invoice_number_format(p_prefix, p_year_in_number, p_padding);

  /*
   * Jahres-Sperre im selben Sperrbereich wie die Nummernvergabe: Die Sequenz-
   * zeile des laufenden Jahres wird angelegt/gesperrt, damit sich eine
   * parallel laufende erste Finalisierung dieses Jahres gegen die Aenderung
   * serialisiert (kein halber Zustand).
   *
   * 01C2 -- Jahresregel: Ein Jahr mit Nummern bleibt unveraenderlich, weil es
   * seine EINGEFRORENE Kopie traegt. Das Standardformat darf deshalb auch
   * waehrend eines gesperrten Jahres geaendert werden; es wirkt ausschliesslich
   * auf Jahre ohne Nummern (das naechste unbenutzte Jahr friert es bei seiner
   * ersten Nummer ein). `effective_from_year` benennt das erste Jahr, fuer das
   * die Einstellung gilt.
   */
  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select * into v_seq from public.workspace_invoice_sequences
  where workspace_id = p_workspace_id and invoice_year = v_year
  for update;

  select row_version into v_current from public.workspace_invoice_number_formats
  where workspace_id = p_workspace_id for update;

  if v_current is null then
    insert into public.workspace_invoice_number_formats (workspace_id, number_prefix, year_in_number, number_padding, row_version, updated_by)
    values (p_workspace_id, p_prefix, p_year_in_number, p_padding, 1, v_user_id)
    returning * into v_row;
  else
    if p_row_version > 0 and p_row_version <> v_current then
      raise exception 'Versionskonflikt invoice_number_format:%', v_current using errcode = 'P0001';
    end if;
    update public.workspace_invoice_number_formats
    set number_prefix = p_prefix,
        year_in_number = p_year_in_number,
        number_padding = p_padding,
        row_version = row_version + 1,
        updated_by = v_user_id
    where workspace_id = p_workspace_id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'prefix', v_row.number_prefix,
    'year_in_number', v_row.year_in_number,
    'padding', v_row.number_padding,
    'row_version', v_row.row_version,
    'current_year', v_year,
    'current_year_locked', v_seq.format_locked_at is not null,
    'effective_from_year', case when v_seq.format_locked_at is not null then v_year + 1 else v_year end
  );
end;
$$;

/*
 * FINANZ-CORE-01A (SQL-16) -- die Formatfunktion friert beim ersten Beleg
 * eines Jahres das Format ein (sie schreibt) und prueft selbst keine
 * Mitgliedschaft. Sie wird nur aus den Freigabe- und Stornofunktionen gerufen
 * (security definer); direkt ausfuehren darf sie niemand mehr.
 */
revoke all on function public.format_workspace_invoice_number(uuid, integer, integer) from public, anon, authenticated;

/* 15 -- SQL-08 */
/*
 * FINANZ-CORE-01A (SQL-08) -- die Werteliste der Rechnungsart an der Tabelle
 * selbst.
 *
 * Nur, wenn der Bestand es zulaesst: Remote ist er hier nicht einsehbar. Gibt
 * es Zeilen ausserhalb der Liste, wird die Regel nicht angelegt (NOTICE) --
 * die Freigabe prueft die Rechnungsart unabhaengig davon
 * (assert_workspace_invoice_integrity).
 *
 * Bewusst KEIN Fremdschluessel Zahlung -> Rechnung: Clients schreiben beide
 * Tabellen nie direkt (RLS kennt nur SELECT), und der einzige Schreibweg
 * add_workspace_invoice_payment verlangt die Rechnung unter Sperre. Ein
 * Fremdschluessel schuetzte nur gegen Wartungs- und Testschreibwege und
 * brach deren Fixtures (P1MA).
 */
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_invoices_invoice_type_check') then
    if exists (
      select 1
      from public.workspace_invoices
      where invoice_type not in ('rechnung', 'abschlag', 'teilrechnung', 'schluss')
    ) then
      raise notice 'FINANZ-CORE-01A (SQL-08): Altbestand mit anderer Rechnungsart -- CHECK nicht angelegt';
    else
      alter table public.workspace_invoices
        add constraint workspace_invoices_invoice_type_check
        check (invoice_type in ('rechnung', 'abschlag', 'teilrechnung', 'schluss'));
    end if;
  end if;
end;
$do$;

/* 16 -- SQL-17 */
/*
 * FINANZ-CORE-01A (SQL-17) -- der Mahnnachweis an der Tabellengrenze.
 *
 * Der Nachweis entsteht ausschliesslich ueber upsert_workspace_sync_entity
 * (Zweig dunning_documentation). Dort prueft der Server nur die Sync-Struktur:
 * Der Versandweg war frei, die Rechnung musste nicht freigegeben sein. Ein
 * Trigger statt einer weiteren Fassung der Sync-Funktion (rund 2800 Zeilen):
 * dieselbe Regel, ohne den Sync-Vertrag anzufassen.
 *
 *   - Weg: dieselbe Liste wie beim Versandvermerk (update_workspace_invoice_sent,
 *     isValidInvoiceSentVia im Client).
 *   - Datum: nicht in der Zukunft (ein Tag Spielraum).
 *   - Rechnung: Ist sie in der Cloud bekannt, muss sie freigegeben sein. Eine
 *     unbekannte Kennung bleibt erlaubt (Altbestand ohne Cloud-Zeile): Der
 *     Nachweis ist eine Tatsache und haengt bewusst nicht hart an Fachdaten
 *     (20260925); ein spaeterer Storno nimmt ihn nicht mit.
 *
 * Zwei gleichzeitige erste Pushes derselben Uebergabe: Der zweite scheitert am
 * Eindeutigkeitsindex (23505), die Sync-Warteschlange wiederholt ihn, und die
 * Wiederholung findet die Zeile ueber die fachliche Identitaet (deduped).
 */
create or replace function public.guard_workspace_dunning_documentation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  if new.delivery_method is null
     or new.delivery_method not in ('email', 'post', 'persoenlich', 'portal', 'sonstige') then
    raise exception 'Mahnnachweis ungueltig: delivery_method' using errcode = 'P0001';
  end if;
  if new.documented_at > (timezone('Europe/Berlin', now()))::date + 1 then
    raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
  end if;
  select wi.invoice_status
  into v_status
  from public.workspace_invoices wi
  where wi.workspace_id = new.workspace_id
    and wi.client_invoice_id = new.client_invoice_id;
  if found and v_status not in ('vorbereitet', 'versendet') then
    raise exception 'Mahnnachweis ungueltig: Rechnung nicht freigegeben' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_workspace_dunning_documentation() from public, anon, authenticated;

drop trigger if exists workspace_dunning_documentation_guard on public.workspace_invoice_dunning_documentations;
create trigger workspace_dunning_documentation_guard
  before insert on public.workspace_invoice_dunning_documentations
  for each row execute function public.guard_workspace_dunning_documentation();

/* 17 -- ZAH-03: Bankbewegung mit erfasster Zahlung verknuepfen */
/*
 * FINANZ-CORE-01A (ZAH-03) -- eine Bankbewegung mit einer bereits erfassten Zahlung verknuepfen.
 *
 * Bisher kannte der Bankabgleich nur einen Weg: bestaetigen, und dabei eine NEUE Zahlung
 * anlegen. War der Eingang schon von Hand erfasst, bot er ihn als (Teil-)Zahlung an -- eine
 * Bestaetigung buchte ihn zum zweiten Mal. Bei einer von Hand voll bezahlten Rechnung blieb
 * die Bewegung dauerhaft offen.
 *
 * Diese Funktion legt KEINE Zahlung an. Sie haelt fest: genau diese Bewegung belegt genau
 * diese, schon vorhandene Zahlung. Dieselbe Tabelle, dieselben Eindeutigkeiten, dieselbe
 * Autorisierung wie confirm_workspace_bank_reconciliation. Wird die Zahlung spaeter
 * storniert, gibt reverse_workspace_*_payment die Bewegung in derselben Transaktion wieder
 * frei (BANKABGLEICH BLOCK 5) -- die Semantik bleibt eine Zuordnung je Zahlung.
 *
 * Bedingungen: Richtung wie beim Bestaetigen, Zahlung vorhanden, nicht storniert, Betrag
 * centgenau gleich der Bewegung, die Zahlung belegt noch keine andere Bewegung.
 */
create or replace function public.link_workspace_bank_reconciliation(
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
  v_amount_cents bigint;
  v_payment_amount numeric;
  v_payment_reversed timestamptz;
  v_payment_found boolean := false;
begin
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

  -- Dieselbe Sperrreihenfolge wie beim Bestaetigen: zuerst die Bewegung.
  select * into v_transaction
  from public.workspace_bank_transactions
  where workspace_id = p_workspace_id
    and client_transaction_id = p_bank_transaction_id
  for update;

  if v_transaction.id is null then
    raise exception 'Bankbewegung nicht gefunden';
  end if;
  v_amount_cents := abs(v_transaction.amount_cents);

  if p_target_type = 'invoice' and v_transaction.amount_cents <= 0 then
    raise exception 'Falsche Richtung: eine Ausgangsrechnung braucht einen Zahlungseingang';
  end if;
  if p_target_type = 'expense' and v_transaction.amount_cents >= 0 then
    raise exception 'Falsche Richtung: eine Ausgabe braucht einen Zahlungsausgang';
  end if;

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

  -- Dann das Ziel (wie Zahlung und Storno), dann die Zahlung.
  if p_target_type = 'invoice' then
    perform 1 from public.workspace_invoices
    where workspace_id = p_workspace_id and client_invoice_id = p_client_target_id
    for update;
    select true, amount, reversed_at
    into v_payment_found, v_payment_amount, v_payment_reversed
    from public.workspace_invoice_payments
    where workspace_id = p_workspace_id
      and client_invoice_id = p_client_target_id
      and client_payment_id = p_client_payment_id;
  else
    perform 1 from public.workspace_expenses
    where workspace_id = p_workspace_id and client_expense_id = p_client_target_id
    for update;
    select true, amount, reversed_at
    into v_payment_found, v_payment_amount, v_payment_reversed
    from public.workspace_expense_payments
    where workspace_id = p_workspace_id
      and client_expense_id = p_client_target_id
      and client_payment_id = p_client_payment_id;
  end if;

  if not coalesce(v_payment_found, false) then
    raise exception 'Zahlung nicht gefunden';
  end if;
  if v_payment_reversed is not null then
    raise exception 'Zahlung storniert';
  end if;
  if round(v_payment_amount * 100) <> v_amount_cents then
    raise exception 'Betrag der Zahlung passt nicht zur Bankbewegung';
  end if;
  if exists (
    select 1 from public.workspace_bank_reconciliations
    where workspace_id = p_workspace_id
      and target_type = p_target_type
      and client_target_id = p_client_target_id
      and client_payment_id = p_client_payment_id
  ) then
    raise exception 'Zahlung bereits einer Bankbewegung zugeordnet';
  end if;

  insert into public.workspace_bank_reconciliations (
    workspace_id, client_reconciliation_id, bank_transaction_id,
    target_type, client_target_id, client_payment_id,
    amount_cents, paid_on, confirmed_by, created_by, updated_by, payload
  )
  values (
    p_workspace_id, p_client_reconciliation_id, p_bank_transaction_id,
    p_target_type, p_client_target_id, p_client_payment_id,
    v_amount_cents, v_transaction.booking_date, v_user_id, v_user_id, v_user_id,
    jsonb_build_object(
      'bankTransactionId', p_bank_transaction_id,
      'targetType', p_target_type,
      'targetId', p_client_target_id,
      'paymentId', p_client_payment_id,
      'amountCents', v_amount_cents,
      'paidOn', v_transaction.booking_date,
      'linkedExistingPayment', true
    )
  )
  returning * into v_inserted;

  return jsonb_build_object('reconciliation', to_jsonb(v_inserted), 'replayed', false);
end;
$$;

revoke all on function public.link_workspace_bank_reconciliation(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.link_workspace_bank_reconciliation(uuid, text, text, text, text, text) to authenticated;

/* 18 -- N06: Kontierung bestaetigt nur mit geklaerter Steuer */
create or replace function public.validate_workspace_accounting_payload(p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_status text;
  v_origin text;
  v_chart text;
  v_account text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'accounting_payload_invalid: kein Objekt' using errcode = 'P0001';
  end if;

  v_status := p_payload->>'status';
  if v_status is null
     or v_status not in ('needs_review', 'confirmed', 'needs_clarification') then
    raise exception 'accounting_status_invalid: %', coalesce(v_status, '(fehlt)')
      using errcode = 'P0001';
  end if;

  v_origin := p_payload->>'origin';
  if v_origin is null or v_origin not in ('suggested', 'manual') then
    raise exception 'accounting_origin_invalid: %', coalesce(v_origin, '(fehlt)')
      using errcode = 'P0001';
  end if;

  v_chart := p_payload->>'chartOfAccounts';
  if v_chart is null or v_chart not in ('SKR03', 'SKR04') then
    raise exception 'accounting_chart_invalid: %', coalesce(v_chart, '(fehlt)')
      using errcode = 'P0001';
  end if;

  if v_status = 'confirmed' then
    /*
     * Die beiden Regeln, die der Workflow braucht. Eine bestaetigte Kontierung
     * ohne Sachkonto waere eine gruene Zeile ohne Buchung; eine ohne Zeitpunkt
     * liesse sich spaeter nicht belegen.
     */
    v_account := nullif(trim(coalesce(p_payload->>'accountNumber', '')), '');
    if v_account is null then
      raise exception 'accounting_confirmed_without_account: Sachkonto fehlt'
        using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_payload->>'confirmedAt', '')), '') is null then
      raise exception 'accounting_confirmed_without_timestamp: confirmedAt fehlt'
        using errcode = 'P0001';
    end if;
    /*
     * FINANZ-CORE-01A (N06) -- eine bestaetigte, exportfaehige Kontierung traegt eine
     * geklaerte Steuerbehandlung. "unclear" ist eine offene Frage, keine Behandlung;
     * bestaetigt versteckte sie sich hinter einem gruenen Haken.
     */
    if coalesce(p_payload->>'taxTreatment', '') not in
       ('standard_19', 'standard_7', 'kleinunternehmer_19', 'reverse_charge_13b', 'tax_free') then
      raise exception 'accounting_confirmed_without_tax: Steuerbehandlung ungeklaert'
        using errcode = 'P0001';
    end if;
  end if;
end;
$$;
