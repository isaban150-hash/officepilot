import { getProductionConfigIssues } from '../../config/productionGuard';

export function ProductionConfigBanner() {
  const issues = getProductionConfigIssues();
  if (issues.length === 0) return null;

  return (
    <div className="production-config-banner" role="alert" data-testid="production-config-banner">
      <strong>Production-Konfiguration prüfen:</strong>
      <ul>
        {issues.map((issue) => (
          <li key={issue.code}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
