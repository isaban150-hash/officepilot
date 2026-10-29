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
 *
 * EINRICHTUNG-01 (AP0–AP4-Abschluss, Z1; Z-08.1, F-04.2) — wählen darf nur, wer
 * schreiben darf, nach derselben Regel wie die übrigen Einstellungsformulare
 * (`canWrite`: Inhaber und Admins bei wirksamer Betriebslizenz, der lokale
 * Betrieb). Mitglieder und der Nur-Lesen-Betrieb sehen den Wert, die Auswahl
 * ist gesperrt. Der Server prüft unabhängig davon selbst.
 */
import { useState } from 'react';
import { Select } from '../ui/Select';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../settings/SettingsAccessNotice';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
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
  const access = useWorkspaceWriteAccess();
  const editable = access.canWrite;
  const noticeVariant = resolveSettingsNoticeVariant(access);
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
    if (!editable) return;
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
        disabled={!editable}
        onChange={(event) => handleChange(event.target.value)}
        data-testid="settings-chart-of-accounts-select"
      >
        {CHART_OF_ACCOUNTS_VALUES.map((chart) => (
          <option key={chart} value={chart}>
            {chart}
          </option>
        ))}
      </Select>

      {/* EINRICHTUNG-01 (AP5; 1.16) — der einheitliche Hinweis mit Grund (Rolle, Lizenz, Löschung). */}
      {!editable && noticeVariant ? (
        <SettingsAccessNotice variant={noticeVariant} testId="settings-chart-of-accounts-readonly" />
      ) : null}

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
