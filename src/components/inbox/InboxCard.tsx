import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { deferItem } from '../../services/inboxService';
import { buildSummaryForInboxItem } from '../../services/documentSummaryPresentation';
import { formatInboxActionToast } from '../../utils/inboxActionToast';
import type { InboxItem } from '../../types/models';
import type { DocumentSummaryActionId } from '../../types/documentSummary';
import { DocumentExperienceCard } from './review/DocumentExperienceCard';

interface InboxCardProps {
  item: InboxItem;
  onReview: (id: string) => void;
  onUpdated: () => void;
}

/**
 * DOCUMENT-INBOX-SUMMARY-01 — list card from DocumentSummary only.
 * Same visual language as Experience Card; filing/priority live in detail view.
 */
export function InboxCard({ item, onReview, onUpdated }: InboxCardProps) {
  const { translate, language, showToast } = useApp();
  const navigate = useNavigate();

  const summary = useMemo(
    () => buildSummaryForInboxItem(item, { translate, language }),
    [item, translate, language],
  );

  const handleAction = (actionId: DocumentSummaryActionId) => {
    if (actionId === 'later') {
      const result = deferItem(item.id);
      if (result) {
        showToast(formatInboxActionToast(result, translate));
        if (result.success) onUpdated();
      }
      return;
    }
    if (actionId === 'open_vorgang') {
      const matchedId = summary.caseMatch?.matchedCaseId ?? item.vorgangId;
      if (matchedId) {
        navigate(`/vorgaenge/${matchedId}`);
        return;
      }
    }
    // link / select / create / review — open detail; user decides there (no auto-link).
    onReview(item.id);
  };

  return (
    <DocumentExperienceCard
      summary={summary}
      translate={translate}
      onAction={handleAction}
      headerMode="headline-only"
      className="inbox-card document-experience-card--inbox"
      cardTestId={`inbox-card-${item.id}`}
      actionUi={{
        [summary.primaryAction.id]: {
          testId: `inbox-review-${item.id}`,
        },
        later: {
          testId: `inbox-later-${item.id}`,
          variant: 'ghost',
        },
      }}
    />
  );
}
