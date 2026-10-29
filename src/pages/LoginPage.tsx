import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { getLoginErrorMessage, getPostLoginRoute } from '../services/auth/authService';
import { resendSignupConfirmation } from '../services/auth/supabaseAuthService';
import { RETURN_PATH_PARAM, resolvePendingReturnPath, resolveReturnPathForUser } from '../services/auth/authReturnPath';
import type { AuthErrorCode } from '../types/auth';
import { genericErrorText, t } from '../i18n';

/** EINRICHTUNG-01 (AP2, A-07.6) — „Bestätigung erneut senden“ ist danach so lange gesperrt. */
export const RESEND_LOCK_SECONDS = 60;

export function LoginPage() {
  const { login, logoutReason } = useAuth();
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const passwordChanged = searchParams.get('passwordChanged') === '1';
  // EINRICHTUNG-01 (AP4, Weg C) — aus dem Einladungslink vorbelegt; die Person kann sie ändern.
  const [email, setEmail] = useState(() => searchParams.get('email')?.trim() ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  const [loading, setLoading] = useState(false);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [resendLockedUntil, setResendLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Countdown der Sperre für „Bestätigung erneut senden“.
  useEffect(() => {
    if (resendLockedUntil === null) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendLockedUntil) setResendLockedUntil(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendLockedUntil]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setError(null);
    setErrorCode(null);
    setResendInfo(null);
    setLoading(true);
    try {
      const result = await login(email, password);
      if (!result.success) {
        setErrorCode(result.error);
        setError(getLoginErrorMessage(result.error, language, result.ref));
        return;
      }
      // A-12 — zurück auf die ursprünglich aufgerufene Seite, wenn sie zulässig ist und zur Rolle passt. Ein wartendes
      // Konto kehrt nur zur Einladung zurück, über die es sich angemeldet hat (EINRICHTUNG-01 AP4, Weg C).
      const route = getPostLoginRoute(result.data.user);
      const ziel = searchParams.get(RETURN_PATH_PARAM);
      const back =
        route === '/'
          ? resolveReturnPathForUser(ziel, result.data.user)
          : route === '/waiting-approval'
            ? resolvePendingReturnPath(ziel, result.data.user)
            : null;
      navigate(back ?? route, { replace: true });
    } catch (thrown) {
      // EIN-26 — eine Ausnahme lässt das Formular nie im Ladezustand. AP9 (1.30): allgemeiner Text mit Kurzreferenz.
      setErrorCode('unknown');
      setError(genericErrorText(language, thrown));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendLockedUntil !== null) return;
    const lockUntil = Date.now() + RESEND_LOCK_SECONDS * 1000;
    setResendLockedUntil(lockUntil);
    setNow(Date.now());
    const outcome = await resendSignupConfirmation(email);
    if (outcome === 'invalid_email') {
      setResendInfo(translate('auth.error.invalidEmail'));
      return;
    }
    if (outcome === 'network') {
      setResendInfo(translate('auth.error.network'));
      return;
    }
    if (outcome === 'rate_limited') {
      setResendInfo(translate('auth.error.rateLimited'));
      return;
    }
    // Neutral: verrät nicht, ob es ein Konto gibt.
    setResendInfo(translate('auth.resend.sent'));
  }

  const lockSeconds = resendLockedUntil !== null ? Math.max(0, Math.ceil((resendLockedUntil - now) / 1000)) : 0;

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
        {logoutReason && !error ? (
          <p className="auth-form__error" role="status" data-testid="login-logout-reason" data-reason={logoutReason}>
            {translate(
              logoutReason === 'profile_missing'
                ? 'auth.logoutReason.profileMissing'
                : logoutReason === 'account_deleted'
                  ? 'auth.logoutReason.accountDeleted'
                  : logoutReason === 'device_data_removed'
                    ? 'auth.logoutReason.deviceDataRemoved'
                    : 'auth.logoutReason.sessionInvalid',
            )}
          </p>
        ) : null}
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="login-error" data-code={errorCode ?? undefined}>
            {error}
          </p>
        ) : null}
        {errorCode === 'email_not_confirmed' ? (
          <div className="auth-form__links" data-testid="login-resend">
            <Button
              type="button"
              variant="outline"
              fullWidth
              disabled={resendLockedUntil !== null}
              onClick={() => void handleResend()}
              data-testid="login-resend-confirmation"
            >
              {resendLockedUntil !== null
                ? t('auth.resend.wait', language, { seconds: lockSeconds })
                : translate('auth.resend.action')}
            </Button>
            {resendInfo ? (
              <p className="auth-form__success" role="status" data-testid="login-resend-info">
                {resendInfo}
              </p>
            ) : null}
          </div>
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
