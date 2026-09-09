-- OFFICEPILOT-FINAL-INVOICE-CANCELLATION-SERVER-FOUNDATION-01C
--
-- Eine stornierte Schlussrechnung bleibt historisch erhalten, ist aber nicht
-- mehr abrechnungswirksam. Sie darf keine Mengen mehr verbrauchen und keine
-- notwendige Ersatz-Schlussrechnung dauerhaft blockieren. Die Garantie
-- „hoechstens eine wirksame Schlussrechnung je Vorgang" bleibt bestehen — sie
-- zaehlt kuenftig nur die nicht stornierten.
--
-- Bewusste Entwurfsentscheidungen:
--
--   * **Die Spalten sind die Wahrheit, nicht der Payload.** Bis hierher war
--     `cancelledAt` ein Feld im Client-JSON: ohne Typ, ohne Formatzwang, vom
--     Client beim Finalisieren mitsendbar und von keiner Stelle erzeugt. Ein
--     Zustand, der ueber Doppelabrechnung entscheidet, gehoert serverseitig
--     erzeugt und typisiert — so wie Nummernkreis und Status es laengst sind.
--
--   * **Nur Schlussrechnungen.** Diese Grundlage traegt ausschliesslich den
--     Fall, den die Analyse belegt hat. Abschlaege, Gutschriften und
--     Stornobelege sind eigene Fachpunkte und werden hier fail-closed
--     abgewiesen.
--
--   * **Keine Rueckabwicklung.** Eine Rechnung mit aktiver Zahlung wird nicht
--     storniert, sondern abgelehnt. Geld zurueckzubuchen ist ein eigener Weg;
--     ihn hier stillschweigend mitzuerledigen waere die gefaehrlichste
--     Abkuerzung dieses Blocks.
--
--   * **Kein Backfill.** Die vorhandenen `payload.cancelledAt`-Werte sind nicht
--     vertrauenswuerdig: Es gab nie einen legitimen Produktivpfad, der sie
--     gesetzt haette, wohl aber einen offenen Einschleusweg. Sie werden
--     deshalb **nicht** in `cancelled_at` uebernommen. Der Preflight vor dem
--     Deployment muss sie finden und fachlich pruefen.
--
--   * **Keine Datenreparatur.** Existieren bereits zwei wirksame
--     Schlussrechnungen fuer denselben Vorgang, scheitert die Indexanlage —
--     und das bleibt gewollt: Welche Rechnung gilt, entscheidet kein Skript.
--
--   * **Eine gemeinsame Lock-Richtung.** `workspace_vorgaenge` →
--     `workspace_invoices` → `workspace_invoice_payments`. Storno, Zahlung und
--     Reversal treffen sich auf der Rechnungszeile; damit kann nicht
--     gleichzeitig eine Rechnung storniert werden und eine neue aktive Zahlung
--     auf ihr entstehen. Kein neuer Sperrmechanismus, keine Advisory Locks.
--
-- PREFLIGHT VOR DEM DEPLOYMENT (nicht Teil dieser Migration):
--   1) select … from public.workspace_invoices
--        where coalesce(payload->>'cancelledAt', '') <> '';        -- erwartet 0
--   2) select workspace_id, vorgang_id, count(*)
--        from public.workspace_invoices
--        where invoice_type = 'schluss'
--          and invoice_status in ('vorbereitet', 'versendet')
--        group by 1, 2 having count(*) > 1;                        -- erwartet 0
--   3) select indexname, indexdef from pg_indexes
--        where tablename = 'workspace_invoices';                   -- Ist-Schema
--   Zeigt eine der drei Abfragen Unerwartetes: STOPP, keine automatische
--   Bereinigung.

/* -------------------------------------------------------------------------- */
/* 1) Die serverseitige Storno-Wahrheit                                       */
/* -------------------------------------------------------------------------- */

alter table public.workspace_invoices
  add column if not exists cancelled_at timestamptz null,
  add column if not exists cancelled_by uuid null references auth.users (id) on delete set null,
  add column if not exists cancel_reason text null;

