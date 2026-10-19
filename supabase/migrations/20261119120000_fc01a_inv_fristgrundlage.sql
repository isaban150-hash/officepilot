/*
 * FINANZ-CORE-01A -- Gesamtnacharbeit Paket 1 (WEISS-Gesamtmaengelinventur vom 15.10.2026):
 * historische Frist- und Zahlungsgrundlage.
 *
 *  INV-01  Unverknuepfter Altbeleg ohne Klaerungsweg. Bisher half nur die Angabe am Kunden, und die
 *          erreicht eine Rechnung ohne customerId nie. Neu: Klaerung je Rechnung
 *          (clarify_workspace_invoice_frist), nur Inhaber/Verwaltung, protokolliert in
 *          workspace_invoice_frist_klaerungen; der Beleg (payload) bleibt unveraendert.
 *  INV-02  Auslandsfrist mit Dreitagesgrenze. Ohne Bestaetigung am Kunden und ohne gepruefte Angabe zu
 *          genau diesem Fristende bleibt jede Zahlung nach dem (Sa/So-verschobenen) Ende ungeklaert,
 *          ohne Hoechstdauer (spaetestens = infinity). Die Klaerung haelt das gepruefte wirksame
 *          Fristende fest (lage.geprueft: kalendarisches Ende -> wirksames Ende).
 *  INV-03  Live-Kundenort veraenderte abgerechnete Abschlaege. Neu: Spalte workspace_invoices.frist_basis,
 *          bei der Freigabe gebunden (Trigger), fuer den Bestand in dieser Migration; spaetere
 *          Kundenaenderungen wirken nur auf neue Rechnungen. Aendern laesst sie nur die Klaerung.
 *          Ausserdem nimmt ein Abschlag, den eine wirksame Schlussrechnung abzieht, keine NEUE Zahlung
 *          mehr an, wenn diese Zahlung und Skonto eingefroren hat -- unabhaengig vom offenen Betrag, auch
 *          nicht ueber den Bankabgleich (der dieselbe Funktion ruft); die Wiederholung derselben
 *          Zahlungskennung bleibt. Ein Altabzug ohne Aufteilung (vor N02) bleibt bis zum Rest zahlbar.
 *          Ein alter Client, der einen Kunden ohne holidayLocation schreibt, loescht die Angabe nicht
 *          mehr (Trigger); entfernt wird sie nur mit ausdruecklichem null.
 *  INV-05  Zusatzgeld nach Skonto: Der Server bleibt beim Vertrag, den die Schlussrechnung schon
 *          prueft (20261116, invoice_abschlag_settlement_mismatch): gezahlt = min(Betrag, Zahlungen),
 *          Skonto = Betrag - gezahlt. Keine Aenderung hier; Client-Leser folgen demselben Vertrag.
 *
 * Neu: Spalte workspace_invoices.frist_basis, Tabelle workspace_invoice_frist_klaerungen, Funktionen
 * workspace_invoice_abschlag_abzug, workspace_invoices_frist_basis (Trigger),
 * workspace_customers_holiday_location (Trigger), clarify_workspace_invoice_frist.
 * Ersetzt: workspace_fristfenster, workspace_invoice_open_cents (20261118), add_workspace_invoice_payment
 * (20261115), pull_workspace_invoices (20260913). Jede ersetzte Funktion ist wortgleich aus ihrer neuesten
 * Fassung uebernommen; geaendert sind allein die mit "INV-" markierten Stellen. Autorisierung,
 * Rollenpruefung und Kontosperre stehen unveraendert vor jeder neuen Pruefung.
 *
 * Setzt 20261114120000 bis 20261118120000 voraus und aendert keine davon. Nur lokal angewendet;
 * Produktion: 20261114 -> ... -> 20261118 -> 20261119 -> (weitere Pakete) -> Client.
 */

/* ------------------------------------------------------------------------------------------------ */
/* 1) Fristgrundlage je Rechnung und Klaerungsprotokoll                                              */
/* ------------------------------------------------------------------------------------------------ */

