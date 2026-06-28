import type { InvoicePrintModel } from '../../types/models';
import { formatInvoiceCurrency } from '../../services/invoicePrintModel';

interface Props {
  model: InvoicePrintModel;
}

export function InvoicePositionTable({ model }: Props) {
  const { positions } = model;

  if (positions.length === 0) {
    return (
      <section className="invoice-block invoice-positions">
        <h2 className="invoice-block__title">Positionen</h2>
        <p className="invoice-positions__empty">Keine Positionen auf dieser Rechnung.</p>
      </section>
    );
  }

  return (
    <section className="invoice-block invoice-positions">
      <h2 className="invoice-block__title">Positionen</h2>

      <table className="invoice-positions__table">
        <thead>
          <tr>
            <th scope="col">Pos.</th>
            <th scope="col">Beschreibung</th>
            <th scope="col">Menge</th>
            <th scope="col">Einheit</th>
            <th scope="col">Einzelpreis</th>
            <th scope="col">Gesamt</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.index}>
              <td>{position.index}</td>
              <td>{position.description}</td>
              <td>{position.quantity.toLocaleString('de-DE')}</td>
              <td>{position.unit}</td>
              <td>{formatInvoiceCurrency(position.unitPrice)}</td>
              <td>{formatInvoiceCurrency(position.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="invoice-positions__cards">
        {positions.map((position) => (
          <article key={position.index} className="invoice-positions__card">
            <p className="invoice-positions__card-title">
              {position.index}. {position.description}
            </p>
            <dl className="invoice-positions__card-facts">
              <div>
                <dt>Menge</dt>
                <dd>
                  {position.quantity.toLocaleString('de-DE')} {position.unit}
                </dd>
              </div>
              <div>
                <dt>Einzelpreis</dt>
                <dd>{formatInvoiceCurrency(position.unitPrice)}</dd>
              </div>
              <div>
                <dt>Gesamt</dt>
                <dd>{formatInvoiceCurrency(position.lineTotal)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
