/**
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — die Verbindung zwischen einem
 * eingegangenen Dokument und einem bereits vorhandenen Finanzbeleg.
 *
 * Bewusst schmal: Hier steht **kein** Betrag, **kein** Zahlungsstatus und
 * **keine** Kopie des Belegs. Die fachliche Wahrheit bleibt `Expense` bzw.
 * `VorgangInvoice`; dieser Datensatz sagt nur, worauf das Dokument verweist,
 * und dass ein Mensch das bestätigt hat.
 *
 * Warum kein vorhandenes Feld: `Expense.linkedInboxId` bedeutet „diese Ausgabe
 * ist **aus** diesem Dokument entstanden" und wird in
 * `createExpenseFromInbox` genau so ausgewertet. Eine Mahnung, die auf eine
 * fremde Ausgabe verweist, dort einzutragen, hiesse zwei verschiedene Aussagen
 * in dasselbe Feld zu schreiben.
 */

/**
 * Die beiden Zahlungswelten. `incoming_payable`: Wir schulden einem
 * Lieferanten Geld (`Expense`). `outgoing_receivable`: Ein Kunde schuldet uns
 * Geld (`VorgangInvoice`). Eine eingehende Mahnung ist immer das erste.
 */
export type DocumentFinanceReferenceDirection = 'incoming_payable' | 'outgoing_receivable';

export type DocumentFinanceReferenceTargetType = 'expense' | 'invoice';

export interface DocumentFinanceReference {
  direction: DocumentFinanceReferenceDirection;
  targetType: DocumentFinanceReferenceTargetType;
  targetId: string;
  /** Die Nummer, über die verbunden wurde — roh, wie im Dokument erkannt. */
  referenceNumber: string;
  /** Normalisierte Gegenpartei; macht den Bezug gegen Umbenennungen prüfbar. */
  counterpartyKey: string;
  /** Nur eine ausdrückliche Nutzerbestätigung schreibt diesen Datensatz. */
  confirmedAt: string;
}
