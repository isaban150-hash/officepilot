/** EINRICHTUNG-01 (AP8; Vertrag 1.29; Abschluss 22 zu E-13) — „Veriler › Bu cihazdaki veriler“. */
export const trDeviceData = {
  'deviceData.subtitle': 'Bu hesabın bu cihazda sakladıkları ve bunları nasıl kaldıracağınız.',
  'deviceData.local':
    'Bulutsuz yerel işletmede tüm veriler yalnızca bu cihazdadır. İkinci bir kopya olmadığı için burada kaldırma öngörülmemiştir; verilerinizi „Yedekleme“ ile yedekleyin.',
  'deviceData.own.title': 'Bu hesabın verileri',
  'deviceData.own.empty': 'Bu cihazda bu hesap için kayıtlı bir şey yok.',
  'deviceData.accountArea': 'İşletmesiz hesap alanı',
  'deviceData.size': 'Boyut: {size}',
  'deviceData.saved': 'Son kayıt: {date}',
  'deviceData.lastSync': 'Son eşitleme: {date}',
  'deviceData.open': 'Açık değişiklikler: {count}',
  'deviceData.rejected': 'Reddedilen değişiklikler: {count}',
  'deviceData.others': 'Bu cihazda verisi olan diğer hesaplar: {count}. Kaldırma sırasında onların verileri korunur.',
  'deviceData.remove.title': 'Verileri bu cihazdan kaldır',
  'deviceData.remove.text':
    'Bu hesabın bu cihazdaki tüm verilerini kaldırır: kayıtlı veriler, dosyalar, taslaklar ve erişim bilgileri. Ardından bu cihazda oturumunuz kapatılır. Buluttaki verileriniz değişmez.',
  'deviceData.remove.ready':
    'Tüm veriler bu oturumda eksiksiz eşitlendi ve hiçbir şey yalnızca bu cihazda değil. Verileri kaldırabilirsiniz.',
  'deviceData.remove.blocked':
    'Bu cihazda bulutta kaydedildiği kanıtlanmamış veriler var. Bu durum sürdükçe kaldırılmazlar — bir yedek dosyasıyla da: Bulut işletiminde bir yedek şu anda geri yüklenemez.',
  'deviceData.checking': 'Bu cihazdaki taslaklar kontrol ediliyor …',
  'deviceData.block.unsynced':
    'Eşitlenmemiş veya reddedilmiş değişiklikler, onaylanmamış ödemeler ya da başlamış bir onaylama. Lütfen önce eşitleyin veya reddi açıklığa kavuşturun.',
  'deviceData.block.not_verified':
    'Bu oturumda bu işletmenin eksiksiz eşitlendiği kanıtlanmadı ya da o zamandan beri değişti. İşletmeye geçin ve eşitlemeyi orada kontrol edin.',
  'deviceData.block.unreadable': 'Kayıtlı veriler okunamıyor ve bu nedenle kontrol edilemiyor.',
  'deviceData.block.local_only':
    'Yalnızca bu cihazda tutulan ve hiç eşitlenmeyen veriler (işletmesiz hesap alanı veya eski e-posta içe aktarımı).',
  'deviceData.block.draft':
    'Yalnızca bu cihazda bulunan taslaklar (fatura, yükleme, müşteri ataması, gönderim veya kurulum). Lütfen tamamlayın veya vazgeçin.',
  'deviceData.block.check_failed': 'Bu cihazdaki taslaklar kontrol edilemedi.',
  'deviceData.backup.noUnlock':
    '{date} tarihli „{name}“ yedeği mevcut. Bulut işletiminde şu anda geri yüklenemediği için eşitlemenin yerini tutmaz.',
  'deviceData.verify.action': 'Eşitlemeyi şimdi kontrol et',
  'deviceData.verify.hint':
    'Etkin işletmeyi eksiksiz eşitler ve ardından açık bir şey kalmadığını kaydeder. Diğer işletmeleri onlara geçtikten sonra kontrol edersiniz.',
  'deviceData.verify.ok': 'Etkin işletme eksiksiz eşitlendi.',
  'deviceData.verify.failed': 'Eşitleme tam olarak başarılı olmadı veya hâlâ açık bir şey var. Hiçbir şey kaldırılmaz.',
  'deviceData.way.sync': 'Senkronizasyona git',
  'deviceData.way.backup': 'Yedeklemeye git',
  'deviceData.remove.action': 'Verileri kaldır',
  'deviceData.remove.dialogTitle': 'Bu hesabın verileri bu cihazdan kaldırılsın mı?',
  'deviceData.remove.dialogText':
    'Bu hesabın bu cihazdaki tüm verileri kaldırılır ve oturumunuz kapatılır. Onaylamak için {word} kelimesini girin.',
  'deviceData.remove.word': 'KALDIR',
  'deviceData.remove.wordLabel': 'Onay kelimesi',
  'deviceData.error.otherTabs':
    'Bu hesapla açık başka bir sekme oturumu kapatmadı. Diğer sekmeleri kapatıp tekrar deneyin. Hiçbir şey kaldırılmadı.',
  'deviceData.error.blocked':
    'Kaldırmadan önceki yeniden kontrolde yalnızca bu cihazda bulunan veriler bulundu. Hiçbir şey kaldırılmadı.',
  'deviceData.error.failed': 'Veriler kaldırılamadı. Lütfen tekrar deneyin.',
} as const;
