import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ExpenseOverviewCard } from '../components/expenses/ExpenseOverviewCard';
import { Button } from '../components/ui/Button';
import { Card, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  applyExpenseOverviewFilters,
  getAllExpenseOverview,
  summarizeExpenseOverview,
  type ExpenseOverviewFilter,
} from '../services/expenseOverviewService';
import type { ExpenseOverviewItem } from '../types/expense';
import { formatPaymentCurrency } from '../services/expensePaymentService';
import type { TranslationKey } from '../i18n';

const FILTER_OPTIONS: ExpenseOverviewFilter[] = [
  'all',
  'offen',
  'teilbezahlt',
  'ueberfaellig',
  'bezahlt',
  'storniert',
];

export function OffeneAusgabenPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<ExpenseOverviewItem[]>(() => getAllExpenseOverview());
  const [filter, setFilter] = useState<ExpenseOverviewFilter>('all');
  const [query, setQuery] = useState('');

  const refreshItems = () => {
    setItems(getAllExpenseOverview());
  };

  useEffect(() => {
    refreshItems();
  }, [location.pathname, location.key]);

  const totals = useMemo(() => summarizeExpenseOverview(items), [items]);

  const filteredItems = useMemo(
    () => applyExpenseOverviewFilters(items, filter, query),
    [items, filter, query],
  );

  return (
    <div className="page">
      <PageHeader
        title={translate('expenseOverview.title')}
        subtitle={translate('expenseOverview.subtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/ausgaben')}
      />

      {totals.overdueExpenseCount > 0 && (
        <p className="invoice-hint invoice-hint--warning">
          {translate('expenseOverview.overdueWarning').replace(
            '{count}',
            String(totals.overdueExpenseCount),
          )}
        </p>
      )}

      {totals.totalExpenseCount > 0 && totals.openExpenseCount === 0 && (
        <p className="invoice-hint invoice-hint--success">{translate('expenseOverview.allPaid')}</p>
      )}

      <section className="overview-kpi-grid">
        <Card className="overview-kpi-card">
          <p className="overview-kpi-card__label">{translate('expenseOverview.openLiabilities')}</p>
          <p className="overview-kpi-card__value">
            {formatPaymentCurrency(totals.openLiabilities)}
          </p>
        </Card>
        <Card className="overview-kpi-card overview-kpi-card--danger">
          <p className="overview-kpi-card__label">{translate('expenseOverview.overdueLiabilities')}</p>
          <p className="overview-kpi-card__value">
            {formatPaymentCurrency(totals.overdueLiabilities)}
          </p>
        </Card>
        <Card className="overview-kpi-card overview-kpi-card--success">
          <p className="overview-kpi-card__label">{translate('expenseOverview.paidTotal')}</p>
          <p className="overview-kpi-card__value">{formatPaymentCurrency(totals.paidTotal)}</p>
        </Card>
        <Card className="overview-kpi-card">
          <p className="overview-kpi-card__label">{translate('expenseOverview.openExpenseCount')}</p>
          <p className="overview-kpi-card__value">{totals.openExpenseCount}</p>
        </Card>
      </section>

      <Card className="overview-meta-card">
        <DataRow
          label={translate('expenseOverview.totalExpenseCount')}
          value={String(totals.totalExpenseCount)}
        />
      </Card>

      <div className="document-toolbar">
        <input
          type="search"
          className="input document-search"
          placeholder={translate('expenseOverview.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={translate('expenseOverview.searchPlaceholder')}
        />
      </div>

      <div className="chip-group overview-filters">
        {FILTER_OPTIONS.map((option) => {
          const key = `expenseOverview.filter.${option}` as TranslationKey;
          return (
            <button
              key={option}
              type="button"
              className={`chip ${filter === option ? 'chip--active' : ''}`}
              onClick={() => setFilter(option)}
            >
              {translate(key)}
            </button>
          );
        })}
      </div>

      {filteredItems.length === 0 ? (
        <p className="empty-state">{translate('expenseOverview.empty')}</p>
      ) : (
        <div className="card-list">
          {filteredItems.map((item) => (
            <ExpenseOverviewCard
              key={item.expense.id}
              item={item}
              translate={translate}
              onExpenseUpdated={refreshItems}
              onPaymentToast={showToast}
            />
          ))}
        </div>
      )}

      <div className="page-header__actions">
        <Link to="/ausgaben">
          <Button variant="outline" fullWidth>
            {translate('expenseOverview.backToAusgaben')}
          </Button>
        </Link>
      </div>
    </div>
  );
}
