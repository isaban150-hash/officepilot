import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { InvoiceOverviewCard } from '../components/invoice/InvoiceOverviewCard';
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
  // FINANZCORE-05C — sichtbar auffindbar, ohne unter „offen" zu zaehlen.
  'ueberbezahlt',
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

      {/* VISUAL-POLISH-01C — Zahlungsstand als Kennzahlenfläche (Kpi-Primitives aus Block A), keine Kartenwand. */}
      <KpiRow testId="rechnungen-summary" ariaLabel={translate('invoices.list.summaryTitle')} className="work-kpis work-kpis--4">
        <KpiTile
          label={translate('overview.openReceivables')}
          value={<MoneyDisplay value={totals.openReceivables} />}
          hint={translate('heute.kpi.openInvoicesHint').replace('{count}', String(totals.openInvoiceCount))}
          testId="rechnungen-kpi-open"
        />
        <KpiTile
          label={translate('overview.overdueReceivables')}
          value={<MoneyDisplay value={totals.overdueReceivables} />}
          hint={translate('heute.kpi.overdueHint').replace('{count}', String(totals.overdueInvoiceCount))}
          tone={totals.overdueInvoiceCount > 0 ? 'critical' : 'neutral'}
          testId="rechnungen-kpi-overdue"
        />
        <KpiTile
          label={translate('overview.paidTotal')}
          value={<MoneyDisplay value={totals.paidTotal} />}
          tone="positive"
          testId="rechnungen-kpi-paid"
        />
        <KpiTile
          label={translate('overview.totalInvoiceCount')}
          value={String(totals.totalInvoiceCount)}
          testId="rechnungen-kpi-total"
        />
      </KpiRow>

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

      <div className="detail-actions work-footer-link">
        <Link to="/vorgaenge">
          <Button variant="ghost" size="sm">{translate('overview.backToVorgaenge')}</Button>
        </Link>
      </div>
    </Page>
  );
}
