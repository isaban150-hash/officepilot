import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { KpiRow, KpiTile } from '../ui/Kpi';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { StatusBadge } from '../ui/Badge';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { getOrderCostSummary, type OrderCostEntry } from '../../services/order/orderCostService';
import type { TranslationKey } from '../../i18n';

/**
 * ORDER-COST-ALLOCATION-01B — „Was hat der Auftrag gekostet?"
 *
 * Drei Zahlen, eine Liste, ein ehrlicher Satz. „Verbleibt" ist bewusst **kein**
 * Deckungsbeitrag: Arbeitszeit und Löhne erfasst OfficeTakt (noch) nicht, und
 * die Oberfläche behauptet keine Kennzahl, die die Daten nicht tragen.
 * Stornierte Belege bleiben als Historie sichtbar, zählen aber nie mit.
 */
interface Props {
  vorgangId: string;
  translate: (key: TranslationKey) => string;
  /** Anzeige-Revision: erneutes Lesen nach Änderungen an Ausgaben. */
  revision?: number;
}

function entryRow(
  entry: OrderCostEntry,
  translate: (key: TranslationKey) => string,
  cancelled: boolean,
) {
  return (
    <BusinessListItem
      key={entry.expenseId}
      testId={cancelled ? 'vorgang-cost-entry-cancelled' : 'vorgang-cost-entry'}
      title={entry.title}
      subtitle={
        <>
          {entry.supplierName}
          {' · '}
          {translate(`expense.category.${entry.category}` as TranslationKey)}
        </>
      }
      status={
        cancelled ? (
          <StatusBadge tone="neutral" label={translate('expense.status.storniert')} icon={false} />
        ) : undefined
      }
      date={<DateDisplay value={entry.issueDate} />}
      amount={<MoneyDisplay value={entry.allocatedNet} emphasis={!cancelled} />}
      to={`/ausgaben/${entry.expenseId}`}
      linkTestId="vorgang-cost-entry-link"
    />
  );
}

export function VorgangCostPanel({ vorgangId, translate, revision = 0 }: Props) {
  const summary = useMemo(() => getOrderCostSummary(vorgangId), [vorgangId, revision]);
  if (!summary) return null;

  return (
    <section className="section vorgang-cost-section" data-testid="vorgang-cost-section">
      <h2 className="section__title">{translate('vorgang.cost.title')}</h2>

      <KpiRow testId="vorgang-cost-kpis" ariaLabel={translate('vorgang.cost.title')} className="work-kpis">
        <KpiTile
          label={translate('vorgang.cost.billed')}
          value={<MoneyDisplay value={summary.billedNet} />}
          testId="vorgang-cost-billed"
        />
        <KpiTile
          label={translate('vorgang.cost.allocated')}
          value={<MoneyDisplay value={summary.allocatedCostNet} />}
          testId="vorgang-cost-allocated"
        />
        <KpiTile
          label={translate('vorgang.cost.remaining')}
          value={<MoneyDisplay value={summary.remainingNet} />}
          tone={summary.remainingNet < 0 ? 'critical' : 'positive'}
          testId="vorgang-cost-remaining"
        />
      </KpiRow>

      <p className="hint-text" data-testid="vorgang-cost-hint">
        {translate('vorgang.cost.hint')}
      </p>

      {summary.entries.length === 0 ? (
        <p className="hint-text" data-testid="vorgang-cost-empty">
          {translate('vorgang.cost.empty')}
        </p>
      ) : (
        <BusinessList testId="vorgang-cost-list" ariaLabel={translate('vorgang.cost.listTitle')}>
          {summary.entries.map((entry) => entryRow(entry, translate, false))}
        </BusinessList>
      )}

      {summary.cancelledEntries.length > 0 ? (
        <>
          <h3 className="section__title" data-testid="vorgang-cost-cancelled-title">
            {translate('vorgang.cost.cancelledTitle')}
          </h3>
          <BusinessList testId="vorgang-cost-cancelled-list" ariaLabel={translate('vorgang.cost.cancelledTitle')}>
            {summary.cancelledEntries.map((entry) => entryRow(entry, translate, true))}
          </BusinessList>
        </>
      ) : null}

      <p className="hint-text">
        <Link to="/ausgaben" data-testid="vorgang-cost-open-expenses">
          {translate('expense.title')}
        </Link>
      </p>
    </section>
  );
}
