import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import {
  formatPaymentCurrency,
  getExpenseOpenAmount,
  isExpenseCancelled,
  isExpensePayable,
  recordExpensePayment,
} from '../../services/expensePaymentService';
import type { Expense, ExpensePaymentInput } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  expense: Expense;
  open: boolean;
  onClose: () => void;
  onSaved: (expense: Expense) => void;
  translate: (key: TranslationKey) => string;
}

export function willExpensePaymentOverpay(openAmount: number, amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && amount > openAmount;
}

export function ExpensePaymentForm({ expense, open, onClose, onSaved, translate }: Props) {
  const cancelled = isExpenseCancelled(expense);
  const payable = isExpensePayable(expense);
  const openAmount = getExpenseOpenAmount(expense);
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(() => String(Math.max(0, openAmount)));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(today);
    setAmount(String(Math.max(0, openAmount)));
    setReference('');
    setNote('');
    setErrorKey(null);
  }, [open, openAmount, today]);

  const parsedAmount = parseFloat(amount.replace(',', '.')) || 0;
  const showOverpaymentWarning = useMemo(
    () => willExpensePaymentOverpay(openAmount, parsedAmount),
    [openAmount, parsedAmount],
  );

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (cancelled || !payable) return;

    const input: ExpensePaymentInput = {
      date,
      amount: parsedAmount,
      reference,
      note,
    };

    const result = recordExpensePayment(expense.id, input);
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }

    onSaved(result.expense);
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog invoice-payment-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="expense-payment-form-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="expense-payment-form-title" className="vorgang-dialog__title">
          {translate('expense.payment.formTitle')}
        </h3>
        <p className="vorgang-dialog__subtitle">
          {expense.supplierName}
          {expense.invoiceNumber ? ` · ${expense.invoiceNumber}` : ''} ·{' '}
          {translate('payment.openAmount')}: {formatPaymentCurrency(openAmount)}
        </p>

        {cancelled && (
          <p className="invoice-payment-form__notice">
            {translate('expense.payment.cancelledNotice')}
          </p>
        )}

        {!payable && !cancelled && (
          <p className="invoice-payment-form__notice">
            {translate('expense.payment.notPayableNotice')}
          </p>
        )}

        <label className="invoice-payment-form__field">
          <span>{translate('payment.date')}</span>
          <input
            type="date"
            className="input"
            value={date}
            disabled={cancelled || !payable}
            required
            onChange={(event) => setDate(event.target.value)}
          />
        </label>

        <label className="invoice-payment-form__field">
          <span>{translate('payment.amount')}</span>
          <input
            type="number"
            className="input"
            min="0.01"
            step="0.01"
            value={amount}
            disabled={cancelled || !payable}
            required
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>

        {showOverpaymentWarning && (
          <p className="invoice-payment-form__warning">
            {translate('payment.overpaymentWarning').replace(
              '{amount}',
              formatPaymentCurrency(parsedAmount - openAmount),
            )}
          </p>
        )}

        <label className="invoice-payment-form__field">
          <span>{translate('payment.reference')}</span>
          <input
            type="text"
            className="input"
            value={reference}
            disabled={cancelled || !payable}
            onChange={(event) => setReference(event.target.value)}
          />
        </label>

        <label className="invoice-payment-form__field">
          <span>{translate('payment.note')}</span>
          <textarea
            className="input invoice-payment-form__textarea"
            value={note}
            disabled={cancelled || !payable}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        {errorKey && (
          <p className="invoice-payment-form__error">
            {translate(errorKey as TranslationKey)}
          </p>
        )}

        <div className="vorgang-dialog__actions">
          <Button type="submit" fullWidth disabled={cancelled || !payable}>
            {translate('payment.save')}
          </Button>
          <Button type="button" variant="outline" fullWidth onClick={onClose}>
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
