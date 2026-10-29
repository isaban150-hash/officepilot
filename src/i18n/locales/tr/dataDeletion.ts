/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.25a, 1.26) — Hesap silme, işletme silme, „Silme talep edildi“ salt okunur durumu.
 * Teknik eşlik (1.31); dil açısından uzman kontrolü E7 kapsamında açıktır.
 */
export const trDataDeletion = {
  'destructive.error.password': 'Şifre doğru değil.',
  'destructive.error.rateLimited': 'Çok fazla deneme. Lütfen 15 dakika sonra yeniden deneyin.',
  'destructive.error.session': 'Oturumunuzun süresi doldu. Lütfen yeniden giriş yapın.',
  'destructive.error.blocked': 'Bu hesap engellenmiş.',
  'destructive.error.confirmation': 'Onayın süresi dolmuş veya geçersiz. Lütfen yeniden onaylayın.',
  'destructive.error.unavailable': 'Hizmete şu anda ulaşılamıyor. Lütfen daha sonra yeniden deneyin.',
  'destructive.password.label': 'Mevcut şifreniz',
  'destructive.password.hint': 'Şifreyi sunucu kontrol eder; OfficeTakt şifreyi kaydetmez.',

  'accountDelete.subtitle': 'Hesabınızı ve girişinizi kalıcı olarak silin.',
  'accountDelete.waiting.link': 'Hesabı sil',
  'accountDelete.waiting.title': 'Hesabı sil',
  'accountDelete.waiting.back': 'Onay sayfasına dön',
  'accountDelete.intro':
    'Silme ile tüm üyelikleriniz sona erer. İşletmelerde adınız bundan sonra „Silinmiş hesap“ olarak görünür; işletmelerin faturaları, belgeleri ve diğer iş verileri değişmeden kalır. Silme geri alınamaz.',
  'accountDelete.ownerHint': 'Bir işletmenin sahibiyseniz, önce işletmeyi devredin veya silinmesini talep edin.',
  'accountDelete.email.label': 'Onay için giriş e-postanız',
  'accountDelete.submit': 'Hesabı kalıcı olarak sil',
  'accountDelete.dialog.title': 'Hesap silinsin mi?',
  'accountDelete.dialog.text': 'Hesabınız engellenir ve silinir, tüm üyelikler sona erer. Bu işlem geri alınamaz.',
  'accountDelete.result.completed': 'Hesabınız silindi. Bu hesabın verileri bu cihazdan kaldırılıyor; oturumunuz kapatılıyor.',
  'accountDelete.result.completing':
    'Silme başladı ve tamamlanacak. Hesabınız zaten engellendi; bu hesabın verileri bu cihazdan kaldırılıyor ve oturumunuz kapatılıyor.',
  'accountDelete.error.owner': 'Şu işletmelerin sahibisiniz: {list}. Önce bunları başka bir üyeye devredin veya işletmenin silinmesini talep edin.',
  'accountDelete.error.ownerTransfer': 'Devre git (Ekip)',
  'accountDelete.error.ownerDelete': 'İşletmeyi sil',
  'accountDelete.error.lastAdmin': 'Son platform yöneticisisiniz. Önce başka bir yönetici atayın.',
  'accountDelete.error.emailMismatch': 'E-posta, giriş e-postanızla eşleşmiyor.',
  'accountDelete.error.requestMismatch': 'Bu hesap için zaten bir silme işlemi sürüyor. Lütfen sayfayı yeniden yükleyin.',
  'accountDelete.localOnly': 'Bulutsuz yerel işletmede silinecek bir hesap yoktur. Bu cihazdaki verileri „Bu cihazdaki veriler“ altında kaldırabilirsiniz.',
  'accountDelete.pendingLink': 'Hesabı sil',
  // Abschluss 23 — Warnung vor dem Verlust nicht abgeglichener Gerätedaten (die Löschung bleibt möglich).
  'accountDelete.deviceWarning.title': 'Dikkat: Bu cihazda bulutta yedeklenmemiş veriler var',
  'accountDelete.deviceWarning.text':
    'Aşağıda adı geçen verilerde eşitlenmemiş veya reddedilmiş değişiklikler, onaylanmamış ödemeler ya da taslaklar var veya bunlar kontrol edilemedi. Hesap silindikten sonra bu hesabın verileri bu cihazdan kaldırılır. Bulutta olmayan her şey o zaman geri getirilemez şekilde kaybolur. Bu verileri saklamak istiyorsanız önce eşitleyin. Silme işlemi yine de mümkündür.',
  'accountDelete.deviceWarning.accountArea': 'İşletmesiz hesap alanı',
  'accountDelete.deviceWarning.sync': 'Senkronizasyona git',
  'accountDelete.deviceWarning.dialog': 'Dikkat: Bu cihazdaki, bulutta olmayan veriler geri getirilemez şekilde kaybolur.',
  // Abschluss 24 — sachlicher Hinweis bei unklarem Abgleich (kein Datenverlust behauptet).
  'accountDelete.deviceNote.text':
    'Not: Bu cihazda açık veya reddedilmiş değişiklik tespit edilmedi. Ancak bu oturumda eksiksiz bir eşitleme kanıtlanmadı. Emin olmak istiyorsanız silmeden önce kontrol edin.',
  'accountDelete.deviceNote.link': '„Bu cihazdaki veriler“ sayfasına git',

  'workspaceDelete.subtitle': 'İşletmenin tüm veri ve dosyalarıyla birlikte silinmesini talep edin.',
  'workspaceDelete.exportHint': 'Saklamak istediğiniz verileri önce dışa aktarın.',
  'workspaceDelete.exportLink': 'Dışa aktarmaya git',
  'workspaceDelete.retention':
    'Saklama yükümlülükleri (ör. faturalar için) işletmeye aittir. Süre dolduktan sonra OfficeTakt tüm verileri geri alınamaz şekilde siler. Hukuki danışmanlık değildir.',
  'workspaceDelete.retentionConfirm': 'Saklama ve dışa aktarma ile ilgili uyarıyı okudum.',
  'workspaceDelete.consequences.title': 'Sonuçlar',
  'workspaceDelete.consequences.members': 'Tüm üyeler erişimini kaybeder.',
  'workspaceDelete.consequences.mailbox': 'Posta kutusu bağlantısı kesilir.',
  'workspaceDelete.consequences.data': 'İşletmenin verileri ve dosyaları silinir.',
  'workspaceDelete.period': 'Silme, talepten en erken 30 gün sonra gerçekleştirilir. O zamana kadar salt okunur geçerlidir ve talebi geri alabilirsiniz.',
  'workspaceDelete.name.label': 'Onay için tam işletme adı: {name}',
  'workspaceDelete.submit': 'Silme talep et',
  'workspaceDelete.dialog.title': 'İşletmenin silinmesi talep edilsin mi?',
  'workspaceDelete.dialog.text': 'En erken 30 gün sonra bu işletmenin tüm verileri ve dosyaları silinir. O zamana kadar geri alabilirsiniz.',
  'workspaceDelete.status.open': 'Silme talep edildi ve en erken {date} tarihinde gerçekleştirilecek.',
  'workspaceDelete.status.deleting': 'Silme gerçekleştiriliyor. Geri alma artık mümkün değil.',
  'workspaceDelete.revoke': 'Talebi geri al',
  'workspaceDelete.revoke.dialog.title': 'Talep geri alınsın mı?',
  'workspaceDelete.revoke.dialog.text': 'İşletme kalır; salt okunur durum sona erer.',
  'workspaceDelete.revoked': 'Talep geri alındı.',
  'workspaceDelete.requested': 'Silme talep edildi.',
  'workspaceDelete.error.name': 'İşletme adı tam olarak eşleşmiyor.',
  'workspaceDelete.error.notice': 'Uyarı bu arada değişti. Lütfen sayfayı yeniden yükleyin ve tekrar onaylayın.',
  'workspaceDelete.error.forbidden': 'Silme talebini yalnızca işletme sahibi oluşturabilir veya geri alabilir.',
  'workspaceDelete.error.inProgress': 'Silme zaten sürüyor; geri alma artık mümkün değil.',
  'workspaceDelete.localOnly': 'Bulutsuz yerel işletmede sunucuda bir işletme yoktur. Bu cihazdaki verileri „Bu cihazdaki veriler“ altında kaldırabilirsiniz.',

  'workspaceAccess.deletion.title': 'Silme talep edildi',
  'workspaceAccess.deletion.owner': 'Bu işletme en erken {date} tarihinde silinecek. O zamana kadar salt okunur geçerlidir; dışa aktarma ve yedekleme mümkün kalır. Talebi geri alabilirsiniz.',
  'workspaceAccess.deletion.admin': 'Bu işletme en erken {date} tarihinde silinecek. O zamana kadar salt okunur geçerlidir; dışa aktarma ve yedekleme mümkün kalır. Yalnızca işletme sahibi geri alabilir.',
  'workspaceAccess.deletion.member': 'Bu işletme en erken {date} tarihinde silinecek. O zamana kadar salt okunur geçerlidir. Yalnızca işletme sahibi geri alabilir.',
  'workspaceAccess.deletion.inProgress': 'Bu işletme şu anda siliniyor.',
  'workspaceAccess.deletion.manage': 'Talebi görüntüle',
} as const;
