import type { BrainSuggestedStep } from './brainOrchestration';

export type FinanceStepId = 'auftrag' | 'rechnung' | 'zahlung' | 'faelligkeit' | 'mahnung';

export type FinanceStepStatus =
  | 'completed'
  | 'open'
  | 'at_risk'
  | 'not_applicable'
  | 'not_due'
  | 'unknown';

export type FinanceRiskSeverity = 'high' | 'medium' | 'low';

export interface FinanceStep {
  id: FinanceStepId;
  status: FinanceStepStatus;
  labelKey: string;
  evidence?: string;
}

export interface FinanceRisk {
  id: string;
  severity: FinanceRiskSeverity;
  messageKey: string;
  params?: Record<string, string | number>;
  priority: number;
}

export interface FinanceRecommendation {
  id: string;
  priority: number;
  messageKey: string;
  params?: Record<string, string | number>;
  route?: string;
  labelKey?: string;
  reasonKey?: string;
}

export interface FinanceAnalysis {
  scope: 'invoice' | 'vorgang' | 'customer' | 'global' | 'inbox';
  scopeId: string;
  scopeTitle: string;
  steps: FinanceStep[];
  risks: FinanceRisk[];
  recommendations: FinanceRecommendation[];
  datevRelevantCount?: number;
  uncertaintyNote?: string;
}

export interface FinanceAnalysisSummary {
  scopeTitle: string;
  completedSteps: string[];
  openSteps: string[];
  riskSteps: string[];
  openReceivables?: number;
  overdueCount?: number;
  primaryRecommendationKey?: string;
  primaryRecommendationParams?: Record<string, string | number>;
}

/** Alle financeIntelligence i18n-Keys (für DE/TR-Paritätstests). */
export const FINANCE_INTELLIGENCE_I18N_KEYS = [
  'financeIntelligence.step.auftrag',
  'financeIntelligence.step.rechnung',
  'financeIntelligence.step.zahlung',
  'financeIntelligence.step.faelligkeit',
  'financeIntelligence.step.mahnung',
  'financeIntelligence.risk.invoiceOverdue',
  'financeIntelligence.risk.paymentOpen',
  'financeIntelligence.risk.partialPayment',
  'financeIntelligence.risk.duplicateInvoice',
  'financeIntelligence.risk.duplicatePayment',
  'financeIntelligence.risk.noInvoiceOnVorgang',
  'financeIntelligence.risk.materialWithoutVorgang',
  'financeIntelligence.risk.missingBookingDoc',
  'financeIntelligence.risk.openReceivables',
  'financeIntelligence.recommend.paymentReminder',
  'financeIntelligence.recommend.mahnung',
  'financeIntelligence.recommend.recordPayment',
  'financeIntelligence.recommend.createInvoice',
  'financeIntelligence.recommend.assignMaterial',
  'financeIntelligence.recommend.reviewOverpaid',
  'financeIntelligence.recommend.reviewDuplicate',
  'financeIntelligence.recommend.collectDatevDocs',
  'financeIntelligence.info.dueToday',
  'financeIntelligence.info.duePending',
  'financeIntelligence.skonto.incomingUsable',
  'financeIntelligence.skonto.outgoingCustomer',
  'financeIntelligence.skonto.reviewRequired',
  'financeIntelligence.hint.overdueInvoice',
  'financeIntelligence.hint.noPaymentRecorded',
  'financeIntelligence.datev.relevantDocs',
  'financeIntelligence.datev.noExport',
  'financeIntelligence.datev.markForAccounting',
  'financeIntelligence.tax.reverseChargeExplain',
  'financeIntelligence.tax.reverseChargeWhen',
  'financeIntelligence.tax.kleinunternehmerExplain',
  'financeIntelligence.tax.missingInvoiceNotices',
  'financeIntelligence.tax.noAdvice',
  'financeIntelligence.nextStep.openInvoices',
  'financeIntelligence.nextStep.openInvoice',
  'financeIntelligence.nextStep.recordPayment',
  'financeIntelligence.nextStep.paymentReminder',
  'financeIntelligence.nextStep.assignMaterial',
  'financeIntelligence.nextStep.default',
  'financeIntelligence.uncertainty.reviewRecommended',
] as const;

export interface FinanceKnowledgeResolution {
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
  financeUsed: string[];
  financeSummary?: FinanceAnalysisSummary;
}
