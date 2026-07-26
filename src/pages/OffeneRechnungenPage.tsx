import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { InvoiceOverviewCard } from '../components/invoice/InvoiceOverviewCard';
import { Button } from '../components/ui/Button';
import { Card, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  applyInvoiceOverviewFilters,
  getAllInvoiceOverview,
  summarizeInvoiceOverview,
  type InvoiceOverviewFilter,
  type InvoiceOverviewItem,
} from '../services/invoiceOverviewService';
import { formatPaymentCurrency } from '../services/invoicePaymentService';
import type { TranslationKey } from '../i18n';

const FILTER_OPTIONS: InvoiceOverviewFilter[] = [
  'all',
  'offen',
  'teilbezahlt',
  'ueberfaellig',
  'bezahlt',
  'storniert',
];

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

  const handleInvoiceUpdated = () => {
    refreshItems();
  };

  const handlePaymentToast = (message: string) => {
    showToast(message);
  };

  return (
    <div className="page">
      <PageHeader
        title={translate('overview.title')}
        subtitle={translate('overview.subtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/vorgaenge')}
      />

      {totals.overdueInvoiceCount > 0 && (
        <p className="invoice-hint invoice-hint--warning">
          {translate('overview.overdueWarning').replace(
            '{count}',
            String(totals.overdueInvoiceCount),
          )}
        </p>
      )}

      {totals.totalInvoiceCount > 0 && totals.openInvoiceCount === 0 && (
        <p className="invoice-hint invoice-hint--success">{translate('overview.allPaid')}</p>
      )}

      <section className="overview-kpi-grid">
        <Card className="overview-kpi-card">
          <p className="overview-kpi-card__label">{translate('overview.openReceivables')}</p>
          <p className="overview-kpi-card__value">{formatPaymentCurrency(totals.openReceivables)}</p>
        </Card>
        <Card className="overview-kpi-card overview-kpi-card--danger">
          <p className="overview-kpi-card__label">{translate('overview.overdueReceivables')}</p>
          <p className="overview-kpi-card__value">{formatPaymentCurrency(totals.overdueReceivables)}</p>
        </Card>
        <Card className="overview-kpi-card overview-kpi-card--success">
          <p className="overview-kpi-card__label">{translate('overview.paidTotal')}</p>
          <p className="overview-kpi-card__value">{formatPaymentCurrency(totals.paidTotal)}</p>
        </Card>
        <Card className="overview-kpi-card">
          <p className="overview-kpi-card__label">{translate('overview.openInvoiceCount')}</p>
          <p className="overview-kpi-card__value">{totals.openInvoiceCount}</p>
        </Card>
      </section>

      <Card className="overview-meta-card">
        <DataRow
          label={translate('overview.totalInvoiceCount')}
          value={String(totals.totalInvoiceCount)}
        />
      </Card>

      <div className="document-toolbar">
        <input
          type="search"
          className="input document-search"
          placeholder={translate('overview.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={translate('overview.searchPlaceholder')}
        />
      </div>

      <div className="chip-group overview-filters">
        {FILTER_OPTIONS.map((option) => {
          const key = `overview.filter.${option}` as TranslationKey;
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
        <p className="empty-state">{translate('overview.empty')}</p>
      ) : (
        <div className="card-list">
          {filteredItems.map((item) => (
            <InvoiceOverviewCard
              key={`${item.vorgangId}-${item.invoice.id}`}
              item={item}
              translate={translate}
              onInvoiceUpdated={handleInvoiceUpdated}
              onPaymentToast={handlePaymentToast}
            />
          ))}
        </div>
      )}

      <div className="page-header__actions">
        <Link to="/vorgaenge">
          <Button variant="outline" fullWidth>
            {translate('overview.backToVorgaenge')}
          </Button>
        </Link>
      </div>
    </div>
  );
}
