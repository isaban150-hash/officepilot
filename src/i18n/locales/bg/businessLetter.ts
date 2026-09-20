/** BRIEFE-01C — Geschäftsschreiben, bulgarisch. */
export const bgBusinessLetter = {
  'businessLetter.area.title': 'Писма',
  'businessLetter.area.subtitle': 'Делови писма до клиенти, ведомства и партньори',
  'businessLetter.area.new': 'Ново делово писмо',
  'businessLetter.area.empty': 'Още няма писма',
  'businessLetter.area.emptyHint': 'Тук се събират деловите ви писма. Създайте първото.',
  'businessLetter.area.search': 'Търсене по тема или получател…',
  'businessLetter.area.searchEmpty': 'Няма намерено писмо.',

  'businessLetter.status.draft': 'Чернова',
  'businessLetter.status.finalized': 'Готово',

  'businessLetter.editor.newTitle': 'Ново делово писмо',
  'businessLetter.editor.editTitle': 'Редактиране на писмо',
  'businessLetter.editor.recipientSection': 'Получател',
  'businessLetter.editor.recipientKind': 'До кого е писмото?',
  'businessLetter.editor.recipientCustomer': 'Клиент от списъка',
  'businessLetter.editor.recipientFree': 'Друг получател',
  'businessLetter.editor.customer': 'Клиент',
  'businessLetter.editor.customerPlaceholder': 'Изберете клиент',
  'businessLetter.editor.customerHint': 'Адресът се прехвърля и може да се промени тук.',
  'businessLetter.editor.vorgang': 'Поръчка (по избор)',
  'businessLetter.editor.vorgangNone': 'Без връзка с поръчка',
  'businessLetter.editor.name': 'Име',
  'businessLetter.editor.company': 'Фирма (по избор)',
  'businessLetter.editor.street': 'Улица и номер',
  'businessLetter.editor.zip': 'Пощенски код',
  'businessLetter.editor.city': 'Град',
  'businessLetter.editor.country': 'Държава (по избор)',
  'businessLetter.editor.contentSection': 'Писмо',
  'businessLetter.editor.letterDate': 'Дата на писмото',
  'businessLetter.editor.subject': 'Тема',
  'businessLetter.editor.subjectPlaceholder': 'За какво се отнася?',
  'businessLetter.editor.body': 'Текст',
  'businessLetter.editor.bodyPlaceholder': 'Напишете текста на писмото тук.',
  'businessLetter.editor.save': 'Запази черновата',
  'businessLetter.editor.finalize': 'Приключи',
  'businessLetter.editor.cancel': 'Отказ',
  'businessLetter.editor.finalizeHint':
    'След приключване съдържанието е окончателно и не може да се променя.',

  'businessLetter.detail.title': 'Делово писмо',
  'businessLetter.detail.recipient': 'Получател',
  'businessLetter.detail.letterDate': 'Дата на писмото',
  'businessLetter.detail.subject': 'Тема',
  'businessLetter.detail.body': 'Текст',
  'businessLetter.detail.customer': 'Клиент',
  'businessLetter.detail.vorgang': 'Поръчка',
  'businessLetter.detail.edit': 'Редактиране',
  'businessLetter.detail.finalizedHint':
    'Това писмо е приключено. Съдържанието остава непроменено.',
  'businessLetter.detail.notFound': 'Това писмо вече не съществува.',
  'businessLetter.detail.back': 'Към писмата',

  'businessLetter.customer.section': 'Делови писма',
  'businessLetter.customer.create': 'Създаване на делово писмо',
  'businessLetter.customer.empty': 'Още няма писма до този клиент.',
  'businessLetter.vorgang.section': 'Делови писма',
  'businessLetter.vorgang.create': 'Създаване на делово писмо',
  'businessLetter.vorgang.empty': 'Още няма писма по тази поръчка.',

  'businessLetter.toast.saved': 'Черновата е запазена.',
  'businessLetter.toast.finalized': 'Писмото е приключено.',

  'businessLetter.subjectRequired': 'Моля, въведете тема.',
  'businessLetter.bodyRequired': 'Моля, напишете текст.',
  'businessLetter.recipientRequired': 'Моля, посочете получател.',
  'businessLetter.notFound': 'Това писмо не беше намерено.',
  'businessLetter.finalizedImmutable':
    'Това писмо вече е приключено и не може да се променя.',
  'businessLetter.alreadyFinalized': 'Това писмо вече е приключено.',
  'businessLetter.incompleteForFinalize':
    'Преди приключване темата и текстът трябва да са попълнени.',
  'businessLetter.companyProfileMissing':
    'Моля, първо въведете данните на фирмата в настройките.',
  'businessLetter.workspaceRequired': 'Вашата работна област още не е готова.',

  /* BRIEFE-01D */
  'businessLetter.pdf.view': 'Преглед на PDF',
  'businessLetter.pdf.download': 'Изтегляне на PDF',
  'businessLetter.pdf.previewTitle': 'Преглед',
  'businessLetter.pdf.failed':
    'Документът не можа да бъде създаден. Моля, опитайте отново.',
  'businessLetter.detail.archive': 'Архив',
  'businessLetter.detail.archiveOpen': 'Отваряне в архива на документите',
  'businessLetter.archiveDraftNotAllowed':
    'Чернова още не се архивира. Първо приключете писмото.',
  'businessLetter.archiveFailed': 'Писмото не можа да бъде архивирано.',
  'document.category.geschaeftsschreiben': 'Служебно писмо',

  /* DOKUMENTVERSTAENDNIS-01B */
  'document.accounting.notABookingDocument':
    'Това писмо не е счетоводен документ. То не изисква пари от фирмата.',
} as const;
