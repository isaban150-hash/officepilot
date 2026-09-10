/** Stable DOM id / URL hash for the Firmendaten backup panel. */
export const BACKUP_SECTION_ID = 'datensicherung';

/** Deep link to Firmendaten scrolled to the backup panel. */
export const FIRMENDATEN_BACKUP_HREF = `/firmendaten#${BACKUP_SECTION_ID}`;

/*
 * COMPANY-SETTINGS-ENTRY-01B — dieselbe Technik für die beiden Abschnitte, auf
 * die der Einstellungsbereich zeigt.
 *
 * Bewusst Tiefenlinks statt eigener Formulare: Zahlungsziel, Skonto und
 * Rechnungsfußzeile liegen im `CompanyProfile` und werden in den Firmendaten
 * bearbeitet. Ein zweites Formular für dieselben Felder wäre eine zweite
 * UI-Wahrheit — genauso unerwünscht wie eine zweite Datenwahrheit.
 */

/** Stabile DOM-Id / URL-Hash des Zahlungsbedingungsblocks. */
export const PAYMENT_TERMS_SECTION_ID = 'zahlungsbedingungen';

/** Stabile DOM-Id / URL-Hash der Rechnungstexte. */
export const INVOICE_TEXTS_SECTION_ID = 'rechnungstexte';

export const FIRMENDATEN_PAYMENT_TERMS_HREF = `/firmendaten#${PAYMENT_TERMS_SECTION_ID}`;
export const FIRMENDATEN_INVOICE_TEXTS_HREF = `/firmendaten#${INVOICE_TEXTS_SECTION_ID}`;
