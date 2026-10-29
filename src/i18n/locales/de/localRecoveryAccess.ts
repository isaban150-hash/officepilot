/**
 * EINRICHTUNG-01 (AP1, E8) — Notfallseiten: wer welchen lokalen Bestand sehen und sichern darf.
 *
 * Ohne Anmeldung nur Bestände ohne Kontobindung; Bestände eines Kontos erst nach der vom Server bestätigten
 * Anmeldung genau dieses Kontos. Die Texte nennen nie Kennungen, Namen oder Inhalte gebundener Bestände.
 */
export const deLocalRecoveryAccess = {
  'localRecovery.identity.checking': 'Die Anmeldung wird geprüft …',
  'localRecovery.identity.signedOut':
    'Ohne Anmeldung sehen Sie nur Bestände ohne Kontobindung. Die Bestände eines Kontos lassen sich erst nach der Anmeldung genau dieses Kontos sichern.',
  'localRecovery.identity.invalid':
    'Die gespeicherte Anmeldung ist nicht mehr gültig. Bitte melden Sie sich neu an, um die Bestände Ihres Kontos zu sichern.',
  'localRecovery.identity.offline':
    'Ohne Verbindung lässt sich die Anmeldung nicht bestätigen. Die Bestände eines Kontos lassen sich deshalb jetzt nicht sichern; sie bleiben unverändert auf diesem Gerät.',
  'localRecovery.identity.confirmed':
    'Angemeldet als {email}. Zusätzlich sichtbar sind die Bestände genau dieses Kontos.',
  'localRecovery.boundCount': 'Weitere Bestände mit Kontobindung auf diesem Gerät: {count}',
  'localRecovery.login.title': 'Mit dem Konto anmelden, dem die Bestände gehören',
  'localRecovery.login.email': 'E-Mail',
  'localRecovery.login.password': 'Passwort',
  'localRecovery.login.submit': 'Anmelden',
  'localRecovery.login.failed': 'Die Anmeldung ist fehlgeschlagen. Bitte prüfen Sie E-Mail und Passwort.',
  'localRecovery.login.offline': 'Keine Verbindung. Die Anmeldung ist nur online möglich.',
  'localRecovery.logout': 'Abmelden (nur auf diesem Gerät)',
  'localRecovery.exportBlocked':
    'Die Anmeldung ließ sich vor der Sicherung nicht bestätigen. Es wurde nichts exportiert.',
  'localRecovery.scope.guest': 'Gastbestand',
  'localRecovery.scope.legacy': 'Altbestand (vor der Kontotrennung)',
  'localRecovery.scope.legacy_setup': 'Altformat der Einrichtung',
  'localRecovery.scope.quarantine': 'Quarantänekopie eines Altbestands',
  'localRecovery.scope.user': 'Bestand Ihres Kontos',
  'localRecovery.scope.workspace': 'Betriebsbestand',
} as const;
