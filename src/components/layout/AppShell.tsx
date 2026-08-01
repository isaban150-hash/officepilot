import { Outlet } from 'react-router-dom';
import { BetaModeBanner } from './BetaModeBanner';
import { PersistenceFailureBanner } from '../system/PersistenceFailureBanner';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { UserMenu } from './UserMenu';
import { GlobalSearchBar } from '../search/GlobalSearchBar';
import { Toast } from '../ui/Card';
import { SafariResumeDebugOverlay } from '../system/SafariResumeDebugOverlay';
import { UiSessionRecoveryHost } from '../system/UiSessionRecoveryHost';
import { useApp } from '../../context/AppContext';

export function AppShell() {
  const { setup, toast, clearToast, translate } = useApp();

  return (
    <div className="app-shell" data-testid="app-shell">
      <div className="app-shell__top">
        <div className="app-shell__top-left">
          <span className="app-shell__brand">OfficePilot</span>
          {setup.companyName ? (
            <span className="app-shell__company" title={setup.companyName}>
              {setup.companyName}
            </span>
          ) : null}
        </div>
        <div className="app-shell__top-right">
          <UserMenu />
        </div>
      </div>
      <PersistenceFailureBanner />
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
