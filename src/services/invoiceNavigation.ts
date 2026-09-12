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
 * MANUAL-INVOICE-UI-01B2 — die globale Detailroute einer Rechnung, unabhängig
 * vom Auftrag: `/rechnungen/:invoiceId`.
 *
 * Die statischen Nachbarn `/rechnungen/neu` und `/rechnungen/offen` sind im
 * Router **vor** dieser Route deklariert und werden nie als Kennung gelesen.
 */
export function buildGlobalInvoiceDetailPath(invoiceId: string): string {
  return `/rechnungen/${invoiceId}`;
}

/**
 * MANUAL-INVOICE-01B2c / UI-01B2 — der erreichbare Ort einer Rechnung.
 *
 * Mit Auftrag bleibt es die bestehende Vorgangsdetailseite — unverändert.
 * Ohne Auftrag führt der Weg auf die globale Detailseite. Bewusst **kein**
 * `/vorgaenge/null/…` und kein erfundener Vorgang.
 */
export function buildInvoiceReachPath(vorgangId: string | null, invoiceId: string): string {
  return vorgangId === null
    ? buildGlobalInvoiceDetailPath(invoiceId)
    : buildInvoiceDetailPath(vorgangId, invoiceId);
}
