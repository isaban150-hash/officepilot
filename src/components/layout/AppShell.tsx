import { Link, Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { SidebarNav } from './SidebarNav';
import { Toast } from '../ui/Card';
import { useApp } from '../../context/AppContext';

export function AppShell() {
  const { setup, toast, clearToast, translate } = useApp();

  return (
    <div className="app-shell" data-testid="app-shell">
      <div className="app-shell__top">
        <span className="app-shell__brand">OfficePilot</span>
        <div className="app-shell__top-right">
          {setup.companyName && (
            <span className="app-shell__company">{setup.companyName}</span>
          )}
          <Link to="/firmendaten" className="app-shell__settings">
            {translate('companyProfile.shortLink')}
          </Link>
        </div>
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
