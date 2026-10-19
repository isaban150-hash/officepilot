/**
 * FINANZ-CORE-01A (Restnacharbeit END18-R3) — was der Server an dieser Ausgabe endgültig abgewiesen hat.
 *
 * Abgewiesene Zahlungen stehen nicht mehr unter den Zahlungen und zählen nirgends (Saldo, offene Posten,
 * Monatsmappe, Export, Abschluss). Abgewiesene Belegänderungen sind zurückgenommen; der Beleg zeigt den
 * Serverstand. Beides bleibt hier sichtbar, damit nichts still verschwindet — und damit klar ist, dass ein
 * tatsächlich geleistetes Geld bewusst neu erfasst werden muss.
 */
import type { TranslationKey } from '../../i18n';
import type { Expense, RejectedExpenseChange } from '../../types/expense';
import type { UnreconciledExpenseRejection } from '../../services/expense/expenseCloudSyncService';
import { formatPaymentCurrency } from '../../services/expensePaymentService';
import { formatDisplayDate } from '../../utils/displayFormat';

interface ExpenseRejectedActionsNoticeProps {
  expense: Expense;
  translate: (key: TranslationKey) => string;
}

const REASON_KEYS: ReadonlyArray<[string, TranslationKey]> = [
  ['expense_payment_overpayment_unconfirmed', 'expense.rejected.reason.overpayment'],
  ['expense_payment_not_payable', 'expense.rejected.reason.notPayable'],
  ['expense_amount_locked_after_payment', 'expense.rejected.reason.amountLocked'],
  ['expense_cancel_has_payments', 'expense.rejected.reason.cancelHasPayments'],
  ['expense_status_locked_after_payment', 'expense.rejected.reason.statusLocked'],
  ['expense_cancel_not_booked', 'expense.rejected.reason.cancelNotBooked'],
  ['expense_cancelled_immutable', 'expense.rejected.reason.cancelledImmutable'],
  ['Ausgabe hat gebuchte Zahlungen', 'expense.rejected.reason.deleteHasPayments'],
  ['Ausgabe storniert', 'expense.rejected.reason.expenseCancelled'],
  ['Ausgabe geloescht', 'expense.rejected.reason.expenseDeleted'],
  ['finance_forbidden_role', 'expense.rejected.reason.role'],
];

export function describeExpenseRejectionReason(
  reason: string,
  translate: (key: TranslationKey) => string,
): string {
  const treffer = REASON_KEYS.find(([marker]) => reason.includes(marker));
  return treffer ? translate(treffer[1]) : reason;
}

function changeKey(change: RejectedExpenseChange): TranslationKey {
  switch (change.kind) {
    case 'cancel':
      return 'expense.rejected.change.cancel';
    case 'delete':
      return 'expense.rejected.change.delete';
    case 'create':
      return 'expense.rejected.change.create';
    case 'payment_reverse':
      return 'expense.rejected.change.paymentReverse';
    default:
      return 'expense.rejected.change.update';
  }
}

export function ExpenseRejectedActionsNotice({ expense, translate }: ExpenseRejectedActionsNoticeProps) {
  const payments = expense.rejectedPayments ?? [];
  const changes = expense.rejectedChanges ?? [];
  if (payments.length === 0 && changes.length === 0) return null;
  return (
    <section className="invoice-hint invoice-hint--warning" data-testid="ausgabe-rejected-panel">
      <p>{translate('expense.rejected.intro')}</p>
      <ul className="detail-list">
        {payments.map((payment) => (
          <li key={`p-${payment.id}`} data-testid="ausgabe-rejected-payment">
            {translate('expense.rejected.payment')
              .replace('{amount}', formatPaymentCurrency(payment.amount))
              .replace('{date}', formatDisplayDate(payment.date))
              .replace('{reason}', describeExpenseRejectionReason(payment.reason, translate))}
          </li>
        ))}
        {changes.map((change) => (
          <li key={`c-${change.outboxId}`} data-testid="ausgabe-rejected-change" data-kind={change.kind}>
            {translate(changeKey(change))
              .replace(
                '{amount}',
                change.attempted?.grossAmount !== undefined ? formatPaymentCurrency(change.attempted.grossAmount) : '—',
              )
              .replace('{reason}', describeExpenseRejectionReason(change.reason, translate))}
          </li>
        ))}
      </ul>
      {payments.length > 0 ? <p data-testid="ausgabe-rejected-hint">{translate('expense.rejected.paymentHint')}</p> : null}
    </section>
  );
}

interface ExpenseUnreconciledRejectionsNoticeProps {
  pending: readonly UnreconciledExpenseRejection[];
  translate: (key: TranslationKey) => string;
}

/**
 * Bericht 19 — eine endgültige Abweisung, deren Serverstand noch nicht abgeglichen ist (Abzug danach gescheitert,
 * Gerät offline): Was hier steht, ist vorläufig und nicht verbindlich; der Monatsabschluss sperrt bis zum Abgleich.
 */
export function ExpenseUnreconciledRejectionsNotice({ pending, translate }: ExpenseUnreconciledRejectionsNoticeProps) {
  if (pending.length === 0) return null;
  return (
    <section className="invoice-hint invoice-hint--warning" data-testid="ausgabe-rejected-pending-panel">
      <p>{translate('expense.rejected.pendingIntro')}</p>
      <ul className="detail-list">
        {pending.map((item) => (
          <li key={item.outboxId} data-testid="ausgabe-rejected-pending" data-kind={item.kind}>
            {translate(
              item.kind === 'payment'
                ? 'expense.rejected.pendingPayment'
                : item.kind === 'reverse'
                  ? 'expense.rejected.pendingReverse'
                  : 'expense.rejected.pendingChange',
            ).replace(
              '{reason}',
              describeExpenseRejectionReason(item.reason, translate),
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
