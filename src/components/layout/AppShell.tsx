import { Link, Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { Toast } from '../ui/Card';
import { useApp } from '../../context/AppContext';

export function AppShell() {
  const { setup, toast, clearToast, translate, resetDemo } = useApp();

  const handleReset = () => {
    if (window.confirm(translate('persist.resetConfirm'))) {
      resetDemo(true);
    }
  };

  return (
    <div className="app-shell">
      <div className="app-shell__top">
        <span className="app-shell__brand">OfficePilot</span>
        <div className="app-shell__top-right">
          {setup.companyName && (
            <span className="app-shell__company">{setup.companyName}</span>
          )}
          <Link to="/firmendaten" className="app-shell__settings">
            {translate('companyProfile.shortLink')}
          </Link>
          <button type="button" className="app-shell__reset" onClick={handleReset}>
            {translate('persist.resetDemo')}
          </button>
        </div>
      </div>
      <main className="app-shell__main">
        <Outlet />
      </main>
      <BottomNav />
      {toast && <Toast message={toast} onClose={clearToast} />}
    </div>
  );
}
