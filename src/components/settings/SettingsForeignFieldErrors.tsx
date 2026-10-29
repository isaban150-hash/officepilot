import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { InlineNotice } from '../ui/States';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { settingsTargetTitleKey, type SettingsTargetId } from '../../pages/settings/settingsHubConfig';
import { settingsFieldHref, settingsFieldLocation } from '../../pages/settings/settingsFieldRegistry';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.18, F-01) — Fehler in Feldern, die auf einer anderen Einstellungsseite bearbeitet
 * werden: je Eintrag Seite, Feld, Meldung und ein Sprung zum Feld (Muster `InvoiceSettingsPage`). Felder dieser Seite
 * markiert die Seite selbst; sie erscheinen hier nicht.
 */
export function foreignFieldErrors(
  errors: Partial<Record<string, TranslationKey>>,
  currentTarget: SettingsTargetId,
): Array<{ field: string; message: TranslationKey }> {
  const seen = new Set<string>();
  const entries: Array<{ field: string; message: TranslationKey }> = [];
  for (const [field, message] of Object.entries(errors)) {
    if (!message) continue;
    const location = settingsFieldLocation(field);
    if (location && location.target === currentTarget) continue;
    const dedupe = `${location?.inputId ?? field}:${message}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    entries.push({ field, message });
  }
  return entries;
}

export interface SettingsForeignFieldErrorListProps {
  entries: Array<{ field: string; message: TranslationKey }>;
  testId: string;
}

/** Die Einträge allein (für Seiten mit eigenem Hinweisrahmen). */
export function SettingsForeignFieldErrorList({ entries, testId }: SettingsForeignFieldErrorListProps) {
  const { translate } = useApp();
  return (
    <ul className="settings-foreign-errors" data-testid={`${testId}-list`}>
      {entries.map(({ field, message }) => {
        const location = settingsFieldLocation(field);
        return (
          <li key={`${field}:${message}`} data-testid={`${testId}-${field}`}>
            {location ? (
              <span className="settings-foreign-errors__where">
                {translate(settingsTargetTitleKey(location.target))} › {translate(location.labelKey)}:{' '}
              </span>
            ) : null}
            <span>{translate(message)}</span>
            {location ? (
              <>
                {' '}
                <Link to={settingsFieldHref(location)} data-testid={`${testId}-jump-${field}`}>
                  {translate('settings.foreignErrors.jump')}
                </Link>
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export interface SettingsForeignFieldErrorsProps {
  entries: Array<{ field: string; message: TranslationKey }>;
  testId: string;
  action?: ReactNode;
}

export function SettingsForeignFieldErrors({ entries, testId, action }: SettingsForeignFieldErrorsProps) {
  const { translate } = useApp();
  if (entries.length === 0) return null;
  return (
    <InlineNotice tone="critical" testId={testId} title={translate('settings.foreignErrors.title')} action={action}>
      <SettingsForeignFieldErrorList entries={entries} testId={testId} />
    </InlineNotice>
  );
}
