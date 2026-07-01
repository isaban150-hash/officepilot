import { getMergedUserAnswers } from './communicationQuestionService';
import type {
  CommunicationContext,
  CommunicationDraftCore,
  CommunicationIntent,
  CommunicationRequest,
  RewriteStyle,
} from '../types/communication';

function recipientName(context: CommunicationContext): string {
  return context.recipient?.name ?? 'Sehr geehrte Damen und Herren';
}

function customerReference(context: CommunicationContext): string {
  if (context.vorgangSummary) {
    return `bezüglich des Vorgangs „${context.vorgangSummary.title}“ (${context.vorgangSummary.baustelle})`;
  }
  if (context.subject) {
    return `bezüglich „${context.subject}“`;
  }
  return '';
}

function applyRewriteStyle(text: string, style?: RewriteStyle): string {
  if (!style) return text;
  switch (style) {
    case 'polite':
      return text.replace(/^Hallo/, 'Guten Tag').replace(/Mit freundlichen Grüßen/, 'Mit freundlichen, vorzüglichen Grüßen');
    case 'assertive':
      return text.replace(/bitte/gi, '').replace(/  +/g, ' ').trim();
    case 'professional':
      return text;
    case 'shorter':
      return text
        .split('\n')
        .filter((line) => line.trim())
        .slice(0, 4)
        .join('\n');
    case 'longer':
      return `${text}\n\nFür Rückfragen stehen wir Ihnen gerne zur Verfügung.`;
    case 'friendly':
      return text.replace(/Sehr geehrte/g, 'Hallo').replace(/Mit freundlichen Grüßen/, 'Viele Grüße');
    default:
      return text;
  }
}

function improveText(source: string): string {
  return source
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^\w/, (char) => char.toUpperCase());
}

function buildPriceAdjustmentDraft(
  answers: Record<string, string>,
  context: CommunicationContext,
): CommunicationDraftCore {
  const position = answers.position.trim();
  const newPrice = answers.newPrice.trim();
  const reason = answers.reason.trim();
  const ref = customerReference(context);

  const body = [
    recipientName(context) === 'Sehr geehrte Damen und Herren'
      ? 'Sehr geehrte Damen und Herren,'
      : `Sehr geehrte/r ${recipientName(context)},`,
    '',
    ref ? `${ref} teilen wir Ihnen mit, dass der Preis für „${position}“ auf ${newPrice} angepasst wird.` : `Wir teilen Ihnen mit, dass der Preis für „${position}“ auf ${newPrice} angepasst wird.`,
    '',
    `Begründung: ${reason}`,
    '',
    'Mit freundlichen Grüßen',
    context.companyName,
  ].join('\n');

  return {
    intent: 'price_adjustment',
    subject: ref ? `Preisanpassung – ${context.vorgangSummary?.title ?? context.subject}` : 'Preisanpassung',
    body,
    tone: 'formal',
    basedOnFacts: [`Position: ${position}`, `Neuer Preis: ${newPrice}`, `Grund (vom Nutzer): ${reason}`],
    notIncluded: ['Keine automatisch ergänzten Marktdaten oder Preisbegründungen'],
  };
}

