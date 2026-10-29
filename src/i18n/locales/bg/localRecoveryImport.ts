/** EINRICHTUNG-01 (App-Eigenprüfung; 1.31, E-9) — аварийна страница за импорт (вж. de/localRecoveryImport.ts). */
export const bgLocalRecoveryImport = {
  'localRecovery.importLink': 'Подготовка на целеви архив и карантина',
  'localRecovery.importNote':
    'Връзката отваря отделна аварийна страница. Там само наличните локални данни се архивират и поставят под карантина — нищо не се импортира и нищо не се заменя.',
  'localRecoveryImport.title': 'Целеви архив и карантина',
  'localRecoveryImport.intro':
    'Тази страница архивира само наличните локални данни на този адрес и създава локално копие под карантина. Нищо не се импортира, нищо не се заменя и не се стартира синхронизация с облака.',
  'localRecoveryImport.label.origin': 'Адрес',
  'localRecoveryImport.markers.title': 'Налични процеси на карантина',
  'localRecoveryImport.label.status': 'Статус',
  'localRecoveryImport.label.token': 'Идентификатор',
  'localRecoveryImport.label.storageKey': 'Ключ за съхранение',
  'localRecoveryImport.markers.note':
    'Наличните процеси тук само се показват. Тази страница никога не премахва маркер, обвивка или файл.',
  'localRecoveryImport.step1.title': '1. Изберете целева област',
  'localRecoveryImport.step1.hint':
    'Нищо не е избрано предварително. Изберете областта изрично — дори когато се предлага само една.',
  'localRecoveryImport.noTargets': 'На този адрес няма валидна работна област.',
  'localRecoveryImport.label.workspace': 'Работна област',
  'localRecoveryImport.value.unknown': 'неизвестно',
  'localRecoveryImport.label.setupCompany': 'Фирма (настройка)',
  'localRecoveryImport.value.none': 'няма данни',
  'localRecoveryImport.label.profileCompany': 'Фирма (профил)',
  'localRecoveryImport.label.savedAt': 'Запазено на',
  'localRecoveryImport.label.counts': 'Процеси / документи',
  'localRecoveryImport.label.selected': 'Избрана област',
  'localRecoveryImport.resumed.text':
    'Страницата беше затворена след изтеглянето на архива. Целевата област и очакваната контролна сума са запазени. Нищо не е поставено под карантина и нищо не е записано.',
  'localRecoveryImport.label.expectedArchiveSha': 'Очаквана SHA-256 стойност на архива',
  'localRecoveryImport.label.backupFilename': 'Име на файла на архива',
  'localRecoveryImport.label.targetSavedAt': 'Състояние на целевата област',
  'localRecoveryImport.resumed.hint':
    'Изтегленият файл може да се сравни по тази контролна сума. За карантината архивът трябва да се подготви отново, файлът да се избере отново и карантината да се потвърди отново — предишното потвърждение вече не важи.',
  'localRecoveryImport.staging.blocked':
    'За тази област вече тече незавършен процес на карантина. Тук той само се показва и не се засяга.',
  'localRecoveryImport.label.startedAt': 'Започнат на',
  'localRecoveryImport.label.archiveSha': 'SHA-256 стойност на архива',
  'localRecoveryImport.label.expectedFiles': 'Очаквани файлове',
  'localRecoveryImport.step2.action': '2. Създайте целеви архив',
  'localRecoveryImport.label.files': 'Файлове',
  'localRecoveryImport.step3.action': '3. Изтеглете архива',
  'localRecoveryImport.fileInput.label': 'Изберете отново току-що изтегления целеви архив',
  'localRecoveryImport.reselect.hint':
    'Не архива, който трябва да бъде възстановен. В тази стъпка нищо не се импортира.',
  'localRecoveryImport.step4.action': '4. Изберете отново току-що изтегления целеви архив',
  'localRecoveryImport.verify.result':
    'Избраният файл напълно съвпада със създадения архив: контролна сума на архива, контролна сума на суровото състояние, област, момент и всички {count} контролни суми на файловете.',
  'localRecoveryImport.step5.action': '5. Създайте локално копие под карантина',
  'localRecoveryImport.quarantine.busy': 'Копието под карантина се създава. Моля, не затваряйте тази страница.',
  'localRecoveryImport.report.title': 'Заключителен отчет',
  'localRecoveryImport.label.targetStorageKey': 'Целеви ключ за съхранение',
  'localRecoveryImport.label.targetScopeKey': 'Целеви ключ на областта',
  'localRecoveryImport.label.rawSha': 'SHA-256 стойност на суровото състояние',
  'localRecoveryImport.label.quarantineToken': 'Идентификатор на карантината',
  'localRecoveryImport.label.markerKey': 'Ключ на маркера',
  'localRecoveryImport.label.stateKey': 'Ключ на обвивката',
  'localRecoveryImport.label.quarantineScopeKey': 'Файлова област на карантината',
  'localRecoveryImport.label.completedAt': 'Момент',
  'localRecoveryImport.label.fileRefId': 'FileRef ID',
  'localRecoveryImport.label.dataKey': 'Ключ на данните',
  'localRecoveryImport.label.mimeType': 'MIME тип',
  'localRecoveryImport.label.size': 'Размер',
  'localRecoveryImport.value.bytes': '{size} байта',
  'localRecoveryImport.label.sha256': 'SHA-256',
  'localRecoveryImport.report.note':
    'Локалният целеви архив е поставен под карантина. Нищо не е импортирано, нищо не е заменено и не е стартирана синхронизация с облака.',
  'localRecoveryImport.targetChangeWarning':
    'По време на процеса или след него е открита промяна в целевата област или друг процес на карантина за тази цел. Това състояние не е одобрено за следваща стъпка. Започнете по-късно изцяло отначало.',
  'localRecoveryImport.readonlyNote':
    'Тази страница не извършва импорт, не заменя данни, не премахва процес на карантина, не стартира синхронизация и не преминава към обичайното приложение.',
  'localRecoveryImport.msg.stagingCreated':
    'Междувременно за тази област е създаден незавършен процес на карантина. Подготвеното състояние беше отхвърлено.',
  'localRecoveryImport.msg.targetChangedElsewhere':
    'Целевата област беше променена от друг изглед. Процесът беше отхвърлен. Моля, изберете областта отново изрично.',
  'localRecoveryImport.msg.confirmBeforeBackupFailed':
    'Входът не можа да бъде потвърден преди архивирането. Нищо не беше създадено.',
  'localRecoveryImport.msg.prepareFailedReason': 'Целевият архив не можа да бъде създаден: {reason}',
  'localRecoveryImport.msg.prepareFailed': 'Целевият архив не можа да бъде създаден.',
  'localRecoveryImport.msg.downloadFailed':
    'Изтеглянето не можа да бъде стартирано. Нищо не беше запазено — моля, опитайте отново.',
  'localRecoveryImport.msg.reselectMismatch':
    'Избраният файл не е току-що създаденият целеви архив ({reason}). Нищо не беше запазено и нищо не беше импортирано. Моля, създайте архива отново.',
  'localRecoveryImport.msg.reselectUnreadable': 'Избраният файл не можа да бъде прочетен. Нищо не беше запазено.',
  'localRecoveryImport.msg.confirmBeforeQuarantineFailed':
    'Входът не можа да бъде потвърден преди карантината. Нищо не беше променено.',
  'localRecoveryImport.msg.quarantineFailedReason': 'Копието под карантина не беше създадено: {reason}',
  'localRecoveryImport.msg.quarantineFailed': 'Копието под карантина не беше създадено.',
  'localRecoveryImport.msg.targetChangedSinceBackup':
    'Локалните целеви данни са се променили след последното архивиране. Процесът започва отначало.',
} as const;
