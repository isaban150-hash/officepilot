import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { buildDocumentExplanation } from '../../services/memory/documentExplanationService';
import { getDocumentUnderstanding } from '../../services/memory/documentUnderstandingService';
import type { TranslationKey } from '../../i18n';

interface DocumentUnderstandingCardProps {
  documentId: string;
}

function formatMemoryStatus(
  status: 'understood' | 'partial' | 'pending' | undefined,
  translate: (key: TranslationKey) => string,
): string {
  switch (status) {
    case 'understood':
      return translate('document.understanding.status.understood');
    case 'partial':
      return translate('document.understanding.status.partial');
    default:
      return translate('document.understanding.status.pending');
  }
}

export function DocumentUnderstandingCard({ documentId }: DocumentUnderstandingCardProps) {
  const { translate } = useApp();
  const memory = getDocumentUnderstanding(documentId);
  const explanation = buildDocumentExplanation({ documentId });

  if (!explanation && !memory?.summary && !memory?.letterExplanation) {
    return null;
  }

  if (!explanation) {
    return null;
  }

  const requiredDocs =
    explanation.requiredDocuments.length === 1 &&
    explanation.requiredDocuments[0] === 'Keine zusätzlichen Unterlagen erkannt.'
      ? translate('document.understanding.noRequiredDocuments')
      : explanation.requiredDocuments.join(' · ');

  const deadlineText =
    explanation.deadline === 'Keine Frist erkannt.'
      ? translate('document.understanding.noDeadline')
      : explanation.deadline;

  return (
    <div
      className="detail-experience-card document-understanding-card"
      data-testid="document-understanding-card"
    >
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('document.understanding.title')}</CardTitle>
        <CardMeta>{formatMemoryStatus(memory?.memoryStatus, translate)}</CardMeta>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.understanding.shortSummary')}
          </h3>
          <p className="detail-experience-section__value">{explanation.shortAnswer}</p>
        </section>

        <section className="detail-experience-section document-understanding-meta">
          <p className="document-understanding-meta__line">
            <span className="document-understanding-meta__label">
              {translate('document.understanding.actionRequired')}
            </span>
            {explanation.actionRequired}
          </p>
          <p className="document-understanding-meta__line">
            <span className="document-understanding-meta__label">
              {translate('document.understanding.deadline')}
            </span>
            {deadlineText}
          </p>
          <p className="document-understanding-meta__line">
            <span className="document-understanding-meta__label">
              {translate('document.understanding.requiredDocuments')}
            </span>
            {requiredDocs}
          </p>
          <p className="document-understanding-meta__line">
            <span className="document-understanding-meta__label">
              {translate('document.understanding.risk')}
            </span>
            {explanation.risk}
          </p>
        </section>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.understanding.recommendation')}
          </h3>
          <p className="detail-experience-section__value detail-experience-section__value--assistant">
            {explanation.recommendation}
          </p>
        </section>

        <section className="detail-experience-section detail-experience-section--paper">
          <h3 className="detail-experience-section__label">
            {translate('document.understanding.filing')}
          </h3>
          <p className="detail-experience-section__value document-understanding-filing__digital">
            {explanation.digitalLocation}
          </p>
          <p className="detail-experience-section__value">
            {explanation.paperLocation}
            {explanation.register !== '—' ? ` · Register ${explanation.register}` : ''}
          </p>
          <p className="detail-experience-section__value">{explanation.originalFiledStatus}</p>
        </section>

        {explanation.nextSteps.length > 0 && (
          <section className="detail-experience-section">
            <h3 className="detail-experience-section__label">
              {translate('document.understanding.nextSteps')}
            </h3>
            <ul className="document-understanding-steps">
              {explanation.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </section>
        )}

        {explanation.uncertaintyNote && (
          <p className="document-understanding-disclaimer">{explanation.uncertaintyNote}</p>
        )}
        <p className="document-understanding-disclaimer">{explanation.disclaimer}</p>
      </Card>
    </div>
  );
}
