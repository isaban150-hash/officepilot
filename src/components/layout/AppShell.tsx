import { Outlet } from 'react-router-dom';
import { BetaModeBanner } from './BetaModeBanner';
import { NetworkStatusBanner } from '../system/NetworkStatusBanner';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { UserMenu } from './UserMenu';
import { GlobalSearchBar } from '../search/GlobalSearchBar';
import { Toast } from '../ui/Card';
import { useApp } from '../../context/AppContext';

export function AppShell() {
  const { setup, toast, clearToast } = useApp();

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
      <NetworkStatusBanner />
      <BetaModeBanner />
      <div className="app-shell__search" data-testid="app-shell-search">
        <GlobalSearchBar compact />
      </div>
      <div className="app-shell__body">
        <SidebarNav />
        <main className="app-shell__main">
          <Outlet />
        </main>
      </div>
      <BottomNav />
      {toast && <Toast message={toast} onClose={clearToast} />}
    </div>
  );
}
