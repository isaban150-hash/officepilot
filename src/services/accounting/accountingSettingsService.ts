/**
 * STEUERBERATER-06A — der Kontenrahmen des Betriebs.
 *
 * SKR03 oder SKR04, **einmal für den Betrieb**, nicht je Beleg. Der Wert liegt
 * in `workspace_settings.settings` und damit dort, wo betriebsweite
 * Einstellungen ohnehin liegen: workspacebezogen, cloudfähig über den
 * vorhandenen `workspace_settings`-Zweig, reload-fest über die normale
 * Persistenz.
 *
 * Bewusst **nicht** im Firmenprofil: Dessen Sync ist schemaversioniert
 * (`profile_schema_version` mit serverseitigem Feldkatalog), ein neues Feld
 * dort bräuchte eine Migration und eine Versionserhöhung, sonst löschte ein
 * älterer Client es still. `workspace_settings.settings` ist freies JSONB ohne
 * Katalog — dieselbe Zusage ohne Migration.
 *
 * Kein Standardwert wird gespeichert: Solange der Betrieb nichts gewählt hat,
 * liefert `getChartOfAccounts` zwar SKR03 als Anzeigevorgabe, aber
 * `hasChosenChartOfAccounts` sagt, dass es eine Vorgabe und keine Entscheidung
 * ist. Ein nie getroffener Beschluss soll nicht wie einer aussehen.
 */
import { getWorkspaceSettingsSnapshot, setWorkspaceSettings } from '../workspace/workspaceStore';
import { persistAll } from '../persistenceService';
import { enqueueSyncOutbox } from '../sync/syncOutboxService';
import { CHART_OF_ACCOUNTS_VALUES, type ChartOfAccounts } from '../../types/accounting';

/** Der Schlüssel in `workspace_settings.settings`. */
export const CHART_OF_ACCOUNTS_SETTING_KEY = 'chartOfAccounts';

/**
 * Die Anzeigevorgabe, solange nichts gewählt wurde.
 *
 * SKR03 ist der in kleinen Handwerksbetrieben verbreitete Rahmen. Er wird
 * angezeigt, aber nicht gespeichert — siehe `hasChosenChartOfAccounts`.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: ChartOfAccounts = 'SKR03';

export function isChartOfAccounts(value: unknown): value is ChartOfAccounts {
  return typeof value === 'string' && (CHART_OF_ACCOUNTS_VALUES as readonly string[]).includes(value);
}

/** Der gewählte Rahmen, oder `undefined`, wenn der Betrieb nie einen gewählt hat. */
export function getChosenChartOfAccounts(): ChartOfAccounts | undefined {
  const raw = getWorkspaceSettingsSnapshot()?.settings?.[CHART_OF_ACCOUNTS_SETTING_KEY];
  return isChartOfAccounts(raw) ? raw : undefined;
}

export function hasChosenChartOfAccounts(): boolean {
  return getChosenChartOfAccounts() !== undefined;
}

/** Der Rahmen, mit dem gearbeitet wird — mit Vorgabe, falls nichts gewählt ist. */
export function getChartOfAccounts(): ChartOfAccounts {
  return getChosenChartOfAccounts() ?? DEFAULT_CHART_OF_ACCOUNTS;
}

export type ChartOfAccountsResult =
  | { success: true; chartOfAccounts: ChartOfAccounts }
  | { success: false; errorKey: string };

/**
 * Setzt den Kontenrahmen des Betriebs.
 *
 * Bestehende Kontierungen werden **nicht** umgeschrieben: Jede trägt den
 * Rahmen, der beim Kontieren galt. Eine Umstellung deutet die Vergangenheit
 * nicht um — ein Konto 4930 aus SKR03 wird nicht dadurch zu einem SKR04-Konto,
 * dass jemand die Einstellung wechselt.
 */
export function setChartOfAccounts(next: ChartOfAccounts): ChartOfAccountsResult {
  if (!isChartOfAccounts(next)) {
    return { success: false, errorKey: 'accounting.chart.invalid' };
  }

  const current = getWorkspaceSettingsSnapshot();
  if (!current) {
    // Ohne Workspace gibt es keine betriebsweite Einstellung, die man setzen könnte.
    return { success: false, errorKey: 'accounting.chart.noWorkspace' };
  }

  setWorkspaceSettings({
    ...current,
    settings: { ...current.settings, [CHART_OF_ACCOUNTS_SETTING_KEY]: next },
    updatedAt: new Date().toISOString(),
  });

  /*
   * Derselbe Weg wie bei jeder anderen betriebsweiten Einstellung: über die
   * Outbox in den vorhandenen `workspace_settings`-Zweig. Keine eigene
   * Sync-Welt.
   */
  enqueueSyncOutbox({
    entityType: 'workspace_settings',
    entityId: current.workspaceId,
    operation: 'update',
    version: current.version,
  });
  persistAll();

  return { success: true, chartOfAccounts: next };
}
