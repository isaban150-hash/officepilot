-- FINANZ-CORE-01A -- systemische Gesamtnacharbeit (SYS-01, SYS-03): der Server prueft Monatsabschluesse gegen seinen
-- eigenen Finanzbestand.
--
-- Bisher hat close_workspace_accounting_period nur Struktur und Monat geprueft und das Manifest des Clients
-- gespeichert (20261009, Hinweis dort: "Er kann die fachliche Bereitschaft nicht nachrechnen"). Ein erfundener,
-- fehlender, veralteter oder falscher Beleg, eine erfundene Zahlung oder ein falscher Betrag wurden angenommen; die
-- kumulierten offenen Posten waren gar nicht an die Revision gebunden.
--
-- Ab hier gilt:
--
--   1. Datenstand und Parallelitaet (D3): Jede Aenderung an Rechnungen, Rechnungszahlungen, Ausgaben,
--      Ausgabenzahlungen, Mitarbeiterzahlungen, Kontierungen und Betriebseinstellungen haelt bis zum Commit eine
--      geteilte Datenstandssperre des Betriebs und schreibt eine Datenstandszeile. Abschluss und Wiederoeffnung
--      nehmen die Sperre exklusiv, bevor sie irgendetwas lesen: Eine Finanzaenderung liegt also entweder ganz vor
--      dem Abschluss (und ist in seiner Pruefung enthalten) oder ganz danach (und macht ihn sichtbar veraltet).
--      Parallele Erstabschluesse desselben Monats laufen nacheinander; der zweite ist ein Replay oder wird mit
--      period_already_closed abgewiesen -- kein roher 23505 mehr.
--   2. Fassung 5 (D2): Angenommen wird nur noch ein Manifest der Fassung 5. Der Server bildet den kanonischen Text
--      aus seinen Tabellen (workspace_fc_abschluss_projektion) und aus dem uebergebenen Manifest
--      (workspace_fc_manifest_text); beide und der Fingerabdruck p5:<sha256> muessen exakt uebereinstimmen. Gebunden
--      sind alle Geld-, Steuer-, Skonto-, Status-, Datums- und Kontierungswerte, die Zahlungen und
--      Mitarbeiterzahlungen des Monats und die kumulierten offenen Posten zum Monatsende. Dieselbe Festlegung steht
--      im Client (src/services/accounting/accountingPeriodManifestV5.ts).
--   3. Bereitschaft: Jeder Beleg des Monats braucht eine bestaetigte Kontierung mit Sachkonto und geklaerter
--      Steuerbehandlung, die dem Steuerstatus des Belegs entspricht -- dieselbe Regel wie collectPeriodBlockers.
--      Ein direkter RPC-Aufruf oder ein alter Client umgeht sie nicht mehr.
--   4. Eine angenommene Revision traegt validated_version = 5, finance_revision (Datenstand) und validated_at. Alte
--      Revisionen (Fassung 1-4) bleiben lesbar, tragen diese Angaben nie und gelten damit nie als serverzertifiziert.
--
-- Bestehende Migrationen bleiben unveraendert; diese Datei ersetzt close/reopen/pull mit derselben Signatur.

/* ------------------------------------------------------------------------------------------------ */
/* 1) Spalten der Abschlussrevision                                                                 */
/* ------------------------------------------------------------------------------------------------ */

alter table public.workspace_accounting_period_closures
  add column if not exists validated_version integer null,
  add column if not exists finance_revision bigint null,
  add column if not exists validated_at timestamptz null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_accounting_period_closures_validated_check'
      and conrelid = 'public.workspace_accounting_period_closures'::regclass
  ) then
    alter table public.workspace_accounting_period_closures
      add constraint workspace_accounting_period_closures_validated_check
      check (
        (validated_version is null and finance_revision is null and validated_at is null)
        or (validated_version = 5 and finance_revision is not null and validated_at is not null
            and fingerprint like 'p5:%')
      );
  end if;
end;
$$;

