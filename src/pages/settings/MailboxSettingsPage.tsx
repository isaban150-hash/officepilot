import { MailboxSettingsSection } from '../../components/communication/MailboxSettingsSection';
import { SettingsAccessNotice, resolveSettingsNoticeVariant } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { useApp } from '../../context/AppContext';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.15, Z-F11) — „Kommunikation › Postfach“ unter eigener Adresse. Der Inhalt ist der
 * bestehende B3-Abschnitt (`MailboxSettingsSection`) und bleibt unverändert.
 *
 * Der OAuth-Rückweg der Edge Function bleibt `/einstellungen/kommunikation?postfach=…`; die Kommunikationsseite leitet
 * ihn mit allen Parametern hierher weiter (`CommunicationSettingsPage`). Ohne Cloud gibt es kein Postfach (1.16); der
 * B3-Abschnitt nennt das selbst („nur mit Cloud-Anbindung“), deshalb steht hier kein zweiter Hinweis.
 */
export const MAILBOX_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS.mailbox;

/** Parameter des OAuth-Rückwegs (B3), die die Kommunikationsseite an das Postfach weitergibt. */
export const MAILBOX_RETURN_PARAMS = ['postfach', 'grund', 'oauth'] as const;

export function MailboxSettingsPage() {
  const { translate } = useApp();
  const { access, cloud } = useSettingsAccess();
  const variant = resolveSettingsNoticeVariant(access);

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-mailbox-page">
      <SettingsPageHeader target="mailbox" subtitle={translate('settings.mailbox.page.subtitle')} />
      {cloud && variant ? <SettingsAccessNotice variant={variant} testId="settings-mailbox-access-notice" /> : null}
      <MailboxSettingsSection />
    </div>
  );
}
