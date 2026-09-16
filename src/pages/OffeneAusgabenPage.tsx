import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ExpenseOverviewCard } from '../components/expenses/ExpenseOverviewCard';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { KpiRow, KpiTile } from '../components/ui/Kpi';
import { MoneyDisplay } from '../components/ui/Display';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { BusinessList } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { InlineNotice } from '../components/ui/States';
import { FilterChips, SearchField } from '../components/ui/Toolbar';
import { useApp } from '../context/AppContext';
import {
  applyExpenseOverviewFilters,
  getAllExpenseOverview,
  summarizeExpenseOverview,
  type ExpenseOverviewFilter,
} from '../services/expenseOverviewService';
import type { ExpenseOverviewItem } from '../types/expense';
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

  const filterOptions = FILTER_OPTIONS.map((option) => ({ id: option, label: translate(`expenseOverview.filter.${option}` as TranslationKey) }));

  /* UIUX-FOUNDATION-01F — dieselbe Struktur wie die Rechnungsübersicht. */
  return (
    <Page testId="offene-ausgaben-page">
      <PageHeader
        title={translate('expenseOverview.title')}
        subtitle={translate('expenseOverview.subtitle')}
        backLabel={translate('common.back')}
        backHref="/ausgaben"
        backTestId="offene-ausgaben-back"
      />

      {totals.overdueExpenseCount > 0 && (
        <InlineNotice tone="warning" testId="offene-ausgaben-overdue-notice">
          {translate('expenseOverview.overdueWarning').replace('{count}', String(totals.overdueExpenseCount))}
        </InlineNotice>
      )}
      {totals.totalExpenseCount > 0 && totals.openExpenseCount === 0 && (
        <InlineNotice tone="success" testId="offene-ausgaben-allpaid-notice">
          {translate('expenseOverview.allPaid')}
        </InlineNotice>
      )}

      {/* VISUAL-POLISH-01C — Zahlungssituation als Kennzahlenfläche (Kpi-Primitives aus Block A). */}
      <KpiRow testId="offene-ausgaben-summary" ariaLabel={translate('invoices.list.summaryTitle')} className="work-kpis work-kpis--4">
        <KpiTile
          label={translate('expenseOverview.openLiabilities')}
          value={<MoneyDisplay value={totals.openLiabilities} />}
          hint={`${translate('expenseOverview.openExpenseCount')}: ${totals.openExpenseCount}`}
          testId="offene-ausgaben-kpi-open"
        />
        <KpiTile
          label={translate('expenseOverview.overdueLiabilities')}
          value={<MoneyDisplay value={totals.overdueLiabilities} />}
          tone={totals.overdueExpenseCount > 0 ? 'critical' : 'neutral'}
          testId="offene-ausgaben-kpi-overdue"
        />
        <KpiTile
          label={translate('expenseOverview.paidTotal')}
          value={<MoneyDisplay value={totals.paidTotal} />}
          tone="positive"
          testId="offene-ausgaben-kpi-paid"
        />
        <KpiTile
          label={translate('expenseOverview.totalExpenseCount')}
          value={String(totals.totalExpenseCount)}
          testId="offene-ausgaben-kpi-total"
        />
      </KpiRow>

      <PageToolbar
        search={
          <SearchField
            label={translate('expenseOverview.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            testId="offene-ausgaben-search"
          />
        }
        filters={<FilterChips options={filterOptions} value={filter} onChange={setFilter} label={translate('list.filter.label')} testIdPrefix="offene-ausgaben-filter" />}
      />

      {filteredItems.length === 0 ? (
        <EmptyStateBlock title={translate('expenseOverview.empty')} description="" testId="offene-ausgaben-empty" />
      ) : (
        <BusinessList testId="offene-ausgaben-list" ariaLabel={translate('expenseOverview.title')}>
          {filteredItems.map((item) => (
            <ExpenseOverviewCard
              key={item.expense.id}
              item={item}
              translate={translate}
              onExpenseUpdated={refreshItems}
              onPaymentToast={showToast}
            />
          ))}
        </BusinessList>
      )}

      <div className="detail-actions">
        <Link to="/ausgaben">
          <Button variant="outline">{translate('expenseOverview.backToAusgaben')}</Button>
        </Link>
      </div>
    </Page>
  );
}
