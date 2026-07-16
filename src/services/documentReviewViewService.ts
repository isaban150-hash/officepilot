import { formatPaperFilingInstruction } from './paperFolderService';
import {
  buildPresentationChecks,
  buildPresentationContext,
  isUnknownPresentationValue,
} from './documentResultPresentationService';
import type {
  DocumentAiAction,
  InboxItem,
  WorkflowResult,
  WorkflowResultExecution,
} from '../types/models';
import type { TranslationKey } from '../i18n';

export const MAX_REVIEW_RECOMMENDATIONS = 6;

export interface DocumentReviewHeroView {
  documentTypeKey: TranslationKey;
  contextLabelKey: TranslationKey;
  contextValue: string;
  introKey: TranslationKey;
}

export interface DocumentReviewRecommendationView {
  id: string;
  labelKey: TranslationKey;
}

export interface DocumentReviewCheckView {
  id: string;
  labelKey: TranslationKey;
}

export interface DocumentReviewSuccessStepView {
  id: string;
  labelKey: TranslationKey;
}


function isUnknown(value?: string | null): boolean {
  return isUnknownPresentationValue(value);
}

function resolveContext(item: InboxItem, workflow: WorkflowResult): {
  labelKey: TranslationKey;
  value: string;
} {
  const summary = workflow.documentUnderstanding;
  const customer = summary?.customer ?? item.recognizedData.Kunde;
  const site = summary?.constructionSite ?? item.recognizedData.Baustelle ?? item.vorgangTitle;

  if (!isUnknown(customer)) {
    return { labelKey: 'reviewWorkflow.hero.customer', value: customer!.trim() };
  }
  if (!isUnknown(site)) {
    return { labelKey: 'reviewWorkflow.hero.site', value: site!.trim() };
  }
  if (
    !isUnknown(item.sender) &&
    item.sender !== 'Absender nicht eindeutig erkannt.' &&
    item.sender !== 'Unbekannter Absender'
  ) {
    return { labelKey: 'reviewWorkflow.hero.sender', value: item.sender.trim() };
  }

  return { labelKey: 'reviewWorkflow.hero.unknown', value: '' };
}

export function buildDocumentReviewHero(
  item: InboxItem,
  workflow: WorkflowResult,
): DocumentReviewHeroView {
  const classifiedKind = workflow.classifiedKind;
  const context = resolveContext(item, workflow);

  return {
    documentTypeKey: `classifiedKind.${classifiedKind}` as TranslationKey,
    contextLabelKey: context.labelKey,
    contextValue: context.value,
    introKey: item.isAdvertisement
      ? 'reviewWorkflow.hero.introAdvertisement'
      : workflow.companyRelevant
        ? 'reviewWorkflow.hero.intro'
        : 'reviewWorkflow.hero.introLimited',
  };
}

const AI_ACTION_LABEL_MAP: Partial<Record<DocumentAiAction['id'], TranslationKey>> = {
  create_order: 'reviewWorkflow.recommend.createOrder',
  write_invoice: 'reviewWorkflow.recommend.writeInvoice',
  monitor_deadline: 'reviewWorkflow.recommend.monitorDeadline',
  archive_document: 'reviewWorkflow.recommend.archive',
  paper_folder: 'reviewWorkflow.recommend.paperFolder',
  tax_advisor_relevant: 'reviewWorkflow.recommend.taxAdvisor',
};

export function buildDocumentReviewRecommendations(
  item: InboxItem,
  workflow: WorkflowResult,
): DocumentReviewRecommendationView[] {
  const recommendations: DocumentReviewRecommendationView[] = [];
  const seen = new Set<string>();

  const push = (id: string, labelKey: TranslationKey) => {
    if (seen.has(labelKey)) return;
    seen.add(labelKey);
    recommendations.push({ id, labelKey });
  };

  if (item.isAdvertisement) {
    push('dispose', 'reviewWorkflow.recommend.dispose');
    push('save', 'reviewWorkflow.recommend.saveAnyway');
    return recommendations.slice(0, MAX_REVIEW_RECOMMENDATIONS);
  }

  for (const action of workflow.documentAiActions) {
    const labelKey = AI_ACTION_LABEL_MAP[action.id];
    if (labelKey) push(action.id, labelKey);
  }

  if (item.paperFiling?.label) {
    push(
      'paper-register',
      'reviewWorkflow.recommend.paperRegister',
    );
  }

  if (!item.vorgangId && workflow.suggestedVorgang) {
    push('link-vorgang', 'reviewWorkflow.recommend.linkVorgang');
  }

  if (workflow.suggestedOrderPositions.length > 0) {
    push('import-positions', 'reviewWorkflow.recommend.importPositions');
  }

  if (workflow.suggestedTasks.length > 0) {
    push('accept-tasks', 'reviewWorkflow.recommend.acceptTasks');
  }

  if (recommendations.length === 0) {
    push('review', 'reviewWorkflow.recommend.reviewDocument');
  }

  return recommendations.slice(0, MAX_REVIEW_RECOMMENDATIONS);
}

export function buildDocumentReviewChecks(
  item: InboxItem,
  workflow: WorkflowResult,
): DocumentReviewCheckView[] {
  const checks: DocumentReviewCheckView[] = [];
  const summary = workflow.documentUnderstanding;

  if (item.isAdvertisement) {
    checks.push({ id: 'advertisement', labelKey: 'reviewWorkflow.check.advertisement' });
    return checks;
  }

  if (!workflow.companyRelevant && !item.markedAsCompanyDocument) {
    checks.push({ id: 'company', labelKey: 'reviewWorkflow.check.confirmCompany' });
  }

  if (summary?.partialRecognition) {
    checks.push({ id: 'partial-text', labelKey: 'reviewWorkflow.check.partialText' });
  }

  const presentationContext = buildPresentationContext(
    item,
    summary,
    workflow.classifiedKind,
  );
  for (const check of buildPresentationChecks(presentationContext)) {
    checks.push(check);
  }

  if (!item.vorgangId && workflow.suggestedVorgang) {
    checks.push({ id: 'vorgang', labelKey: 'reviewWorkflow.check.selectVorgang' });
  }

  if (workflow.contractAnalysis?.isContract && !summary?.date && !item.recognizedData.Datum) {
    checks.push({ id: 'contract-date', labelKey: 'reviewWorkflow.check.contractDate' });
  }

  return checks;
}

export function isDocumentReviewComplete(checks: DocumentReviewCheckView[]): boolean {
  return checks.length === 0;
}

const SUCCESS_STEP_LABELS: Partial<Record<string, TranslationKey>> = {
  archive_document: 'reviewWorkflow.success.archived',
  create_vorgang: 'reviewWorkflow.success.orderCreated',
  link_vorgang: 'reviewWorkflow.success.linkedVorgang',
  import_positions: 'reviewWorkflow.success.positionsImported',
  accept_tasks: 'reviewWorkflow.success.tasksAccepted',
  apply_contract_fields: 'reviewWorkflow.success.contractApplied',
  finalize_inbox: 'reviewWorkflow.success.completed',
};

export function buildDocumentReviewSuccessSteps(
  execution: WorkflowResultExecution,
): DocumentReviewSuccessStepView[] {
  const steps: DocumentReviewSuccessStepView[] = [];

  for (const step of execution.successSteps) {
    const labelKey = SUCCESS_STEP_LABELS[step];
    if (labelKey) {
      steps.push({ id: step, labelKey });
    }
  }

  return steps;
}

export function buildPaperRegisterHint(item: InboxItem): string | undefined {
  if (!item.paperFiling) return undefined;
  return formatPaperFilingInstruction(item.paperFiling);
}
