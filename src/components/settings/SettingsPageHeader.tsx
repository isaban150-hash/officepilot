import type { ReactNode } from 'react';
import { PageHeader } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import {
  SETTINGS_HUB_ROUTE,
  settingsTargetTitleKey,
  type SettingsTargetId,
} from '../../pages/settings/settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.15, 1.17) — Seitenkopf jeder Einstellungsunterseite: Titel aus demselben Schlüssel
 * wie der Hub-Eintrag, „Zu den Einstellungen“ führt in den Hub.
 */
export interface SettingsPageHeaderProps {
  target: SettingsTargetId;
  subtitle?: ReactNode;
  /** Bestehende Test-IDs der Rückwege bleiben erhalten (z. B. `settings-company-back`). */
  backTestId?: string;
  status?: ReactNode;
}

export function SettingsPageHeader({ target, subtitle, backTestId, status }: SettingsPageHeaderProps) {
  const { translate } = useApp();
  return (
    <PageHeader
      title={translate(settingsTargetTitleKey(target))}
      subtitle={subtitle}
      status={status}
      backLabel={translate('settings.backToHub')}
      backHref={SETTINGS_HUB_ROUTE}
      backTestId={backTestId ?? `settings-${target}-back`}
    />
  );
}
