import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { formatInvoiceCurrency, formatInvoiceDate } from '../../services/invoicePrintModel';
import { getTaxStatusLabel } from '../../services/invoiceTaxService';
import { fromCents } from '../../services/invoiceMoney';
import { getCurrentBillableOrderNetCents } from '../../services/orderBillingRules';
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
  /*
   * FINANZ-CORE-01A (ANG-19, F-04) — `contractTotals` ist das bei Annahme bzw. Anlage
   * eingefrorene Brutto. Nachträge ändern nur die Positionen; „Auftragssumme" zeigte
   * deshalb nach einem Nachtrag weiter den alten Wert, ohne Netto/Brutto-Angabe
   * neben dem Netto-Auftragswert. Jetzt nennt die Zeile ihren Bezug, und mit
   * bestätigten Nachträgen steht der aktuelle Netto-Auftragswert daneben.
   */
  const mitNachtraegen = (vorgang.confirmedOrderAmendments?.length ?? 0) > 0;
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
          <DataRow
            label={translate(vorgang.sourceOfferId ? 'vorgang.order.totalAtAcceptance' : 'vorgang.order.totalAtCreation')}
            value={<span data-testid="vorgang-order-total">{formatInvoiceCurrency(vorgang.contractTotals.total)}</span>}
          />
        ) : null}
        {mitNachtraegen ? (
          <DataRow
            label={translate('vorgang.order.currentNet')}
            value={
              <span data-testid="vorgang-order-current-net">
                {formatInvoiceCurrency(fromCents(getCurrentBillableOrderNetCents(vorgang)))}
              </span>
            }
          />
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
      {/* AUFTRAG-02C — der Hinweis nennt die tatsaechliche Herkunft des Stands. */}
      <p className="form-hint">
        {translate(vorgang.sourceOfferId ? 'vorgang.order.frozenHint' : 'vorgang.order.frozenHintManual')}
      </p>
    </DetailSection>
  );
}
