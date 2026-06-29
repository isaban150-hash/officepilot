import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import { ExpensePaymentForm } from './ExpensePaymentForm';
import { getExpensePaymentSavedToastKey } from './ExpensePaymentSummary';
import { ExpensePaymentBadge } from './ExpensePaymentBadge';
import {
  calculateExpensePaymentSummary,
  formatPaymentCurrency,
  isExpenseCancelled,
  isExpensePayable,
} from '../../services/expensePaymentService';
import type { ExpenseOverviewItem } from '../../types/expense';
import type { Expense } from '../../types/expense';
import type { TranslationKey } from '../../i18n';

interface Props {
  item: ExpenseOverviewItem;
  translate: (key: TranslationKey) => string;
  onExpenseUpdated?: (item: ExpenseOverviewItem) => void;
  onPaymentToast?: (message: string) => void;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

export function ExpenseOverviewCard({
  item,
  translate,
  onExpenseUpdated,
  onPaymentToast,
}: Props) {
  const navigate = useNavigate();
  const [currentItem, setCurrentItem] = useState(item);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const { expense, paymentSummary } = currentItem;

  useEffect(() => {
    setCurrentItem(item);
  }, [item]);

  const openExpense = () => {
    navigate(`/ausgaben/${expense.id}?from=overview`);
  };

  const handlePaymentSaved = (updated: Expense) => {
    const nextItem: ExpenseOverviewItem = {
      expense: updated,
      paymentSummary: calculateExpensePaymentSummary(updated),
    };
    setCurrentItem(nextItem);
    onExpenseUpdated?.(nextItem);
    onPaymentToast?.(translate(getExpensePaymentSavedToastKey(updated)));
  };

  const categoryKey = `expense.category.${expense.category}` as TranslationKey;

  return (
    <>
      <Card className="invoice-overview-card">
        <CardTitle>{expense.title}</CardTitle>
        <CardMeta>
          {expense.supplierName}
          {expense.invoiceNumber ? ` · ${expense.invoiceNumber}` : ''}
        </CardMeta>
        <CardMeta>{translate(categoryKey)}</CardMeta>

        <DataRow label={translate('expense.fieldIssueDate')} value={formatDate(expense.issueDate)} />
        <DataRow
          label={translate('expense.fieldDueDate')}
          value={formatDate(expense.paymentDueDate)}
        />
        <DataRow
          label={translate('payment.totalDue')}
          value={formatPaymentCurrency(paymentSummary.totalDue)}
        />
        <DataRow
          label={translate('payment.paidAmount')}
          value={formatPaymentCurrency(paymentSummary.paidAmount)}
        />
        <DataRow
          label={translate('payment.openAmount')}
          value={formatPaymentCurrency(paymentSummary.openAmount)}
        />
        <DataRow
          label={translate('expense.fieldBookingStatus')}
          value={translate(`expense.status.${expense.status}` as TranslationKey)}
        />
        <DataRow
          label={translate('payment.paymentStatus')}
          value={<ExpensePaymentBadge status={paymentSummary.status} translate={translate} />}
        />

        <div className="invoice-overview-card__actions">
          <Button type="button" onClick={openExpense}>
            {translate('expense.open')}
          </Button>
          {isExpensePayable(expense) && !isExpenseCancelled(expense) && (
            <Button type="button" variant="outline" onClick={() => setShowPaymentForm(true)}>
              {translate('payment.recordShort')}
            </Button>
          )}
          {expense.archiveDocumentId && (
            <Link to={`/dokumente/${expense.archiveDocumentId}`}>
              <Button type="button" variant="outline">
                {translate('expenseOverview.archive')}
              </Button>
            </Link>
          )}
        </div>
      </Card>

      <ExpensePaymentForm
        expense={expense}
        open={showPaymentForm}
        onClose={() => setShowPaymentForm(false)}
        onSaved={handlePaymentSaved}
        translate={translate}
      />
    </>
  );
}
