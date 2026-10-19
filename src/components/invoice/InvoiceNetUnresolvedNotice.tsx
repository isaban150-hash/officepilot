import type { TranslationKey } from '../../i18n';
import { formatPaymentCurrency } from '../../services/invoicePaymentService';
import { getTaxStatusLabel } from '../../services/invoiceTaxService';
import type { VorgangInvoice } from '../../types/models';
import { Button } from '../ui/Button';
import { EmptyStateBlock } from '../ui/EmptyStateBlock';

/**
 * FC01A-P1-Restkorrektur (lokaler Altbestand) — die Rechnungsanzeige einer Altrechnung, deren Netto
 * sich aus den eingefrorenen Rechnungsdaten nicht sicher ermitteln lässt (`resolveInvoiceNet`).
 *
 * Statt erfundener Beträge oder „kann nicht angezeigt werden" steht hier, was feststeht (Nummer,
 * Rechnungsbetrag, Steuerstatus), was fehlt, dass nichts geändert wurde, und der Berichtigungsweg.
 * Druck, PDF, E-Rechnung und Versand sind über `validateFinalizedInvoiceForPdf` gesperrt.
 */
export function InvoiceNetUnresolvedNotice({
  invoice,
  translate,
  onBack,
}: {
  invoice: VorgangInvoice;
  translate: (key: TranslationKey) => string;
  onBack: () => void;
}) {
  const facts = translate('invoice.netUnresolved.facts')
    .replace('{number}', invoice.number)
    .replace('{amount}', formatPaymentCurrency(invoice.amount))
    .replace('{taxStatus}', getTaxStatusLabel(invoice.taxStatus));
  return (
    <div className="page" data-testid="invoice-net-unresolved">
      <EmptyStateBlock
        title={translate('invoice.netUnresolved.title')}
        description={facts}
        testId="invoice-net-unresolved-summary"
        actions={
          <Button variant="outline" onClick={onBack}>
            {translate('common.back')}
          </Button>
        }
      />
      <section className="invoice-cancelled-panel" data-testid="invoice-net-unresolved-correction">
        <p className="invoice-hint invoice-hint--warning" data-testid="invoice-net-unresolved-blocked">
          {translate('invoice.netUnresolved.blocked')}
        </p>
        <h3 className="ui-section-header__title">{translate('invoice.netUnresolved.stepsTitle')}</h3>
        <ol data-testid="invoice-net-unresolved-steps">
          <li>{translate('invoice.netUnresolved.stepOriginal')}</li>
          <li>{translate('invoice.netUnresolved.stepAdvisor')}</li>
          <li>{translate('invoice.netUnresolved.stepCorrection')}</li>
        </ol>
      </section>
    </div>
  );
}