/* ------------------------------------------------------------------------------------------------ */
/* 2) Datenstand und Datenstandssperre                                                              */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Nur anhaengen, nie aendern: Der Datenstand eines Betriebs ist die hoechste Kennung seiner Zeilen. Bewusst keine
 * gemeinsame Zaehlerzeile -- sie wuerde alle Finanzaenderungen eines Betriebs gegeneinander sperren und neue
 * Verklemmungen erzeugen. Wird der Betrieb geloescht, gehen seine Zeilen mit (der Ausloeser schreibt waehrend der
 * Loeschkaskade nichts mehr).
 */
create table if not exists public.workspace_finance_changes (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  table_name text not null,
  changed_at timestamptz not null default now()
);

create index if not exists workspace_finance_changes_workspace_idx
  on public.workspace_finance_changes (workspace_id, id desc);

alter table public.workspace_finance_changes enable row level security;
revoke all on public.workspace_finance_changes from public, anon, authenticated;
revoke all on sequence public.workspace_finance_changes_id_seq from public, anon, authenticated;

/* Schluessel der Datenstandssperre: Klasse 'FC5' und der Betrieb (Kollisionen kosten nur Wartezeit). */
create or replace function public.workspace_fc_sperrschluessel(p_workspace_id uuid)
returns integer
language sql
immutable
set search_path = public
as $$
  select hashtext(p_workspace_id::text);
$$;

create or replace function public.workspace_finance_change_mark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
begin
  if tg_op = 'DELETE' then
    v_ws := old.workspace_id;
  else
    v_ws := new.workspace_id;
  end if;
  if v_ws is null then
    return null;
  end if;
  /* Ein Betrieb, der gerade geloescht wird, braucht keinen Datenstand mehr. */
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces w where w.id = v_ws) then
    return null;
  end if;
  /*
   * Geteilt: Finanzaenderungen untereinander warten nicht aufeinander. Ein laufender Abschluss (exklusiv) haelt
   * sie bis zu seinem Commit an; eine laufende Aenderung haelt den Abschluss bis zu ihrem Commit an.
   */
  perform pg_advisory_xact_lock_shared(4605749, public.workspace_fc_sperrschluessel(v_ws));
  insert into public.workspace_finance_changes (workspace_id, table_name) values (v_ws, tg_table_name);
  if tg_op = 'UPDATE' and old.workspace_id is distinct from new.workspace_id and old.workspace_id is not null then
    perform pg_advisory_xact_lock_shared(4605749, public.workspace_fc_sperrschluessel(old.workspace_id));
    insert into public.workspace_finance_changes (workspace_id, table_name) values (old.workspace_id, tg_table_name);
  end if;
  return null;
end;
$$;

revoke all on function public.workspace_fc_sperrschluessel(uuid) from public, anon, authenticated, service_role;
revoke all on function public.workspace_finance_change_mark() from public, anon, authenticated, service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'workspace_invoices',
    'workspace_invoice_payments',
    'workspace_expenses',
    'workspace_expense_payments',
    'workspace_employee_payments',
    'workspace_accounting_assignments',
    'workspace_settings'
  ] loop
    execute format('drop trigger if exists %I on public.%I', v_table || '_finance_change', v_table);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.workspace_finance_change_mark()',
      v_table || '_finance_change',
      v_table
    );
  end loop;
end;
$$;

/* Exklusiv sperren und den Datenstand lesen -- fuer Abschluss und Wiederoeffnung, vor jedem anderen Lesen. */
create or replace function public.workspace_fc_datenstand_sperren(p_workspace_id uuid)
returns bigint
language plpgsql
volatile
set search_path = public
as $$
declare
  v_stand bigint;
begin
  perform pg_advisory_xact_lock(4605749, public.workspace_fc_sperrschluessel(p_workspace_id));
  select coalesce(max(c.id), 0) into v_stand
  from public.workspace_finance_changes c
  where c.workspace_id = p_workspace_id;
  return v_stand;
end;
$$;

revoke all on function public.workspace_fc_datenstand_sperren(uuid) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 3) Bausteine des kanonischen Textes                                                              */
/* ------------------------------------------------------------------------------------------------ */

