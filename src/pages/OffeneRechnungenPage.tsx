import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { InvoiceOverviewCard } from '../components/invoice/InvoiceOverviewCard';
import { Button } from '../components/ui/Button';
import { DataRow, PageHeader } from '../components/ui/Card';
import { MoneyDisplay } from '../components/ui/Display';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { BusinessList } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { DetailSection, SummaryList } from '../components/ui/Section';
import { InlineNotice } from '../components/ui/States';
import { FilterChips, SearchField } from '../components/ui/Toolbar';
import { useApp } from '../context/AppContext';
import {
  applyInvoiceOverviewFilters,
  getAllInvoiceOverview,
  summarizeInvoiceOverview,
  type InvoiceOverviewFilter,
  type InvoiceOverviewItem,
} from '../services/invoiceOverviewService';
import { MANUAL_INVOICE_ROUTE } from '../services/invoice/manualInvoiceFlow';
import type { TranslationKey } from '../i18n';

const FILTER_OPTIONS: InvoiceOverviewFilter[] = [
  'all',
  'offen',
  'teilbezahlt',
  'ueberfaellig',
  'bezahlt',
  'storniert',
];

/**
 * UIUX-FOUNDATION-01E — Rechnungsübersicht.
 *
 * `getAllInvoiceOverview` liefert bereits alle Rechnungen (Filter „Alle“ ist
 * Standard); die Seite heißt deshalb wie der Hauptbereich „Rechnungen“ —
 * ohne neue Aggregation. Struktur: Header (Back = Aufträge, eine
 * Hauptaktion) → Hinweise → Zahlungsstand → Toolbar → Business-Liste.
 */
export function OffeneRechnungenPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<InvoiceOverviewItem[]>(() => getAllInvoiceOverview());
  const [filter, setFilter] = useState<InvoiceOverviewFilter>('all');
  const [query, setQuery] = useState('');

  const refreshItems = () => {
    setItems(getAllInvoiceOverview());
  };

  useEffect(() => {
    refreshItems();
  }, [location.pathname, location.key]);

  const totals = useMemo(() => summarizeInvoiceOverview(items), [items]);
  const filteredItems = useMemo(
    () => applyInvoiceOverviewFilters(items, filter, query),
    [items, filter, query],
  );

  const filterOptions = useMemo(
    () => FILTER_OPTIONS.map((option) => ({ id: option, label: translate(`overview.filter.${option}` as TranslationKey) })),
    [translate],
  );

  const handleInvoiceUpdated = () => {
    refreshItems();
  };

  const handlePaymentToast = (message: string) => {
    showToast(message);
  };

  return (
    <Page testId="rechnungen-page">
      <PageHeader
        title={translate('invoices.list.title')}
        subtitle={translate('overview.subtitle')}
        backLabel={translate('common.back')}
        backHref="/vorgaenge"
        backTestId="rechnungen-back"
        /* MANUAL-INVOICE-UI-01B1B — der eine Einstieg in die Rechnung ohne Auftrag. */
        primaryAction={
          <Button type="button" onClick={() => navigate(MANUAL_INVOICE_ROUTE)} data-testid="overview-new-invoice">
            {translate('manualInvoice.entry')}
          </Button>
        }
      />

      {totals.overdueInvoiceCount > 0 && (
        <InlineNotice tone="warning" testId="rechnungen-overdue-notice">
          {translate('overview.overdueWarning').replace('{count}', String(totals.overdueInvoiceCount))}
        </InlineNotice>
      )}
      {totals.totalInvoiceCount > 0 && totals.openInvoiceCount === 0 && (
        <InlineNotice tone="success" testId="rechnungen-allpaid-notice">
          {translate('overview.allPaid')}
        </InlineNotice>
      )}

      <DetailSection title={translate('invoices.list.summaryTitle')} surface testId="rechnungen-summary">
        <SummaryList>
          <DataRow label={translate('overview.openReceivables')} value={<MoneyDisplay value={totals.openReceivables} emphasis />} />
          <DataRow label={translate('overview.overdueReceivables')} value={<MoneyDisplay value={totals.overdueReceivables} />} />
          <DataRow label={translate('overview.paidTotal')} value={<MoneyDisplay value={totals.paidTotal} />} />
          <DataRow label={translate('overview.openInvoiceCount')} value={String(totals.openInvoiceCount)} />
          <DataRow label={translate('overview.totalInvoiceCount')} value={String(totals.totalInvoiceCount)} />
        </SummaryList>
      </DetailSection>

      <PageToolbar
        search={
          <SearchField
            label={translate('overview.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            testId="rechnungen-search"
          />
        }
        filters={<FilterChips options={filterOptions} value={filter} onChange={setFilter} label={translate('list.filter.label')} testIdPrefix="rechnungen-filter" />}
      />

      {filteredItems.length === 0 ? (
        <EmptyStateBlock title={translate('overview.empty')} description="" testId="rechnungen-empty" />
      ) : (
        <BusinessList testId="rechnungen-list" ariaLabel={translate('invoices.list.title')}>
          {filteredItems.map((item) => (
            <InvoiceOverviewCard
              key={`${item.vorgangId}-${item.invoice.id}`}
              item={item}
              translate={translate}
              onInvoiceUpdated={handleInvoiceUpdated}
              onPaymentToast={handlePaymentToast}
            />
          ))}
        </BusinessList>
      )}

      <div className="detail-actions">
        <Link to="/vorgaenge">
          <Button variant="outline">{translate('overview.backToVorgaenge')}</Button>
        </Link>
      </div>
    </Page>
  );
}
