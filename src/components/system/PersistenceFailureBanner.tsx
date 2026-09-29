import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  getPersistenceHealthSnapshot,
  subscribePersistenceHealth,
  type PersistenceHealthSnapshot,
} from '../../services/persistenceHealthService';
import { SETTINGS_BACKUP_HREF } from '../../services/backupSectionNavigation';

export function PersistenceFailureBanner() {
  const { translate } = useApp();
  const [health, setHealth] = useState<PersistenceHealthSnapshot>(() =>
    getPersistenceHealthSnapshot(),
  );

  useEffect(() => subscribePersistenceHealth(setHealth), []);

  if (!health.hasFailure) return null;

  /*
   * SYNC-AUTOMATIK-01A — ein anderer Tab hat neuer gespeichert. Hier hilft
   * keine Datensicherung, sondern nur das Neuladen: Danach arbeitet dieser Tab
   * auf dem aktuellen Stand, und nichts wurde überschrieben.
   */
  if (health.staleTab) {
    return (
      <div className="persistence-failure-banner" role="alert" data-testid="persistence-stale-tab-banner">
        <p className="persistence-failure-banner__text">{translate('persist.banner.staleTab')}</p>
        <button
          type="button"
          className="persistence-failure-banner__link"
          data-testid="persistence-stale-tab-reload"
          onClick={() => window.location.reload()}
        >
          {translate('persist.banner.reload')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="persistence-failure-banner"
      role="alert"
      data-testid="persistence-failure-banner"
    >
      <p className="persistence-failure-banner__text">{translate('persist.banner.message')}</p>
      <Link
        to={SETTINGS_BACKUP_HREF}
        className="persistence-failure-banner__link"
        data-testid="persistence-failure-backup-link"
      >
        {translate('persist.banner.openBackup')}
      </Link>
    </div>
  );
}
