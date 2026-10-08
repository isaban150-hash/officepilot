import { Link } from 'react-router-dom';
import { InlineNotice } from '../ui/States';
import type { TranslationKey } from '../../i18n';

/** P1 MITARBEITERZAHLUNGEN — die Seite der Mitarbeiterzahlungen. */
export const EMPLOYEE_PAYMENTS_ROUTE = '/finanzen/mitarbeiterzahlungen';

/**
 * P1 MITARBEITERZAHLUNGEN — der Hinweis an einer Lohnabrechnung oder
 * Lohnunterlage: Sie wird nicht als Ausgabe erfasst. Die Abrechnung bucht der
 * Steuerberater; die tatsächliche Auszahlung gehört zu den
 * Mitarbeiterzahlungen — dorthin führt der Link.
 */
export function PayrollDocumentHint({
  translate,
  testId = 'payroll-document-hint',
}: {
  translate: (key: TranslationKey) => string;
  testId?: string;
}) {
  return (
    <InlineNotice
      tone="info"
      testId={testId}
      action={
        <Link to={EMPLOYEE_PAYMENTS_ROUTE} className="btn btn--outline btn--sm" data-testid={`${testId}-link`}>
          {translate('payroll.hint.link')}
        </Link>
      }
    >
      {translate('payroll.hint.text')}
    </InlineNotice>
  );
}
