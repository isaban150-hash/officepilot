/**
 * P1 MITARBEITERZAHLUNGEN — die feste Dokumentkennung der Auszahlungsquittung.
 *
 * Abgeleitet aus der Zahlungs-Id, damit zwei Geräte für dieselbe Zahlung nie
 * zwei Originale anlegen. Eine eigene, importfreie Datei: Archiv, Lebenszyklus
 * und Dokumentliste lesen sie, ohne einen Importzyklus zu schliessen.
 */
export const PAYOUT_RECEIPT_DOCUMENT_PREFIX = 'emp-receipt-';

export function buildPayoutReceiptDocumentId(paymentId: string): string {
  return `${PAYOUT_RECEIPT_DOCUMENT_PREFIX}${paymentId.trim()}`;
}

/** Die selbst erzeugte Quittung — nicht die unterschriebene Fassung (das ist der Nachweis). */
export function isPayoutReceiptDocumentId(id: string | null | undefined): boolean {
  return (
    typeof id === 'string' &&
    id.startsWith(PAYOUT_RECEIPT_DOCUMENT_PREFIX) &&
    id.length > PAYOUT_RECEIPT_DOCUMENT_PREFIX.length
  );
}
