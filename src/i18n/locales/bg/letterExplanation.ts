export const bgLetterExplanation = {
  'letter.explain.intro':
    'OfficePilot обяснява писмото на прост език. Моля, проверете важните данни в оригинала.',
  'letter.explain.uncertainHint':
    'Моля, проверете оригинала или се консултирайте с данъчния си консултант.',
  'letter.explain.about.brief':
    'Това е писмо от {sender}. Тема: {subject}. Проверете дали е нужен отговор.',
  'letter.explain.about.behoerde':
    'Това е писмо от германски орган {sender}. Тема: {subject}. Проверете срока и съдържанието.',
  'letter.explain.about.versicherung':
    'Това е застрахователно писмо от {sender}. Проверете вноска, срок или покритие.',
  'letter.explain.about.krankenkasse':
    'Krankenkasse {sender} ви е писала. Тема: {subject}. Проверете вноски или уведомления.',
  'letter.explain.about.bgBau':
    'BG BAU ви е писала – напр. за вноска или удостоверение. Подател: {sender}.',
  'letter.explain.about.finanzamt':
    'Finanzamt {sender} ви е писало – напр. за данъци или срок.',
  'letter.explain.about.sokaBau':
    'SOKA-BAU ви е писала. Проверете вноски или документи. Подател: {sender}.',
  'letter.explain.about.wichtig':
    'Важно писмо от {sender}: {title}. Проверете съдържанието и срока в оригинала.',
  'letter.explain.nextSteps.brief':
    'Прочетете писмото накратко. При неяснота се обърнете към подателя или данъчния консултант.',
  'letter.explain.nextSteps.behoerde':
    'Проверете срока и съдържанието. Архивирайте оригинала и при нужда предайте нататък.',
  'letter.explain.nextSteps.versicherung':
    'Проверете вноската и срока. Архивирайте писмото. При въпроси – застрахователен посредник.',
  'letter.explain.nextSteps.krankenkasse':
    'Проверете вноски и срокове. Архивирайте оригинала. При въпроси – Krankenkasse или счетоводство.',
  'letter.explain.nextSteps.bgBau':
    'Проверете вноска и срок. Архивирайте оригинала. При вноски – данъчен консултант.',
  'letter.explain.nextSteps.finanzamt':
    'Проверете внимателно сроковете и архивирайте оригинала. При данъчни въпроси – Steuerberater.',
  'letter.explain.nextSteps.sokaBau':
    'Проверете вноски и задължения. Архивирайте оригинала.',
  'letter.explain.nextSteps.wichtig':
    'Проверете дали са нужни плащане, срок или отговор. При неяснота – данъчен консултант.',
  'letter.explain.deadline.recognized':
    'Възможен срок: {deadline}. Моля, проверете в оригиналното писмо.',
  'letter.explain.deadline.fromText':
    'Разпознат срок в текста: {deadline}. Моля, проверете в оригинала.',
  'letter.explain.deadline.none': 'Не е разпознат срок.',
  'letter.explain.importance.critical':
    'Вероятно спешно – проверете приоритетно и сроковете в писмото.',
  'letter.explain.importance.high': 'Вероятно важно – обработете скоро.',
  'letter.explain.importance.medium': 'Може да е важно – проверете в следващите дни.',
  'letter.explain.importance.low': 'По-ниска приоритетност – все пак проверете накратко.',
  'letter.explain.importance.unclear': 'Значението е неясно.',
} as const;

export const bgDocumentExplanation = {
  'documentExplanation.noData':
    'Нямам достатъчно информация. Моля, проверете документа или го качете отново.',
  'documentExplanation.risk.high': 'Висок – проверете скоро.',
  'documentExplanation.risk.medium': 'Среден – следете срокове и документи.',
  'documentExplanation.risk.low': 'Нисък – архивирайте рутинно.',
  'documentExplanation.risk.unclear': 'Неясно – проверете ръчно.',
  'documentExplanation.confidence.low': 'Разпознаването е несигурно – прочетете документа.',
  'documentExplanation.confidence.medium': 'Някои данни липсват – проверете при нужда.',
} as const;

export const bgLetterLabels = {
  'letter.explain.title': 'Обяснение на писмо',
  'letter.explain.about': 'За какво става въпрос?',
  'letter.explain.importance': 'Важно ли е?',
  'letter.explain.deadline': 'Има ли срок?',
  'letter.explain.nextSteps': 'Какво следва?',
  'letter.explain.digitalStorage': 'Дигитален архив',
  'letter.explain.paperStorage': 'Хартиен архив',
  'letter.explain.disclaimerTitle': 'Бележка',
  'letter.kind.brief': 'Писмо',
  'letter.kind.behoerde': 'Писмо от орган',
  'letter.kind.versicherung': 'Застрахователно писмо',
  'letter.kind.krankenkasse': 'Krankenkasse / AOK',
  'letter.kind.bg_bau': 'BG BAU',
  'letter.kind.finanzamt': 'Finanzamt',
  'letter.kind.soka_bau': 'SOKA-BAU',
  'letter.kind.wichtiges_schreiben': 'Важно писмо',
} as const;

export const bgNavigation = {
  'nav.schreibtisch': 'Начало',
  'nav.dokumente': 'Документи',
  'nav.auftraege': 'Поръчки',
  'nav.officepilot': 'OfficePilot',
  'nav.mehr': 'Още',
  'nav.steuerberater': 'Данъчен консултант',
} as const;

export const bgDocAssistantCore = {
  'docAssistant.section.brief': 'Накратко',
  'docAssistant.section.actions': 'Какво да направите сега?',
  'docAssistant.section.inaction': 'Какво става, ако не направите нищо?',
  'docAssistant.section.filing': 'Архивиране',
  'docAssistant.section.original': 'Какво да направите с оригинала?',
  'docAssistant.section.steuerberater': 'Данъчен консултант',
  'docAssistant.section.trust': 'Сигурно / Моля, проверете',
  'docAssistant.section.questions': 'Въпрос за този документ',
  'docAssistant.answer.aiUnavailable': 'Преводът изисква настройка на AI.',
} as const;
