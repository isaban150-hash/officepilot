import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { formatInvoiceCurrency, formatInvoiceDate } from '../../services/invoicePrintModel';
import { getTaxStatusLabel } from '../../services/invoiceTaxService';
import type { Vorgang } from '../../types/models';
import { DataRow } from '../ui/Card';
import { DetailSection, SummaryList } from '../ui/Section';

/**
 * ANGEBOT->AUFTRAG-02B — der kaufmännische Kopf eines Auftrags aus Angebot:
 * Auftragsnummer, Herkunft (Angebot), Kunde, Steuerstatus, Summe. Nur für
 * Vorgänge mit `orderNumber`; Vorgänge aus Werkverträgen zeigen nichts davon.
 */
export function VorgangOrderFactsCard({ vorgang }: { vorgang: Vorgang }) {
  const { translate } = useApp();
  if (!vorgang.orderNumber) return null;
  return (
    <DetailSection title={translate('vorgang.order.title')} testId="vorgang-order-facts">
      <SummaryList columns={2}>
        <DataRow label={translate('vorgang.order.number')} value={<strong data-testid="vorgang-order-number">{vorgang.orderNumber}</strong>} />
        <DataRow label={translate('vorgang.order.date')} value={vorgang.orderDate ? formatInvoiceDate(vorgang.orderDate) : '—'} />
        <DataRow label={translate('offer.editor.customer')} value={vorgang.customerBilling?.name || vorgang.customer} />
        <DataRow
          label={translate('vorgang.order.taxStatus')}
          value={<span data-testid="vorgang-order-tax">{vorgang.taxStatus ? getTaxStatusLabel(vorgang.taxStatus) : '—'}</span>}
        />
        {vorgang.contractTotals ? (
          <DataRow label={translate('vorgang.order.total')} value={formatInvoiceCurrency(vorgang.contractTotals.total)} />
        ) : null}
        {vorgang.sourceOfferId ? (
          <DataRow
            label={translate('vorgang.order.sourceOffer')}
            value={
              <Link to={`/angebote/${vorgang.sourceOfferId}`} data-testid="vorgang-order-open-offer">
                {vorgang.sourceOfferNumber ?? translate('offer.detail.title')} →
              </Link>
            }
          />
        ) : null}
      </SummaryList>
      <p className="form-hint">{translate('vorgang.order.frozenHint')}</p>
    </DetailSection>
  );
}
