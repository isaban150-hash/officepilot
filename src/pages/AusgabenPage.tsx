import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PageHeader, StatusBadge } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { DateDisplay, MoneyDisplay } from '../components/ui/Display';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { FilterChips, SearchField } from '../components/ui/Toolbar';
import { useApp } from '../context/AppContext';
import {
  EXPENSE_CATEGORIES,
  getAllExpenses,
  getExpenseSummary,
  searchExpenses,
} from '../services/expenseService';
import { expenseStatusTone } from '../services/ui/statusTone';
import { formatEuroAmount } from '../utils/displayFormat';
import type { ExpenseCategory } from '../types/expense';
import type { TranslationKey } from '../i18n';

/**
 * UIUX-FOUNDATION-01D — repräsentative Business-Liste.
 *
 * Vorher: Kartenwand mit drei Badges pro Karte (Kategorie, Status, Betrag).
 * Jetzt: PageHeader + Toolbar (Suche, Kategorie-Chips) + `BusinessList`:
 * Identität (Titel, Lieferant · Nummer), Datum, Status, Betrag — eine
 * klickbare Zeile. Fachlogik (Suche, Summen, Kategorien) unverändert.
 */
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

  const categoryOptions = useMemo(
    () => [
      { id: 'all' as const, label: translate('expense.categoryAll') },
      ...EXPENSE_CATEGORIES.map((cat) => ({ id: cat, label: translate(`expense.category.${cat}` as TranslationKey) })),
    ],
    [translate],
  );

  return (
    <Page testId="ausgaben-page">
      <PageHeader
        title={translate('expense.title')}
        subtitle={
          <>
            {translate('expense.subtitle')}
            <span className="page-header__summary" data-testid="ausgaben-summary">
              {' · '}
              {translate('expense.summaryCount').replace('{count}', String(summary.totalCount))} ·{' '}
              {translate('expense.summaryTotal').replace('{amount}', formatEuroAmount(summary.totalGrossAmount))}
            </span>
          </>
        }
        primaryAction={
          <Link to="/ausgaben/neu">
            <Button variant="primary" fullWidth>
              {translate('expense.add')}
            </Button>
          </Link>
        }
        secondaryAction={
          <Link to="/ausgaben/offen">
            <Button variant="outline" fullWidth>
              {translate('expense.openLiabilities')}
            </Button>
          </Link>
        }
      />

      <PageToolbar
        search={
          <SearchField
            label={translate('expense.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            testId="ausgaben-search"
          />
        }
        filters={
          <FilterChips
            options={categoryOptions}
            value={category}
            onChange={setCategory}
            label={translate('expense.categoryAll')}
            testIdPrefix="ausgaben-category"
          />
        }
      />

      {filtered.length === 0 ? (
        <EmptyStateBlock
          title={translate('expense.empty')}
          description=""
          testId="ausgaben-empty"
        />
      ) : (
        <BusinessList testId="ausgaben-list" ariaLabel={translate('expense.title')}>
          {filtered.map((expense) => {
            const categoryKey = `expense.category.${expense.category}` as TranslationKey;
            const statusKey = `expense.status.${expense.status}` as TranslationKey;
            return (
              <BusinessListItem
                key={expense.id}
                to={`/ausgaben/${expense.id}`}
                title={expense.title}
                subtitle={`${expense.supplierName}${expense.invoiceNumber ? ` · ${expense.invoiceNumber}` : ''}`}
                meta={translate(categoryKey)}
                date={<DateDisplay value={expense.issueDate} />}
                status={<StatusBadge tone={expenseStatusTone(expense.status)} label={translate(statusKey)} icon={false} />}
                amount={<MoneyDisplay value={expense.grossAmount} />}
                testId={`ausgaben-row-${expense.id}`}
              />
            );
          })}
        </BusinessList>
      )}
    </Page>
  );
}