alter table public.workspace_invoices
  add column if not exists frist_basis jsonb null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_invoices_frist_basis_check'
      and conrelid = 'public.workspace_invoices'::regclass
  ) then
    alter table public.workspace_invoices
      add constraint workspace_invoices_frist_basis_check
      check (frist_basis is null or (jsonb_typeof(frist_basis) = 'object' and jsonb_typeof(frist_basis->'lage') = 'object'));
  end if;
end;
$$;

create table if not exists public.workspace_invoice_frist_klaerungen (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_invoice_id text not null,
  client_klaerung_id text not null,
  klaerung jsonb not null,
  begruendung text not null,
  lage_vorher jsonb null,
  lage_nachher jsonb not null,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint workspace_invoice_frist_klaerungen_id_unique unique (workspace_id, client_klaerung_id),
  constraint workspace_invoice_frist_klaerungen_begruendung_check check (length(btrim(begruendung)) between 3 and 500)
);

create index if not exists workspace_invoice_frist_klaerungen_invoice_idx
  on public.workspace_invoice_frist_klaerungen (workspace_id, client_invoice_id, created_at);

alter table public.workspace_invoice_frist_klaerungen enable row level security;
revoke all on table public.workspace_invoice_frist_klaerungen from public, anon, authenticated, service_role;
grant select on table public.workspace_invoice_frist_klaerungen to authenticated;

drop policy if exists workspace_invoice_frist_klaerungen_select_member on public.workspace_invoice_frist_klaerungen;
create policy workspace_invoice_frist_klaerungen_select_member
on public.workspace_invoice_frist_klaerungen for select to authenticated
using (public.is_active_workspace_member(workspace_id));

/* ------------------------------------------------------------------------------------------------ */
/* 2) Fristfenster: Ausland ohne Hoechstdauer, gepruefte Fristenden (INV-02)                         */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Jedes moegliche wirksame Fristende liegt in [fruehestens, spaetestens]. Wie berechneFristFenster im
 * Client: abbedungen -> kalendarisch; inland -> ueber freie Tage (fruehestens) bzw. freie und unklare Tage
 * (spaetestens); ausland -> Sa/So verschoben, dann
 *   - geprueftes Ende zu genau diesem kalendarischen Ende (lage.geprueft) -> dieses Ende;
 *   - am Kunden bestaetigt, dass dort keine Feiertage verschieben -> das Sa/So-Ende;
 *   - sonst offen: spaetestens = infinity (INV-02; bisher drei Werktage).
 */
