import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  hasPendingCompanyCloudBackup,
  subscribeSyncOutbox,
} from '../../services/sync/syncOutboxService';

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — solange Firmendaten nur lokal liegen,
 * muss das sichtbar bleiben. Kein stiller Fehler: der Nutzer erfährt, dass
 * gespeichert wurde und die Cloud-Sicherung noch aussteht, und kommt mit einem
 * Klick zur vorhandenen Synchronisierung.
 */
export function CloudBackupPendingBanner() {
  const { translate } = useApp();
  const [pending, setPending] = useState<boolean>(() => hasPendingCompanyCloudBackup());

  useEffect(() => {
    const refresh = () => setPending(hasPendingCompanyCloudBackup());
    refresh();
    // Jede Outbox-Änderung meldet sich: der Hinweis verschwindet nach Erfolg.
    const unsubscribe = subscribeSyncOutbox(refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  if (!pending) return null;

  return (
    <div
      className="persistence-failure-banner"
      role="status"
      data-testid="cloud-backup-pending-banner"
    >
      <p className="persistence-failure-banner__text">{translate('cloudBackup.pending.message')}</p>
      {/* Die produktive Synchronisierung liegt unter `/synchronisation`. */}
      <Link
        to="/synchronisation"
        className="persistence-failure-banner__link"
        data-testid="cloud-backup-open-sync"
      >
        {translate('cloudBackup.pending.openSync')}
      </Link>
    </div>
  );
}
