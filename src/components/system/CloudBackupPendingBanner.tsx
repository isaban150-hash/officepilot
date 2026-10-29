import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  hasPendingCompanyCloudBackup,
  hasRejectedCompanyCloudChange,
  subscribeSyncOutbox,
} from '../../services/sync/syncOutboxService';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
import { COMPANY_SETTINGS_ROUTE } from '../../pages/settings/CompanySettingsPage';

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — solange Firmendaten nur lokal liegen,
 * muss das sichtbar bleiben. Kein stiller Fehler: der Nutzer erfährt, dass
 * gespeichert wurde und die Cloud-Sicherung noch aussteht, und kommt mit einem
 * Klick zur vorhandenen Synchronisierung.
 */
export function CloudBackupPendingBanner() {
  const { translate } = useApp();
  const access = useWorkspaceWriteAccess();
  const [pending, setPending] = useState<boolean>(() => hasPendingCompanyCloudBackup());
  const [rejected, setRejected] = useState<boolean>(() => hasRejectedCompanyCloudChange());

  useEffect(() => {
    const refresh = () => {
      setPending(hasPendingCompanyCloudBackup());
      setRejected(hasRejectedCompanyCloudChange());
    };
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

  /*
   * EINRICHTUNG-01 (AP3, O-03.3) — eine endgültig abgewiesene Änderung der Firmendaten bleibt sichtbar, bis eine
   * spätere angenommen ist. Nur für Inhaber und Admins mit Schreibrecht: Sie können die Firmendaten korrigieren. Im
   * Nur-Lesen-Betrieb erklärt das Lizenzbanner den Grund; Mitglieder ändern keine Firmendaten.
   */
  if (!pending && rejected && access.canWrite && access.reason === 'owner_or_admin') {
    return (
      <div
        className="persistence-failure-banner"
        role="alert"
        data-testid="company-cloud-rejected-banner"
      >
        <p className="persistence-failure-banner__text">{translate('setupFlow.companyRejected.message')}</p>
        <Link
          to={COMPANY_SETTINGS_ROUTE}
          className="persistence-failure-banner__link"
          data-testid="company-cloud-rejected-open"
        >
          {translate('setupFlow.companyRejected.open')}
        </Link>
      </div>
    );
  }

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
