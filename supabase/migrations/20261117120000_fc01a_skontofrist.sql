/*
 * FINANZ-CORE-01A -- Gesamtabschluss: Skontofrist nach Paragraf 193 BGB.
 *
 * Entscheidung des Auftraggebers vom 14.10.2026: Faellt das kalendarische Ende einer
 * Skontofrist (Rechnungsdatum + Tage) auf einen Samstag oder Sonntag, gilt der folgende
 * Montag. Feiertage verschieben nicht -- dieselbe Regel wie beim Zahlungsziel (ZAH-10). Sie
 * gilt fuer alle Rechnungen, auch bereits ausgestellte, und wirkt nur zugunsten des Kunden.
 * Grundlage: Paragrafen 186, 193 BGB; OLG Hamm, Urteil vom 28.03.2006, 21 U 134/04
 * (10 Tage sind Kalendertage, der Schuldner ist ueber Paragraf 193 BGB geschuetzt).
 *
 * Bisher endete die Skontofrist kalendarisch, auch an Samstag und Sonntag: Ein Abschlag vom
 * Donnerstag, 03.09., mit 10 Tagen endete am Sonntag, 13.09.; die Zahlung am Montag galt als
 * verspaetet, der Skontorest blieb offen und sperrte die Schlussrechnung.
 *
 * Der Server rechnet die Frist nur an einer Stelle (workspace_invoice_open_cents, seit
 * 20261115). Sie gilt fuer die Schlussrechnungspruefung, den Bankabgleich und die
 * Zahlungsannahme. Ersetzt wird nur diese Funktion; Rechte wie bisher nur Eigentuemer.
 * Der Client rechnet gleich (buildSkontoDeadline, shiftToWorkingDay).
 *
 * Setzt 20261114120000, 20261115120000 und 20261116120000 voraus. Nur lokal angewendet;
 * Produktion: 20261114 -> 20261115 -> 20261116 -> 20261117 -> Client.
 */

/* Samstag und Sonntag -> folgender Montag; jeder andere Tag bleibt (ISODOW 6 = Samstag, 7 = Sonntag). */
create or replace function public.workspace_shift_to_working_day(p_day date)
returns date
language sql
immutable
set search_path = public
as $$
  select case extract(isodow from p_day)::int
    when 6 then p_day + 2
    when 7 then p_day + 1
    else p_day
  end;
$$;

revoke all on function public.workspace_shift_to_working_day(date) from public, anon, authenticated, service_role;

/*
 * Wie 20261115, nur das Fristende verschiebt sich von Samstag/Sonntag auf den Montag.
 * NULL, wenn die Rechnung fehlt oder keinen Betrag traegt. Ohne eigene Sperre: Die Aufrufer
 * halten die Sperre der Rechnung (und des Vorgangs).
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
    select public.workspace_shift_to_working_day(
             public.workspace_safe_date(
               case when jsonb_typeof(i.payload->'issueDate') = 'string'
                    then i.payload->>'issueDate'
                    else i.payload->>'date' end
             ) + s.days
           ) as deadline
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