/*
 * Ein Storno ohne Begruendung ist buchhalterisch wertlos. Der Zwang steht in
 * der Datenbank und nicht nur in der Funktion, damit auch ein spaeterer
 * Schreibweg ihn nicht umgehen kann.
 *
 * `on delete set null` bei `cancelled_by` folgt dem Muster von `created_by`,
 * `reversed_by` und `updated_by`: Wird ein Benutzerkonto geloescht, bleibt die
 * Stornohistorie vollstaendig lesbar, nur die Personenzuordnung entfaellt.
 */
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspace_invoices_cancel_reason_check'
  ) then
    alter table public.workspace_invoices
      add constraint workspace_invoices_cancel_reason_check
      check (cancelled_at is null or length(btrim(coalesce(cancel_reason, ''))) > 0);
  end if;
end;
$$;

create index if not exists workspace_invoices_cancelled_idx
  on public.workspace_invoices (workspace_id, cancelled_at)
  where cancelled_at is not null;

/* -------------------------------------------------------------------------- */
/* 2) Der Backstop zaehlt nur noch wirksame Schlussrechnungen                  */
/* -------------------------------------------------------------------------- */

/*
 * Guard und Index muessen dieselbe Fachsemantik tragen. Waere nur der RPC
 * gelockert, scheiterte der Insert am strengeren Index — und der bestehende
 * Exception-Handler uebersetzte das in `invoice_final_already_exists`: Die
 * Korrektur waere wirkungslos, aber unauffaellig. Deshalb wandern beide hier
 * gemeinsam.
 *
 * Bewusst ohne `concurrently`: Migrationen laufen in einer Transaktion, in der
 * `create index concurrently` nicht zulaessig ist. Die Tabelle ist waehrend des
 * Umbaus kurz gesperrt; das ist bei einem Rollout hinnehmbar und ehrlicher als
 * ein Verfahren, das die Migrationsumgebung nicht traegt.
 */
drop index if exists public.workspace_invoices_single_final_invoice;

create unique index if not exists workspace_invoices_single_final_invoice
  on public.workspace_invoices (workspace_id, vorgang_id)
  where invoice_type = 'schluss'
    and invoice_status in ('vorbereitet', 'versendet')
    and cancelled_at is null;

/* -------------------------------------------------------------------------- */
/* 3) cancel_workspace_invoice                                                */
/* -------------------------------------------------------------------------- */

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
  v_existing public.workspace_invoices;
  v_updated public.workspace_invoices;
  v_active_payments integer;
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

  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'invoice_cancel_reason_required';
  end if;

  /*
   * Lock-Reihenfolge, verbindlich fuer alle rechnungsschreibenden Funktionen:
   * Vorgang → Rechnung → Zahlungen. `finalize_workspace_invoice` und
   * `confirm_workspace_order_amendment` beginnen ebenfalls beim Vorgang;
   * dieselbe Richtung schliesst Deadlocks aus.
   *
   * Der Vorgang wird gesperrt, obwohl er nicht veraendert wird: Er ist der
   * gemeinsame Serialisierungspunkt gegenueber einer parallel laufenden
   * Finalisierung. Sonst koennte eine Ersatz-Schlussrechnung entstehen,
   * waehrend die alte gerade storniert wird — beide Transaktionen saehen
   * jeweils einen Zustand, den es nie gab.
   */
  perform 1
  from public.workspace_invoices wi
  join public.workspace_vorgaenge v
    on v.workspace_id = wi.workspace_id
   and v.vorgang_id = wi.vorgang_id
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = v_invoice_id
  for update of v;

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
   * Idempotenz vor jeder Pruefung — und ausdruecklich vor der Zahlungspruefung:
   * Eine bereits stornierte Rechnung bleibt storniert, auch wenn danach eine
   * Zahlung zurueckgenommen oder erfasst wurde. Ein zweiter Aufruf ist kein
   * Ereignis: `cancelled_at`, `cancelled_by`, `cancel_reason` und
   * `row_version` bleiben unveraendert. Insbesondere ueberschreibt eine zweite
   * Begruendung die erste nicht — der Grund gehoert zur Handlung, die
   * tatsaechlich stattgefunden hat.
   */
  if v_existing.cancelled_at is not null then
    return next v_existing;
    return;
  end if;

  -- 01C — Grundlage traegt ausschliesslich die Schlussrechnung.
  if v_existing.invoice_type is distinct from 'schluss' then
    raise exception 'invoice_cancel_type_not_supported';
  end if;

  -- Ein Entwurf ist nie hinausgegangen; es gibt nichts zu stornieren.
  if v_existing.invoice_status not in ('vorbereitet', 'versendet') then
    raise exception 'invoice_cancel_not_finalized';
  end if;

  /*
   * Fail-closed bei Geld. Eine bezahlte Rechnung zu stornieren hiesse, eine
   * Zahlung ohne Forderung stehen zu lassen. Es wird nichts zurueckgebucht und
   * keine Zahlung still reversiert — der Nutzer nimmt die Zahlung zuerst
   * ausdruecklich zurueck.
   *
   * Die Zaehlung steht unter der Rechnungssperre; `add_workspace_invoice_payment`
   * sperrt dieselbe Zeile, bevor es einfuegt. Damit kann keine Zahlung
   * zwischen dieser Pruefung und dem Update entstehen.
   */
  select count(*)
  into v_active_payments
  from public.workspace_invoice_payments p
  where p.workspace_id = p_workspace_id
    and p.client_invoice_id = v_invoice_id
    and p.reversed_at is null;

  if coalesce(v_active_payments, 0) > 0 then
    raise exception 'invoice_cancel_has_active_payments';
  end if;

  /*
   * `invoice_status` bleibt unangetastet. Er beschreibt den Weg zum Kunden;
   * eine versendete Rechnung bleibt versendet, auch wenn sie storniert wird.
   * Ebenso unveraendert: Rechnungsnummer, Positionen, Betraege, Snapshots,
   * Versandangaben, Zahlungsdatensaetze, Archivhistorie. Storno nimmt die
   * Abrechnungswirkung zurueck — es loescht nichts.
   *
   * Der Payload-Spiegel entsteht ausschliesslich hier, aus der autoritativen
   * Entscheidung. Er existiert nur, damit aeltere Clients den Zustand lesen
   * koennen; geschrieben wird er nie vom Client.
   */
  update public.workspace_invoices
  set cancelled_at = now(),
      cancelled_by = v_user_id,
      cancel_reason = v_reason,
      payload = payload || jsonb_build_object(
        'cancelledAt', to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'cancelReason', v_reason
      ),
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.cancelled_at is null then
    raise exception 'Stornierung nicht angewendet';
  end if;

  return next v_updated;
