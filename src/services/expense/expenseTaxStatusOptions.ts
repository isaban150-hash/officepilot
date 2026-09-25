/**
 * FINANZCORE-05B-FIX1 — die Steuerstatus, die an einer Ausgabe zur Wahl stehen.
 *
 * Ausschliesslich die Werte, die `TaxStatus` ohnehin kennt — es wird keiner
 * erfunden und keiner weggelassen. Die Reihenfolge ist die der Häufigkeit im
 * Handwerk: Der Regelsatz steht oben, der ungeklärte Fall unten.
 *
 * Bewusst ein eigener, winziger Baustein statt einer Liste im Formular: Die
 * Auswahl gehört zur Fachlichkeit der Ausgabe, nicht zum Layout, und ein Test
 * kann sie so prüfen, ohne das Formular zu rendern.
 *
 * `unclear` steht mit in der Liste, weil es ein ehrlicher Zustand ist: Wer den
 * Beleg gerade nicht einordnen kann, soll das festhalten können, statt einen
 * Satz zu raten. Es ist zugleich der Wert, den ein aus einem Eingangsdokument
 * erzeugter Beleg bekommt.
 */
import type { TaxStatus } from '../../types/models';

export const EXPENSE_TAX_STATUS_OPTIONS: readonly TaxStatus[] = [
  'standard_19',
  'standard_7',
  'reverse_charge_13b',
  'tax_free',
  'kleinunternehmer_19',
  'unclear',
] as const;

/**
 * Der Vorschlag für eine **neu von Hand** erfasste Ausgabe.
 *
 * Der Regelsatz, weil er der Normalfall einer Lieferantenrechnung ist — und
 * ausdrücklich **nicht** der Steuerstatus der eigenen Ausgangsrechnungen.
 * Für Belege aus dem Eingang gilt er nicht; die bekommen `unclear`, weil sich
 * aus einem Scan kein Steuerstatus zuverlässig ableiten lässt.
 */
export const MANUAL_EXPENSE_DEFAULT_TAX_STATUS: TaxStatus = 'standard_19';
