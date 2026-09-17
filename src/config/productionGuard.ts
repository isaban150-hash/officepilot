export interface ProductionConfigIssue {
  code: 'beta_mode_in_production' | 'default_admin_in_production';
  message: string;
}

export function isProductionBuild(): boolean {
  return import.meta.env.PROD;
}

/**
 * V1-B1 — Staging-Kennzeichnung. Nur ein ausdrückliches
 * `VITE_APP_ENVIRONMENT=staging` markiert die App als Staging; Produktion
 * und lokale Entwicklung ohne die Variable bleiben unmarkiert.
 */
export function isStagingEnvironment(): boolean {
  return (import.meta.env.VITE_APP_ENVIRONMENT ?? '').toString().trim().toLowerCase() === 'staging';
}

export function isBetaTestModeEnabled(): boolean {
  return import.meta.env.VITE_BETA_TEST_MODE === 'true';
}

export function isDefaultAdminBootstrapAllowed(): boolean {
  if (!isProductionBuild()) return true;
  return import.meta.env.VITE_ALLOW_DEFAULT_ADMIN === 'true';
}

export function getProductionConfigIssues(): ProductionConfigIssue[] {
  if (!isProductionBuild()) return [];

  const issues: ProductionConfigIssue[] = [];

  if (isBetaTestModeEnabled()) {
    issues.push({
      code: 'beta_mode_in_production',
      message:
        'VITE_BETA_TEST_MODE ist in Production aktiv. Für die geschlossene Beta muss diese Variable leer oder false sein.',
    });
  }

  if (isDefaultAdminBootstrapAllowed()) {
    issues.push({
      code: 'default_admin_in_production',
      message:
        'VITE_ALLOW_DEFAULT_ADMIN ist in Production aktiv. Nur für die Ersteinrichtung verwenden und danach entfernen.',
    });
  }

  return issues;
}
