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
  onSecurePayment?: (paymentId: string) => void;
}

export function InvoicePaymentHistory({
  invoice,
  translate,
  onRemovePayment,
  allowRemove = true,
  unsyncedPaymentIds,
  onSecurePayment,
}: Props) {
  /* UIUX-FOUNDATION-01G — Confirm-first über den kanonischen Dialog statt window.confirm. */
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const unsynced = new Set(unsyncedPaymentIds ?? []);
  const payments = [...getInvoicePayments(invoice)].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  if (payments.length === 0) {
    return (
      <section className="invoice-payment-history">
        <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
        <p className="invoice-payment-history__empty">{translate('payment.historyEmpty')}</p>
      </section>
    );
  }

  return (
    <section className="invoice-payment-history">
      <h3 className="invoice-payment-history__title">{translate('payment.historyTitle')}</h3>
      <BusinessList className="invoice-payment-history__list">
        {payments.map((payment) => (
          <BusinessListItem
            key={payment.id}
            className="invoice-payment-history__item"
            title={<DateDisplay value={payment.date} />}
            amount={<MoneyDisplay value={payment.amount} />}
            subtitle={payment.reference ? `${translate('payment.reference')}: ${payment.reference}` : undefined}
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
            {allowRemove && onRemovePayment && (
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
      {(() => {
        const pending = payments.find((entry) => entry.id === pendingRemoveId);
        return (
          <SimpleConfirmDialog
            open={Boolean(pending)}
            title={translate('payment.remove')}
            message={pending ? `${translate('payment.removeConfirm')} ${formatDisplayDate(pending.date)} · ${formatEuroAmount(pending.amount)}` : translate('payment.removeConfirm')}
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
