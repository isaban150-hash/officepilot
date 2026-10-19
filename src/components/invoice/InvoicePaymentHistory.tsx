import { paymentMethodLabel } from '../payment/PaymentMethodField';
import { isPaymentFromBankReconciliation } from '../../services/bank/bankReconciliationStore';
import { useState } from 'react';
import { Button } from '../ui/Button';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';
import { formatDisplayDate, formatEuroAmount } from '../../utils/displayFormat';
import { getInvoicePayments } from '../../services/invoicePaymentService';
import type { VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { InlineNotice } from '../ui/States';
import type { InvoicePaymentResyncBlockReason } from '../../services/invoice/invoicePaymentCloudResyncService';

interface Props {
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  onRemovePayment?: (paymentId: string) => void;
  allowRemove?: boolean;
  /**
   * PAYMENT-CLOUD-CLOSURE-04B2B1 — Kennungen der Zahlungen, die nachweislich
   * noch nicht in der Cloud liegen.
   *
   * Sie darf **nur** aus einem erfolgreichen Cloud-Abgleich stammen. Bleibt sie
   * leer oder ist der Abgleich gescheitert, wird nichts behauptet: Unbekannt
   * ist nicht dasselbe wie ungesichert.
   */
  unsyncedPaymentIds?: readonly string[];
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N01) — der Server hat diese Zahlungen endgültig
   * abgewiesen; sie werden nicht automatisch erneut gesendet. Der Grund steht am Hinweis.
   */
  blockedPaymentReasons?: Readonly<Record<string, InvoicePaymentResyncBlockReason>>;
  onSecurePayment?: (paymentId: string) => void;
  /**
   * FC01A-Nacharbeit (A2) — die Zahlungen sind nicht rücknehmbar (etwa: eine wirksame
   * Schlussrechnung zieht diesen Abschlag als bezahlt ab). Statt der Aktion steht der Grund.
   */
  removeBlockedReason?: string;
  /**
   * FINANZ-CORE-01A (END18-R3) — eine fachlich abgewiesene Zahlung als Überzahlung bestätigen und erneut
   * senden (nur bei `overpayment_unconfirmed`), bzw. ihren Nachweis bewusst verwerfen.
   */
  onConfirmRejectedPayment?: (paymentId: string) => void;
  onDiscardRejectedPayment?: (paymentId: string) => void;
}

