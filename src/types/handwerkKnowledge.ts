import type { BrainSuggestedStep } from './brainOrchestration';
import type { ClassifiedDocumentKind } from './models';

export type HandwerkKnowledgeId =
  | 'werkvertrag'
  | 'angebot'
  | 'leistungsverzeichnis'
  | 'aufmasz'
  | 'nachtrag'
  | 'abschlagsrechnung'
  | 'schlussrechnung'
  | 'teilrechnung'
  | 'materialrechnung'
  | 'lieferschein'
  | 'stundenzettel'
  | 'bautagebuch'
  | 'abnahme'
  | 'gewaehrleistung'
  | 'vob'
  | 'lv'
  | 'ep'
  | 'gp'
  | 'einheitspreis'
  | 'pauschalpreis'
  | 'baustelleneinrichtung'
  | 'geruest'
  | 'daemmung'
  | 'abdichtung'
  | 'unterkonstruktion'
  | 'attika'
  | 'lichtkuppel'
  | 'dachflaeche'
  | 'fallrohr'
  | 'traufe'
  | 'ortgang'
  | 'workflow_chain';

export interface HandwerkTermDefinition {
  id: HandwerkKnowledgeId;
  title: string;
  aliases: string[];
  definition: string;
  practicalNote: string;
  relatedIds?: HandwerkKnowledgeId[];
  documentKind?: ClassifiedDocumentKind;
}

export interface HandwerkAdvice {
  messageKey: string;
  params?: Record<string, string | number>;
  certainty: 'high' | 'medium' | 'low';
  knowledgeId: string;
}

export interface HandwerkKnowledgeResolution {
  source: 'memory' | 'rules' | 'clarification';
  assistantAnswer?: {
    title: string;
    summary: string;
    bullets: string[];
    actions: [];
    linkedRoute?: string;
  };
  suggestedNextSteps?: BrainSuggestedStep[];
  uncertaintyNote?: string;
  clarificationQuestion?: string;
  knowledgeUsed: string[];
}
