import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  getOpenAmount,
  isInvoiceCancelled,
  recordPayment,
} from '../../services/invoicePaymentService';
import type { InvoicePaymentInput, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  vorgangId: string;
  invoice: VorgangInvoice;
  open: boolean;
  onClose: () => void;
  onSaved: (invoice: VorgangInvoice) => void;
  translate: (key: TranslationKey) => string;
}

export function willPaymentOverpay(openAmount: number, amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && amount > openAmount;
}

export function InvoicePaymentForm({
  vorgangId,
  invoice,
  open,
  onClose,
  onSaved,
  translate,
}: Props) {
  const cancelled = isInvoiceCancelled(invoice);
  const openAmount = getOpenAmount(invoice);
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
    () => willPaymentOverpay(openAmount, parsedAmount),
    [openAmount, parsedAmount],
  );

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (cancelled) return;

    const input: InvoicePaymentInput = {
      date,
      amount: parsedAmount,
      reference,
      note,
    };

    const result = recordPayment(vorgangId, invoice.id, input);
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }

    onSaved(result.invoice);
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog invoice-payment-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-payment-form-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="invoice-payment-form-title" className="vorgang-dialog__title">
          {translate('payment.formTitle')}
        </h3>
        <p className="vorgang-dialog__subtitle">
          {invoice.number} · {translate('payment.openAmount')}: {formatPaymentCurrency(openAmount)}
        </p>

        {cancelled && (
          <p className="invoice-payment-form__notice">{translate('payment.invoiceCancelledNotice')}</p>
        )}

        <label className="invoice-payment-form__field">
          <span>{translate('payment.date')}</span>
          <input
            type="date"
            className="input"
            value={date}
            disabled={cancelled}
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
            disabled={cancelled}
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
            disabled={cancelled}
            onChange={(event) => setReference(event.target.value)}
          />
        </label>

        <label className="invoice-payment-form__field">
          <span>{translate('payment.note')}</span>
          <textarea
            className="input invoice-payment-form__textarea"
            value={note}
            disabled={cancelled}
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
          <Button type="submit" fullWidth disabled={cancelled}>
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

export function getPaymentSavedToastKey(invoice: VorgangInvoice): TranslationKey {
  const summary = calculatePaymentSummary(invoice);
  if (summary.status === 'bezahlt') return 'payment.savedFullyPaid';
  return 'payment.savedSuccess';
}
