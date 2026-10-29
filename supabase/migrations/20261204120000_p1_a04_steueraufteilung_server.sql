-- P1-KORREKTUR A-04 (WEISS-Restfehler A04-WEISS-R1 und A04-WEISS-R2) -- die Steueraufteilung einer Ausgabe im
-- Serververtrag und Abschlussfassung 6.
--
-- ENTWURF -- erst nach ausdruecklicher Freigabe nach supabase/migrations uebernehmen und ausfuehren. Erzeugt von
-- pruefunterlagen/p1-korrektur-a04-a02/werkzeug/erzeuge-migration-a04.mjs aus den zuletzt angewendeten Fassungen
-- (20261120 upsert_workspace_expense, add_workspace_expense_payment; 20261023 upsert_workspace_accounting_assignment;
-- 20261123 close_workspace_accounting_period, workspace_fc_abschluss_projektion, workspace_fc_manifest_text). Keine
-- bestehende Migration wird veraendert; diese Datei ersetzt Funktionen mit unveraenderter Signatur und legt neue an.
--
-- R1 -- bisher kannte der Server die Steueraufteilung nicht: Ein Altclient verlor beim Laden/Speichern das Kennzeichen
--       "offen", und die Platzhalter (Netto = Brutto, 0 Steuer) erschienen danach wieder als Nullsteuer. Ab hier:
--         * Ein Schreibstand ohne Kennzeichen `taxSplitSchema` uebernimmt die gespeicherte Aufteilung (taxSplit,
--           inputTaxDeduction, deductibleTaxAmount) statt sie zu verlieren.
--         * Neue Geldangaben ohne Kennzeichen und ohne Aufteilung mit Platzhaltern bei Regel-/unklarem Status werden
--           als "offen" gespeichert (nie als bestaetigte Nullsteuer). Unveraenderter Altbestand bleibt exakt.
--         * Pruefung der Aufteilung bei neuer Zeile, Geldaenderung oder geaenderter Aufteilung:
--           offen nur mit Platzhaltern, bei Regel-/unklarem Status und ohne Auftragszuordnung; belegt/gemischt mit
--           0 Steuer bei 19 %/7 % abgewiesen; gemischt/offen nicht bei Status ohne Umsatzsteuer; Vorsteuerabzug nur zu
--           belegter Steuer, "teilweise" mit Betrag zwischen 0 und Steuer (gleiches Vorzeichen).
--         * Keine neue Zahlung (auch Bankabgleich) und keine Kontierungsbestaetigung bei offener Aufteilung; kein
--           Monatsabschluss mit nicht stornierter offener Ausgabe.
-- R2 -- Aufteilungsart, Vorsteuerabzug und abziehbarer Betrag waren nicht an die Abschlussrevision gebunden. Ab hier:
--         * Abschlussfassung 6 (p6:<sha256>): Fassung 5 und je E-Zeile die drei Merkmale, identisch mit
--           src/services/accounting/accountingPeriodManifestV6.ts. Neue Revisionen nur noch in Fassung 6.
--         * Bestehende Revisionen (Fassung 1-5) bleiben unveraendert gespeichert und lesbar (validated_version 5 bzw.
--           leer). Fuer Monate mit einer aktiven Revision dieser Fassungen ist eine Aenderung der drei Merkmale
--           gesperrt (expense_tax_split_closed_period); Korrekturweg: Monat wieder oeffnen, neue Revision.
--
-- Datenaenderung: keine. Kein UPDATE/DELETE an Geschaeftsdaten. DDL: nur die Pruefbedingung der Abschlussrevisionen
-- (zusaetzlich validated_version = 6 mit p6:). Bestehende Zeilen erfuellen die neue Bedingung unveraendert.
--
-- Rueckwaertskompatibilitaet: Clients vor dieser Fassung schreiben weiter; sie verlieren die Aufteilung nicht mehr,
-- widerspruechliche Staende und Zahlungen auf offene Aufteilungen werden endgueltig abgewiesen, Monatsabschluesse
-- alter Clients (Fassung 5) mit "closure_manifest_version_outdated" (wie bisher fuer Fassung 1-4).

/* ------------------------------------------------------------------------------------------------ */
/* 1) Pruefbedingung der Abschlussrevisionen: Fassung 5 oder 6                                       */
/* ------------------------------------------------------------------------------------------------ */

alter table public.workspace_accounting_period_closures
  drop constraint if exists workspace_accounting_period_closures_validated_check;

alter table public.workspace_accounting_period_closures
  add constraint workspace_accounting_period_closures_validated_check
  check (
    (validated_version is null and finance_revision is null and validated_at is null)
    or (validated_version = 5 and finance_revision is not null and validated_at is not null
        and fingerprint like 'p5:%')
    or (validated_version = 6 and finance_revision is not null and validated_at is not null
        and fingerprint like 'p6:%')
  );

/* ------------------------------------------------------------------------------------------------ */
/* 2) Die Steueraufteilung einer gespeicherten Nutzlast -- exakt wie der Client                      */
/*    (src/services/expense/expenseTaxSplit.ts, expenseNormalize.ts)                                  */
/* ------------------------------------------------------------------------------------------------ */

