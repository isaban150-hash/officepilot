import { Link, Outlet } from 'react-router-dom';
import { BetaModeBanner } from './BetaModeBanner';
import { NetworkStatusBanner } from '../system/NetworkStatusBanner';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { GlobalSearchBar } from '../search/GlobalSearchBar';
import { Toast } from '../ui/Card';
import { LegalFooterLinks } from '../legal/LegalFooterLinks';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../ui/Button';

export function AppShell() {
  const { setup, toast, clearToast, translate } = useApp();
  const { user, logout, isAdmin } = useAuth();

  return (
    <div className="app-shell" data-testid="app-shell">
      <div className="app-shell__top">
        <span className="app-shell__brand">OfficePilot</span>
        <div className="app-shell__top-right">
          {user ? (
            <span className="app-shell__user" data-testid="app-shell-user">
              {user.firstName} {user.lastName}
            </span>
          ) : null}
          {setup.companyName && (
            <span className="app-shell__company">{setup.companyName}</span>
          )}
          {isAdmin ? (
            <Link to="/admin/users" className="app-shell__settings" data-testid="admin-nav-link">
              Admin
            </Link>
          ) : null}
          <Link to="/firmendaten" className="app-shell__settings">
            {translate('companyProfile.shortLink')}
          </Link>
          <Button variant="ghost" onClick={logout} data-testid="logout-button">
            Abmelden
          </Button>
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
      <footer className="app-shell__legal-footer">
        <LegalFooterLinks />
      </footer>
      {toast && <Toast message={toast} onClose={clearToast} />}
    </div>
  );
}
