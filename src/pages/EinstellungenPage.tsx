import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import type { TranslationKey } from '../i18n';
import {
  FIRMENDATEN_INVOICE_TEXTS_HREF,
  FIRMENDATEN_PAYMENT_TERMS_HREF,
} from '../services/backupSectionNavigation';

/**
 * COMPANY-SETTINGS-ENTRY-01B — der zentrale Einstiegspunkt in die
 * Einstellungen.
 *
 * Diese Seite **bearbeitet nichts**. Sie bündelt und findet: Firmendaten,
 * Zahlungsbedingungen, Rechnungstexte und Betrieb liegen bereits im
 * `CompanyProfile` beziehungsweise auf vorhandenen Seiten — es fehlte allein
 * ein Ort, an dem ein Betrieb sie erwartet.
 *
 * Bewusst eine ruhige Zeilenliste und kein Kachel-Dashboard: Einstellungen
 * werden gesucht, nicht durchstöbert. Jede Zeile trägt Titel, kurze
 * Beschreibung und einen Pfeil — mehr braucht es nicht, und Abzeichen oder
 * Kennzahlen hätten hier keinen Nutzen.
 */

interface SettingsEntry {
  id: string;
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
          titleKey: 'settings.company.title',
          descriptionKey: 'settings.company.description',
          href: '/firmendaten',
        },
      ],
    },
    {
      id: 'documents',
      titleKey: 'settings.group.documents',
      entries: [
        {
          id: 'invoice-texts',
          titleKey: 'settings.documents.title',
          descriptionKey: 'settings.documents.description',
          /* Tiefenlink in die bestehenden Firmendaten — kein zweites Formular. */
          href: FIRMENDATEN_INVOICE_TEXTS_HREF,
        },
      ],
    },
    {
      id: 'payment',
      titleKey: 'settings.group.payment',
      entries: [
        {
          id: 'payment-terms',
          titleKey: 'settings.payment.title',
          descriptionKey: 'settings.payment.description',
          href: FIRMENDATEN_PAYMENT_TERMS_HREF,
        },
      ],
    },
    {
      id: 'team',
      titleKey: 'settings.group.team',
      entries: [
        {
          id: 'operations',
          titleKey: 'settings.team.operations.title',
          descriptionKey: 'settings.team.operations.description',
          href: '/mehr',
        },
        /* Die Mitarbeiterverwaltung gibt es nur dort, wo sie auch erlaubt ist. */
        ...(isAdmin
          ? [
              {
                id: 'users',
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