/* Steuerstatus wie normalizeExpense bzw. die Fassung-5-Projektion: fehlend -> standard_19, kein Text -> leer. */
create or replace function public.workspace_expense_steuerstatus(p_payload jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when jsonb_typeof(p_payload->'taxStatus') = 'string' then p_payload->>'taxStatus'
    when coalesce(jsonb_typeof(p_payload->'taxStatus'), 'null') = 'null' then 'standard_19'
    else ''
  end;
$$;

/*
 * Brutto, Netto, Steuer in Cent wie die Fassung-5-Projektion (rx): Brutto aus grossAmount (sonst amount, sonst 0),
 * fehlendes Netto = Brutto, fehlende Steuer = max(0, Brutto - Netto). Gerundet wie toCents (halb weg von null).
 */
create or replace function public.workspace_expense_betraege_cent(
  p_payload jsonb,
  out brutto bigint,
  out netto bigint,
  out steuer bigint
)
language sql
immutable
set search_path = public
as $$
  select g.b, n.n,
         case when jsonb_typeof(p_payload->'taxAmount') = 'number'
              then round((p_payload->>'taxAmount')::numeric * 100)::bigint
              else greatest(0, g.b - n.n) end
  from (
    select case
      when jsonb_typeof(p_payload->'grossAmount') = 'number' then round((p_payload->>'grossAmount')::numeric * 100)::bigint
      when coalesce(jsonb_typeof(p_payload->'grossAmount'), 'null') = 'null' and jsonb_typeof(p_payload->'amount') = 'number'
        then round((p_payload->>'amount')::numeric * 100)::bigint
      else 0::bigint
    end as b
  ) g
  cross join lateral (
    select case when jsonb_typeof(p_payload->'netAmount') = 'number'
                then round((p_payload->>'netAmount')::numeric * 100)::bigint
                else g.b end as n
  ) n;
$$;

/*
 * Der fachliche Zustand wie resolveExpenseTaxSplitState: steuerfrei (Status ohne Umsatzsteuer) | offen (nur mit
 * Platzhaltern) | gemischt | belegt | altbestand_pruefen (ohne Kennzeichen, Platzhalter bei Regel-/unklarem Status).
 * "Status ohne Umsatzsteuer" = alles ausser standard_19, standard_7, unclear (wie isZeroRateTaxStatus).
 */
create or replace function public.workspace_expense_steueraufteilung(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_status text := public.workspace_expense_steuerstatus(p_payload);
  v_b bigint;
  v_n bigint;
  v_s bigint;
  v_split text;
begin
  if v_status not in ('standard_19', 'standard_7', 'unclear') then
    return 'steuerfrei';
  end if;
  select x.brutto, x.netto, x.steuer into v_b, v_n, v_s from public.workspace_expense_betraege_cent(p_payload) x;
  v_split := case
    when jsonb_typeof(p_payload->'taxSplit') = 'string' and p_payload->>'taxSplit' in ('belegt', 'gemischt', 'offen')
      then p_payload->>'taxSplit'
  end;
  if v_split = 'offen' then
    return case when v_s = 0 and v_n = v_b then 'offen' else 'belegt' end;
  end if;
  if v_split in ('gemischt', 'belegt') then
    return v_split;
  end if;
  return case when v_s = 0 and v_n = v_b then 'altbestand_pruefen' else 'belegt' end;
end;
$$;

/* Wirksamer Vorsteuerabzug wie resolveExpenseInputTaxDeduction: nur zu belegter Steuer <> 0, sonst leer. */
create or replace function public.workspace_expense_vorsteuerabzug(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_steuer bigint;
begin
  if public.workspace_expense_steueraufteilung(p_payload) not in ('belegt', 'gemischt') then
    return '';
  end if;
  select x.steuer into v_steuer from public.workspace_expense_betraege_cent(p_payload) x;
  if v_steuer = 0 then
    return '';
  end if;
  return case
    when jsonb_typeof(p_payload->'inputTaxDeduction') = 'string' and p_payload->>'inputTaxDeduction' in ('voll', 'teilweise', 'keiner')
      then p_payload->>'inputTaxDeduction'
    else 'voll'
  end;
end;
$$;

/* Abziehbarer Betrag in Cent nur bei "teilweise" (wie normalizeExpense + expenseTaxSplitClosureAttributes), sonst null. */
create or replace function public.workspace_expense_abziehbar_cent(p_payload jsonb)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case
    when public.workspace_expense_vorsteuerabzug(p_payload) = 'teilweise' and jsonb_typeof(p_payload->'deductibleTaxAmount') = 'number'
      then round((p_payload->>'deductibleTaxAmount')::numeric * 100)::bigint
  end;
$$;

/*
 * Die fachliche Pruefung einer neuen oder geaenderten Nutzlast (A04-WEISS-R1). Wirft bei Widerspruch; die Codes
 * stehen im Client als endgueltige Abweisung (syncRoleDenial: expense_tax_split_, expense_input_tax_deduction_).
 */
create or replace function public.workspace_expense_steueraufteilung_pruefen(p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_status text := public.workspace_expense_steuerstatus(p_payload);
  v_ohne_ust boolean := public.workspace_expense_steuerstatus(p_payload) not in ('standard_19', 'standard_7', 'unclear');
  v_split text;
  v_abzug text;
  v_b bigint;
  v_n bigint;
  v_s bigint;
  v_d bigint;
begin
  if p_payload ? 'taxSplit' and coalesce(jsonb_typeof(p_payload->'taxSplit'), 'null') <> 'null' then
    if jsonb_typeof(p_payload->'taxSplit') <> 'string' or p_payload->>'taxSplit' not in ('belegt', 'gemischt', 'offen') then
      raise exception 'expense_tax_split_invalid: taxSplit % ist unbekannt', p_payload->'taxSplit' using errcode = 'P0001';
    end if;
    v_split := p_payload->>'taxSplit';
  end if;
  if p_payload ? 'inputTaxDeduction' and coalesce(jsonb_typeof(p_payload->'inputTaxDeduction'), 'null') <> 'null' then
    if jsonb_typeof(p_payload->'inputTaxDeduction') <> 'string'
       or p_payload->>'inputTaxDeduction' not in ('voll', 'teilweise', 'keiner') then
      raise exception 'expense_input_tax_deduction_invalid: inputTaxDeduction % ist unbekannt', p_payload->'inputTaxDeduction'
        using errcode = 'P0001';
    end if;
    v_abzug := p_payload->>'inputTaxDeduction';
  end if;
  if p_payload ? 'deductibleTaxAmount' and coalesce(jsonb_typeof(p_payload->'deductibleTaxAmount'), 'null') <> 'null'
     and jsonb_typeof(p_payload->'deductibleTaxAmount') <> 'number' then
    raise exception 'expense_input_tax_deduction_invalid: deductibleTaxAmount ist keine Zahl' using errcode = 'P0001';
  end if;

  select x.brutto, x.netto, x.steuer into v_b, v_n, v_s from public.workspace_expense_betraege_cent(p_payload) x;

  if v_split = 'offen' then
    if v_ohne_ust then
      raise exception 'expense_tax_split_conflict: "offen" passt nicht zu Steuerstatus % ohne Umsatzsteuer', v_status
        using errcode = 'P0001';
    end if;
    if not (v_s = 0 and v_n = v_b) then
      raise exception 'expense_tax_split_conflict: "offen" verlangt Netto = Brutto und 0 Steuer (Netto %, Steuer %, Brutto % Cent) -- Netto/Steuer bitte als belegt angeben',
        v_n, v_s, v_b using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_payload->'allocations') = 'array' and jsonb_array_length(p_payload->'allocations') > 0 then
      raise exception 'expense_tax_split_open_allocations: offene Steueraufteilung mit Auftragszuordnung' using errcode = 'P0001';
    end if;
  end if;
  if v_split = 'gemischt' and v_ohne_ust then
    raise exception 'expense_tax_split_conflict: "gemischt" passt nicht zu Steuerstatus % ohne Umsatzsteuer', v_status
      using errcode = 'P0001';
  end if;
  if v_split in ('belegt', 'gemischt') and v_status in ('standard_19', 'standard_7') and v_s = 0 then
    raise exception 'expense_tax_split_zero_tax: 0 Steuer bei % ist kein belegter Wert ("offen" oder Status ohne Umsatzsteuer waehlen)',
      v_status using errcode = 'P0001';
  end if;

  if v_abzug is not null then
    if coalesce(v_split, '') not in ('belegt', 'gemischt') or v_ohne_ust or v_s = 0 then
      raise exception 'expense_input_tax_deduction_conflict: Vorsteuerabzug nur zu belegter Steuer' using errcode = 'P0001';
    end if;
    if v_abzug = 'teilweise' then
      v_d := case when jsonb_typeof(p_payload->'deductibleTaxAmount') = 'number'
                  then round((p_payload->>'deductibleTaxAmount')::numeric * 100)::bigint end;
      if v_d is null or v_d = 0 or sign(v_d) <> sign(v_s) or abs(v_d) >= abs(v_s) then
        raise exception 'expense_input_tax_deduction_amount_invalid: abziehbarer Betrag % Cent bei Steuer % Cent', coalesce(v_d::text, '(fehlt)'), v_s
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  if coalesce(v_abzug, '') <> 'teilweise'
     and p_payload ? 'deductibleTaxAmount' and coalesce(jsonb_typeof(p_payload->'deductibleTaxAmount'), 'null') <> 'null' then
    raise exception 'expense_input_tax_deduction_conflict: abziehbarer Betrag nur bei "teilweise"' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.workspace_expense_steuerstatus(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_expense_betraege_cent(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_expense_steueraufteilung(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_expense_vorsteuerabzug(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_expense_abziehbar_cent(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_expense_steueraufteilung_pruefen(jsonb) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 3) Ausgabe schreiben: Erhalt, Einordnung und Pruefung der Steueraufteilung (A04-WEISS-R1/R2)       */
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
  /* P1-KORREKTUR A04-WEISS-R1/R2 */
  v_schema boolean;
  v_split_changed boolean;
  v_alte_fassung text;
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
     * (b) Neue Geldangaben ohne Kennzeichen und ohne Aufteilung: Platzhalter (Netto = Brutto, 0 Steuer) bei Regel- oder
     *     unklarem Steuerstatus sind ungeklaert -- "offen", nie eine bestaetigte Nullsteuer. Wiederholungen ohne
     *     Geldaenderung und unveraenderter Altbestand bleiben exakt, wie sie sind.
     */
    if not v_schema and not (v_payload ? 'taxSplit')
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

/* ------------------------------------------------------------------------------------------------ */
/* 4) Ausgabenzahlung: keine Zahlung auf eine offene Steueraufteilung (A04-WEISS-R1)                 */
/* ------------------------------------------------------------------------------------------------ */

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
    /*
     * P1-KORREKTUR A04-WEISS-R1 -- keine neue Zahlung auf eine offene Steueraufteilung, fuer jeden Aufrufer (auch
     * Bankabgleich, Altclient, direkter Aufruf). Wiederholungen einer bereits gespeicherten Zahlung bleiben erlaubt.
     */
    if public.workspace_expense_steueraufteilung(v_expense.payload) = 'offen' then
      raise exception 'expense_payment_tax_split_open: Steueraufteilung offen -- zuerst Netto und Vorsteuer vom Beleg eintragen'
        using errcode = 'P0001';
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

/* ------------------------------------------------------------------------------------------------ */
/* 5) Kontierung: keine Bestaetigung bei offener Steueraufteilung (A04-WEISS-R1)                     */
/* ------------------------------------------------------------------------------------------------ */

create or replace function public.upsert_workspace_accounting_assignment(
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
  v_assignment_id text;
  v_source_type text;
  v_source_id text;
  v_deleted boolean;
  v_payload jsonb;
  v_existing public.workspace_accounting_assignments;
  v_row public.workspace_accounting_assignments;
  /* P1-KORREKTUR A04-WEISS-R1 */
  v_expense public.workspace_expenses;
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

  v_assignment_id := nullif(trim(coalesce(p_payload->>'client_assignment_id', '')), '');
  if v_assignment_id is null then
    raise exception 'client_assignment_id fehlt';
  end if;

  v_source_type := nullif(trim(coalesce(p_payload->>'source_type', '')), '');
  if v_source_type is null or v_source_type not in ('expense', 'invoice') then
    raise exception 'source_type ungueltig';
  end if;

  v_source_id := nullif(trim(coalesce(p_payload->>'source_id', '')), '');
  if v_source_id is null then
    raise exception 'source_id fehlt';
  end if;

  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;
  v_payload := v_payload - 'sync';

  select * into v_existing
  from public.workspace_accounting_assignments
  where workspace_id = p_workspace_id
    and client_assignment_id = v_assignment_id
  for update;

  /*
   * Ein Grabstein traegt keine Kontierung und wird deshalb nicht geprueft —
   * sonst liesse sich eine fehlerhafte Altzeile nicht mehr entfernen.
   */
  if not v_deleted then
    perform public.validate_workspace_accounting_payload(v_payload);
  end if;

  /*
   * P1-KORREKTUR A04-WEISS-R1 -- eine Kontierung wird nicht bestaetigt, solange die Steueraufteilung ihres
   * Eingangsbelegs offen ist (auch nicht durch einen Altclient oder direkten Aufruf). Eine stornierte Ausgabe bleibt
   * bestaetigbar (sie wird nicht gebucht und laesst sich nicht mehr nachtragen); eine bereits bestaetigte Zeile, die
   * unveraendert bestaetigt bleibt (Wiederholung), ebenso.
   */
  if not v_deleted and v_source_type = 'expense'
     and v_payload->>'status' = 'confirmed'
     and (v_existing.id is null or (v_existing.payload->>'status') is distinct from 'confirmed') then
    select * into v_expense
    from public.workspace_expenses e
    where e.workspace_id = p_workspace_id
      and e.client_expense_id = v_source_id;
    if v_expense.id is not null and not v_expense.deleted and v_expense.status <> 'storniert'
       and public.workspace_expense_steueraufteilung(v_expense.payload) = 'offen' then
      raise exception 'accounting_confirm_tax_split_open: Steueraufteilung des Belegs offen -- Kontierung nicht bestaetigbar'
        using errcode = 'P0001';
    end if;
  end if;

  if v_existing.id is null then
    if v_deleted then
      -- Grabstein fuer eine Zeile, die die Cloud nie sah: nichts anzulegen.
      return jsonb_build_object('row_version', 0, 'updated_at', now(), 'deleted', true, 'noop', true);
    end if;
    insert into public.workspace_accounting_assignments (
      workspace_id, client_assignment_id, source_type, source_id,
      payload, deleted, row_version, created_by
    ) values (
      p_workspace_id, v_assignment_id, v_source_type, v_source_id,
      v_payload, false, 1, v_user_id
    )
    returning * into v_row;
  else
    if v_existing.row_version <> coalesce(p_row_version, -1) then
      raise exception 'Versionskonflikt: Kontierung % hat Version %, erwartet %',
        v_assignment_id, v_existing.row_version, p_row_version;
    end if;
    if v_existing.deleted then
      raise exception 'Kontierung bereits geloescht';
    end if;
    /*
     * Der Beleg einer Kontierung wechselt nicht. Waere das erlaubt, koennte
     * eine bestaetigte Zuordnung stillschweigend auf einen anderen Beleg
     * zeigen — und niemand saehe es.
     */
    if not v_deleted
       and (v_existing.source_type <> v_source_type or v_existing.source_id <> v_source_id) then
      raise exception 'accounting_source_immutable: Beleg einer Kontierung ist unveraenderlich'
        using errcode = 'P0001';
    end if;

    if v_deleted then
      update public.workspace_accounting_assignments
      set deleted = true,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    else
      update public.workspace_accounting_assignments
      set payload = v_payload,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    end if;
  end if;

  return jsonb_build_object(
    'row_version', v_row.row_version,
    'updated_at', v_row.updated_at,
    'deleted', v_row.deleted
  );
end;
$$;

/* ------------------------------------------------------------------------------------------------ */
/* 6) Abschlussfassung 6: Serverprojektion und Manifesttext (A04-WEISS-R2)                           */
/* ------------------------------------------------------------------------------------------------ */

create or replace function public.workspace_fc_abschluss_projektion6(
  p_workspace_id uuid,
  p_year integer,
  p_month integer
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_ms date := make_date(p_year, p_month, 1);
  v_mk text := to_char(make_date(p_year, p_month, 1), 'YYYY-MM');
  v_me text := to_char((make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD');
  v_chart text;
  v_res jsonb;
begin
  select case when s.settings->>'chartOfAccounts' in ('SKR03', 'SKR04') then s.settings->>'chartOfAccounts' end
    into v_chart
  from public.workspace_settings s
  where s.workspace_id = p_workspace_id;
  v_chart := coalesce(v_chart, 'SKR03');

  with
  ri as materialized (
    select wi.client_invoice_id as id,
           wi.invoice_type as typ,
           wi.payload as pl,
           wi.frist_basis->'lage' as lage,
           case when jsonb_typeof(wi.payload->'issueDate') = 'string' then left(wi.payload->>'issueDate', 10)
                when jsonb_typeof(wi.payload->'date') = 'string' then left(wi.payload->>'date', 10)
                else '' end as belegdatum,
           case when wi.cancelled_at is null then null
                else to_char(wi.cancelled_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') end as stornotag,
           coalesce(wi.payload->>'taxStatus', '') as steuerstatus
    from public.workspace_invoices wi
    where wi.workspace_id = p_workspace_id
      and wi.invoice_status in ('vorbereitet', 'versendet')
  ),
  rb as materialized (
    select ri.*, b.brutto, b.netto
    from ri
    cross join lateral public.workspace_fc_rechnung_buchung(ri.typ, ri.pl) b
  ),
  rs as materialized (
    select rb.id, rb.brutto as total, s.zahlbar, s.frist
    from rb
    cross join lateral public.workspace_fc_skonto_rahmen(p_workspace_id, rb.pl, rb.lage, rb.brutto) s
  ),
  rx as materialized (
    select we.client_expense_id as id,
           we.status,
           we.payload as pl,
           left(coalesce(we.payload->>'issueDate', we.payload->>'createdAt', ''), 10) as belegdatum,
           case when we.status = 'storniert' then public.workspace_fc_geschaeftstag(we.payload->>'cancelledAt') end as stornotag,
           case when jsonb_typeof(we.payload->'taxStatus') = 'string' then we.payload->>'taxStatus'
                when jsonb_typeof(we.payload->'taxStatus') is null or jsonb_typeof(we.payload->'taxStatus') = 'null' then 'standard_19'
                else '' end as steuerstatus,
           g.brutto,
           g.netto,
           case when jsonb_typeof(we.payload->'taxAmount') = 'number'
                then round((we.payload->>'taxAmount')::numeric * 100)::bigint
                else greatest(0, g.brutto - g.netto) end as steuer,
           left(coalesce(we.payload->>'paymentDueDate', ''), 10) as faellig,
           /* Fassung 6 (A04-WEISS-R2): die steuerlichen Merkmale des Belegs, wie expenseTaxSplitClosureAttributes. */
           public.workspace_expense_steueraufteilung(we.payload) as aufteilung,
           public.workspace_expense_vorsteuerabzug(we.payload) as abzug,
           public.workspace_expense_abziehbar_cent(we.payload) as abziehbar
    from public.workspace_expenses we
    cross join lateral (
      select gb.brutto,
             case when jsonb_typeof(we.payload->'netAmount') = 'number'
                  then round((we.payload->>'netAmount')::numeric * 100)::bigint
                  else gb.brutto end as netto
      from (
        select case
          when jsonb_typeof(we.payload->'grossAmount') = 'number'
            then round((we.payload->>'grossAmount')::numeric * 100)::bigint
          when coalesce(jsonb_typeof(we.payload->'grossAmount'), 'null') = 'null'
               and jsonb_typeof(we.payload->'amount') = 'number'
            then round((we.payload->>'amount')::numeric * 100)::bigint
          else 0::bigint
        end as brutto
      ) gb
    ) g
    where we.workspace_id = p_workspace_id
      and not we.deleted
      and we.status in ('gebucht', 'storniert')
  ),
  ka as materialized (
    select a.source_type as st, a.source_id as sid, a.payload as pl
    from public.workspace_accounting_assignments a
    where a.workspace_id = p_workspace_id
      and not a.deleted
  ),
  zi as materialized (
    select p.client_invoice_id as iid, p.client_payment_id as pid, p.paid_on,
           round(p.amount * 100)::bigint as c, p.method
    from public.workspace_invoice_payments p
    where p.workspace_id = p_workspace_id
      and p.reversed_at is null
  ),
  /* Rechnungen zum Monatsende: alle bis dahin datierten, bis dahin nicht stornierten, Zahlungen bis Monatsende. */
  oi as materialized (
    select rb.id, rb.belegdatum, rb.brutto, rs.zahlbar, rs.frist,
           left(coalesce(rb.pl->>'paymentDueDate', ''), 10) as faellig,
           coalesce(sum(zi.c) filter (where zi.paid_on <= v_me::date), 0)::bigint as paid,
           coalesce(sum(zi.c) filter (where zi.paid_on <= v_me::date and rs.frist is not null and zi.paid_on <= rs.frist), 0)::bigint as frueh
    from rb
    join rs on rs.id = rb.id
    left join zi on zi.iid = rb.id
    where rb.belegdatum <> ''
      and rb.belegdatum <= v_me collate "C"
      and (rb.stornotag is null or rb.stornotag > v_me collate "C")
    group by rb.id, rb.belegdatum, rb.brutto, rs.zahlbar, rs.frist, rb.pl
  ),
  e as materialized (
    /* Beleg-Skonto zum Monatsende wie buildInvoiceBeleg: ausgeglichen, etwas gezahlt -> Betrag minus gezahlt. */
    select 'invoice'::text as st, rb.id as sid, 'ausgangsrechnung'::text as belegart, rb.belegdatum as datum,
           rb.brutto, rb.netto, rb.brutto - rb.netto as steuer,
           coalesce(public.workspace_fc_wirksames_skonto(oi.brutto, oi.zahlbar, oi.frist, oi.paid, oi.frueh), 0)::bigint as skonto,
           case when rb.stornotag is not null and rb.stornotag <= v_me collate "C" then 'storniert' else 'aktiv' end as status,
           rb.steuerstatus,
           ''::text as aufteilung, ''::text as abzug, null::bigint as abziehbar
    from rb
    left join oi on oi.id = rb.id
    where left(rb.belegdatum, 7) = v_mk
    union all
    select 'invoice', rb.id, 'rechnungsstorno', rb.stornotag, -rb.brutto, -rb.netto, -(rb.brutto - rb.netto), 0::bigint, 'storno', rb.steuerstatus, '', '', null::bigint
    from rb
    where rb.stornotag is not null and left(rb.stornotag, 7) = v_mk
    union all
    select 'expense', rx.id, 'eingangsbeleg', rx.belegdatum, rx.brutto, rx.netto, rx.steuer, 0::bigint,
           case when rx.status = 'storniert' and (rx.stornotag is null or rx.stornotag <= v_me collate "C") then 'storniert' else 'aktiv' end,
           rx.steuerstatus, rx.aufteilung, rx.abzug, rx.abziehbar
    from rx
    where left(rx.belegdatum, 7) = v_mk
    union all
    select 'expense', rx.id, 'ausgabenstorno', rx.stornotag, -rx.brutto, -rx.netto, -rx.steuer, 0::bigint, 'storno', rx.steuerstatus, rx.aufteilung, rx.abzug, rx.abziehbar
    from rx
    where rx.status = 'storniert' and rx.stornotag is not null and left(rx.stornotag, 7) = v_mk
  ),
  ek as materialized (
    select e.*,
           ka.pl as kpl,
           coalesce(ka.pl->>'chartOfAccounts', '') as kontenrahmen,
           btrim(coalesce(ka.pl->>'accountNumber', ''), E' \t\n\r\f\v') as konto,
           coalesce(ka.pl->>'taxTreatment', '') as steuerbehandlung,
           case when ka.pl is null then 'none' else coalesce(ka.pl->>'status', '') end as kontierungsstatus,
           btrim(coalesce(ka.pl->>'bookingText', ''), E' \t\n\r\f\v') as buchungstext
    from e
    left join ka on ka.st = e.st and ka.sid = e.sid
  ),
  zo as (
    select zi.*, rs.total, rs.zahlbar, rs.frist,
           (sum(zi.c) over w)::bigint as paid_incl,
           (sum(case when rs.frist is not null and zi.paid_on <= rs.frist then zi.c else 0 end) over w)::bigint as frueh_incl
    from zi
    join rs on rs.id = zi.iid
    window w as (partition by zi.iid order by zi.paid_on, zi.pid collate "C" rows between unbounded preceding and current row)
  ),
  p as materialized (
    select 'invoice'::text as st, zo.iid as sid, zo.pid, to_char(zo.paid_on, 'YYYY-MM-DD') as datum, zo.c as betrag,
           public.workspace_fc_wirksames_skonto(zo.total, zo.zahlbar, zo.frist, zo.paid_incl, zo.frueh_incl)
             - public.workspace_fc_wirksames_skonto(
                 zo.total, zo.zahlbar, zo.frist, zo.paid_incl - zo.c,
                 zo.frueh_incl - case when zo.frist is not null and zo.paid_on <= zo.frist then zo.c else 0 end
               ) as skonto,
           public.workspace_fc_zahlungsart(zo.method) as zahlungsart
    from zo
    join rb on rb.id = zo.iid
    where rb.stornotag is null
      and to_char(zo.paid_on, 'YYYY-MM') = v_mk
    union all
    select 'expense', x.client_expense_id, x.client_payment_id, to_char(x.paid_on, 'YYYY-MM-DD'),
           round(x.amount * 100)::bigint, 0::bigint, public.workspace_fc_zahlungsart(x.method)
    from public.workspace_expense_payments x
    join rx on rx.id = x.client_expense_id
    where x.workspace_id = p_workspace_id
      and x.reversed_at is null
      and rx.status = 'gebucht'
      and to_char(x.paid_on, 'YYYY-MM') = v_mk
  ),
  mz as materialized (
    select m.client_payment_id as pid, to_char(m.paid_on, 'YYYY-MM-DD') as zt, round(m.amount * 100)::bigint as c,
           m.kind, m.method,
           case when m.reversed_at is null then null
                else to_char(m.reversed_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') end as stornotag
    from public.workspace_employee_payments m
    where m.workspace_id = p_workspace_id
  ),
  m as materialized (
    select mz.pid, 'zahlung'::text as art, mz.zt as datum, mz.c as betrag, mz.kind, mz.method,
           case when mz.stornotag is not null and mz.stornotag <= v_me collate "C" then 'storniert' else 'aktiv' end as status
    from mz
    where left(mz.zt, 7) = v_mk
    union all
    select mz.pid, 'storno', mz.stornotag, -mz.c, mz.kind, mz.method, 'storno'
    from mz
    where mz.stornotag is not null and left(mz.stornotag, 7) = v_mk and left(mz.zt, 7) < v_mk collate "C"
  ),
  ox as (
    select rx.id, rx.belegdatum, rx.brutto, rx.faellig,
           coalesce(sum(round(x.amount * 100)) filter (where x.paid_on <= v_me::date), 0)::bigint as paid
    from rx
    left join public.workspace_expense_payments x
      on x.workspace_id = p_workspace_id and x.client_expense_id = rx.id and x.reversed_at is null
    where rx.belegdatum <> ''
      and rx.belegdatum <= v_me collate "C"
      and not (rx.status = 'storniert' and (rx.stornotag is null or rx.stornotag <= v_me collate "C"))
    group by rx.id, rx.belegdatum, rx.brutto, rx.faellig
  ),
  o as materialized (
    select 'ausgangsrechnung'::text as belegart, q.id, q.belegdatum as datum, q.brutto, q.paid as bezahlt, q.offen, q.faellig
    from (
      select oi.*, public.workspace_fc_offen(oi.brutto, oi.zahlbar, oi.frist, oi.paid, oi.frueh) as offen
      from oi
    ) q
    where q.offen >= 1
    union all
    select 'eingangsbeleg', q.id, q.belegdatum, q.brutto, q.paid, q.offen, q.faellig
    from (
      select ox.*, case when ox.brutto < 0 then 0::bigint else greatest(0, ox.brutto - ox.paid) end as offen
      from ox
    ) q
    where q.offen >= 1
  ),
  nb as (
    select distinct on (ek.st, ek.sid) ek.st, ek.sid,
           case
             when ek.kpl is null then 'keine_kontierung'
             when ek.kontierungsstatus <> 'confirmed' then 'nicht_bestaetigt'
             when ek.konto = '' then 'ohne_konto'
             when ek.steuerbehandlung not in ('standard_19', 'standard_7', 'kleinunternehmer_19', 'reverse_charge_13b', 'tax_free')
               then 'steuer_ungeklaert'
             when ek.steuerstatus <> '' and ek.steuerstatus <> ek.steuerbehandlung then 'steuer_abweichend'
           end as grund
    from ek
    order by ek.st, ek.sid
  )
  select jsonb_build_object(
    'monthKey', v_mk,
    'chartOfAccounts', v_chart,
    'text', concat_ws(
      chr(10),
      'v=6|month=' || public.workspace_fc_kanon(v_mk) || '|chart=' || public.workspace_fc_kanon(v_chart),
      (select string_agg(
                'E|' || public.workspace_fc_kanon(ek.st) || '|' || public.workspace_fc_kanon(ek.sid) || '|'
                  || public.workspace_fc_kanon(ek.belegart) || '|' || public.workspace_fc_kanon(ek.datum) || '|'
                  || ek.brutto::text || '|' || coalesce(ek.netto::text, '-') || '|' || coalesce(ek.steuer::text, '-') || '|'
                  || ek.skonto::text || '|' || public.workspace_fc_kanon(ek.status) || '|' || public.workspace_fc_kanon(ek.kontenrahmen) || '|'
                  || public.workspace_fc_kanon(ek.konto) || '|' || public.workspace_fc_kanon(ek.steuerbehandlung) || '|'
                  || public.workspace_fc_kanon(ek.kontierungsstatus) || '|' || public.workspace_fc_kanon(ek.buchungstext) || '|'
                  || public.workspace_fc_kanon(ek.aufteilung) || '|' || public.workspace_fc_kanon(ek.abzug) || '|'
                  || coalesce(ek.abziehbar::text, ''),
                chr(10)
                order by ek.st collate "C", ek.sid collate "C", ek.belegart collate "C")
       from ek),
      (select string_agg(
                'P|' || public.workspace_fc_kanon(p.st) || '|' || public.workspace_fc_kanon(p.sid) || '|'
                  || public.workspace_fc_kanon(p.pid) || '|' || p.datum || '|' || p.betrag::text || '|'
                  || p.skonto::text || '|' || public.workspace_fc_kanon(p.zahlungsart),
                chr(10)
                order by p.st collate "C", p.sid collate "C", p.pid collate "C")
       from p),
      (select string_agg(
                'M|' || public.workspace_fc_kanon(m.pid) || '|' || public.workspace_fc_kanon(m.art) || '|'
                  || public.workspace_fc_kanon(m.datum) || '|' || m.betrag::text || '|'
                  || public.workspace_fc_kanon(m.kind) || '|' || public.workspace_fc_kanon(m.method) || '|'
                  || public.workspace_fc_kanon(m.status),
                chr(10)
                order by m.pid collate "C", m.art collate "C")
       from m),
      (select string_agg(
                'O|' || public.workspace_fc_kanon(o.belegart) || '|' || public.workspace_fc_kanon(o.id) || '|'
                  || public.workspace_fc_kanon(o.datum) || '|' || o.brutto::text || '|' || o.bezahlt::text || '|'
                  || o.offen::text || '|' || public.workspace_fc_kanon(o.faellig),
                chr(10)
                order by o.belegart collate "C", o.id collate "C")
       from o)
    ),
    'documentCount', (select count(*) from e),
    'totalBruttoCents', (select coalesce(sum(e.brutto), 0) from e),
    'totalNettoCents', (select coalesce(sum(coalesce(e.netto, 0)), 0) from e),
    'totalSteuerCents', (select coalesce(sum(coalesce(e.steuer, 0)), 0) from e),
    'nichtBereit', coalesce(
      (select jsonb_agg(jsonb_build_object('sourceType', nb.st, 'sourceId', nb.sid, 'grund', nb.grund)
                        order by nb.st collate "C", nb.sid collate "C")
       from (
         select nb.st, nb.sid, nb.grund from nb where nb.grund is not null
         union all
         /* Fassung 6 (A04-WEISS-R1): eine nicht stornierte Ausgabe des Monats mit offener Steueraufteilung. */
         select 'expense'::text, rx.id, 'steueraufteilung_offen'::text
         from rx
         where rx.status = 'gebucht' and left(rx.belegdatum, 7) = v_mk and rx.aufteilung = 'offen'
       ) nb),
      '[]'::jsonb
    )
  )
  into v_res;

  return v_res || jsonb_build_object(
    'fingerprint', 'p6:' || encode(sha256(convert_to(v_res->>'text', 'UTF8')), 'hex')
  );
end;
$$;

revoke all on function public.workspace_fc_abschluss_projektion6(uuid, integer, integer) from public, anon, authenticated, service_role;

create or replace function public.workspace_fc_manifest_text6(p_manifest jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  with
  ent as (
    select x from jsonb_array_elements(case when jsonb_typeof(p_manifest->'entries') = 'array' then p_manifest->'entries' else '[]'::jsonb end) x
  ),
  pay as (
    select x from jsonb_array_elements(case when jsonb_typeof(p_manifest->'payments') = 'array' then p_manifest->'payments' else '[]'::jsonb end) x
  ),
  emp as (
    select x from jsonb_array_elements(case when jsonb_typeof(p_manifest->'employeePayments') = 'array' then p_manifest->'employeePayments' else '[]'::jsonb end) x
  ),
  opn as (
    select x from jsonb_array_elements(case when jsonb_typeof(p_manifest->'offenePosten') = 'array' then p_manifest->'offenePosten' else '[]'::jsonb end) x
  )
  select concat_ws(
    chr(10),
    'v=6|month=' || public.workspace_fc_kanon(p_manifest->>'monthKey') || '|chart=' || public.workspace_fc_kanon(p_manifest->>'chartOfAccounts'),
    (select string_agg(
              'E|' || public.workspace_fc_kanon(x->>'sourceType') || '|' || public.workspace_fc_kanon(x->>'sourceId') || '|'
                || public.workspace_fc_kanon(x->>'belegart') || '|' || public.workspace_fc_kanon(x->>'datum') || '|'
                || public.workspace_fc_json_cent(x->'brutto') || '|' || public.workspace_fc_json_cent(x->'netto') || '|'
                || public.workspace_fc_json_cent(x->'steuer') || '|'
                || case when coalesce(jsonb_typeof(x->'skontoAbzug'), 'null') = 'null' then '0'
                        else public.workspace_fc_json_cent(x->'skontoAbzug') end || '|'
                || public.workspace_fc_kanon(x->>'belegStatus') || '|'
                || public.workspace_fc_kanon(x->>'kontenrahmen') || '|' || public.workspace_fc_kanon(x->>'accountNumber') || '|'
                || public.workspace_fc_kanon(x->>'taxTreatment') || '|' || public.workspace_fc_kanon(x->>'assignmentStatus') || '|'
                || public.workspace_fc_kanon(x->>'bookingText') || '|'
                || public.workspace_fc_kanon(x->>'steueraufteilung') || '|' || public.workspace_fc_kanon(x->>'vorsteuerabzug') || '|'
                || case when coalesce(jsonb_typeof(x->'abziehbareVorsteuer'), 'null') = 'null' then ''
                        else public.workspace_fc_json_cent(x->'abziehbareVorsteuer') end,
              chr(10)
              order by coalesce(x->>'sourceType', '') collate "C", coalesce(x->>'sourceId', '') collate "C",
                       coalesce(x->>'belegart', '') collate "C", x::text collate "C")
     from ent),
    (select string_agg(
              'P|' || public.workspace_fc_kanon(x->>'sourceType') || '|' || public.workspace_fc_kanon(x->>'sourceId') || '|'
                || public.workspace_fc_kanon(x->>'paymentId') || '|' || public.workspace_fc_kanon(x->>'datum') || '|'
                || public.workspace_fc_json_cent(x->'betrag') || '|'
                || case when coalesce(jsonb_typeof(x->'skontoAbzug'), 'null') = 'null' then '0'
                        else public.workspace_fc_json_cent(x->'skontoAbzug') end || '|'
                || public.workspace_fc_kanon(x->>'zahlungsart'),
              chr(10)
              order by coalesce(x->>'sourceType', '') collate "C", coalesce(x->>'sourceId', '') collate "C",
                       coalesce(x->>'paymentId', '') collate "C", x::text collate "C")
     from pay),
    (select string_agg(
              'M|' || public.workspace_fc_kanon(x->>'paymentId') || '|' || public.workspace_fc_kanon(x->>'art') || '|'
                || public.workspace_fc_kanon(x->>'datum') || '|' || public.workspace_fc_json_cent(x->'betrag') || '|'
                || public.workspace_fc_kanon(x->>'kind') || '|' || public.workspace_fc_kanon(x->>'method') || '|'
                || public.workspace_fc_kanon(x->>'status'),
              chr(10)
              order by coalesce(x->>'paymentId', '') collate "C", coalesce(x->>'art', '') collate "C", x::text collate "C")
     from emp),
    (select string_agg(
              'O|' || public.workspace_fc_kanon(x->>'belegart') || '|' || public.workspace_fc_kanon(x->>'belegId') || '|'
                || public.workspace_fc_kanon(x->>'datum') || '|' || public.workspace_fc_json_cent(x->'brutto') || '|'
                || public.workspace_fc_json_cent(x->'bezahlt') || '|' || public.workspace_fc_json_cent(x->'offen') || '|'
                || public.workspace_fc_kanon(x->>'faelligAm'),
              chr(10)
              order by coalesce(x->>'belegart', '') collate "C", coalesce(x->>'belegId', '') collate "C", x::text collate "C")
     from opn)
  );
$$;

revoke all on function public.workspace_fc_manifest_text6(jsonb) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 7) Monat abschliessen: nur noch Fassung 6 (A04-WEISS-R2)                                         */
/* ------------------------------------------------------------------------------------------------ */

create or replace function public.close_workspace_accounting_period(
  p_workspace_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_closure_id text;
  v_year integer;
  v_month integer;
  v_fingerprint text;
  v_manifest jsonb;
  v_stand bigint;
  v_same public.workspace_accounting_period_closures;
  v_active public.workspace_accounting_period_closures;
  v_next_revision integer;
  v_row public.workspace_accounting_period_closures;
  v_proj jsonb;
  v_client_text text;
  v_nicht jsonb;
begin
  /* R1-SEC-01 -- Autorisierung vor allem anderen (unveraendert aus 20261023). */
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

  v_closure_id := nullif(trim(coalesce(p_payload->>'client_closure_id', '')), '');
  if v_closure_id is null then
    raise exception 'client_closure_id fehlt';
  end if;

  begin
    v_year := (p_payload->>'period_year')::integer;
    v_month := (p_payload->>'period_month')::integer;
  exception when others then
    raise exception 'period_invalid: Jahr oder Monat unlesbar' using errcode = 'P0001';
  end;
  if v_year is null or v_month is null
     or v_year < 2000 or v_year > 2999
     or v_month < 1 or v_month > 12 then
    raise exception 'period_invalid: % / %', coalesce(v_year, -1), coalesce(v_month, -1)
      using errcode = 'P0001';
  end if;

  v_fingerprint := nullif(trim(coalesce(p_payload->>'fingerprint', '')), '');
  if v_fingerprint is null then
    raise exception 'closure_without_fingerprint: fingerprint fehlt' using errcode = 'P0001';
  end if;

  v_manifest := coalesce(p_payload->'manifest', '{}'::jsonb);
  if jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'closure_manifest_invalid: kein Objekt' using errcode = 'P0001';
  end if;
  if not (v_manifest ? 'entries') or jsonb_typeof(v_manifest->'entries') <> 'array' then
    raise exception 'closure_manifest_invalid: entries fehlen' using errcode = 'P0001';
  end if;
  if nullif(v_manifest->>'monthKey', '') is distinct from
     (lpad(v_year::text, 4, '0') || '-' || lpad(v_month::text, 2, '0')) then
    raise exception 'closure_manifest_period_mismatch: % gehoert nicht zu %-%',
      coalesce(v_manifest->>'monthKey', '(fehlt)'), v_year, v_month
      using errcode = 'P0001';
  end if;

  /*
   * SYS-03 (D3) -- zuerst die Datenstandssperre, dann jedes Lesen. Parallele Abschluesse und Wiederoeffnungen
   * dieses Betriebs laufen nacheinander; Finanzaenderungen liegen ganz davor oder ganz danach.
   */
  v_stand := public.workspace_fc_datenstand_sperren(p_workspace_id);

  /*
   * Replay ueber die Kennung: Dieselbe Revision noch einmal geschickt (etwa nach verlorener Antwort) bekommt ihre
   * gespeicherte Antwort, auch wenn der Monat inzwischen wieder geoeffnet wurde. Eine fremde Nutzung derselben
   * Kennung ist ein Konflikt, kein stilles Verschmelzen.
   */
  select * into v_same
  from public.workspace_accounting_period_closures c
  where c.workspace_id = p_workspace_id
    and c.client_closure_id = v_closure_id;
  if v_same.id is not null then
    if v_same.period_year = v_year and v_same.period_month = v_month and v_same.fingerprint = v_fingerprint then
      return jsonb_build_object(
        'revision', v_same.revision,
        'closed_at', v_same.closed_at,
        'row_version', v_same.row_version,
        'noop', true,
        'fingerprint', v_same.fingerprint,
        'validated_version', v_same.validated_version,
        'finance_revision', v_same.finance_revision,
        'validated_at', v_same.validated_at,
        'reopened_at', v_same.reopened_at
      );
    end if;
    raise exception 'closure_id_conflict: Kennung gehoert zu einer anderen Revision' using errcode = 'P0001';
  end if;

  /*
   * SYS-01 / P1-KORREKTUR A04-WEISS-R2 -- neue Revisionen nur noch in Fassung 6 (bindet zusaetzlich Steueraufteilung,
   * Vorsteuerabzug und abziehbaren Betrag). Aeltere Clients werden sichtbar abgewiesen, nicht still angenommen;
   * bestehende Revisionen der Fassung 5 bleiben unveraendert gespeichert und lesbar.
   */
  if coalesce(v_manifest->>'fingerprintVersion', '') <> '6' or v_fingerprint not like 'p6:%' then
    raise exception 'closure_manifest_version_outdated: Fassung % wird nicht mehr angenommen; bitte die App aktualisieren',
      coalesce(v_manifest->>'fingerprintVersion', '(fehlt)')
      using errcode = 'P0001';
  end if;

  select * into v_active
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = v_year
    and period_month = v_month
    and reopened_at is null
  for update;

  if v_active.id is not null then
    /*
     * Ein Replay derselben Revision ist oben ueber die Kennung erledigt. Eine andere Kennung mit demselben Stand ist
     * ein zweites Geraet: Seine Revision wird nicht gespeichert -- also darf sie auch nicht als angenommen gelten.
     * Der Abgleich bringt die bestehende, servervalidierte Revision auf das Geraet.
     */
    if v_active.fingerprint = v_fingerprint then
      raise exception 'period_already_closed: Revision % mit demselben Stand ist bereits abgeschlossen',
        v_active.revision using errcode = 'P0001';
    end if;
    raise exception 'period_already_closed: Revision % ist offen; bitte zuerst wieder oeffnen',
      v_active.revision using errcode = 'P0001';
  end if;

  v_proj := public.workspace_fc_abschluss_projektion6(p_workspace_id, v_year, v_month);

  /* Bereitschaft wie collectPeriodBlockers -- auch gegen direkte Aufrufe. */
  v_nicht := v_proj->'nichtBereit';
  if jsonb_array_length(v_nicht) > 0 then
    raise exception 'closure_not_ready: % Beleg(e) ohne abschlussfaehige Kontierung (%)',
      jsonb_array_length(v_nicht),
      (select string_agg((n->>'sourceType') || ':' || (n->>'sourceId') || ' ' || (n->>'grund'), ', ')
       from (select n from jsonb_array_elements(v_nicht) n limit 5) q)
      using errcode = 'P0001';
  end if;

  v_client_text := public.workspace_fc_manifest_text6(v_manifest);
  if v_client_text is distinct from v_proj->>'text' then
    raise exception 'closure_manifest_mismatch: %', public.workspace_fc_text_befund(v_client_text, v_proj->>'text')
      using errcode = 'P0001';
  end if;
  if v_fingerprint <> v_proj->>'fingerprint' then
    raise exception 'closure_fingerprint_mismatch: Fingerabdruck passt nicht zum Serverbestand' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_manifest->'documentCount') is distinct from 'number'
     or (v_manifest->>'documentCount')::numeric <> (v_proj->>'documentCount')::numeric
     or public.workspace_fc_json_cent(v_manifest->'totalBrutto') <> (v_proj->>'totalBruttoCents')
     or public.workspace_fc_json_cent(v_manifest->'totalNetto') <> (v_proj->>'totalNettoCents')
     or public.workspace_fc_json_cent(v_manifest->'totalSteuer') <> (v_proj->>'totalSteuerCents') then
    raise exception 'closure_manifest_mismatch: Belegzahl oder Summen weichen ab' using errcode = 'P0001';
  end if;

  select coalesce(max(revision), 0) + 1 into v_next_revision
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = v_year
    and period_month = v_month;

  insert into public.workspace_accounting_period_closures (
    workspace_id, client_closure_id, period_year, period_month, revision,
    fingerprint, manifest, closed_at, closed_by,
    validated_version, finance_revision, validated_at
  ) values (
    p_workspace_id, v_closure_id, v_year, v_month, v_next_revision,
    v_fingerprint, v_manifest, now(), v_user_id,
    6, v_stand, now()
  )
  returning * into v_row;

  return jsonb_build_object(
    'revision', v_row.revision,
    'closed_at', v_row.closed_at,
    'row_version', v_row.row_version,
    'noop', false,
    'fingerprint', v_row.fingerprint,
    'validated_version', v_row.validated_version,
    'finance_revision', v_row.finance_revision,
    'validated_at', v_row.validated_at,
    'reopened_at', v_row.reopened_at
  );
end;
$$;
