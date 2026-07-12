import { detectCommunicationIntent } from '../communicationIntentService';
import { detectMemoryQueryIntent } from '../memory/memoryQueryService';
import { detectIntent, type AssistantIntent } from '../officeAssistantService';
import type { BrainCapabilityId } from '../../types/brainOrchestration';
import { detectActiveCapabilities } from './brainCapabilityRegistry';

export type BrainIntentCategory =
  | 'memory'
  | 'communication_draft'
  | 'communication_question'
  | 'document_explanation'
  | 'business_query'
  | 'unknown';

export interface BrainIntentAssessment {
  category: BrainIntentCategory;
  assistantIntent: AssistantIntent;
  memoryIntent: ReturnType<typeof detectMemoryQueryIntent>;
  communicationIntent: ReturnType<typeof detectCommunicationIntent>;
  activeCapabilities: BrainCapabilityId[];
  needsContext: boolean;
}

export function assessBrainIntent(question: string): BrainIntentAssessment {
  const trimmed = question.trim();
  const memoryIntent = detectMemoryQueryIntent(trimmed);
  const assistantIntent = detectIntent(trimmed);
  const communicationIntent = detectCommunicationIntent(trimmed);
  const activeCapabilities = detectActiveCapabilities(trimmed);

  let category: BrainIntentCategory = 'unknown';
  if (memoryIntent) {
    category = 'memory';
  } else if (
    /formuliere|schreib.*(kunde|kunden|nachricht|mail|absage|antwort)|nachricht.*schreiben/i.test(
      trimmed,
    )
  ) {
    category = 'communication_draft';
  } else if (
    communicationIntent !== 'unknown' &&
    communicationIntent !== 'document_question' &&
    !['improve_text', 'rewrite_message', 'translate_message'].includes(communicationIntent)
  ) {
    category = 'communication_draft';
  } else if (
    communicationIntent === 'document_question' ||
    /was bedeutet|was muss ich tun|was wollte|was ist mit/i.test(trimmed)
  ) {
    category = 'document_explanation';
  } else if (assistantIntent !== 'unknown') {
    category = 'business_query';
  }

  const needsContext =
    category === 'communication_draft' ||
    communicationIntent === 'document_reply' ||
    /formuliere|schreib.*zurück|antwort.*schreiben/i.test(trimmed);

  return {
    category,
    assistantIntent,
    memoryIntent,
    communicationIntent,
    activeCapabilities,
    needsContext,
  };
}
