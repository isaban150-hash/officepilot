/** BRIEFE-01C — Geschäftsschreiben, türkisch. */
export const trBusinessLetter = {
  'businessLetter.area.title': 'Yazışmalar',
  'businessLetter.area.subtitle': 'Müşterilere, kurumlara ve iş ortaklarına resmî yazılar',
  'businessLetter.area.new': 'Yeni resmî yazı',
  'businessLetter.area.empty': 'Henüz yazı yok',
  'businessLetter.area.emptyHint': 'Resmî yazılarınız burada toplanır. İlkini oluşturun.',
  'businessLetter.area.search': 'Konu veya alıcı ara…',
  'businessLetter.area.searchEmpty': 'Yazı bulunamadı.',

  'businessLetter.status.draft': 'Taslak',
  'businessLetter.status.finalized': 'Tamamlandı',

  'businessLetter.editor.newTitle': 'Yeni resmî yazı',
  'businessLetter.editor.editTitle': 'Resmî yazıyı düzenle',
  'businessLetter.editor.recipientSection': 'Alıcı',
  'businessLetter.editor.recipientKind': 'Yazı kime gidiyor?',
  'businessLetter.editor.recipientCustomer': 'Müşteri listesinden',
  'businessLetter.editor.recipientFree': 'Başka bir alıcı',
  'businessLetter.editor.customer': 'Müşteri',
  'businessLetter.editor.customerPlaceholder': 'Müşteri seçin',
  'businessLetter.editor.customerHint': 'Adres devralınır ve burada değiştirilebilir.',
  'businessLetter.editor.vorgang': 'İş (isteğe bağlı)',
  'businessLetter.editor.vorgangNone': 'Bir işe bağlı değil',
  'businessLetter.editor.name': 'Ad',
  'businessLetter.editor.company': 'Firma (isteğe bağlı)',
  'businessLetter.editor.street': 'Sokak ve numara',
  'businessLetter.editor.zip': 'Posta kodu',
  'businessLetter.editor.city': 'Şehir',
  'businessLetter.editor.country': 'Ülke (isteğe bağlı)',
  'businessLetter.editor.contentSection': 'Yazı',
  'businessLetter.editor.letterDate': 'Yazı tarihi',
  'businessLetter.editor.subject': 'Konu',
  'businessLetter.editor.subjectPlaceholder': 'Konu nedir?',
  'businessLetter.editor.body': 'Metin',
  'businessLetter.editor.bodyPlaceholder': 'Yazı metnini buraya girin.',
  'businessLetter.editor.save': 'Taslağı kaydet',
  'businessLetter.editor.finalize': 'Tamamla',
  'businessLetter.editor.cancel': 'İptal',
  'businessLetter.editor.finalizeHint':
    'Tamamlandıktan sonra içerik sabitlenir ve değiştirilemez.',

  'businessLetter.detail.title': 'Resmî yazı',
  'businessLetter.detail.recipient': 'Alıcı',
  'businessLetter.detail.letterDate': 'Yazı tarihi',
  'businessLetter.detail.subject': 'Konu',
  'businessLetter.detail.body': 'Metin',
  'businessLetter.detail.customer': 'Müşteri',
  'businessLetter.detail.vorgang': 'İş',
  'businessLetter.detail.edit': 'Düzenle',
  'businessLetter.detail.finalizedHint':
    'Bu yazı tamamlandı. İçeriği değişmeden korunur.',
  'businessLetter.detail.notFound': 'Bu yazı artık mevcut değil.',
  'businessLetter.detail.back': 'Yazışmalara dön',

  'businessLetter.customer.section': 'Resmî yazılar',
  'businessLetter.customer.create': 'Resmî yazı oluştur',
  'businessLetter.customer.empty': 'Bu müşteriye henüz yazı yok.',
  'businessLetter.vorgang.section': 'Resmî yazılar',
  'businessLetter.vorgang.create': 'Resmî yazı oluştur',
  'businessLetter.vorgang.empty': 'Bu işe ait henüz yazı yok.',

  'businessLetter.toast.saved': 'Taslak kaydedildi.',
  'businessLetter.toast.finalized': 'Yazı tamamlandı.',

  'businessLetter.subjectRequired': 'Lütfen bir konu girin.',
  'businessLetter.bodyRequired': 'Lütfen bir metin yazın.',
  'businessLetter.recipientRequired': 'Lütfen bir alıcı belirtin.',
  'businessLetter.notFound': 'Bu yazı bulunamadı.',
  'businessLetter.finalizedImmutable':
    'Bu yazı tamamlandı ve artık değiştirilemez.',
  'businessLetter.alreadyFinalized': 'Bu yazı zaten tamamlandı.',
  'businessLetter.incompleteForFinalize':
    'Tamamlamadan önce konu ve metin doldurulmalıdır.',
  'businessLetter.companyProfileMissing':
    'Lütfen önce ayarlarda firma bilgilerinizi girin.',
  'businessLetter.workspaceRequired': 'Çalışma alanınız henüz hazır değil.',

  /* BRIEFE-01D */
  'businessLetter.pdf.view': 'PDF görüntüle',
  'businessLetter.pdf.download': 'PDF indir',
  'businessLetter.pdf.previewTitle': 'Önizleme',
  'businessLetter.pdf.failed':
    'Belge oluşturulamadı. Lütfen tekrar deneyin.',
  'businessLetter.detail.archive': 'Arşiv',
  'businessLetter.detail.archiveOpen': 'Belge arşivinde aç',
  'businessLetter.archiveDraftNotAllowed':
    'Taslak henüz arşivlenmez. Önce yazıyı tamamlayın.',
  'businessLetter.archiveFailed': 'Yazı arşivlenemedi.',
  'document.category.geschaeftsschreiben': 'Resmi yazı',

  /* DOKUMENTVERSTAENDNIS-01B */
  'document.accounting.notABookingDocument':
    'Bu yazı bir muhasebe belgesi değildir. İşletmeden para talep etmiyor.',
} as const;
