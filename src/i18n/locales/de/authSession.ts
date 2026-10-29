/**
 * EINRICHTUNG-01 (AP2) — Anmeldung, Sitzung und Abmelden.
 *
 * Eigene Hinweise statt „E-Mail oder Passwort falsch“ für unbestätigte E-Mail, zu viele Versuche, Netz und unbekannte
 * Fehler (EIN-17); neutrale Antworten, die nicht verraten, ob es ein Konto gibt (A-07.6, A-08.1); Hinweise nach einer
 * vom Server veranlassten Abmeldung; Verbindungsstörung ohne Abmeldung (A-01.1); Abmelden mit Warnung (A-06).
 */
export const deAuthSession = {
  'auth.error.emailNotConfirmed':
    'Ihre E-Mail-Adresse ist noch nicht bestätigt. Bitte öffnen Sie den Link aus der Bestätigungsmail.',
  'auth.error.rateLimited': 'Zu viele Versuche. Bitte warten Sie einen Moment und versuchen Sie es dann erneut.',
  'auth.error.network': 'Keine Verbindung zum Server. Bitte prüfen Sie die Internetverbindung und versuchen Sie es erneut.',
  'auth.error.unknown': 'Das ist gerade nicht möglich. Bitte versuchen Sie es später erneut.',
  'auth.error.weakPassword': 'Dieses Passwort ist zu schwach. Bitte wählen Sie ein längeres Passwort.',
  'auth.resend.action': 'Bestätigung erneut senden',
  'auth.resend.sent':
    'Falls zu dieser Adresse ein unbestätigtes Konto gehört, ist eine neue Bestätigungsmail unterwegs.',
  'auth.resend.wait': 'Erneut senden in {seconds} s',
  'auth.register.successHint':
    'Keine E-Mail erhalten? Wenn Sie bereits ein Konto haben, melden Sie sich an oder nutzen Sie „Passwort vergessen“.',
  'auth.logoutReason.profileMissing': 'Zu dieser Anmeldung gibt es kein Profil. Sie wurden abgemeldet.',
  'auth.logoutReason.sessionInvalid':
    'Ihre Sitzung wurde beendet, zum Beispiel durch „Auf allen Geräten abmelden“. Bitte melden Sie sich erneut an.',
  'auth.connection.banner':
    'Die Verbindung zum Server ist gestört. Sie bleiben angemeldet; Änderungen werden auf diesem Gerät gespeichert und später übertragen. Zahlungen, Freigaben und Versand sind bis dahin gesperrt.',
  'auth.connection.retry': 'Erneut verbinden',
  'auth.profileUnavailable.title': 'Verbindung gestört',
  'auth.profileUnavailable.body':
    'Ihr Profil konnte gerade nicht geladen werden. Sie bleiben angemeldet; OfficeTakt versucht es automatisch erneut.',
  'auth.logout.action': 'Abmelden',
  'auth.logout.title': 'Abmelden?',
  'auth.logout.pendingWarning':
    'Auf diesem Gerät warten {count} Änderungen auf die Übertragung. Sie bleiben gespeichert und werden nach der nächsten Anmeldung dieses Kontos gesendet.',
  'auth.logout.cancel': 'Abbrechen',
  'auth.logout.confirm': 'Trotzdem abmelden',
  'auth.logout.busy': 'Wird abgemeldet …',
  'auth.logout.everywhere': 'Auf allen Geräten abmelden',
  'auth.logout.everywhereConfirm':
    'Alle Anmeldungen dieses Kontos werden beendet, auch auf anderen Geräten. Dort ist danach eine neue Anmeldung nötig.',
  'auth.logout.everywhereAction': 'Überall abmelden',
  'auth.logout.everywhereFailed':
    'Ohne Verbindung lässt sich nicht auf allen Geräten abmelden. Bitte versuchen Sie es erneut, sobald die Verbindung steht.',
  'legalConsent.title': 'Zustimmung erforderlich',
  'legalConsent.subtitle': 'Bitte stimmen Sie der geltenden Fassung der Rechtstexte zu, um OfficeTakt weiter zu nutzen.',
  'legalConsent.terms': 'Ich stimme den AGB zu.',
  'legalConsent.privacy': 'Ich habe die Datenschutzerklärung gelesen und stimme zu.',
  'legalConsent.license': 'Ich stimme den Lizenzbedingungen zu.',
  'legalConsent.read': 'lesen',
  'legalConsent.accept': 'Zustimmen',
  'legalConsent.decline': 'Ablehnen und abmelden',

  /* EINRICHTUNG-01 (AP7; 1.25) — Hinweis nach der Kontolöschung. */
  'auth.logoutReason.accountDeleted': 'Ihr Konto wurde gelöscht bzw. die Löschung wird abgeschlossen. Die Daten dieses Kontos wurden von diesem Gerät entfernt.',
  'auth.logoutReason.deviceDataRemoved': 'Die Daten dieses Kontos wurden von diesem Gerät entfernt. Ihre Daten in der Cloud sind unverändert.',
} as const;
