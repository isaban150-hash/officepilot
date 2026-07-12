import type { AssistantAnswer } from './models';
import type { BrainAnswer } from './brain';
import type { ProactiveHint } from './companySession';
import type { CommunicationContextRef } from './communication';
import type { WorkflowAnalysisSummary } from './workflowIntelligence';
import type { FinanceAnalysisSummary } from './financeIntelligence';

/** Erweiterbare Fähigkeiten – geplante Module sind vorbereitet, aber nicht aktiv. */
export type BrainCapabilityId =
  | 'documents'
  | 'communication'
  | 'vorgaenge'
  | 'invoices'
  | 'tasks'
  | 'memory'
  | 'knowledge'
  | 'ocr'
  | 'intake'
  | 'weather'
  | 'finanzamt'
  | 'bg_bau'
  | 'insurance'
  | 'datev'
  | 'vob'
  | 'construction_knowledge'
  | 'material_prices'
  | 'subsidies'
  | 'web_research';

export type BrainCapabilityStatus = 'active' | 'planned';

export type BrainOrchestrationSource =
  | 'memory'
  | 'search'
  | 'rules'
  | 'ai'
  | 'clarification'
  | 'planned_capability'
  | 'unavailable';

export type BrainConfidence = 'high' | 'medium' | 'low';

export type BrainOrchestrationMode = 'smart' | 'rules' | 'deep';

export interface BrainSuggestedStep {
  id: string;
  labelKey: string;
  route?: string;
  reasonKey?: string;
}

export interface BrainOrchestrationOptions {
  mode?: BrainOrchestrationMode;
  contextRef?: CommunicationContextRef;
  today?: Date | string;
}

export interface BrainOrchestrationResult {
  question: string;
  source: BrainOrchestrationSource;
  confidence: BrainConfidence;
  capabilityId?: BrainCapabilityId;
  assistantAnswer?: AssistantAnswer;
  brainAnswer?: BrainAnswer;
  suggestedNextSteps: BrainSuggestedStep[];
  uncertaintyNote?: string;
  clarificationQuestion?: string;
  proactiveHints?: ProactiveHint[];
  companyContextUsed?: string[];
  handwerkKnowledgeUsed?: string[];
  workflowUsed?: string[];
  workflowSummary?: WorkflowAnalysisSummary;
  financeUsed?: string[];
  financeSummary?: FinanceAnalysisSummary;
  generatedAt: string;
}
