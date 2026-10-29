export const deBackup = {
  'backup.title': 'Datensicherung',
  // EINRICHTUNG-01 (AP7; 1.23) — die Sicherung betrifft diesen Betrieb auf diesem Gerät, nicht „alle Daten im Browser“.
  'backup.hint':
    'Die Sicherung enthält die Daten dieses Betriebs auf diesem Gerät als ZIP-Datei. Laden Sie sie regelmäßig herunter, am besten täglich am Ende des Arbeitstags.',
  'backup.counts.title': 'Inhalt der Sicherung',
  'backup.counts.emailsHint':
    'E-Mails: auf diesem Gerät übernommene E-Mails. Gesendete und empfangene E-Mails des Postfachs liegen auf dem Server.',
  'backup.area.customers': 'Kunden',
  'backup.area.vorgaenge': 'Vorgänge',
  'backup.area.offers': 'Angebote',
  'backup.area.invoices': 'Rechnungen',
  'backup.area.payments': 'Zahlungen',
  'backup.area.expenses': 'Ausgaben',
  'backup.area.documents': 'Dokumente',
  'backup.area.files': 'Dateien',
  'backup.area.letters': 'Briefe',
  'backup.area.emails': 'E-Mails',
  'backup.area.tasks': 'Aufgaben',
  'backup.area.knowledge': 'Wissen',
  'backup.area.bankTransactions': 'Bankumsätze',
  'backup.area.employees': 'Mitarbeiter',
  'backup.area.employeePayments': 'Mitarbeiterzahlungen',
  'backup.area.accountingAssignments': 'Kontierungen',
  'backup.area.settings': 'Einstellungen',
  'backup.download': 'Datensicherung herunterladen',
  'backup.loading': 'Datensicherung wird erstellt…',
  // EINRICHTUNG-01 (S-12.2) — der Browser meldet nur den Start des Downloads, nicht das Speichern.
  'backup.success':
    'Der Download der Datensicherung wurde gestartet. Bitte prüfen Sie, ob die Datei in Ihrem Download-Ordner angekommen ist.',
  'backup.successPartial':
    'Der Download der Teilsicherung wurde gestartet. Diese Dateien sind darin nicht enthalten:',
  'backup.error.missingFile':
    'Die Datensicherung wurde nicht erstellt, weil diese Dateien fehlen:',
  'backup.missing.hint':
    'Sie können ohne die fehlenden Dateien sichern. Die Datei wird dann als Teilsicherung gekennzeichnet.',
  'backup.missing.allowPartial': 'Ohne fehlende Dateien sichern',
  'backup.missing.cancel': 'Abbrechen',
  'backup.missing.unnamed': 'Datei ohne Namen',
  'backup.error.credentials':
    'Die Datensicherung wurde nicht erstellt, weil der lokale Bestand Anmeldedaten enthält, die nicht in eine Sicherung gehören.',
  'backup.error.failed': 'Die Datensicherung konnte nicht erstellt werden. Bitte erneut versuchen.',
  'backup.export.notAllowed': 'Datensicherungen können nur Inhaber und Administratoren dieses Betriebs erstellen.',

  'backup.validate.chooseFile': 'Datensicherung auswählen',
  'backup.validate.checking': 'Wird geprüft …',
  'backup.validate.previewTitle': 'Vorschau der Datensicherung',
  'backup.validate.exportedAt': 'Exportdatum',
  'backup.validate.schemaVersion': 'Backup-Version',
  'backup.validate.recordCount': 'Anzahl Datensätze',
  'backup.validate.fileCount': 'Anzahl Dateien',
  'backup.validate.totalSize': 'Gesamtgröße',
  'backup.validate.replaceHint': 'Die Wiederherstellung ersetzt die Daten dieses Betriebs auf diesem Gerät.',
  'backup.validate.contentTitle': 'Inhalt nach Bereichen',
  'backup.validate.incomplete':
    'Diese Datensicherung ist eine Teilsicherung. Folgende Dateien sind nicht enthalten:',

  'backup.validate.error.invalid': 'Die Datei ist keine gültige OfficeTakt-Datensicherung.',
  'backup.validate.error.tooLarge': 'Die Datei ist zu groß und kann nicht geprüft werden.',
  'backup.validate.error.structure':
    'Die Dateistruktur der Datensicherung ist ungültig oder unvollständig.',
  'backup.validate.error.manifest': 'Das Inhaltsverzeichnis der Datensicherung ist ungültig.',
  'backup.validate.error.schema':
    'Diese Backup-Version wird nicht unterstützt.',
  'backup.validate.error.appState': 'Der gespeicherte App-Zustand in der Datensicherung ist ungültig.',
  'backup.validate.error.nonImportable':
    'Die Datei enthält Daten, die nicht wiederhergestellt werden dürfen.',
  'backup.validate.error.blobs':
    'Die Dateien in der Datensicherung stimmen nicht mit dem Inhaltsverzeichnis überein.',
  'backup.validate.error.refs':
    'Die Dateiverweise in der Datensicherung sind unvollständig oder widersprüchlich.',
  'backup.validate.error.limits':
    'Die Datensicherung überschreitet zulässige Größen- oder Anzahlgrenzen.',

  'backup.restore.confirm': 'Ich verstehe, dass die Daten dieses Betriebs auf diesem Gerät ersetzt werden.',
  'backup.restore.confirmIncomplete':
    'Ich habe verstanden, dass diese Dateien nach der Wiederherstellung fehlen.',
  'backup.restore.cloudBlocked':
    'Im Cloud-Betrieb liegen Ihre Daten auf dem Server. Eine lokale Datensicherung kann diesen Bestand nicht ersetzen, deshalb ist die Wiederherstellung hier nicht verfügbar.',
  'backup.restore.action': 'Datensicherung wiederherstellen',
  'backup.restore.success': 'Wiederherstellung abgeschlossen. Die Seite wird neu geladen.',
  'backup.restore.phase.safety': 'Sicherheitsbackup wird erstellt …',
  'backup.restore.phase.stage': 'Dateien werden vorbereitet …',
  'backup.restore.phase.commit': 'Daten werden wiederhergestellt …',
  'backup.restore.phase.verify': 'Wiederherstellung wird geprüft …',
  'backup.restore.phase.rollback': 'Vorheriger Stand wird wiederhergestellt …',

  'backup.restore.error.notValidated':
    'Bitte zuerst eine gültige Datensicherung auswählen und prüfen.',
  'backup.restore.error.notConfirmed':
    'Bitte bestätigen Sie, dass die Daten dieses Betriebs auf diesem Gerät ersetzt werden dürfen.',
  'backup.restore.error.safety':
    'Die Wiederherstellung wurde abgebrochen, weil das Sicherheitsbackup nicht erstellt werden konnte.',
  'backup.restore.error.stage':
    'Die Wiederherstellung wurde abgebrochen. Ihre bisherigen Daten wurden nicht verändert.',
  'backup.restore.error.commit':
    'Die Wiederherstellung ist fehlgeschlagen.',
  'backup.restore.error.verify':
    'Die Wiederherstellung konnte nicht bestätigt werden. Der vorherige Stand wurde wiederhergestellt.',
  'backup.restore.error.rollback':
    'Die Wiederherstellung ist fehlgeschlagen. Bitte laden Sie Ihre letzte Datensicherung manuell.',
  'backup.restore.error.failed': 'Die Wiederherstellung ist fehlgeschlagen.',
  'backup.restore.error.cloudWorkspace':
    'Im Cloud-Betrieb ist keine Wiederherstellung aus einer lokalen Datensicherung möglich. Ihre Daten wurden nicht verändert.',
} as const;