/* Maskierung wie im Client (kanonText): \ -> \\, | -> \p, CR -> \r, LF -> \n. */
create or replace function public.workspace_fc_kanon(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select replace(replace(replace(replace(coalesce(p_text, ''), '\', '\\'), '|', '\p'), chr(13), '\r'), chr(10), '\n');
$$;

/* Ein JSON-Betrag in ganzen Cent wie toCents (halb weg von null), sonst '-' (Client: cent()). */
create or replace function public.workspace_fc_json_cent(p_value jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select case when jsonb_typeof(p_value) = 'number' then round((p_value #>> '{}')::numeric * 100)::bigint::text else '-' end;
$$;

/* Geschaeftstag (Europe/Berlin) eines gespeicherten Zeitpunkts wie toBusinessDay; ein reines Datum bleibt. */
create or replace function public.workspace_fc_geschaeftstag(p_text text)
returns text
language plpgsql
stable
set search_path = public
set "TimeZone" = 'Europe/Berlin'
as $$
declare
  v text := btrim(coalesce(p_text, ''));
begin
  if v = '' then
    return null;
  end if;
  if v ~ '^\d{4}-\d{2}-\d{2}$' then
    return v;
  end if;
  begin
    return to_char(v::timestamptz at time zone 'Europe/Berlin', 'YYYY-MM-DD');
  exception when others then
    return left(v, 10);
  end;
end;
$$;

/* Zahlungsart wie normalizePaymentMethod: nur bank/cash/other, sonst leer. */
create or replace function public.workspace_fc_zahlungsart(p_method text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_method in ('bank', 'cash', 'other') then p_method else '' end;
$$;

/* Umsatzsteuer in Cent aus Netto wie taxCentsFromNet (Math.round). */
create or replace function public.workspace_fc_steuer_aus_netto(p_net bigint, p_rate integer)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case when p_rate <= 0 then 0::bigint else floor(p_net::numeric * p_rate / 100 + 0.5)::bigint end;
$$;

/* Der Betrag, den ein Netto bei der Freigabe ergeben haette (amountCentsForNet). */
create or replace function public.workspace_fc_betrag_aus_netto(p_typ text, p_net bigint, p_rate integer, p_ded bigint)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case
    when p_typ = 'schluss' then greatest(0, p_net + public.workspace_fc_steuer_aus_netto(p_net, p_rate) - p_ded)
    else p_net + public.workspace_fc_steuer_aus_netto(p_net, p_rate) - p_ded
  end;
$$;

/*
 * Das verlaessliche Netto einer Rechnung in Cent (resolveInvoiceNet) oder NULL, wenn es ungeklaert ist:
 * gespeichertes Netto, das den Betrag ergibt; sonst Pauschalnetto oder Positionssumme, die ihn ergeben; sonst bei
 * ausdruecklich steuerfreier Rechnung Betrag plus Abzuege; sonst ungeklaert. Nie aus dem Brutto zurueckgerechnet.
 */
create or replace function public.workspace_fc_rechnung_netto(p_typ text, p_pl jsonb)
returns bigint
language plpgsql
immutable
set search_path = public
as $$
declare
  v_amount bigint;
  v_rate integer;
  v_ded bigint;
  v_fixed_mode boolean;
  v_fixed bigint;
  v_stored bigint;
  v_pos bigint;
  v_pos_n integer;
  v_pos_ok boolean;
  v_deductions jsonb;
begin
  if jsonb_typeof(p_pl->'amount') is distinct from 'number' then
    return null;
  end if;
  v_amount := round((p_pl->>'amount')::numeric * 100)::bigint;
  v_rate := case p_pl->>'taxStatus' when 'standard_19' then 19 when 'standard_7' then 7 else 0 end;
  v_deductions := case when jsonb_typeof(p_pl->'previousAbschlagDeductions') = 'array'
                       then p_pl->'previousAbschlagDeductions' else '[]'::jsonb end;
  select coalesce(sum(round((d->>'amount')::numeric * 100)), 0)::bigint into v_ded
  from jsonb_array_elements(v_deductions) d
  where jsonb_typeof(d->'amount') = 'number';

  v_fixed_mode := p_typ = 'abschlag' and p_pl->>'calculationMode' = 'fixed_amount';
  if v_fixed_mode and jsonb_typeof(p_pl->'fixedAmountNet') = 'number' then
    v_fixed := round((p_pl->>'fixedAmountNet')::numeric * 100)::bigint;
    if v_fixed <= 0 then
      v_fixed := null;
    end if;
  end if;

  if jsonb_typeof(p_pl->'subtotal') = 'number' then
    v_stored := round((p_pl->>'subtotal')::numeric * 100)::bigint;
  end if;
  if v_stored is not null and public.workspace_fc_betrag_aus_netto(p_typ, v_stored, v_rate, v_ded) = v_amount then
    if v_fixed is not null and v_fixed <> v_stored then
      return null;
    end if;
    return v_stored;
  end if;
  if v_stored is not null and v_stored <> v_amount then
    return null;
  end if;

  if v_fixed is not null and public.workspace_fc_betrag_aus_netto(p_typ, v_fixed, v_rate, v_ded) = v_amount then
    return v_fixed;
  end if;

  if not v_fixed_mode and jsonb_typeof(p_pl->'positions') = 'array' then
    select count(*),
           coalesce(bool_and(jsonb_typeof(l->'unitPrice') = 'number'), true),
           sum(case when jsonb_typeof(l->'unitPrice') = 'number'
                    then round((l->>'quantity')::numeric * round((l->>'unitPrice')::numeric, 2) * 100) end)::bigint
      into v_pos_n, v_pos_ok, v_pos
    from jsonb_array_elements(p_pl->'positions') l
    where jsonb_typeof(l->'quantity') = 'number' and (l->>'quantity')::numeric > 0;
    if v_pos_n = 0 or not v_pos_ok then
      v_pos := null;
    end if;
  end if;
  if v_pos is not null and public.workspace_fc_betrag_aus_netto(p_typ, v_pos, v_rate, v_ded) = v_amount then
    return v_pos;
  end if;

  if v_stored is null and v_fixed is null and v_pos is null
     and p_pl->>'taxStatus' in ('kleinunternehmer_19', 'reverse_charge_13b', 'tax_free')
     and (v_amount > 0 or v_ded = 0) then
    return v_amount + v_ded;
  end if;
  return null;
end;
$$;

/*
 * Buchungsbetraege einer Rechnung in Cent (invoiceBookingAmounts): Brutto ist der Betrag; eine Schlussrechnung mit
 * Abschlagsabzug bucht den Rest -- Netto abzueglich der verlaesslichen Abzugsnetti, sonst die Steuer des Rests ueber
 * den Satz. Steuer ist immer Brutto - Netto; ungeklaertes Netto bleibt NULL.
 */
create or replace function public.workspace_fc_rechnung_buchung(
  p_typ text,
  p_pl jsonb,
  out brutto bigint,
  out netto bigint
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_net bigint;
  v_rate integer;
  v_deductions jsonb;
  v_d jsonb;
  v_gross bigint;
  v_dnet bigint;
  v_sum bigint := 0;
  v_all boolean := true;
  v_steuer bigint;
begin
  brutto := case when jsonb_typeof(p_pl->'amount') = 'number'
                 then round((p_pl->>'amount')::numeric * 100)::bigint else 0 end;
  netto := null;
  v_net := public.workspace_fc_rechnung_netto(p_typ, p_pl);
  if v_net is null then
    return;
  end if;
  v_deductions := case when p_typ = 'schluss' and jsonb_typeof(p_pl->'previousAbschlagDeductions') = 'array'
                       then p_pl->'previousAbschlagDeductions' else '[]'::jsonb end;
  if jsonb_array_length(v_deductions) = 0 then
    netto := v_net;
    return;
  end if;
  v_rate := case p_pl->>'taxStatus' when 'standard_19' then 19 when 'standard_7' then 7 else 0 end;
  for v_d in select value from jsonb_array_elements(v_deductions) loop
    if jsonb_typeof(v_d->'amount') is distinct from 'number' then
      v_all := false;
      exit;
    end if;
    v_gross := round((v_d->>'amount')::numeric * 100)::bigint;
    if jsonb_typeof(v_d->'subtotal') = 'number' then
      v_dnet := round((v_d->>'subtotal')::numeric * 100)::bigint;
      if v_gross - v_dnet <> public.workspace_fc_steuer_aus_netto(v_dnet, v_rate) then
        v_all := false;
        exit;
      end if;
    elsif v_rate = 0 then
      v_dnet := v_gross;
    else
      v_all := false;
      exit;
    end if;
    v_sum := v_sum + v_dnet;
  end loop;
  if v_all then
    netto := v_net - v_sum;
    return;
  end if;
  v_steuer := case when v_rate > 0 then floor(brutto::numeric * v_rate / (100 + v_rate) + 0.5)::bigint else 0 end;
  netto := brutto - v_steuer;
end;
$$;

/*
 * Skontorahmen einer Rechnung (getSkontoFristStatus): Zahlbetrag nach Skonto und das fruehestmoegliche Fristende,
 * oder beides NULL ohne lesbares Skonto oder Basisdatum. Ein ungeklaertes Fristende zaehlt nicht als Skonto (der
 * Client gleicht nur bei "beglichen" aus).
 */
create or replace function public.workspace_fc_skonto_rahmen(
  p_workspace_id uuid,
  p_pl jsonb,
  p_lage jsonb,
  p_total bigint,
  out zahlbar bigint,
  out frist date
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_pct numeric;
  v_days integer;
  v_basis date;
  v_fenster record;
begin
  if nullif(btrim(coalesce(p_pl->>'skontoText', '')), '') is null then
    return;
  end if;
  select s.pct, s.days into v_pct, v_days from public.workspace_skonto_terms(p_pl->>'skontoText') s;
  v_basis := public.workspace_safe_date(
    case when jsonb_typeof(p_pl->'issueDate') = 'string' then p_pl->>'issueDate' else p_pl->>'date' end
  );
  if v_pct is null or v_pct <= 0 or v_pct >= 100 or v_days is null or v_basis is null then
    return;
  end if;
  select * into v_fenster
  from public.workspace_fristfenster(v_basis + v_days, coalesce(p_lage, public.workspace_invoice_frist_lage(p_workspace_id, p_pl)));
  zahlbar := round(p_total * (100 - v_pct) / 100)::bigint;
  frist := v_fenster.fruehestens;
end;
$$;

/* Offener Betrag in Cent (getOpenAmount) aus gezahlter Summe und Summe bis zum Skontofristende. */
create or replace function public.workspace_fc_offen(p_total bigint, p_zahlbar bigint, p_frist date, p_paid bigint, p_frueh bigint)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case
    when p_paid >= p_total then 0::bigint
    when p_frist is not null and p_frueh + 1 >= p_zahlbar then 0::bigint
    else p_total - p_paid
  end;
$$;

/* Wirksames Skonto nach einem Zahlungsstand (skontoAbzugDurchZahlung): ausgeglichen und etwas gezahlt. */
create or replace function public.workspace_fc_wirksames_skonto(p_total bigint, p_zahlbar bigint, p_frist date, p_paid bigint, p_frueh bigint)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case
    when public.workspace_fc_offen(p_total, p_zahlbar, p_frist, p_paid, p_frueh) = 0 and p_paid > 0
      then greatest(0, p_total - p_paid)
    else 0::bigint
  end;
$$;

revoke all on function public.workspace_fc_kanon(text) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_json_cent(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_geschaeftstag(text) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_zahlungsart(text) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_steuer_aus_netto(bigint, integer) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_betrag_aus_netto(text, bigint, integer, bigint) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_rechnung_netto(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_rechnung_buchung(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_skonto_rahmen(uuid, jsonb, jsonb, bigint) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_offen(bigint, bigint, date, bigint, bigint) from public, anon, authenticated, service_role;
revoke all on function public.workspace_fc_wirksames_skonto(bigint, bigint, date, bigint, bigint) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 4) Die Serverprojektion eines Monats (Fassung 5)                                                  */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Der kanonische Text, wie ihn der Server aus seinem Bestand bildet, dazu Belegzahl, Summen und die Belege ohne
 * abschlussfaehige Kontierung. Zeilen (identisch mit buildPeriodCanonicalTextV5):
 *
 *   v=5|month=<YYYY-MM>|chart=<Kontenrahmen>
 *   E|st|sid|belegart|datum|brutto|netto|steuer|skonto|status|kontenrahmen|konto|steuerbehandlung|kontierungsstatus|text
 *   P|st|sid|zahlung|datum|betrag|skonto|zahlungsart
 *   M|zahlung|art|datum|betrag|art der Zahlung|zahlungsweg|status
 *   O|belegart|beleg|datum|brutto|bezahlt|offen|faellig
 *
 * Auswahl wie die Monatsmappe (buildMonatsmappeModel): freigegebene Rechnungen, gebuchte und stornierte Ausgaben
 * ohne Grabstein; Stornos im Monat ihres Geschaeftstags (Europe/Berlin); nicht zurueckgenommene Zahlungen nach
 * Zahlungsdatum, ohne Zahlungen stornierter Belege; offene Posten aller Belege bis zum Monatsende, Stand
 * Monatsende.
 */
create or replace function public.workspace_fc_abschluss_projektion(
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
           left(coalesce(we.payload->>'paymentDueDate', ''), 10) as faellig
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
           rb.steuerstatus
    from rb
    left join oi on oi.id = rb.id
    where left(rb.belegdatum, 7) = v_mk
    union all
    select 'invoice', rb.id, 'rechnungsstorno', rb.stornotag, -rb.brutto, -rb.netto, -(rb.brutto - rb.netto), 0::bigint, 'storno', rb.steuerstatus
    from rb
    where rb.stornotag is not null and left(rb.stornotag, 7) = v_mk
    union all
    select 'expense', rx.id, 'eingangsbeleg', rx.belegdatum, rx.brutto, rx.netto, rx.steuer, 0::bigint,
           case when rx.status = 'storniert' and (rx.stornotag is null or rx.stornotag <= v_me collate "C") then 'storniert' else 'aktiv' end,
           rx.steuerstatus
    from rx
    where left(rx.belegdatum, 7) = v_mk
    union all
    select 'expense', rx.id, 'ausgabenstorno', rx.stornotag, -rx.brutto, -rx.netto, -rx.steuer, 0::bigint, 'storno', rx.steuerstatus
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
      'v=5|month=' || public.workspace_fc_kanon(v_mk) || '|chart=' || public.workspace_fc_kanon(v_chart),
      (select string_agg(
                'E|' || public.workspace_fc_kanon(ek.st) || '|' || public.workspace_fc_kanon(ek.sid) || '|'
                  || public.workspace_fc_kanon(ek.belegart) || '|' || public.workspace_fc_kanon(ek.datum) || '|'
                  || ek.brutto::text || '|' || coalesce(ek.netto::text, '-') || '|' || coalesce(ek.steuer::text, '-') || '|'
                  || ek.skonto::text || '|' || public.workspace_fc_kanon(ek.status) || '|' || public.workspace_fc_kanon(ek.kontenrahmen) || '|'
                  || public.workspace_fc_kanon(ek.konto) || '|' || public.workspace_fc_kanon(ek.steuerbehandlung) || '|'
                  || public.workspace_fc_kanon(ek.kontierungsstatus) || '|' || public.workspace_fc_kanon(ek.buchungstext),
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
       from nb where nb.grund is not null),
      '[]'::jsonb
    )
  )
  into v_res;

  return v_res || jsonb_build_object(
    'fingerprint', 'p5:' || encode(sha256(convert_to(v_res->>'text', 'UTF8')), 'hex')
  );
end;
$$;

revoke all on function public.workspace_fc_abschluss_projektion(uuid, integer, integer) from public, anon, authenticated, service_role;

/*
 * Der kanonische Text eines uebergebenen Manifests -- dieselbe Bildung wie buildPeriodCanonicalTextV5, damit kein
 * Manifest mit passendem Fingerabdruck, aber anderen Werten gespeichert wird.
 */
create or replace function public.workspace_fc_manifest_text(p_manifest jsonb)
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
    'v=5|month=' || public.workspace_fc_kanon(p_manifest->>'monthKey') || '|chart=' || public.workspace_fc_kanon(p_manifest->>'chartOfAccounts'),
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
                || public.workspace_fc_kanon(x->>'bookingText'),
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

revoke all on function public.workspace_fc_manifest_text(jsonb) from public, anon, authenticated, service_role;

/*
 * Unterschiede zwischen Manifest- und Servertext als Kurzbefund: fehlende, erfundene, abweichende und doppelte
 * Zeilen (Schluessel ohne Betraege) und ein abweichender Kopf.
 */
create or replace function public.workspace_fc_text_befund(p_client text, p_server text)
returns text
language sql
immutable
set search_path = public
as $$
  with
  c as (
    select l, case
      when l like 'E|%' then array_to_string((string_to_array(l, '|'))[1:4], '|')
      when l like 'P|%' then array_to_string((string_to_array(l, '|'))[1:4], '|')
      when l like 'M|%' then array_to_string((string_to_array(l, '|'))[1:3], '|')
      when l like 'O|%' then array_to_string((string_to_array(l, '|'))[1:3], '|')
      else 'KOPF' end as k
    from unnest(string_to_array(coalesce(p_client, ''), chr(10))) l
  ),
  s as (
    select l, case
      when l like 'E|%' then array_to_string((string_to_array(l, '|'))[1:4], '|')
      when l like 'P|%' then array_to_string((string_to_array(l, '|'))[1:4], '|')
      when l like 'M|%' then array_to_string((string_to_array(l, '|'))[1:3], '|')
      when l like 'O|%' then array_to_string((string_to_array(l, '|'))[1:3], '|')
      else 'KOPF' end as k
    from unnest(string_to_array(coalesce(p_server, ''), chr(10))) l
  ),
  befund as (
    select 'fehlend' as art, s.k from s where s.k <> 'KOPF' and not exists (select 1 from c where c.k = s.k)
    union all
    select 'erfunden', c.k from c where c.k <> 'KOPF' and not exists (select 1 from s where s.k = c.k)
    union all
    select distinct 'abweichend', c.k from c
      where c.k <> 'KOPF' and exists (select 1 from s where s.k = c.k)
        and not exists (select 1 from s where s.k = c.k and s.l = c.l)
    union all
    select 'doppelt', c.k from c where c.k <> 'KOPF' group by c.k having count(*) > 1
    union all
    select 'kopf', 'KOPF' where (select string_agg(l, '') from c where k = 'KOPF') is distinct from (select string_agg(l, '') from s where k = 'KOPF')
  )
  select format(
    'fehlend=%s erfunden=%s abweichend=%s doppelt=%s kopf=%s; %s',
    (select count(*) from befund where art = 'fehlend'),
    (select count(*) from befund where art = 'erfunden'),
    (select count(*) from befund where art = 'abweichend'),
    (select count(*) from befund where art = 'doppelt'),
    (select count(*) from befund where art = 'kopf'),
    coalesce((select string_agg(art || ' ' || k, ', ' order by art, k collate "C")
              from (select * from befund order by art, k collate "C" limit 5) b), '')
  );
$$;

revoke all on function public.workspace_fc_text_befund(text, text) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 5) Monat abschliessen                                                                             */
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

  /* SYS-01 -- nur Fassung 5 ist pruefbar; aeltere Clients werden sichtbar abgewiesen, nicht still angenommen. */
  if coalesce(v_manifest->>'fingerprintVersion', '') <> '5' or v_fingerprint not like 'p5:%' then
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

  v_proj := public.workspace_fc_abschluss_projektion(p_workspace_id, v_year, v_month);

  /* Bereitschaft wie collectPeriodBlockers -- auch gegen direkte Aufrufe. */
  v_nicht := v_proj->'nichtBereit';
  if jsonb_array_length(v_nicht) > 0 then
    raise exception 'closure_not_ready: % Beleg(e) ohne abschlussfaehige Kontierung (%)',
      jsonb_array_length(v_nicht),
      (select string_agg((n->>'sourceType') || ':' || (n->>'sourceId') || ' ' || (n->>'grund'), ', ')
       from (select n from jsonb_array_elements(v_nicht) n limit 5) q)
      using errcode = 'P0001';
  end if;

  v_client_text := public.workspace_fc_manifest_text(v_manifest);
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
    5, v_stand, now()
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

/* ------------------------------------------------------------------------------------------------ */
/* 6) Monat wieder oeffnen                                                                           */
/* ------------------------------------------------------------------------------------------------ */

create or replace function public.reopen_workspace_accounting_period(
  p_workspace_id uuid,
  p_period_year integer,
  p_period_month integer,
  p_reason text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_active public.workspace_accounting_period_closures;
  v_row public.workspace_accounting_period_closures;
begin
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

  /* SYS-03 (D3) -- dieselbe Sperre wie der Abschluss: Abschluss und Wiederoeffnung laufen nacheinander. */
  perform public.workspace_fc_datenstand_sperren(p_workspace_id);

  select * into v_active
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = p_period_year
    and period_month = p_period_month
    and reopened_at is null
  for update;

  if v_active.id is null then
    raise exception 'period_not_closed: kein offener Abschluss fuer %-%',
      p_period_year, p_period_month using errcode = 'P0001';
  end if;

  if p_expected_revision is not null and v_active.revision <> p_expected_revision then
    raise exception 'Versionskonflikt: offene Revision ist %, erwartet %',
      v_active.revision, p_expected_revision;
  end if;

  update public.workspace_accounting_period_closures
  set reopened_at = now(),
      reopened_by = v_user_id,
      reopen_reason = nullif(trim(coalesce(p_reason, '')), ''),
      row_version = row_version + 1,
      updated_at = now()
  where id = v_active.id
  returning * into v_row;

  return jsonb_build_object(
    'revision', v_row.revision,
    'reopened_at', v_row.reopened_at,
    'row_version', v_row.row_version
  );
end;
$$;

/* ------------------------------------------------------------------------------------------------ */
/* 7) Abschluesse lesen -- mit Serverbestaetigung                                                   */
/* ------------------------------------------------------------------------------------------------ */

create or replace function public.pull_workspace_accounting_period_closures(p_workspace_id uuid)
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
    'closures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_closure_id', c.client_closure_id,
        'period_year', c.period_year,
        'period_month', c.period_month,
        'revision', c.revision,
        'fingerprint', c.fingerprint,
        'manifest', c.manifest,
        'closed_at', c.closed_at,
        'closed_by', c.closed_by,
        'reopened_at', c.reopened_at,
        'reopened_by', c.reopened_by,
        'reopen_reason', c.reopen_reason,
        'row_version', c.row_version,
        /* Systemische Gesamtnacharbeit (E1) -- nur eine servervalidierte Revision traegt diese Angaben. */
        'validated_version', c.validated_version,
        'finance_revision', c.finance_revision,
        'validated_at', c.validated_at
      ) order by c.period_year desc, c.period_month desc, c.revision desc)
      from public.workspace_accounting_period_closures c
      where c.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.close_workspace_accounting_period(uuid, jsonb) from public, anon;
revoke all on function public.reopen_workspace_accounting_period(uuid, integer, integer, text, integer) from public, anon;
revoke all on function public.pull_workspace_accounting_period_closures(uuid) from public, anon;
grant execute on function public.close_workspace_accounting_period(uuid, jsonb) to authenticated;
grant execute on function public.reopen_workspace_accounting_period(uuid, integer, integer, text, integer) to authenticated;
grant execute on function public.pull_workspace_accounting_period_closures(uuid) to authenticated;
