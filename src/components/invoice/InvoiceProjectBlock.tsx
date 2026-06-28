import type { InvoicePrintModel } from '../../types/models';

interface Props {
  model: InvoicePrintModel;
}

export function InvoiceProjectBlock({ model }: Props) {
  return (
    <section className="invoice-block invoice-project">
      <h2 className="invoice-block__title">Bauvorhaben</h2>
      <dl className="invoice-project__facts">
        <div>
          <dt>Titel</dt>
          <dd>{model.projectTitle}</dd>
        </div>
        {model.projectSite && (
          <div>
            <dt>Baustelle</dt>
            <dd>{model.projectSite}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
