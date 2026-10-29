/** EINRICHTUNG-01 (AP1, E8) — Аварийни страници (вж. de/localRecoveryAccess.ts). */
export const bgLocalRecoveryAccess = {
  'localRecovery.identity.checking': 'Входът се проверява …',
  'localRecovery.identity.signedOut':
    'Без вход виждате само данни, които не са обвързани с профил. Данните на даден профил могат да се архивират едва след вход точно с този профил.',
  'localRecovery.identity.invalid':
    'Запазеният вход вече не е валиден. Моля, влезте отново, за да архивирате данните на профила си.',
  'localRecovery.identity.offline':
    'Без връзка входът не може да се потвърди. Затова данните на даден профил не могат да се архивират сега; те остават непроменени на това устройство.',
  'localRecovery.identity.confirmed':
    'Влезли сте като {email}. Допълнително се виждат данните точно на този профил.',
  'localRecovery.boundCount': 'Други данни, обвързани с профил, на това устройство: {count}',
  'localRecovery.login.title': 'Влезте с профила, на който принадлежат данните',
  'localRecovery.login.email': 'Имейл',
  'localRecovery.login.password': 'Парола',
  'localRecovery.login.submit': 'Вход',
  'localRecovery.login.failed': 'Входът не бе успешен. Моля, проверете имейла и паролата.',
  'localRecovery.login.offline': 'Няма връзка. Входът е възможен само онлайн.',
  'localRecovery.logout': 'Изход (само на това устройство)',
  'localRecovery.exportBlocked': 'Входът не можа да се потвърди преди архивирането. Нищо не е експортирано.',
  'localRecovery.scope.guest': 'Данни на гост',
  'localRecovery.scope.legacy': 'Стари данни (преди разделянето по профили)',
  'localRecovery.scope.legacy_setup': 'Стар формат на настройката',
  'localRecovery.scope.quarantine': 'Карантинно копие на стари данни',
  'localRecovery.scope.user': 'Данни на вашия профил',
  'localRecovery.scope.workspace': 'Данни на фирмата',
} as const;
