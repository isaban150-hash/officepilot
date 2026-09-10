import {
  formatManagingDirectorLine,
  formatRegisterLine,
} from '../../services/invoice/companyDocumentLines';
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
  /*
   * INVOICE-PDF-COMPANY-BLOCK-01 — dieselben Zeilen wie im PDF, aus derselben
   * Quelle. Die Formulierung lag vorher hier und musste im PDF ein zweites Mal
   * geschrieben werden; genau daraus entstand die Abweichung, die dieser Block
   * schliesst.
   */
  const registerLine = formatRegisterLine(company);
  const directorLine = formatManagingDirectorLine(company);

  return (
    <footer className="invoice-footer" data-testid="invoice-footer">
      {model.footerNotes.trim() && <p className="invoice-footer__notes">{model.footerNotes}</p>}
      <div className="invoice-footer__legal">
        <p className="invoice-footer__company">
          {company.companyName}
          {company.legalForm ? ` ${company.legalForm}` : ''}
        </p>
        {address && <p>{address}</p>}
        {directorLine && <p data-testid="invoice-footer-director">{directorLine}</p>}
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
        {registerLine && <p data-testid="invoice-footer-register">{registerLine}</p>}
        <p>
          {[company.bankName, company.iban && `IBAN ${company.iban}`, company.bic && `BIC ${company.bic}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </footer>
  );
}
