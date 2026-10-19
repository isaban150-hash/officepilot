/*
 * FINANZ-CORE-01A -- Gesamtnacharbeit Paket 3 (WEISS-Gesamtmaengelinventur vom 15.10.2026):
 * kanonische Rechnungsposition vor der Nummernvergabe.
 *
 *  INV-06  Einzelpreisvertrag: Der Client rechnet, druckt und sendet den Einzelpreis auf Cent (eine
 *          Rundung, billingLineTotalCents); Auftraege und Angebote rechnet der Server ebenso
 *          (build_workspace_order_totals). Eine freie Rechnung mit 10 x 0,045 nahm der Server aber an
 *          und vergab eine Nummer; gedruckt stand 0,05 bei Zeile 0,45, die E-Rechnung war
 *          money_inconsistent. Neu: Ein Einzelpreis mit mehr als zwei Nachkommastellen wird abgewiesen
 *          (invoice_unit_price_precision) -- in derselben Transaktion wie die Nummer, die damit nicht
 *          verbraucht wird.
 *  INV-07  Eine Position ohne lineTotal rechnete der Server fuer die Summenpruefung aus, speicherte sie
 *          aber ohne; der eigene Cloud-Leser verwarf die nummerierte Rechnung
 *          (payload.positions[0].lineTotal:not_finite). Neu: ohne gespeicherten Zeilenbetrag keine
 *          Freigabe (invoice_line_total_missing). Stimmt er nicht, weist assert_workspace_invoice_integrity
 *          wie bisher ab (invoice_totals_mismatch: Zeile). Der strenge Leser bleibt unveraendert streng.
 *
 * Bewusst als Trigger auf der Einfuegung freigegebener Rechnungszeilen (nicht als Neufassung der
 * Freigabe): So gilt die Regel fuer jeden Weg, der eine Rechnung anlegt, und keine Freigabefunktion muss
 * erneut uebernommen werden. Ausgestellte Belege werden nicht angefasst (nur INSERT). Der Bestand ist
 * geprueft: lokal 0 von 747 freigegebenen Rechnungen verletzen die Regel (Produktion siehe Bericht).
 *
 * Neu: Funktion workspace_invoices_positions_canonical, Trigger workspace_invoices_positions_canonical.
 * Setzt 20261114120000 bis 20261120120000 voraus und aendert keine davon. Nur lokal angewendet.
 */

create or replace function public.workspace_invoices_positions_canonical()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_line jsonb;
  v_index integer := 0;
begin
  if new.invoice_status = 'entwurf'
     or new.invoice_type not in ('rechnung', 'abschlag', 'teilrechnung', 'schluss') then
    return new;
  end if;
  for v_line in select value from jsonb_array_elements(coalesce(new.payload->'positions', '[]'::jsonb)) loop
    /* INV-06 -- der Einzelpreis auf Cent, wie Client, Druck, E-Rechnung, Angebot und Auftrag. */
    if jsonb_typeof(v_line->'unitPrice') = 'number'
       and (v_line->>'unitPrice')::numeric is distinct from round((v_line->>'unitPrice')::numeric, 2) then
      raise exception 'invoice_unit_price_precision: Position % hat Einzelpreis % (hoechstens zwei Nachkommastellen)',
        v_index + 1, v_line->>'unitPrice'
        using errcode = 'P0001';
    end if;
    /* INV-07 -- der Zeilenbetrag ist gespeichert, damit jeder Leser dieselbe Zeile sieht. */
    if jsonb_typeof(v_line->'lineTotal') is distinct from 'number' then
      raise exception 'invoice_line_total_missing: Position % ohne Zeilenbetrag', v_index + 1
        using errcode = 'P0001';
    end if;
    v_index := v_index + 1;
  end loop;
  return new;
end;
$$;

revoke all on function public.workspace_invoices_positions_canonical() from public, anon, authenticated, service_role;

drop trigger if exists workspace_invoices_positions_canonical on public.workspace_invoices;
create trigger workspace_invoices_positions_canonical
before insert on public.workspace_invoices
for each row
execute function public.workspace_invoices_positions_canonical();
