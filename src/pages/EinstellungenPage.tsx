import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { useSettingsAccess } from '../hooks/useSettingsAccess';
import {
  SETTINGS_RETURN_STATE,
  resolveSettingsHubGroups,
  type SettingsIconId,
} from './settings/settingsHubConfig';

/**
 * COMPANY-SETTINGS-ENTRY-01B / SETTINGS-01B2 — der zentrale Einstiegspunkt in die Einstellungen.
 *
 * Diese Seite **bearbeitet nichts**. Sie bündelt und findet. Bewusst eine ruhige Zeilenliste und kein
 * Kachel-Dashboard: Einstellungen werden gesucht, nicht durchstöbert. Jede Zeile trägt Icon, Titel, kurze
 * Beschreibung und einen Pfeil.
 *
 * EINRICHTUNG-01 (AP5; Verträge 1.15–1.17) — Gruppen, Ziele und Sichtbarkeit kommen allein aus
 * `settingsHubConfig`: sieben Gruppen in fester Reihenfolge, je Ziel genau ein Eintrag; jede Rolle sieht genau ihre
 * Ziele, der lokale Betrieb ohne Cloud keine Serverziele. Lizenz, Löschantrag und unbestätigte Rechte ändern die
 * Auswahl nicht — die Seiten zeigen dann den Nur-Lesen-Hinweis. Die Plattform-Verwaltung steht nicht hier, sondern
 * nur im Benutzermenü (P-01.1).
 */

function ChevronRightIcon() {
  return (
    <svg className="settings-row__chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const ICON_PATHS: Record<SettingsIconId, string> = {
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  lock: 'M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zm2 0V7a4 4 0 118 0v4',
  language: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z',
  sessions: 'M4 5h16v10H4zM2 19h20M9 15v4m6-4v4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13M10 11v6m4-6v6',
  company: 'M3 21h18M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16M9 7h2m2 0h2M9 11h2m2 0h2M9 15h2m2 0h2M10 21v-4h4v4',
  design: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm4 3h3v3H8V8zm-1 9l4-4 3 3 2-2 3 3',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm13 10v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  invoice: 'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5M9 13h6M9 17h6M9 9h2',
  offer: 'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5M9 15l2 2 4-4',
  letter: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  numbers: 'M9 4L7 20M17 4l-2 16M4 9h16M3 15h16',
  communication: 'M3 6a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6zm0 1l9 6 9-6',
  mailbox: 'M3 13l2-8h14l2 8v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zm0 0h5l1 2h6l1-2h5',
  accounting: 'M5 4h12a2 2 0 012 2v14H7a2 2 0 01-2-2V4zm0 14a2 2 0 012-2h12M9 8h6M9 11h4',
  backup: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2',
  export: 'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5M12 11v6m0 0l-3-3m3 3l3-3',
  device: 'M8 2h8a1 1 0 011 1v18a1 1 0 01-1 1H8a1 1 0 01-1-1V3a1 1 0 011-1zm3 17h2',
  sync: 'M4 12a8 8 0 0114-5.3L20 9M20 4v5h-5M20 12a8 8 0 01-14 5.3L4 15m0 5v-5h5',
  legal: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 006 0L5 7zm14 0l-3 7a3 3 0 006 0l-3-7zM8 21h8',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 8v5m0-8h.01',
};

/** Schlichte Linien-Icons, dieselbe Handschrift wie die Navigation. */
function SettingsIcon({ id }: { id: SettingsIconId }) {
  return (
    <svg
      className="settings-row__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={ICON_PATHS[id]} />
    </svg>
  );
}

export function EinstellungenPage() {
  const { translate } = useApp();
  const { viewer } = useSettingsAccess();
  const groups = resolveSettingsHubGroups(viewer);

  return (
    <div className="page settings-page" data-testid="einstellungen-page">
      <PageHeader title={translate('settings.title')} subtitle={translate('settings.subtitle')} />

      {groups.map((group) => (
        <section
          className="settings-group"
          key={group.id}
          data-testid={`settings-group-${group.id}`}
          aria-labelledby={`settings-group-title-${group.id}`}
        >
          <h2 className="settings-group__title" id={`settings-group-title-${group.id}`}>
            {translate(group.titleKey)}
          </h2>
          <div className="settings-list">
            {group.targets.map((entry) => (
              <Link
                key={entry.id}
                to={entry.path}
                state={entry.external ? SETTINGS_RETURN_STATE : undefined}
                className="settings-row"
                data-testid={`settings-entry-${entry.id}`}
              >
                <SettingsIcon id={entry.icon} />
                <span className="settings-row__text">
                  <span className="settings-row__title">{translate(entry.titleKey)}</span>
                  <span className="settings-row__description">{translate(entry.descriptionKey)}</span>
                </span>
                <ChevronRightIcon />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