create or replace function public.workspace_fristfenster(
  p_ende date,
  p_lage jsonb,
  out fruehestens date,
  out spaetestens date
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_i integer;
  v_geprueft date;
begin
  if p_lage->>'art' = 'abbedungen' then
    fruehestens := p_ende;
    spaetestens := p_ende;
    return;
  end if;
  if p_lage->>'art' = 'ausland' then
    fruehestens := p_ende;
    v_i := 0;
    while v_i < 40 and extract(isodow from fruehestens) in (6, 7) loop
      fruehestens := fruehestens + 1;
      v_i := v_i + 1;
    end loop;
    /* INV-02 -- das gepruefte Ende zu genau diesem kalendarischen Ende. */
    if jsonb_typeof(p_lage->'geprueft'->(to_char(p_ende, 'YYYY-MM-DD'))) = 'string' then
      v_geprueft := public.workspace_safe_date(p_lage->'geprueft'->>(to_char(p_ende, 'YYYY-MM-DD')));
      if v_geprueft is not null and v_geprueft >= fruehestens then
        fruehestens := v_geprueft;
        spaetestens := v_geprueft;
        return;
      end if;
    end if;
    if coalesce(p_lage->'ohneFeiertagBestaetigt' = 'true'::jsonb, false) then
      spaetestens := fruehestens;
    else
      /* INV-02 -- keine Hoechstdauer: ohne Klaerung bleibt das Ende offen. */
      spaetestens := 'infinity'::date;
    end if;
    return;
  end if;
  fruehestens := p_ende;
  v_i := 0;
  while v_i < 40 and public.workspace_frist_tagstatus(fruehestens, p_lage) = 'frei' loop
    fruehestens := fruehestens + 1;
    v_i := v_i + 1;
  end loop;
  spaetestens := p_ende;
  v_i := 0;
  while v_i < 40 and public.workspace_frist_tagstatus(spaetestens, p_lage) <> 'werktag' loop
    spaetestens := spaetestens + 1;
    v_i := v_i + 1;
  end loop;
end;
$$;

revoke all on function public.workspace_fristfenster(date, jsonb) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 3) Bindung bei der Freigabe (INV-03)                                                              */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Bei jeder finalisierten Zeile ohne Fristgrundlage wird die Lage gebunden, die in diesem Augenblick gilt
 * (Vereinbarung -> Angabe am Kunden -> Land/PLZ der Rechnungsanschrift -> unbekannt). Danach aendert sie
 * nur clarify_workspace_invoice_frist (Sitzungsmerker officetakt.frist_klaerung); jeder andere Schreiber
 * laesst sie stehen oder wird abgewiesen. So deutet keine spaetere Kundenaenderung eine Rechnung um.
 */
create or replace function public.workspace_invoices_frist_basis()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.invoice_status <> 'entwurf' then
      new.frist_basis := jsonb_build_object(
        'lage', public.workspace_invoice_frist_lage(new.workspace_id, new.payload),
        'quelle', 'freigabe',
        'festgelegtAm', to_jsonb(now())
      );
    else
      new.frist_basis := null;
    end if;
    return new;
  end if;

  if new.frist_basis is distinct from old.frist_basis
     and coalesce(current_setting('officetakt.frist_klaerung', true), '') <> 'on' then
    raise exception 'invoice_frist_basis_immutable' using errcode = 'P0001';
  end if;
  if new.frist_basis is null and new.invoice_status <> 'entwurf' then
    new.frist_basis := jsonb_build_object(
      'lage', public.workspace_invoice_frist_lage(new.workspace_id, new.payload),
      'quelle', 'freigabe',
      'festgelegtAm', to_jsonb(now())
    );
  end if;
  return new;
end;
$$;

revoke all on function public.workspace_invoices_frist_basis() from public, anon, authenticated, service_role;

drop trigger if exists workspace_invoices_frist_basis on public.workspace_invoices;
create trigger workspace_invoices_frist_basis
before insert or update on public.workspace_invoices
for each row
execute function public.workspace_invoices_frist_basis();

/* Bestand: die Lage, mit der der Server bis heute rechnet (20261118, live), wird jetzt festgehalten. */
select set_config('officetakt.frist_klaerung', 'on', true);
update public.workspace_invoices
set frist_basis = jsonb_build_object(
  'lage', public.workspace_invoice_frist_lage(workspace_id, payload),
  'quelle', 'bestand',
  'festgelegtAm', to_jsonb(now())
)
where invoice_status <> 'entwurf'
  and frist_basis is null;
select set_config('officetakt.frist_klaerung', 'off', true);

/* ------------------------------------------------------------------------------------------------ */
/* 4) Ortsangabe am Kunden: Weglassen ist kein Loeschen (INV-03, alte Clients)                       */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Ein Client ohne Kenntnis von holidayLocation schreibt den ganzen Kunden-Payload ohne diesen Schluessel
 * (upsert_workspace_sync_entity ersetzt den Payload). Fehlt der Schluessel, bleibt die gespeicherte Angabe;
 * ein ausdrueckliches null (neuer Client) entfernt sie; alles, was kein Objekt ist, wird nicht gespeichert.
 */
