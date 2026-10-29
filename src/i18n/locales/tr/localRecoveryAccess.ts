/** EINRICHTUNG-01 (AP1, E8) — Acil durum sayfaları (bkz. de/localRecoveryAccess.ts). */
export const trLocalRecoveryAccess = {
  'localRecovery.identity.checking': 'Oturum kontrol ediliyor …',
  'localRecovery.identity.signedOut':
    'Oturum açmadan yalnızca bir hesaba bağlı olmayan verileri görürsünüz. Bir hesaba ait veriler ancak tam olarak o hesapla oturum açıldıktan sonra yedeklenebilir.',
  'localRecovery.identity.invalid':
    'Kayıtlı oturum artık geçerli değil. Hesabınızın verilerini yedeklemek için lütfen yeniden oturum açın.',
  'localRecovery.identity.offline':
    'Bağlantı olmadan oturum doğrulanamaz. Bu nedenle bir hesaba ait veriler şu anda yedeklenemez; bu cihazda değişmeden kalır.',
  'localRecovery.identity.confirmed':
    '{email} olarak oturum açıldı. Ayrıca tam olarak bu hesaba ait veriler görünür.',
  'localRecovery.boundCount': 'Bu cihazda hesaba bağlı diğer veriler: {count}',
  'localRecovery.login.title': 'Verilerin ait olduğu hesapla oturum açın',
  'localRecovery.login.email': 'E-posta',
  'localRecovery.login.password': 'Şifre',
  'localRecovery.login.submit': 'Oturum aç',
  'localRecovery.login.failed': 'Oturum açılamadı. Lütfen e-posta ve şifreyi kontrol edin.',
  'localRecovery.login.offline': 'Bağlantı yok. Oturum yalnızca çevrimiçi açılabilir.',
  'localRecovery.logout': 'Oturumu kapat (yalnızca bu cihazda)',
  'localRecovery.exportBlocked': 'Oturum yedeklemeden önce doğrulanamadı. Hiçbir şey dışa aktarılmadı.',
  'localRecovery.scope.guest': 'Misafir verileri',
  'localRecovery.scope.legacy': 'Eski veriler (hesap ayrımından önce)',
  'localRecovery.scope.legacy_setup': 'Kurulumun eski biçimi',
  'localRecovery.scope.quarantine': 'Eski verilerin karantina kopyası',
  'localRecovery.scope.user': 'Hesabınızın verileri',
  'localRecovery.scope.workspace': 'İşletme verileri',
} as const;
