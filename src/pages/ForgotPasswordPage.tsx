import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';

/** Exported for tests — recovery emails must land on this path of the current origin. */
export function buildPasswordResetRedirectTo(origin = window.location.origin): string {
  return `${origin}/reset-password`;
}

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const { translate } = useApp();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const formEmail = String(new FormData(event.currentTarget).get('email') ?? email).trim();
    setError(null);
    setSuccess(false);
    setLoading(true);
    const result = await requestPasswordReset(formEmail, buildPasswordResetRedirectTo());
    setLoading(false);
    if (!result.success) {
      setError(translate('auth.error.invalidEmail'));
      return;
    }
    setSuccess(true);
  }

  return (
    <AuthLayout
      title={translate('auth.forgotPassword.title')}
      subtitle={translate('auth.forgotPassword.subtitle')}
      testId="forgot-password-page"
    >
      <form className="auth-form" onSubmit={handleSubmit} data-testid="forgot-password-form">
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="forgot-password-error">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="auth-form__success" role="status" data-testid="forgot-password-success">
            {translate('auth.forgotPassword.success')}
          </p>
        ) : null}
        <Input
          label={translate('auth.forgotPassword.email')}
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={loading}
          data-testid="forgot-password-email"
        />
        <p className="auth-form__hint hint-text">{translate('auth.forgotPassword.hint')}</p>
        <Button
          type="submit"
          fullWidth
          loading={loading}
          disabled={loading}
          data-testid="forgot-password-submit"
        >
          {loading
            ? translate('auth.forgotPassword.submitting')
            : translate('auth.forgotPassword.submit')}
        </Button>
        <p className="auth-form__links">
          <Link to="/login">{translate('auth.forgotPassword.backToLogin')}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