create or replace function public.workspace_customers_holiday_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and not new.deleted
     and jsonb_typeof(new.payload) = 'object'
     and jsonb_typeof(old.payload->'holidayLocation') = 'object'
     and not (new.payload ? 'holidayLocation') then
    new.payload := new.payload || jsonb_build_object('holidayLocation', old.payload->'holidayLocation');
  end if;
  if jsonb_typeof(new.payload) = 'object'
     and new.payload ? 'holidayLocation'
     and jsonb_typeof(new.payload->'holidayLocation') <> 'object' then
    new.payload := new.payload - 'holidayLocation';
  end if;
  return new;
end;
$$;

revoke all on function public.workspace_customers_holiday_location() from public, anon, authenticated, service_role;

drop trigger if exists workspace_customers_holiday_location on public.workspace_customers;
create trigger workspace_customers_holiday_location
before insert or update on public.workspace_customers
for each row
execute function public.workspace_customers_holiday_location();

/* ------------------------------------------------------------------------------------------------ */
/* 5) Offener Betrag mit gebundener Lage (aus 20261118)                                              */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Wie 20261118. INV-03: Lage aus frist_basis (bei der Freigabe gebunden oder geklaert), nur ohne sie live.
 * INV-02: ein offenes Auslandsende heisst in der Meldung "offen".
 */
create or replace function public.workspace_invoice_open_cents(
  p_workspace_id uuid,
  p_client_invoice_id text
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_payload jsonb;
  v_basis_lage jsonb;
  v_total numeric;
  v_paid numeric;
  v_pct numeric;
  v_days integer;
  v_basis date;
  v_fenster record;
  v_payable numeric;
  v_bis_frueh numeric;
  v_bis_spaet numeric;
begin
  select wi.payload, wi.frist_basis->'lage', round((wi.payload->>'amount')::numeric * 100)
    into v_payload, v_basis_lage, v_total
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = p_client_invoice_id
    and jsonb_typeof(wi.payload->'amount') = 'number';
  if v_payload is null then return null; end if;

  select coalesce(sum(round(p.amount * 100)), 0) into v_paid
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = p_client_invoice_id
    and p.reversed_at is null;
  if v_paid >= v_total then return 0; end if;

  select s.pct, s.days into v_pct, v_days from public.workspace_skonto_terms(v_payload->>'skontoText') s;
  v_basis := public.workspace_safe_date(
    case when jsonb_typeof(v_payload->'issueDate') = 'string' then v_payload->>'issueDate' else v_payload->>'date' end
  );
  if v_pct is null or v_pct <= 0 or v_pct >= 100 or v_days is null or v_basis is null then
    return v_total - v_paid;
  end if;

  /* INV-03 -- die gebundene Lage; nur eine Zeile ohne Bindung (Entwurf) rechnet live. */
  select * into v_fenster
  from public.workspace_fristfenster(
    v_basis + v_days,
    coalesce(v_basis_lage, public.workspace_invoice_frist_lage(p_workspace_id, v_payload))
  );
  v_payable := round(v_total * (100 - v_pct) / 100);

  select coalesce(sum(round(p.amount * 100)) filter (where p.paid_on <= v_fenster.fruehestens), 0),
         coalesce(sum(round(p.amount * 100)) filter (where p.paid_on <= v_fenster.spaetestens), 0)
    into v_bis_frueh, v_bis_spaet
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = p_client_invoice_id
    and p.reversed_at is null;

  if v_bis_frueh + 1 >= v_payable then return 0; end if;
  if v_bis_spaet + 1 >= v_payable then
    raise exception 'invoice_skonto_deadline_unclear: Frist % bis %', v_fenster.fruehestens,
      case when v_fenster.spaetestens = 'infinity'::date then 'offen' else v_fenster.spaetestens::text end
      using errcode = 'P0001';
  end if;
  return v_total - v_paid;
end;
$$;

revoke all on function public.workspace_invoice_open_cents(uuid, text) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 6) Abschlag in wirksamer Schlussrechnung (INV-03)                                                 */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Der Abzug dieses Abschlags in einer wirksamen (freigegebenen, nicht stornierten) Schlussrechnung
 * desselben Vorgangs, oder NULL. Seit N02 friert der Abzug gezahlt (paidAmount) und Skonto
 * (skontoAmount) ein; ein Altabzug ohne diese Aufteilung zog den vollen Betrag ab.
 */
