import { ChartOfAccountsSetting } from '../../components/accounting/ChartOfAccountsSetting';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { useApp } from '../../context/AppContext';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.15) — „Buchhaltung › Kontenrahmen“, aus der aufgelösten Seite „Betrieb“.
 *
 * STEUERBERATER-06A — der Kontenrahmen gehört zur Buchhaltung, nicht zur Rechnungsstellung: Er betrifft Eingangsbelege
 * genauso wie Ausgangsrechnungen. Die Auswahl wirkt sofort; wählen darf nur, wer schreiben darf (AP0–AP4-Abschluss Z1).
 * Ohne Schreibrecht bleibt der Wert lesbar, mit dem einheitlichen Hinweis (1.16).
 */
export const CHART_OF_ACCOUNTS_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS['chart-of-accounts'];

export function ChartOfAccountsSettingsPage() {
  const { translate } = useApp();
  return (
    <div className="page settings-page settings-subpage" data-testid="settings-chart-of-accounts-page">
      <SettingsPageHeader target="chart-of-accounts" subtitle={translate('accounting.settings.hint')} />
      <section className="settings-form__section" data-testid="settings-accounting-section">
        <h2 className="settings-form__legend">{translate('accounting.settings.section')}</h2>
        <ChartOfAccountsSetting translate={translate} />
      </section>
    </div>
  );
}
