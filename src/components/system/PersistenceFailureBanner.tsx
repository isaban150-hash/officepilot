import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import {
  getPersistenceHealthSnapshot,
  subscribePersistenceHealth,
  type PersistenceHealthSnapshot,
} from '../../services/persistenceHealthService';

export function PersistenceFailureBanner() {
  const { translate } = useApp();
  const [health, setHealth] = useState<PersistenceHealthSnapshot>(() =>
    getPersistenceHealthSnapshot(),
  );

  useEffect(() => subscribePersistenceHealth(setHealth), []);

  if (!health.hasFailure) return null;

  return (
    <div
      className="persistence-failure-banner"
      role="alert"
      data-testid="persistence-failure-banner"
    >
      <p className="persistence-failure-banner__text">{translate('persist.banner.message')}</p>
      <Link
        to="/firmendaten"
        className="persistence-failure-banner__link"
        data-testid="persistence-failure-backup-link"
      >
        {translate('persist.banner.openBackup')}
      </Link>
    </div>
  );
}
