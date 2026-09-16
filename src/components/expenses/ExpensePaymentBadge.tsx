import { StatusBadge } from '../ui/Badge';
import { paymentStatusTone } from '../../services/ui/statusTone';
import type { ExpensePaymentStatus } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  status: ExpensePaymentStatus;
  translate: (key: TranslationKey) => string;
}

/** UIUX-FOUNDATION-01E — dieselbe Statussprache wie bei Rechnungen. */
export function ExpensePaymentBadge({ status, translate }: Props) {
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
export function getExpensePaymentBadgeClass(status: ExpensePaymentStatus): string {
  return `invoice-payment-badge--${status}`;
}
