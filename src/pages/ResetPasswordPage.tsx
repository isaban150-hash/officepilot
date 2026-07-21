import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { PasswordInput } from '../components/auth/PasswordInput';
import { Button } from '../components/ui/Button';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { getLoginErrorMessage, MIN_PASSWORD_LENGTH } from '../services/auth/authService';
import type { PasswordUpdateError } from '../services/auth/supabaseAuthService';
import type { TranslationKey } from '../i18n';
import type { AppLanguage } from '../types/models';

function recoveryErrorMessage(
  error: PasswordUpdateError,
  translate: (key: TranslationKey) => string,
  language: AppLanguage,
): string {
  if (error === 'password_too_short') {
    return getLoginErrorMessage('password_too_short', language);
  }
  if (error === 'recovery_session_missing') {
    return translate('auth.resetPassword.error.invalidLink');
  }
  return translate('auth.resetPassword.error.updateFailed');
}

export function ResetPasswordPage() {
  const {
    passwordRecoveryPending,
    refreshPasswordRecoveryState,
    updatePasswordDuringRecovery,
    logout,
  } = useAuth();
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [hasRecovery, setHasRecovery] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = await refreshPasswordRecoveryState();
      if (!cancelled) {
        setHasRecovery(active || passwordRecoveryPending);
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPasswordRecoveryState, passwordRecoveryPending]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError(null);

    if (password !== passwordConfirm) {
      setError(translate('auth.error.passwordMismatch'));
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(getLoginErrorMessage('password_too_short', language));
      return;
    }

    const recoveryOk = await refreshPasswordRecoveryState();
    if (!recoveryOk) {
      setHasRecovery(false);
      setError(translate('auth.resetPassword.error.invalidLink'));
      return;
    }

    setLoading(true);
    const result = await updatePasswordDuringRecovery(password);
    setLoading(false);

    if (!result.success) {
      setError(recoveryErrorMessage(result.error, translate, language));
      if (result.error === 'recovery_session_missing') {
        setHasRecovery(false);
      }
      return;
    }

    await logout();
    navigate('/login?passwordChanged=1', { replace: true });
  }

  if (checking) {
    return (
      <AuthLayout
        title={translate('auth.resetPassword.title')}
        subtitle={translate('auth.resetPassword.subtitle')}
        testId="reset-password-page"
      >
        <p className="auth-info" data-testid="reset-password-checking">
          {translate('auth.resetPassword.checking')}
        </p>
      </AuthLayout>
    );
  }

  if (!hasRecovery && !passwordRecoveryPending) {
    return (
      <AuthLayout
        title={translate('auth.resetPassword.title')}
        subtitle={translate('auth.resetPassword.subtitle')}
        testId="reset-password-page"
      >
        <div className="auth-info" data-testid="reset-password-invalid">
          <p className="auth-form__error" role="alert">
            {translate('auth.resetPassword.error.invalidLink')}
          </p>
          <Link
            to="/forgot-password"
            className="btn btn--primary btn--full"
            data-testid="reset-password-request-again"
          >
            {translate('auth.resetPassword.requestAgain')}
          </Link>
          <p className="auth-form__links">
            <Link to="/login">{translate('auth.forgotPassword.backToLogin')}</Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={translate('auth.resetPassword.title')}
      subtitle={translate('auth.resetPassword.subtitle')}
      testId="reset-password-page"
    >
      <form className="auth-form" onSubmit={handleSubmit} data-testid="reset-password-form">
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="reset-password-error">
            {error}
          </p>
        ) : null}
        <PasswordInput
          label={translate('auth.resetPassword.newPassword')}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={loading}
          testId="reset-password-new"
        />
        <PasswordInput
          label={translate('auth.resetPassword.confirmPassword')}
          autoComplete="new-password"
          value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={loading}
          testId="reset-password-confirm"
        />
        <Button
          type="submit"
          fullWidth
          loading={loading}
          disabled={loading}
          data-testid="reset-password-submit"
        >
          {loading
            ? translate('auth.resetPassword.submitting')
            : translate('auth.resetPassword.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
