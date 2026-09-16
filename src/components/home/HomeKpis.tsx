import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { getInboxSummary } from '../../services/inboxService';
import { getAllInvoiceOverview, summarizeInvoiceOverview } from '../../services/invoiceOverviewService';
import { getSteuerberaterMonthOverview } from '../../services/steuerberaterOverviewService';
import { getAllVorgaenge } from '../../services/vorgangService';
import { formatInvoiceCurrency } from '../../services/invoicePrintModel';
import { KpiRow, KpiTile } from '../ui/Kpi';
import { RowList, RowListItem } from '../ui/Lists';
import { StatusBadge } from '../ui/Badge';
import { NavIcon } from '../layout/NavIcon';

/**
 * VISUAL-POLISH-01B — „Ihr Betrieb heute": vier Kennzahlen aus den vorhandenen
 * Services (keine neue Aggregation) plus die Steuerberater-Zeile mit dem
 * kanonischen Monatsstatus aus REAL-PRODUCT-TEST-01B. Ersetzt die frühere
 * Steuerberater-Zeile in „Offene Arbeit" (keine Dublette).
 */
export function HomeKpis() {
  const { translate, language } = useApp();
  const inbox = useMemo(() => getInboxSummary(), []);
  const activeOrders = useMemo(() => getAllVorgaenge().filter((v) => v.status !== 'abgeschlossen').length, []);
  const invoices = useMemo(() => summarizeInvoiceOverview(getAllInvoiceOverview()), []);
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const tax = useMemo(() => getSteuerberaterMonthOverview(new Date(), locale), [locale]);
  const monthShort = tax.monthLabel.split(' ')[0] ?? tax.monthLabel;

  const taxStatus =
    tax.state === 'empty'
      ? translate('mobile.home.taxEmpty')
      : tax.state === 'ready'
        ? translate('mobile.home.taxComplete')
        : tax.openCount === 1
          ? translate('mobile.home.taxOpenOne')
          : translate('mobile.home.taxOpen').replace('{count}', String(tax.openCount));

  return (
    <div className="home-kpis" data-testid="home-kpis">
      <KpiRow ariaLabel={translate('heute.section.kpis')}>
        <KpiTile
          to="/rechnungen/offen"
          label={translate('heute.kpi.openReceivables')}
          value={formatInvoiceCurrency(invoices.openReceivables)}
          hint={
            invoices.overdueInvoiceCount > 0
              ? translate('heute.kpi.overdueHint').replace('{count}', String(invoices.overdueInvoiceCount))
              : translate('heute.kpi.openInvoicesHint').replace('{count}', String(invoices.openInvoiceCount))
          }
          tone={invoices.overdueInvoiceCount > 0 ? 'critical' : 'neutral'}
          testId="home-kpi-receivables"
        />
        <KpiTile
          to="/ablage"
          label={translate('heute.kpi.inbox')}
          value={inbox.neu}
          hint={inbox.urgent > 0 ? `${inbox.urgent} ${translate('ablage.urgentCount')}` : translate('heute.kpi.inboxHint')}
          tone={inbox.urgent > 0 ? 'warning' : 'neutral'}
          testId="home-kpi-inbox"
        />
        <KpiTile
          to="/vorgaenge"
          label={translate('heute.kpi.orders')}
          value={activeOrders}
          hint={translate('heute.kpi.ordersHint')}
          testId="home-kpi-orders"
        />
        <KpiTile
          to="/steuerberater"
          label={translate('heute.kpi.tax')}
          value={`${tax.completenessPercent} %`}
          hint={monthShort}
          progress={tax.completenessPercent}
          tone={tax.state === 'ready' ? 'positive' : 'neutral'}
          testId="home-kpi-tax"
        />
      </KpiRow>
      <RowList className="home-kpis__tax">
        <RowListItem
          to="/steuerberater"
          icon={<NavIcon id="tax" />}
          title={translate('mobile.home.taxTitle')}
          description={`${monthShort} · ${taxStatus}`}
          trailing={
            <span className="home-kpis__tax-trailing">
              {tax.state === 'ready' ? (
                <StatusBadge tone="success" label={translate('steuerberater.status.complete')} icon={false} />
              ) : null}
              <span className="row-list__cta" data-testid="home-card-steuerberater-action">{translate('steuerberater.prepareFolderButton')}</span>
            </span>
          }
          testId="home-card-steuerberater"
        />
      </RowList>
    </div>
  );
}
