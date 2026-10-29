/** EINRICHTUNG-01 (AP2) — Oturum açma, oturum ve oturumu kapatma (bkz. de/authSession.ts). */
export const trAuthSession = {
  'auth.error.emailNotConfirmed':
    'E-posta adresiniz henüz onaylanmadı. Lütfen onay e-postasındaki bağlantıyı açın.',
  'auth.error.rateLimited': 'Çok fazla deneme. Lütfen biraz bekleyip yeniden deneyin.',
  'auth.error.network': 'Sunucuya bağlantı yok. Lütfen internet bağlantınızı kontrol edip yeniden deneyin.',
  'auth.error.unknown': 'Bu şu anda mümkün değil. Lütfen daha sonra yeniden deneyin.',
  'auth.error.weakPassword': 'Bu şifre çok zayıf. Lütfen daha uzun bir şifre seçin.',
  'auth.resend.action': 'Onayı yeniden gönder',
  'auth.resend.sent': 'Bu adrese ait onaylanmamış bir hesap varsa yeni bir onay e-postası gönderildi.',
  'auth.resend.wait': '{seconds} sn sonra yeniden gönder',
  'auth.register.successHint':
    'E-posta gelmedi mi? Zaten bir hesabınız varsa oturum açın veya „Şifremi unuttum“ seçeneğini kullanın.',
  'auth.logoutReason.profileMissing': 'Bu oturuma ait bir profil yok. Oturumunuz kapatıldı.',
  'auth.logoutReason.sessionInvalid':
    'Oturumunuz sonlandırıldı, örneğin „Tüm cihazlarda oturumu kapat“ ile. Lütfen yeniden oturum açın.',
  'auth.connection.banner':
    'Sunucu bağlantısında sorun var. Oturumunuz açık kalır; değişiklikler bu cihazda kaydedilir ve daha sonra aktarılır. Ödemeler, onaylar ve gönderim o zamana kadar kilitlidir.',
  'auth.connection.retry': 'Yeniden bağlan',
  'auth.profileUnavailable.title': 'Bağlantı sorunu',
  'auth.profileUnavailable.body':
    'Profiliniz şu anda yüklenemedi. Oturumunuz açık kalır; OfficeTakt otomatik olarak yeniden dener.',
  'auth.logout.action': 'Oturumu kapat',
  'auth.logout.title': 'Oturum kapatılsın mı?',
  'auth.logout.pendingWarning':
    'Bu cihazda {count} değişiklik aktarılmayı bekliyor. Kayıtlı kalırlar ve bu hesapla bir sonraki oturum açışta gönderilirler.',
  'auth.logout.cancel': 'İptal',
  'auth.logout.confirm': 'Yine de oturumu kapat',
  'auth.logout.busy': 'Oturum kapatılıyor …',
  'auth.logout.everywhere': 'Tüm cihazlarda oturumu kapat',
  'auth.logout.everywhereConfirm':
    'Bu hesabın tüm oturumları, diğer cihazlarda da sonlandırılır. Orada yeniden oturum açmak gerekir.',
  'auth.logout.everywhereAction': 'Her yerde oturumu kapat',
  'auth.logout.everywhereFailed':
    'Bağlantı olmadan tüm cihazlarda oturum kapatılamaz. Bağlantı kurulunca lütfen yeniden deneyin.',
  'legalConsent.title': 'Onay gerekli',
  'legalConsent.subtitle': 'OfficeTakt’ı kullanmaya devam etmek için lütfen hukuki metinlerin geçerli sürümünü onaylayın.',
  'legalConsent.terms': 'Kullanım şartlarını kabul ediyorum.',
  'legalConsent.privacy': 'Gizlilik bildirimini okudum ve kabul ediyorum.',
  'legalConsent.license': 'Lisans koşullarını kabul ediyorum.',
  'legalConsent.read': 'oku',
  'legalConsent.accept': 'Onayla',
  'legalConsent.decline': 'Reddet ve oturumu kapat',

  'auth.logoutReason.accountDeleted': 'Hesabınız silindi veya silme işlemi tamamlanıyor. Bu hesabın verileri bu cihazdan kaldırıldı.',
  'auth.logoutReason.deviceDataRemoved': 'Bu hesabın verileri bu cihazdan kaldırıldı. Buluttaki verileriniz değişmedi.',
} as const;
