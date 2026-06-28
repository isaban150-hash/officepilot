import type { InvoicePrintModel } from '../../types/models';
import { getTaxStatusLabel } from '../../services/invoicePrintModel';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceTaxNotice({ model }: Props) {
  return (
    <section className="invoice-block invoice-tax-notice">
      <h2 className="invoice-block__title">Steuerhinweis</h2>
      <p className="invoice-tax-notice__status">{getTaxStatusLabel(model.taxStatus)}</p>
      {model.taxNotices.length > 0 ? (
        <ul className="invoice-tax-notice__list">
          {model.taxNotices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : (
        model.taxStatus === 'standard_19' && (
          <p>Umsatzsteuer wird zum regulären Steuersatz ausgewiesen.</p>
        )
      )}
    </section>
  );
}
