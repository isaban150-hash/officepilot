export const deDocumentOriginal = {
  'document.original.title': 'Originaldatei',
  'document.original.download': 'Original herunterladen',
  'document.original.unavailable': 'Originaldatei nicht verfügbar.',
  'document.original.uploadedAt': 'Hochgeladen am',
  'document.original.blobMissing':
    'Die Originaldatei konnte nicht geladen werden. Die Dateimetadaten sind vorhanden, der Dateiinhalt fehlt oder ist beschädigt.',
  'document.original.lifecycle.temp': 'Vorübergehend gespeichert',
  'document.original.lifecycle.expired':
    'Die vorübergehende Frist ist überschritten. Die Datei bleibt gespeichert, bis Sie sie dauerhaft speichern oder manuell entfernen.',
  'document.original.lifecycle.sharedNotice':
    'Diese Datei wird von {count} Einträgen verwendet. Dauerhaft speichern gilt für alle diese Einträge.',
  'document.original.action.promotePermanently': 'Datei dauerhaft speichern',
  'document.original.promote.confirmShared':
    'Diese Datei wird von mehreren Einträgen verwendet. Möchten Sie sie für alle dauerhaft speichern?',
  'document.original.promote.success': 'Datei wurde dauerhaft gespeichert.',
  'document.original.promote.alreadyCommitted': 'Die Datei ist bereits dauerhaft gespeichert.',
  'document.original.promote.error.notFound': 'Die Dateireferenz wurde nicht gefunden.',
  'document.original.promote.error.notTemp': 'Nur vorübergehend gespeicherte Dateien können dauerhaft gemacht werden.',
  'document.original.promote.error.persistFailed':
    'Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.',
  'docAssistant.error.blobMissingAfterWrite':
    'Die Datei wurde geschrieben, aber danach nicht vollständig gefunden. Bitte erneut speichern.',
  'docAssistant.error.blobSizeMismatch':
    'Die gespeicherte Dateigröße weicht vom Original ab. Bitte erneut speichern.',
  'docAssistant.error.blobHashMismatch':
    'Die gespeicherte Datei stimmt nicht mit dem Original überein. Bitte erneut speichern.',
  'docAssistant.error.title.integrityFailed': 'Dateiintegrität fehlgeschlagen',
} as const;
