export const trBackup = {
  'backup.title': 'Veri yedekleme',
  'backup.hint':
    'Bulut senkronizasyonuna ek olarak her iş gününün sonunda ZIP yedek indirmeniz önerilir.',
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
    'Geri yükleme bu tarayıcıdaki tüm yerel OfficePilot verilerini değiştirir.',

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

  'backup.restore.confirm':
    'Bu tarayıcıdaki tüm yerel OfficePilot verilerinin değiştirileceğini anlıyorum.',
  'backup.restore.action': 'Yedeği geri yükle',
  'backup.restore.success': 'Geri yükleme tamamlandı. Sayfa yenilenecek.',
  'backup.restore.phase.safety': 'Güvenlik yedeği oluşturuluyor …',
  'backup.restore.phase.stage': 'Dosyalar hazırlanıyor …',
  'backup.restore.phase.commit': 'Veriler geri yükleniyor …',
  'backup.restore.phase.verify': 'Geri yükleme kontrol ediliyor …',
  'backup.restore.phase.rollback': 'Önceki durum geri yükleniyor …',

  'backup.restore.error.notValidated': 'Lütfen önce geçerli bir yedek seçip kontrol edin.',
  'backup.restore.error.notConfirmed': 'Lütfen yerel verilerin değiştirilmesini onaylayın.',
  'backup.restore.error.safety':
    'Güvenlik yedeği oluşturulamadığı için geri yükleme iptal edildi.',
  'backup.restore.error.stage':
    'Geri yükleme iptal edildi. Mevcut verileriniz değişmedi.',
  'backup.restore.error.commit': 'Geri yükleme başarısız oldu.',
  'backup.restore.error.verify':
    'Geri yükleme doğrulanamadı. Önceki durum geri yüklendi.',
  'backup.restore.error.rollback':
    'Geri yükleme başarısız oldu. Lütfen son yedeğinizi elle yükleyin.',
  'backup.restore.error.failed': 'Geri yükleme başarısız oldu.',
} as const;
