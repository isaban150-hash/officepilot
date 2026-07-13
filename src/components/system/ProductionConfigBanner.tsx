import { getProductionConfigIssues } from '../../config/productionGuard';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';

export function ProductionConfigBanner() {
  const lang = getCachedSetup()?.language ?? 'de';
  const issues = getProductionConfigIssues();
  if (issues.length === 0) return null;

  return (
    <div className="production-config-banner" role="alert" data-testid="production-config-banner">
      <strong>{t('common.productionConfig.title', lang)}:</strong>
      <ul>
        {issues.map((issue) => (
          <li key={issue.code}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
