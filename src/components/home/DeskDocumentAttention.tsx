import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { filterActiveItems, getInboxItems } from '../../services/inboxService';
import { buildSummaryForInboxItem } from '../../services/documentSummaryPresentation';
import { DocumentSummaryCompactCard } from '../documents/DocumentSummaryCompactCard';
import { Card, CardTitle } from '../ui/Card';

/**
 * DOCUMENT-SUMMARY-ROLL-OUT — "Heute beachten" document snippets.
 * Same DocumentSummary language as Inbox / Experience Card.
 */
export function DeskDocumentAttention() {
  const { translate, language } = useApp();
  const navigate = useNavigate();

  const items = useMemo(() => {
    return filterActiveItems(getInboxItems())
      .filter((item) => item.status === 'neu' || item.status === 'spaeter_klaeren')
      .slice(0, 3);
  }, []);

  const cards = useMemo(
    () =>
      items.map((item) => ({
        item,
        summary: buildSummaryForInboxItem(item, { translate, language }),
      })),
    [items, translate, language],
  );

  if (cards.length === 0) return null;

  return (
    <Card className="desk-document-attention" data-testid="desk-document-attention">
      <CardTitle>{translate('pending.title')}</CardTitle>
      <div className="desk-document-attention__list">
        {cards.map(({ item, summary }) => (
          <DocumentSummaryCompactCard
            key={item.id}
            summary={summary}
            translate={translate}
            maxFacts={3}
            cardTestId={`desk-attention-${item.id}`}
            onPrimaryClick={() => {
              if (
                summary.primaryAction.id === 'open_vorgang' &&
                summary.caseMatch?.matchedCaseId
              ) {
                navigate(`/vorgaenge/${summary.caseMatch.matchedCaseId}`);
                return;
              }
              navigate(`/ablage/${item.id}`);
            }}
            onAction={(actionId) => {
              if (actionId === 'later') {
                navigate('/ablage');
                return;
              }
              if (actionId === 'open_vorgang' && summary.caseMatch?.matchedCaseId) {
                navigate(`/vorgaenge/${summary.caseMatch.matchedCaseId}`);
                return;
              }
              navigate(`/ablage/${item.id}`);
            }}
          />
        ))}
      </div>
    </Card>
  );
}
