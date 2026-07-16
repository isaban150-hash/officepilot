export const bgStorageRecommendation = {
  'storageRecommendation.level.archive_required': 'Препоръчва се спешно постоянно запазване',
  'storageRecommendation.level.archive_recommended': 'Препоръчва се постоянно запазване',
  'storageRecommendation.level.temporary_only': 'Само временно запазване',
  'storageRecommendation.level.review_required': 'Проверете присвояването',
  'storageRecommendation.level.duplicate_detected': 'Възможен дубликат',
  'storageRecommendation.level.discard_recommended': 'Запазването е по избор',

  'storageRecommendation.reason.duplicateDetected':
    'Вече съществува подобен файл – възможен е дубликат.',
  'storageRecommendation.reason.discardAdvertisement':
    'Няма разпознаваема бизнес релевантност – запазването е по избор.',
  'storageRecommendation.reason.lowOcrQuality':
    'Текстът не можа да бъде прочетен достатъчно – моля, проверете.',
  'storageRecommendation.reason.partialRecognition':
    'Текстът е разпознат само частично – моля, проверете.',
  'storageRecommendation.reason.fallbackClassification':
    'Видът документ не можа да бъде определен със сигурност.',
  'storageRecommendation.reason.uncertainCriticalFields':
    'Важни данни са несигурни – моля, проверете.',
  'storageRecommendation.reason.missingCustomer':
    'Липсва клиент или възложител – проверете присвояването.',
  'storageRecommendation.reason.insufficientEvidence':
    'Има твърде малко надеждни указания.',
  'storageRecommendation.reason.unclearClassification':
    'Значението на документа е неясно.',
  'storageRecommendation.reason.baustellenfotoTemporary':
    'Снимка от строителна площадка без процес – временно запазване.',
  'storageRecommendation.reason.baustellenfotoWithVorgang':
    'Снимка от строителна площадка с процес – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.archiveRecommended': 'Препоръчва се запазване.',

  'storageRecommendation.reason.kind.mahnung':
    'Разпознато е предупредително писмо – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.kind.zahlungserinnerung':
    'Разпознато е напомняне за плащане – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.kind.steuerbescheid':
    'Разпознато е данъчно решение – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.kind.umsatzsteuerbescheid':
    'Разпознато е ДДС решение – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.kind.freistellungsbescheinigung':
    'Разпознато е удостоверение за освобождаване – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.kind.unbedenklichkeitsbescheinigung':
    'Разпознато е удостоверение за липса на претенции – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.kind.eingangsrechnung':
    'Разпозната е входяща фактура – препоръчва се запазване.',
  'storageRecommendation.reason.kind.rechnung':
    'Разпозната е фактура – препоръчва се запазване.',
  'storageRecommendation.reason.kind.tankbeleg':
    'Разпознат е бон за горivo – препоръчва се запазване.',
  'storageRecommendation.reason.kind.auftrag':
    'Разпозната е поръчка – препоръчва се запазване.',
  'storageRecommendation.reason.kind.angebot':
    'Разпозната е оферта – препоръчва се запазване.',
  'storageRecommendation.reason.kind.werkvertrag':
    'Разпознат е договор за изработка – препоръчва се запазване.',
  'storageRecommendation.reason.kind.sonstiges':
    'Неизвестен документ – проверете присвояването.',
  'storageRecommendation.reason.kind.brief':
    'Разпознато е писмо – проверете присвояването.',
  'storageRecommendation.reason.kind.agentur_fuer_arbeit':
    'Разпознато е писмо от Агенцията по заетост – проверете и архивирайте.',

  'storageRecommendation.reason.authorityDeadline.finanzamt':
    'Писмо от Finanzamt със срок – препоръчва се постоянно запазване.',
  'storageRecommendation.reason.authorityDeadline.bg_bau':
    'Писмо от BG BAU със срок – препоръчва се постоянно запазване.',

  'storageRecommendation.folderLabel': 'Предложена архивна папка',
  'storageRecommendation.recognition.confident': 'Разпознаването изглежда правилно',
  'storageRecommendation.recognition.assign_customer': 'Моля, присвоете клиент',
  'storageRecommendation.recognition.review': 'Моля, проверете накратко',
  'storageRecommendation.steuerberater.mark': 'Може да е данъчно релевантен',
  'storageRecommendation.steuerberater.check': 'Проверете данъчната релевантност',
  'storageRecommendation.steuerberater.not_relevant': 'Счетоводител: вероятно не е релевантен',

  'storageRecommendation.disclaimer.notLegalAdvice':
    'Забележка: OfficePilot не замества правен или данъчен съвет. Моля, проверете задълженията си за съхранение.',

  'storageRecommendation.action.savePermanently': 'Запази завинаги',
  'storageRecommendation.action.temporaryOnly': 'Само временно запазване',
  'storageRecommendation.action.reviewAssignment': 'Провери присвояването',
  'storageRecommendation.action.useExisting': 'Използвай съществуващ файл',
  'storageRecommendation.action.saveAnyway': 'Все пак запази',
  'storageRecommendation.action.discard': 'Не запазвай',
} as const;
