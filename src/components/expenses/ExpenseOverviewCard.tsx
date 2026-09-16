import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { BusinessListItem } from '../ui/Lists';
import { ExpensePaymentForm } from './ExpensePaymentForm';
import { getExpensePaymentSavedToastKey } from './ExpensePaymentSummary';
import { ExpensePaymentBadge } from './ExpensePaymentBadge';
import {
  calculateExpensePaymentSummary,
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

  /* UIUX-FOUNDATION-01F — Business-Zeile wie die Rechnungsübersicht; Aktionen unverändert. */
  return (
    <>
      <BusinessListItem
        className="expense-overview-card"
        testId="expense-overview-card"
        title={expense.title}
        subtitle={`${expense.supplierName}${expense.invoiceNumber ? ` · ${expense.invoiceNumber}` : ''}`}
        meta={translate(categoryKey)}
        status={<ExpensePaymentBadge status={paymentSummary.status} translate={translate} />}
        date={
          <>
            {translate('expense.fieldDueDate')}: <DateDisplay value={expense.paymentDueDate} />
          </>
        }
        amount={<MoneyDisplay value={paymentSummary.openAmount} emphasis />}
        footer={
          <>
            <dl className="business-list__figures">
              <div>
                <dt>{translate('expense.fieldIssueDate')}</dt>
                <dd>
                  <DateDisplay value={expense.issueDate} />
                </dd>
              </div>
              <div>
                <dt>{translate('payment.totalDue')}</dt>
                <dd>
                  <MoneyDisplay value={paymentSummary.totalDue} />
                </dd>
              </div>
              <div>
                <dt>{translate('payment.paidAmount')}</dt>
                <dd>
                  <MoneyDisplay value={paymentSummary.paidAmount} />
                </dd>
              </div>
              <div>
                <dt>{translate('payment.openAmount')}</dt>
                <dd>
                  <MoneyDisplay value={paymentSummary.openAmount} />
                </dd>
              </div>
              <div>
                <dt>{translate('expense.fieldBookingStatus')}</dt>
                <dd>{translate(`expense.status.${expense.status}` as TranslationKey)}</dd>
              </div>
              <div>
                <dt>{translate('payment.paymentStatus')}</dt>
                <dd>{translate(`payment.status.${paymentSummary.status}` as TranslationKey)}</dd>
              </div>
            </dl>
            <div className="invoice-overview-card__actions">
              <Button type="button" size="sm" onClick={openExpense}>
                {translate('expense.open')}
              </Button>
              {isExpensePayable(expense) && !isExpenseCancelled(expense) && (
                <Button type="button" size="sm" variant="outline" onClick={() => setShowPaymentForm(true)}>
                  {translate('payment.recordShort')}
                </Button>
              )}
              {expense.archiveDocumentId && (
                <Link to={`/dokumente/${expense.archiveDocumentId}`}>
                  <Button type="button" size="sm" variant="outline">
                    {translate('expenseOverview.archive')}
                  </Button>
                </Link>
              )}
            </div>
          </>
        }
      />

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
