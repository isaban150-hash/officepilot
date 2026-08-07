import { t } from '../i18n';
import type { BusinessFactCertainty } from '../types/businessInterpretation';
import type { InboxItem, WorkflowResult } from '../types/models';

export interface DocumentNarrativeInput {
  item: InboxItem;
  workflow?: WorkflowResult | null;
  truthBusinessInterpretation?: WorkflowResult['businessInterpretation'] | null;
}

function withSentenceEnd(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function pickFirstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function capitalizeFirst(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function isUncertain(certainty: BusinessFactCertainty | undefined): boolean {
  return certainty === 'uncertain' || certainty === 'proposed' || certainty === 'conflicting';
}

function resolveDocumentType(input: DocumentNarrativeInput): string | undefined {
  return pickFirstNonEmpty(
    input.workflow?.documentUnderstanding?.documentType,
    input.workflow?.classifiedKind,
    input.item.classifiedKind,
    input.item.documentType,
  );
}

function resolveCounterparty(input: DocumentNarrativeInput): {
  value?: string;
  uncertain: boolean;
} {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const party = bi?.facts.parties.counterparty;
  const value = pickFirstNonEmpty(
    party?.name,
    input.workflow?.documentUnderstanding?.sender,
    input.item.sender,
  );
  return {
    value,
    uncertain: party ? isUncertain(party.certainty) : false,
  };
}

function resolveAmount(input: DocumentNarrativeInput): {
  value?: string;
  uncertain: boolean;
} {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const money = bi?.facts.money?.[0];
  const value = pickFirstNonEmpty(
    money?.amountFormatted,
    money?.amount != null ? `${money.amount} ${money.currency ?? 'EUR'}` : undefined,
    input.workflow?.documentUnderstanding?.amount,
  );
  return {
    value,
    uncertain: money ? isUncertain(money.certainty) : false,
  };
}

function resolveDeadline(input: DocumentNarrativeInput): {
  value?: string;
  uncertain: boolean;
} {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const deadline = bi?.facts.timeline.deadline;
  const value = pickFirstNonEmpty(
    deadline?.value,
    input.workflow?.documentUnderstanding?.deadline,
    input.item.deadline,
  );
  return {
    value,
    uncertain: deadline ? isUncertain(deadline.certainty) : false,
  };
}

function resolvePurpose(input: DocumentNarrativeInput): {
  value?: string;
  uncertain: boolean;
} {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const meaning = bi?.meaning;
  const value = pickFirstNonEmpty(meaning?.summary);
  return {
    value,
    uncertain: meaning ? isUncertain(meaning.certainty) : false,
  };
}

function resolveContractFamilyLabel(input: DocumentNarrativeInput): string | undefined {
  const family = input.truthBusinessInterpretation?.contractFamily ?? input.workflow?.businessInterpretation?.contractFamily;
  if (!family) return undefined;

  switch (family) {
    case 'werkvertrag':
      return 'Werkvertrag';
    case 'wartungsvertrag':
      return 'Wartungsvertrag';
    case 'mietvertrag':
      return 'Mietvertrag';
    case 'dienstleistungsvertrag':
      return 'Dienstleistungsvertrag';
    case 'kaufvertrag':
      return 'Kaufvertrag';
    case 'subunternehmervertrag':
      return 'Subunternehmervertrag';
    default:
      return undefined;
  }
}

function resolveVorgangContext(input: DocumentNarrativeInput): string | undefined {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const ref = bi?.vorgangRef;
  if (!ref) return undefined;

  const documentType = resolveDocumentType(input);
  const normalizedType = documentType?.trim().toLowerCase();
  const subject = normalizedType
    ? normalizedType === 'eingangsrechnung' || normalizedType === 'rechnung'
      ? 'Diese Rechnung'
      : normalizedType === 'nachtrag'
        ? 'Dieser Nachtrag'
        : `Dieses ${documentType}`
    : 'Dieses Dokument';

  const contractFamilyLabel = resolveContractFamilyLabel(input);
  const contractRelation =
    normalizedType === 'nachtrag' && contractFamilyLabel
      ? ` Er bezieht sich auf den bereits erkannten ${contractFamilyLabel}.`
      : undefined;

  if (ref.status === 'linked' && ref.linkedVorgangTitle?.trim()) {
    return `${subject} gehört zum Vorgang „${ref.linkedVorgangTitle.trim()}“.${contractRelation ?? ''}`;
  }
  if (ref.status === 'suggested' && ref.suggested?.vorgangTitle?.trim()) {
    return `${subject} gehört wahrscheinlich zum Vorgang „${ref.suggested.vorgangTitle.trim()}“.${contractRelation ?? ''}`;
  }
  if (ref.status === 'ambiguous' && ref.similarCount > 0) {
    return `Der Vorgangsbezug ist noch nicht eindeutig (${ref.similarCount} mögliche Vorgänge).`;
  }
  return undefined;
}

function resolveNextStep(input: DocumentNarrativeInput): string | undefined {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const value = pickFirstNonEmpty(
    bi?.operational.nextStep,
    input.workflow?.workflowDecision?.operationalNextStep,
    input.workflow?.documentUnderstanding?.nextStep,
  );
  return value ? `Nächster Schritt: ${value}.` : undefined;
}

function resolveRisk(input: DocumentNarrativeInput): string | undefined {
  const risk = input.workflow?.workflowDecision?.risks?.[0];
  if (!risk) return undefined;
  const text = t(risk.messageKey as never, 'de', risk.params);
  if (!text || text === risk.messageKey) return undefined;
  return `Risiko: ${text}`;
}

export function buildDocumentNarrative(input: DocumentNarrativeInput): string {
  const documentType = resolveDocumentType(input);
  const counterparty = resolveCounterparty(input);
  const amount = resolveAmount(input);
  const purpose = resolvePurpose(input);
  const deadline = resolveDeadline(input);
  const vorgangRef = resolveVorgangContext(input);
  const nextStep = resolveNextStep(input);
  const risk = resolveRisk(input);

  const sentenceOneParts: string[] = [];
  if (documentType) {
    sentenceOneParts.push(`Das Dokument wurde als ${documentType} eingeordnet`);
  }
  if (counterparty.value) {
    sentenceOneParts.push(
      counterparty.uncertain
        ? `die Gegenpartei ist wahrscheinlich ${counterparty.value}`
        : `die Gegenpartei ist ${counterparty.value}`,
    );
  }
  if (amount.value) {
    sentenceOneParts.push(
      amount.uncertain
        ? `ein Betrag ist wahrscheinlich ${amount.value}`
        : `ein Betrag ist ${amount.value}`,
    );
  }

  const sentenceTwoParts: string[] = [];
  if (purpose.value) {
    sentenceTwoParts.push(
      purpose.uncertain ? `Es geht wahrscheinlich um: ${purpose.value}` : purpose.value,
    );
  }
  if (deadline.value) {
    sentenceTwoParts.push(
      deadline.uncertain
        ? `Eine Frist ist wahrscheinlich ${deadline.value}`
        : `Die Frist ist ${deadline.value}`,
    );
  }

  const lines: string[] = [];
  if (sentenceOneParts.length > 0) {
    lines.push(withSentenceEnd(capitalizeFirst(sentenceOneParts.join(', '))));
  }
  if (sentenceTwoParts.length > 0) {
    lines.push(withSentenceEnd(sentenceTwoParts.join('. ')));
  }
  if (vorgangRef) lines.push(withSentenceEnd(vorgangRef));
  if (nextStep) lines.push(withSentenceEnd(nextStep));
  if (risk) lines.push(withSentenceEnd(risk));

  return lines.filter(Boolean).slice(0, 4).join(' ');
}
