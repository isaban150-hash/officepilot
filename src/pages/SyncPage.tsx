import { useCallback, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Badge, DataRow, PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection, SummaryList } from '../components/ui/Section';
import { InlineNotice } from '../components/ui/States';
import { RowList, RowListItem } from '../components/ui/Lists';
import { useApp } from '../context/AppContext';
import type { SyncOutboxEntry, SyncState } from '../types/sync';
import type { TranslationKey } from '../i18n';
import {
  getSyncUiSnapshot,
  summarizeSyncStatus,
  type SyncStatusSummary,
  isLocalOnlySyncMode,
  retrySyncFromUi,
  runSyncFromUi,
  shortenSyncId,
  type SyncUiSnapshot,
} from '../services/sync/syncUiService';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { isSupabaseSyncAllowed } from '../services/sync/cloudSyncAllowlist';
import { enqueueIntakeBackfill, planIntakeBackfill } from '../services/document/intakeCloudBackfillService';

const SYNCING_STATES: SyncState[] = ['checking', 'uploading', 'downloading', 'merging'];

/* REAL-PRODUCT-TEST-01D — Gründe für wartende/fehlgeschlagene Einträge in Nutzersprache. */
function blockedReasonKey(entry: SyncOutboxEntry): TranslationKey | null {
  if (!isSupabaseSyncAllowed(entry.entityType)) return 'sync.outboxReason.localOnly';
  if (entry.status === 'error' || entry.status === 'failed') return 'sync.outboxReason.failed';
  if (entry.status !== 'blocked') return null;
  return entry.blockedReason === 'beta_mode' ? 'sync.outboxReason.betaMode' : 'sync.outboxReason.versionConflict';
}

function resolutionKey(resolution: string): TranslationKey {
  const map: Record<string, TranslationKey> = {
    remote_wins: 'sync.resolution.remoteWins',
    local_wins: 'sync.resolution.localWins',
    union: 'sync.resolution.union',
    conflict: 'sync.resolution.conflict',
    noop: 'sync.resolution.noop',
  };
  return map[resolution] ?? 'sync.resolution.conflict';
}

function entityTypeKey(entityType: string): TranslationKey {
  const map: Record<string, TranslationKey> = {
    document: 'sync.entity.document',
    document_file: 'sync.entity.document_file',
    document_file_binding: 'sync.entity.document_file_binding',
    document_work_result: 'sync.entity.document_work_result',
    expense: 'sync.entity.expense',
    expense_payment: 'sync.entity.expense_payment',
    inbox_item: 'sync.entity.inbox_item',
    task: 'sync.entity.task',
    vorgang: 'sync.entity.vorgang',
    invoice: 'sync.entity.invoice',
  };
  return map[entityType] ?? 'sync.entity.other';
}

function operationKey(operation: string): TranslationKey {
  const map: Record<string, TranslationKey> = {
    create: 'sync.operation.create',
    update: 'sync.operation.update',
    delete: 'sync.operation.delete',
  };
  return map[operation] ?? 'sync.operation.update';
}

function outboxStatusKey(status: SyncOutboxEntry['status']): TranslationKey {
  const map: Record<string, TranslationKey> = {
    blocked: 'sync.outboxStatus.blocked',
    pending: 'sync.outboxStatus.pending',
    error: 'sync.outboxStatus.error',
    failed: 'sync.outboxStatus.error',
  };
  return map[status] ?? 'sync.outboxStatus.pending';
}

function statusTone(kind: SyncStatusSummary['kind']): 'default' | 'success' | 'warning' | 'info' {
  if (kind === 'offline' || kind === 'syncing') return 'info';
  if (kind === 'synced') return 'success';
  if (kind === 'failed' || kind === 'waiting') return 'warning';
  return 'default';
}

/** Verständlicher Gesamtstatus statt reinem Engine-Zustand. */
function statusLabelFor(
  summary: SyncStatusSummary,
  syncState: SyncState,
  translate: (key: TranslationKey) => string,
): string {
  switch (summary.kind) {
    case 'synced':
      return translate('sync.summary.synced');
    case 'waiting':
      return summary.waitingCount === 1
        ? translate('sync.summary.waitingOne')
        : translate('sync.summary.waiting').replace('{count}', String(summary.waitingCount));
    case 'failed':
      return summary.failedCount === 1
        ? translate('sync.summary.failedOne')
        : summary.failedCount > 1
          ? translate('sync.summary.failed').replace('{count}', String(summary.failedCount))
          : translate('sync.status.error');
    default:
      return translate(`sync.status.${syncState}` as TranslationKey);
  }
}

