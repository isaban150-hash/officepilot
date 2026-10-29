/** EINRICHTUNG-01 (AP2) — Вход, сесия и изход (вж. de/authSession.ts). */
export const bgAuthSession = {
  'auth.error.emailNotConfirmed':
    'Имейл адресът ви още не е потвърден. Моля, отворете връзката от писмото за потвърждение.',
  'auth.error.rateLimited': 'Твърде много опити. Моля, изчакайте малко и опитайте отново.',
  'auth.error.network': 'Няма връзка със сървъра. Моля, проверете интернет връзката и опитайте отново.',
  'auth.error.unknown': 'Това не е възможно в момента. Моля, опитайте по-късно.',
  'auth.error.weakPassword': 'Тази парола е твърде слаба. Моля, изберете по-дълга парола.',
  'auth.resend.action': 'Изпрати потвърждението отново',
  'auth.resend.sent': 'Ако към този адрес има непотвърден профил, е изпратено ново писмо за потвърждение.',
  'auth.resend.wait': 'Повторно изпращане след {seconds} с',
  'auth.register.successHint':
    'Не сте получили имейл? Ако вече имате профил, влезте или използвайте „Забравена парола“.',
  'auth.logoutReason.profileMissing': 'Към този вход няма профил. Излязохте от системата.',
  'auth.logoutReason.sessionInvalid':
    'Сесията ви е прекратена, например чрез „Изход от всички устройства“. Моля, влезте отново.',
  'auth.connection.banner':
    'Връзката със сървъра е нарушена. Оставате влезли; промените се запазват на това устройство и се прехвърлят по-късно. Плащания, одобрения и изпращане дотогава са блокирани.',
  'auth.connection.retry': 'Свържи отново',
  'auth.profileUnavailable.title': 'Нарушена връзка',
  'auth.profileUnavailable.body':
    'Профилът ви не можа да се зареди в момента. Оставате влезли; OfficeTakt опитва автоматично отново.',
  'auth.logout.action': 'Изход',
  'auth.logout.title': 'Изход?',
  'auth.logout.pendingWarning':
    'На това устройство {count} промени чакат прехвърляне. Те остават запазени и се изпращат при следващия вход с този профил.',
  'auth.logout.cancel': 'Отказ',
  'auth.logout.confirm': 'Изход въпреки това',
  'auth.logout.busy': 'Излизане …',
  'auth.logout.everywhere': 'Изход от всички устройства',
  'auth.logout.everywhereConfirm':
    'Всички сесии на този профил се прекратяват, и на други устройства. Там е необходим нов вход.',
  'auth.logout.everywhereAction': 'Изход навсякъде',
  'auth.logout.everywhereFailed':
    'Без връзка не може да се излезе от всички устройства. Моля, опитайте отново, когато има връзка.',
  'legalConsent.title': 'Необходимо е съгласие',
  'legalConsent.subtitle': 'Моля, приемете действащата версия на правните текстове, за да продължите да използвате OfficeTakt.',
  'legalConsent.terms': 'Приемам общите условия.',
  'legalConsent.privacy': 'Прочетох декларацията за поверителност и я приемам.',
  'legalConsent.license': 'Приемам лицензионните условия.',
  'legalConsent.read': 'прочети',
  'legalConsent.accept': 'Приемам',
  'legalConsent.decline': 'Отказ и изход',

  'auth.logoutReason.accountDeleted': 'Акаунтът ви е изтрит или изтриването се завършва. Данните на този акаунт са премахнати от това устройство.',
  'auth.logoutReason.deviceDataRemoved': 'Данните на този акаунт са премахнати от това устройство. Данните ви в облака са непроменени.',
} as const;
