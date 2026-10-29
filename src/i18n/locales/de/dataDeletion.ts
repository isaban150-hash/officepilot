/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.25a, 1.26) — Konto löschen, Betrieb löschen, Nur-Lesen „Löschung beantragt“.
 */
export const deDataDeletion = {
  /* 1.25a — gemeinsame Fehler des Bestätigungsnachweises. */
  'destructive.error.password': 'Das Passwort ist nicht korrekt.',
  'destructive.error.rateLimited': 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.',
  'destructive.error.session': 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
  'destructive.error.blocked': 'Dieses Konto ist gesperrt.',
  'destructive.error.confirmation': 'Die Bestätigung ist abgelaufen oder ungültig. Bitte erneut bestätigen.',
  'destructive.error.unavailable': 'Der Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen.',
  'destructive.password.label': 'Ihr aktuelles Passwort',
  'destructive.password.hint': 'Das Passwort prüft der Server; OfficeTakt speichert es nicht.',

  /* 1.25 — Konto löschen. */
  'accountDelete.subtitle': 'Ihr Konto und Ihre Anmeldung endgültig löschen.',
  // L-01.6 — auch ein wartendes Konto löscht sich selbst, ohne Zugang zu einem Betrieb.
  'accountDelete.waiting.link': 'Konto löschen',
  'accountDelete.waiting.title': 'Konto löschen',
  'accountDelete.waiting.back': 'Zurück zur Freischaltung',
  'accountDelete.intro':
    'Mit der Löschung enden alle Ihre Mitgliedschaften. In den Betrieben erscheint Ihr Name danach als „Gelöschtes Konto“; Rechnungen, Dokumente und andere Geschäftsdaten der Betriebe bleiben unverändert. Die Löschung lässt sich nicht rückgängig machen.',
  'accountDelete.ownerHint': 'Sind Sie Inhaber eines Betriebs, übergeben Sie ihn zuerst oder beantragen Sie seine Löschung.',
  'accountDelete.email.label': 'Ihre Anmelde-E-Mail zur Bestätigung',
  'accountDelete.submit': 'Konto endgültig löschen',
  'accountDelete.dialog.title': 'Konto löschen?',
  'accountDelete.dialog.text': 'Ihr Konto wird gesperrt und gelöscht, alle Mitgliedschaften enden. Das lässt sich nicht rückgängig machen.',
  'accountDelete.result.completed': 'Ihr Konto ist gelöscht. Die Daten dieses Kontos werden von diesem Gerät entfernt; Sie werden abgemeldet.',
  'accountDelete.result.completing':
    'Die Löschung hat begonnen und wird abgeschlossen. Ihr Konto ist bereits gesperrt; die Daten dieses Kontos werden von diesem Gerät entfernt, und Sie werden abgemeldet.',
  'accountDelete.error.owner': 'Sie sind Inhaber dieser Betriebe: {list}. Übergeben Sie sie zuerst an ein anderes Mitglied oder beantragen Sie die Löschung des Betriebs.',
  'accountDelete.error.ownerTransfer': 'Zur Übergabe (Team)',
  'accountDelete.error.ownerDelete': 'Betrieb löschen',
  'accountDelete.error.lastAdmin': 'Sie sind der letzte Plattform-Admin. Ernennen Sie zuerst einen weiteren Admin.',
  'accountDelete.error.emailMismatch': 'Die E-Mail stimmt nicht mit Ihrer Anmelde-E-Mail überein.',
  'accountDelete.error.requestMismatch': 'Für dieses Konto läuft bereits eine Löschung. Bitte die Seite neu laden.',
  'accountDelete.localOnly': 'Im lokalen Betrieb ohne Cloud gibt es kein Konto zu löschen. Daten auf diesem Gerät entfernen Sie unter „Daten auf diesem Gerät“.',
  'accountDelete.pendingLink': 'Konto löschen',
  // Abschluss 23 — Warnung vor dem Verlust nicht abgeglichener Gerätedaten (die Löschung bleibt möglich).
  'accountDelete.deviceWarning.title': 'Achtung: Auf diesem Gerät liegen Daten, die nicht in der Cloud gesichert sind',
  'accountDelete.deviceWarning.text':
    'In den unten genannten Beständen gibt es nicht abgeglichene oder abgewiesene Änderungen, unbestätigte Zahlungen oder Entwürfe, oder sie ließen sich nicht prüfen. Nach der Kontolöschung werden die Daten dieses Kontos von diesem Gerät entfernt. Was nicht in der Cloud liegt, ist dann unwiederbringlich verloren. Gleichen Sie vorher ab, wenn Sie diese Daten behalten möchten. Die Löschung bleibt trotzdem möglich.',
  'accountDelete.deviceWarning.accountArea': 'Kontobereich ohne Betrieb',
  'accountDelete.deviceWarning.sync': 'Zur Synchronisation',
  'accountDelete.deviceWarning.dialog': 'Achtung: Daten auf diesem Gerät, die nicht in der Cloud liegen, gehen dabei unwiederbringlich verloren.',
  // Abschluss 24 — sachlicher Hinweis bei unklarem Abgleich (kein Datenverlust behauptet).
  'accountDelete.deviceNote.text':
    'Hinweis: Offene oder abgewiesene Änderungen wurden auf diesem Gerät nicht erkannt. Ein vollständiger Abgleich ist in dieser Sitzung aber nicht nachgewiesen. Wenn Sie sichergehen möchten, prüfen Sie ihn vor der Löschung.',
  'accountDelete.deviceNote.link': 'Zu „Daten auf diesem Gerät“',

  /* 1.26 — Betrieb löschen. */
  'workspaceDelete.subtitle': 'Die Löschung des Betriebs mit allen Daten und Dateien beantragen.',
  'workspaceDelete.exportHint': 'Exportieren Sie vorher die Daten, die Sie behalten möchten.',
  'workspaceDelete.exportLink': 'Zum Export',
  'workspaceDelete.retention':
    'Aufbewahrungspflichten (z. B. für Rechnungen) liegen beim Betrieb. Nach Ablauf der Frist löscht OfficeTakt alle Daten unwiderruflich. Keine Rechtsberatung.',
  'workspaceDelete.retentionConfirm': 'Ich habe den Hinweis zur Aufbewahrung und zum Export gelesen.',
  'workspaceDelete.consequences.title': 'Folgen',
  'workspaceDelete.consequences.members': 'Alle Mitglieder verlieren den Zugang.',
  'workspaceDelete.consequences.mailbox': 'Das Postfach wird getrennt.',
  'workspaceDelete.consequences.data': 'Daten und Dateien des Betriebs werden gelöscht.',
  'workspaceDelete.period': 'Die Löschung wird frühestens 30 Tage nach dem Antrag ausgeführt. Bis dahin gilt Nur-Lesen, und Sie können den Antrag widerrufen.',
  'workspaceDelete.name.label': 'Genauer Firmenname zur Bestätigung: {name}',
  'workspaceDelete.submit': 'Löschung beantragen',
  'workspaceDelete.dialog.title': 'Löschung des Betriebs beantragen?',
  'workspaceDelete.dialog.text': 'Frühestens nach 30 Tagen werden alle Daten und Dateien dieses Betriebs gelöscht. Bis dahin können Sie widerrufen.',
  'workspaceDelete.status.open': 'Die Löschung ist beantragt und wird frühestens am {date} ausgeführt.',
  'workspaceDelete.status.deleting': 'Die Löschung wird ausgeführt. Ein Widerruf ist nicht mehr möglich.',
  'workspaceDelete.revoke': 'Antrag widerrufen',
  'workspaceDelete.revoke.dialog.title': 'Antrag widerrufen?',
  'workspaceDelete.revoke.dialog.text': 'Der Betrieb bleibt bestehen; das Nur-Lesen endet.',
  'workspaceDelete.revoked': 'Der Antrag ist widerrufen.',
  'workspaceDelete.requested': 'Die Löschung ist beantragt.',
  'workspaceDelete.error.name': 'Der Firmenname stimmt nicht genau überein.',
  'workspaceDelete.error.notice': 'Der Hinweis wurde inzwischen geändert. Bitte die Seite neu laden und erneut bestätigen.',
  'workspaceDelete.error.forbidden': 'Nur der Inhaber kann die Löschung beantragen oder widerrufen.',
  'workspaceDelete.error.inProgress': 'Die Löschung läuft bereits; ein Widerruf ist nicht mehr möglich.',
  'workspaceDelete.localOnly': 'Im lokalen Betrieb ohne Cloud gibt es keinen Betrieb auf dem Server. Daten auf diesem Gerät entfernen Sie unter „Daten auf diesem Gerät“.',

  /* 1.26 — Nur-Lesen „Löschung beantragt“ auf jeder Seite. */
  'workspaceAccess.deletion.title': 'Löschung beantragt',
  'workspaceAccess.deletion.owner': 'Dieser Betrieb wird frühestens am {date} gelöscht. Bis dahin gilt Nur-Lesen; Export und Sicherung bleiben möglich. Sie können den Antrag widerrufen.',
  'workspaceAccess.deletion.admin': 'Dieser Betrieb wird frühestens am {date} gelöscht. Bis dahin gilt Nur-Lesen; Export und Sicherung bleiben möglich. Widerrufen kann nur der Inhaber.',
  'workspaceAccess.deletion.member': 'Dieser Betrieb wird frühestens am {date} gelöscht. Bis dahin gilt Nur-Lesen. Widerrufen kann nur der Inhaber.',
  'workspaceAccess.deletion.inProgress': 'Dieser Betrieb wird gerade gelöscht.',
  'workspaceAccess.deletion.manage': 'Antrag ansehen',
} as const;
