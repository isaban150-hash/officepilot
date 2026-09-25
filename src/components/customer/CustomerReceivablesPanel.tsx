/**
 * FINANZCORE-05D — die offenen Posten eines Kunden in der Kundenakte.
 *
 * Bewusst kein Dashboard: vier Kennzahlen, die Altersstruktur nur wenn etwas
 * offen ist, danach die Rechnungen selbst. Die Bausteine sind die vorhandenen
 * (`SummaryList`, `DataRow`, `BusinessList`) — keine neue Kartenwelt und keine
 * Diagrammbibliothek für fünf Zahlen.
 *
 * Diese Komponente rechnet nichts. Sie bekommt das fertige Ergebnis aus
 * `summarizeCustomerReceivables`; die Regeln stehen dort und nur dort.
 */
import { DataRow } from '../ui/Card';
import { SummaryList } from '../ui/Section';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { InvoicePaymentBadge } from '../invoice/InvoicePaymentBadge';
import { formatDisplayDate } from '../../utils/displayFormat';
import {
  formatReceivablesAmount,
  RECEIVABLES_AGING_BUCKETS,
  type CustomerReceivablesSummary,
} from '../../services/customer/customerReceivablesService';
import type { TranslationKey } from '../../i18n';

interface Props {
  receivables: CustomerReceivablesSummary;
  translate: (key: TranslationKey) => string;
}

export function CustomerReceivablesPanel({ receivables, translate }: Props) {
  const {
    openReceivables,
    overdueReceivables,
    overpaidCredit,
    netBalance,
    openInvoiceCount,
    overdueInvoiceCount,
    aging,
    openItems,
    overpaidItems,
    isSettled,
  } = receivables;

  /*
   * Der Leerzustand: Ein Kunde ohne Forderungen bekommt einen Satz, keine
   * Wand aus Nullen. Ein Guthaben ohne offene Forderung ist aber keine Leere
   * — dann wird weiter unten ausdrücklich das Guthaben gezeigt.
   */
  if (isSettled) {
    return (
      <div data-testid="kunden-receivables">
        <p className="detail-empty" data-testid="kunden-receivables-empty">
          {translate('kunden.receivables.empty')}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="kunden-receivables">
      <SummaryList columns={2} testId="kunden-receivables-summary">
        <DataRow
          label={translate('kunden.receivables.open')}
          value={<span data-testid="kunden-receivables-open">{formatReceivablesAmount(openReceivables)}</span>}
        />
        <DataRow
          label={translate('kunden.receivables.overdue')}
          value={<span data-testid="kunden-receivables-overdue">{formatReceivablesAmount(overdueReceivables)}</span>}
        />
        <DataRow
          label={translate('kunden.receivables.credit')}
          value={<span data-testid="kunden-receivables-credit">{formatReceivablesAmount(overpaidCredit)}</span>}
        />
        <DataRow
          label={translate('kunden.receivables.netBalance')}
          value={<span data-testid="kunden-receivables-net">{formatReceivablesAmount(netBalance)}</span>}
        />
        <DataRow
          label={translate('kunden.receivables.openCount')}
          value={<span data-testid="kunden-receivables-open-count">{String(openInvoiceCount)}</span>}
        />
        <DataRow
          label={translate('kunden.receivables.overdueCount')}
          value={<span data-testid="kunden-receivables-overdue-count">{String(overdueInvoiceCount)}</span>}
        />
      </SummaryList>

      {/*
        * Der Hinweis steht bewusst direkt unter dem Saldo: Er ist der
        * Unterschied zwischen einer Zusammenfassung und einer Buchung.
        */}
      <p className="detail-hint" data-testid="kunden-receivables-net-hint">
        {translate('kunden.receivables.netBalanceHint')}
      </p>

      {openReceivables > 0 && (
        <>
          <h3 className="ui-section-header__title">
            {translate('kunden.receivables.agingTitle')}
          </h3>
          <SummaryList columns={1} testId="kunden-receivables-aging">
            {RECEIVABLES_AGING_BUCKETS.map((bucket) => (
              <DataRow
                key={bucket}
                label={translate(`kunden.receivables.aging.${bucket}` as TranslationKey)}
                value={
                  <span data-testid={`kunden-receivables-aging-${bucket}`}>
                    {formatReceivablesAmount(aging[bucket])}
                  </span>
                }
              />
            ))}
          </SummaryList>
        </>
      )}

      {openItems.length > 0 && (
        <>
          <h3 className="ui-section-header__title">
            {translate('kunden.receivables.itemsTitle')}
          </h3>
          <BusinessList>
            {openItems.map((item) => (
              <BusinessListItem
                key={item.invoiceId}
                to={item.route}
                linkTestId={`kunden-receivable-${item.invoiceId}`}
                title={item.number}
                subtitle={
                  <span data-testid={`kunden-receivable-meta-${item.invoiceId}`}>
                    {formatDisplayDate(item.issueDate)}
                    {' · '}
                    {item.dueDate
                      ? `${translate('kunden.receivables.itemDue')}: ${formatDisplayDate(item.dueDate)}`
                      : translate('kunden.receivables.itemNoDue')}
                    {item.agingBucket === 'notSent'
                      ? ` · ${translate('kunden.receivables.aging.notSent')}`
                      : ''}
                    {item.overdueDays > 0
                      ? ` · ${translate('kunden.receivables.overdueDays').replace(
                          '{days}',
                          String(item.overdueDays),
                        )}`
                      : ''}
                    {' · '}
                    {translate('kunden.receivables.itemAmount')}:{' '}
                    {formatReceivablesAmount(item.invoiceAmount)}
                    {' · '}
                    {translate('kunden.receivables.itemPaid')}:{' '}
                    {formatReceivablesAmount(item.paidAmount)}
                  </span>
                }
                status={<InvoicePaymentBadge status={item.status} translate={translate} />}
                amount={
                  <span className="money-display" data-testid={`kunden-receivable-open-${item.invoiceId}`}>
                    {formatReceivablesAmount(item.openAmount)}
                  </span>
                }
              />
            ))}
          </BusinessList>
        </>
      )}

      {/*
        * Getrennter Abschnitt, nicht in die offene Liste gemischt: Eine
        * überbezahlte Rechnung fordert nichts mehr. Sie zwischen offene Posten
        * zu stellen, hiesse sie als Forderung zu lesen.
        */}
      {overpaidItems.length > 0 && (
        <>
          <h3 className="ui-section-header__title">
            {translate('kunden.receivables.creditTitle')}
          </h3>
          <p className="detail-hint" data-testid="kunden-receivables-credit-hint">
            {translate('kunden.receivables.creditHint')}
          </p>
          <BusinessList>
            {overpaidItems.map((item) => (
              <BusinessListItem
                key={item.invoiceId}
                to={item.route}
                linkTestId={`kunden-credit-${item.invoiceId}`}
                title={item.number}
                subtitle={`${translate('kunden.receivables.itemAmount')}: ${formatReceivablesAmount(
                  item.invoiceAmount,
                )} · ${translate('kunden.receivables.itemPaid')}: ${formatReceivablesAmount(
                  item.paidAmount,
                )}`}
                amount={
                  <span className="money-display" data-testid={`kunden-credit-amount-${item.invoiceId}`}>
                    {formatReceivablesAmount(item.overpaidAmount)}
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
