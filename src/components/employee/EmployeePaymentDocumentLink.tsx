/**
 * P1 MITARBEITERZAHLUNGEN — der Zusammenhang eines Dokuments zur
 * Mitarbeiterzahlung, im Dokumentdetail.
 *
 * Gefunden wird er über die Zahlung (Quittung oder Nachweis), nicht über ein
 * Feld am Dokument: Die Zahlung bleibt die eine Wahrheit. Ist sie storniert,
 * steht das hier ausdrücklich — das Dokument selbst bleibt unverändert.
 */
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { findEmployeePaymentsByDocument } from '../../services/employee/employeePaymentService';
import { formatDisplayDatePadded, formatEuroAmount } from '../../utils/displayFormat';

export function buildEmployeePaymentHref(paymentId: string): string {
  return `/finanzen/mitarbeiterzahlungen?zahlung=${encodeURIComponent(paymentId)}`;
}

export function EmployeePaymentDocumentLink({ documentId }: { documentId: string }) {
  const { translate } = useApp();
  const zahlungen = findEmployeePaymentsByDocument(documentId);
  if (zahlungen.length === 0) return null;

  return (
    <section className="employee-payment-document-link" data-testid="document-employee-payment-link">
      {zahlungen.map((zahlung) => {
        const rolle = zahlung.receiptDocumentId === documentId ? 'receipt' : 'proof';
        return (
          <div
            key={zahlung.id}
            className="employee-payment-document-link__item"
            data-testid={`document-employee-payment-${rolle}`}
          >
            <p className="employee-payment-document-link__title">
              {translate(`employeePayment.document.${rolle}` as TranslationKey).replace(
                '{reference}',
                zahlung.receiptReference,
              )}
            </p>
            <p className="form-hint">
              {translate('employeePayment.document.meta')
                .replace('{employee}', zahlung.employeeName)
                .replace('{amount}', formatEuroAmount(zahlung.amount))
                .replace('{date}', formatDisplayDatePadded(zahlung.paymentDate))}
            </p>
            {zahlung.reversedAt ? (
              <p className="employee-payment-document-link__reversed" data-testid="document-employee-payment-reversed">
                {translate('employeePayment.document.reversed').replace(
                  '{date}',
                  formatDisplayDatePadded(zahlung.reversedAt),
                )}
              </p>
            ) : null}
            <Link to={buildEmployeePaymentHref(zahlung.id)} data-testid="document-employee-payment-open">
              {translate('employeePayment.document.open')}
            </Link>
          </div>
        );
      })}
    </section>
  );
}
