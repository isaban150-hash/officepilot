/** EINRICHTUNG-01 (AP8; Verträge 1.27, 1.28) — Verlassen-Schutz, Wiederaufnahme und neue Rückfragen. */
export const deLeaveGuard = {
  'leaveGuard.title': 'Ungespeicherte Änderungen',
  'leaveGuard.textDraft':
    'Ihre Eingaben bleiben als Entwurf erhalten und werden Ihnen beim nächsten Öffnen dieser Seite angeboten. Möchten Sie die Seite jetzt verlassen?',
  'leaveGuard.textLost': 'Ihre Eingaben gehen verloren, wenn Sie die Seite jetzt verlassen.',
  'leaveGuard.stay': 'Bleiben',
  'leaveGuard.leave': 'Verlassen',
  'formResume.offer': 'Es gibt einen nicht gespeicherten Entwurf dieses Formulars.',
  'formResume.continue': 'Fortsetzen',
  'formResume.discard': 'Verwerfen',
  'formResume.stale': 'Ein älterer Entwurf wurde verworfen, weil sich die Daten inzwischen geändert haben.',
  'confirm.knowledgeDelete.title': 'Wissenseintrag löschen?',
  'confirm.knowledgeDelete.text': 'Der Eintrag wird gelöscht und steht dem Assistenten nicht mehr zur Verfügung.',
  'confirm.knowledgeDelete.action': 'Eintrag löschen',
  'confirm.logoRemove.title': 'Logo entfernen?',
  'confirm.logoRemove.text': 'Neue Belege erscheinen ohne Logo. Bereits erstellte Belege behalten ihr Logo.',
  'confirm.logoRemove.action': 'Logo entfernen',
  'confirm.invitationRevoke.title': 'Einladung widerrufen?',
  'confirm.invitationRevoke.text': 'Der Einladungslink wird ungültig. Sie können später neu einladen.',
  'confirm.invitationRevoke.action': 'Einladung widerrufen',
  'confirm.transferRevoke.title': 'Übergabeantrag widerrufen?',
  'confirm.transferRevoke.text': 'Der Antrag auf Übergabe des Betriebs wird zurückgenommen. Sie bleiben Inhaber.',
  'confirm.transferRevoke.action': 'Antrag widerrufen',
  'confirm.restore.title': 'Datensicherung wiederherstellen?',
  'confirm.restore.text': 'Die Daten dieses Betriebs auf diesem Gerät werden durch den Stand der Sicherung ersetzt.',
  'confirm.restore.action': 'Wiederherstellen',
  // EINRICHTUNG-01 (AP9; 1.32) — Skip-Link als erstes fokussierbares Element.
  'a11y.skipToContent': 'Zum Inhalt springen',
  // EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — B2-Fehlerseite „Seite nicht gefunden“.
  'notFound.title': 'Seite nicht gefunden',
  'notFound.text': 'Die angeforderte Seite existiert nicht oder wurde verschoben.',
  'notFound.home': 'Zur Startseite',
  // EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — B2-Fehlergrenze (vorher fest deutsch).
  'serverError.title': 'Etwas ist schiefgelaufen',
  'serverError.text': 'Die Anwendung ist vorübergehend nicht verfügbar. Bitte laden Sie die Seite neu.',
  'serverError.retry': 'Erneut versuchen',
  'serverError.devDetails': 'Technische Details',
} as const;
