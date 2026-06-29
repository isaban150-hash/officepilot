import { checkCompanyRelevanceFromInbox, isDocumentAnalysisAllowed } from './companyRelevanceService';
import { analyzeContractFromInbox } from './contractAnalysisService';
import {
  getClassificationForItem,
  getSuggestedVorgangForItem,
} from './documentClassificationService';
import { getCompanyProfile } from './companyProfileService';
import { getInboxItemById } from './inboxService';
import { getCachedSetup } from './persistenceService';
import {
  getLetterExplanation,
  isExplainableLetter,
} from './letterExplanationService';
import { buildOrderPositionsFromInbox } from './orderPositionFactory';
import {
  buildDedupeKey,
  proposePrimaryInboxTask,
  proposeTasksFromClassification,
  proposeTasksFromContract,
  createTasksFromProposals,
} from './taskEngineService';
import {
  addOrderPosition,
  buildVorgangDraftFromInbox,
  createVorgangFromInbox,
  findSimilarVorgaenge,
  getVorgangById,
  linkInboxToExistingVorgang,
} from './vorgangService';
import type {
  AnalysisConfidence,
  DetectedOrderPosition,
  DocumentClassificationResult,
  InboxItem,
  MaterialStandard,
  Task,
  OrderUnit,
  TaskProposal,
  Vorgang,
  WorkflowLetterSummary,
  WorkflowNextAction,
  WorkflowResult,
  WorkflowWarning,
} from '../types/models';

function mapDetectedUnit(unit: string): OrderUnit {
  const normalized = unit.trim().toLowerCase();
  if (normalized.includes('m²') || normalized === 'm2') return 'm²';
  if (normalized.includes('stunde') || normalized === 'h') return 'Stunden';
  if (normalized.includes('pausch')) return 'Pauschal';
  if (normalized.includes('meter') || normalized === 'm') return 'Meter';
  return 'Stück';
}

function inferClassificationConfidence(
  classification: DocumentClassificationResult,
): AnalysisConfidence {
  if (classification.suggestedVorgang?.confidence === 'high') return 'high';
  const key = classification.detectionReasonKey;
  if (key.includes('explicit') || key.includes('filename') || key.includes('uploadHint')) {
    return 'high';
  }
  if (key.includes('keyword') || key.includes('hint')) return 'medium';
  return 'low';
}

function mapLetterExplanation(
  explanation: NonNullable<ReturnType<typeof getLetterExplanation>>,
): WorkflowLetterSummary {
  return {
    kind: explanation.kind,
    about: explanation.about,
    importance: explanation.importance,
    deadline: explanation.deadline,
    nextSteps: explanation.nextSteps,
    digitalStorage: explanation.digitalStorage,
    paperStorage: explanation.paperStorage,
  };
}

function resolveSuggestedPositions(
  item: InboxItem,
  contractAnalysis: WorkflowResult['contractAnalysis'],
): DetectedOrderPosition[] {
  if (contractAnalysis?.isContract && contractAnalysis.positions.length > 0) {
    return contractAnalysis.positions;
  }

  return buildOrderPositionsFromInbox(item).map((position) => ({
    description: position.description,
    unit: position.unit,
    quantity: position.plannedQuantity,
    unitPrice: position.unitPrice,
    lineTotal: position.plannedQuantity * position.unitPrice,
  }));
}

function collectSuggestedTasks(
  item: InboxItem,
  contractAnalysis: WorkflowResult['contractAnalysis'],
): TaskProposal[] {
  const profile = getCompanyProfile();
  if (!isDocumentAnalysisAllowed(item, profile)) return [];

  const proposals: TaskProposal[] = [];
  const seen = new Set<string>();

  const push = (proposal: TaskProposal) => {
    const key = proposal.dedupeKey ?? buildDedupeKey(proposal);
    if (seen.has(key)) return;
    seen.add(key);
    proposals.push({ ...proposal, dedupeKey: key });
  };

  proposeTasksFromClassification(item, profile).forEach(push);

  const primary = proposePrimaryInboxTask(item, profile);
  if (primary) push(primary);

  if (contractAnalysis?.isContract) {
    proposeTasksFromContract(contractAnalysis, item.id).forEach(push);
  }

  return proposals;
}

function buildWarnings(
  item: InboxItem,
  companyRelevant: boolean,
  classification: DocumentClassificationResult | null,
): WorkflowWarning[] {
  const warnings: WorkflowWarning[] = [];

  if (!companyRelevant) {
    warnings.push({
      id: 'company_relevance_blocked',
      message: 'Kein automatischer Firmenbezug erkannt. Analyse und Vorschläge sind eingeschränkt.',
    });
  }

  if (item.isAdvertisement) {
    warnings.push({
      id: 'advertisement',
      message: 'Werbung erkannt – bitte manuell entscheiden, ob gespeichert werden soll.',
    });
  }

  if (classification?.isAdvertisement) {
    warnings.push({
      id: 'classification_advertisement',
      message: 'Dokument wurde als Werbung eingestuft.',
    });
  }

  return warnings;
}

