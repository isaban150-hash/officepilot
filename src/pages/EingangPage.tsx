import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DocumentsCapturePanel } from '../components/documents/DocumentsCapturePanel';
import { PendingAttentionCard } from '../components/dashboard/PendingAttentionCard';
import { InboxCard } from '../components/inbox/InboxCard';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  filterActiveItems,
  getInboxItems,
  getInboxSummary,
} from '../services/inboxService';
import { scanPendingItems } from '../services/pendingEngineService';

export function EingangPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState(() => filterActiveItems(getInboxItems()));
  const [pendingSummary, setPendingSummary] = useState(() => scanPendingItems().summary);
  const summary = getInboxSummary();

  const refresh = useCallback(() => {
    setItems(filterActiveItems(getInboxItems()));
    setPendingSummary(scanPendingItems().summary);
  }, []);

  const handleReview = (id: string) => {
    navigate(`/ablage/${id}`);
  };

  return (
    <div className="page ablage-page" data-testid="ablage-page">
      <PageHeader
        title={translate('ablage.title')}
        subtitle={translate('ablage.subtitle')}
      />

      <DocumentsCapturePanel />

      <PendingAttentionCard summary={pendingSummary} />

      <div className="ablage-summary">
        <span className="ablage-summary__stat">
          <strong>{summary.neu}</strong> {translate('ablage.newCount')}
        </span>
        <span className="ablage-summary__divider">·</span>
        <span className="ablage-summary__stat ablage-summary__stat--urgent">
          <strong>{summary.urgent}</strong> {translate('ablage.urgentCount')}
        </span>
      </div>

      <p className="ablage-intro">{translate('ablage.intro')}</p>

      <div className="card-list" id="eingang-list" data-testid="eingang-list">
        {items.length === 0 ? (
          <EmptyStateBlock
            title={translate('ablage.empty.title')}
            description={translate('ablage.empty.desc')}
            testId="ablage-empty-state"
          />
        ) : (
          items.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              onReview={handleReview}
              onUpdated={refresh}
            />
          ))
        )}
      </div>
    </div>
  );
}
