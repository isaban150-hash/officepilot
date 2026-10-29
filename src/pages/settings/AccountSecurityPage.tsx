import { useState, type FormEvent } from 'react';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { changePassword, requestEmailChange } from '../../services/auth/accountService';
import type { TranslationKey } from '../../i18n';
import { AccountInfoLine, AccountLocalOnlyPage, type AccountInfo } from './AccountSettingsPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';

/**
 * EINRICHTUNG-01 (AP3, K-02/K-03; AP5, Vertrag 1.15) — „Anmeldung und Sicherheit“: E-Mail-Wechsel mit doppelter
 * Bestätigung (bis dahin gilt die alte Adresse) und Passwortwechsel mit Bestätigung des alten; andere Geräte werden
 * dabei abgemeldet, diese Sitzung bleibt. Persönlich (Ausnahme B), auch im Nur-Lesen-Betrieb bedienbar.
 */
export const ACCOUNT_SECURITY_ROUTE = SETTINGS_TARGET_PATHS['account-security'];

export function AccountSecurityPage() {
  const { translate } = useApp();
  const { user } = useAuth();

  const [newEmail, setNewEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailInfo, setEmailInfo] = useState<AccountInfo>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordInfo, setPasswordInfo] = useState<AccountInfo>(null);
  // EINRICHTUNG-01 (AP8; 1.27) — Rückfrage beim Verlassen; Passwörter werden nie als Entwurf gehalten.
  useLeaveGuard(newEmail.trim() !== '' || currentPassword !== '' || newPassword !== '' || confirmPassword !== '', false);

  if (!isSupabaseConfigured()) return <AccountLocalOnlyPage target="account-security" testId="settings-account-security-page" />;
  if (!user) return null;

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    if (emailBusy) return;
    setEmailBusy(true);
    setEmailInfo(null);
    try {
      const outcome = await requestEmailChange(user.email, newEmail);
      const key: TranslationKey =
        outcome === 'sent'
          ? 'account.email.sent'
          : outcome === 'same_email'
            ? 'account.email.same'
            : outcome === 'invalid_email'
              ? 'auth.error.invalidEmail'
              : outcome === 'rate_limited'
                ? 'auth.error.rateLimited'
                : outcome === 'network'
                  ? 'auth.error.network'
                  : 'auth.error.unknown';
      setEmailInfo({ ok: outcome === 'sent', key });
      if (outcome === 'sent') setNewEmail('');
    } finally {
      setEmailBusy(false);
    }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    setPasswordInfo(null);
    if (newPassword !== confirmPassword) {
      setPasswordInfo({ ok: false, key: 'account.password.mismatch' });
      return;
    }
    setPasswordBusy(true);
    try {
      const outcome = await changePassword({ userId: user.id, email: user.email, currentPassword, newPassword });
      const key: TranslationKey =
        outcome === 'ok'
          ? 'account.password.changed'
          : outcome === 'wrong_current'
            ? 'account.password.wrongCurrent'
            : outcome === 'weak_password'
              ? 'account.password.weak'
              : outcome === 'same_password'
                ? 'account.password.same'
                : outcome === 'rate_limited'
                  ? 'auth.error.rateLimited'
                  : outcome === 'network'
                    ? 'auth.error.network'
                    : 'auth.error.unknown';
      setPasswordInfo({ ok: outcome === 'ok', key });
      if (outcome === 'ok') {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    } finally {
      setPasswordBusy(false);
    }
  };

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-account-security-page">
      <SettingsPageHeader target="account-security" subtitle={translate('settings.account.security.subtitle')} />

      <form className="settings-form__section" onSubmit={(event) => void submitEmail(event)} data-testid="account-email">
        <h2 className="settings-form__legend">{translate('account.section.email')}</h2>
        <div className="data-row">
          <span className="data-row__label">{translate('account.email.current')}</span>
          <span className="data-row__value" data-testid="account-email-current">{user.email}</span>
        </div>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.email.new')}</span>
          <input className="input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="email" data-testid="account-email-new" />
        </label>
        <AccountInfoLine value={emailInfo} testId="account-email-info" />
        <Button type="submit" variant="outline" disabled={emailBusy || !newEmail.trim()} data-testid="account-email-submit">
          {translate('account.email.request')}
        </Button>
      </form>

      <form className="settings-form__section" onSubmit={(event) => void submitPassword(event)} data-testid="account-password">
        <h2 className="settings-form__legend">{translate('account.section.password')}</h2>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.password.current')}</span>
          <input className="input" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" data-testid="account-password-current" />
        </label>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.password.new')}</span>
          <input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" data-testid="account-password-new" />
        </label>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.password.confirm')}</span>
          <input className="input" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" data-testid="account-password-confirm" />
        </label>
        <AccountInfoLine value={passwordInfo} testId="account-password-info" />
        <Button type="submit" variant="outline" disabled={passwordBusy || !currentPassword || !newPassword} data-testid="account-password-submit">
          {translate('account.password.change')}
        </Button>
      </form>
    </div>
  );
}
