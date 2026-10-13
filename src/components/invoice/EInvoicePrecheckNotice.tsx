import { describeCanonicalIssue } from '../../services/einvoice/einvoiceIssueText';
import type { InvoiceEInvoicePrecheck } from '../../services/invoice/invoiceEInvoicePrecheck';
import type { TranslationKey } from '../../i18n';

interface Props {
  precheck: InvoiceEInvoicePrecheck;
  translate: (key: TranslationKey) => string;
}

/**
 * FINANZ-CORE-01A (KUN-02) — was einer E-Rechnung zu diesem Entwurf fehlen
 * würde, sichtbar **vor** der Freigabe. Kein Hindernis für die Freigabe; mit
 * E-Rechnungs-Angaben beim Empfänger aufgeklappt, sonst eingeklappt.
 */
export function EInvoicePrecheckNotice({ precheck, translate }: Props) {
  if (precheck.issues.length === 0) return null;
  const texts = [...new Set(precheck.issues.map(describeCanonicalIssue))];
  return (
    <details
      className={`invoice-hint${precheck.eInvoiceExpected ? ' invoice-hint--warning' : ''}`}
      data-testid="invoice-einvoice-precheck"
      open={precheck.eInvoiceExpected}
    >
      <summary>
        {translate(
          precheck.eInvoiceExpected ? 'invoice.einvoicePrecheck.titleExpected' : 'invoice.einvoicePrecheck.title',
        )}
      </summary>
      <p>
        {translate(
          precheck.onlyXRechnung ? 'invoice.einvoicePrecheck.hintXRechnungOnly' : 'invoice.einvoicePrecheck.hint',
        )}
      </p>
      <ul className="invoice-warn-list">
        {texts.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </details>
  );
}
