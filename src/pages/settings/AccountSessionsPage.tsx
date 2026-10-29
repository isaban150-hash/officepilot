import { useState } from 'react';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import type { TranslationKey } from '../../i18n';
import { AccountLocalOnlyPage } from './AccountSettingsPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP2, EIN-16/EIN-26; AP3; AP5, Vertrag 1.15) — „Sitzungen“: Abmelden gilt nur für dieses Gerät;
 * „Auf allen Geräten abmelden“ beendet jede Sitzung des Kontos.
 */
export const ACCOUNT_SESSIONS_ROUTE = SETTINGS_TARGET_PATHS['account-sessions'];

export function AccountSessionsPage() {
  const { translate } = useApp();
  const { user, logout, logoutEverywhere } = useAuth();
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<TranslationKey | null>(null);

  if (!isSupabaseConfigured()) return <AccountLocalOnlyPage target="account-sessions" testId="settings-account-sessions-page" />;
  if (!user) return null;

  const runLogout = async (everywhere: boolean) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
    try {
      if (everywhere) await logoutEverywhere();
      else await logout();
    } catch {
      setSessionError(everywhere ? 'auth.logout.everywhereFailed' : 'auth.error.unknown');
    } finally {
      setSessionBusy(false);
    }
  };

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-account-sessions-page">
      <SettingsPageHeader target="account-sessions" subtitle={translate('settings.account.sessions.subtitle')} />
      <section className="settings-form__section" data-testid="account-sessions">
        <h2 className="settings-form__legend">{translate('account.section.sessions')}</h2>
        <p className="hint-text">{translate('account.sessions.hint')}</p>
        {sessionError ? (
          <p className="auth-form__error" role="alert" data-testid="account-sessions-error">{translate(sessionError)}</p>
        ) : null}
        <div className="form-actions">
          <Button type="button" variant="outline" disabled={sessionBusy} onClick={() => void runLogout(false)} data-testid="account-logout">
            {translate('auth.logout.action')}
          </Button>
          <Button type="button" variant="danger" disabled={sessionBusy} onClick={() => void runLogout(true)} data-testid="account-logout-everywhere">
            {translate('auth.logout.everywhere')}
          </Button>
        </div>
      </section>
    </div>
  );
}
