/** EINRICHTUNG-01 (AP8; Verträge 1.27, 1.28) — защита при напускане, продължаване и нови потвърждения. */
export const bgLeaveGuard = {
  'leaveGuard.title': 'Незапазени промени',
  'leaveGuard.textDraft':
    'Въведеното остава като чернова и ще ви бъде предложено при следващото отваряне на тази страница. Искате ли да напуснете страницата сега?',
  'leaveGuard.textLost': 'Въведеното ще бъде загубено, ако напуснете страницата сега.',
  'leaveGuard.stay': 'Оставане',
  'leaveGuard.leave': 'Напускане',
  'formResume.offer': 'Има незапазена чернова на този формуляр.',
  'formResume.continue': 'Продължаване',
  'formResume.discard': 'Отхвърляне',
  'formResume.stale': 'По-стара чернова беше отхвърлена, защото данните междувременно са се променили.',
  'confirm.knowledgeDelete.title': 'Изтриване на записа от знанията?',
  'confirm.knowledgeDelete.text': 'Записът се изтрива и асистентът вече няма да го използва.',
  'confirm.knowledgeDelete.action': 'Изтриване на записа',
  'confirm.logoRemove.title': 'Премахване на логото?',
  'confirm.logoRemove.text': 'Новите документи ще бъдат без лого. Вече създадените документи запазват логото си.',
  'confirm.logoRemove.action': 'Премахване на логото',
  'confirm.invitationRevoke.title': 'Оттегляне на поканата?',
  'confirm.invitationRevoke.text': 'Връзката за покана става невалидна. По-късно можете да поканите отново.',
  'confirm.invitationRevoke.action': 'Оттегляне на поканата',
  'confirm.transferRevoke.title': 'Оттегляне на искането за предаване?',
  'confirm.transferRevoke.text': 'Искането за предаване на фирмата се оттегля. Оставате собственик.',
  'confirm.transferRevoke.action': 'Оттегляне на искането',
  'confirm.restore.title': 'Възстановяване на резервното копие?',
  'confirm.restore.text': 'Данните на тази фирма на това устройство се заменят със състоянието от копието.',
  'confirm.restore.action': 'Възстановяване',
  // EINRICHTUNG-01 (AP9; 1.32) — Skip-Link als erstes fokussierbares Element.
  'a11y.skipToContent': 'Към съдържанието',
  // EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — B2-Fehlerseite „Seite nicht gefunden“.
  'notFound.title': 'Страницата не е намерена',
  'notFound.text': 'Търсената страница не съществува или е преместена.',
  'notFound.home': 'Към началната страница',
  // EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — B2-Fehlergrenze.
  'serverError.title': 'Нещо се обърка',
  'serverError.text': 'Приложението временно не е достъпно. Моля, презаредете страницата.',
  'serverError.retry': 'Опитайте отново',
  'serverError.devDetails': 'Технически подробности',
} as const;
