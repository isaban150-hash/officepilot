import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { formatPaymentCurrency, getInvoicePayments } from '../../services/invoicePaymentService';
import {
  cancelFinalizedInvoice,
  type CancelInvoiceFailureReason,
} from '../../services/invoice/invoiceCancellationService';
import { getInvoiceDocumentTitle } from '../../services/invoiceTypeService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * FINAL-INVOICE-CANCELLATION-UI-01A — die sichtbare Stornierung einer
 * Schlussrechnung.
 *
 * Confirm-first, und zwar in der strengsten Auslegung: Der Klick auf die
 * Aktion storniert nichts. Er öffnet diesen Dialog, der zeigt, **welche**
 * Rechnung betroffen ist, verlangt einen selbst formulierten Grund und
 * storniert erst nach einer zweiten, ausdrücklichen Bestätigung.
 *
 * Der Dialog folgt dem vorhandenen Muster von `InvoicePaymentForm`
 * (`vorgang-dialog-backdrop` + `role="dialog"`), damit keine zweite
 * Dialoginfrastruktur entsteht.
 *
 * Er entscheidet nichts selbst: Die fachliche Prüfung liegt beim Server
 * (`cancel_workspace_invoice`), die lokalen Hinweise sind Vorwarnung, nicht
 * Schutz.
 */

interface Props {
  vorgangId: string;
  invoice: VorgangInvoice;
  open: boolean;
  onClose: () => void;
  onCancelled: (invoice: VorgangInvoice) => void;
  translate: (key: TranslationKey) => string;
}

/** Serverantwort → Satz, den ein Mensch versteht. Kein technischer Code. */
const REASON_MESSAGE_KEYS: Record<CancelInvoiceFailureReason, TranslationKey> = {
  has_active_payments: 'invoice.cancel.error.activePayments',
  type_not_supported: 'invoice.cancel.error.typeNotSupported',
  not_finalized: 'invoice.cancel.error.notFinalized',
  reason_required: 'invoice.cancel.error.reasonRequired',
  not_found: 'invoice.cancel.error.notFound',
  forbidden: 'invoice.cancel.error.forbidden',
  offline: 'invoice.cancel.error.offline',
  workspace_missing: 'invoice.cancel.error.workspaceMissing',
  local_persist_failed: 'invoice.cancel.error.localPersistFailed',
  unknown: 'invoice.cancel.error.unknown',
};

/**
 * Nach diesen Ausgängen hat die Cloud die Rechnung bereits storniert — nur der
 * lokale Nachtrag fehlt. Ein zweiter Stornoversuch wäre hier das Gefährlichste,
 * was die Oberfläche tun könnte: Der Nutzer sähe einen Fehler und würde eine
 * Handlung wiederholen, die längst stattgefunden hat. Deshalb wird die Aktion
 * gesperrt und stattdessen zum Neuladen geraten.
 */
const CLOUD_ALREADY_APPLIED: ReadonlySet<CancelInvoiceFailureReason> = new Set([
  'local_persist_failed',
]);

