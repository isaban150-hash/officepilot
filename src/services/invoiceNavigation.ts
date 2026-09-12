/**
 * Canonical app routes for invoices.
 * Detail: `/vorgaenge/:vorgangId/rechnungen/:invoiceId`
 * Create: `/vorgaenge/:vorgangId/rechnung?type=…`
 * Overview: `/rechnungen/offen`
 */

export function buildInvoiceDetailPath(vorgangId: string, invoiceId: string): string {
  return `/vorgaenge/${vorgangId}/rechnungen/${invoiceId}`;
}

/**
 * Rechnungsarten, die über die allgemeine Anlege-Route erreichbar sind.
 *
 * Bewusst schmaler als `InvoiceDocumentType`: `teilrechnung`, `gutschrift` und
 * `storno` entstehen nicht über diesen Weg. Der Typ-Picker der Rechnungsseite
 * bietet ebenfalls genau diese drei an — was hier nicht steht, wäre eine
 * Sackgasse, aus der der Nutzer ohne URL-Änderung nicht mehr herausfindet.
 */
export type InvoiceCreateType = 'rechnung' | 'abschlag' | 'schluss';

/**
 * Der Typ ist verpflichtend — ohne Vorgabewert und ohne Laufzeit-Rückfall.
 * Ein vergessener Aufrufer fiel bisher still auf `rechnung` zurück, weil
 * `parseInvoiceDocumentType` aus einem fehlenden Parameter genau das macht.
 * Damit versprach etwa „Schlussrechnung erstellen" das eine und öffnete das
 * andere. Als Pflichtparameter meldet TypeScript diesen Fehler jetzt beim
 * Übersetzen statt ihn dem Nutzer zu zeigen.
 */
export function buildInvoiceCreatePath(vorgangId: string, type: InvoiceCreateType): string {
  return `/vorgaenge/${vorgangId}/rechnung?type=${type}`;
}

export function buildOpenInvoicesPath(): string {
  return '/rechnungen/offen';
}

/**
 * MANUAL-INVOICE-01B2c — der erreichbare Ort einer Rechnung.
 *
 * Mit Auftrag ist das die Detailseite. Eine Rechnung ohne Auftrag hat heute
 * noch keine eigene Route; sie ist aber in der Rechnungsübersicht sichtbar,
 * und genau dorthin führt der Weg. Bewusst **kein** `/vorgaenge/null/…` und
 * kein erfundener Vorgang — der Pfad ist wahr, nur noch nicht spezifisch.
 * Die eigene Route ist Teil des UI-Blocks.
 */
export function buildInvoiceReachPath(vorgangId: string | null, invoiceId: string): string {
  return vorgangId === null
    ? buildOpenInvoicesPath()
    : buildInvoiceDetailPath(vorgangId, invoiceId);
}
