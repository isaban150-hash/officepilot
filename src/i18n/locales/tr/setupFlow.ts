/** EINRICHTUNG-01 (AP3; O-01 bis O-05) — kurulum sihirbazı ve kilitleri (bkz. de/setupFlow.ts). */
export const trSetupFlow = {
  'setupFlow.field.legalForm': 'Hukuki biçim (isteğe bağlı)',
  'setupFlow.field.country': 'Ülke',
  'setupFlow.field.phone': 'Telefon (isteğe bağlı)',
  'setupFlow.resumed': 'Kaydedilmiş taslağınız yüklendi. Kaldığınız yerden devam ediyorsunuz.',
  'setupFlow.completing': 'Tamamlanıyor …',
  'setupFlow.retry': 'Tekrar dene',
  'setupFlow.numberRange.network':
    'Bağlantı olmadığı için son fatura numarası sunucuya kaydedilemedi. Kurulum henüz tamamlanmadı; girdileriniz korunur.',
  'setupFlow.numberRange.forbidden':
    'Sunucu son fatura numarasını reddetti (rol veya lisans). Kurulum henüz tamamlanmadı; girdileriniz korunur.',
  'setupFlow.numberRange.failed':
    'Son fatura numarası sunucuya kaydedilemedi. Kurulum henüz tamamlanmadı; girdileriniz korunur.',
  'setupFlow.member.title': 'İşletme henüz kuruluyor',
  'setupFlow.member.hint': 'Kurulumu bu işletmenin sahibi veya bir yönetici yapar.',
  'setupFlow.member.next': 'Kurulum tamamlandığında „Tekrar kontrol et“ ile devam edebilirsiniz.',
  'setupFlow.license.title': 'İşletme lisansı geçerli değil',
  'setupFlow.license.hint': 'İşletmenin lisansı geçerli olduğunda kurulum yeniden mümkündür.',
  'setupFlow.unknown.title': 'Bu işletmedeki rolünüz doğrulanmadı',
  'setupFlow.unknown.hint':
    'Doğrulanmış bir rol olmadan OfficeTakt kurulumu açmaz. Bağlantı olduğunda lütfen tekrar kontrol edin.',
  'setupFlow.companyRejected.message':
    'Sunucu firma bilgilerindeki son değişikliği reddetti. Değişiklik yalnızca bu cihazda geçerli; sunucudaki firma adı ve işletme adı değişmedi.',
  'setupFlow.companyRejected.open': 'Firma bilgilerini kontrol et',
  'setupFlow.team.hint': 'Çalışanlar davetle katılır. Bunu daha sonra Ayarlar › Ekip altında da yapabilirsiniz.',
  'setupFlow.team.finishAndInvite': 'Tamamla ve ekibi davet et',
} as const;
