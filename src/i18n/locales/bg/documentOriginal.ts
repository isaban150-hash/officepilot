export const bgDocumentOriginal = {
  'document.original.title': 'Оригинален файл',
  'document.original.download': 'Изтегли оригинала',
  'document.original.unavailable': 'Оригиналният файл не е наличен.',
  'document.original.uploadedAt': 'Качено на',
  'document.original.blobMissing':
    'Оригиналният файл не можа да бъде зареден. Метаданните са налични, но съдържанието липсва или е повредено.',
  'document.original.lifecycle.temp': 'Запазено временно',
  'document.original.lifecycle.expired':
    'Временният срок е изтекъл. Файлът остава запазен, докато го запазите трайно или го премахнете ръчно.',
  'document.original.lifecycle.sharedNotice':
    'Този файл се използва от {count} записа. Трайното запазване важи за всички тези записи.',
  'document.original.action.promotePermanently': 'Запази файла трайно',
  'document.original.promote.confirmShared':
    'Този файл се използва от няколко записа. Искате ли да го запазите трайно за всички?',
  'document.original.promote.success': 'Файлът беше запазен трайно.',
  'document.original.promote.alreadyCommitted': 'Файлът вече е запазен трайно.',
  'document.original.promote.error.notFound': 'Референцията към файла не беше намерена.',
  'document.original.promote.error.notTemp': 'Само временно запазени файлове могат да бъдат направени трайни.',
  'document.original.promote.error.persistFailed':
    'Промяната не можа да бъде запазена. Моля, опитайте отново.',
  'docAssistant.error.blobMissingAfterWrite':
    'Файлът беше записан, но след това не беше намерен изцяло. Моля, запазете отново.',
  'docAssistant.error.blobSizeMismatch':
    'Запазеният размер на файла се различава от оригинала. Моля, запазете отново.',
  'docAssistant.error.blobHashMismatch':
    'Запазеният файл не съвпада с оригинала. Моля, запазете отново.',
  'docAssistant.error.title.integrityFailed': 'Целостта на файла е неуспешна',
} as const;