export function InvoiceCancelDialog({
  vorgangId,
  invoice,
  open,
  onClose,
  onCancelled,
  translate,
}: Props) {
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [locked, setLocked] = useState(false);
  /*
   * Die Sperre gegen Doppelabsenden liegt in einem Ref, nicht im State.
   * `setBusy(true)` wirkt erst beim nächsten Render — drei Absendungen im
   * selben Tick sähen alle `busy === false` und lösten drei Stornoversuche
   * aus. Gemessen: genau das passierte, bevor diese Zeile hier stand.
   */
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    /*
     * Der Grund wird bewusst **nicht** vorbelegt. Ein vorausgefüllter
     * Standardsatz wäre eine erfundene Begründung — und sie stünde dauerhaft
     * in der Buchhaltung.
     */
    setReason('');
    setReasonTouched(false);
    setBusy(false);
    setErrorKey(null);
    setLocked(false);
    inFlight.current = false;
  }, [open, invoice.id]);

  if (!open) return null;

  const trimmedReason = reason.trim();
  const reasonMissing = trimmedReason.length === 0;
  const hasLocalPayments = getInvoicePayments(invoice).length > 0;
  const submitDisabled = busy || locked || reasonMissing || hasLocalPayments;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setReasonTouched(true);
    if (reasonMissing) {
      setErrorKey('invoice.cancel.error.reasonRequired');
      return;
    }
    /* Doppelklick und Doppelabsenden laufen ins Leere, nicht in einen zweiten Storno. */
    if (inFlight.current || busy || locked) return;

    inFlight.current = true;
    setBusy(true);
    setErrorKey(null);

    const result = await cancelFinalizedInvoice({
      vorgangId,
      invoiceId: invoice.id,
      reason: trimmedReason,
    });

    if (!result.ok) {
      setErrorKey(REASON_MESSAGE_KEYS[result.reason]);
      /*
       * Freigeben, damit der Nutzer es nach einem behebbaren Fehler erneut
       * versuchen kann — ausser die Cloud hat bereits storniert. Dann bleibt
       * gesperrt, was gesperrt gehört.
       */
      if (CLOUD_ALREADY_APPLIED.has(result.reason)) {
        setLocked(true);
      } else {
        inFlight.current = false;
      }
      setBusy(false);
      return;
    }

    /*
     * Der lokale Stand ist zu diesem Zeitpunkt bereits aus dem autoritativen
     * Serverergebnis nachgeführt (`applyInvoiceCancellationFromCloud`). Die
     * Ansicht liest ihn frisch, statt einen optimistischen Zustand zu bauen.
     */
    const { getVorgangInvoice } = await import('../../services/vorgangService');
    const updated = getVorgangInvoice(vorgangId, invoice.id);
    setBusy(false);
    if (updated) onCancelled(updated);
    onClose();
  };

  const documentTitle = getInvoiceDocumentTitle(invoice.type, invoice.abschlagNumber);
  const invoiceDate = invoice.issueDate ?? invoice.date;

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog invoice-cancel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-cancel-dialog-title"
        data-testid="invoice-cancel-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="invoice-cancel-dialog-title" className="vorgang-dialog__title">
          {translate('invoice.cancel.title')}
        </h3>

        {/*
          * Welche Rechnung — bevor irgendetwas bestätigt werden kann.
          * Bewusst mit dem vorhandenen `data-row`-Markup statt eigener CSS:
          * Der Dialog soll aussehen wie der Rest des Produkts.
          */}
        <div data-testid="invoice-cancel-facts">
          <div className="data-row" data-testid="invoice-cancel-number">
            <span className="data-row__label">{translate('invoice.number')}</span>
            <span className="data-row__value">{invoice.number}</span>
          </div>
          <div className="data-row" data-testid="invoice-cancel-type">
            <span className="data-row__label">{translate('invoice.typeLabel')}</span>
            <span className="data-row__value">{documentTitle}</span>
          </div>
          {invoiceDate ? (
            <div className="data-row" data-testid="invoice-cancel-date">
              <span className="data-row__label">{translate('invoice.issueDate')}</span>
              <span className="data-row__value">{invoiceDate}</span>
            </div>
          ) : null}
          <div className="data-row" data-testid="invoice-cancel-amount">
            <span className="data-row__label">{translate('invoice.grossAmount')}</span>
            <span className="data-row__value">{formatPaymentCurrency(invoice.amount)}</span>
          </div>
        </div>

        <p className="invoice-cancel-dialog__notice" data-testid="invoice-cancel-notice">
          {translate('invoice.cancel.notice')}
        </p>

        {hasLocalPayments ? (
          <p className="invoice-payment-form__warning" data-testid="invoice-cancel-payment-block">
            {translate('invoice.cancel.error.activePayments')}
          </p>
        ) : null}

        <label className="invoice-payment-form__field">
          <span>{translate('invoice.cancel.reasonLabel')}</span>
          <textarea
            className="input invoice-payment-form__textarea"
            rows={3}
            value={reason}
            disabled={busy || locked}
            required
            data-testid="invoice-cancel-reason-input"
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setReasonTouched(true)}
          />
        </label>
        {reasonTouched && reasonMissing ? (
          <p className="invoice-payment-form__error" data-testid="invoice-cancel-reason-error">
            {translate('invoice.cancel.error.reasonRequired')}
          </p>
        ) : null}

        {errorKey ? (
          <p className="invoice-payment-form__error" data-testid="invoice-cancel-error">
            {translate(errorKey)}
          </p>
        ) : null}

        <div className="vorgang-dialog__actions">
          <Button
            type="submit"
            variant="danger"
            fullWidth
            loading={busy}
            disabled={submitDisabled}
            data-testid="invoice-cancel-submit"
          >
            {translate('invoice.cancel.confirm')}
          </Button>
          <Button
            type="button"
            variant="outline"
            fullWidth
            disabled={busy}
            onClick={onClose}
            data-testid="invoice-cancel-abort"
          >
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
