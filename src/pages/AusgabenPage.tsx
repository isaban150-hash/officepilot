import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useApp } from '../context/AppContext';
import {
  EXPENSE_CATEGORIES,
  getAllExpenses,
  getExpenseSummary,
  searchExpenses,
} from '../services/expenseService';
import type { ExpenseCategory } from '../types/expense';
import type { TranslationKey } from '../i18n';

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

function formatEuro(amount: number): string {
  return `${amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function AusgabenPage() {
  const { translate } = useApp();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ExpenseCategory | 'all'>('all');
  const [expenses, setExpenses] = useState(getAllExpenses);
  const summary = useMemo(() => getExpenseSummary(), [expenses]);

  useEffect(() => {
    setExpenses(getAllExpenses());
  }, [location.pathname, location.key]);

  const filtered = useMemo(
    () => searchExpenses(query, category),
    [query, category, expenses],
  );

  return (
    <div className="page">
      <PageHeader title={translate('expense.title')} subtitle={translate('expense.subtitle')} />

      <Card className="expense-summary-card">
        <CardMeta>
          {translate('expense.summaryCount').replace('{count}', String(summary.totalCount))} ·{' '}
          {translate('expense.summaryTotal').replace('{amount}', formatEuro(summary.totalGrossAmount))}
        </CardMeta>
      </Card>

      <div className="page-header__actions">
        <Link to="/ausgaben/neu">
          <Button variant="primary" fullWidth>
            {translate('expense.add')}
          </Button>
        </Link>
      </div>

      <div className="document-toolbar">
        <input
          type="search"
          className="input document-search"
          placeholder={translate('expense.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={translate('expense.searchPlaceholder')}
        />
      </div>

      <div className="chip-group document-categories">
        <button
          type="button"
          className={`chip ${category === 'all' ? 'chip--active' : ''}`}
          onClick={() => setCategory('all')}
        >
          {translate('expense.categoryAll')}
        </button>
        {EXPENSE_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className={`chip ${category === cat ? 'chip--active' : ''}`}
            onClick={() => setCategory(cat)}
          >
            {translate(`expense.category.${cat}` as TranslationKey)}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="empty-state">{translate('expense.empty')}</p>
      ) : (
        <div className="card-list">
          {filtered.map((expense) => {
            const categoryKey = `expense.category.${expense.category}` as TranslationKey;
            const statusKey = `expense.status.${expense.status}` as TranslationKey;
            return (
              <Link key={expense.id} to={`/ausgaben/${expense.id}`} className="card-link">
                <Card>
                  <CardTitle>{expense.title}</CardTitle>
                  <CardMeta>
                    {expense.supplierName}
                    {expense.invoiceNumber ? ` · ${expense.invoiceNumber}` : ''} ·{' '}
                    {formatDate(expense.issueDate)}
                  </CardMeta>
                  <div className="badge-row">
                    <Badge tone="info">{translate(categoryKey)}</Badge>
                    <Badge>{translate(statusKey)}</Badge>
                    <Badge tone="warning">{formatEuro(expense.grossAmount)}</Badge>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
