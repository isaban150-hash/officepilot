export const deStorageRecommendation = {
  'storageRecommendation.level.archive_required': 'Dauerhaft speichern dringend empfohlen',
  'storageRecommendation.level.archive_recommended': 'Dauerhaft speichern sinnvoll',
  'storageRecommendation.level.temporary_only': 'Nur vorübergehend behalten',
  'storageRecommendation.level.review_required': 'Zuordnung prüfen',
  'storageRecommendation.level.duplicate_detected': 'Mögliche Dublette',
  'storageRecommendation.level.discard_recommended': 'Speichern optional',

  'storageRecommendation.reason.duplicateDetected':
    'Eine ähnliche Datei existiert bereits – Dublette möglich.',
  'storageRecommendation.reason.discardAdvertisement':
    'Keine erkennbare geschäftliche Relevanz – Speichern optional.',
  'storageRecommendation.reason.lowOcrQuality':
    'Der Text konnte nur unzureichend gelesen werden – bitte prüfen.',
  'storageRecommendation.reason.partialRecognition':
    'Der Text wurde nur teilweise erkannt – bitte prüfen.',
  'storageRecommendation.reason.fallbackClassification':
    'Die Dokumentart konnte nicht sicher bestimmt werden.',
  'storageRecommendation.reason.uncertainCriticalFields':
    'Wichtige Angaben sind unsicher – bitte prüfen.',
  'storageRecommendation.reason.missingCustomer':
    'Kunde oder Auftraggeber fehlt – Zuordnung prüfen.',
  'storageRecommendation.reason.insufficientEvidence':
    'Es liegen zu wenige belastbare Hinweise vor.',
  'storageRecommendation.reason.unclearClassification':
    'Die Bedeutung des Dokuments ist unklar.',
  'storageRecommendation.reason.baustellenfotoTemporary':
    'Baustellenfoto ohne Vorgang – vorübergehend behalten.',
  'storageRecommendation.reason.baustellenfotoWithVorgang':
    'Baustellenfoto mit Vorgangsbezug – dauerhaft speichern sinnvoll.',
  'storageRecommendation.reason.archiveRecommended': 'Speichern empfohlen.',

  'storageRecommendation.reason.kind.mahnung':
    'Mahnung erkannt – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.kind.zahlungserinnerung':
    'Zahlungserinnerung erkannt – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.kind.steuerbescheid':
    'Steuerbescheid erkannt – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.kind.umsatzsteuerbescheid':
    'Umsatzsteuerbescheid erkannt – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.kind.freistellungsbescheinigung':
    'Freistellungsbescheinigung erkannt – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.kind.unbedenklichkeitsbescheinigung':
    'Unbedenklichkeitsbescheinigung erkannt – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.kind.eingangsrechnung':
    'Eingangsrechnung erkannt – Speichern empfohlen.',
  'storageRecommendation.reason.kind.rechnung':
    'Rechnung erkannt – Speichern empfohlen.',
  'storageRecommendation.reason.kind.tankbeleg':
    'Tankbeleg erkannt – Speichern empfohlen.',
  'storageRecommendation.reason.kind.auftrag':
    'Auftrag erkannt – Speichern empfohlen.',
  'storageRecommendation.reason.kind.angebot':
    'Angebot erkannt – Speichern empfohlen.',
  'storageRecommendation.reason.kind.werkvertrag':
    'Werkvertrag erkannt – Speichern empfohlen.',
  'storageRecommendation.reason.kind.sonstiges':
    'Unbekanntes Dokument – Zuordnung prüfen.',
  'storageRecommendation.reason.kind.brief':
    'Brief erkannt – Zuordnung prüfen.',

  'storageRecommendation.reason.authorityDeadline.finanzamt':
    'Finanzamt-Schreiben mit Frist – dauerhaftes Speichern wird empfohlen.',
  'storageRecommendation.reason.authorityDeadline.bg_bau':
    'BG-BAU-Schreiben mit Frist – dauerhaftes Speichern wird empfohlen.',

  'storageRecommendation.folderLabel': 'Vorgeschlagener Ablageort',
  'storageRecommendation.recognition.confident': 'Erkennung wirkt stimmig',
  'storageRecommendation.recognition.assign_customer': 'Kunde bitte zuordnen',
  'storageRecommendation.recognition.review': 'Bitte kurz prüfen',
  'storageRecommendation.steuerberater.mark': 'Kann steuerlich relevant sein',
  'storageRecommendation.steuerberater.check': 'Steuerliche Relevanz prüfen',
  'storageRecommendation.steuerberater.not_relevant': 'Steuerberater: voraussichtlich nicht relevant',

  'storageRecommendation.disclaimer.notLegalAdvice':
    'Hinweis: OfficePilot ersetzt keine Rechts- oder Steuerberatung. Bitte prüfen Sie Ihre Aufbewahrungspflicht.',

  'storageRecommendation.action.savePermanently': 'Dauerhaft speichern',
  'storageRecommendation.action.temporaryOnly': 'Nur vorübergehend behalten',
  'storageRecommendation.action.reviewAssignment': 'Zuordnung prüfen',
  'storageRecommendation.action.useExisting': 'Vorhandene Datei verwenden',
  'storageRecommendation.action.saveAnyway': 'Trotzdem speichern',
  'storageRecommendation.action.discard': 'Nicht speichern',
} as const;
