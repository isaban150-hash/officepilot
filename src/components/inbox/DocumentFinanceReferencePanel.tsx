/**
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — die Belegprüfung für Mahnungen und
 * Zahlungserinnerungen.
 *
 * Bewusst schmal: eine Karte, die zeigt, was gefunden wurde, und genau zwei
 * mögliche Handlungen — den Beleg öffnen und die Verbindung **bestätigen**.
 * Keine Zahlungsaktion, keine Buchung, keine Ausgabenanlage. Bei „bereits
 * bezahlt" bleibt ausschliesslich der Hinweis und der Weg zur Rechnung.
 */
import { Button } from '../ui/Button';
import { Card, CardTitle, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import type { DocumentFinanceReferenceMatch } from '../../services/documentFinanceReferenceService';

const STATUS_TEXT: Record<DocumentFinanceReferenceMatch['status'], TranslationKey> = {
  exact: 'financeReference.exact',
  paid_conflict: 'financeReference.paidConflict',
  already_linked: 'financeReference.alreadyLinked',
  ambiguous: 'financeReference.ambiguous',
  not_found: 'financeReference.notFound',
  conflict: 'financeReference.conflict',
};

interface DocumentFinanceReferencePanelProps {
  match: DocumentFinanceReferenceMatch;
  translate: (key: TranslationKey) => string;
  onOpenTarget: (targetId: string) => void;
  onConfirmLink: (targetId: string) => void;
}

function money(value: number): string {
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export function DocumentFinanceReferencePanel({
  match,
  translate,
  onOpenTarget,
  onConfirmLink,
}: DocumentFinanceReferencePanelProps) {
  const { matched, status } = match;
  // Verknüpfen darf nur, was eindeutig **und** noch nicht verbunden ist.
  const canLink = status === 'exact' && matched !== null;

  return (
    <Card className="document-finance-reference" data-testid="document-finance-reference">
      <CardTitle>{translate('financeReference.title')}</CardTitle>
      <p data-testid="document-finance-reference-status">{translate(STATUS_TEXT[status])}</p>

      {matched ? (
        <div data-testid="document-finance-reference-target">
          <DataRow label={translate('expense.fieldSupplier')} value={matched.supplierName} />
          <DataRow
            label={translate('expense.fieldInvoiceNumber')}
            value={matched.invoiceNumber}
          />
          <DataRow
            label={translate('expense.fieldGrossAmount')}
            value={money(matched.grossAmount)}
          />
          <DataRow
            label={translate('financeReference.paidAmount')}
            value={money(matched.paidAmount)}
          />
          <DataRow
            label={translate('financeReference.openAmount')}
            value={money(matched.openAmount)}
          />
        </div>
      ) : null}

      {match.amountMismatch ? (
        <p
          className="invoice-hint invoice-hint--warning"
          data-testid="document-finance-reference-amount-mismatch"
        >
          {translate('financeReference.amountMismatch')}
        </p>
      ) : null}

      {matched ? (
        <Button
          variant="outline"
          fullWidth
          data-testid="document-finance-reference-open"
          onClick={() => onOpenTarget(matched.targetId)}
        >
          {translate('financeReference.open')}
        </Button>
      ) : null}

      {canLink ? (
        <Button
          fullWidth
          data-testid="document-finance-reference-link"
          onClick={() => onConfirmLink(matched!.targetId)}
        >
          {translate('financeReference.link')}
        </Button>
      ) : null}
    </Card>
  );
}
