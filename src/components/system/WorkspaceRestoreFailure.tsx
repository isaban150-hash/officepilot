import { AuthLayout } from '../auth/AuthLayout';
import { Button } from '../ui/Button';
import { getCachedSetup } from '../../services/persistenceService';
import { readPersonalUiLanguage } from '../../services/auth/personalUiLanguage';
import type { SetupWizardAccess } from '../../services/setupAccessService';
import { PendingInvitationsPanel } from '../team/PendingInvitationsPanel';
import { WorkspaceChangeNotice } from '../team/WorkspaceChangeNotice';
import { t, type TranslationKey } from '../../i18n';

/** EINRICHTUNG-01 (AP3, O-05) — Titel und Hinweis je Sperrgrund. */
const SETUP_BLOCKED_TEXTS: Record<Exclude<SetupWizardAccess, 'allowed'>, { title: TranslationKey; hint: TranslationKey }> = {
  member: { title: 'setupFlow.member.title', hint: 'setupFlow.member.hint' },
  license_read_only: { title: 'setupFlow.license.title', hint: 'setupFlow.license.hint' },
  unknown: { title: 'setupFlow.unknown.title', hint: 'setupFlow.unknown.hint' },
};

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
      language={lang}
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
  /** EINRICHTUNG-01 (AP3, O-05.1) — ohne Angabe wie bisher (Inhaber oder lokaler Betrieb). */
  access?: SetupWizardAccess;
  userId?: string | null;
}

/**
 * OFFICEPILOT-MULTI-ORIGIN-SETUP-01B3 — der Server bestätigt einen bestehenden
 * Workspace (created:false), der aber kein abgeschlossenes Setup trägt. Nur ein
 * ausdrückliches „Einrichtung fortsetzen“ öffnet den Assistenten.
 *
 * EINRICHTUNG-01 (AP3; EIN-13, O-05.1, O-05.4) — „Einrichtung fortsetzen“ gibt es nur für Inhaber und Admins mit
 * Schreibrecht. Ein Mitglied liest, dass der Inhaber den Betrieb einrichtet; eine unbestätigte Rolle oder eine nicht
 * wirksame Betriebslizenz sperrt mit eigenem Hinweis.
 */
export function WorkspaceSetupNotFound({
  onRecheck,
  onSwitchAccount,
  onContinueSetup,
  access = 'allowed',
  userId = null,
}: WorkspaceSetupNotFoundProps) {
  const lang = readPersonalUiLanguage(userId) ?? getCachedSetup()?.language ?? 'de';

  if (access !== 'allowed') {
    const texts = SETUP_BLOCKED_TEXTS[access];
    return (
      <AuthLayout language={lang} title={t(texts.title, lang)} subtitle={t(texts.hint, lang)} testId="workspace-setup-not-found">
        <div className="auth-form" data-testid="workspace-setup-blocked" data-access={access}>
          {access === 'member' ? (
            <p className="auth-info" data-testid="workspace-setup-member-hint">
              {t('setupFlow.member.next', lang)}
            </p>
          ) : null}
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
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      language={lang}
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

interface WorkspaceInvitationPendingProps {
  userId: string | null;
  onRecheck: () => void;
  onLogout: () => void;
  onOpenPlatform?: () => void;
}

/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.5, M-07.4) — freigegeben, ohne Mitgliedschaft, aber mit offener Einladung an die
 * bestätigte E-Mail. Der Server legt keinen eigenen Betrieb an, solange sie offen ist; die Person entscheidet hier.
 */
export function WorkspaceInvitationPending({ userId, onRecheck, onLogout, onOpenPlatform }: WorkspaceInvitationPendingProps) {
  const lang = readPersonalUiLanguage(userId) ?? getCachedSetup()?.language ?? 'de';
  return (
    <AuthLayout language={lang} title={t('invitation.pending.title', lang)} subtitle={t('invitation.pending.body', lang)} testId="workspace-invitation-pending">
      <div className="auth-info">
        <PendingInvitationsPanel userId={userId} language={lang} onDeclined={onRecheck} testId="workspace-invitation-pending-list" />
        {onOpenPlatform ? (
          <Button type="button" variant="ghost" fullWidth data-testid="workspace-open-platform" onClick={onOpenPlatform}>
            {t('platform.entry', lang)}
          </Button>
        ) : null}
        <Button type="button" variant="outline" fullWidth data-testid="workspace-invitation-pending-logout" onClick={onLogout}>
          {t('workspaceAccess.noLicense.logout', lang)}
        </Button>
      </div>
    </AuthLayout>
  );
}

interface WorkspaceNoLicenseProps {
  userId: string | null;
  onRecheck: () => void;
  onLogout: () => void;
  /** EINRICHTUNG-01 (AP4, P-01.1) — Plattform-Admins erreichen die Verwaltung auch ohne eigenen Betrieb. */
  onOpenPlatform?: () => void;
}

/**
 * EINRICHTUNG-01 (AP1, Z-03.1) — freigegeben, aber ohne Betrieb: keine Mitgliedschaft zum Binden und keine
 * wirksame eigene Lizenz für einen neuen Betrieb. Der Server hat nichts angelegt. Statt eines Einrichtungsassistenten,
 * dessen Eingaben nirgends gespeichert werden könnten, ein Hinweis mit dem nächsten Schritt.
 */
export function WorkspaceNoLicense({ userId, onRecheck, onLogout, onOpenPlatform }: WorkspaceNoLicenseProps) {
  const lang = readPersonalUiLanguage(userId) ?? getCachedSetup()?.language ?? 'de';

  return (
    <AuthLayout
      title={t('workspaceAccess.noLicense.title', lang)}
      subtitle={t('workspaceAccess.noLicense.body', lang)}
      testId="workspace-no-license"
    >
      <div className="auth-info">
        <WorkspaceChangeNotice language={lang} />
        <p data-testid="workspace-no-license-next">{t('workspaceAccess.noLicense.next', lang)}</p>
        <Button type="button" fullWidth data-testid="workspace-no-license-recheck" onClick={onRecheck}>
          {t('workspaceAccess.noLicense.retry', lang)}
        </Button>
        {onOpenPlatform ? (
          <Button type="button" variant="ghost" fullWidth data-testid="workspace-open-platform" onClick={onOpenPlatform}>
            {t('platform.entry', lang)}
          </Button>
        ) : null}
        <Button type="button" variant="outline" fullWidth data-testid="workspace-no-license-logout" onClick={onLogout}>
          {t('workspaceAccess.noLicense.logout', lang)}
        </Button>
      </div>
    </AuthLayout>
  );
}