function buildNextActions(
  item: InboxItem,
  input: {
    companyRelevant: boolean;
    suggestedVorgang: WorkflowResult['suggestedVorgang'];
    suggestedOrderPositions: DetectedOrderPosition[];
    suggestedTasks: TaskProposal[];
    contractAnalysis: WorkflowResult['contractAnalysis'];
    classification: DocumentClassificationResult | null;
  },
): WorkflowNextAction[] {
  const actions: WorkflowNextAction[] = [];

  if (!item.importedToArchive && input.companyRelevant) {
    actions.push({
      id: 'archive_document',
      labelKey: 'intake.action.archive',
      enabled: true,
    });
  }

  if (input.suggestedVorgang && !item.vorgangId) {
    actions.push({
      id: 'link_vorgang',
      labelKey: 'intake.action.linkVorgang',
      enabled: true,
    });
  }

  const canCreateVorgang =
    !item.vorgangId &&
    input.companyRelevant &&
    (input.contractAnalysis?.isContract ||
      input.classification?.processType === 'create_vorgang' ||
      item.documentType === 'kundenauftrag');

  if (canCreateVorgang) {
    actions.push({
      id: 'create_vorgang',
      labelKey: 'intake.action.createVorgang',
      enabled: true,
    });
  }

  if (input.suggestedOrderPositions.length > 0) {
    actions.push({
      id: 'import_positions',
      labelKey: 'intake.action.importPositions',
      enabled: Boolean(item.vorgangId || input.suggestedVorgang),
    });
  }

  if (input.suggestedTasks.length > 0) {
    actions.push({
      id: 'accept_tasks',
      labelKey: 'intake.action.acceptTasks',
      enabled: true,
    });
  }

  actions.push({
    id: 'cancel',
    labelKey: 'intake.action.cancel',
    enabled: true,
  });

  return actions;
}

export function processUploadedDocument(
  inboxItemId: string,
): WorkflowResult | null {
  const item = getInboxItemById(inboxItemId);
  if (!item) return null;

  const profile = getCompanyProfile();
  const companyRelevance = checkCompanyRelevanceFromInbox(item, profile);
  const companyRelevant = isDocumentAnalysisAllowed(item, profile);

  if (!companyRelevant) {
    return {
      inboxItemId,
      companyRelevant: false,
      companyRelevance,
      classifiedKind: item.classifiedKind ?? 'sonstiges',
      classificationConfidence: 'low',
      classification: null,
      documentExplanation: null,
      contractAnalysis: null,
      suggestedVorgang: null,
      similarVorgaenge: [],
      suggestedOrderPositions: [],
      suggestedTasks: [],
      suggestedArchiveFolder: item.digitalFolder,
      requiredDocuments: [],
      pendingSummary: null,
      warnings: buildWarnings(item, false, null),
      nextActions: [
        {
          id: 'cancel',
          labelKey: 'intake.action.cancel',
          enabled: true,
        },
      ],
    };
  }

  const classification = getClassificationForItem(item);
  const documentExplanation =
    isExplainableLetter(item) && getLetterExplanation(item)
      ? mapLetterExplanation(getLetterExplanation(item)!)
      : null;
  const contractAnalysis = analyzeContractFromInbox(item);
  const suggestedVorgang = getSuggestedVorgangForItem(item) ?? classification.suggestedVorgang ?? null;
  const materialDefault = getCachedSetup()?.materialStandard ?? 'unclear';
  const draft = buildVorgangDraftFromInbox(item, materialDefault);
  const similarVorgaenge = findSimilarVorgaenge(draft);
  const suggestedOrderPositions = resolveSuggestedPositions(item, contractAnalysis);
  const suggestedTasks = collectSuggestedTasks(item, contractAnalysis);
  const requiredDocuments = contractAnalysis.isContract ? contractAnalysis.requiredDocuments : [];
  const warnings = buildWarnings(item, true, classification);

  return {
    inboxItemId,
    companyRelevant: true,
    companyRelevance,
    classifiedKind: classification.classifiedKind,
    classificationConfidence: inferClassificationConfidence(classification),
    classification,
    documentExplanation,
    contractAnalysis: contractAnalysis.isContract ? contractAnalysis : null,
    suggestedVorgang,
    similarVorgaenge,
    suggestedOrderPositions,
    suggestedTasks,
    suggestedArchiveFolder: classification.digitalFolder,
    requiredDocuments,
    pendingSummary: null,
    warnings,
    nextActions: buildNextActions(item, {
      companyRelevant: true,
      suggestedVorgang,
      suggestedOrderPositions,
      suggestedTasks,
      contractAnalysis: contractAnalysis.isContract ? contractAnalysis : null,
      classification,
    }),
  };
}

export function acceptSuggestedTasks(proposals: TaskProposal[]): Task[] {
  if (proposals.length === 0) return [];
  return createTasksFromProposals(proposals);
}

export function importSuggestedPositionsToVorgang(
  vorgangId: string,
  positions: DetectedOrderPosition[],
): { success: boolean; added: number; skipped: number } {
  const vorgang = getVorgangById(vorgangId);
  const existingDescriptions = new Set(
    (vorgang?.orderPositions ?? []).map((position) => position.description.trim().toLowerCase()),
  );
  let added = 0;
  let skipped = 0;

  for (const position of positions) {
    const descriptionKey = position.description.trim().toLowerCase();
    if (!descriptionKey || existingDescriptions.has(descriptionKey)) {
      skipped += 1;
      continue;
    }

    const result = addOrderPosition(vorgangId, {
      description: position.description,
      plannedQuantity: position.quantity,
      unit: mapDetectedUnit(position.unit),
      unitPrice: position.unitPrice,
      category: 'arbeit',
      billable: true,
    });
    if (result.success) {
      added += 1;
      existingDescriptions.add(descriptionKey);
    }
  }

  return { success: added > 0, added, skipped };
}

export function linkWorkflowVorgang(
  item: InboxItem,
  vorgangId: string,
): { vorgang: Vorgang; inbox: InboxItem } | null {
  return linkInboxToExistingVorgang(item, vorgangId);
}

export function createWorkflowVorgang(
  item: InboxItem,
  materialDefault: MaterialStandard = 'unclear',
): { vorgang: Vorgang; inbox: InboxItem } | null {
  return createVorgangFromInbox(item, undefined, materialDefault);
}
