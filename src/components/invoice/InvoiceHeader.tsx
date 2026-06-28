import type { InvoicePrintModel } from '../../types/models';
import { formatInvoiceDate } from '../../services/invoicePrintModel';

interface Props {
  model: InvoicePrintModel;
}

function formatCompanyLine(model: InvoicePrintModel): string {
  const { company } = model;
  const parts = [company.street, `${company.zip} ${company.city}`.trim(), company.country].filter(
    Boolean,
  );
  return parts.join(', ');
}

export function InvoiceHeader({ model }: Props) {
  const { company } = model;
  const companyLine = formatCompanyLine(model);

  return (
    <header className="invoice-header">
      <div className="invoice-header__brand">
        {company.logoDataUrl ? (
          <img
            src={company.logoDataUrl}
            alt=""
            className="invoice-header__logo"
          />
        ) : (
          <div className="invoice-header__logo-placeholder" aria-hidden="true">
            Logo
          </div>
        )}
        <div className="invoice-header__company">
          <p className="invoice-header__name">
            {company.companyName}
            {company.legalForm ? ` ${company.legalForm}` : ''}
          </p>
          {companyLine && <p className="invoice-header__address">{companyLine}</p>}
          {company.phone && <p>Tel.: {company.phone}</p>}
          {company.email && <p>E-Mail: {company.email}</p>}
          {company.website && <p>{company.website}</p>}
          {company.taxNumber && <p>Steuernummer: {company.taxNumber}</p>}
          {company.vatId && <p>USt-IdNr.: {company.vatId}</p>}
        </div>
      </div>

      <div className="invoice-header__meta">
        <h1 className="invoice-header__title">Rechnung</h1>
        <dl className="invoice-header__facts">
          <div>
            <dt>Rechnungsnummer</dt>
            <dd>{model.invoiceNumber}</dd>
          </div>
          <div>
            <dt>Rechnungsdatum</dt>
            <dd>{formatInvoiceDate(model.issueDate)}</dd>
          </div>
          <div>
            <dt>Belegart</dt>
            <dd>{model.documentTitle}</dd>
          </div>
        </dl>
      </div>
    </header>
  );
}
