export const trBackup = {
  'backup.title': 'Veri yedekleme',
  'backup.hint':
    'Yedek, bu işletmenin bu cihazdaki verilerini ZIP dosyası olarak içerir. Düzenli olarak, en iyisi her gün iş gününün sonunda indirin.',
  'backup.counts.title': 'Yedeğin içeriği',
  'backup.counts.emailsHint':
    'E-postalar: bu cihaza aktarılan e-postalar. Posta kutusunun gönderilen ve alınan e-postaları sunucuda bulunur.',
  'backup.area.customers': 'Müşteriler',
  'backup.area.vorgaenge': 'İşlemler',
  'backup.area.offers': 'Teklifler',
  'backup.area.invoices': 'Faturalar',
  'backup.area.payments': 'Ödemeler',
  'backup.area.expenses': 'Giderler',
  'backup.area.documents': 'Belgeler',
  'backup.area.files': 'Dosyalar',
  'backup.area.letters': 'Mektuplar',
  'backup.area.emails': 'E-postalar',
  'backup.area.tasks': 'Görevler',
  'backup.area.knowledge': 'Bilgi',
  'backup.area.bankTransactions': 'Banka hareketleri',
  'backup.area.employees': 'Çalışanlar',
  'backup.area.employeePayments': 'Çalışan ödemeleri',
  'backup.area.accountingAssignments': 'Hesap atamaları',
  'backup.area.settings': 'Ayarlar',
  'backup.download': 'Yedek indirme',
  'backup.loading': 'Yedek oluşturuluyor…',
  'backup.success':
    'Yedeğin indirilmesi başlatıldı. Lütfen dosyanın indirme klasörünüze ulaşıp ulaşmadığını kontrol edin.',
  'backup.successPartial':
    'Kısmi yedeğin indirilmesi başlatıldı. Şu dosyalar yedekte yer almıyor:',
  'backup.error.missingFile':
    'Şu dosyalar eksik olduğu için yedek oluşturulmadı:',
  'backup.missing.hint':
    'Eksik dosyalar olmadan yedekleyebilirsiniz. Dosya bu durumda kısmi yedek olarak işaretlenir.',
  'backup.missing.allowPartial': 'Eksik dosyalar olmadan yedekle',
  'backup.missing.cancel': 'İptal',
  'backup.missing.unnamed': 'Adsız dosya',
  'backup.error.credentials':
    'Yerel veriler yedeğe ait olmayan oturum bilgileri içerdiği için yedek oluşturulmadı.',
  'backup.error.failed': 'Yedek oluşturulamadı. Lütfen tekrar deneyin.',
  'backup.export.notAllowed': 'Yedekleri yalnızca bu işletmenin sahipleri ve yöneticileri oluşturabilir.',

  'backup.validate.chooseFile': 'Yedek seç',
  'backup.validate.checking': 'Kontrol ediliyor …',
  'backup.validate.previewTitle': 'Yedek önizlemesi',
  'backup.validate.exportedAt': 'Dışa aktarma tarihi',
  'backup.validate.schemaVersion': 'Yedek sürümü',
  'backup.validate.recordCount': 'Kayıt sayısı',
  'backup.validate.fileCount': 'Dosya sayısı',
  'backup.validate.totalSize': 'Toplam boyut',
  'backup.validate.replaceHint': 'Geri yükleme, bu işletmenin bu cihazdaki verilerini değiştirir.',
  'backup.validate.contentTitle': 'Alanlara göre içerik',
  'backup.validate.incomplete':
    'Bu yedek kısmi bir yedektir. Şu dosyalar yedekte yer almıyor:',

  'backup.validate.error.invalid': 'Dosya geçerli bir OfficeTakt yedeği değil.',
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

  'backup.restore.confirm': 'Bu işletmenin bu cihazdaki verilerinin değiştirileceğini anlıyorum.',
  'backup.restore.confirmIncomplete':
    'Bu dosyaların geri yüklemeden sonra eksik olacağını anladım.',
  'backup.restore.cloudBlocked':
    'Bulut modunda verileriniz sunucuda bulunur. Yerel bir yedek bu verilerin yerini alamaz; bu nedenle geri yükleme burada kullanılamaz.',
  'backup.restore.action': 'Yedeği geri yükle',
  'backup.restore.success': 'Geri yükleme tamamlandı. Sayfa yenilenecek.',
  'backup.restore.phase.safety': 'Güvenlik yedeği oluşturuluyor …',
  'backup.restore.phase.stage': 'Dosyalar hazırlanıyor …',
  'backup.restore.phase.commit': 'Veriler geri yükleniyor …',
  'backup.restore.phase.verify': 'Geri yükleme kontrol ediliyor …',
  'backup.restore.phase.rollback': 'Önceki durum geri yükleniyor …',

  'backup.restore.error.notValidated': 'Lütfen önce geçerli bir yedek seçip kontrol edin.',
  'backup.restore.error.notConfirmed':
    'Lütfen bu işletmenin bu cihazdaki verilerinin değiştirilebileceğini onaylayın.',
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
  'backup.restore.error.cloudWorkspace':
    'Bulut modunda yerel bir yedekten geri yükleme yapılamaz. Verileriniz değiştirilmedi.',
} as const;
