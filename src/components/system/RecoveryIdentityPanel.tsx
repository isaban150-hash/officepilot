import { useState, type FormEvent } from 'react';
import { t } from '../../i18n';
import type { AppLanguage } from '../../types/models';
import type { RecoveryIdentity } from '../../services/storage/localRecoveryAccessService';
import type { RecoveryLoginError } from '../../hooks/useRecoveryIdentity';

interface RecoveryIdentityPanelProps {
  identity: RecoveryIdentity;
  lang: AppLanguage;
  /** Anzahl gebundener Bestände, die diese Identität nicht sieht — ohne jede weitere Angabe (T-01.2). */
  hiddenBoundCount: number;
  loginBusy: boolean;
  loginError: RecoveryLoginError;
  onLogin: (email: string, password: string) => Promise<boolean>;
  onLogout: () => Promise<void>;
}

/**
 * EINRICHTUNG-01 (AP1, E8; T-01, T-02) — Anmeldestand der Notfallseiten.
 *
 * Sagt, was ohne Anmeldung sichtbar ist, bietet die Anmeldung genau des Kontos an, dem die Bestände gehören, und
 * meldet offline, dass gebundene Bestände unverändert auf dem Gerät bleiben. Nennt nie Kennungen, Namen oder
 * Inhalte gebundener Bestände — nur ihre Anzahl.
 */
export function RecoveryIdentityPanel({
  identity,
  lang,
  hiddenBoundCount,
  loginBusy,
  loginError,
  onLogin,
  onLogout,
}: RecoveryIdentityPanelProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const text = (() => {
    switch (identity.state) {
      case 'checking':
        return t('localRecovery.identity.checking', lang);
      case 'confirmed':
        return t('localRecovery.identity.confirmed', lang, { email: identity.email ?? '—' });
      case 'invalid':
        return t('localRecovery.identity.invalid', lang);
      case 'offline':
        return t('localRecovery.identity.offline', lang);
      default:
        return t('localRecovery.identity.signedOut', lang);
    }
  })();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onLogin(email, password)) setPassword('');
  };

  const showLogin = identity.state === 'signed_out' || identity.state === 'invalid';

  return (
    <section className="local-recovery-identity" data-testid="local-recovery-identity-panel">
      <p className="form-hint" role="status" data-testid="local-recovery-identity" data-state={identity.state}>
        {text}
      </p>
      {hiddenBoundCount > 0 ? (
        <p className="form-hint" data-testid="local-recovery-bound-count">
          {t('localRecovery.boundCount', lang, { count: hiddenBoundCount })}
        </p>
      ) : null}
      {showLogin ? (
        <form className="auth-form" onSubmit={(event) => void submit(event)} data-testid="local-recovery-login">
          <p className="form-hint">{t('localRecovery.login.title', lang)}</p>
          <label className="auth-form__field">
            <span>{t('localRecovery.login.email', lang)}</span>
            <input
              type="email"
              className="input"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="local-recovery-login-email"
            />
          </label>
          <label className="auth-form__field">
            <span>{t('localRecovery.login.password', lang)}</span>
            <input
              type="password"
              className="input"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="local-recovery-login-password"
            />
          </label>
          {loginError ? (
            <p className="form-error" role="alert" data-testid="local-recovery-login-error">
              {t(loginError === 'offline' ? 'localRecovery.login.offline' : 'localRecovery.login.failed', lang)}
            </p>
          ) : null}
          <button
            type="submit"
            className="btn btn--primary btn--full"
            disabled={loginBusy || !email.trim() || !password}
            data-testid="local-recovery-login-submit"
          >
            {t('localRecovery.login.submit', lang)}
          </button>
        </form>
      ) : null}
      {identity.state === 'confirmed' ? (
        <button
          type="button"
          className="btn btn--ghost btn--full"
          onClick={() => void onLogout()}
          data-testid="local-recovery-logout"
        >
          {t('localRecovery.logout', lang)}
        </button>
      ) : null}
    </section>
  );
}