export function InvoicePaymentHistory({
  invoice,
  translate,
  onRemovePayment,
  allowRemove = true,
  unsyncedPaymentIds,
  blockedPaymentReasons,
  onSecurePayment,
  removeBlockedReason,
  onConfirmRejectedPayment,
  onDiscardRejectedPayment,
}: Props) {
  /* UIUX-FOUNDATION-01G — Confirm-first über den kanonischen Dialog statt window.confirm. */
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const unsynced = new Set(unsyncedPaymentIds ?? []);
  const payments = [...getInvoicePayments(invoice)].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  /*
   * FINANZ-CORE-01A (END18-R3) — vom Server fachlich abgewiesene Zahlungen: nicht gebucht, ohne Wirkung auf
   * Summen, Status, Mahnung und Export. Sichtbar, bis der Nutzer entscheidet.
   */
  const rejected = invoice.rejectedPayments ?? [];
  const rejectedSection =
    rejected.length > 0 ? (
      <div className="invoice-payment-history__rejected" data-testid="payment-rejected-list">
        <InlineNotice tone="warning">{translate('payment.rejected.intro')}</InlineNotice>
        {rejected.map((entry) => (
          <div key={entry.id} className="invoice-payment-history__rejected-item" data-testid={`payment-rejected-${entry.id}`}>
            <p>
              {translate('payment.rejected.item')
                .replace('{amount}', formatEuroAmount(entry.amount))
                .replace('{date}', formatDisplayDate(entry.date))
                .replace('{reason}', translate(`payment.cloudBlocked.${entry.reason}` as TranslationKey))}
            </p>
            {entry.reason === 'overpayment_unconfirmed' && onConfirmRejectedPayment ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onConfirmRejectedPayment(entry.id)}
                data-testid={`payment-rejected-confirm-${entry.id}`}
              >
                {translate('payment.rejected.confirm')}
              </Button>
            ) : null}
            {onDiscardRejectedPayment ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onDiscardRejectedPayment(entry.id)}
                data-testid={`payment-rejected-discard-${entry.id}`}
              >
                {translate('payment.rejected.discard')}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    ) : null;

  if (payments.length === 0) {
    return (
      <section className="invoice-payment-history">
        <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
        <p className="invoice-payment-history__empty">{translate('payment.historyEmpty')}</p>
        {rejectedSection}
      </section>
    );
  }

  return (
    <section className="invoice-payment-history">
      <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
      {allowRemove && onRemovePayment && removeBlockedReason && (
        <InlineNotice tone="neutral" testId="payment-remove-blocked">
          {removeBlockedReason}
        </InlineNotice>
      )}
      <BusinessList className="invoice-payment-history__list">
        {payments.map((payment) => (
          <BusinessListItem
            key={payment.id}
            className="invoice-payment-history__item"
            title={<DateDisplay value={payment.date} />}
            amount={<MoneyDisplay value={payment.amount} />}
            subtitle={
              [
                paymentMethodLabel(payment.method, translate),
                payment.reference ? `${translate('payment.reference')}: ${payment.reference}` : undefined,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            meta={payment.note || undefined}
            footer={
              <>
            {/*
              04B2B1 — Confirm-first: Der Hinweis nennt den Zustand, übertragen
              wird ausschließlich auf ausdrückliche Aktion des Nutzers.
            */}
            {unsynced.has(payment.id) && (
              <div
                className="invoice-payment-history__unsynced"
                data-testid={`payment-unsynced-${payment.id}`}
              >
                <InlineNotice tone="warning">{translate('payment.cloudNotSecured')}</InlineNotice>
                {blockedPaymentReasons?.[payment.id] ? (
                  <p
                    className="invoice-payment-history__blocked"
                    data-testid={`payment-resync-blocked-${payment.id}`}
                  >
                    {translate(`payment.cloudBlocked.${blockedPaymentReasons[payment.id]}` as TranslationKey)}
                  </p>
                ) : null}
                {onSecurePayment && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onSecurePayment(payment.id)}
                    data-testid={`payment-secure-${payment.id}`}
                  >
                    {translate('payment.cloudSecureAction')}
                  </Button>
                )}
              </div>
            )}
            {allowRemove && onRemovePayment && !removeBlockedReason && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPendingRemoveId(payment.id)}
                data-testid={`payment-remove-${payment.id}`}
              >
                {translate('payment.remove')}
              </Button>
            )}
              </>
            }
          />
        ))}
      </BusinessList>
      {rejectedSection}
      {(() => {
        const pending = payments.find((entry) => entry.id === pendingRemoveId);
        return (
          <SimpleConfirmDialog
            open={Boolean(pending)}
            title={translate('payment.remove')}
            /*
             * BLOCK 5 — stammt die Zahlung aus einer Bankzuordnung, sagt die
             * Rueckfrage, was ausserdem geschieht. Der Nutzer soll nicht
             * ueberrascht werden, dass die Bankbewegung danach wieder offen ist.
             */
            message={
              pending
                ? `${translate('payment.removeConfirm')} ${formatDisplayDate(pending.date)} · ${formatEuroAmount(pending.amount)}${
                    isPaymentFromBankReconciliation(pending.id)
                      ? ` ${translate('payment.removeBankHint')}`
                      : ''
                  }`
                : translate('payment.removeConfirm')
            }
            confirmLabel={translate('payment.remove')}
            cancelLabel={translate('common.cancel')}
            dialogTestId="payment-remove-dialog"
            confirmTestId="payment-remove-confirm"
            cancelTestId="payment-remove-cancel"
            onConfirm={() => {
              if (pending && onRemovePayment) onRemovePayment(pending.id);
              setPendingRemoveId(null);
              return true;
            }}
            onCancel={() => setPendingRemoveId(null)}
          />
        );
      })()}
    </section>
  );
}
