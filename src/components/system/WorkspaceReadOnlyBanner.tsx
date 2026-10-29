import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { formatDeletionDate, useWorkspaceDeletionInfo } from '../../hooks/useWorkspaceDeletionInfo';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
import { SETTINGS_TARGET_PATHS } from '../../pages/settings/settingsHubConfig';
import type { TranslationKey } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP1, Z-08.1; Vertrag 1.3, E5) — Nur-Lesen sichtbar machen.
 *
 * Meldet der Server die Betriebslizenz als nicht wirksam, sagt dieser Hinweis auf jeder Seite, was weiter geht
 * (ansehen, herunterladen, drucken; sichern für Inhaber und Admins) und wer die Lizenz verlängern kann. Die
 * Schreibbedienelemente folgen derselben Auskunft (`resolveWorkspaceWriteAccess`). Keine Sperrseite: Abmelden und
 * die eigenen Kontoeinstellungen bleiben erreichbar (Z-08.4).
 */
export function WorkspaceReadOnlyBanner() {
  const { translate, language } = useApp();
  const access = useWorkspaceWriteAccess();
  const deletion = useWorkspaceDeletionInfo();
  if (!access.licenseReadOnly) return null;
  /*
   * EINRICHTUNG-01 (AP7; 1.26) — eigener Grund „Löschung beantragt“: Hinweis mit Datum; der Inhaber erreicht den Antrag
   * (Widerruf), Inhaber und Admins behalten Export und Sicherung.
   */
  if (access.readOnlyReason === 'deletion') {
    const key: TranslationKey = deletion.inProgress
      ? 'workspaceAccess.deletion.inProgress'
      : access.role === 'owner'
        ? 'workspaceAccess.deletion.owner'
        : access.role === 'admin'
          ? 'workspaceAccess.deletion.admin'
          : 'workspaceAccess.deletion.member';
    return (
      <div
        className="persistence-failure-banner workspace-read-only-banner"
        role="status"
        data-testid="workspace-read-only-banner"
        data-reason="deletion"
        data-role={access.role}
      >
        <p className="persistence-failure-banner__text">
          <strong>{translate('workspaceAccess.deletion.title')}</strong> ·{' '}
          {translate(key).replace('{date}', formatDeletionDate(deletion.executeAfter, language))}
          {access.role === 'owner' && !deletion.inProgress ? (
            <>
              {' '}
              <Link to={SETTINGS_TARGET_PATHS['workspace-delete']} data-testid="workspace-read-only-banner-manage">
                {translate('workspaceAccess.deletion.manage')}
              </Link>
            </>
          ) : null}
        </p>
      </div>
    );
  }
  const text: TranslationKey =
    access.role === 'owner'
      ? 'workspaceAccess.readOnly.owner'
      : access.role === 'admin'
        ? 'workspaceAccess.readOnly.admin'
        : 'workspaceAccess.readOnly.member';
  return (
    <div
      className="persistence-failure-banner workspace-read-only-banner"
      role="status"
      data-testid="workspace-read-only-banner"
      data-role={access.role}
    >
      <p className="persistence-failure-banner__text">
        <strong>{translate('workspaceAccess.readOnly.title')}</strong> · {translate(text)}
      </p>
    </div>
  );
}