end;
$$;

revoke all on function public.cancel_workspace_invoice(uuid, text, text) from public;
grant execute on function public.cancel_workspace_invoice(uuid, text, text) to authenticated;

/* -------------------------------------------------------------------------- */
/* 4) Zahlungspfad: gemeinsamer Serialisierungspunkt                          */
/* -------------------------------------------------------------------------- */

/*
 * Fortgeschrieben aus 20250826120000. Zwei Aenderungen, sonst nichts:
 *
 *   * Die Rechnungszeile wird mit `for update` geladen. Vorher war es ein
 *     reines SELECT — und ein reines SELECT wird von einem fremden
 *     `for update` nicht aufgehalten. Zwischen Storno und Zahlung gab es
 *     deshalb keinen gemeinsamen Serialisierungspunkt: Es fehlt auch ein
 *     Foreign Key von den Zahlungen auf die Rechnung, der implizit gesperrt
 *     haette.
 *   * Die Stornopruefung liest die autoritative Spalte statt des Payloads.
 *
 * Die Idempotenz ueber „Insert zuerst, pruefen danach" bleibt unveraendert —
 * sie loest ein anderes Problem (zwei gleiche Zahlungskennungen) und wird von
 * der Sperre nicht beruehrt.
 */
create or replace function public.add_workspace_invoice_payment(
  p_workspace_id uuid,
  p_client_invoice_id text,
  p_client_payment_id text,
  p_amount numeric,
  p_paid_on text,
  p_reference text default null,
  p_note text default null
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
  v_attempt int;
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

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  -- Kein Formatzwang: `pay-<millis>` und UUID sind beide gueltig.
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_payment_id is null then
    raise exception 'client_payment_id fehlt';
  end if;

  if p_amount is null or p_amount <= 0 then
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

  v_reference := nullif(trim(coalesce(p_reference, '')), '');
  v_note := nullif(trim(coalesce(p_note, '')), '');

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
   * PAYMENT-SQL-CONCURRENCY-04B2B3 — Insert zuerst, pruefen danach.
   *
   * Vorher stand hier ein sperrendes Select und erst dann der Insert. Zwischen
   * beiden Schritten passt ein zweiter Request: Eine Sperre kann keine Zeile
   * halten, die es noch nicht gibt. Zwei gleichzeitige Aufrufe derselben
   * Kennung sahen beide nichts, fuegten beide ein — einer bekam eine
   * Unique-Violation statt des zugesagten idempotenten Erfolgs.
   *
   * Jetzt traegt der Eindeutigkeitsschluessel selbst die Serialisierung. Der
   * Verlierer bekommt kein Ergebnis zurueck, laedt die fremde Zeile mit Sperre
   * und bewertet sie fachlich. `do nothing` allein waere gefaehrlich: Es wuerde
   * eine abweichende Geldbewegung still verschlucken. Deshalb folgt auf den
   * leeren Insert immer eine Pruefung, nie ein pauschaler Erfolg.
   *
   * Zweimal versucht: Faellt der konkurrierende Request zurueck (Rollback),
   * verschwindet die Zeile wieder und der zweite Anlauf kann sie regulaer
   * anlegen. Danach ist Schweigen keine Option mehr.
   */
  for v_attempt in 1..2 loop
    insert into public.workspace_invoice_payments (
      workspace_id, client_invoice_id, client_payment_id,
      amount, paid_on, reference, note, created_by
    )
    values (
      p_workspace_id, v_invoice_id, v_payment_id,
      round(p_amount, 2), v_paid_on::date, v_reference, v_note, v_user_id
    )
    on conflict (workspace_id, client_invoice_id, client_payment_id) do nothing
    returning * into v_inserted;

    if v_inserted.id is not null then
      /*
       * Nachbedingung: Die zurueckgegebene Zeile muss den **vollstaendigen**
       * Request abbilden — Schluessel, Betrag, Datum, Referenz, Notiz. Erfolg
       * fuer etwas anderes als das Gesendete waere eine Luege.
       */
      if v_inserted.workspace_id is distinct from p_workspace_id
        or v_inserted.client_invoice_id is distinct from v_invoice_id
        or v_inserted.client_payment_id is distinct from v_payment_id
        or v_inserted.amount is distinct from round(p_amount, 2)
        or v_inserted.paid_on is distinct from v_paid_on::date
        or v_inserted.reference is distinct from v_reference
        or v_inserted.note is distinct from v_note
        or v_inserted.reversed_at is not null
      then
        raise exception 'Zahlung Nachbedingung verletzt';
      end if;

      return next v_inserted;
      return;
    end if;

    -- Kein Ergebnis: Die Kennung ist bereits vergeben. Zeile sperren und pruefen.
    select * into v_existing
    from public.workspace_invoice_payments
    where workspace_id = p_workspace_id
      and client_invoice_id = v_invoice_id
      and client_payment_id = v_payment_id
    for update;

    if v_existing.id is not null then
      /*
       * Grabsteinvorrang — bewusst **vor** dem Inhaltsvergleich: Eine
       * inhaltlich identische Wiederholung wuerde die Stornierung sonst als
       * stillen Erfolg ueberspielen. Reversal gewinnt, die Zeile bleibt
       * unveraendert, es wird nichts wiederbelebt.
       */
      if v_existing.reversed_at is not null then
        raise exception 'Zahlungskonflikt: diese Zahlung wurde storniert';
      end if;

      /*
       * Fachliche Identitaet, exakt und ausschliesslich ueber diese vier
       * Felder. Keine Deduplizierung anhand Betrag oder Datum: Zwei echte
       * Zahlungen ueber denselben Betrag am selben Tag bleiben zwei Zahlungen.
       */
      if v_existing.amount is distinct from round(p_amount, 2)
        or v_existing.paid_on is distinct from v_paid_on::date
        or v_existing.reference is distinct from v_reference
        or v_existing.note is distinct from v_note
      then
        raise exception 'Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten';
      end if;

      return next v_existing;
      return;
    end if;
  end loop;

  -- Weder eingefuegt noch auffindbar: kein Erfolg, keine Vermutung.
  raise exception 'Zahlung nicht angelegt';
end;
$$;

/*
 * Reversal: dieselbe Lock-Richtung. Erst die Rechnung, dann die Zahlung.
 * Fachlich unveraendert — eine Zahlung darf auch auf einer stornierten
 * Rechnung zurueckgenommen werden; genau das ist der Weg, eine bezahlte
 * Rechnung ueberhaupt stornierbar zu machen.
 */
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

  v_invoice_id := nullif(trim(coalesce(p_client_invoice_id, '')), '');
  v_payment_id := nullif(trim(coalesce(p_client_payment_id, '')), '');
  if v_invoice_id is null or v_payment_id is null then
    raise exception 'Zahlungskennung fehlt';
  end if;

  -- 01C: Rechnung vor Zahlung sperren — dieselbe Richtung wie Storno und Zahlung.
  perform 1
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

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

/* -------------------------------------------------------------------------- */
/* 5) Der Payload traegt keine Stornowahrheit mehr herein                     */
/* -------------------------------------------------------------------------- */

/*
 * `cancelledAt` und `cancelReason` kommen aus der Idempotenznormalisierung
 * heraus — aus demselben Grund wie `paymentStatus`: Sie sind kein Belegtext,
 * sondern ein spaeter entstehender Zustand. Zwei Finalisierungsversuche
 * derselben Kennung, die sich nur hierin unterscheiden, sind derselbe Beleg.
 *
 * Wichtiger noch: Damit kann ein manipulierter oder alter Client beim
 * Finalisieren keine Rechnung mehr als storniert markieren. Die Spalten sind
 * die Wahrheit, und sie werden ausschliesslich von `cancel_workspace_invoice`
 * gesetzt.
 */
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
    - 'cancelled_by';
$$;

/* -------------------------------------------------------------------------- */
/* 5b) Der Pull liefert die Stornowahrheit als Spalten mit                     */
/* -------------------------------------------------------------------------- */

/*
 * Fortgeschrieben aus 20250723140000. Der Pull baut eine ausdrueckliche
 * Feldliste; ohne diese Ergaenzung erreichten die neuen Spalten kein Geraet,
 * und der Payload-Spiegel waere die einzige Quelle. Genau das soll er nicht
 * sein — er existiert nur fuer aeltere Clients.
 *
 * `cancelled_by` wandert bewusst mit: Wer storniert hat, gehoert zur
 * Stornowahrheit. Ob ein Client die Angabe anzeigt, entscheidet er selbst.
 */
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
          'cancel_reason', wi.cancel_reason
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

/* -------------------------------------------------------------------------- */
/* 6) finalize_workspace_invoice — nur wirksame Schlussrechnungen blockieren   */
/* -------------------------------------------------------------------------- */

/*
 * Fortgeschrieben aus 20250828120000. Genau eine fachliche Aenderung: Der
 * Single-Final-Guard zaehlt nur noch nicht stornierte Schlussrechnungen.
 * Vorgangs-Lock, Idempotenz-Replay, Nachtragspruefung, Nummernkreis,
 * Fehlernamen und Race-Verhalten bleiben unveraendert.
 */
create or replace function public.finalize_workspace_invoice(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb
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

  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');
  if v_vorgang_id is null then
    raise exception 'vorgang_id fehlt';
  end if;

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

  select *
  into v_existing
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id)
  for update;

  if found then
    v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
    v_normalized_incoming := public.normalize_workspace_invoice_payload_for_idempotency(
      coalesce(p_invoice, '{}'::jsonb)
      || jsonb_build_object(
        'id', trim(p_client_invoice_id),
        'status', 'vorbereitet'
      )
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
   * 01D — Single-Final-Invoice-Guard.
   *
   * Steht bewusst **nach** dem Idempotenz-Replay: Ein Wiederholungslauf nach
   * verlorener Antwort traegt dieselbe `client_invoice_id` und muss den
   * bestehenden Erfolg zurueckbekommen, nicht diesen Fehler. Die eigene
   * Kennung ist deshalb ausdruecklich ausgenommen.
   *
   * Der Vorgang ist an dieser Stelle bereits gesperrt; die Pruefung ist damit
   * gegen parallele Transaktionen desselben Vorgangs serialisiert.
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

  v_next_sequence := v_next_sequence + 1;
  v_invoice_number := public.format_workspace_invoice_number(v_year, v_next_sequence);

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

      v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
      v_normalized_incoming := public.normalize_workspace_invoice_payload_for_idempotency(
        coalesce(p_invoice, '{}'::jsonb)
        || jsonb_build_object(
          'id', trim(p_client_invoice_id),
          'status', 'vorbereitet'
        )
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
    and last_sequence = v_next_sequence - 1;

  if not found then
    raise exception 'Nummernkreis konnte nicht erhöht werden';
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'invoice', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;
