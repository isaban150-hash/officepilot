import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import {
  calculatePaymentSummary,
  formatPaymentCurrency,
  getOpenAmount,
  getPaymentOverpayAmount,
  isInvoiceCancelled,
  recordPayment,
  willPaymentNeedUnsentConfirm,
} from '../../services/invoicePaymentService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import {
  isInvoicePaymentCloudSynced,
  syncInvoicePaymentToCloud,
} from '../../services/invoicePaymentService';
import type { InvoicePayment, InvoicePaymentInput, VorgangInvoice } from '../../types/models';
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
  return getPaymentOverpayAmount(openAmount, amount) > 0;
}

type FormPhase = 'form' | 'confirm';

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
  const needsUnsentNotice = willPaymentNeedUnsentConfirm(invoice);

  const [phase, setPhase] = useState<FormPhase>('form');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState(() => String(Math.max(0, openAmount)));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  /** 04B2B1 — gesetzt heißt: lokal gebucht, Cloud-Sicherung offen. */
  const [pendingPayment, setPendingPayment] = useState<InvoicePayment | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhase('form');
    setDate(today);
    setAmount(String(Math.max(0, openAmount)));
    setReference('');
    setNote('');
    setErrorKey(null);
    // Ein neu geöffnetes Formular kennt keine offene Sicherung.
    setPendingPayment(null);
    setSyncing(false);
  }, [open, openAmount, today]);

  const parsedAmount = parseFloat(amount.replace(',', '.')) || 0;
  const overpayAmount = useMemo(
    () => getPaymentOverpayAmount(openAmount, parsedAmount),
    [openAmount, parsedAmount],
  );
  const showOverpaymentWarning = overpayAmount > 0;

  if (!open) return null;

  const buildInput = (): InvoicePaymentInput => ({
    date,
    amount: parsedAmount,
    reference,
    note,
  });

  /**
   * PAYMENT-CLOUD-CLOSURE-04B2B1 — die Cloud-Sicherung einer bereits lokal
   * gebuchten Zahlung.
   *
   * Getrennt vom Erfassen, damit ein zweiter Klick nach einem Cloud-Fehler
   * niemals eine zweite Zahlung bucht: Übertragen wird ausschließlich das
   * vorhandene Objekt mit seiner vorhandenen Kennung.
   */
  const syncRecordedPayment = (payment: InvoicePayment) => {
    setSyncing(true);
    void syncInvoicePaymentToCloud(invoice.id, payment)
      .then((outcome) => {
        setSyncing(false);
        if (isInvoicePaymentCloudSynced(outcome)) {
          setPendingPayment(null);
          onClose();
          return;
        }
        /*
         * Die Zahlung bleibt lokal gebucht — der Nutzer hat sie erfasst. Aber
         * sie steht nur hier, und das darf die Oberfläche nicht verschweigen.
         * `supabase_not_configured` ist bei Geld kein stiller Normalfall.
         */
        setPendingPayment(payment);
        setErrorKey(outcome === 'conflict' ? 'payment.cloudConflict' : 'payment.cloudOnlyLocal');
      })
      .catch(() => {
        setSyncing(false);
        setPendingPayment(payment);
        setErrorKey('payment.cloudOnlyLocal');
      });
  };

  const submitPayment = (confirmed: boolean) => {
    if (cancelled || syncing) return;

    /*
     * Zustand B: lokal erfasst, Cloud ausstehend. Ein erneuter Klick wiederholt
     * ausschließlich die Sicherung — kein `recordPayment`, keine neue Kennung,
     * keine zweite Buchung desselben Betrags.
     */
    if (pendingPayment) {
      setErrorKey(null);
      syncRecordedPayment(pendingPayment);
      return;
    }

    const needsUnsent = willPaymentNeedUnsentConfirm(invoice);
    const needsOverpay = overpayAmount > 0;

    if (!confirmed && (needsUnsent || needsOverpay)) {
      setPhase('confirm');
      setErrorKey(null);
      return;
    }

    const result = recordPayment(vorgangId, invoice.id, buildInput(), {
      confirmUnsent: needsUnsent ? confirmed : undefined,
      confirmOverpayment: needsOverpay ? confirmed : undefined,
    });

    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }

    onSaved(result.invoice);
    if (!getLastPersistSuccess()) {
      setErrorKey('persist.failed.userAction');
      return;
    }

    // Der lokale Commit steht — ab hier geht es nur noch um die Cloud.
    syncRecordedPayment(result.payment);
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

        {needsUnsentNotice && phase === 'form' ? (
          <p className="invoice-payment-form__notice" data-testid="payment-unsent-notice">
            {translate('payment.unsentNotice')}
          </p>
        ) : null}

        {phase === 'form' ? (
          <>
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
              <p className="invoice-payment-form__warning" data-testid="payment-overpay-warning">
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
              <Button type="submit" fullWidth disabled={cancelled} data-testid="payment-save">
                {translate('payment.save')}
              </Button>
              <Button type="button" variant="outline" fullWidth onClick={handleClose}>
                {translate('common.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <div className="invoice-payment-form__confirm" data-testid="payment-confirm">
            <p>{translate('payment.confirmIntro')}</p>
            {needsUnsentNotice ? (
              <p className="invoice-payment-form__notice" data-testid="payment-unsent-confirm">
                {translate('payment.unsentNotice')}
              </p>
            ) : null}
            {overpayAmount > 0 ? (
              <p className="invoice-payment-form__warning" data-testid="payment-overpay-confirm">
                {translate('payment.overpaymentConfirmDetail').replace(
                  '{amount}',
                  formatPaymentCurrency(overpayAmount),
                )}
              </p>
            ) : null}
            <p className="invoice-payment-form__confirm-summary">
              {formatPaymentCurrency(parsedAmount)} · {date}
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
                disabled={cancelled}
                data-testid="payment-confirm-submit"
                onClick={() => submitPayment(true)}
              >
                {translate('payment.confirmSave')}
              </Button>
              <Button
                type="button"
                variant="outline"
                fullWidth
                data-testid="payment-confirm-back"
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

export function getPaymentSavedToastKey(invoice: VorgangInvoice): TranslationKey {
  const summary = calculatePaymentSummary(invoice);
  if (summary.status === 'bezahlt') return 'payment.savedFullyPaid';
  return 'payment.savedSuccess';
}
