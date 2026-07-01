import type {
  CommunicationContext,
  CommunicationIntent,
  CommunicationRequest,
  MissingCommunicationInfo,
} from '../types/communication';

type FieldDef = Omit<MissingCommunicationInfo, 'fieldId'> & { fieldId: string };

const FIELD = {
  position: {
    fieldId: 'position',
    labelKey: 'communication.field.position',
    promptKey: 'communication.prompt.position',
    required: true,
    inputType: 'text' as const,
  },
  newPrice: {
    fieldId: 'newPrice',
    labelKey: 'communication.field.newPrice',
    promptKey: 'communication.prompt.newPrice',
    required: true,
    inputType: 'text' as const,
  },
  reason: {
    fieldId: 'reason',
    labelKey: 'communication.field.reason',
    promptKey: 'communication.prompt.reason',
    required: true,
    inputType: 'text' as const,
  },
  newDate: {
    fieldId: 'newDate',
    labelKey: 'communication.field.newDate',
    promptKey: 'communication.prompt.newDate',
    required: true,
    inputType: 'date' as const,
  },
  oldDate: {
    fieldId: 'oldDate',
    labelKey: 'communication.field.oldDate',
    promptKey: 'communication.prompt.oldDate',
    required: false,
    inputType: 'date' as const,
  },
  delayReason: {
    fieldId: 'delayReason',
    labelKey: 'communication.field.delayReason',
    promptKey: 'communication.prompt.delayReason',
    required: false,
    inputType: 'text' as const,
  },
  delayDuration: {
    fieldId: 'delayDuration',
    labelKey: 'communication.field.delayDuration',
    promptKey: 'communication.prompt.delayDuration',
    required: false,
    inputType: 'text' as const,
  },
  workDescription: {
    fieldId: 'workDescription',
    labelKey: 'communication.field.workDescription',
    promptKey: 'communication.prompt.workDescription',
    required: true,
    inputType: 'text' as const,
  },
  coreMessage: {
    fieldId: 'coreMessage',
    labelKey: 'communication.field.coreMessage',
    promptKey: 'communication.prompt.coreMessage',
    required: true,
    inputType: 'text' as const,
  },
  targetLanguage: {
    fieldId: 'targetLanguage',
    labelKey: 'communication.field.targetLanguage',
    promptKey: 'communication.prompt.targetLanguage',
    required: true,
    inputType: 'text' as const,
  },
  sourceText: {
    fieldId: 'sourceText',
    labelKey: 'communication.field.sourceText',
    promptKey: 'communication.prompt.sourceText',
    required: true,
    inputType: 'text' as const,
  },
  invoiceReference: {
    fieldId: 'invoiceReference',
    labelKey: 'communication.field.invoiceReference',
    promptKey: 'communication.prompt.invoiceReference',
    required: true,
    inputType: 'text' as const,
  },
  cancelTarget: {
    fieldId: 'cancelTarget',
    labelKey: 'communication.field.cancelTarget',
    promptKey: 'communication.prompt.cancelTarget',
    required: true,
    inputType: 'text' as const,
  },
  cancelReason: {
    fieldId: 'cancelReason',
    labelKey: 'communication.field.cancelReason',
    promptKey: 'communication.prompt.cancelReason',
    required: true,
    inputType: 'text' as const,
  },
  declineTarget: {
    fieldId: 'declineTarget',
    labelKey: 'communication.field.declineTarget',
    promptKey: 'communication.prompt.declineTarget',
    required: true,
    inputType: 'text' as const,
  },
  declineReason: {
    fieldId: 'declineReason',
    labelKey: 'communication.field.declineReason',
    promptKey: 'communication.prompt.declineReason',
    required: true,
    inputType: 'text' as const,
  },
};

