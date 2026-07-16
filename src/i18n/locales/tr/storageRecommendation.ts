export const trStorageRecommendation = {
  'storageRecommendation.level.archive_required': 'Kalıcı kaydetme acilen önerilir',
  'storageRecommendation.level.archive_recommended': 'Kalıcı kaydetme mantıklı',
  'storageRecommendation.level.temporary_only': 'Yalnızca geçici sakla',
  'storageRecommendation.level.review_required': 'Atamayı kontrol et',
  'storageRecommendation.level.duplicate_detected': 'Olası kopya',
  'storageRecommendation.level.discard_recommended': 'Kaydetme isteğe bağlı',

  'storageRecommendation.reason.duplicateDetected':
    'Benzer bir dosya zaten mevcut – kopya olabilir.',
  'storageRecommendation.reason.discardAdvertisement':
    'Tanınabilir işlevsel bir ilgi yok – kaydetme isteğe bağlı.',
  'storageRecommendation.reason.lowOcrQuality':
    'Metin yeterince okunamadı – lütfen kontrol edin.',
  'storageRecommendation.reason.partialRecognition':
    'Metin yalnızca kısmen tanındı – lütfen kontrol edin.',
  'storageRecommendation.reason.fallbackClassification':
    'Belge türü güvenle belirlenemedi.',
  'storageRecommendation.reason.uncertainCriticalFields':
    'Önemli bilgiler belirsiz – lütfen kontrol edin.',
  'storageRecommendation.reason.missingCustomer':
    'Müşteri veya sipariş veren eksik – atamayı kontrol edin.',
  'storageRecommendation.reason.insufficientEvidence':
    'Yeterli güvenilir ipucu yok.',
  'storageRecommendation.reason.unclearClassification':
    'Belgenin anlamı belirsiz.',
  'storageRecommendation.reason.baustellenfotoTemporary':
    'İşlem olmadan şantiye fotoğrafı – geçici saklayın.',
  'storageRecommendation.reason.baustellenfotoWithVorgang':
    'İşlem bağlantılı şantiye fotoğrafı – kalıcı kaydetme mantıklı.',
  'storageRecommendation.reason.archiveRecommended': 'Kaydetme önerilir.',

  'storageRecommendation.reason.kind.mahnung':
    'İhtarname tanındı – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.kind.zahlungserinnerung':
    'Ödeme hatırlatması tanındı – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.kind.steuerbescheid':
    'Vergi kararı tanındı – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.kind.umsatzsteuerbescheid':
    'KDV kararı tanındı – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.kind.freistellungsbescheinigung':
    'Muafiyet belgesi tanındı – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.kind.unbedenklichkeitsbescheinigung':
    'Borçsuzluk belgesi tanındı – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.kind.eingangsrechnung':
    'Gelen fatura tanındı – kaydetme önerilir.',
  'storageRecommendation.reason.kind.rechnung':
    'Fatura tanındı – kaydetme önerilir.',
  'storageRecommendation.reason.kind.tankbeleg':
    'Yakıt fişi tanındı – kaydetme önerilir.',
  'storageRecommendation.reason.kind.auftrag':
    'Sipariş tanındı – kaydetme önerilir.',
  'storageRecommendation.reason.kind.angebot':
    'Teklif tanındı – kaydetme önerilir.',
  'storageRecommendation.reason.kind.werkvertrag':
    'İş sözleşmesi tanındı – kaydetme önerilir.',
  'storageRecommendation.reason.kind.sonstiges':
    'Bilinmeyen belge – atamayı kontrol edin.',
  'storageRecommendation.reason.kind.brief':
    'Mektup tanındı – atamayı kontrol edin.',
  'storageRecommendation.reason.kind.agentur_fuer_arbeit':
    'İş Kurumu yazısı tanındı – atamayı kontrol edin ve arşivleyin.',

  'storageRecommendation.reason.authorityDeadline.finanzamt':
    'Finanzamt yazısı ve süre – kalıcı kaydetme önerilir.',
  'storageRecommendation.reason.authorityDeadline.bg_bau':
    'BG BAU yazısı ve süre – kalıcı kaydetme önerilir.',

  'storageRecommendation.folderLabel': 'Önerilen arşiv yolu',
  'storageRecommendation.recognition.confident': 'Tanıma tutarlı görünüyor',
  'storageRecommendation.recognition.assign_customer': 'Müşteri lütfen atanmalı',
  'storageRecommendation.recognition.review': 'Lütfen kısaca kontrol edin',
  'storageRecommendation.steuerberater.mark': 'Vergisel olarak ilgili olabilir',
  'storageRecommendation.steuerberater.check': 'Vergisel ilgiyi kontrol edin',
  'storageRecommendation.steuerberater.not_relevant': 'Mali müşavir: muhtemelen ilgili değil',

  'storageRecommendation.disclaimer.notLegalAdvice':
    'Not: OfficePilot hukuk veya vergi danışmanlığının yerini almaz. Lütfen saklama yükümlülüğünüzü kontrol edin.',

  'storageRecommendation.action.savePermanently': 'Kalıcı olarak kaydet',
  'storageRecommendation.action.temporaryOnly': 'Yalnızca geçici sakla',
  'storageRecommendation.action.reviewAssignment': 'Atamayı kontrol et',
  'storageRecommendation.action.useExisting': 'Mevcut dosyayı kullan',
  'storageRecommendation.action.saveAnyway': 'Yine de kaydet',
  'storageRecommendation.action.discard': 'Kaydetme',
} as const;