create or replace function public.workspace_invoice_abschlag_abzug(
  p_workspace_id uuid,
  p_client_invoice_id text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select d.value
  from public.workspace_invoices a
  join public.workspace_invoices s
    on s.workspace_id = a.workspace_id
   and s.vorgang_id = a.vorgang_id
  cross join lateral jsonb_array_elements(coalesce(s.payload->'previousAbschlagDeductions', '[]'::jsonb)) d
  where a.workspace_id = p_workspace_id
    and a.client_invoice_id = p_client_invoice_id
    and a.invoice_type = 'abschlag'
    and a.vorgang_id is not null
    and s.invoice_type = 'schluss'
    and s.invoice_status in ('vorbereitet', 'versendet')
    and s.cancelled_at is null
    and d.value->>'invoiceId' = p_client_invoice_id
  limit 1;
$$;

revoke all on function public.workspace_invoice_abschlag_abzug(uuid, text) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------------------------------ */
/* 7) Zahlungsannahme (aus 20261115)                                                                 */
/* ------------------------------------------------------------------------------------------------ */

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
  /* INV-03 */
  v_abzug jsonb;
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
    /*
     * INV-03 -- ein Abschlag, dessen Zahlung und Skonto eine wirksame Schlussrechnung eingefroren hat
     * (Abzug mit paidAmount, seit N02), nimmt keine NEUE Zahlung mehr an, gleich wie hoch sein offener
     * Betrag gerade erscheint. Jede weitere Zahlung machte die eingefrorene Aufteilung falsch und waere
     * wegen A2 nicht einmal ruecknehmbar. Bisher galt die Sperre nur oberhalb des offenen Betrags --
     * und den konnte eine spaetere Ortsaenderung wieder oeffnen (WEISS S1). Geld nach der
     * Schlussrechnung gehoert auf die Schlussrechnung. Der Bankabgleich ruft diese Funktion.
     *
     * Ein Altabzug ohne Aufteilung (vor N02) zog den vollen Betrag ab, auch wenn der Abschlag noch
     * nicht bezahlt war; sein Rest bleibt wie bisher bis zum offenen Betrag zahlbar (Z2c), sonst
     * waere er nie buchbar.
     */
    v_abzug := case when v_invoice.invoice_type = 'abschlag'
                    then public.workspace_invoice_abschlag_abzug(p_workspace_id, v_invoice_id) end;
    if jsonb_typeof(v_abzug->'paidAmount') = 'number' then
      raise exception 'invoice_payment_final_invoice_exists: Abschlag in Schlussrechnung abgezogen'
        using errcode = 'P0001';
    end if;
    v_open_cents := public.workspace_invoice_open_cents(p_workspace_id, v_invoice_id);
    if v_open_cents is not null and round(p_amount, 2) * 100 > v_open_cents then
      if v_abzug is not null then
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

/* ------------------------------------------------------------------------------------------------ */
/* 8) Klaerung der Fristgrundlage je Rechnung (INV-01/02)                                            */
/* ------------------------------------------------------------------------------------------------ */

/*
 * Haelt fuer genau eine Rechnung fest, wo ihre Fristen enden -- auch fuer eine Rechnung ohne
 * customerId. Der Beleg (payload) bleibt unveraendert; geaendert wird nur frist_basis, und jeder Schritt
 * steht mit Person, Zeit, Begruendung sowie Lage vorher/nachher in workspace_invoice_frist_klaerungen.
 *
 *   {"art":"inland","region":"NW"[,"fronleichnam":true|false][,"mariaeHimmelfahrt":..][,"augsburgerFriedensfest":..]}
 *       Sitz des Kunden in diesem Bundesland (Gemeindefeiertage nur, wo sie etwas bedeuten).
 *   {"art":"ausland","kalenderEnde":"YYYY-MM-DD","wirksamesEnde":"YYYY-MM-DD"}
 *       Sitz im Ausland; fuer das kalendarische Ende einer Frist dieser Rechnung (Skontofrist oder
 *       Zahlungsziel) ist das wirksame Ende geprueft. Weitere Fristenden bleiben offen, bis auch sie
 *       geprueft sind.
 *
 * Nur Inhaber/Verwaltung (assert_financial_action_allowed). Sperrfolge Vorgang -> Rechnung wie Zahlung,
 * Storno und Schlussrechnung. Abgewiesen: Entwurf, Storno, abweichende Vereinbarung (kalendarisch),
 * Abschlag in wirksamer Schlussrechnung (eingefroren). Dieselbe client_klaerung_id mit demselben Inhalt
 * liefert die Zeile erneut; mit anderem Inhalt ist sie ein Konflikt.
 */
create or replace function public.clarify_workspace_invoice_frist(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_klaerung_id text,
  p_klaerung jsonb,
  p_begruendung text
)
returns setof public.workspace_invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice_id text;
  v_klaerung_id text;
  v_begruendung text;
  v_vorgang_id text;
  v_invoice public.workspace_invoices;
  v_existing public.workspace_invoice_frist_klaerungen;
  v_art text;
  v_region text;
  v_gemeinde jsonb := '{}'::jsonb;
  v_lage_vorher jsonb;
  v_lage jsonb;
  v_kalender date;
  v_wirksam date;
  v_frueh date;
  v_i integer;
  v_pct numeric;
  v_days integer;
  v_basis date;
  v_ziel date;
  v_klaerung jsonb;
  v_updated public.workspace_invoices;
begin
  perform public.assert_financial_action_allowed(p_workspace_id);

  v_invoice_id := nullif(btrim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;
  v_klaerung_id := nullif(btrim(coalesce(p_client_klaerung_id, '')), '');
  if v_klaerung_id is null or length(v_klaerung_id) > 120 then
    raise exception 'invoice_frist_klaerung_invalid: client_klaerung_id' using errcode = 'P0001';
  end if;
  v_begruendung := btrim(coalesce(p_begruendung, ''));
  if length(v_begruendung) < 3 or length(v_begruendung) > 500 then
    raise exception 'invoice_frist_klaerung_invalid: begruendung' using errcode = 'P0001';
  end if;
  if p_klaerung is null or jsonb_typeof(p_klaerung) <> 'object' then
    raise exception 'invoice_frist_klaerung_invalid: klaerung' using errcode = 'P0001';
  end if;

  /* Normalform der Angabe -- nur die Schluessel, die fuer ihre Art etwas bedeuten. */
  v_art := p_klaerung->>'art';
  if v_art = 'inland' then
    v_region := p_klaerung->>'region';
    if v_region is null or not (v_region = any (array['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'])) then
      raise exception 'invoice_frist_klaerung_invalid: region' using errcode = 'P0001';
    end if;
    if v_region in ('SN', 'TH') and jsonb_typeof(p_klaerung->'fronleichnam') = 'boolean' then
      v_gemeinde := v_gemeinde || jsonb_build_object('fronleichnam', p_klaerung->'fronleichnam');
    end if;
    if v_region = 'BY' then
      if jsonb_typeof(p_klaerung->'mariaeHimmelfahrt') = 'boolean' then
        v_gemeinde := v_gemeinde || jsonb_build_object('mariaeHimmelfahrt', p_klaerung->'mariaeHimmelfahrt');
      end if;
      if jsonb_typeof(p_klaerung->'augsburgerFriedensfest') = 'boolean' then
        v_gemeinde := v_gemeinde || jsonb_build_object('augsburgerFriedensfest', p_klaerung->'augsburgerFriedensfest');
      end if;
    end if;
    v_klaerung := jsonb_build_object('art', 'inland', 'region', v_region) || v_gemeinde;
  elsif v_art = 'ausland' then
    v_kalender := public.workspace_safe_date(p_klaerung->>'kalenderEnde');
    v_wirksam := public.workspace_safe_date(p_klaerung->>'wirksamesEnde');
    if v_kalender is null or v_wirksam is null then
      raise exception 'invoice_frist_klaerung_invalid: datum' using errcode = 'P0001';
    end if;
    v_frueh := v_kalender;
    v_i := 0;
    while v_i < 40 and extract(isodow from v_frueh) in (6, 7) loop
      v_frueh := v_frueh + 1;
      v_i := v_i + 1;
    end loop;
    /* Das wirksame Ende liegt nie vor dem Sa/So-Ende; 60 Tage sind eine Eingabegrenze, keine Fristregel. */
    if v_wirksam < v_frueh or v_wirksam > v_kalender + 60 or extract(isodow from v_wirksam) in (6, 7) then
      raise exception 'invoice_frist_klaerung_invalid: wirksamesEnde' using errcode = 'P0001';
    end if;
    v_klaerung := jsonb_build_object(
      'art', 'ausland',
      'kalenderEnde', to_char(v_kalender, 'YYYY-MM-DD'),
      'wirksamesEnde', to_char(v_wirksam, 'YYYY-MM-DD')
    );
  else
    raise exception 'invoice_frist_klaerung_invalid: art' using errcode = 'P0001';
  end if;

  /* Wiederholung derselben Kennung. */
  select * into v_existing
  from public.workspace_invoice_frist_klaerungen k
  where k.workspace_id = p_workspace_id
    and k.client_klaerung_id = v_klaerung_id;
  if v_existing.id is not null then
    if v_existing.client_invoice_id is distinct from v_invoice_id
       or v_existing.klaerung is distinct from v_klaerung
       or v_existing.begruendung is distinct from v_begruendung then
      raise exception 'invoice_frist_klaerung_conflict' using errcode = 'P0001';
    end if;
    return query
      select wi.* from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id and wi.client_invoice_id = v_invoice_id;
    return;
  end if;

  /* Sperrfolge wie Zahlung, Storno und Schlussrechnung: erst der Vorgang, dann die Rechnung. */
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
  if v_invoice.cancelled_at is not null then
    raise exception 'Rechnung storniert';
  end if;
  if v_invoice.invoice_type = 'abschlag'
     and public.workspace_invoice_abschlag_abzug(p_workspace_id, v_invoice_id) is not null then
    raise exception 'invoice_frist_final_invoice_exists' using errcode = 'P0001';
  end if;

  v_lage_vorher := coalesce(v_invoice.frist_basis->'lage',
                            public.workspace_invoice_frist_lage(p_workspace_id, v_invoice.payload));
  if v_lage_vorher->>'art' = 'abbedungen' then
    raise exception 'invoice_frist_abbedungen' using errcode = 'P0001';
  end if;

  if v_art = 'inland' then
    v_lage := jsonb_build_object(
      'art', 'inland',
      'laender', jsonb_build_array(v_region),
      'gemeinde', v_gemeinde,
      'quelle', 'klaerung'
    );
  else
    /* Nur ein Fristende dieser Rechnung: die Skontofrist oder das Zahlungsziel. */
    select s.pct, s.days into v_pct, v_days from public.workspace_skonto_terms(v_invoice.payload->>'skontoText') s;
    v_basis := public.workspace_safe_date(
      case when jsonb_typeof(v_invoice.payload->'issueDate') = 'string'
           then v_invoice.payload->>'issueDate' else v_invoice.payload->>'date' end
    );
    v_ziel := public.workspace_safe_date(left(coalesce(v_invoice.payload->>'paymentDueDate', ''), 10));
    if not (
      (v_pct is not null and v_pct > 0 and v_pct < 100 and v_days is not null and v_basis is not null
         and v_kalender = v_basis + v_days)
      or (v_ziel is not null and v_kalender = v_ziel)
    ) then
      raise exception 'invoice_frist_klaerung_invalid: kalenderEnde' using errcode = 'P0001';
    end if;
    v_lage := jsonb_build_object(
      'art', 'ausland',
      'ohneFeiertagBestaetigt',
        case when v_lage_vorher->>'art' = 'ausland'
             then coalesce(v_lage_vorher->'ohneFeiertagBestaetigt' = 'true'::jsonb, false)
             else false end,
      'geprueft',
        (case when v_lage_vorher->>'art' = 'ausland' and jsonb_typeof(v_lage_vorher->'geprueft') = 'object'
              then v_lage_vorher->'geprueft' else '{}'::jsonb end)
        || jsonb_build_object(to_char(v_kalender, 'YYYY-MM-DD'), to_char(v_wirksam, 'YYYY-MM-DD')),
      'quelle', 'klaerung'
    );
  end if;

  insert into public.workspace_invoice_frist_klaerungen (
    workspace_id, client_invoice_id, client_klaerung_id, klaerung, begruendung,
    lage_vorher, lage_nachher, created_by
  )
  values (
    p_workspace_id, v_invoice_id, v_klaerung_id, v_klaerung, v_begruendung,
    v_lage_vorher, v_lage, v_user_id
  );

  perform set_config('officetakt.frist_klaerung', 'on', true);
  update public.workspace_invoices
  set
    frist_basis = jsonb_build_object(
      'lage', v_lage,
      'quelle', 'klaerung',
      'festgelegtAm', to_jsonb(now()),
      'klaerung', jsonb_build_object(
        'id', v_klaerung_id,
        'angabe', v_klaerung,
        'begruendung', v_begruendung,
        'von', v_user_id,
        'am', to_jsonb(now())
      )
    ),
    row_version = row_version + 1,
    updated_by = v_user_id
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  returning * into v_updated;
  perform set_config('officetakt.frist_klaerung', 'off', true);

  return next v_updated;
end;
$$;

revoke all on function public.clarify_workspace_invoice_frist(uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.clarify_workspace_invoice_frist(uuid, text, text, jsonb, text) to authenticated;

/* ------------------------------------------------------------------------------------------------ */
/* 9) Pull: die Fristgrundlage reist mit (aus 20260913)                                              */
/* ------------------------------------------------------------------------------------------------ */

create or replace function public.pull_workspace_invoices(
  p_workspace_id uuid,
  p_since timestamptz default null
)
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

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', wi.id,
          'workspace_id', wi.workspace_id,
          'vorgang_id', wi.vorgang_id,
          'client_invoice_id', wi.client_invoice_id,
          'invoice_number', wi.invoice_number,
          'invoice_year', wi.invoice_year,
          'invoice_sequence_number', wi.invoice_sequence_number,
          'invoice_type', wi.invoice_type,
          'invoice_status', wi.invoice_status,
          'payload', wi.payload,
          'row_version', wi.row_version,
          'created_at', wi.created_at,
          'updated_at', wi.updated_at,
          'cancelled_at', wi.cancelled_at,
          'cancelled_by', wi.cancelled_by,
          'cancel_reason', wi.cancel_reason,
          'cancellation_kind', wi.cancellation_kind,
          'correction_document_id', wi.correction_document_id,
          'correction_number', wi.correction_number,
          /* INV-03 -- die gebundene Fristgrundlage; alte Clients lesen nur bekannte Schluessel. */
          'frist_basis', wi.frist_basis
        )
        order by wi.created_at asc, wi.id asc
      )
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and (p_since is null or wi.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.pull_workspace_invoices(uuid, timestamptz) from public, anon;
grant execute on function public.pull_workspace_invoices(uuid, timestamptz) to authenticated;
