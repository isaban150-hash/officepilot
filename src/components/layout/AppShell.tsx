import { Link, Outlet } from 'react-router-dom';
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

export function AppShell() {
  /*
   * Die Kopfzeile zeigt die **aktuelle** Firmenidentität. Die liegt in
   * `CompanyProfile`; `CompanySetup.companyName` ist nur noch ein
   * Legacy-Spiegel und kann nach einem Cloud-Pull veraltet sein.
   */
  const { companyProfile, toast, clearToast, translate } = useApp();
  const companyName = companyProfile.companyName;

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
            * SETTINGS-01B2 — der Zahnrad-Griff neben dem Benutzermenü. Kein
            * Sidebar-Eintrag, kein Bottom-Nav-Tab: Einstellungen sind ein
            * Werkzeug, kein Arbeitsbereich.
            */}
          <Link
            to="/einstellungen"
            className="app-shell__settings-gear"
            aria-label={translate('settings.gear')}
            title={translate('settings.gear')}
            data-testid="settings-gear"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.55-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-1.55V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9a1.7 1.7 0 001.55 1H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z" />
            </svg>
          </Link>
          <UserMenu />
        </div>
      </div>
      <PersistenceFailureBanner />
      <CloudBackupPendingBanner />
      <BetaModeBanner />
      <UiSessionRecoveryHost />
      <div className="app-shell__search" data-testid="app-shell-search">
        <GlobalSearchBar compact collapsibleOnMobile />
      </div>
      <div className="app-shell__body">
        <SidebarNav />
        <main className="app-shell__main">
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
