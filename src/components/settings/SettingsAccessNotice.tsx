import { ReadOnlyNotice } from '../ui/ReadOnlyNotice';
import { useApp } from '../../context/AppContext';
import { formatDeletionDate, useWorkspaceDeletionInfo } from '../../hooks/useWorkspaceDeletionInfo';
import type { TranslationKey } from '../../i18n';
import type { WorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.16) — der eine Hinweis für Einstellungsseiten ohne Schreibrecht.
 *
 * Varianten: Rolle, Lizenz, Löschung, Rolle unbekannt, Rechte unbestätigt, lokaler Betrieb. Die Seitenart bestimmt den
 * Text der Rollenvariante:
 *  - `view`      Inhalt bleibt lesbar (Firmendaten, Design, Dokumente, Kommunikation, Buchhaltung)
 *  - `hidden`    nur der Hinweis, kein Inhalt und keine Aktion (Sicherung, Export)
 *  - `ownerOnly` nur der Hinweis; das Ziel gehört allein dem Inhaber (Betrieb löschen)
 *
 * Reine Darstellung. Ob und mit welcher Variante der Hinweis erscheint, entscheidet die Seite anhand von
 * `resolveSettingsNoticeVariant` bzw. ihrer Rollenregel.
 */
export type SettingsNoticeVariant = 'role' | 'license' | 'deletion' | 'unknown' | 'unconfirmed' | 'localOnly';
export type SettingsPageKind = 'view' | 'hidden' | 'ownerOnly';

/** Grund des Nur-Lesens für eine Betriebsseite: Löschung vor Lizenz vor Rolle (N-03.4, N-03.7). */
export function resolveSettingsNoticeVariant(access: WorkspaceWriteAccess): SettingsNoticeVariant | null {
  if (access.reason === 'local_only') return null;
  if (access.licenseReadOnly === true) return access.readOnlyReason === 'deletion' ? 'deletion' : 'license';
  if (access.reason === 'member') return 'role';
  if (access.reason === 'membership_unknown') return 'unknown';
  return null;
}

const TITLE_KEYS: Record<SettingsNoticeVariant, TranslationKey> = {
  role: 'settings.access.title.role',
  license: 'settings.access.title.license',
  deletion: 'settings.access.title.deletion',
  unknown: 'settings.access.title.unknown',
  unconfirmed: 'settings.access.title.unconfirmed',
  localOnly: 'settings.access.title.localOnly',
};

export function settingsNoticeMessageKey(variant: SettingsNoticeVariant, kind: SettingsPageKind = 'view'): TranslationKey {
  switch (variant) {
    case 'role':
      return kind === 'ownerOnly'
        ? 'settings.access.role.ownerOnly'
        : kind === 'hidden'
          ? 'settings.access.role.hidden'
          : 'settings.access.role.view';
    case 'license':
      return 'settings.access.license';
    case 'deletion':
      return 'settings.access.deletion';
    case 'unknown':
      return 'settings.access.unknown';
    case 'unconfirmed':
      return 'settings.access.unconfirmed';
    case 'localOnly':
      return 'settings.access.localOnly';
  }
}

export interface SettingsAccessNoticeProps {
  variant: SettingsNoticeVariant;
  kind?: SettingsPageKind;
  testId?: string;
}

export function SettingsAccessNotice({ variant, kind = 'view', testId = 'settings-access-notice' }: SettingsAccessNoticeProps) {
  const { translate, language } = useApp();
  // EINRICHTUNG-01 (AP7; 1.26) — der Hinweis „Löschung beantragt“ nennt das früheste Ausführungsdatum.
  const deletion = useWorkspaceDeletionInfo();
  const message = translate(settingsNoticeMessageKey(variant, kind)).replace('{date}', formatDeletionDate(deletion.executeAfter, language));
  return (
    <ReadOnlyNotice
      className="settings-access-notice"
      variant={variant}
      title={translate(TITLE_KEYS[variant])}
      message={message}
      testId={testId}
    />
  );
}
