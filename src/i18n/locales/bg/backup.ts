export const bgBackup = {
  'backup.title': 'Резервно копие',
  'backup.hint':
    'Данните ви са само в този браузър. Изтегляйте редовно резервно копие.',
  'backup.download': 'Изтегляне на резервно копие',
  'backup.loading': 'Създава се резервно копие…',
  'backup.success': 'Резервното копие е изтеглено.',
  'backup.error.missingFile':
    'Резервното копие не можа да бъде създадено, защото липсва необходим файл.',
  'backup.error.failed': 'Резервното копие не можа да бъде създадено. Моля, опитайте отново.',

  'backup.validate.chooseFile': 'Избор на резервно копие',
  'backup.validate.checking': 'Проверява се …',
  'backup.validate.previewTitle': 'Преглед на резервното копие',
  'backup.validate.exportedAt': 'Дата на експорт',
  'backup.validate.schemaVersion': 'Версия на резервното копие',
  'backup.validate.recordCount': 'Брой записи',
  'backup.validate.fileCount': 'Брой файлове',
  'backup.validate.totalSize': 'Общ размер',
  'backup.validate.replaceHint':
    'Възстановяването по-късно би заменило всички локални данни на OfficePilot в този браузър.',
  'backup.validate.restoreUnavailable':
    'Възстановяването все още не е налично в тази версия.',

  'backup.validate.error.invalid': 'Файлът не е валидно резервно копие на OfficePilot.',
  'backup.validate.error.tooLarge': 'Файлът е твърде голям и не може да бъде проверен.',
  'backup.validate.error.structure':
    'Структурата на резервното копие е невалидна или непълна.',
  'backup.validate.error.manifest': 'Съдържанието на резервното копие е невалидно.',
  'backup.validate.error.schema': 'Тази версия на резервното копие не се поддържа.',
  'backup.validate.error.appState':
    'Съхраненото състояние на приложението в резервното копие е невалидно.',
  'backup.validate.error.nonImportable':
    'Файлът съдържа данни, които не трябва да се възстановяват.',
  'backup.validate.error.blobs':
    'Файловете в резервното копие не съответстват на съдържанието.',
  'backup.validate.error.refs':
    'Препратките към файлове в резервното копие са непълни или противоречиви.',
  'backup.validate.error.limits':
    'Резервното копие надвишава допустимите граници за размер или брой.',
} as const;
