import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useAuth } from '../context/AuthContext';
import { getLoginErrorMessage, getPostLoginRoute } from '../services/auth/authService';

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
      setError(getLoginErrorMessage(result.error));
      return;
    }
    navigate(getPostLoginRoute(result.data.user), { replace: true });
  }

  return (
    <AuthLayout title="Anmelden" subtitle="Melden Sie sich mit Ihrem OfficePilot-Zugang an." testId="login-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <Input
          label="E-Mail"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          data-testid="login-email"
        />
        <Input
          label="Passwort"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          data-testid="login-password"
        />
        <Button type="submit" fullWidth loading={loading} disabled={loading} data-testid="login-submit">
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
