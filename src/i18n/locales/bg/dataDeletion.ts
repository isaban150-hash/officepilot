/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.25a, 1.26) — изтриване на акаунт, изтриване на фирма, режим „Изтриването е заявено“.
 * Техническо съответствие (1.31); езиковата проверка от специалист е открита по E7.
 */
export const bgDataDeletion = {
  'destructive.error.password': 'Паролата не е правилна.',
  'destructive.error.rateLimited': 'Твърде много опити. Моля, опитайте отново след 15 минути.',
  'destructive.error.session': 'Сесията ви е изтекла. Моля, влезте отново.',
  'destructive.error.blocked': 'Този акаунт е блокиран.',
  'destructive.error.confirmation': 'Потвърждението е изтекло или е невалидно. Моля, потвърдете отново.',
  'destructive.error.unavailable': 'Услугата в момента не е достъпна. Моля, опитайте отново по-късно.',
  'destructive.password.label': 'Текущата ви парола',
  'destructive.password.hint': 'Паролата се проверява от сървъра; OfficeTakt не я запазва.',

  'accountDelete.subtitle': 'Окончателно изтриване на акаунта и входа ви.',
  'accountDelete.waiting.link': 'Изтриване на акаунта',
  'accountDelete.waiting.title': 'Изтриване на акаунта',
  'accountDelete.waiting.back': 'Обратно към одобрението',
  'accountDelete.intro':
    'С изтриването приключват всички ваши членства. Във фирмите името ви ще се показва като „Изтрит акаунт“; фактурите, документите и другите бизнес данни на фирмите остават непроменени. Изтриването не може да бъде отменено.',
  'accountDelete.ownerHint': 'Ако сте собственик на фирма, първо я прехвърлете или заявете нейното изтриване.',
  'accountDelete.email.label': 'Вашият имейл за вход за потвърждение',
  'accountDelete.submit': 'Окончателно изтриване на акаунта',
  'accountDelete.dialog.title': 'Да се изтрие ли акаунтът?',
  'accountDelete.dialog.text': 'Акаунтът ви ще бъде блокиран и изтрит, всички членства приключват. Това не може да бъде отменено.',
  'accountDelete.result.completed': 'Акаунтът ви е изтрит. Данните на този акаунт се премахват от това устройство; излизате от профила.',
  'accountDelete.result.completing':
    'Изтриването започна и ще бъде завършено. Акаунтът ви вече е блокиран; данните на този акаунт се премахват от това устройство и излизате от профила.',
  'accountDelete.error.owner': 'Вие сте собственик на тези фирми: {list}. Първо ги прехвърлете на друг член или заявете изтриването на фирмата.',
  'accountDelete.error.ownerTransfer': 'Към прехвърлянето (Екип)',
  'accountDelete.error.ownerDelete': 'Изтриване на фирмата',
  'accountDelete.error.lastAdmin': 'Вие сте последният администратор на платформата. Първо назначете друг администратор.',
  'accountDelete.error.emailMismatch': 'Имейлът не съвпада с имейла ви за вход.',
  'accountDelete.error.requestMismatch': 'За този акаунт вече тече изтриване. Моля, презаредете страницата.',
  'accountDelete.localOnly': 'В локалния режим без облак няма акаунт за изтриване. Данните на това устройство премахвате в „Данни на това устройство“.',
  'accountDelete.pendingLink': 'Изтриване на акаунта',
  // Abschluss 23 — Warnung vor dem Verlust nicht abgeglichener Gerätedaten (die Löschung bleibt möglich).
  'accountDelete.deviceWarning.title': 'Внимание: На това устройство има данни, които не са запазени в облака',
  'accountDelete.deviceWarning.text':
    'В изброените по-долу данни има несинхронизирани или отхвърлени промени, непотвърдени плащания или чернови, или те не можаха да бъдат проверени. След изтриването на акаунта данните на този акаунт се премахват от това устройство. Всичко, което не е в облака, тогава се губи безвъзвратно. Синхронизирайте предварително, ако искате да запазите тези данни. Изтриването остава възможно.',
  'accountDelete.deviceWarning.accountArea': 'Област на акаунта без фирма',
  'accountDelete.deviceWarning.sync': 'Към синхронизацията',
  'accountDelete.deviceWarning.dialog': 'Внимание: Данните на това устройство, които не са в облака, се губят безвъзвратно.',
  // Abschluss 24 — sachlicher Hinweis bei unklarem Abgleich (kein Datenverlust behauptet).
  'accountDelete.deviceNote.text':
    'Бележка: На това устройство не са открити отворени или отхвърлени промени. В тази сесия обаче не е доказана пълна синхронизация. Ако искате да сте сигурни, проверете преди изтриването.',
  'accountDelete.deviceNote.link': 'Към „Данни на това устройство“',

  'workspaceDelete.subtitle': 'Заявяване на изтриване на фирмата с всички данни и файлове.',
  'workspaceDelete.exportHint': 'Първо експортирайте данните, които искате да запазите.',
  'workspaceDelete.exportLink': 'Към експорта',
  'workspaceDelete.retention':
    'Задълженията за съхранение (напр. за фактури) са на фирмата. След изтичане на срока OfficeTakt изтрива всички данни безвъзвратно. Не е правна консултация.',
  'workspaceDelete.retentionConfirm': 'Прочетох указанието за съхранението и експорта.',
  'workspaceDelete.consequences.title': 'Последици',
  'workspaceDelete.consequences.members': 'Всички членове губят достъп.',
  'workspaceDelete.consequences.mailbox': 'Пощенската кутия се изключва.',
  'workspaceDelete.consequences.data': 'Данните и файловете на фирмата се изтриват.',
  'workspaceDelete.period': 'Изтриването се изпълнява най-рано 30 дни след заявката. Дотогава важи само за четене и можете да оттеглите заявката.',
  'workspaceDelete.name.label': 'Точно име на фирмата за потвърждение: {name}',
  'workspaceDelete.submit': 'Заявяване на изтриване',
  'workspaceDelete.dialog.title': 'Да се заяви ли изтриване на фирмата?',
  'workspaceDelete.dialog.text': 'Най-рано след 30 дни всички данни и файлове на тази фирма ще бъдат изтрити. Дотогава можете да оттеглите заявката.',
  'workspaceDelete.status.open': 'Изтриването е заявено и ще бъде изпълнено най-рано на {date}.',
  'workspaceDelete.status.deleting': 'Изтриването се изпълнява. Оттегляне вече не е възможно.',
  'workspaceDelete.revoke': 'Оттегляне на заявката',
  'workspaceDelete.revoke.dialog.title': 'Да се оттегли ли заявката?',
  'workspaceDelete.revoke.dialog.text': 'Фирмата остава; режимът само за четене приключва.',
  'workspaceDelete.revoked': 'Заявката е оттеглена.',
  'workspaceDelete.requested': 'Изтриването е заявено.',
  'workspaceDelete.error.name': 'Името на фирмата не съвпада точно.',
  'workspaceDelete.error.notice': 'Указанието междувременно е променено. Моля, презаредете страницата и потвърдете отново.',
  'workspaceDelete.error.forbidden': 'Само собственикът може да заяви или оттегли изтриването.',
  'workspaceDelete.error.inProgress': 'Изтриването вече тече; оттегляне не е възможно.',
  'workspaceDelete.localOnly': 'В локалния режим без облак няма фирма на сървъра. Данните на това устройство премахвате в „Данни на това устройство“.',

  'workspaceAccess.deletion.title': 'Изтриването е заявено',
  'workspaceAccess.deletion.owner': 'Тази фирма ще бъде изтрита най-рано на {date}. Дотогава важи само за четене; експортът и архивирането остават възможни. Можете да оттеглите заявката.',
  'workspaceAccess.deletion.admin': 'Тази фирма ще бъде изтрита най-рано на {date}. Дотогава важи само за четене; експортът и архивирането остават възможни. Само собственикът може да оттегли заявката.',
  'workspaceAccess.deletion.member': 'Тази фирма ще бъде изтрита най-рано на {date}. Дотогава важи само за четене. Само собственикът може да оттегли заявката.',
  'workspaceAccess.deletion.inProgress': 'Тази фирма в момента се изтрива.',
  'workspaceAccess.deletion.manage': 'Преглед на заявката',
} as const;
