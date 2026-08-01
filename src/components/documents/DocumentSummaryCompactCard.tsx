import type { DocumentSummary } from '../../types/documentSummary';
import type { DocumentSummaryActionId } from '../../types/documentSummary';
import type { TranslationKey } from '../../i18n';
import { DocumentExperienceCard } from '../inbox/review/DocumentExperienceCard';

export type DocumentSummaryCompactCardProps = {
  summary: DocumentSummary;
  translate: (key: TranslationKey) => string;
  onAction?: (actionId: DocumentSummaryActionId) => void;
  onPrimaryClick?: () => void;
  className?: string;
  cardTestId?: string;
  /** Max facts shown (default 4 for dense lists). */
  maxFacts?: number;
};

/**
 * Compact list/snippet card — DocumentSummary only, shared Experience Card chrome.
 */
export function DocumentSummaryCompactCard({
  summary,
  translate,
  onAction,
  onPrimaryClick,
  className,
  cardTestId = 'document-summary-compact',
  maxFacts = 4,
}: DocumentSummaryCompactCardProps) {
  const trimmed: DocumentSummary = {
    ...summary,
    facts: summary.facts.slice(0, maxFacts),
    details: [],
  };

  return (
    <DocumentExperienceCard
      summary={trimmed}
      translate={translate}
      headerMode="headline-only"
      className={['document-summary-compact', className].filter(Boolean).join(' ')}
      cardTestId={cardTestId}
      onAction={(actionId) => {
        if (actionId === trimmed.primaryAction.id && onPrimaryClick) {
          onPrimaryClick();
          return;
        }
        onAction?.(actionId);
      }}
      actionUi={{
        [trimmed.primaryAction.id]: {
          testId: `${cardTestId}-primary`,
        },
        later: {
          testId: `${cardTestId}-later`,
          variant: 'ghost',
          hidden: !trimmed.secondaryActions.some((a) => a.id === 'later'),
        },
      }}
    />
  );
}
