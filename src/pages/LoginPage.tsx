import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { getAuthErrorMessage } from '../services/auth/authService';
import { getLicenseBlockReason } from '../services/auth/licenseService';
import { findUserByEmail } from '../services/auth/authStore';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (!result.success) {
      setError(getAuthErrorMessage(result.error));
      return;
    }
    const user = findUserByEmail(email);
    const block = getLicenseBlockReason(user);
    if (block === 'pending') {
      navigate('/waiting-approval', { replace: true });
      return;
    }
    if (block === 'blocked') {
      navigate('/access-blocked', { replace: true });
      return;
    }
    if (block === 'license_expired' || block === 'no_license') {
      navigate('/license-expired', { replace: true });
      return;
    }
    navigate('/', { replace: true });
  }

  return (
    <AuthLayout title="Anmelden" subtitle="Melden Sie sich mit Ihrem OfficePilot-Zugang an." testId="login-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <label className="auth-form__field">
          <span>E-Mail</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="login-email"
          />
        </label>
        <label className="auth-form__field">
          <span>Passwort</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            data-testid="login-password"
          />
        </label>
        <Button type="submit" fullWidth disabled={loading} data-testid="login-submit">
          {loading ? 'Wird angemeldet…' : 'Anmelden'}
        </Button>
        <p className="auth-form__links">
          <Link to="/forgot-password">Passwort vergessen?</Link>
          <Link to="/register">Neu registrieren</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
