export const trBackup = {
  'backup.title': 'Veri yedekleme',
  'backup.hint':
    'Verileriniz şu anda yalnızca bu tarayıcıda duruyor. Düzenli olarak bir yedek indirin.',
  'backup.download': 'Yedek indirme',
  'backup.loading': 'Yedek oluşturuluyor…',
  'backup.success': 'Yedek indirildi.',
  'backup.error.missingFile':
    'Gerekli bir dosya eksik olduğu için yedek oluşturulamadı.',
  'backup.error.failed': 'Yedek oluşturulamadı. Lütfen tekrar deneyin.',

  'backup.validate.chooseFile': 'Yedek seç',
  'backup.validate.checking': 'Kontrol ediliyor …',
  'backup.validate.previewTitle': 'Yedek önizlemesi',
  'backup.validate.exportedAt': 'Dışa aktarma tarihi',
  'backup.validate.schemaVersion': 'Yedek sürümü',
  'backup.validate.recordCount': 'Kayıt sayısı',
  'backup.validate.fileCount': 'Dosya sayısı',
  'backup.validate.totalSize': 'Toplam boyut',
  'backup.validate.replaceHint':
    'Geri yükleme daha sonra bu tarayıcıdaki tüm yerel OfficePilot verilerini değiştirir.',
  'backup.validate.restoreUnavailable': 'Geri yükleme bu sürümde henüz kullanılamıyor.',

  'backup.validate.error.invalid': 'Dosya geçerli bir OfficePilot yedeği değil.',
  'backup.validate.error.tooLarge': 'Dosya çok büyük; kontrol edilemiyor.',
  'backup.validate.error.structure': 'Yedek dosya yapısı geçersiz veya eksik.',
  'backup.validate.error.manifest': 'Yedek içindekiler listesi geçersiz.',
  'backup.validate.error.schema': 'Bu yedek sürümü desteklenmiyor.',
  'backup.validate.error.appState': 'Yedekteki uygulama durumu geçersiz.',
  'backup.validate.error.nonImportable':
    'Dosya, geri yüklenmemesi gereken veriler içeriyor.',
  'backup.validate.error.blobs':
    'Yedekteki dosyalar içindekiler listesiyle uyuşmuyor.',
  'backup.validate.error.refs':
    'Yedekteki dosya başvuruları eksik veya çelişkili.',
  'backup.validate.error.limits':
    'Yedek izin verilen boyut veya sayı sınırlarını aşıyor.',
} as const;
