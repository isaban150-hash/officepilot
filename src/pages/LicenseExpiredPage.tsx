import { Button } from '../components/ui/Button';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useAuth } from '../context/AuthContext';
import { useAuthPageText } from '../hooks/useAuthPageText';

/**
 * Rückfallseite für einen Kontostatus, der weder wartend, gesperrt noch freigegeben ist. EINRICHTUNG-01 (AP9; 1.31) —
 * übersetzt; die Lizenz ist nach E3 die des Betriebs, verlängern kann sie dessen Inhaber.
 */
export function LicenseExpiredPage() {
  const { logout, user } = useAuth();
  const { language, text } = useAuthPageText(user?.id ?? null);

  return (
    <AuthLayout
      language={language}
      title={text('auth.licenseExpired.title')}
      subtitle={text('auth.licenseExpired.subtitle')}
      testId="license-expired-page"
    >
      <div className="auth-info">
        {user ? <p>{text('auth.licenseExpired.user', { email: user.email })}</p> : null}
        <p>{text('auth.licenseExpired.contact')}</p>
        <Button variant="outline" fullWidth onClick={logout} data-testid="license-expired-logout">
          {text('auth.logout.action')}
        </Button>
      </div>
    </AuthLayout>
  );
}
