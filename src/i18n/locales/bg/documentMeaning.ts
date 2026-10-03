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
  'documentMeaning.financeNote': 'Сравнение с OfficeTakt',
  'documentMeaning.complaint': 'Според подателя',
  'documentMeaning.complaint.reports': 'Подателят съобщава: „{text}"',
  'documentMeaning.complaint.demands': 'Подателят изисква: {what}',
  'documentMeaning.complaint.announces': 'Подателят обявява: {what}',
  'documentMeaning.complaint.references': 'Посочена връзка: {refs}',
  'documentMeaning.complaint.notConfirmed': 'OfficeTakt не потвърждава тези данни и не признава нищо.',
  'documentMeaning.complaint.outgoing':
    'Собствено писмо на вашата фирма. Това не е оплакване срещу вашата фирма; исканията и сроковете в него са към получателя.',
  'documentMeaning.complaint.demand.remedy': 'отстраняване на недостатъка',
  'documentMeaning.complaint.demand.statement': 'становище',
  'documentMeaning.complaint.demand.documents': 'документи',
  'documentMeaning.complaint.demand.damages': 'обезщетение',
  'documentMeaning.complaint.demand.reimbursement': 'възстановяване на разходи',
  'documentMeaning.complaint.demand.reduction': 'намаление',
  'documentMeaning.complaint.demand.retention': 'задържане',
  'documentMeaning.complaint.demand.payment': 'плащане',
  'documentMeaning.complaint.escalation.substitutePerformance': 'възлагане на работата на друг',
  'documentMeaning.complaint.escalation.legalAction': 'адвокатски или съдебни стъпки',
  'documentMeaning.complaint.reference.order': 'Поръчка',
  'documentMeaning.complaint.reference.invoice': 'Фактура',
  'documentMeaning.complaint.reference.case': 'Случай',
  'documentMeaning.complaint.reference.offer': 'Оферта',
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
  // BROWSER-ACCEPTANCE-FIX 01 / A3 — eigene, verknüpfte Ausgangsrechnung
  'documentMeaning.customer.assigned': 'Клиент',
  'documentMeaning.vorgang.assigned': 'Поръчка',
  'documentMeaning.candidate.fromInvoice': 'Взето от фактурата',
  'documentMeaning.accounting.ownInvoice': 'Собствена фактура – вече записана',
  'documentMeaning.accounting.ownInvoiceHint': 'Сумата е във вашата фактура. Тук не е нужно ново осчетоводяване.',
  'documentMeaning.nextStep': 'Следваща стъпка',
  'documentMeaning.next.confirmAndAnswer': 'Потвърдете връзката и подгответе отговор.',
  'documentMeaning.next.answerRequired': 'Подгответе отговор и следете сроковете.',
  'documentMeaning.next.checkExistingRecord': 'Проверете свързания документ.',
  'documentMeaning.next.reviewAndBook': 'Проверете документа и го приемете като разход.',
  'documentMeaning.next.fileOnly': 'Архивирайте документа. Засега не е нужно действие.',
  'documentMeaning.next.reviewYourself': 'Моля, прегледайте писмото сами.',
  'documentMeaning.uncertain': 'Това OfficeTakt не можа да разпознае със сигурност',
  'documentMeaning.uncertain.noSubject': 'Темата не е посочена ясно в писмото.',
  'documentMeaning.uncertain.recipient':
    'Не беше ясно дали писмото е адресирано до вашата фирма.',
  'documentMeaning.uncertain.noAssignment': 'Клиент и поръчка не можаха да бъдат свързани.',
  'documentMeaning.uncertain.relativeDeadline':
    'Срокът е посочен само относително (напр. „след получаване"). Моля, проверете точната дата сами – OfficeTakt не я изчислява.',
  'documentMeaning.uncertain.noDeadline': 'Изисква се действие, но в писмото няма посочен срок.',
  'documentMeaning.disclaimer':
    'OfficeTakt чете писмото машинно. Моля, проверете важните данни в оригинала.',

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
