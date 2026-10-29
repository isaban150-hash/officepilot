import { LanguageSwitcher } from '../../components/settings/LanguageSwitcher';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP3, K-04; AP5, Vertrag 1.15) — „Sprache“: je Person, ohne Firmen-Schreibauftrag, auch im
 * Nur-Lesen-Betrieb. Die Sprache der aufgelösten Seite „Betrieb“ ist hierher gezogen.
 *
 * Im lokalen Betrieb ohne Cloud gibt es kein Konto; die Sprache gilt dann wie bisher für diese Einrichtung auf diesem
 * Gerät (`CompanySetup.language`). Die Seite bleibt dort erreichbar, sonst ließe sich die Sprache lokal nicht mehr
 * ändern (dokumentierte Abweichung von 1.16).
 */
export const ACCOUNT_LANGUAGE_ROUTE = SETTINGS_TARGET_PATHS['account-language'];

export function AccountLanguagePage() {
  const { translate } = useApp();
  const { user } = useAuth();

  const cloud = isSupabaseConfigured();
  if (cloud && !user) return null;

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-account-language-page">
      <SettingsPageHeader
        target="account-language"
        subtitle={translate(cloud ? 'settings.account.language.subtitle' : 'settings.account.language.localSubtitle')}
      />
      <section className="settings-form__section" data-testid="account-language">
        <h2 className="settings-form__legend">{translate('account.section.language')}</h2>
        <p className="hint-text">{translate(cloud ? 'account.language.hint' : 'settings.account.language.localHint')}</p>
        <LanguageSwitcher testId="account-language-switcher" />
      </section>
    </div>
  );
}
