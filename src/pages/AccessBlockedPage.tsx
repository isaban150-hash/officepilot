import { Button } from '../components/ui/Button';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';

export function AccessBlockedPage() {
  const { logout, user } = useAuth();
  const { translate } = useApp();

  return (
    <AuthLayout title={translate('auth.accessBlocked.title')} testId="access-blocked-page">
      <div className="auth-info">
        <p role="alert" data-testid="access-blocked-message">
          {translate('auth.accessBlocked.message')}
        </p>
        {user ? (
          <p>{translate('auth.accessBlocked.user').replace('{email}', user.email)}</p>
        ) : null}
        <p>{translate('auth.accessBlocked.contactAdmin')}</p>
        <Button variant="outline" fullWidth onClick={logout} data-testid="access-blocked-logout">
          {translate('auth.accessBlocked.logout')}
        </Button>
      </div>
    </AuthLayout>
  );
}
