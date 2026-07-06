import { Link } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';

export function ForgotPasswordPage() {
  return (
    <AuthLayout
      title="Passwort vergessen"
      subtitle="Die Passwort-Zurücksetzung ist in dieser lokalen Version noch nicht angebunden."
      testId="forgot-password-page"
    >
      <div className="auth-info">
        <p>
          Bitte wenden Sie sich an Ihren Administrator. Eine echte Passwort-Wiederherstellung
          wird mit der späteren Cloud-Anbindung (Supabase/Auth0/Firebase) bereitgestellt.
        </p>
        <Link to="/login" className="btn btn--outline btn--full">
          Zurück zur Anmeldung
        </Link>
      </div>
    </AuthLayout>
  );
}
