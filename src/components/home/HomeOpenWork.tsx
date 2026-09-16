import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { getInboxSummary } from '../../services/inboxService';
import { getAllInvoiceOverview, summarizeInvoiceOverview } from '../../services/invoiceOverviewService';
import { getAllVorgaenge } from '../../services/vorgangService';
import { StatusBadge } from '../ui/Badge';
import { RowList, RowListItem } from '../ui/Lists';
import { NavIcon } from '../layout/NavIcon';

/**
 * UIUX-FOUNDATION-01E — „Offene Arbeit“ auf Heute: drei Zeilen mit den
 * vorhandenen Zählern (Eingang, Aufträge, Rechnungen). Nur bestehende Services,
 * keine neue Aggregation. VISUAL-POLISH-01B: Steuerberater steht nur noch in
 * „Ihr Betrieb heute“ (`HomeKpis`) — keine doppelte Zeile.
 */
export function HomeOpenWork() {
  const { translate } = useApp();
  const inbox = useMemo(() => getInboxSummary(), []);
  const orderCount = useMemo(() => getAllVorgaenge().length, []);
  const invoices = useMemo(() => summarizeInvoiceOverview(getAllInvoiceOverview()), []);

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
    </RowList>
  );
}
