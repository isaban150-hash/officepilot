/**
 * FINANZCORE-05E — Abrechnung und Zahlungsstand eines Auftrags.
 *
 * Zwei Blöcke, bewusst getrennt und getrennt beschriftet:
 *
 *   „Abrechnung" rechnet in **Netto** gegen den Auftragswert — das ist der
 *   Maßstab der Auftragspositionen. „Zahlungsstand" rechnet in **Brutto**,
 *   denn eine Forderung wird brutto beglichen. Beides in eine Zeile zu
 *   stellen, hiesse zwei verschiedene Größen zu vergleichen; die Überschriften
 *   sagen deshalb ausdrücklich, welcher Maßstab gilt.
 *
 * Diese Komponente rechnet nichts — sie stellt `summarizeOrderFinancials` dar.
 * Gebaut aus den vorhandenen Bausteinen, keine neue Kartenwand.
 */
import { DataRow } from '../ui/Card';
import { SummaryList } from '../ui/Section';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { InvoicePaymentBadge } from '../invoice/InvoicePaymentBadge';
import { Badge } from '../ui/Badge';
import { formatPaymentCurrency } from '../../services/invoicePaymentService';
import { formatDisplayDate } from '../../utils/displayFormat';
import type { OrderFinancials, OrderPaymentState } from '../../services/order/orderFinancialsService';
import type { TranslationKey } from '../../i18n';

/** 01H — „noch offen" nur, wenn tatsächlich ein offener Betrag dasteht. */
const PAYMENT_STATE_LABEL: Record<OrderPaymentState, TranslationKey> = {
  noActiveClaim: 'order.financials.stateNoActiveClaim',
  open: 'order.financials.stateNotSettled',
  overpaid: 'order.financials.stateOverpaid',
  settled: 'order.financials.stateSettled',
};

interface Props {
  financials: OrderFinancials;
  translate: (key: TranslationKey) => string;
}

/** „—" statt einer erfundenen Null, wenn es keinen belastbaren Wert gibt. */
function money(value: number | null, translate: (key: TranslationKey) => string): string {
  return value === null ? translate('order.financials.noOrderValue') : formatPaymentCurrency(value);
}

