/**
 * BANKABGLEICH-V1 BLOCK 4 — die bestätigte Zuordnung.
 *
 * Der Unterschied zu Block 3 in einem Satz: Ein Vorschlag ist eine
 * Beobachtung, eine Zuordnung ist eine **Entscheidung mit Geldwirkung**.
 * Deshalb ist sie persistent, serverseitig eindeutig und entsteht nur nach
 * ausdrücklicher Bestätigung.
 *
 * Sie ist bewusst eine **eigene Entität** und kein Feld an der Zahlung oder
 * an der Bankbewegung: Nur so kann eine Eindeutigkeit „je Bankbewegung
 * höchstens eine Zuordnung" überhaupt durchgesetzt werden, und nur so bleibt
 * erkennbar, dass diese Zahlung aus einem Kontoauszug stammt.
 */

export type BankReconciliationTargetType = 'invoice' | 'expense';

export interface BankReconciliation {
  id: string;
  /** Die Bankbewegung — je Betrieb höchstens einmal zugeordnet. */
  bankTransactionId: string;
  targetType: BankReconciliationTargetType;
  /** `VorgangInvoice.id` bzw. `Expense.id`. */
  targetId: string;
  /** Die Zahlung, die durch diese Bestätigung entstanden ist. */
  paymentId: string;
  /** Was tatsächlich gebucht wurde, in Cent — immer positiv. */
  amountCents: number;
  /** Das Buchungsdatum der Bank, nicht die Uhrzeit der Bestätigung. */
  paidOn: string;
  confirmedAt: string;
  sync?: import('./sync').SyncMeta;
}

/** Warum eine Bestätigung nicht ausgeführt werden konnte — in Produktsprache übersetzbar. */
export type BankReconciliationRefusal =
  | 'already_reconciled'
  | 'amount_exceeds_open'
  | 'wrong_direction'
  | 'target_not_found'
  | 'transaction_not_found'
  | 'nothing_open'
  | 'offline';

export type BankReconciliationOutcome =
  | { ok: true; reconciliation: BankReconciliation }
  | { ok: false; refusal: BankReconciliationRefusal; detail?: string };
