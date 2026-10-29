/** EINRICHTUNG-01 (App-Eigenprüfung; 1.31, E-9) — acil durum içe aktarma sayfası (bkz. de/localRecoveryImport.ts). */
export const trLocalRecoveryImport = {
  'localRecovery.importLink': 'Hedef yedeğini ve karantinayı hazırla',
  'localRecovery.importNote':
    'Bağlantı ayrı bir acil durum sayfası açar. Orada yalnızca mevcut yerel veriler yedeklenir ve karantinaya alınır — hiçbir şey içe aktarılmaz ve hiçbir şey değiştirilmez.',
  'localRecoveryImport.title': 'Hedef yedeği ve karantina',
  'localRecoveryImport.intro':
    'Bu sayfa yalnızca bu adresteki mevcut yerel verileri yedekler ve yerel bir karantina kopyası oluşturur. Hiçbir şey içe aktarılmaz, hiçbir şey değiştirilmez ve bulut eşitlemesi başlatılmaz.',
  'localRecoveryImport.label.origin': 'Adres',
  'localRecoveryImport.markers.title': 'Mevcut karantina işlemleri',
  'localRecoveryImport.label.status': 'Durum',
  'localRecoveryImport.label.token': 'Tanımlayıcı',
  'localRecoveryImport.label.storageKey': 'Depolama anahtarı',
  'localRecoveryImport.markers.note':
    'Mevcut işlemler burada yalnızca gösterilir. Bu sayfa hiçbir zaman bir işaretçiyi, bir kabı veya bir dosyayı silmez.',
  'localRecoveryImport.step1.title': '1. Hedef alanı seçin',
  'localRecoveryImport.step1.hint':
    'Hiçbir şey önceden seçilmez. Yalnızca bir alan sunulsa bile alanı açıkça seçin.',
  'localRecoveryImport.noTargets': 'Bu adreste geçerli bir çalışma alanı yok.',
  'localRecoveryImport.label.workspace': 'Çalışma alanı',
  'localRecoveryImport.value.unknown': 'bilinmiyor',
  'localRecoveryImport.label.setupCompany': 'Firma (kurulum)',
  'localRecoveryImport.value.none': 'bilgi yok',
  'localRecoveryImport.label.profileCompany': 'Firma (profil)',
  'localRecoveryImport.label.savedAt': 'Kayıt tarihi',
  'localRecoveryImport.label.counts': 'İşlemler / belgeler',
  'localRecoveryImport.label.selected': 'Seçilen alan',
  'localRecoveryImport.resumed.text':
    'Sayfa, yedek indirildikten sonra kapatıldı. Hedef alan ve beklenen sağlama değeri bilinmeye devam ediyor. Hiçbir şey karantinaya alınmadı ve hiçbir şey yazılmadı.',
  'localRecoveryImport.label.expectedArchiveSha': 'Beklenen arşiv SHA-256 değeri',
  'localRecoveryImport.label.backupFilename': 'Yedeğin dosya adı',
  'localRecoveryImport.label.targetSavedAt': 'Hedef alanın durumu',
  'localRecoveryImport.resumed.hint':
    'İndirilen dosya bu sağlama değeriyle karşılaştırılabilir. Karantina için yedek yeniden hazırlanmalı, dosya yeniden seçilmeli ve karantina yeniden onaylanmalıdır — önceki onay artık geçerli değildir.',
  'localRecoveryImport.staging.blocked':
    'Bu alan için tamamlanmamış bir karantina işlemi zaten devam ediyor. Burada yalnızca gösterilir ve ona dokunulmaz.',
  'localRecoveryImport.label.startedAt': 'Başlangıç',
  'localRecoveryImport.label.archiveSha': 'Arşiv SHA-256 değeri',
  'localRecoveryImport.label.expectedFiles': 'Beklenen dosyalar',
  'localRecoveryImport.step2.action': '2. Hedef yedeğini oluştur',
  'localRecoveryImport.label.files': 'Dosyalar',
  'localRecoveryImport.step3.action': '3. Yedeği indir',
  'localRecoveryImport.fileInput.label': 'Az önce indirilen hedef yedeğini yeniden seçin',
  'localRecoveryImport.reselect.hint':
    'Geri yüklenecek yedek değil. Bu adımda hiçbir şey içe aktarılmaz.',
  'localRecoveryImport.step4.action': '4. Az önce indirilen hedef yedeğini yeniden seçin',
  'localRecoveryImport.verify.result':
    'Seçilen dosya, oluşturulan yedekle tamamen aynıdır: arşiv sağlama değeri, ham durum sağlama değeri, alan, zaman ve {count} dosya sağlama değerinin tümü.',
  'localRecoveryImport.step5.action': '5. Yerel karantina kopyası oluştur',
  'localRecoveryImport.quarantine.busy': 'Karantina kopyası oluşturuluyor. Lütfen bu sayfayı kapatmayın.',
  'localRecoveryImport.report.title': 'Sonuç raporu',
  'localRecoveryImport.label.targetStorageKey': 'Hedef depolama anahtarı',
  'localRecoveryImport.label.targetScopeKey': 'Hedef alan anahtarı',
  'localRecoveryImport.label.rawSha': 'Ham durum SHA-256 değeri',
  'localRecoveryImport.label.quarantineToken': 'Karantina tanımlayıcısı',
  'localRecoveryImport.label.markerKey': 'İşaretçi anahtarı',
  'localRecoveryImport.label.stateKey': 'Kap anahtarı',
  'localRecoveryImport.label.quarantineScopeKey': 'Karantina dosya alanı',
  'localRecoveryImport.label.completedAt': 'Zaman',
  'localRecoveryImport.label.fileRefId': 'FileRef kimliği',
  'localRecoveryImport.label.dataKey': 'Veri anahtarı',
  'localRecoveryImport.label.mimeType': 'MIME türü',
  'localRecoveryImport.label.size': 'Boyut',
  'localRecoveryImport.value.bytes': '{size} bayt',
  'localRecoveryImport.label.sha256': 'SHA-256',
  'localRecoveryImport.report.note':
    'Yerel hedef yedeği karantinaya alındı. Hiçbir şey içe aktarılmadı, hiçbir şey değiştirilmedi ve bulut eşitlemesi başlatılmadı.',
  'localRecoveryImport.targetChangeWarning':
    'İşlem sırasında veya sonrasında hedef alanda bir değişiklik ya da bu hedef için başka bir karantina işlemi algılandı. Bu durum başka hiçbir adım için onaylı değildir. Daha sonra tamamen yeniden başlayın.',
  'localRecoveryImport.readonlyNote':
    'Bu sayfa içe aktarma yapmaz, hiçbir veriyi değiştirmez, hiçbir karantina işlemini silmez, eşitleme başlatmaz ve normal uygulamaya geçmez.',
  'localRecoveryImport.msg.stagingCreated':
    'Bu alan için bu arada tamamlanmamış bir karantina işlemi oluşturuldu. Hazırlanan durum iptal edildi.',
  'localRecoveryImport.msg.targetChangedElsewhere':
    'Hedef alan başka bir görünümde değiştirildi. İşlem iptal edildi. Lütfen alanı yeniden açıkça seçin.',
  'localRecoveryImport.msg.confirmBeforeBackupFailed':
    'Oturum yedeklemeden önce doğrulanamadı. Hiçbir şey oluşturulmadı.',
  'localRecoveryImport.msg.prepareFailedReason': 'Hedef yedeği oluşturulamadı: {reason}',
  'localRecoveryImport.msg.prepareFailed': 'Hedef yedeği oluşturulamadı.',
  'localRecoveryImport.msg.downloadFailed':
    'İndirme başlatılamadı. Hiçbir şey kaydedilmedi — lütfen tekrar deneyin.',
  'localRecoveryImport.msg.reselectMismatch':
    'Seçilen dosya az önce oluşturulan hedef yedeği değil ({reason}). Hiçbir şey kaydedilmedi ve hiçbir şey içe aktarılmadı. Lütfen yedeği yeniden oluşturun.',
  'localRecoveryImport.msg.reselectUnreadable': 'Seçilen dosya okunamadı. Hiçbir şey kaydedilmedi.',
  'localRecoveryImport.msg.confirmBeforeQuarantineFailed':
    'Oturum karantinadan önce doğrulanamadı. Hiçbir şey değiştirilmedi.',
  'localRecoveryImport.msg.quarantineFailedReason': 'Karantina kopyası oluşturulmadı: {reason}',
  'localRecoveryImport.msg.quarantineFailed': 'Karantina kopyası oluşturulmadı.',
  'localRecoveryImport.msg.targetChangedSinceBackup':
    'Yerel hedef veriler son yedekten bu yana değişti. İşlem yeniden başlıyor.',
} as const;
