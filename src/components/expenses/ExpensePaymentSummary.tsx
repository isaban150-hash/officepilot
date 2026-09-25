import {
  calculateExpensePaymentSummary,
  getOverdueDays,
  isCreditNoteExpense,
  isExpenseCancelled,
} from '../../services/expensePaymentService';
import { ExpensePaymentBadge } from './ExpensePaymentBadge';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';
import { InlineNotice } from '../ui/States';
import { MoneyDisplay } from '../ui/Display';

interface Props {
  expense: Expense;
  translate: (key: TranslationKey) => string;
}

export function ExpensePaymentSummary({ expense, translate }: Props) {
  const summary = calculateExpensePaymentSummary(expense);
  const overdueDays = getOverdueDays(expense);
  const creditNote = isCreditNoteExpense(expense);
  /*
   * FINANZCORE-05B-FIX2 — eine Gutschrift trägt ein Guthaben, keine Schuld.
   * Angezeigt wird der Betrag ohne Vorzeichen; dass es ein Guthaben ist, sagt
   * die Beschriftung.
   */
  const creditAmount = Math.abs(summary.totalDue);
  /*
   * Altbestand: Kann an einer Gutschrift schon eine Zahlung hängen? Im heutigen
   * Modell entsteht sie nicht mehr — die Erfassung ist gesperrt. Ein alter
   * Datensatz wird deshalb nicht umgeschrieben, sondern benannt.
   */
  const creditNoteWithPayments = creditNote && summary.paidAmount !== 0;

  return (
    <section className="invoice-payment-summary">
      <div className="invoice-payment-summary__header">
        <h3 className="invoice-payment-summary__title">{translate('payment.summaryTitle')}</h3>
        <ExpensePaymentBadge status={summary.status} translate={translate} />
      </div>

      {isExpenseCancelled(expense) && (
        <InlineNotice tone="neutral">{translate('expense.payment.cancelledNotice')}</InlineNotice>
      )}

      {creditNote && !isExpenseCancelled(expense) && (
        <InlineNotice tone="info" testId="ausgabe-credit-note-notice">
          {translate('expense.creditNote.notice')}
        </InlineNotice>
      )}

      {creditNoteWithPayments && (
        <InlineNotice tone="warning" testId="ausgabe-credit-note-legacy-payments">
          {translate('expense.creditNote.legacyPaymentsNotice')}
        </InlineNotice>
      )}

      {summary.status === 'ueberfaellig' && !isExpenseCancelled(expense) && (
        <InlineNotice tone="critical">{translate('expense.payment.overdueNotice')}</InlineNotice>
      )}

      {/*
        * FINANZCORE-05B-FIX2 — die Gutschrift bekommt ihre eigenen Zeilen.
        *
        * „Bezahlt", „Offen" und „Überzahlung" sind Begriffe für eine
        * Verbindlichkeit. Auf einen Beleg, der ein Guthaben ausweist, passt
        * keiner davon; bis hierher zeigte die Ansicht alle drei — mit 0,00,
        * 0,00 und einer Überzahlung, die es nie gab.
        */}
      {creditNote ? (
        <dl className="invoice-payment-summary__rows summary-list summary-list--single">
          <div className="invoice-payment-summary__row">
            <dt>{translate('expense.creditNote.amountLabel')}</dt>
            <dd data-testid="ausgabe-credit-amount">
              <MoneyDisplay value={creditAmount} />
            </dd>
          </div>
          {creditNoteWithPayments && (
            <div className="invoice-payment-summary__row">
              <dt>{translate('payment.paidAmount')}</dt>
              <dd><MoneyDisplay value={summary.paidAmount} /></dd>
            </div>
          )}
        </dl>
      ) : (
        <dl className="invoice-payment-summary__rows summary-list summary-list--single">
          <div className="invoice-payment-summary__row">
            <dt>{translate('payment.totalDue')}</dt>
            <dd><MoneyDisplay value={summary.totalDue} /></dd>
          </div>
          <div className="invoice-payment-summary__row">
            <dt>{translate('payment.paidAmount')}</dt>
            <dd><MoneyDisplay value={summary.paidAmount} /></dd>
          </div>
          {/* V1-A — ein stornierter Beleg hat keinen offenen Betrag; die Zahl bleibt in der Rechnung, nicht in der Anzeige. */}
          {!isExpenseCancelled(expense) && (
            <div className="invoice-payment-summary__row">
              <dt>{translate('payment.openAmount')}</dt>
              <dd><MoneyDisplay value={summary.openAmount} /></dd>
            </div>
          )}
          {summary.overpaidAmount > 0 && (
            <div className="invoice-payment-summary__row invoice-payment-summary__row--overpaid">
              <dt>{translate('payment.overpaidAmount')}</dt>
              <dd><MoneyDisplay value={summary.overpaidAmount} /></dd>
            </div>
          )}
        </dl>
      )}

      {overdueDays > 0 && (
        <p className="invoice-payment-summary__overdue-days">
          {translate('payment.overdueDays').replace('{days}', String(overdueDays))}
        </p>
      )}
    </section>
  );
}

export function getExpensePaymentSavedToastKey(expense: Expense): TranslationKey {
  const summary = calculateExpensePaymentSummary(expense);
  if (summary.status === 'bezahlt') return 'expense.payment.savedFullyPaid';
  return 'expense.payment.savedSuccess';
}
