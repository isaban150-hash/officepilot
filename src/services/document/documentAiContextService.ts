import { analyzeContractFromInbox } from '../contractAnalysisService';
import { getLetterExplanation } from '../letterExplanationService';
import { MAX_RECOGNIZED_TEXT_LENGTH } from '../communicationConstants';
import { sanitizeAiText, containsSensitiveFactKey } from '../ai/aiTextSanitizer';
import type { DocumentAiContext } from '../../types/areaAi';
import type { CompanyDocument, InboxItem } from '../../types/models';

function truncateText(text: string, max = MAX_RECOGNIZED_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildRecognizedDataLines(data: Record<string, string>): string[] {
  return Object.entries(data)
    .filter(([key]) => !containsSensitiveFactKey(key))
    .map(([key, value]) => `${key}: ${sanitizeAiText(value)}`);
}

export function buildDocumentAiContextFromDocument(document: CompanyDocument): DocumentAiContext {
  return {
    sourceType: 'document',
    title: document.title,
    issuerOrSender: document.issuer,
    category: document.category,
    issueDate: document.issueDate,
    validUntil: document.validUntil,
    recognizedText: document.recognizedText
      ? sanitizeAiText(truncateText(document.recognizedText))
      : undefined,
    recognizedDataLines: document.tags.map((tag) => `Tag: ${sanitizeAiText(tag)}`),
    linkedVorgangTitle: document.linkedVorgang?.vorgangTitle,
    missingDocuments: [],
    tags: document.tags,
  };
}

export function buildDocumentAiContextFromInbox(item: InboxItem): DocumentAiContext {
  const vertragstext =
    item.recognizedData._vertragstext ?? item.recognizedData.Vertragstext ?? '';
  const recognizedText = truncateText(
    [item.title, item.sender, item.officePilotSuggestion, vertragstext]
      .concat(
        Object.entries(item.recognizedData)
          .filter(([key]) => key !== '_vertragstext' && key !== 'Vertragstext')
          .map(([, value]) => value),
      )
      .filter(Boolean)
      .join('\n'),
  );

  const explanation = getLetterExplanation(item);
  const contract = analyzeContractFromInbox(item);

  return {
    sourceType: 'inbox',
    title: item.title,
    issuerOrSender: item.sender,
    category: item.documentType,
    deadline: item.deadline ?? item.recognizedData.Frist ?? undefined,
    recognizedText: sanitizeAiText(recognizedText),
    recognizedDataLines: buildRecognizedDataLines(item.recognizedData),
    linkedVorgangTitle: item.vorgangTitle,
    letterSummary: explanation
      ? {
          about: sanitizeAiText(explanation.about),
          deadline: sanitizeAiText(explanation.deadline),
          nextSteps: sanitizeAiText(explanation.nextSteps),
        }
      : undefined,
    missingDocuments: contract.isContract
      ? contract.requiredDocuments.map((doc) => doc.reason || doc.type.replace(/_/g, ' '))
      : [],
    tags: [],
  };
}

export function buildDocumentAiAllowedSourceText(context: DocumentAiContext): string {
  return [
    context.title,
    context.issuerOrSender,
    context.category,
    context.deadline ?? '',
    context.validUntil ?? '',
    context.issueDate ?? '',
    context.recognizedText ?? '',
    ...context.recognizedDataLines,
    context.linkedVorgangTitle ?? '',
    context.letterSummary?.about ?? '',
    context.letterSummary?.deadline ?? '',
    context.letterSummary?.nextSteps ?? '',
    ...context.missingDocuments,
    ...context.tags,
  ].join('\n');
}
