import type { InvoicePrintModel } from '../../types/models';
import { formatInvoiceCurrency } from '../../services/invoicePrintModel';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceSummary({ model }: Props) {
  const { summary, type } = model;
  const isSchluss = type === 'schluss' && summary.deductionLines.length > 0;

  return (
    <section className="invoice-block invoice-summary">
      <h2 className="invoice-block__title">Summen</h2>
      <dl className="invoice-summary__rows">
        <div className="invoice-summary__row">
          <dt>Netto</dt>
          <dd>{formatInvoiceCurrency(summary.subtotalNet)}</dd>
        </div>
        {summary.taxRate > 0 && (
          <div className="invoice-summary__row">
            <dt>MwSt. ({summary.taxRate} %)</dt>
            <dd>{formatInvoiceCurrency(summary.taxAmount)}</dd>
          </div>
        )}
        <div className="invoice-summary__row invoice-summary__row--emphasis">
          <dt>{isSchluss ? 'Zwischensumme (brutto)' : 'Brutto'}</dt>
          <dd>{formatInvoiceCurrency(summary.grossTotal)}</dd>
        </div>

        {isSchluss && (
          <>
            <div className="invoice-summary__deductions">
              <p className="invoice-summary__deductions-title">Bereits berechnet</p>
              {summary.deductionLines.map((line) => (
                <div key={`${line.label}-${line.invoiceNumber}`} className="invoice-summary__row">
                  <dt>
                    {line.label}
                    <span className="invoice-summary__deduction-ref"> ({line.invoiceNumber})</span>
                  </dt>
                  <dd>− {formatInvoiceCurrency(line.amount)}</dd>
                </div>
              ))}
              <div className="invoice-summary__row">
                <dt>Summe Abschläge</dt>
                <dd>− {formatInvoiceCurrency(summary.deductionsTotal)}</dd>
              </div>
            </div>
            <div className="invoice-summary__row invoice-summary__row--total">
              <dt>Restbetrag</dt>
              <dd>{formatInvoiceCurrency(summary.amountDue)}</dd>
            </div>
          </>
        )}

        {!isSchluss && summary.taxRate === 0 && (
          <div className="invoice-summary__row invoice-summary__row--total">
            <dt>Gesamtbetrag</dt>
            <dd>{formatInvoiceCurrency(summary.amountDue)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
