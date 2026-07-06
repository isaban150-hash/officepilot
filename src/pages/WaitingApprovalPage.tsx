import { Button } from '../components/ui/Button';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useAuth } from '../context/AuthContext';

export function WaitingApprovalPage() {
  const { logout, user } = useAuth();

  return (
    <AuthLayout
      title="Freischaltung ausstehend"
      subtitle="Ihr Zugang wurde registriert und wartet auf die Freigabe durch einen Administrator."
      testId="waiting-approval-page"
    >
      <div className="auth-info">
        {user ? (
          <p data-testid="waiting-approval-email">
            <strong>{user.firstName} {user.lastName}</strong> ({user.email})
          </p>
        ) : null}
        <p>Sie erhalten Zugriff, sobald Ihr Konto freigeschaltet wurde.</p>
        <Button variant="outline" fullWidth onClick={logout} data-testid="waiting-approval-logout">
          Abmelden
        </Button>
      </div>
    </AuthLayout>
  );
}
