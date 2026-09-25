import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import {
  formatPaymentCurrency,
  getExpenseOpenAmount,
  isExpenseCancelled,
  isExpensePayable,
  recordExpensePayment,
  willExpensePaymentNeedOverpayConfirm,
} from '../../services/expensePaymentService';
import type { Expense, ExpensePaymentInput } from '../../types/expense';
import type { TranslationKey } from '../../i18n';
import { getBusinessDay } from '../../services/businessDateService';
import { formatDisplayDatePadded } from '../../utils/displayFormat';

interface Props {
  expense: Expense;
  open: boolean;
  onClose: () => void;
  onSaved: (expense: Expense) => void;
  translate: (key: TranslationKey) => string;
}

export function willExpensePaymentOverpay(openAmount: number, amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && willExpensePaymentNeedOverpayConfirm(openAmount, amount);
}

/**
 * FINANZCORE-05C — dieselben zwei Schritte wie im Rechnungsdialog.
 *
 * Bis hierher buchte dieses Formular sofort, auch wenn der Betrag über dem
 * offenen Rest lag; der gelbe Hinweis daneben war leicht zu übersehen und
 * hielt niemanden auf. Die Rechnungsseite kannte den Zwischenschritt längst —
 * `phase: 'form' | 'confirm'` mit einem zweiten Knopf. Kein neues Muster, kein
 * `window.confirm`, sondern das vorhandene.
 */
type FormPhase = 'form' | 'confirm';

export function ExpensePaymentForm({ expense, open, onClose, onSaved, translate }: Props) {
  const cancelled = isExpenseCancelled(expense);
  const payable = isExpensePayable(expense);
  const openAmount = getExpenseOpenAmount(expense);
  const today = getBusinessDay();

  /*
   * FINANZCORE-05B-FIX3 — der Vorschlag als **Maschinenwert**, nicht als Text.
   *
   * In FIX2 habe ich hier `.replace('.', ',')` ergänzt, damit statt „119" ein
   * Geldbetrag dasteht. Das Feld ist aber ein `input[type=number]`: Ein Wert
   * mit deutschem Komma ist dort kein gültiger Zahlenwert, der Browser verwirft
   * ihn stillschweigend — und das Feld blieb leer. Aus einer Kosmetikänderung
   * wurde ein unbenutzbarer Dialog.
   *
   * Deshalb die strikte Trennung: Im `value` steht der maschinenlesbare Wert
   * mit Punkt (`49.00`, `49.37`), passend zu `step="0.01"`. Die deutsche
   * Schreibweise gehört in die Anzeige **neben** das Feld, wo sie über
   * `formatPaymentCurrency` ohnehin steht.
   *
   * Zwei Nachkommastellen bleiben: Sie waren der Grund für FIX2 und sind auch
   * als Maschinenwert gültig.
   */
  const suggestedAmount = (value: number): string => Math.max(0, value).toFixed(2);

  const [phase, setPhase] = useState<FormPhase>('form');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(() => suggestedAmount(openAmount));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('form');
    setDate(today);
    setAmount(suggestedAmount(openAmount));
    setReference('');
    setNote('');
    setErrorKey(null);
  }, [open, openAmount, today]);

  const parsedAmount = parseFloat(amount.replace(',', '.')) || 0;
  const overpayAmount = useMemo(
    () => Math.max(0, parsedAmount - openAmount),
    [openAmount, parsedAmount],
  );
  const showOverpaymentWarning = willExpensePaymentOverpay(openAmount, parsedAmount);

  if (!open) return null;

  const submitPayment = (confirmed: boolean) => {
    if (cancelled || !payable) return;

    const needsOverpay = willExpensePaymentNeedOverpayConfirm(openAmount, parsedAmount);
    if (!confirmed && needsOverpay) {
      setPhase('confirm');
      setErrorKey(null);
      return;
    }

    const input: ExpensePaymentInput = {
      date,
      amount: parsedAmount,
      reference,
      note,
    };

    const result = recordExpensePayment(expense.id, input, {
      confirmOverpayment: needsOverpay ? confirmed : undefined,
    });
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }

    onSaved(result.expense);
    onClose();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submitPayment(false);
  };

  const handleClose = () => {
    setPhase('form');
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={handleClose}>
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

        {phase === 'form' ? (
          <>
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
              <p
                className="invoice-payment-form__warning"
                data-testid="expense-payment-overpay-warning"
              >
                {translate('payment.overpaymentWarning').replace(
                  '{amount}',
                  formatPaymentCurrency(overpayAmount),
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
              <Button
                type="submit"
                fullWidth
                disabled={cancelled || !payable}
                data-testid="expense-payment-save"
              >
                {translate('payment.save')}
              </Button>
              <Button type="button" variant="outline" fullWidth onClick={handleClose}>
                {translate('common.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <div className="invoice-payment-form__confirm" data-testid="expense-payment-confirm">
            <p>{translate('payment.confirmIntro')}</p>
            <p
              className="invoice-payment-form__warning"
              data-testid="expense-payment-overpay-confirm"
            >
              {translate('payment.overpaymentConfirmDetail').replaceAll(
                '{amount}',
                formatPaymentCurrency(overpayAmount),
              )}
            </p>
            {/*
              * Die drei Zahlen ausgeschrieben: woher der Beleg kommt, was
              * gebucht würde, was dadurch entsteht. Eine blosse Differenz
              * zwingt den Nutzer zum Kopfrechnen, genau dort, wo er
              * nachrechnen soll.
              */}
            <dl className="invoice-payment-form__confirm-figures" data-testid="expense-payment-confirm-figures">
              <div>
                <dt>{translate('payment.confirmOpenAmount')}</dt>
                <dd data-testid="expense-payment-confirm-open">{formatPaymentCurrency(openAmount)}</dd>
              </div>
              <div>
                <dt>{translate('payment.confirmPaymentAmount')}</dt>
                <dd data-testid="expense-payment-confirm-amount">{formatPaymentCurrency(parsedAmount)}</dd>
              </div>
              <div>
                <dt>{translate('payment.confirmOverpaidAmount')}</dt>
                <dd data-testid="expense-payment-confirm-overpaid">{formatPaymentCurrency(overpayAmount)}</dd>
              </div>
            </dl>
            {/* FINANZCORE-05C-FIX1 — deutsche Schreibweise, gemeinsamer Helfer; wie im Rechnungsdialog. */}
            <p
              className="invoice-payment-form__confirm-summary"
              data-testid="expense-payment-confirm-summary"
            >
              {formatPaymentCurrency(parsedAmount)} · {formatDisplayDatePadded(date)}
            </p>
            {errorKey && (
              <p className="invoice-payment-form__error">
                {translate(errorKey as TranslationKey)}
              </p>
            )}
            <div className="vorgang-dialog__actions">
              <Button
                type="button"
                fullWidth
                disabled={cancelled || !payable}
                data-testid="expense-payment-confirm-submit"
                onClick={() => submitPayment(true)}
              >
                {translate('payment.confirmSave')}
              </Button>
              <Button
                type="button"
                variant="outline"
                fullWidth
                data-testid="expense-payment-confirm-back"
                onClick={() => {
                  setPhase('form');
                  setErrorKey(null);
                }}
              >
                {translate('common.back')}
              </Button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
