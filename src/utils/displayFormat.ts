/**
 * UIUX-FOUNDATION-01B — gemeinsame Anzeigeformatierung.
 *
 * Konsolidiert die in Seiten und Services mehrfach kopierten
 * `formatEuro`/`formatMoney`/`formatDate`-Helfer (identische Logik:
 * de-DE, zwei Nachkommastellen, „€“ mit geschütztem Leerzeichen; Datum
 * `toLocaleDateString('de-DE')`, leer → „—“). Produktiv gilt EUR; es gibt
 * keine Währungsumrechnung und keine Multi-Currency-Darstellung.
 *
 * Bestehende Aufrufer (u. a. `formatInvoiceCurrency`, `formatPaymentCurrency`)
 * bleiben unverändert; die Seitenmigration stellt sie blockweise um.
 */
export const EMPTY_DISPLAY = '—';

export function formatEuroAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY_DISPLAY;
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function formatDisplayDate(value: string | Date | null | undefined): string {
  if (!value) return EMPTY_DISPLAY;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : EMPTY_DISPLAY;
    return date.toLocaleDateString('de-DE');
  } catch {
    return typeof value === 'string' ? value : EMPTY_DISPLAY;
  }
}

/** ISO-Wert für `<time dateTime>`; leer, wenn der Wert kein Datum ist. */
export function toDateTimeAttribute(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}
