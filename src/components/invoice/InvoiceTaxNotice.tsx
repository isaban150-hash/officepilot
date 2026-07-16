import type { InvoicePrintModel } from '../../types/models';
import { getTaxStatusLabel } from '../../services/invoicePrintModel';
import { useApp } from '../../context/AppContext';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceTaxNotice({ model }: Props) {
  const { translate } = useApp();
  const isReverseCharge = model.taxStatus === 'reverse_charge_13b';

  return (
    <section className="invoice-block invoice-tax-notice" data-testid="invoice-tax-notice">
      <h2 className="invoice-block__title">{translate('invoice.taxNoticeTitle')}</h2>
      <p className="invoice-tax-notice__status">{getTaxStatusLabel(model.taxStatus)}</p>
      {isReverseCharge ? (
        <p className="invoice-tax-notice__review" data-testid="invoice-13b-preview-hint">
          {translate('invoice.reverseCharge.previewHint')}
        </p>
      ) : null}
      {model.taxNotices.length > 0 ? (
        <ul className="invoice-tax-notice__list">
          {model.taxNotices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : (
        model.taxStatus === 'standard_19' && (
          <p>{translate('invoice.taxNotice.standard19')}</p>
        )
      )}
      {isReverseCharge ? (
        <p data-testid="invoice-13b-no-vat">{translate('invoice.reverseCharge.noVat')}</p>
      ) : null}
    </section>
  );
}
