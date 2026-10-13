/**
 * FINANZ-CORE-01A (SQL-01) — wann ein früherer Beleg nicht stornierbar ist.
 *
 * Eine reine Regel ohne Seiteneffekte, getrennt vom Stornodienst: Der Dialog
 * zeigt sie vorab, der Dienst prüft sie vor dem Serveraufruf, der Server
 * (`cancel_workspace_invoice`) entscheidet endgültig.
 */
import { getVorgangById } from '../vorgangService';
import type { VorgangInvoice } from '../../types/models';

/**
 * FINANZ-CORE-01A — wann die Seite die Stornoaktion anbietet. Bisher stand die Regel nur in
 * InvoiceDetailPage; der Test prüfte eine eigene Kopie, die nur Schlussrechnungen kannte.
 *
 * Normale Rechnungen (mit und ohne Auftrag); Teilrechnung, Abschlag und Schlussrechnung nur mit
 * Auftrag (ohne Auftrag gibt es sie nicht); nur freigegeben (vorbereitet/versendet), nie doppelt.
 */
export function canOfferInvoiceCancel(
  invoice: Pick<VorgangInvoice, 'type' | 'status' | 'paymentStatus' | 'cancelledAt'>,
  vorgangId: string | null,
): boolean {
  const cancelled = invoice.paymentStatus === 'storniert' || Boolean(invoice.cancelledAt);
  return (
    (invoice.type === 'rechnung' ||
      ((invoice.type === 'teilrechnung' || invoice.type === 'abschlag' || invoice.type === 'schluss') &&
        vorgangId !== null)) &&
    (invoice.status === 'vorbereitet' || invoice.status === 'versendet') &&
    !cancelled
  );
}

/**
 * Die wirksame Schlussrechnung, die diesen Beleg bereits abgerechnet hat.
 * Nach ihr ist jeder frühere Beleg desselben Vorgangs Teil der
 * Schlussabrechnung: Ein Pauschalabschlag steht dort als Abzug, eine
 * Teilrechnung oder ein mengenbasierter Abschlag hat Menge verbraucht. Ein
 * Storno danach machte die Schlussrechnung falsch.
 */
export function findFinalInvoiceBlockingCancel(
  vorgangId: string | null,
  invoice: Pick<VorgangInvoice, 'id' | 'type'>,
): VorgangInvoice | null {
  if (vorgangId === null || invoice.type === 'schluss') return null;
  const invoices = getVorgangById(vorgangId)?.invoices ?? [];
  return (
    invoices.find(
      (entry) =>
        entry.id !== invoice.id &&
        entry.type === 'schluss' &&
        (entry.status === 'vorbereitet' || entry.status === 'versendet') &&
        !entry.cancelledAt &&
        entry.paymentStatus !== 'storniert',
    ) ?? null
  );
}
