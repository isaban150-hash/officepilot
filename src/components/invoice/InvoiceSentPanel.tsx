import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import {
  formatInvoiceSentViaLabel,
  INVOICE_SENT_VIA_OPTIONS,
  markInvoiceAsSent,
  updateInvoiceSentDetails,
  type InvoiceSentInput,
} from '../../services/invoiceSentService';
import { isSentDateAfterPaymentDue } from '../../services/invoicePaymentService';
import type { InvoiceSentVia, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  vorgangId: string;
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  onUpdated: (invoice: VorgangInvoice) => void;
}

type FormMode = 'closed' | 'mark' | 'correct' | 'confirm-mark' | 'confirm-correct';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(value: string): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

export function InvoiceSentPanel({ vorgangId, invoice, translate, onUpdated }: Props) {
  const [mode, setMode] = useState<FormMode>('closed');
  const [sentAt, setSentAt] = useState(todayIso());
  const [sentVia, setSentVia] = useState<InvoiceSentVia>('email');
  const [sentNote, setSentNote] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (mode !== 'mark' && mode !== 'correct') return;
    if (mode === 'mark') {
      setSentAt(todayIso());
      setSentVia('email');
      setSentNote('');
    } else {
      setSentAt(invoice.sentAt?.trim() || todayIso());
      setSentVia(invoice.sentVia ?? 'email');
      setSentNote(invoice.sentNote ?? '');
    }
    setErrorKey(null);
  }, [mode, invoice.id, invoice.sentAt, invoice.sentVia, invoice.sentNote]);

  const closeAll = () => {
    setMode('closed');
    setErrorKey(null);
  };

  const buildInput = (): InvoiceSentInput => ({
    sentAt,
    sentVia,
    sentNote: sentNote.trim() || undefined,
  });

  const handleConfirm = () => {
    const input = buildInput();
    const result =
      mode === 'confirm-mark'
        ? markInvoiceAsSent(vorgangId, invoice.id, input)
        : updateInvoiceSentDetails(vorgangId, invoice.id, input);

    if (!result.ok) {
      if (result.reason === 'invalid_date') {
        setErrorKey('invoice.sent.error.date');
      } else if (result.reason === 'invalid_via') {
        setErrorKey('invoice.sent.error.via');
      } else if (result.reason === 'not_prepared' || result.reason === 'already_sent') {
        setErrorKey('invoice.sent.error.notPrepared');
      } else {
        setErrorKey('invoice.sent.error.failed');
      }
      return;
    }

    onUpdated(result.invoice);
    closeAll();
  };

  const showForm = mode === 'mark' || mode === 'correct';
  const showConfirm = mode === 'confirm-mark' || mode === 'confirm-correct';
  const isSent = invoice.status === 'versendet';
  const lateSentHintDate = showForm || showConfirm ? sentAt : invoice.sentAt;
  const showLateSentHint = isSentDateAfterPaymentDue(lateSentHintDate, invoice.paymentDueDate);

  return (
    <section className="invoice-sent-panel" data-testid="invoice-sent-panel">
      <Card>
        <CardTitle>{translate('invoice.sent.title')}</CardTitle>
        <p className="invoice-sent-panel__hint" data-testid="invoice-sent-hint">
          {translate('invoice.sent.hint')}
        </p>

        {showLateSentHint && isSent && mode === 'closed' ? (
          <p className="invoice-sent-panel__late-due" data-testid="invoice-sent-late-due">
            {translate('invoice.sent.dueAlreadyPassed').replace(
              '{due}',
              formatDisplayDate(invoice.paymentDueDate ?? ''),
            )}
          </p>
        ) : null}

        {isSent ? (
          <div className="invoice-sent-panel__status" data-testid="invoice-sent-status">
            <dl className="invoice-sent-panel__facts">
              <div>
                <dt>{translate('invoice.sent.date')}</dt>
                <dd data-testid="invoice-sent-at">{formatDisplayDate(invoice.sentAt ?? '')}</dd>
              </div>
              <div>
                <dt>{translate('invoice.sent.via')}</dt>
                <dd data-testid="invoice-sent-via">
                  {formatInvoiceSentViaLabel(invoice.sentVia, translate)}
                </dd>
              </div>
              {invoice.sentNote?.trim() ? (
                <div>
                  <dt>{translate('invoice.sent.note')}</dt>
                  <dd data-testid="invoice-sent-note">{invoice.sentNote}</dd>
                </div>
              ) : null}
            </dl>
            {mode === 'closed' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode('correct')}
                data-testid="invoice-sent-correct"
              >
                {translate('invoice.sent.correct')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div data-testid="invoice-sent-prepared">
            <p className="invoice-sent-panel__meta">
              {translate('invoice.sent.notSentYet')}
            </p>
            {mode === 'closed' ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setMode('mark')}
                data-testid="invoice-sent-mark"
              >
                {translate('invoice.sent.mark')}
              </Button>
            ) : null}
          </div>
        )}

        {showForm ? (
          <form
            className="invoice-sent-panel__form"
            data-testid="invoice-sent-form"
            onSubmit={(event) => {
              event.preventDefault();
              setMode(mode === 'mark' ? 'confirm-mark' : 'confirm-correct');
            }}
          >
            <label className="invoice-sent-panel__label" htmlFor="invoice-sent-date">
              {translate('invoice.sent.date')}
            </label>
            <input
              id="invoice-sent-date"
              type="date"
              className="input"
              value={sentAt}
              onChange={(event) => setSentAt(event.target.value)}
              required
              data-testid="invoice-sent-date-input"
            />

            <label className="invoice-sent-panel__label" htmlFor="invoice-sent-via-input">
              {translate('invoice.sent.via')}
            </label>
            <select
              id="invoice-sent-via-input"
              className="input"
              value={sentVia}
              onChange={(event) => setSentVia(event.target.value as InvoiceSentVia)}
              data-testid="invoice-sent-via-input"
            >
              {INVOICE_SENT_VIA_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {translate(`invoice.sent.via.${option}` as TranslationKey)}
                </option>
              ))}
            </select>

            <label className="invoice-sent-panel__label" htmlFor="invoice-sent-note-input">
              {translate('invoice.sent.noteOptional')}
            </label>
            <textarea
              id="invoice-sent-note-input"
              className="input"
              rows={2}
              value={sentNote}
              onChange={(event) => setSentNote(event.target.value)}
              data-testid="invoice-sent-note-input"
            />

            {errorKey ? (
              <p className="invoice-sent-panel__error" data-testid="invoice-sent-error">
                {translate(errorKey)}
              </p>
            ) : null}

            {showLateSentHint ? (
              <p className="invoice-sent-panel__late-due" data-testid="invoice-sent-late-due">
                {translate('invoice.sent.dueAlreadyPassed').replace(
                  '{due}',
                  formatDisplayDate(invoice.paymentDueDate ?? ''),
                )}
              </p>
            ) : null}

            <div className="invoice-sent-panel__actions">
              <Button type="button" variant="outline" size="sm" onClick={closeAll}>
                {translate('common.cancel')}
              </Button>
              <Button type="submit" size="sm" data-testid="invoice-sent-continue">
                {translate('invoice.sent.continue')}
              </Button>
            </div>
          </form>
        ) : null}

        {showConfirm ? (
          <div className="invoice-sent-panel__confirm" data-testid="invoice-sent-confirm">
            <p>{translate('invoice.sent.confirmText')}</p>
            <p className="invoice-sent-panel__confirm-summary">
              {formatDisplayDate(sentAt)} · {formatInvoiceSentViaLabel(sentVia, translate)}
            </p>
            {showLateSentHint ? (
              <p className="invoice-sent-panel__late-due" data-testid="invoice-sent-late-due">
                {translate('invoice.sent.dueAlreadyPassed').replace(
                  '{due}',
                  formatDisplayDate(invoice.paymentDueDate ?? ''),
                )}
              </p>
            ) : null}
            {errorKey ? (
              <p className="invoice-sent-panel__error" data-testid="invoice-sent-error">
                {translate(errorKey)}
              </p>
            ) : null}
            <div className="invoice-sent-panel__actions">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMode(mode === 'confirm-mark' ? 'mark' : 'correct')}
                data-testid="invoice-sent-confirm-back"
              >
                {translate('common.back')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleConfirm}
                data-testid="invoice-sent-confirm-submit"
              >
                {translate('invoice.sent.confirm')}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
