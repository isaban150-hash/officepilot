import { StatusBadge } from '../ui/Badge';
import { paymentStatusTone } from '../../services/ui/statusTone';
import type { InvoicePaymentStatus } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  status: InvoicePaymentStatus;
  translate: (key: TranslationKey) => string;
}

/**
 * UIUX-FOUNDATION-01E — Zahlungsstatus über das kanonische Statussystem
 * (`StatusBadge` + `paymentStatusTone`); keine eigenen Domain-Farben mehr.
 * Die Zusatzklasse `invoice-payment-badge` bleibt als stabiler Selektor.
 */
export function InvoicePaymentBadge({ status, translate }: Props) {
  const labelKey = `payment.status.${status}` as TranslationKey;
  return (
    <StatusBadge
      tone={paymentStatusTone(status)}
      label={translate(labelKey)}
      icon={false}
      className={`invoice-payment-badge invoice-payment-badge--${status}`}
    />
  );
}

/** @deprecated Ton kommt aus `paymentStatusTone`; nur noch für Alt-Selektoren. */
export function getPaymentBadgeClass(status: InvoicePaymentStatus): string {
  return `invoice-payment-badge--${status}`;
}
