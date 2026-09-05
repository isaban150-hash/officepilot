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
  /**
   * DUNNING-CHECK-PAYMENT-EXECUTION-01B — der ehrliche nächste Schritt, wenn es
   * nichts zu verknüpfen gibt: die vorhandene Ausgabenübersicht. Keine neue
   * Suche.
   */
  onBrowseExpenses?: () => void;
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
  onBrowseExpenses,
}: DocumentFinanceReferencePanelProps) {
  const { matched, status } = match;
  // Verknüpfen darf nur, was eindeutig **und** noch nicht verbunden ist.
  const canLink = status === 'exact' && matched !== null;
  /*
   * DUNNING-CHECK-PAYMENT-EXECUTION-01B — bei mehreren Treffern liegen die
   * Kandidaten längst vor; sie wurden bisher nur nicht gezeigt. Der Nutzer sah
   * „Mehrere Rechnungen passen" und hatte keinen Weg weiter.
   *
   * Gezeigt wird die vorhandene Reihenfolge des Resolvers — **keine** neue
   * Rangfolge, keine Vorauswahl, keine automatische Verknüpfung. Wer zuordnet,
   * tut das bewusst über denselben Confirm-first-Weg wie im eindeutigen Fall.
   */
  const showCandidates = status === 'ambiguous' && match.candidates.length > 0;
  /*
   * Wo es nichts zu verknüpfen gibt, ist die ehrliche Hilfe der Blick in die
   * vorhandenen Ausgaben — nicht eine leere Auswahl.
   */
  const showBrowse =
    Boolean(onBrowseExpenses) && (status === 'not_found' || status === 'conflict');

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

      {showCandidates ? (
        <div data-testid="document-finance-reference-candidates">
          <p className="document-finance-reference__hint">
            {translate('financeReference.chooseInvoice')}
          </p>
          {match.candidates.map((candidate) => (
            <div
              key={candidate.targetId}
              className="document-finance-reference__candidate"
              data-testid={`document-finance-reference-candidate-${candidate.targetId}`}
            >
              <DataRow
                label={translate('expense.fieldSupplier')}
                value={candidate.supplierName}
              />
              <DataRow
                label={translate('expense.fieldInvoiceNumber')}
                value={candidate.invoiceNumber}
              />
              <DataRow
                label={translate('expense.fieldGrossAmount')}
                value={money(candidate.grossAmount)}
              />
              <DataRow
                label={translate('financeReference.openAmount')}
                value={money(candidate.openAmount)}
              />
              <Button
                variant="outline"
                fullWidth
                data-testid={`document-finance-reference-candidate-open-${candidate.targetId}`}
                onClick={() => onOpenTarget(candidate.targetId)}
              >
                {translate('financeReference.open')}
              </Button>
              <Button
                fullWidth
                data-testid={`document-finance-reference-candidate-link-${candidate.targetId}`}
                onClick={() => onConfirmLink(candidate.targetId)}
              >
                {translate('financeReference.link')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {showBrowse ? (
        <Button
          variant="outline"
          fullWidth
          data-testid="document-finance-reference-browse"
          onClick={() => onBrowseExpenses?.()}
        >
          {translate('financeReference.browseExpenses')}
        </Button>
      ) : null}
    </Card>
  );
}
