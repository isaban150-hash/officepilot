import { Outlet } from 'react-router-dom';
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
