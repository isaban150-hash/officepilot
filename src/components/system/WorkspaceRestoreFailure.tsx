import { AuthLayout } from '../auth/AuthLayout';
import { Button } from '../ui/Button';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';

interface WorkspaceRestoreFailureProps {
  onRetry: () => void;
  onSwitchAccount: () => void;
}

/**
 * OFFICEPILOT-SETUP-CLOUD-PERSIST-01B — nutzt die vorhandene Auth-Seitenstruktur
 * (auth-page/auth-card): mobiler Seitenrand, begrenzte Kartenbreite und die
 * bestehende Überschriftengröße statt einer ungestylten h1.
 *
 * Fachlich (01B2): kein „Neuen Betrieb einrichten“ bei technischem Fehler.
 */
export function WorkspaceRestoreFailure({
  onRetry,
  onSwitchAccount,
}: WorkspaceRestoreFailureProps) {
  const lang = getCachedSetup()?.language ?? 'de';

  return (
    <AuthLayout
      title={t('workspaceRestore.failed.title', lang)}
      subtitle={t('workspaceRestore.failed.hint', lang)}
      testId="workspace-restore-failure"
    >
      <div className="auth-form">
        <Button type="button" fullWidth data-testid="workspace-restore-retry" onClick={onRetry}>
          {t('workspaceRestore.failed.retry', lang)}
        </Button>
        <Button
          type="button"
          variant="ghost"
          fullWidth
          data-testid="workspace-restore-switch-account"
          onClick={onSwitchAccount}
        >
          {t('workspaceRestore.failed.switchAccount', lang)}
        </Button>
      </div>
    </AuthLayout>
  );
}

interface WorkspaceSetupNotFoundProps {
  onRecheck: () => void;
  onSwitchAccount: () => void;
  onContinueSetup: () => void;
}

/**
 * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B3 — der Server bestätigt einen bestehenden
 * Workspace (created:false), der aber kein abgeschlossenes Setup trägt. Nur ein
 * ausdrückliches „Einrichtung fortsetzen“ öffnet den Assistenten.
 */
export function WorkspaceSetupNotFound({
  onRecheck,
  onSwitchAccount,
  onContinueSetup,
}: WorkspaceSetupNotFoundProps) {
  const lang = getCachedSetup()?.language ?? 'de';

  return (
    <AuthLayout
      title={t('workspaceRestore.noSetup.title', lang)}
      subtitle={t('workspaceRestore.noSetup.hint', lang)}
      testId="workspace-setup-not-found"
    >
      <div className="auth-form">
        <Button type="button" fullWidth data-testid="workspace-setup-recheck" onClick={onRecheck}>
          {t('workspaceRestore.noSetup.recheck', lang)}
        </Button>
        <Button
          type="button"
          variant="ghost"
          fullWidth
          data-testid="workspace-setup-switch-account"
          onClick={onSwitchAccount}
        >
          {t('workspaceRestore.noSetup.switchAccount', lang)}
        </Button>
        <Button
          type="button"
          variant="ghost"
          fullWidth
          data-testid="workspace-setup-continue"
          onClick={onContinueSetup}
        >
          {t('workspaceRestore.noSetup.continueSetup', lang)}
        </Button>
      </div>
    </AuthLayout>
  );
}