function buildDelayNoticeDraft(
  answers: Record<string, string>,
  context: CommunicationContext,
): CommunicationDraftCore {
  const reason = answers.delayReason?.trim();
  const duration = answers.delayDuration?.trim();
  const detail = [reason, duration].filter(Boolean).join(' – ');
  const ref = customerReference(context);

  const body = [
    `Sehr geehrte/r ${recipientName(context)},`,
    '',
    ref
      ? `${ref} müssen wir Sie leider über eine Verzögerung informieren.`
      : 'Wir müssen Sie leider über eine Verzögerung informieren.',
    detail ? `Grund/Dauer: ${detail}` : '',
    '',
    'Wir informieren Sie, sobald ein neuer Termin feststeht.',
    '',
    'Mit freundlichen Grüßen',
    context.companyName,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const basedOnFacts = ['Verzögerung vom Nutzer gemeldet'];
  if (reason) basedOnFacts.push(`Grund: ${reason}`);
  if (duration) basedOnFacts.push(`Dauer: ${duration}`);

  return {
    intent: 'delay_notice',
    subject: 'Information zur Verzögerung',
    body,
    tone: 'formal',
    basedOnFacts,
    notIncluded: ['Kein neuer Termin – nur wenn vom Nutzer angegeben'],
  };
}

function buildDocumentReplyDraft(
  answers: Record<string, string>,
  context: CommunicationContext,
): CommunicationDraftCore {
  const core = answers.coreMessage.trim();
  const sender = context.recipient?.organization ?? context.recipient?.name ?? 'Absender';

  const body = [
    `Sehr geehrte Damen und Herren,`,
    '',
    context.subject ? `bezüglich Ihres Schreibens „${context.subject}“:` : `bezüglich Ihres Schreibens:`,
    '',
    core,
    '',
    'Mit freundlichen Grüßen',
    context.companyName,
  ].join('\n');

  return {
    intent: 'document_reply',
    subject: context.subject ? `Re: ${context.subject}` : `Antwort an ${sender}`,
    body,
    tone: 'formal',
    basedOnFacts: [`Kernaussage (vom Nutzer): ${core}`],
    notIncluded: ['Keine rechtliche Bewertung', 'Keine ergänzten Fakten außer Nutzerangabe'],
  };
}

function buildPaymentReminderDraft(
  answers: Record<string, string>,
  context: CommunicationContext,
): CommunicationDraftCore {
  const invoiceRef = answers.invoiceReference?.trim() ?? context.invoiceSummary?.number ?? '';
  const openAmount = context.invoiceSummary?.openAmount;
  const dueDate = context.invoiceSummary?.dueDate;

  const lines = [
    `Sehr geehrte/r ${recipientName(context)},`,
    '',
    `wir möchten Sie freundlich an die Rechnung ${invoiceRef} erinnern.`,
  ];
  if (openAmount !== undefined) {
    lines.push(`Offener Betrag: ${openAmount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`);
  }
  if (dueDate) {
    lines.push(`Zahlungsziel: ${dueDate}`);
  }
  lines.push('', 'Mit freundlichen Grüßen', context.companyName);

  const basedOnFacts = [`Rechnungsbezug: ${invoiceRef}`];
  if (openAmount !== undefined) basedOnFacts.push(`Offener Betrag aus System: ${openAmount}`);
  if (dueDate) basedOnFacts.push(`Fälligkeit aus System: ${dueDate}`);

  return {
    intent: 'payment_reminder',
    subject: `Zahlungserinnerung – Rechnung ${invoiceRef}`,
    body: lines.join('\n'),
    tone: 'formal',
    basedOnFacts,
    notIncluded: ['Keine Mahngebühren oder rechtliche Schritte'],
  };
}

function buildGenericDraft(
  intent: CommunicationIntent,
  answers: Record<string, string>,
  context: CommunicationContext,
  title: string,
  messageLine: string,
): CommunicationDraftCore {
  const reasonKey = answers.reason ?? answers.cancelReason ?? answers.declineReason;
  const body = [
    `Sehr geehrte/r ${recipientName(context)},`,
    '',
    messageLine,
    reasonKey ? `Grund: ${reasonKey.trim()}` : '',
    '',
    'Mit freundlichen Grüßen',
    context.companyName,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const basedOnFacts: string[] = [messageLine];
  if (reasonKey) basedOnFacts.push(`Grund (vom Nutzer): ${reasonKey.trim()}`);

  return {
    intent,
    subject: title,
    body,
    tone: 'formal',
    basedOnFacts,
    notIncluded: ['Keine automatisch ergänzten Begründungen'],
  };
}

export function buildCommunicationDraft(
  request: CommunicationRequest,
  context: CommunicationContext,
  intent: CommunicationIntent,
): CommunicationDraftCore | null {
  const answers = getMergedUserAnswers(intent, request, context);

  switch (intent) {
    case 'price_adjustment':
      if (!answers.position || !answers.newPrice || !answers.reason) return null;
      return buildPriceAdjustmentDraft(answers, context);

    case 'delay_notice':
      if (!answers.delayReason && !answers.delayDuration) return null;
      return buildDelayNoticeDraft(answers, context);

    case 'document_reply':
      if (!answers.coreMessage) return null;
      return buildDocumentReplyDraft(answers, context);

    case 'payment_reminder':
    case 'invoice_followup':
      if (!answers.invoiceReference && !context.invoiceSummary?.number) return null;
      return buildPaymentReminderDraft(answers, context);

    case 'cancel_order':
      if (!answers.cancelTarget || !answers.cancelReason) return null;
      return buildGenericDraft(
        intent,
        answers,
        context,
        'Stornierung',
        `Hiermit stornieren wir: ${answers.cancelTarget.trim()}.`,
      );

    case 'decline_offer':
      if (!answers.declineTarget || !answers.declineReason) return null;
      return buildGenericDraft(
        intent,
        answers,
        context,
        'Absage Angebot',
        `Leider müssen wir das Angebot „${answers.declineTarget.trim()}“ ablehnen.`,
      );

    case 'appointment_change': {
      if (!answers.newDate) return null;
      const oldPart = answers.oldDate ? ` vom ${answers.oldDate}` : '';
      return buildGenericDraft(
        intent,
        answers,
        context,
        'Terminänderung',
        `Wir möchten den Termin${oldPart} auf ${answers.newDate} verschieben.`,
      );
    }

    case 'additional_work':
      if (!answers.workDescription || !answers.reason) return null;
      return buildGenericDraft(
        intent,
        answers,
        context,
        'Zusätzliche Leistung',
        `Zusätzliche Leistung: ${answers.workDescription.trim()}.`,
      );

    case 'improve_text': {
      if (!answers.sourceText) return null;
      const improved = improveText(answers.sourceText);
      return {
        intent,
        body: improved,
        tone: 'neutral',
        basedOnFacts: ['Quelltext vom Nutzer'],
        notIncluded: ['Keine inhaltlichen Ergänzungen'],
      };
    }

    case 'rewrite_message': {
      if (!answers.sourceText) return null;
      const rewritten = applyRewriteStyle(answers.sourceText, request.rewriteStyle);
      return {
        intent,
        body: rewritten,
        tone: request.rewriteStyle === 'shorter' ? 'short' : 'neutral',
        basedOnFacts: ['Quelltext vom Nutzer', `Stil: ${request.rewriteStyle ?? 'neutral'}`],
        notIncluded: ['Keine neuen Informationen oder Gründe'],
      };
    }

    case 'translate_message': {
      if (!answers.sourceText || !answers.targetLanguage) return null;
      return {
        intent,
        subject: 'Übersetzung (Entwurf)',
        body: `[Übersetzung nach ${answers.targetLanguage} – bitte Fachtext prüfen]\n\n${answers.sourceText}`,
        tone: 'neutral',
        basedOnFacts: [`Quelltext vom Nutzer`, `Zielsprache: ${answers.targetLanguage}`],
        notIncluded: ['Keine beglaubigte Übersetzung – nur Entwurf'],
      };
    }

    default:
      return null;
  }
}

export { applyRewriteStyle, improveText };
