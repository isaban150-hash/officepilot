/**
 * E-RECHNUNG-04C — die Zuordnungen zwischen OfficeTakt-Fachwerten und
 * standardisierten Codes. Eine Stelle, drei kleine Tabellen.
 *
 * Bewusst zusammen und nicht in drei Dateien: Es sind drei Übersetzungen
 * derselben Art, jede wenige Zeilen lang, und sie werden immer gemeinsam
 * gelesen. Was sie eint, ist die Haltung — **nichts wird geraten**. Wo keine
 * eindeutige Zuordnung besteht, liefert die Funktion nichts, und der Builder
 * bricht ab. Ein stiller Rückfall auf einen plausiblen Code wäre der
 * gefährlichste Fehler dieses Bereichs: Er erzeugt eine Rechnung, die durch
 * jede Prüfung läuft und trotzdem etwas anderes behauptet, als der Betrieb
 * geleistet hat.
 *
 * Rein: keine Stores, keine Cloud, kein Zustand.
 */
import type { InvoiceDocumentType, TaxStatus, VorgangInvoice } from '../../types/models';
import { isFixedAmountAbschlag } from '../invoiceCalculationMode';
import type { CanonicalDocumentKind, CanonicalTaxCategory } from './canonicalEInvoice';

/* ------------------------------------------------------------------ */
/* Einheiten                                                           */
/* ------------------------------------------------------------------ */

/**
 * Die fünf OfficeTakt-Einheiten und ihre standardisierten Codes.
 *
 * Projektseitig festgelegt. `Pauschal` wird dabei **nicht** neu gedeutet: Es
 * bleibt die Pauschal-Einheit im bisherigen OfficeTakt-Sinn und bekommt den
 * Code für eine Pauschalsumme. Es als „Stück" auszugeben, wäre bequem und
 * falsch — eine Pauschale ist keine Stückzahl.
 *
 * Die Liste ist das Gegenstück zu `ORDER_UNITS` (`src/services/orderUnits.ts`)
 * und zur SQL-Fassung `workspace_invoice_unit_is_known` aus 03F2. Ein Test
 * hält alle drei aneinander; läuft eine weg, fällt es dort auf und nicht beim
 * Kunden.
 */
export const UNIT_CODES: Readonly<Record<string, string>> = {
  'm²': 'MTK',
  Meter: 'MTR',
  Stunden: 'HUR',
  Stück: 'H87',
  Pauschal: 'LS',
};

/** Der Code zu einer Einheit — oder nichts. Niemals ein Rückfallwert. */
export function resolveUnitCode(unit: string | null | undefined): string | undefined {
  const raw = (unit ?? '').trim();
  if (!raw) return undefined;
  return Object.prototype.hasOwnProperty.call(UNIT_CODES, raw) ? UNIT_CODES[raw] : undefined;
}

/* ------------------------------------------------------------------ */
/* Steuer                                                              */
/* ------------------------------------------------------------------ */

export interface TaxCategoryMapping {
  category: CanonicalTaxCategory;
  rate: number;
  /** Braucht dieser Fall einen Rechtsgrund auf dem Beleg? */
  requiresReason: boolean;
}

/**
 * Die Steuerstatus, die sich **eindeutig** abbilden lassen.
 *
 * `tax_free` und `unclear` stehen absichtlich nicht darin:
 *
 *  - `unclear` ist keine Steuerentscheidung, sondern ihr Fehlen. Ein Beleg
 *    damit ist nicht exportierbar, Punkt. (Die Freigabe solcher Rechnungen
 *    ändert 04C nicht — ein bereits finalisierter Altbeleg bleibt gültig, er
 *    lässt sich nur nicht als E-Rechnung ausgeben.)
 *
 *  - `tax_free` heisst in OfficeTakt „Steuerfrei / ohne USt" und trägt als
 *    Begründung einen frei konfigurierbaren Text (`taxFreeNotice`, Vorgabe
 *    „Die Leistung ist ohne Umsatzsteuer."). Dahinter können ganz
 *    verschiedene Rechtsgründe stehen — eine Befreiung nach § 4 UStG, eine
 *    Ausfuhr, eine innergemeinschaftliche Lieferung oder ein nicht steuerbarer
 *    Umsatz. Eine strukturierte Rechnung verlangt genau diese Unterscheidung,
 *    und der Beleg speichert sie nicht. Sie zu raten hiesse, dem Empfänger
 *    einen Rechtsgrund zu nennen, den der Betrieb nie angegeben hat.
 *    Deshalb: fail-closed, bis das Produkt den Grund erfasst.
 */
const TAX_CATEGORIES: Readonly<Partial<Record<TaxStatus, TaxCategoryMapping>>> = {
  standard_19: { category: 'standard', rate: 19, requiresReason: false },
  standard_7: { category: 'standard', rate: 7, requiresReason: false },
  reverse_charge_13b: { category: 'reverse_charge', rate: 0, requiresReason: true },
  kleinunternehmer_19: { category: 'exempt', rate: 0, requiresReason: true },
};

export function resolveTaxCategory(status: TaxStatus | string): TaxCategoryMapping | undefined {
  return TAX_CATEGORIES[status as TaxStatus];
}

/* ------------------------------------------------------------------ */
/* Belegart                                                            */
/* ------------------------------------------------------------------ */

/**
 * Die semantische Belegart.
 *
 * Der Abschlag zerfällt in zwei Arten, und das ist keine Spitzfindigkeit: Ein
 * mengenbasierter Abschlag verbraucht Auftragsmenge und wirkt über seine
 * Positionen; ein Pauschalabschlag führt gar keine Positionen und wird später
 * von der Schlussrechnung abgezogen (03B2). Wer beide gleich behandelt,
 * erzeugt entweder eine Rechnung ohne Zeilen oder einen doppelten Abzug.
 *
 * `storno` und `gutschrift` gibt es als erzeugbare Belege nicht; eine
 * Stornierung entsteht über `cancellationKind` am Original und wird hier als
 * `correction` behandelt.
 */
export function resolveDocumentKind(invoice: VorgangInvoice): CanonicalDocumentKind | undefined {
  if (invoice.cancellationKind === 'correction') return 'correction';
  return documentKindForType(invoice.type, isFixedAmountAbschlag(invoice));
}

function documentKindForType(
  type: InvoiceDocumentType,
  fixedAmount: boolean,
): CanonicalDocumentKind | undefined {
  switch (type) {
    case 'rechnung':
      return 'invoice';
    case 'teilrechnung':
      return 'partial_invoice';
    case 'abschlag':
      return fixedAmount ? 'prepayment_invoice_fixed' : 'prepayment_invoice_quantity';
    case 'schluss':
      return 'final_invoice';
    default:
      // `gutschrift` und `storno` entstehen in OfficeTakt nicht als eigener Beleg.
      return undefined;
  }
}
