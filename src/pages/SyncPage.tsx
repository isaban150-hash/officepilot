import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Badge, Card, CardTitle, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import type { SyncState } from '../types/sync';
import type { TranslationKey } from '../i18n';
import {
  getSyncUiSnapshot,
  retrySyncFromUi,
  runSyncFromUi,
  shortenSyncId,
  type SyncUiSnapshot,
} from '../services/sync/syncUiService';

const SYNCING_STATES: SyncState[] = ['checking', 'uploading', 'downloading', 'merging'];

function statusTone(
  syncState: SyncState,
  isOffline: boolean,
): 'default' | 'success' | 'warning' | 'info' {
  if (isOffline) return 'info';
  if (syncState === 'synced') return 'success';
  if (syncState === 'error') return 'warning';
  if (SYNCING_STATES.includes(syncState)) return 'info';
  return 'default';
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
      const report = await runSyncFromUi();
      refresh();
      if (report.errorCount > 0) {
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

  const statusKey = `sync.status.${snapshot.status.syncState}` as TranslationKey;
  const statusLabel = translate(statusKey);
  const tone = statusTone(snapshot.status.syncState, snapshot.isOffline);
  const isSyncing = busy || SYNCING_STATES.includes(snapshot.status.syncState);
  const report = snapshot.lastReport;

  return (
    <div className="page sync-page" data-testid="sync-page">
      <Link to="/mehr" className="back-link">
        ← {translate('common.back')}
      </Link>

      <PageHeader title={translate('sync.title')} subtitle={translate('sync.subtitle')} />

      <Card className="sync-page__banner" highlight={snapshot.isOffline}>
        <p className="sync-page__mode" data-testid="sync-mode-label">
          {translate('sync.mode.localPrepared')}
        </p>
        {snapshot.isOffline && (
          <p className="sync-page__offline" data-testid="sync-offline-hint">
            {translate('sync.offlineHint')}
          </p>
        )}
      </Card>

      <Card className="sync-page__section">
        <div className="sync-page__status-row">
          <CardTitle>{translate('sync.section.status')}</CardTitle>
          <span data-testid="sync-status-badge">
            <Badge tone={tone}>{statusLabel}</Badge>
          </span>
        </div>
        <DataRow label={translate('sync.lastSync')} value={formatTimestamp(snapshot.status.lastSyncedAt)} />
        {snapshot.status.lastError && (
          <p className="sync-page__error" data-testid="sync-error-message">
            {snapshot.status.lastError}
          </p>
        )}
      </Card>

      <Card className="sync-page__section">
        <CardTitle>{translate('sync.section.device')}</CardTitle>
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
      </Card>

      <Card className="sync-page__section">
        <CardTitle>{translate('sync.section.outbox')}</CardTitle>
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
      </Card>

      {(report || snapshot.status.lastError) && (
        <Card className="sync-page__section">
          <div data-testid="sync-report-section">
            <CardTitle>{translate('sync.section.report')}</CardTitle>
            {report && (
              <>
                <DataRow label={translate('sync.report.duration')} value={`${report.durationMs} ms`} />
                <DataRow label={translate('sync.report.uploads')} value={report.uploadCount} />
                <DataRow label={translate('sync.report.downloads')} value={report.downloadCount} />
                <DataRow label={translate('sync.report.conflicts')} value={report.conflictCount} />
                <DataRow label={translate('sync.report.retry')} value={report.retryAttempts} />
              </>
            )}
          </div>
        </Card>
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
    </div>
  );
}
