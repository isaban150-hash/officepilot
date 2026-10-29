import { StatusBadge } from '../ui/Badge';
import { paymentStatusTone } from '../../services/ui/statusTone';
import type { ExpensePaymentStatus } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  status: ExpensePaymentStatus;
  translate: (key: TranslationKey) => string;
  /** P1 A-04 Produktregel A — Zahlung erfasst, Steueraufteilung noch offen: „Bezahlt – Steuerprüfung offen“. */
  taxReviewOpen?: boolean;
}

/** Die Statusbezeichnung einer Ausgabe; mit offener Steuerprüfung nach einer Zahlung als Zusatz. */
export function expensePaymentStatusLabel(
  status: ExpensePaymentStatus,
  translate: (key: TranslationKey) => string,
  taxReviewOpen = false,
): string {
  const label = translate(`payment.status.${status}` as TranslationKey);
  return taxReviewOpen ? translate('expense.payment.statusTaxReviewOpen').replace('{status}', label) : label;
}

/** UIUX-FOUNDATION-01E — dieselbe Statussprache wie bei Rechnungen. */
export function ExpensePaymentBadge({ status, translate, taxReviewOpen = false }: Props) {
  return (
    <StatusBadge
      tone={taxReviewOpen ? 'warning' : paymentStatusTone(status)}
      label={expensePaymentStatusLabel(status, translate, taxReviewOpen)}
      icon={false}
      className={`invoice-payment-badge invoice-payment-badge--${status}`}
    />
  );
}

/** @deprecated Ton kommt aus `paymentStatusTone`; nur noch für Alt-Selektoren. */
export function getExpensePaymentBadgeClass(status: ExpensePaymentStatus): string {
  return `invoice-payment-badge--${status}`;
}
