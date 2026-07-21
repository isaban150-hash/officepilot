import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { getLoginErrorMessage, getPostLoginRoute } from '../services/auth/authService';

export function LoginPage() {
  const { login } = useAuth();
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const passwordChanged = searchParams.get('passwordChanged') === '1';
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
      setError(getLoginErrorMessage(result.error, language));
      return;
    }
    navigate(getPostLoginRoute(result.data.user), { replace: true });
  }

  return (
    <AuthLayout
      title={translate('auth.login.title')}
      subtitle={translate('auth.login.subtitle')}
      testId="login-page"
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {passwordChanged ? (
          <p className="auth-form__success" role="status" data-testid="login-password-changed">
            {translate('auth.login.passwordChanged')}
          </p>
        ) : null}
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <Input
          label={translate('auth.login.email')}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          data-testid="login-email"
        />
        <Input
          label={translate('auth.login.password')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          data-testid="login-password"
        />
        <Button type="submit" fullWidth loading={loading} disabled={loading} data-testid="login-submit">
          {loading ? translate('auth.login.submitting') : translate('auth.login.submit')}
        </Button>
        <p className="auth-form__links">
          <Link to="/forgot-password">{translate('auth.login.forgotPassword')}</Link>
          <Link to="/register">{translate('auth.login.register')}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
