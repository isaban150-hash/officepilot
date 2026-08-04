import type { BusinessInterpretationConfirmation } from './businessInterpretation';
import type { BusinessInterpretationMeaning } from './businessInterpretation';
import type { BusinessInterpretationNextActionCandidate } from './businessInterpretation';
import type { BusinessInterpretationResult } from './businessInterpretation';
import type { BusinessInterpretationVorgangRef } from './businessInterpretation';
import type { BusinessPrimaryCase } from './businessInterpretation';
import type { BusinessEventType } from './businessInterpretation';
import type { BusinessStructuredTimeline } from './businessInterpretation';
import type { WorkflowAnalysis, WorkflowRisk } from './workflowIntelligence';
import type {
  AnalysisConfidence,
  ClassifiedDocumentKind,
  CompanyRelevanceResult,
  DocumentAiAction,
  DocumentClassificationResult,
  DocumentUnderstandingSummary,
  SuggestedDocumentAction,
  SuggestedVorgangLink,
  TaskProposal,
  WorkflowNextAction,
  WorkflowWarning,
} from './models';

export interface WorkflowDecisionArchiveDecision {
  readonly isArchived: boolean;
  readonly canArchive: boolean;
  readonly recommended: boolean;
  readonly enabled: boolean;
}

export interface WorkflowDecisionExecutionStatus {
  readonly importedToArchive: boolean;
  readonly archiveDocumentId?: string | null;
  readonly linkedVorgangId?: string | null;
  readonly linkedVorgangTitle?: string | null;
  readonly hasVorgang: boolean;
  readonly confirmedFiling: boolean;
}

export interface WorkflowDecisionOfficeActionContext {
  readonly availableDocumentActions: SuggestedDocumentAction[];
}

export interface WorkflowDecision {
  readonly inboxItemId: string;
  readonly source: 'live' | 'snapshot';
  readonly companyRelevant: boolean;
  readonly companyRelevance: CompanyRelevanceResult;
  readonly classifiedKind: ClassifiedDocumentKind;
  readonly classificationConfidence: AnalysisConfidence;
  readonly classification: DocumentClassificationResult | null;
  readonly documentExplanation: import('./models').WorkflowLetterSummary | null;
  readonly documentUnderstanding: DocumentUnderstandingSummary | null;
  readonly documentAiActions: DocumentAiAction[];
  readonly warnings: WorkflowWarning[];
  readonly suggestedVorgang: SuggestedVorgangLink | null;
  readonly businessInterpretation: BusinessInterpretationResult | null;
  readonly documentMeaning: BusinessInterpretationMeaning | null;
  readonly eventType: BusinessEventType | null;
  readonly primaryDecision: BusinessPrimaryCase | null;
  readonly operationalNextStep: string;
  readonly nextActionCandidates: BusinessInterpretationNextActionCandidate[];
  readonly nextActions: WorkflowNextAction[];
  readonly taskProposals: TaskProposal[];
  readonly vorgangRef: BusinessInterpretationVorgangRef;
  readonly deadlines: BusinessStructuredTimeline;
  readonly confirmations: BusinessInterpretationConfirmation[];
  readonly archiveDecision: WorkflowDecisionArchiveDecision;
  readonly officeActionContext: WorkflowDecisionOfficeActionContext;
  readonly executionStatus: WorkflowDecisionExecutionStatus;
  readonly risks: WorkflowRisk[];
  readonly workflowAnalysis: WorkflowAnalysis | null;
}
