export const trDocumentOriginal = {
  'document.original.title': 'Orijinal dosya',
  'document.original.download': 'Orijinali indir',
  'document.original.unavailable': 'Orijinal dosya kullanılamıyor.',
  'document.original.uploadedAt': 'Yüklenme zamanı',
  'document.original.blobMissing':
    'Orijinal dosya yüklenemedi. Meta veriler mevcut ancak dosya içeriği eksik veya bozulmuş.',
  'document.original.lifecycle.temp': 'Geçici olarak saklandı',
  'document.original.lifecycle.expired':
    'Geçici süre doldu. Dosya, kalıcı olarak kaydedene veya manuel silene kadar saklanmaya devam eder.',
  'document.original.lifecycle.sharedNotice':
    'Bu dosya {count} kayıt tarafından kullanılıyor. Kalıcı kaydetme tüm bu kayıtlar için geçerlidir.',
  'document.original.action.promotePermanently': 'Dosyayı kalıcı olarak kaydet',
  'document.original.promote.confirmShared':
    'Bu dosya birden fazla kayıt tarafından kullanılıyor. Tümü için kalıcı olarak kaydetmek istiyor musunuz?',
  'document.original.promote.success': 'Dosya kalıcı olarak kaydedildi.',
  'document.original.promote.alreadyCommitted': 'Dosya zaten kalıcı olarak kaydedilmiş.',
  'document.original.promote.error.notFound': 'Dosya referansı bulunamadı.',
  'document.original.promote.error.notTemp': 'Yalnızca geçici dosyalar kalıcı hale getirilebilir.',
  'document.original.promote.error.persistFailed':
    'Değişiklik kaydedilemedi. Lütfen tekrar deneyin.',
  'docAssistant.error.blobMissingAfterWrite':
    'Dosya yazıldı ancak ardından tam olarak bulunamadı. Lütfen yeniden kaydedin.',
  'docAssistant.error.blobSizeMismatch':
    'Kaydedilen dosya boyutu orijinalden farklı. Lütfen yeniden kaydedin.',
  'docAssistant.error.blobHashMismatch':
    'Kaydedilen dosya orijinalle eşleşmiyor. Lütfen yeniden kaydedin.',
  'docAssistant.error.title.integrityFailed': 'Dosya bütünlüğü başarısız',
} as const;
