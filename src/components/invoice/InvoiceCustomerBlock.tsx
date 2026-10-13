import type { InvoicePrintModel } from '../../types/models';
import { buildCustomerLegalLines } from '../../services/invoice/customerLegalLines';

interface Props {
  model: InvoicePrintModel;
}

function formatCustomerAddress(model: InvoicePrintModel): string {
  const { customer } = model;
  const parts = [customer.street, `${customer.zip} ${customer.city}`.trim()].filter(Boolean);
  return parts.join(', ');
}

export function InvoiceCustomerBlock({ model }: Props) {
  const address = formatCustomerAddress(model);

  return (
    <section className="invoice-block invoice-customer">
      <h2 className="invoice-block__title">{model.offer ? 'Angebot für' : 'Rechnungsempfänger'}</h2>
      <p className="invoice-customer__name">{model.customer.name}</p>
      {model.customer.contactPerson && (
        <p>Ansprechpartner: {model.customer.contactPerson}</p>
      )}
      {address && <p>{address}</p>}
      {/* FINANZ-CORE-01A (AUS-11) — Land außerhalb Deutschlands und USt-IdNr. des Empfängers, nur wenn im Beleg vorhanden. */}
      {buildCustomerLegalLines(model.customer).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {model.customer.email && <p>{model.customer.email}</p>}
      {model.customer.phone && <p>{model.customer.phone}</p>}
    </section>
  );
}
