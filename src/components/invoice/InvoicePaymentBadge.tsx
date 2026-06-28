import type { InvoicePaymentStatus } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  status: InvoicePaymentStatus;
  translate: (key: TranslationKey) => string;
}

const STATUS_CLASS: Record<InvoicePaymentStatus, string> = {
  offen: 'invoice-payment-badge--offen',
  teilbezahlt: 'invoice-payment-badge--teilbezahlt',
  bezahlt: 'invoice-payment-badge--bezahlt',
  ueberfaellig: 'invoice-payment-badge--ueberfaellig',
  storniert: 'invoice-payment-badge--storniert',
};

export function InvoicePaymentBadge({ status, translate }: Props) {
  const labelKey = `payment.status.${status}` as TranslationKey;

  return (
    <span className={`invoice-payment-badge ${STATUS_CLASS[status]}`}>
      {translate(labelKey)}
    </span>
  );
}

export function getPaymentBadgeClass(status: InvoicePaymentStatus): string {
  return STATUS_CLASS[status];
}
