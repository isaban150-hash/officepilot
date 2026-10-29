export const bgBackup = {
  'backup.title': 'Резервно копие',
  'backup.hint':
    'Резервното копие съдържа данните на тази фирма на това устройство като ZIP файл. Изтегляйте го редовно, най-добре всеки ден в края на работния ден.',
  'backup.counts.title': 'Съдържание на резервното копие',
  'backup.counts.emailsHint':
    'Имейли: имейли, прехвърлени на това устройство. Изпратените и получените имейли на пощенската кутия се намират на сървъра.',
  'backup.area.customers': 'Клиенти',
  'backup.area.vorgaenge': 'Процеси',
  'backup.area.offers': 'Оферти',
  'backup.area.invoices': 'Фактури',
  'backup.area.payments': 'Плащания',
  'backup.area.expenses': 'Разходи',
  'backup.area.documents': 'Документи',
  'backup.area.files': 'Файлове',
  'backup.area.letters': 'Писма',
  'backup.area.emails': 'Имейли',
  'backup.area.tasks': 'Задачи',
  'backup.area.knowledge': 'Знания',
  'backup.area.bankTransactions': 'Банкови движения',
  'backup.area.employees': 'Служители',
  'backup.area.employeePayments': 'Плащания към служители',
  'backup.area.accountingAssignments': 'Осчетоводявания',
  'backup.area.settings': 'Настройки',
  'backup.download': 'Изтегляне на резервно копие',
  'backup.loading': 'Създава се резервно копие…',
  'backup.success':
    'Изтеглянето на резервното копие започна. Моля, проверете дали файлът е пристигнал в папката за изтегляния.',
  'backup.successPartial':
    'Изтеглянето на частичното резервно копие започна. Тези файлове не се съдържат в него:',
  'backup.error.missingFile':
    'Резервното копие не беше създадено, защото липсват тези файлове:',
  'backup.missing.hint':
    'Можете да създадете копие без липсващите файлове. Тогава файлът се отбелязва като частично резервно копие.',
  'backup.missing.allowPartial': 'Копие без липсващите файлове',
  'backup.missing.cancel': 'Отказ',
  'backup.missing.unnamed': 'Файл без име',
  'backup.error.credentials':
    'Резервното копие не беше създадено, защото локалните данни съдържат данни за вход, които не бива да попадат в резервно копие.',
  'backup.error.failed': 'Резервното копие не можа да бъде създадено. Моля, опитайте отново.',
  'backup.export.notAllowed': 'Резервни копия могат да създават само собствениците и администраторите на тази фирма.',

  'backup.validate.chooseFile': 'Избор на резервно копие',
  'backup.validate.checking': 'Проверява се …',
  'backup.validate.previewTitle': 'Преглед на резервното копие',
  'backup.validate.exportedAt': 'Дата на експорт',
  'backup.validate.schemaVersion': 'Версия на резервното копие',
  'backup.validate.recordCount': 'Брой записи',
  'backup.validate.fileCount': 'Брой файлове',
  'backup.validate.totalSize': 'Общ размер',
  'backup.validate.replaceHint': 'Възстановяването заменя данните на тази фирма на това устройство.',
  'backup.validate.contentTitle': 'Съдържание по области',
  'backup.validate.incomplete':
    'Това е частично резервно копие. Следните файлове не се съдържат в него:',

  'backup.validate.error.invalid': 'Файлът не е валидно резервно копие на OfficeTakt.',
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

  'backup.restore.confirm': 'Разбирам, че данните на тази фирма на това устройство ще бъдат заменени.',
  'backup.restore.confirmIncomplete':
    'Разбирам, че тези файлове ще липсват след възстановяването.',
  'backup.restore.cloudBlocked':
    'В облачен режим данните ви се намират на сървъра. Локално резервно копие не може да ги замени, затова възстановяването тук не е налично.',
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
    'Моля, потвърдете, че данните на тази фирма на това устройство могат да бъдат заменени.',
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
  'backup.restore.error.cloudWorkspace':
    'В облачен режим не е възможно възстановяване от локално резервно копие. Данните ви не са променени.',
} as const;
