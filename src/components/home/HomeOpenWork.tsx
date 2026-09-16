import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { getInboxSummary } from '../../services/inboxService';
import { getAllInvoiceOverview, summarizeInvoiceOverview } from '../../services/invoiceOverviewService';
import { getSteuerberaterMonthOverview } from '../../services/steuerberaterOverviewService';
import { getAllVorgaenge } from '../../services/vorgangService';
import { StatusBadge } from '../ui/Badge';
import { RowList, RowListItem } from '../ui/Lists';
import { NavIcon } from '../layout/NavIcon';

/**
 * UIUX-FOUNDATION-01E — „Offene Arbeit“ auf Heute: vier Zeilen mit den
 * vorhandenen Zählern (Eingang, Aufträge, Rechnungen, Steuerberater). Nur
 * bestehende Services, keine neue Aggregation.
 */
export function HomeOpenWork() {
  const { translate, language } = useApp();
  const inbox = useMemo(() => getInboxSummary(), []);
  const orderCount = useMemo(() => getAllVorgaenge().length, []);
  const invoices = useMemo(() => summarizeInvoiceOverview(getAllInvoiceOverview()), []);
  const locale = language === 'tr' ? 'tr-TR' : 'de-DE';
  const tax = useMemo(() => getSteuerberaterMonthOverview(new Date(), locale), [locale]);
  const monthShort = tax.monthLabel.split(' ')[0] ?? tax.monthLabel;

  return (
    <RowList testId="home-open-work">
      <RowListItem
        to="/ablage"
        icon={<NavIcon id="inbox" />}
        title={translate('heute.openInbox')}
        description={
          inbox.neu > 0 ? translate('heute.openInboxDesc').replace('{count}', String(inbox.neu)) : translate('heute.openInboxEmpty')
        }
        trailing={inbox.urgent > 0 ? <StatusBadge tone="warning" label={`${inbox.urgent} ${translate('ablage.urgentCount')}`} icon={false} /> : undefined}
        testId="home-card-inbox"
      />
      <RowListItem
        to="/vorgaenge"
        icon={<NavIcon id="orders" />}
        title={translate('mobile.home.ordersTitle')}
        description={
          orderCount > 0
            ? translate('mobile.home.ordersCount').replace('{count}', String(orderCount))
            : translate('mobile.home.ordersEmpty')
        }
        testId="home-card-orders"
      />
      <RowListItem
        to="/rechnungen/offen"
        icon={<NavIcon id="invoice" />}
        title={translate('heute.openInvoices')}
        description={translate('heute.openInvoicesDesc')
          .replace('{count}', String(invoices.openInvoiceCount))
          .replace('{overdue}', String(invoices.overdueInvoiceCount))}
        trailing={
          invoices.overdueInvoiceCount > 0 ? (
            <StatusBadge tone="critical" label={translate('overview.filter.ueberfaellig')} icon={false} />
          ) : undefined
        }
        testId="home-card-invoices"
      />
      <RowListItem
        to="/steuerberater"
        icon={<NavIcon id="tax" />}
        title={translate('mobile.home.taxTitle')}
        /* REAL-PRODUCT-TEST-01B — „bereit" nur aus dem kanonischen Monatsstatus; ohne Belege neutral. */
        description={
          tax.state === 'empty'
            ? `${monthShort} · ${translate('mobile.home.taxEmpty')}`
            : `${monthShort} · ${tax.completenessPercent} % ${translate('mobile.home.taxPercentLabel')} · ${
                tax.state === 'ready'
                  ? translate('mobile.home.taxComplete')
                  : tax.openCount === 1
                    ? translate('mobile.home.taxOpenOne')
                    : translate('mobile.home.taxOpen').replace('{count}', String(tax.openCount))
              }`
        }
        trailing={<span className="row-list__cta" data-testid="home-card-steuerberater-action">{translate('steuerberater.prepareFolderButton')}</span>}
        testId="home-card-steuerberater"
      />
    </RowList>
  );
}
