import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { useApp } from '../../context/AppContext';
import { APP_VERSION, APP_VERSION_STATE, resolveAppBuildId, resolveAppEnvironment } from '../../config/appVersion';
import { isSupabaseConfigured } from '../../lib/supabase';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.15, N-06.1) — „Hilfe und Rechtliches › Version“: Version, Stand, Build, Umgebung und
 * Betriebsart. Für alle sichtbar; zeigt keine Konten-, Betriebs- oder Serverangaben.
 */
export const VERSION_ROUTE = SETTINGS_TARGET_PATHS.version;

function formatState(iso: string): string {
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleDateString('de-DE', { timeZone: 'UTC' });
}

export function VersionPage() {
  const { translate } = useApp();
  const buildId = resolveAppBuildId();
  const environment = resolveAppEnvironment();

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-version-page">
      <SettingsPageHeader target="version" subtitle={translate('settings.version.subtitle')} />
      <section className="settings-form__section" data-testid="settings-version-details">
        <div className="data-row">
          <span className="data-row__label">{translate('settings.version.number')}</span>
          <span className="data-row__value" data-testid="settings-version-number">{APP_VERSION}</span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('settings.version.state')}</span>
          <span className="data-row__value" data-testid="settings-version-state">{formatState(APP_VERSION_STATE)}</span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('settings.version.build')}</span>
          <span className="data-row__value" data-testid="settings-version-build">
            {buildId ?? translate('settings.version.buildLocal')}
          </span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('settings.version.environment')}</span>
          <span className="data-row__value" data-testid="settings-version-environment">
            {translate(`settings.version.environment.${environment}`)}
          </span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('settings.version.mode')}</span>
          <span className="data-row__value" data-testid="settings-version-mode">
            {translate(isSupabaseConfigured() ? 'settings.version.mode.cloud' : 'settings.version.mode.local')}
          </span>
        </div>
      </section>
    </div>
  );
}
