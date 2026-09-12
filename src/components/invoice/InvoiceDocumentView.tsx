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

        {/*
          * NORMAL-INVOICE-CANCELLATION-01B — nur auf dem Korrekturbeleg: der
          * eindeutige Bezug auf die Originalrechnung und der Stornogrund.
          * Ein Original-Modell trägt `correction` nicht; sein Markup bleibt
          * unverändert (geschützter Snapshot).
          */}
        {model.correction && (
          <section className="invoice-block invoice-correction" data-testid="invoice-correction-block">
            <h2 className="invoice-block__title">Rechnungskorrektur</h2>
            <dl className="invoice-service-period__facts">
              <div>
                <dt>Bezug</dt>
                <dd data-testid="invoice-correction-reference">
                  Rechnung {model.correction.originalInvoiceNumber} vom{' '}
                  {formatInvoiceDate(model.correction.originalIssueDate)}
                </dd>
              </div>
              <div>
                <dt>Grund</dt>
                <dd data-testid="invoice-correction-reason">{model.correction.cancelReason}</dd>
              </div>
            </dl>
          </section>
        )}

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
        {/* Ein Korrekturbeleg hat kein Zahlungsziel — kein Zahlungsblock. */}
        {!model.correction && <InvoicePaymentBlock model={model} />}

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
