import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import type { TranslationKey } from '../i18n';
import { COMPANY_SETTINGS_ROUTE } from './settings/CompanySettingsPage';
import { DESIGN_SETTINGS_ROUTE } from './settings/DesignSettingsPage';
import { INVOICE_SETTINGS_ROUTE } from './settings/InvoiceSettingsPage';
import { OPERATING_SETTINGS_ROUTE } from './settings/OperatingSettingsPage';

/**
 * COMPANY-SETTINGS-ENTRY-01B / SETTINGS-01B2 — der zentrale Einstiegspunkt in
 * die Einstellungen.
 *
 * Diese Seite **bearbeitet nichts**. Sie bündelt und findet. Seit 01B2 führt
 * „Firmenprofil" auf die eigene Unterseite `/einstellungen/firma`; die
 * Bereiche Rechnungen & Zahlungen (01B4) und Dokumente & Design (01B3) haben
 * eigene Unterseiten, Betrieb (01B5) ebenfalls — kein Link ins Leere und
 * kein Link mehr auf die alte Firmendaten-Seite.
 *
 * Bewusst eine ruhige Zeilenliste und kein Kachel-Dashboard: Einstellungen
 * werden gesucht, nicht durchstöbert. Jede Zeile trägt Icon, Titel, kurze
 * Beschreibung und einen Pfeil — mehr braucht es nicht.
 */

type SettingsIconId = 'company' | 'invoice' | 'design' | 'operations' | 'users';

interface SettingsEntry {
  id: string;
  icon: SettingsIconId;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  href: string;
}

interface SettingsGroup {
  id: string;
  titleKey: TranslationKey;
  entries: SettingsEntry[];
}

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

/** Schlichte Linien-Icons, dieselbe Handschrift wie die Navigation. */
function SettingsIcon({ id }: { id: SettingsIconId }) {
  const paths: Record<SettingsIconId, string> = {
    company: 'M3 21h18M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16M9 7h2m2 0h2M9 11h2m2 0h2M9 15h2m2 0h2M10 21v-4h4v4',
    invoice: 'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zm7 0v5h5M9 13h6M9 17h6M9 9h2',
    design: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm4 3h3v3H8V8zm-1 9l4-4 3 3 2-2 3 3',
    operations: 'M12 3l1.5 3 3.3.5-2.4 2.3.6 3.3L12 10.6 9 12.1l.6-3.3L7.2 6.5l3.3-.5L12 3zM4 21v-2a4 4 0 014-4h8a4 4 0 014 4v2',
    users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm13 10v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  };
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
      <path d={paths[id]} />
    </svg>
  );
}

export function EinstellungenPage() {
  const { translate } = useApp();
  const { isAdmin } = useAuth();

  const groups: SettingsGroup[] = [
    {
      id: 'company',
      titleKey: 'settings.group.company',
      entries: [
        {
          id: 'company-profile',
          icon: 'company',
          titleKey: 'settings.company.title',
          descriptionKey: 'settings.company.description',
          href: COMPANY_SETTINGS_ROUTE,
        },
      ],
    },
    {
      id: 'documents',
      titleKey: 'settings.group.documents',
      entries: [
        {
          id: 'invoices',
          icon: 'invoice',
          titleKey: 'settings.invoices.title',
          descriptionKey: 'settings.invoices.description',
          /* SETTINGS-01B4 — die eine Unterseite für alle Rechnungs-Vorbelegungen. */
          href: INVOICE_SETTINGS_ROUTE,
        },
      ],
    },
    {
      id: 'design',
      titleKey: 'settings.group.design',
      entries: [
        {
          id: 'logo',
          icon: 'design',
          titleKey: 'settings.design.title',
          descriptionKey: 'settings.design.description',
          href: DESIGN_SETTINGS_ROUTE,
        },
      ],
    },
    {
      id: 'team',
      titleKey: 'settings.group.team',
      entries: [
        {
          id: 'operations',
          icon: 'operations',
          titleKey: 'settings.operating.title',
          descriptionKey: 'settings.operating.description',
          /* SETTINGS-01B5 — eigene Betriebsseite statt Mehr-Seite. */
          href: OPERATING_SETTINGS_ROUTE,
        },
        /* Die Mitarbeiterverwaltung gibt es nur dort, wo sie auch erlaubt ist. */
        ...(isAdmin
          ? [
              {
                id: 'users',
                icon: 'users' as const,
                titleKey: 'settings.team.users.title' as TranslationKey,
                descriptionKey: 'settings.team.users.description' as TranslationKey,
                href: '/admin/users',
              },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="page settings-page" data-testid="einstellungen-page">
      <PageHeader title={translate('settings.title')} subtitle={translate('settings.subtitle')} />

      {groups.map((group) => (
        <section className="settings-group" key={group.id} data-testid={`settings-group-${group.id}`}>
          <h2 className="settings-group__title">{translate(group.titleKey)}</h2>
          <div className="settings-list">
            {group.entries.map((entry) => (
              <Link
                key={entry.id}
                to={entry.href}
                className="settings-row"
                data-testid={`settings-entry-${entry.id}`}
              >
                <SettingsIcon id={entry.icon} />
                <span className="settings-row__text">
                  <span className="settings-row__title">{translate(entry.titleKey)}</span>
                  <span className="settings-row__description">
                    {translate(entry.descriptionKey)}
                  </span>
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
