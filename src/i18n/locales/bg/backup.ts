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
    'Възстановяването заменя всички локални данни на OfficePilot в този браузър.',

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

  'backup.restore.confirm':
    'Разбирам, че всички локални данни на OfficePilot в този браузър ще бъдат заменени.',
  'backup.restore.action': 'Възстановяване на резервно копие',
  'backup.restore.success': 'Възстановяването завърши. Страницата ще се презареди.',
  'backup.restore.phase.safety': 'Създава се резервно копие за безопасност …',
  'backup.restore.phase.stage': 'Файловете се подготвят …',
  'backup.restore.phase.commit': 'Данните се възстановяват …',
  'backup.restore.phase.verify': 'Възстановяването се проверява …',
  'backup.restore.phase.rollback': 'Предишното състояние се възстановява …',

  'backup.restore.error.notValidated':
    'Моля, първо изберете и проверете валидно резервно копие.',
  'backup.restore.error.notConfirmed':
    'Моля, потвърдете, че локалните данни могат да бъдат заменени.',
  'backup.restore.error.safety':
    'Възстановяването е прекратено, защото не можа да се създаде резервно копие за безопасност.',
  'backup.restore.error.stage':
    'Възстановяването е прекратено. Досегашните ви данни не са променени.',
  'backup.restore.error.commit': 'Възстановяването не успя.',
  'backup.restore.error.verify':
    'Възстановяването не можа да бъде потвърдено. Предишното състояние е върнато.',
  'backup.restore.error.rollback':
    'Възстановяването не успя. Моля, заредете последното си резервно копие ръчно.',
  'backup.restore.error.failed': 'Възстановяването не успя.',
} as const;
