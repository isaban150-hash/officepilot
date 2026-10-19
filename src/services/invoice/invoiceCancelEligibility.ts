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

/**
 * FC01A-Nacharbeit (A2) — die wirksame Schlussrechnung, die diesen Abschlag als beglichen
 * abzieht. Solange es sie gibt, ist eine Zahlung des Abschlags nicht rücknehmbar: Die
 * Schlussrechnung hat die Zahlung eingefroren und weist den Abschlag als bezahlt aus; nach
 * einer Rücknahme stünde er wieder offen (mahnbar). Wie beim Storno (SQL-01): zuerst die
 * Schlussrechnung stornieren. Der Server (`reverse_workspace_invoice_payment`) entscheidet
 * endgültig; mengenbasierte Abschläge (kein Abzug) und andere Belege sind nicht betroffen.
 */
export function findFinalInvoiceBlockingPaymentReversal(
  vorgangId: string | null,
  invoice: Pick<VorgangInvoice, 'id' | 'type'>,
): VorgangInvoice | null {
  if (vorgangId === null || invoice.type !== 'abschlag') return null;
  const invoices = getVorgangById(vorgangId)?.invoices ?? [];
  return (
    invoices.find(
      (entry) =>
        entry.id !== invoice.id &&
        entry.type === 'schluss' &&
        (entry.status === 'vorbereitet' || entry.status === 'versendet') &&
        !entry.cancelledAt &&
        entry.paymentStatus !== 'storniert' &&
        (entry.previousAbschlagDeductions ?? []).some((deduction) => deduction.invoiceId === invoice.id),
    ) ?? null
  );
}

/**
 * FINANZ-CORE-01A (Gesamtnacharbeit INV-03) — hat eine wirksame Schlussrechnung Zahlung und Skonto dieses
 * Abschlags eingefroren (Abzug mit `paidAmount`, seit N02)? Dann nimmt er keine neue Zahlung mehr an, gleich
 * wie hoch sein offener Betrag gerade erscheint — die eingefrorene Aufteilung würde sonst falsch, und die
 * Zahlung wäre nicht einmal rücknehmbar (Server: `add_workspace_invoice_payment`). Ein Altabzug ohne
 * Aufteilung (vor N02) bleibt bis zum offenen Betrag zahlbar.
 */
export function hasFrozenFinalInvoiceDeduction(
  vorgangId: string | null,
  invoice: Pick<VorgangInvoice, 'id' | 'type'>,
): boolean {
  const schluss = findFinalInvoiceBlockingPaymentReversal(vorgangId, invoice);
  if (!schluss) return false;
  return (schluss.previousAbschlagDeductions ?? []).some(
    (deduction) => deduction.invoiceId === invoice.id && typeof deduction.paidAmount === 'number',
  );
}