function formatTimestamp(value?: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString('de-DE');
}

export function SyncPage() {
  const { translate, showToast } = useApp();
  const [snapshot, setSnapshot] = useState<SyncUiSnapshot>(() => getSyncUiSnapshot());
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setSnapshot(getSyncUiSnapshot());
  }, []);

  const handleSync = async () => {
    setBusy(true);
    try {
      const before = getSyncUiSnapshot();
      const report = await runSyncFromUi();
      refresh();
      if (isLocalOnlySyncMode(before)) {
        showToast(translate('sync.feedback.localOnly'));
      } else if (report.errorCount > 0) {
        showToast(translate('sync.feedback.error'));
      } else {
        showToast(translate('sync.feedback.success'));
      }
    } catch {
      refresh();
      showToast(translate('sync.feedback.error'));
    } finally {
      setBusy(false);
    }
  };

  /*
   * FINANZ-CORE-DURABILITY-01B — Backfill: bestehende lokale Belege einmalig in
   * die Outbox stellen und sofort synchronisieren. Idempotent; lokale Daten
   * bleiben unveraendert.
   */
  const handleBackfill = async () => {
    const plan = planIntakeBackfill(buildPersistedStateSnapshot());
    if (plan.entries.length === 0) {
      showToast(translate('sync.backfill.nothing'));
      return;
    }
    const queued = enqueueIntakeBackfill(plan);
    showToast(translate('sync.backfill.queued').replace('{count}', String(queued)));
    await handleSync();
  };

  const handleRetry = async () => {
    setBusy(true);
    try {
      const report = await retrySyncFromUi();
      refresh();
      if (report.errorCount > 0) {
        showToast(translate('sync.feedback.retryError'));
      } else {
        showToast(translate('sync.feedback.retrySuccess'));
      }
    } catch {
      refresh();
      showToast(translate('sync.feedback.retryError'));
    } finally {
      setBusy(false);
    }
  };

  const summary = summarizeSyncStatus(snapshot);
  const statusLabel = statusLabelFor(summary, snapshot.status.syncState, translate);
  const tone = statusTone(summary.kind);
  const isSyncing = busy || SYNCING_STATES.includes(snapshot.status.syncState);
  const report = snapshot.lastReport;

  return (
    <Page className="sync-page" testId="sync-page">
      <PageHeader
        title={translate('sync.title')}
        subtitle={translate('sync.subtitle')}
        backLabel={translate('common.back')}
        backHref="/mehr"
        backTestId="sync-back"
      />

      {/* UIUX-FOUNDATION-01G — Sync-Seite auf Sections/Notices; Sync-Logik unverändert. */}
      <InlineNotice tone={snapshot.isOffline ? 'warning' : 'info'} testId="sync-mode-notice">
        <span data-testid="sync-mode-label">{translate('sync.mode.localPrepared')}</span>
        <br />
        <span data-testid="sync-no-cloud-hint">{translate('sync.noCloudDataHint')}</span>
        {snapshot.isOffline && (
          <>
            <br />
            <span data-testid="sync-offline-hint">{translate('sync.offlineHint')}</span>
          </>
        )}
      </InlineNotice>

      <DetailSection
        title={translate('sync.section.status')}
        action={
          <span data-testid="sync-status-badge">
            <Badge tone={tone}>{statusLabel}</Badge>
          </span>
        }
        surface
      >
        <SummaryList columns={1}>
          <DataRow label={translate('sync.lastSync')} value={formatTimestamp(snapshot.status.lastSyncedAt)} />
        </SummaryList>
        {summary.kind === 'waiting' && (
          <InlineNotice tone="warning" testId="sync-waiting-notice">
            {summary.waitingCount === 1
              ? translate('sync.summary.waitingHintOne')
              : translate('sync.summary.waitingHint').replace('{count}', String(summary.waitingCount))}
          </InlineNotice>
        )}
        {summary.mergedCount > 0 && (
          <InlineNotice tone="info" testId="sync-merged-notice">
            {summary.mergedCount === 1
              ? translate('sync.summary.mergedOne')
              : translate('sync.summary.merged').replace('{count}', String(summary.mergedCount))}
          </InlineNotice>
        )}
        {snapshot.status.lastError && (
          <InlineNotice tone="critical" testId="sync-error-message">
            {translate('sync.error.userMessage')}
          </InlineNotice>
        )}
      </DetailSection>

      <DetailSection title={translate('sync.section.device')}>
        <SummaryList>
        <DataRow
          label={translate('sync.deviceId')}
          value={
            <span data-testid="sync-device-id">{shortenSyncId(snapshot.deviceId)}</span>
          }
        />
        <DataRow
          label={translate('sync.workspaceId')}
          value={
            <span data-testid="sync-workspace-id">{shortenSyncId(snapshot.workspaceId)}</span>
          }
        />
        </SummaryList>
      </DetailSection>

      <DetailSection title={translate('sync.section.outbox')}>
        <div className="sync-page__outbox-grid" data-testid="sync-outbox-counts">
          <div className="sync-page__outbox-stat">
            <span className="sync-page__outbox-value">{snapshot.outboxCounts.pending}</span>
            <span className="sync-page__outbox-label">{translate('sync.outbox.pending')}</span>
          </div>
          <div className="sync-page__outbox-stat">
            <span className="sync-page__outbox-value">{snapshot.outboxCounts.completed}</span>
            <span className="sync-page__outbox-label">{translate('sync.outbox.completed')}</span>
          </div>
          <div className="sync-page__outbox-stat">
            <span className="sync-page__outbox-value">{snapshot.outboxCounts.error}</span>
            <span className="sync-page__outbox-label">{translate('sync.outbox.error')}</span>
          </div>
        </div>
        {snapshot.pendingOutboxEntries.length > 0 && (
          <RowList testId="sync-outbox-pending-list">
            {snapshot.pendingOutboxEntries.map((entry) => (
              <RowListItem
                key={entry.id}
                title={translate(entityTypeKey(entry.entityType))}
                description={[translate(operationKey(entry.operation)), blockedReasonKey(entry) ? translate(blockedReasonKey(entry)!) : null]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={
                  <Badge tone={!isSupabaseSyncAllowed(entry.entityType) ? 'default' : entry.status === 'blocked' ? 'warning' : 'info'}>
                    {!isSupabaseSyncAllowed(entry.entityType) ? translate('sync.outboxStatus.localOnly') : translate(outboxStatusKey(entry.status))}
                  </Badge>
                }
              />
            ))}
          </RowList>
        )}
      </DetailSection>

      {(report || snapshot.status.lastError) && (
        <DetailSection title={translate('sync.section.report')} testId="sync-report-section">
          {report && (
            <SummaryList>
              <DataRow label={translate('sync.report.uploads')} value={report.uploadCount} />
              <DataRow label={translate('sync.report.downloads')} value={report.downloadCount} />
              <DataRow label={translate('sync.report.merged')} value={report.conflictCount} />
              <DataRow label={translate('sync.report.retry')} value={report.retryAttempts} />
            </SummaryList>
          )}
          {report && report.conflicts.length > 0 && (
            /* Automatisch behandelte Konflikte verständlich: was, und wie entschieden. */
            <RowList testId="sync-report-conflicts">
              {report.conflicts.map((conflict, index) => (
                <RowListItem
                  key={`${conflict.entityType}-${conflict.entityId}-${index}`}
                  title={translate(entityTypeKey(conflict.entityType))}
                  description={translate(resolutionKey(conflict.resolution))}
                />
              ))}
            </RowList>
          )}
        </DetailSection>
      )}

      <div className="sync-page__actions">
        <Button
          type="button"
          fullWidth
          disabled={isSyncing}
          data-testid="sync-run-button"
          onClick={() => void handleSync()}
        >
          {isSyncing ? translate('sync.action.running') : translate('sync.action.run')}
        </Button>

        {!isLocalOnlySyncMode(snapshot) && (
          <Button
            type="button"
            variant="secondary"
            fullWidth
            disabled={isSyncing}
            data-testid="sync-backfill-button"
            onClick={() => void handleBackfill()}
          >
            {translate('sync.backfill.action')}
          </Button>
        )}

        {snapshot.hasRetryableErrors && (
          <Button
            type="button"
            variant="secondary"
            fullWidth
            disabled={isSyncing}
            data-testid="sync-retry-button"
            onClick={() => void handleRetry()}
          >
            {translate('sync.action.retry')}
          </Button>
        )}
      </div>
    </Page>
  );
}
