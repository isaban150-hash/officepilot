/**
 * FINANZ-CORE-01A (Bericht 20) — welche lokal gebuchten Rechnungszahlungen der Server noch nicht bestätigt hat.
 *
 * Eine Rechnungszahlung wird zuerst lokal gebucht und danach gesendet. Scheitert das Senden (Netz, Rolle, Konflikt),
 * bleibt sie lokal stehen (N01) — das ist richtig, aber sie ist keine bestätigte Finanztatsache. Ohne Vermerk war
 * das nach einem Neustart nicht mehr zu erkennen, und ein Monatsabschluss band sie wie eine gebuchte Zahlung.
 *
 * Vermerkt wird je Betrieb (Speicherbereich) und Zahlung, dauerhaft auf dem Gerät:
 *  - gesetzt, wenn ein Sendeversuch nicht bestätigt wurde (außer im reinen Lokalbetrieb ohne Cloud) und wenn der
 *    vollständige Abzug eine lokale Zahlung zeigt, die der Server nicht kennt;
 *  - gelöscht, sobald der Server sie bestätigt (Senden erfolgreich oder im vollständigen Abzug enthalten).
 * Der Monatsabschluss liest nur diesen Vermerk (`collectUnconfirmedFinancialSources`). Leicht und ohne schwere
 * Importe, damit Abschluss und Zahlungsdienst ihn ohne Zyklus nutzen.
 */
import { getActiveStorageKey } from '../storage/storageScopeService';

interface Vermerk {
  at: string;
}

function storageKey(): string {
  return `${getActiveStorageKey()}:invoice-payment-unconfirmed`;
}

function vermerkKey(invoiceId: string, paymentId: string): string {
  return `${invoiceId}#${paymentId}`;
}

function lesen(): Record<string, Vermerk> {
  try {
    const raw = localStorage.getItem(storageKey());
    const value = raw ? (JSON.parse(raw) as unknown) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, Vermerk> = {};
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      if (id.includes('#')) result[id] = { at: String((entry as Partial<Vermerk> | null)?.at ?? '') };
    }
    return result;
  } catch {
    return {};
  }
}

function schreiben(vermerke: Record<string, Vermerk>): void {
  try {
    if (Object.keys(vermerke).length === 0) localStorage.removeItem(storageKey());
    else localStorage.setItem(storageKey(), JSON.stringify(vermerke));
  } catch {
    /* Ohne Gerätespeicher bleibt der Vermerk aus; der nächste vollständige Abzug setzt ihn erneut. */
  }
}

export function markInvoicePaymentUnconfirmed(invoiceId: string, paymentId: string, at: Date = new Date()): void {
  const vermerke = lesen();
  const id = vermerkKey(invoiceId, paymentId);
  if (vermerke[id]) return;
  vermerke[id] = { at: at.toISOString() };
  schreiben(vermerke);
}

export function clearInvoicePaymentUnconfirmed(invoiceId: string, paymentId: string): void {
  const vermerke = lesen();
  const id = vermerkKey(invoiceId, paymentId);
  if (!vermerke[id]) return;
  delete vermerke[id];
  schreiben(vermerke);
}

export function isInvoicePaymentUnconfirmed(invoiceId: string, paymentId: string): boolean {
  return Boolean(lesen()[vermerkKey(invoiceId, paymentId)]);
}

/** Alle Vermerke als `invoiceId#paymentId`. */
export function getUnconfirmedInvoicePaymentKeys(): Set<string> {
  return new Set(Object.keys(lesen()));
}

export function resetInvoicePaymentConfirmationForTests(): void {
  schreiben({});
}
