import { Button } from '../components/ui/Button';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useAuth } from '../context/AuthContext';

export function LicenseExpiredPage() {
  const { logout, user } = useAuth();

  return (
    <AuthLayout
      title="Lizenz abgelaufen"
      subtitle="Ihre OfficePilot-Lizenz ist nicht mehr aktiv."
      testId="license-expired-page"
    >
      <div className="auth-info">
        {user ? <p>Benutzer: {user.email}</p> : null}
        <p>Bitte wenden Sie sich an Ihren Administrator, um die Lizenz zu verlängern.</p>
        <Button variant="outline" fullWidth onClick={logout} data-testid="license-expired-logout">
          Abmelden
        </Button>
      </div>
    </AuthLayout>
  );
}
