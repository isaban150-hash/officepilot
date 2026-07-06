import type { InvoicePrintModel } from '../../types/models';
import { formatInvoiceDate } from '../../services/invoicePrintModel';

interface Props {
  model: InvoicePrintModel;
}

export function InvoicePaymentBlock({ model }: Props) {
  const { company } = model;

  return (
    <section className="invoice-block invoice-payment invoice-payment--highlight">
      <h2 className="invoice-block__title">Zahlungsinformationen</h2>
      <dl className="invoice-payment__facts">
        {company.iban && (
          <div>
            <dt>IBAN</dt>
            <dd>{company.iban}</dd>
          </div>
        )}
        {company.bic && (
          <div>
            <dt>BIC</dt>
            <dd>{company.bic}</dd>
          </div>
        )}
        {company.bankName && (
          <div>
            <dt>Bank</dt>
            <dd>{company.bankName}</dd>
          </div>
        )}
        <div>
          <dt>Zahlungsziel</dt>
          <dd>{formatInvoiceDate(model.paymentDueDate)}</dd>
        </div>
        {model.paymentTermsText && (
          <div>
            <dt>Zahlungsbedingungen</dt>
            <dd>{model.paymentTermsText}</dd>
          </div>
        )}
        {model.skontoText && (
          <div>
            <dt>Skonto</dt>
            <dd>{model.skontoText}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