function isFilled(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function missingFields(
  defs: FieldDef[],
  answers: Record<string, string> = {},
): MissingCommunicationInfo[] {
  return defs
    .filter((def) => def.required && !isFilled(answers[def.fieldId]))
    .map(({ fieldId, labelKey, promptKey, required, inputType, options }) => ({
      fieldId,
      labelKey,
      promptKey,
      required,
      inputType,
      options,
    }));
}

function extractFromUserText(request: CommunicationRequest, key: string): string | undefined {
  return request.userAnswers?.[key]?.trim() || undefined;
}

function mergeAnswer(
  request: CommunicationRequest,
  key: string,
  userTextFallback?: string,
): string | undefined {
  const fromAnswers = extractFromUserText(request, key);
  if (fromAnswers) return fromAnswers;
  if (key === 'sourceText' && userTextFallback && userTextFallback.length > 20) {
    return userTextFallback;
  }
  if (key === 'coreMessage' && userTextFallback) {
    const match = userTextFallback.match(/dass\s+(.+)/i);
    if (match) return match[1].trim();
  }
  return undefined;
}

export function getRequiredFieldsForIntent(intent: CommunicationIntent): FieldDef[] {
  switch (intent) {
    case 'price_adjustment':
      return [FIELD.position, FIELD.newPrice, FIELD.reason];
    case 'cancel_order':
      return [FIELD.cancelTarget, FIELD.cancelReason];
    case 'decline_offer':
      return [FIELD.declineTarget, FIELD.declineReason];
    case 'appointment_change':
      return [FIELD.newDate];
    case 'delay_notice':
      return [FIELD.delayReason, FIELD.delayDuration];
    case 'additional_work':
      return [FIELD.workDescription, FIELD.reason];
    case 'payment_reminder':
      return [FIELD.invoiceReference];
    case 'invoice_followup':
      return [FIELD.invoiceReference];
    case 'document_reply':
      return [FIELD.coreMessage];
    case 'translate_message':
      return [FIELD.sourceText, FIELD.targetLanguage];
    case 'improve_text':
    case 'rewrite_message':
      return [FIELD.sourceText];
    default:
      return [];
  }
}

export function getMissingCommunicationInfo(
  intent: CommunicationIntent,
  request: CommunicationRequest,
  context: CommunicationContext,
): MissingCommunicationInfo[] {
  const answers = { ...(request.userAnswers ?? {}) };

  if (intent === 'delay_notice') {
    const hasReason = isFilled(answers.delayReason);
    const hasDuration = isFilled(answers.delayDuration);
    if (!hasReason && !hasDuration) {
      return [
        {
          ...FIELD.delayReason,
          required: true,
        },
        {
          ...FIELD.delayDuration,
          required: true,
        },
      ];
    }
    return [];
  }

  if (intent === 'payment_reminder' || intent === 'invoice_followup') {
    if (context.invoiceSummary?.number) {
      answers.invoiceReference = answers.invoiceReference ?? context.invoiceSummary.number;
    }
  }

  if (intent === 'improve_text' || intent === 'rewrite_message' || intent === 'translate_message') {
    if (!answers.sourceText) {
      const source = mergeAnswer(request, 'sourceText', request.userText);
      if (source) answers.sourceText = source;
    }
  }

  if (intent === 'document_reply') {
    if (!answers.coreMessage) {
      const core = mergeAnswer(request, 'coreMessage', request.userText);
      if (core) answers.coreMessage = core;
    }
  }

  const defs = getRequiredFieldsForIntent(intent);
  return missingFields(defs, answers);
}

export function getMergedUserAnswers(
  intent: CommunicationIntent,
  request: CommunicationRequest,
  context: CommunicationContext,
): Record<string, string> {
  const answers = { ...(request.userAnswers ?? {}) };

  if (context.invoiceSummary?.number && !answers.invoiceReference) {
    answers.invoiceReference = context.invoiceSummary.number;
  }

  if ((intent === 'improve_text' || intent === 'rewrite_message' || intent === 'translate_message') && !answers.sourceText) {
    const source = mergeAnswer(request, 'sourceText', request.userText);
    if (source) answers.sourceText = source;
  }

  if (intent === 'document_reply' && !answers.coreMessage) {
    const core = mergeAnswer(request, 'coreMessage', request.userText);
    if (core) answers.coreMessage = core;
  }

  return answers;
}
