export const deBackup = {
  'backup.title': 'Datensicherung',
  'backup.hint':
    'Deine Daten liegen derzeit nur in diesem Browser. Lade regelmäßig eine Datensicherung herunter.',
  'backup.download': 'Datensicherung herunterladen',
  'backup.loading': 'Datensicherung wird erstellt…',
  'backup.success': 'Datensicherung wurde heruntergeladen.',
  'backup.error.missingFile':
    'Die Datensicherung konnte nicht erstellt werden, weil eine benötigte Datei fehlt.',
  'backup.error.failed': 'Die Datensicherung konnte nicht erstellt werden. Bitte erneut versuchen.',

  'backup.validate.chooseFile': 'Datensicherung auswählen',
  'backup.validate.checking': 'Wird geprüft …',
  'backup.validate.previewTitle': 'Vorschau der Datensicherung',
  'backup.validate.exportedAt': 'Exportdatum',
  'backup.validate.schemaVersion': 'Backup-Version',
  'backup.validate.recordCount': 'Anzahl Datensätze',
  'backup.validate.fileCount': 'Anzahl Dateien',
  'backup.validate.totalSize': 'Gesamtgröße',
  'backup.validate.replaceHint':
    'Die Wiederherstellung würde später alle lokalen OfficePilot-Daten in diesem Browser ersetzen.',
  'backup.validate.restoreUnavailable': 'Wiederherstellung ist in dieser Version noch nicht verfügbar.',

  'backup.validate.error.invalid': 'Die Datei ist keine gültige OfficePilot-Datensicherung.',
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
} as const;
