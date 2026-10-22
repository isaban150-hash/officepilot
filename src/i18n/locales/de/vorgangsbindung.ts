/**
 * DOKUMENTE-01 R1-WEISS-START und DOK-WEISS-DIREKT — Läufe und direkte Vorgänge, die an das Konto ihres Aufrufs
 * gebunden sind und bei einem Wechsel oder ohne bestätigte Anmeldung anhalten.
 *
 * Die Texte melden nie Erfolg für etwas, das nicht geschehen ist, und sagen, dass nichts verloren ging.
 */
export const deVorgangsbindung = {
  'sync.feedback.halted':
    'Synchronisation angehalten: Das Konto dieses Laufs ließ sich nicht bestätigen oder wurde gewechselt. Es wurde nichts gesendet; Ihre offenen Änderungen bleiben erhalten.',
  'document.delete.identityChanged':
    'Löschen abgebrochen: Inzwischen ist ein anderes Konto oder ein anderer Betrieb aktiv. Es wurde nichts gelöscht.',
  'document.delete.identityUnconfirmed':
    'Löschen abgebrochen: Ihre Anmeldung ließ sich nicht bestätigen. Es wurde nichts gelöscht. Bitte melden Sie sich erneut an.',
} as const;
