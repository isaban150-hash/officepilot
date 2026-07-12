import { Card, CardMeta, CardTitle } from '../ui/Card';
import { getDocumentDisplayLabelKey } from '../../services/documentDisplayLabelService';
import type { ClassifiedDocumentKind, DocumentAiAction, DocumentUnderstandingSummary } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface DocumentIntakeUnderstandingPanelProps {
  summary: DocumentUnderstandingSummary;
  actions?: DocumentAiAction[];
  translate: (key: TranslationKey) => string;
  titleKey?: TranslationKey;
}

function SummaryRow({ label, value }: { label: string; value?: string }) {
  if (!value?.trim()) return null;
  return (
    <div className="doc-understanding__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function DocumentIntakeUnderstandingPanel({
  summary,
  actions = [],
  translate,
  titleKey = 'document.intakeUnderstanding.title',
}: DocumentIntakeUnderstandingPanelProps) {
  const kindKey = getDocumentDisplayLabelKey(summary.documentType as ClassifiedDocumentKind);

  return (
    <Card className="doc-understanding-panel" highlight data-testid="document-intake-understanding">
      <CardTitle>{translate(titleKey)}</CardTitle>
      {summary.partialRecognition && (
        <CardMeta data-testid="document-partial-hint">
          {translate('document.intakeUnderstanding.partialHint')}
        </CardMeta>
      )}
      {summary.uncertainFields && summary.uncertainFields.length > 0 && (
        <CardMeta data-testid="document-uncertain-hint">
          {translate('document.intakeUnderstanding.uncertainHint')}
        </CardMeta>
      )}

      <dl className="doc-understanding__list">
        <SummaryRow label={translate('document.intakeUnderstanding.documentType')} value={translate(kindKey)} />
        <SummaryRow label={translate('document.intakeUnderstanding.sender')} value={summary.sender} />
        <SummaryRow label={translate('document.intakeUnderstanding.recipient')} value={summary.recipient} />
        <SummaryRow label={translate('document.intakeUnderstanding.date')} value={summary.date} />
        <SummaryRow label={translate('document.intakeUnderstanding.reference')} value={summary.referenceNumber} />
        <SummaryRow label={translate('document.intakeUnderstanding.constructionSite')} value={summary.constructionSite} />
        <SummaryRow label={translate('document.intakeUnderstanding.customer')} value={summary.customer} />
        <SummaryRow label={translate('document.intakeUnderstanding.vorgang')} value={summary.vorgang} />
        <SummaryRow label={translate('document.intakeUnderstanding.invoiceNumber')} value={summary.invoiceNumber} />
        <SummaryRow label={translate('document.intakeUnderstanding.amount')} value={summary.amount} />
        <SummaryRow label={translate('document.intakeUnderstanding.deadline')} value={summary.deadline} />
        <SummaryRow label={translate('document.understanding.nextStep')} value={summary.nextStep} />
      </dl>

      {actions.length > 0 && (
        <div className="doc-understanding__actions">
          <h4 className="doc-understanding__actions-title">{translate('document.intakeUnderstanding.aiActions')}</h4>
          <ul className="doc-understanding__action-list">
            {actions.map((action) => (
              <li
                key={action.id}
                className={`doc-understanding__action ${action.recommended ? 'doc-understanding__action--recommended' : ''}`}
              >
                <span aria-hidden>✓</span>
                {translate(action.labelKey as TranslationKey)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
