import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { filterActiveItems, getInboxItems } from '../../services/inboxService';
import { buildSummaryForInboxItem } from '../../services/documentSummaryPresentation';
import {
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
} from '../../services/documentWorkResultService';
import { getCustomerById } from '../../services/customerStoreService';
import { getVorgangById } from '../../services/vorgangService';
import { DocumentSummaryCompactCard } from '../documents/DocumentSummaryCompactCard';
import { Button } from '../ui/Button';
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

  /**
   * DASHBOARD-CONTRACT-CARD-FIELD-MAPPING-01B1 — only already stored data.
   * No analysis is started here: the stored snapshot's BusinessInterpretation is
   * used as-is (a snapshot carries no proposal), and the customer is resolved
   * strictly via Vorgang.customerId.
   */
  const cards = useMemo(
    () =>
      items.map((item) => {
        const snapshot = getDocumentWorkResultForItem(item.id);
        const displayBusinessInterpretation =
          snapshot && isDocumentWorkResultUsableForDisplay(snapshot, item)
            ? snapshot.businessInterpretation ?? null
            : null;

        const vorgang = item.vorgangId ? getVorgangById(item.vorgangId) ?? null : null;
        const customerId = vorgang?.customerId?.trim();
        // Confirm-first: only a linked customer that still exists counts.
        const confirmedCustomerName = customerId
          ? getCustomerById(customerId)?.name ?? null
          : null;

        return {
          item,
          summary: buildSummaryForInboxItem(item, {
            translate,
            language,
            displayBusinessInterpretation,
            confirmedCustomerName,
          }),
        };
      }),
    [items, translate, language],
  );

  if (cards.length === 0) return null;

  return (
    <Card className="desk-document-attention" data-testid="desk-document-attention">
      <CardTitle>{translate('pending.title')}</CardTitle>
      <div className="desk-document-attention__list">
        {cards.map(({ item, summary }) => (
          <div className="inbox-card-shell" key={item.id}>
            <DocumentSummaryCompactCard
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
            {/* DOCUMENT-INBOX-DELETE-01 — explicit way into the detail page. */}
            <Button
              variant="ghost"
              size="sm"
              className="document-open-link"
              onClick={() => navigate(`/ablage/${item.id}`)}
              data-testid={`desk-open-document-${item.id}`}
            >
              {translate('inbox.openDocument')}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
