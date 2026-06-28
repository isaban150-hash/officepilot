import type { InvoicePrintModel } from '../../types/models';
import { formatInvoiceDate } from '../../services/invoicePrintModel';
import { InvoiceCustomerBlock } from './InvoiceCustomerBlock';
import { InvoiceFooter } from './InvoiceFooter';
import { InvoiceHeader } from './InvoiceHeader';
import { InvoicePaymentBlock } from './InvoicePaymentBlock';
import { InvoicePositionTable } from './InvoicePositionTable';
import { InvoiceProjectBlock } from './InvoiceProjectBlock';
import { InvoiceSummary } from './InvoiceSummary';
import { InvoiceTaxNotice } from './InvoiceTaxNotice';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceDocumentView({ model }: Props) {
  return (
    <article
      className="invoice-document"
      data-invoice-type={model.type}
      data-tax-status={model.taxStatus}
    >
      <div className="invoice-document__sheet">
        <InvoiceHeader model={model} />
        <InvoiceCustomerBlock model={model} />

        {model.introText.trim() && (
          <section className="invoice-block invoice-intro">
            <p>{model.introText}</p>
          </section>
        )}

        <InvoiceProjectBlock model={model} />

        <section className="invoice-block invoice-service-period">
          <h2 className="invoice-block__title">Leistungszeitraum</h2>
          <dl className="invoice-service-period__facts">
            <div>
              <dt>Von</dt>
              <dd>{formatInvoiceDate(model.servicePeriodFrom)}</dd>
            </div>
            <div>
              <dt>Bis</dt>
              <dd>{formatInvoiceDate(model.servicePeriodTo)}</dd>
            </div>
          </dl>
        </section>

        <InvoicePositionTable model={model} />
        <InvoiceSummary model={model} />
        <InvoiceTaxNotice model={model} />
        <InvoicePaymentBlock model={model} />

        {model.closingText.trim() && (
          <section className="invoice-block invoice-closing">
            <p>{model.closingText}</p>
          </section>
        )}

        <InvoiceFooter model={model} />
      </div>
    </article>
  );
}
