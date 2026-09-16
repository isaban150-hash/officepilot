import { Link, Outlet } from 'react-router-dom';
import { useRef } from 'react';
import { useMainScrollRestoration } from './useMainScrollRestoration';
import { BetaModeBanner } from './BetaModeBanner';
import { PersistenceFailureBanner } from '../system/PersistenceFailureBanner';
import { CloudBackupPendingBanner } from '../system/CloudBackupPendingBanner';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { UserMenu } from './UserMenu';
import { GlobalSearchBar } from '../search/GlobalSearchBar';
import { Toast } from '../ui/Card';
import { SafariResumeDebugOverlay } from '../system/SafariResumeDebugOverlay';
import { UiSessionRecoveryHost } from '../system/UiSessionRecoveryHost';
import { useApp } from '../../context/AppContext';
import { Icon } from '../ui/Icon';
import { ASSISTENT_ROUTE } from './navConfig';

export function AppShell() {
  /*
   * Die Kopfzeile zeigt die **aktuelle** Firmenidentität. Die liegt in
   * `CompanyProfile`; `CompanySetup.companyName` ist nur noch ein
   * Legacy-Spiegel und kann nach einem Cloud-Pull veraltet sein.
   */
  const { companyProfile, toast, clearToast, translate } = useApp();
  const companyName = companyProfile.companyName;
  /* 01D — Scrollregel: neue Seite oben, Rückweg an gemerkter Position. */
  const mainRef = useRef<HTMLElement | null>(null);
  useMainScrollRestoration(mainRef);

  return (
    <div className="app-shell" data-testid="app-shell">
      <div className="app-shell__top">
        <div className="app-shell__top-left">
          <span className="app-shell__brand">OfficePilot</span>
          {companyName ? (
            <span className="app-shell__company" title={companyName}>
              {companyName}
            </span>
          ) : null}
        </div>
        <div className="app-shell__top-right">
          {/*
            * UIUX-FOUNDATION-01C — globale Werkzeuge im Header: Assistent
            * (vorher ein Hauptnavigationsplatz), Einstellungen (Zahnrad),
            * Benutzermenü. Keine zweite Hauptnavigation.
            */}
          <Link
            to={ASSISTENT_ROUTE}
            className="app-shell__tool"
            aria-label={translate('nav.assistant.tool')}
            title={translate('nav.assistant.tool')}
            data-testid="assistant-entry"
          >
            <Icon id="assistant" />
          </Link>
          <Link
            to="/einstellungen"
            className="app-shell__tool app-shell__settings-gear"
            aria-label={translate('settings.gear')}
            title={translate('settings.gear')}
            data-testid="settings-gear"
          >
            <Icon id="settings" />
          </Link>
          <UserMenu />
        </div>
        {/* VISUAL-POLISH-01B — Suche kompakt im Kopf (Desktop: Feld, mobil: Symbol), kein eigener Suchbalken. */}
        <div className="app-shell__search" data-testid="app-shell-search">
          <GlobalSearchBar compact collapsibleOnMobile iconTrigger />
        </div>
      </div>
      <PersistenceFailureBanner />
      <CloudBackupPendingBanner />
      <BetaModeBanner />
      <UiSessionRecoveryHost />
      <div className="app-shell__body">
        <SidebarNav />
        <main className="app-shell__main" ref={mainRef} data-testid="app-shell-main">
          <Outlet />
        </main>
      </div>
      <BottomNav />
      {toast && (
        <Toast message={toast} onClose={clearToast} closeLabel={translate('common.close')} />
      )}
      <SafariResumeDebugOverlay />
    </div>
  );
}
