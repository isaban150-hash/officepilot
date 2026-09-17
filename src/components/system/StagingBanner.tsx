import { isStagingEnvironment } from '../../config/productionGuard';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';

/**
 * V1-B1 — sichtbare STAGING-Kennzeichnung.
 *
 * Erscheint ausschließlich, wenn `VITE_APP_ENVIRONMENT=staging` gesetzt ist
 * (Build-Zeit). Produktion und lokale Entwicklung ohne die Variable zeigen
 * nichts. Gedacht für den ersten echten E-Mail-Test gegen ein getrenntes
 * Staging-System: Ein Tester soll Staging nie mit Produktion verwechseln.
 */
export function StagingBanner() {
  if (!isStagingEnvironment()) return null;
  const lang = getCachedSetup()?.language ?? 'de';
  return (
    <div className="staging-banner" role="status" data-testid="staging-banner">
      <strong>{t('common.staging.title', lang)}</strong>
      {t('common.staging.hint', lang)}
    </div>
  );
}
