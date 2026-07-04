import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { formatPaperFilingInstruction } from '../../services/paperFolderService';
import { getDocumentUnderstanding } from '../../services/memory/documentUnderstandingService';
import type { MemoryRiskLevel } from '../../types/memory';
import type { TranslationKey } from '../../i18n';

interface DocumentUnderstandingCardProps {
  documentId: string;
}

function formatRiskLabel(
  riskLevel: MemoryRiskLevel | undefined,
  translate: (key: TranslationKey) => string,
): string {
  switch (riskLevel) {
    case 'high':
      return translate('document.understanding.risk.high');
    case 'medium':
      return translate('document.understanding.risk.medium');
    case 'low':
      return translate('document.understanding.risk.low');
    default:
      return translate('document.understanding.risk.unknown');
  }
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

  if (!memory?.summary && !memory?.letterExplanation) {
    return null;
  }

  const summary = memory.summary;
  const explanation = memory.letterExplanation;
  const shortText = summary?.shortSummary ?? explanation?.shortExplanation ?? '—';
  const deadline =
    summary?.deadline ??
    (explanation?.deadline !== 'Keine Frist erkannt.' ? explanation?.deadline : null);
  const nextStep = summary?.nextAction ?? explanation?.recommendation ?? '—';
  const digitalLocation =
    explanation?.digitalStorage ?? `${memory.digitalFolder.name} (${memory.digitalFolder.path})`;
  const paperLocation =
    explanation?.paperStorage ??
    (memory.paperFolder?.folderId || memory.paperFolder?.label
      ? formatPaperFilingInstruction(memory.paperFolder)
      : translate('document.understanding.paperUnknown'));
  const riskLabel = formatRiskLabel(summary?.riskLevel ?? memory.riskLevel, translate);
  const deadlineText = deadline ?? translate('document.understanding.noDeadline');

  return (
    <div className="detail-experience-card document-understanding-card" data-testid="document-understanding-card">
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('document.understanding.title')}</CardTitle>
        <CardMeta>{formatMemoryStatus(memory.memoryStatus, translate)}</CardMeta>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.understanding.shortSummary')}
          </h3>
          <p className="detail-experience-section__value">{shortText}</p>
        </section>

        <section className="detail-experience-section document-understanding-meta">
          <p className="document-understanding-meta__line">
            <span className="document-understanding-meta__label">
              {translate('document.understanding.deadline')}
            </span>
            {deadlineText}
          </p>
          <p className="document-understanding-meta__line">
            <span className="document-understanding-meta__label">
              {translate('document.understanding.risk')}
            </span>
            {riskLabel}
          </p>
        </section>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.understanding.nextStep')}
          </h3>
          <p className="detail-experience-section__value detail-experience-section__value--assistant">
            {nextStep}
          </p>
        </section>

        <section className="detail-experience-section detail-experience-section--paper">
          <h3 className="detail-experience-section__label">
            {translate('document.understanding.filing')}
          </h3>
          <p className="detail-experience-section__value document-understanding-filing__digital">
            {digitalLocation}
          </p>
          <p className="detail-experience-section__value">{paperLocation}</p>
        </section>
      </Card>
    </div>
  );
}
