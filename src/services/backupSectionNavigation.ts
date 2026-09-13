/** Stable DOM id / URL hash for the backup panel (heute auf der Betriebsseite). */
export const BACKUP_SECTION_ID = 'datensicherung';

/**
 * SETTINGS-01B5 — kanonischer Tiefenlink zur Datensicherung auf der
 * Betriebsseite. `/firmendaten#datensicherung` bleibt als Legacy-URL
 * redirectfähig (FirmendatenLegacyRoute), ist aber kein Linkziel mehr.
 */
export const SETTINGS_BACKUP_HREF = `/einstellungen/betrieb#${BACKUP_SECTION_ID}`;

/*
 * SETTINGS-01B5 — die Abschnitts-Ids der abgelösten Firmendaten-Seite leben
 * nur noch als Legacy-Hashes: `FirmendatenLegacyRoute` bildet sie auf die
 * kanonischen Settings-Seiten ab. Kein Link im Produkt zeigt mehr auf
 * `/firmendaten#…`.
 */

/** Legacy-Hash des früheren Zahlungsbedingungsblocks (→ /einstellungen/rechnungen). */
export const PAYMENT_TERMS_SECTION_ID = 'zahlungsbedingungen';

/** Legacy-Hash der früheren Rechnungstexte (→ /einstellungen/rechnungen). */
export const INVOICE_TEXTS_SECTION_ID = 'rechnungstexte';

/** Legacy-Hash des früheren Logo-Abschnitts (→ /einstellungen/design). */
export const LOGO_SECTION_ID = 'logo';

/** SETTINGS-01B4 — Hashes, die auf die Rechnungs-Unterseite umgeleitet werden. */
export const FIRMENDATEN_INVOICE_SECTION_IDS: readonly string[] = [
  PAYMENT_TERMS_SECTION_ID,
  INVOICE_TEXTS_SECTION_ID,
];
