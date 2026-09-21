import type { InvoicePrintModel } from '../../types/models';
import { InvoiceCustomerBlock } from '../invoice/InvoiceCustomerBlock';
import { InvoiceFooter } from '../invoice/InvoiceFooter';
import { InvoiceHeader } from '../invoice/InvoiceHeader';
import { InvoicePositionTable } from '../invoice/InvoicePositionTable';
import { InvoiceProjectBlock } from '../invoice/InvoiceProjectBlock';
import { InvoiceSummary } from '../invoice/InvoiceSummary';
import { InvoiceTaxNotice } from '../invoice/InvoiceTaxNotice';

/**
 * ANGEBOT-01B — die Bildschirmansicht eines Angebots.
 *
 * Dieselben Bausteine wie die Rechnung (Kopf, Empfänger, Betreff, Positionen,
 * Summen, Steuerhinweis, Fuss); es fehlen bewusst Leistungszeitraum und
 * Zahlungsblock, stattdessen stehen die Konditionen. Das Modell trägt den
 * `offer`-Kontext, den Kopf und Empfängerblock für ihre Beschriftung nutzen.
 */
interface Props {
  model: InvoicePrintModel;
}

export function OfferDocumentView({ model }: Props) {
  return (
    <article className="invoice-document offer-document" data-tax-status={model.taxStatus} data-testid="offer-document">
      <div className="invoice-document__sheet">
        <InvoiceHeader model={model} />
        <InvoiceCustomerBlock model={model} />

        {model.introText.trim() && (
          <section className="invoice-block invoice-intro">
            <p>{model.introText}</p>
          </section>
        )}

        <InvoiceProjectBlock model={model} />
        <InvoicePositionTable model={model} />
        <InvoiceSummary model={model} />
        <InvoiceTaxNotice model={model} />

        {model.paymentTermsText.trim() && (
          <section className="invoice-block invoice-payment" data-testid="offer-document-terms">
            <h2 className="invoice-block__title">Konditionen</h2>
            <p>{model.paymentTermsText}</p>
          </section>
        )}

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
