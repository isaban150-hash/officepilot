-- RECHNUNGSINTEGRITAET-03B2 -- ein Abschlag verbraucht entweder Menge oder Geld.
--
-- Folgemigration zu 20261001120000 (bereits remote angewendet; sie wird hier
-- ausdruecklich **nicht** umgeschrieben). Korrigiert wird allein die
-- Abzugsbasis der Schlussrechnung.
--
-- Realbefund aus der unabhaengigen Abnahme: Ein mengenbasierter Abschlag ueber
-- eine von zwei Einheiten reduzierte korrekt die offene Menge -- und wurde in
-- der Schlussrechnung **zusaetzlich** monetaer abgezogen. Die Schlussrechnung
-- rechnete danach nur die verbleibende Einheit (5 EUR) ab und zog dieselben
-- 5 EUR nochmals ab: Restbetrag 0 EUR, obwohl erst die Haelfte bezahlt war.
--
-- Die Regel folgt dem bestehenden Hybrid des Modells:
--   * `fixed_amount` (und jeder Abschlag ohne Positionsmenge) nimmt keine
--     Auftragsmenge weg -- sein Betrag gehoert abgezogen.
--   * ein mengenbasierter Abschlag hat seine Leistung bereits ueber die
--     abgerechnete Menge verbraucht; sie fehlt in den Positionen der
--     Schlussrechnung und darf nicht ein zweites Mal als Geld verschwinden.
--
-- Geprueft wird die tatsaechlich verbrauchte Menge, nicht allein der Modus:
-- Altbestand ohne `calculationMode` ist dadurch richtig eingeordnet. Die
-- Stornoregel bleibt unveraendert -- ein stornierter Abschlag wirkt weder
-- mengen- noch geldseitig.
--
-- Client (`getPreviousAbschlagDeductions`) und Server rechnen damit dieselbe
-- Abzugsbasis; `assert_workspace_invoice_integrity` vergleicht sie centgenau
-- und weist eine abweichende Schlussrechnung weiterhin ab.

create or replace function public.workspace_invoice_abschlag_deductions(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_exclude_client_invoice_id text
)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(sum(round((wi.payload->>'amount')::numeric * 100)), 0) / 100
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.vorgang_id = p_vorgang_id
    and wi.invoice_type = 'abschlag'
    and wi.invoice_status in ('vorbereitet', 'versendet')
    and wi.cancelled_at is null
    and coalesce(wi.payload->>'paymentStatus', '') <> 'storniert'
    and wi.client_invoice_id is distinct from p_exclude_client_invoice_id
    and jsonb_typeof(wi.payload->'amount') = 'number'
    -- Nur Abschlaege, die keine Auftragsmenge verbraucht haben.
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

revoke all on function public.workspace_invoice_abschlag_deductions(uuid, text, text) from public, anon;