export function OrderFinancialsPanel({ financials, translate }: Props) {
  const {
    orderValueNet,
    invoicedNet,
    remainingBillableNet,
    invoicedPercent,
    isOverInvoiced,
    paidAmount,
    openReceivables,
    overdueReceivables,
    overpaidCredit,
    invoiceCount,
    hasFinalInvoice,
    isFullyInvoiced,
    awaitsFinalInvoice,
    paymentState,
    invoices,
  } = financials;

  return (
    <div data-testid="vorgang-financials">
      {/* ---------------- Abrechnung (netto) ---------------- */}
      <h3 className="ui-section-header__title">{translate('order.financials.billingTitle')}</h3>
      <SummaryList columns={2} testId="vorgang-financials-billing">
        <DataRow
          label={translate('order.financials.orderValue')}
          value={<span data-testid="vorgang-financials-order-value">{money(orderValueNet, translate)}</span>}
        />
        <DataRow
          label={translate('order.financials.invoiced')}
          value={
            <span data-testid="vorgang-financials-invoiced">
              {formatPaymentCurrency(invoicedNet)}
              {invoicedPercent !== null ? ` (${invoicedPercent.toLocaleString('de-DE')} %)` : ''}
            </span>
          }
        />
        <DataRow
          label={translate('order.financials.remaining')}
          value={
            <span data-testid="vorgang-financials-remaining">
              {money(remainingBillableNet, translate)}
            </span>
          }
        />
        <DataRow
          label={translate('order.financials.invoiceCount')}
          value={<span data-testid="vorgang-financials-count">{String(invoiceCount)}</span>}
        />
      </SummaryList>

      {/*
        * Der Sonderfall wird benannt, nicht kaschiert: Ein negativer Rest
        * bedeutet, dass mehr abgerechnet wurde als beauftragt. Das kann
        * richtig sein (Nachtrag noch nicht erfasst) oder ein Fehler — die
        * Entscheidung gehört dem Nutzer, nicht einem stillen `max(0, …)`.
        */}
      {isOverInvoiced && (
        <p className="detail-hint" data-testid="vorgang-financials-over-invoiced">
          {translate('order.financials.overInvoicedHint')}
        </p>
      )}

      {/* ---------------- Zahlungsstand (brutto) ---------------- */}
      <h3 className="ui-section-header__title">{translate('order.financials.paymentTitle')}</h3>
      <SummaryList columns={2} testId="vorgang-financials-payment">
        <DataRow
          label={translate('order.financials.paid')}
          value={<span data-testid="vorgang-financials-paid">{formatPaymentCurrency(paidAmount)}</span>}
        />
        <DataRow
          label={translate('order.financials.open')}
          value={<span data-testid="vorgang-financials-open">{formatPaymentCurrency(openReceivables)}</span>}
        />
        <DataRow
          label={translate('order.financials.overdue')}
          value={<span data-testid="vorgang-financials-overdue">{formatPaymentCurrency(overdueReceivables)}</span>}
        />
        <DataRow
          label={translate('order.financials.overpaid')}
          value={<span data-testid="vorgang-financials-overpaid">{formatPaymentCurrency(overpaidCredit)}</span>}
        />
      </SummaryList>

      {overpaidCredit > 0 && (
        <p className="detail-hint" data-testid="vorgang-financials-overpaid-hint">
          {translate('order.financials.overpaidHint')}
        </p>
      )}

      {/*
        * Die beiden Zustände stehen nebeneinander, weil sie verschiedene Dinge
        * sagen: Ein Auftrag kann vollständig abgerechnet und trotzdem unbezahlt
        * sein.
        */}
      <p className="detail-hint" data-testid="vorgang-financials-state">
        {isFullyInvoiced
          ? translate('order.financials.stateFullyInvoiced')
          : awaitsFinalInvoice
            ? translate('order.financials.stateAwaitsFinal')
            : translate('order.financials.stateOpenBilling')}
        {' · '}
        {translate(PAYMENT_STATE_LABEL[paymentState])}
        {hasFinalInvoice ? ` · ${translate('order.financials.stateHasFinal')}` : ''}
      </p>

      {/* ---------------- Rechnungsverlauf ---------------- */}
      {invoices.length === 0 ? (
        <p className="detail-empty" data-testid="vorgang-financials-empty">
          {translate('order.financials.noInvoices')}
        </p>
      ) : (
        <>
          <h3 className="ui-section-header__title">{translate('order.financials.historyTitle')}</h3>
          <BusinessList>
            {invoices.map((entry) => (
              <BusinessListItem
                key={entry.invoiceId}
                linkTestId={`vorgang-financials-invoice-${entry.invoiceId}`}
                title={
                  <span data-testid={`vorgang-financials-invoice-title-${entry.invoiceId}`}>
                    {entry.number} · {entry.typeLabel}
                  </span>
                }
                subtitle={
                  <span data-testid={`vorgang-financials-invoice-meta-${entry.invoiceId}`}>
                    {formatDisplayDate(entry.issueDate)}
                    {' · '}
                    {translate('order.financials.itemAmount')}:{' '}
                    {formatPaymentCurrency(entry.invoiceAmount)}
                    {' · '}
                    {translate('order.financials.itemPaid')}:{' '}
                    {formatPaymentCurrency(entry.paidAmount)}
                    {' · '}
                    {translate('order.financials.itemOpen')}:{' '}
                    {formatPaymentCurrency(entry.openAmount)}
                    {entry.overpaidAmount > 0
                      ? ` · ${translate('order.financials.itemOverpaid')}: ${formatPaymentCurrency(
                          entry.overpaidAmount,
                        )}`
                      : ''}
                  </span>
                }
                status={
                  entry.cancelled ? (
                    /*
                     * Storniert bleibt sichtbar — die Historie gehört zum
                     * Auftrag. Das Abzeichen sagt, dass sie in keiner aktiven
                     * Summe steckt.
                     */
                    <Badge tone="neutral" data-testid={`vorgang-financials-cancelled-${entry.invoiceId}`}>
                      {translate('order.financials.cancelled')}
                    </Badge>
                  ) : (
                    <InvoicePaymentBadge status={entry.status} translate={translate} />
                  )
                }
                amount={
                  <span className="money-display" data-testid={`vorgang-financials-open-${entry.invoiceId}`}>
                    {formatPaymentCurrency(entry.openAmount)}
                  </span>
                }
              />
            ))}
          </BusinessList>
        </>
      )}
    </div>
  );
}
