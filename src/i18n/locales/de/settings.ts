/**
 * COMPANY-SETTINGS-ENTRY-01B — Texte des zentralen Einstellungsbereichs.
 *
 * Bewusst in der Sprache eines Handwerksbetriebs, nicht in der von
 * Systemadministratoren: „Firmenprofil" statt „Company Entity",
 * „Benutzer & Betrieb" statt „Tenant Configuration".
 */
export const deSettings = {
  'settings.title': 'Einstellungen',
  'settings.subtitle': 'Verwalte deinen Betrieb, deine Rechnungen und OfficePilot.',

  'settings.group.company': 'Firmenprofil',
  'settings.company.title': 'Firmendaten',
  'settings.company.description': 'Anschrift, Kontakt, Logo, Bank- und Steuerinformationen',

  'settings.group.documents': 'Rechnungen & Dokumente',
  'settings.documents.title': 'Rechnungstexte',
  'settings.documents.description': 'Fußzeile und Hinweise auf deinen Rechnungen',

  'settings.group.payment': 'Zahlungsbedingungen',
  'settings.payment.title': 'Zahlungsziel und Skonto',
  'settings.payment.description': 'Standardwerte für neue Rechnungen — pro Rechnung änderbar',

  'settings.group.team': 'Benutzer & Betrieb',
  'settings.team.operations.title': 'Betrieb und weitere Bereiche',
  'settings.team.operations.description': 'Sprache, Datensicherung und alle übrigen Bereiche',
  'settings.team.users.title': 'Mitarbeiter',
  'settings.team.users.description': 'Zugänge freigeben und verwalten',
} as const;
