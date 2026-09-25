/**
 * STEUERBERATER-06A — die Auswahl des Kontenrahmens.
 *
 * Eine betriebsweite Einstellung, kein Belegfeld. Sie wirkt sofort — wie die
 * Sprache daneben und aus demselben Grund: Es gibt nichts zu bestätigen, der
 * Betrieb führt entweder SKR03 oder SKR04.
 *
 * Bestehende Kontierungen werden dadurch **nicht** umgeschrieben; jede trägt
 * den Rahmen, mit dem sie angelegt wurde. Der Hinweis darunter sagt das, damit
 * niemand eine Umstellung für eine Umbuchung hält.
 */
import { useState } from 'react';
import { Select } from '../ui/Select';
import {
  CHART_OF_ACCOUNTS_SETTING_KEY,
  getChartOfAccounts,
  hasChosenChartOfAccounts,
  setChartOfAccounts,
} from '../../services/accounting/accountingSettingsService';
import { getWorkspaceSettingsSnapshot } from '../../services/workspace/workspaceStore';
import { CHART_OF_ACCOUNTS_VALUES, type ChartOfAccounts } from '../../types/accounting';
import type { TranslationKey } from '../../i18n';

interface Props {
  translate: (key: TranslationKey) => string;
}

export function ChartOfAccountsSetting({ translate }: Props) {
  const [value, setValue] = useState<ChartOfAccounts>(() => getChartOfAccounts());
  const [chosen, setChosen] = useState(() => hasChosenChartOfAccounts());
  const [errorKey, setErrorKey] = useState<string | null>(null);
  /*
   * FINANZ-SYNC-BLOCKER-01G — solange eine Sync-Entscheidung zum Kontenrahmen
   * offen ist, zeigt diese Seite den Cloud-Wert. Ohne Hinweis hielte man ihn
   * für die getroffene Wahl. Entschieden wird weiterhin ausschliesslich auf der
   * Synchronisationsseite; hier steht nur, dass es etwas zu klären gibt.
   */
  const konfliktOffen = (getWorkspaceSettingsSnapshot()?.conflict?.fields ?? []).some(
    (field) => field.key === CHART_OF_ACCOUNTS_SETTING_KEY,
  );

  const handleChange = (next: string) => {
    const chart = next as ChartOfAccounts;
    const result = setChartOfAccounts(chart);
    if (!result.success) {
      setErrorKey(result.errorKey);
      return;
    }
    setErrorKey(null);
    setValue(chart);
    setChosen(true);
  };

  return (
    <div data-testid="settings-chart-of-accounts">
      <Select
        label={translate('accounting.chart')}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        data-testid="settings-chart-of-accounts-select"
      >
        {CHART_OF_ACCOUNTS_VALUES.map((chart) => (
          <option key={chart} value={chart}>
            {chart}
          </option>
        ))}
      </Select>

      {konfliktOffen ? (
        <p className="hint-text" data-testid="settings-chart-of-accounts-conflict">
          {translate('accounting.chart.conflictPending')}
        </p>
      ) : null}

      {/*
        * Solange niemand gewählt hat, steht hier ausdrücklich, dass es eine
        * Vorgabe ist. Ein nie getroffener Beschluss soll nicht wie einer
        * aussehen.
        */}
      {!chosen ? (
        <p className="hint-text" data-testid="settings-chart-of-accounts-unset">
          {translate('accounting.chart.notChosen')}
        </p>
      ) : null}

      <p className="hint-text" data-testid="settings-chart-of-accounts-hint">
        {translate('accounting.chart.hint')}
      </p>

      {errorKey ? (
        <p className="hint-text" data-testid="settings-chart-of-accounts-error">
          {translate(errorKey as TranslationKey)}
        </p>
      ) : null}
    </div>
  );
}
