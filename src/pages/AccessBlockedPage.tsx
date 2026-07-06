import { Button } from '../components/ui/Button';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useAuth } from '../context/AuthContext';

export function AccessBlockedPage() {
  const { logout, user } = useAuth();

  return (
    <AuthLayout title="Zugang gesperrt" testId="access-blocked-page">
      <div className="auth-info">
        <p role="alert" data-testid="access-blocked-message">
          Ihr Zugang wurde gesperrt.
        </p>
        {user ? <p>Benutzer: {user.email}</p> : null}
        <p>Bitte kontaktieren Sie Ihren Administrator.</p>
        <Button variant="outline" fullWidth onClick={logout} data-testid="access-blocked-logout">
          Abmelden
        </Button>
      </div>
    </AuthLayout>
  );
}
