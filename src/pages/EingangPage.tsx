import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DocumentsCapturePanel } from '../components/documents/DocumentsCapturePanel';
import { InboxCard } from '../components/inbox/InboxCard';
import { Button } from '../components/ui/Button';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { PageHeader } from '../components/ui/Card';
import { RowList, RowListItem } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { FilterChips } from '../components/ui/Toolbar';
import { useApp } from '../context/AppContext';
import {
  filterActiveItems,
  getInboxItems,
  getInboxSummary,
} from '../services/inboxService';
import { scanPendingItems } from '../services/pendingEngineService';
import type { InboxStatus, PendingHighlight } from '../types/models';
import type { TranslationKey } from '../i18n';

type InboxFilter = 'neu' | 'spaeter_klaeren' | 'all';

function formatHighlightLabel(highlight: PendingHighlight, translate: (key: TranslationKey) => string): string {
  let text = translate(highlight.labelKey as TranslationKey);
  if (highlight.params) {
    for (const [key, value] of Object.entries(highlight.params)) {
      text = text.replace(`{${key}}`, String(value));
    }
  }
  return text.replace('{count}', String(highlight.count));
}

/**
 * UIUX-FOUNDATION-01E — Eingang.
 *
 * Route bleibt `/ablage`. Struktur: Header (Titel, Zähler im Untertitel, eine
 * Hauptaktion „Dokument hinzufügen“) → Aufmerksamkeit (RowList aus dem
 * bestehenden Pending-Scan) → Aufnahmewege → Filter → Dokumentliste. Die
 * Dokumentzeile selbst bleibt die fachlich geprüfte `InboxCard`
 * (Primary-Action-/Review-Logik unverändert); der Filter arbeitet nur auf
 * den geladenen Einträgen.
 */
export function EingangPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState(() => filterActiveItems(getInboxItems()));
  const [pendingSummary, setPendingSummary] = useState(() => scanPendingItems().summary);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const summary = getInboxSummary();

  const refresh = useCallback(() => {
    setItems(filterActiveItems(getInboxItems()));
    setPendingSummary(scanPendingItems().summary);
  }, []);

  const handleReview = (id: string) => {
    navigate(`/ablage/${id}`);
  };

  const filterOptions = useMemo(() => {
    const countByStatus = (status: InboxStatus) => items.filter((item) => item.status === status).length;
    return [
      { id: 'all' as const, label: translate('ablage.filter.all'), count: items.length },
      { id: 'neu' as const, label: translate('ablage.filter.new'), count: countByStatus('neu') },
      { id: 'spaeter_klaeren' as const, label: translate('ablage.filter.later'), count: countByStatus('spaeter_klaeren') },
    ];
  }, [translate, items]);
  const visibleItems = filter === 'all' ? items : items.filter((item) => item.status === filter);

  return (
    <Page className="ablage-page" testId="ablage-page">
      <PageHeader
        title={translate('ablage.title')}
        subtitle={
          <>
            {translate('ablage.subtitle')}
            <span className="page-header__summary" data-testid="ablage-summary">
              {' · '}
              <strong>{summary.neu}</strong> {translate('ablage.newCount')} · <strong>{summary.urgent}</strong>{' '}
              {translate('ablage.urgentCount')}
            </span>
          </>
        }
        primaryAction={
          <Link to="/dokumente/hinzufuegen" data-testid="ablage-add-document">
            <Button fullWidth>{translate('ablage.addDocument')}</Button>
          </Link>
        }
      />

      {pendingSummary.highlights.length > 0 ? (
        <DetailSection title={translate('pending.title')} testId="ablage-attention">
          <RowList ariaLabel={translate('pending.title')}>
            {pendingSummary.highlights.map((highlight) => (
              <RowListItem
                key={highlight.id}
                icon="warning"
                title={formatHighlightLabel(highlight, translate)}
                onClick={() => navigate(highlight.route)}
                testId={`ablage-attention-${highlight.id}`}

              />
            ))}
          </RowList>
        </DetailSection>
      ) : null}

      <DocumentsCapturePanel />

      {items.length > 0 ? (
        <PageToolbar
          filters={<FilterChips options={filterOptions} value={filter} onChange={setFilter} label={translate('list.filter.label')} testIdPrefix="ablage-filter" />}
        />
      ) : null}

      <div className="card-list" id="eingang-list" data-testid="eingang-list">
        {items.length === 0 ? (
          <EmptyStateBlock
            title={translate('ablage.empty.title')}
            description={translate('ablage.empty.desc')}
            testId="ablage-empty-state"
          />
        ) : visibleItems.length === 0 ? (
          <EmptyStateBlock title={translate('list.noMatches.title')} description={translate('list.noMatches.desc')} testId="ablage-no-matches" />
        ) : (
          visibleItems.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              onReview={handleReview}
              onUpdated={refresh}
            />
          ))
        )}
      </div>
    </Page>
  );
}
