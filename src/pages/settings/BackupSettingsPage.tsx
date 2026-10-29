import { BackupExportPanel } from '../../components/settings/BackupExportPanel';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { useApp } from '../../context/AppContext';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.15, 1.16; AP7, 1.23) — „Daten › Sicherung“, aus der aufgelösten Seite „Betrieb“.
 *
 * Inhaber und Admins sowie der lokale Betrieb sichern hier, auch im Nur-Lesen-Betrieb (Lizenz oder Löschantrag; E9,
 * Ausnahme nach 1.16). Mitglieder und eine unbestätigte Rolle sehen nur den Hinweis — kein Inhalt, keine Aktion.
 */
export const BACKUP_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS.backup;

export function BackupSettingsPage() {
  const { translate } = useApp();
  const { access, managesWorkspace } = useSettingsAccess();

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-backup-page">
      <SettingsPageHeader target="backup" subtitle={translate('settings.backup.page.subtitle')} />
      {managesWorkspace ? (
        <BackupExportPanel />
      ) : (
        <SettingsAccessNotice
          variant={resolveSettingsNoticeVariant(access) === 'unknown' ? 'unknown' : 'role'}
          kind="hidden"
          testId="backup-export-not-allowed"
        />
      )}
    </div>
  );
}
