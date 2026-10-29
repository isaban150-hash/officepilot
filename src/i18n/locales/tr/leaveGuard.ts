/** EINRICHTUNG-01 (AP8; Verträge 1.27, 1.28) — ayrılma koruması, devam etme ve yeni onay soruları. */
export const trLeaveGuard = {
  'leaveGuard.title': 'Kaydedilmemiş değişiklikler',
  'leaveGuard.textDraft':
    'Girdileriniz taslak olarak kalır ve bu sayfayı bir sonraki açışınızda size sunulur. Sayfadan şimdi ayrılmak istiyor musunuz?',
  'leaveGuard.textLost': 'Sayfadan şimdi ayrılırsanız girdileriniz kaybolur.',
  'leaveGuard.stay': 'Kal',
  'leaveGuard.leave': 'Ayrıl',
  'formResume.offer': 'Bu formun kaydedilmemiş bir taslağı var.',
  'formResume.continue': 'Devam et',
  'formResume.discard': 'At',
  'formResume.stale': 'Veriler bu arada değiştiği için eski bir taslak atıldı.',
  'confirm.knowledgeDelete.title': 'Bilgi kaydı silinsin mi?',
  'confirm.knowledgeDelete.text': 'Kayıt silinir ve asistan artık bunu kullanamaz.',
  'confirm.knowledgeDelete.action': 'Kaydı sil',
  'confirm.logoRemove.title': 'Logo kaldırılsın mı?',
  'confirm.logoRemove.text': 'Yeni belgeler logosuz görünür. Daha önce oluşturulan belgeler logolarını korur.',
  'confirm.logoRemove.action': 'Logoyu kaldır',
  'confirm.invitationRevoke.title': 'Davet geri alınsın mı?',
  'confirm.invitationRevoke.text': 'Davet bağlantısı geçersiz olur. Daha sonra yeniden davet edebilirsiniz.',
  'confirm.invitationRevoke.action': 'Daveti geri al',
  'confirm.transferRevoke.title': 'Devir talebi geri alınsın mı?',
  'confirm.transferRevoke.text': 'İşletmenin devir talebi geri alınır. Sahip olarak kalırsınız.',
  'confirm.transferRevoke.action': 'Talebi geri al',
  'confirm.restore.title': 'Yedek geri yüklensin mi?',
  'confirm.restore.text': 'Bu işletmenin bu cihazdaki verileri yedekteki durumla değiştirilir.',
  'confirm.restore.action': 'Geri yükle',
  // EINRICHTUNG-01 (AP9; 1.32) — Skip-Link als erstes fokussierbares Element.
  'a11y.skipToContent': 'İçeriğe atla',
  // EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — B2-Fehlerseite „Seite nicht gefunden“.
  'notFound.title': 'Sayfa bulunamadı',
  'notFound.text': 'İstenen sayfa mevcut değil veya taşınmış.',
  'notFound.home': 'Ana sayfaya git',
  // EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — B2-Fehlergrenze.
  'serverError.title': 'Bir sorun oluştu',
  'serverError.text': 'Uygulama geçici olarak kullanılamıyor. Lütfen sayfayı yeniden yükleyin.',
  'serverError.retry': 'Yeniden dene',
  'serverError.devDetails': 'Teknik ayrıntılar',
} as const;
