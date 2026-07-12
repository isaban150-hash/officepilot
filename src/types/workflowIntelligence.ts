import type { BrainSuggestedStep } from './brainOrchestration';

export type WorkflowStepId =
  | 'werkvertrag'
  | 'auftrag'
  | 'leistungsverzeichnis'
  | 'material'
  | 'lieferschein'
  | 'aufmasz'
  | 'abschlagsrechnung'
  | 'schlussrechnung'
  | 'abnahme'
  | 'gewaehrleistung';

export type WorkflowStepStatus =
  | 'completed'
  | 'missing'
  | 'partial'
  | 'at_risk'
  | 'not_applicable'
  | 'not_due'
  | 'unknown';

export type WorkflowRiskSeverity = 'high' | 'medium' | 'low';

export interface WorkflowStep {
  id: WorkflowStepId;
  status: WorkflowStepStatus;
  labelKey: string;
  evidence?: string;
}

export interface WorkflowRisk {
  id: string;
  severity: WorkflowRiskSeverity;
  messageKey: string;
  params?: Record<string, string | number>;
}

export interface WorkflowRecommendation {
  id: string;
  priority: number;
  messageKey: string;
  params?: Record<string, string | number>;
  route?: string;
  labelKey?: string;
  reasonKey?: string;
}

export interface WorkflowAnalysis {
  scope: 'vorgang' | 'inbox';
  scopeId: string;
  scopeTitle: string;
  steps: WorkflowStep[];
  risks: WorkflowRisk[];
  recommendations: WorkflowRecommendation[];
  relatedDocumentIds: string[];
}

export interface WorkflowAnalysisSummary {
  scopeTitle: string;
  completedSteps: string[];
  missingSteps: string[];
  riskSteps: string[];
  notDueSteps: string[];
  unknownSteps: string[];
  primaryRecommendationKey?: string;
  primaryRecommendationParams?: Record<string, string | number>;
}

/** Alle workflowIntelligence i18n-Keys (für DE/TR-Paritätstests). */
export const WORKFLOW_INTELLIGENCE_I18N_KEYS = [
  'workflowIntelligence.step.werkvertrag',
  'workflowIntelligence.step.auftrag',
  'workflowIntelligence.step.leistungsverzeichnis',
  'workflowIntelligence.step.material',
  'workflowIntelligence.step.lieferschein',
  'workflowIntelligence.step.aufmasz',
  'workflowIntelligence.step.abschlagsrechnung',
  'workflowIntelligence.step.schlussrechnung',
  'workflowIntelligence.step.abnahme',
  'workflowIntelligence.step.gewaehrleistung',
  'workflowIntelligence.recommend.createVorgangFromContract',
  'workflowIntelligence.recommend.linkMaterialToVorgang',
  'workflowIntelligence.recommend.assignMaterial',
  'workflowIntelligence.recommend.importPositions',
  'workflowIntelligence.recommend.collectLieferschein',
  'workflowIntelligence.recommend.checkAufmasz',
  'workflowIntelligence.recommend.createAbschlag',
  'workflowIntelligence.recommend.createInvoice',
  'workflowIntelligence.recommend.createSchluss',
  'workflowIntelligence.recommend.prepareAbnahme',
  'workflowIntelligence.risk.materialWithoutVorgang',
  'workflowIntelligence.risk.materialAmbiguousVorgang',
  'workflowIntelligence.risk.materialWithoutLieferschein',
  'workflowIntelligence.risk.schlussWithoutAufmasz',
  'workflowIntelligence.risk.invoiceWithoutContract',
  'workflowIntelligence.risk.vorgangWithoutCustomer',
  'workflowIntelligence.risk.duplicateMaterial',
  'workflowIntelligence.risk.missingAbnahme',
  'workflowIntelligence.risk.openPositions',
  'workflowIntelligence.nextStep.reviewContract',
  'workflowIntelligence.nextStep.createVorgangReason',
  'workflowIntelligence.nextStep.linkMaterial',
  'workflowIntelligence.nextStep.openVorgang',
  'workflowIntelligence.nextStep.createInvoice',
  'workflowIntelligence.nextStep.createSchluss',
  'workflowIntelligence.nextStep.invoiceReason',
  'workflowIntelligence.nextStep.default',
] as const;

export interface WorkflowKnowledgeResolution {
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
  workflowUsed: string[];
  workflowSummary?: WorkflowAnalysisSummary;
}
