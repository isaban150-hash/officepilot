import type { InvoicePrintModel } from '../../types/models';

interface Props {
  model: InvoicePrintModel;
}

function formatAddress(model: InvoicePrintModel): string {
  const { company } = model;
  return [company.street, `${company.zip} ${company.city}`.trim(), company.country]
    .filter(Boolean)
    .join(' · ');
}

export function InvoiceFooter({ model }: Props) {
  const { company } = model;
  const address = formatAddress(model);

  return (
    <footer className="invoice-footer" data-testid="invoice-footer">
      {model.footerNotes.trim() && <p className="invoice-footer__notes">{model.footerNotes}</p>}
      <div className="invoice-footer__legal">
        <p className="invoice-footer__company">
          {company.companyName}
          {company.legalForm ? ` ${company.legalForm}` : ''}
        </p>
        {address && <p>{address}</p>}
        {company.managingDirector && (
          <p>Geschäftsführer/Inhaber: {company.managingDirector}</p>
        )}
        <p>
          {[company.phone && `Tel. ${company.phone}`, company.email && company.email]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {company.website && <p>{company.website}</p>}
        <p>
          {[company.taxNumber && `St.-Nr. ${company.taxNumber}`, company.vatId && `USt-IdNr. ${company.vatId}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p>
          {[company.bankName, company.iban && `IBAN ${company.iban}`, company.bic && `BIC ${company.bic}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </footer>
  );
}
