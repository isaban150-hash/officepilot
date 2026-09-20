/** DOKUMENTVERSTAENDNIS-01C — български. Кратки изречения, без технически термини. */
export const bgDocumentMeaning = {
  'documentMeaning.title': 'Какво пише в това писмо',
  'documentMeaning.certificate': 'Вид на удостоверението',
  'documentMeaning.certificate.constructionExemption':
    'Удостоверение за освобождаване при строителни услуги (данък при източника в строителството)',
  'documentMeaning.certificate.reverseChargeStatus':
    'Удостоверение за данъчно задължение при строителни услуги или почистване на сгради',
  'documentMeaning.certificate.domesticEstablishment':
    'Удостоверение за установяване в страната',
  'documentMeaning.subject': 'Относно',
  'documentMeaning.purpose': 'Накратко',
  'documentMeaning.action.question': 'Трябва ли да направя нещо?',
  'documentMeaning.action.yes': 'Да',
  'documentMeaning.action.no': 'Не',
  'documentMeaning.action.unclear': 'Не е разпознато със сигурност',
  'documentMeaning.obligations': 'Какво трябва да направя?',
  'documentMeaning.obligations.by': 'до',
  'documentMeaning.deadlines': 'Дати и срокове',
  'documentMeaning.deadlines.action': 'Срок за действие',
  'documentMeaning.deadlines.info': 'Само за сведение',
  'documentMeaning.amounts': 'Суми в писмото',
  'documentMeaning.accounting': 'Счетоводство',
  'documentMeaning.accounting.none': 'Няма нов разход',
  'documentMeaning.accounting.noneHint': 'От това писмо не възниква счетоводен документ.',
  'documentMeaning.accounting.reference': 'Отнася се до вече съществуващ документ',
  'documentMeaning.accounting.referenceHint':
    'Сумата вече е в книгите ви. Втори разход би бил дублиран.',
  'documentMeaning.accounting.candidate': 'Може да се приеме като нов документ',
  'documentMeaning.accounting.candidateHint': 'Моля, проверете документа, преди да го приемете.',
  'documentMeaning.customer': 'Вероятен клиент',
  'documentMeaning.vorgang': 'Вероятна поръчка',
  'documentMeaning.candidate.uncertain': 'Моля, проверете',
  'documentMeaning.candidate.confirm': 'Потвърди връзката',
  'documentMeaning.candidate.choose': 'Моля, изберете сами.',
  'documentMeaning.nextStep': 'Следваща стъпка',
  'documentMeaning.next.confirmAndAnswer': 'Потвърдете връзката и подгответе отговор.',
  'documentMeaning.next.answerRequired': 'Подгответе отговор и следете сроковете.',
  'documentMeaning.next.checkExistingRecord': 'Проверете свързания документ.',
  'documentMeaning.next.reviewAndBook': 'Проверете документа и го приемете като разход.',
  'documentMeaning.next.fileOnly': 'Архивирайте документа. Засега не е нужно действие.',
  'documentMeaning.next.reviewYourself': 'Моля, прегледайте писмото сами.',
  'documentMeaning.uncertain': 'Това OfficePilot не можа да разпознае със сигурност',
  'documentMeaning.uncertain.noSubject': 'Темата не е посочена ясно в писмото.',
  'documentMeaning.uncertain.recipient':
    'Не беше ясно дали писмото е адресирано до вашата фирма.',
  'documentMeaning.uncertain.noAssignment': 'Клиент и поръчка не можаха да бъдат свързани.',
  'documentMeaning.disclaimer':
    'OfficePilot чете писмото машинно. Моля, проверете важните данни в оригинала.',

  /* DOKUMENT-ASSISTENT-01F */
  'documentReminder.proposalTitle': 'Напомняне на',
  'documentReminder.documentDeadline': 'Срок в писмото:',
  'documentReminder.confirm': 'Създай напомняне',
  'documentReminder.created': 'Напомнянето беше създадено.',
  'documentReminder.alreadyExists': 'Това напомняне вече съществува.',
  'documentReminder.chooseDeadline':
    'Писмото съдържа няколко срока. Моля, посочете кой имате предвид.',

  /* DOKUMENT-ASSISTENT-01G */
  'documentReply.recipient': 'Получател:',
  'documentReply.recipientUnknown': 'още не е определен',
  'documentReply.missingAddress':
    'За писмо липсва адресът. Можете да го допълните в редактора на писма.',
  'documentReply.missingEmail':
    'За имейл няма записан адрес. Можете да го въведете в следващата стъпка.',
  'documentReply.chooseChannel': 'Как искате да отговорите?',
  'documentReply.asLetter': 'Продължи като писмо',
  'documentReply.asEmail': 'Продължи като имейл',
  'documentReply.nothingSentYet':
    'Още нищо не е изпратено и нищо не е приключено. Ще проверите текста в следващата стъпка.',
} as const;
