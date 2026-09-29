import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { subscribePersistenceHealth } from '../../services/persistenceHealthService';
import { isLocalStateStaleInThisTab } from '../../services/persistenceService';
import { subscribeSyncOutbox } from '../../services/sync/syncOutboxService';
import { getSyncUiSnapshot, summarizeSyncStatus } from '../../services/sync/syncUiService';
import { subscribeAutomaticSyncStatus } from '../../services/sync/syncSchedulerRuntime';
import type { SyncSchedulerStatus } from '../../services/sync/syncScheduler';
import {
  SYNC_INDICATOR_LABEL_KEYS,
  deriveSyncIndicatorState,
  type SyncIndicatorState,
} from '../../services/sync/syncIndicatorService';

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/**
 * SYNC-AUTOMATIK-01A — globale Statusanzeige im Kopf. Der normale Nutzer muss
 * dafür nicht auf die Sync-Seite; ein Klick führt aber dorthin.
 *
 * Sichtbar nur, solange die automatische Synchronisation aktiv ist (angemeldet,
 * Workspace bereit) — im reinen Gerätebetrieb gibt es nichts anzuzeigen.
 */
export function SyncStatusIndicator() {
  const { translate } = useApp();
  const [scheduler, setScheduler] = useState<SyncSchedulerStatus | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => setTick((value) => value + 1);
    const unsubscribeScheduler = subscribeAutomaticSyncStatus((status) => {
      setScheduler(status);
      refresh();
    });
    const unsubscribeOutbox = subscribeSyncOutbox(refresh);
    const unsubscribeHealth = subscribePersistenceHealth(refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      unsubscribeScheduler();
      unsubscribeOutbox();
      unsubscribeHealth();
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  if (!scheduler) return null;

  void tick;
  const snapshot = getSyncUiSnapshot();
  const state: SyncIndicatorState = deriveSyncIndicatorState({
    online: isOnline(),
    staleTab: isLocalStateStaleInThisTab(),
    summary: summarizeSyncStatus(snapshot),
    outbox: snapshot.outbox,
    scheduler,
  });
  const label = translate(SYNC_INDICATOR_LABEL_KEYS[state] as TranslationKey);

  return (
    <Link
      to="/synchronisation"
      className={`app-shell__sync-indicator app-shell__sync-indicator--${state}`}
      aria-label={`${translate('sync.indicator.label' as TranslationKey)}: ${label}`}
      title={label}
      data-testid="sync-status-indicator"
      data-state={state}
    >
      <span className="app-shell__sync-indicator-dot" aria-hidden="true" />
      <span className="app-shell__sync-indicator-text">{label}</span>
    </Link>
  );
}
