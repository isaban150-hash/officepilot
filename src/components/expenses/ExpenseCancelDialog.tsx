import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { cancelExpense, hasBookedExpensePayments } from '../../services/expenseService';
import { formatPaymentCurrency } from '../../services/expensePaymentService';
import { formatDisplayDate } from '../../utils/displayFormat';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

/**
 * OFFICEPILOT-V1-A — die sichtbare Stornierung einer gebuchten Ausgabe.
 *
 * Gleiches Muster wie `InvoiceCancelDialog`: Der Klick auf die Aktion
 * storniert nichts, er öffnet diesen Dialog. Der zeigt, **welcher** Beleg
 * betroffen ist, verlangt einen selbst formulierten Grund und storniert erst
 * nach der ausdrücklichen Bestätigung. Fachliche Prüfung liegt im Dienst
 * (`cancelExpense`): genau einmal, nie mit gebuchter Zahlung, nie löschen.
 */
interface Props {
  expense: Expense;
  open: boolean;
  onClose: () => void;
  onCancelled: (expense: Expense) => void;
  translate: (key: TranslationKey) => string;
}

export function ExpenseCancelDialog({ expense, open, onClose, onCancelled, translate }: Props) {
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  /* Doppelklick läuft ins Leere, nicht in einen zweiten Stornoversuch. */
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    /* Der Grund wird nicht vorbelegt — ein Standardsatz wäre eine erfundene Begründung. */
    setReason('');
    setReasonTouched(false);
    setErrorKey(null);
    inFlight.current = false;
  }, [open, expense.id]);

  if (!open) return null;

  const trimmedReason = reason.trim();
  const reasonMissing = trimmedReason.length === 0;
  const blockedByPayments = hasBookedExpensePayments(expense);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setReasonTouched(true);
    if (reasonMissing) {
      setErrorKey('expense.cancel.reasonRequired');
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    const result = cancelExpense(expense.id, trimmedReason);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      inFlight.current = false;
      return;
    }
    onCancelled(result.expense);
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog invoice-cancel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="expense-cancel-dialog-title"
        data-testid="expense-cancel-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="expense-cancel-dialog-title" className="vorgang-dialog__title">
          {translate('expense.cancel')}
        </h3>

        <div data-testid="expense-cancel-facts">
          <div className="data-row">
            <span className="data-row__label">{translate('expense.fieldSupplier')}</span>
            <span className="data-row__value">{expense.supplierName}</span>
          </div>
          <div className="data-row">
            <span className="data-row__label">{translate('expense.fieldIssueDate')}</span>
            <span className="data-row__value">{formatDisplayDate(expense.issueDate)}</span>
          </div>
          <div className="data-row" data-testid="expense-cancel-amount">
            <span className="data-row__label">{translate('expense.fieldGrossAmount')}</span>
            <span className="data-row__value">{formatPaymentCurrency(expense.grossAmount)}</span>
          </div>
        </div>

        <p className="invoice-cancel-dialog__notice" data-testid="expense-cancel-notice">
          {translate('expense.cancel.intro')}
        </p>

        {blockedByPayments ? (
          <p className="invoice-payment-form__warning" data-testid="expense-cancel-payment-block">
            {translate('expense.cancel.hasPayments')}
          </p>
        ) : null}

        <label className="invoice-payment-form__field">
          <span>{translate('expense.cancel.reasonLabel')}</span>
          <textarea
            className="input invoice-payment-form__textarea"
            rows={3}
            value={reason}
            placeholder={translate('expense.cancel.reasonPlaceholder')}
            disabled={blockedByPayments}
            required
            data-testid="expense-cancel-reason-input"
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setReasonTouched(true)}
          />
        </label>
        {reasonTouched && reasonMissing ? (
          <p className="invoice-payment-form__error" data-testid="expense-cancel-reason-error">
            {translate('expense.cancel.reasonRequired')}
          </p>
        ) : null}
        {errorKey ? (
          <p className="invoice-payment-form__error" data-testid="expense-cancel-error">
            {translate(errorKey)}
          </p>
        ) : null}

        <div className="vorgang-dialog__actions">
          <Button
            type="submit"
            variant="danger"
            fullWidth
            disabled={reasonMissing || blockedByPayments}
            data-testid="expense-cancel-submit"
          >
            {translate('expense.cancel.confirm')}
          </Button>
          <Button type="button" variant="outline" fullWidth onClick={onClose} data-testid="expense-cancel-abort">
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
