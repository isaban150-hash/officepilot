import type { EnhancedDetectedOrderPosition } from '../types/documentIntelligence';
import { checkCompanyRelevanceFromInbox, isDocumentAnalysisAllowed } from './companyRelevanceService';
import {
  buildUnderstandingFromItem,
} from './documentIntakeUnderstandingService';
import { analyzeContractFromInbox } from './contractAnalysisService';
import {
  analyzeContractIntelligenceFromInbox,
  buildContractOrderProposal,
} from './contractIntelligenceService';
import {
  getClassificationForItem,
  getSuggestedVorgangForItem,
} from './documentClassificationService';
import { resolvePrimaryTargetForInboxItem } from './documentPrimaryTargetResolver';
import { getCompanyProfile } from './companyProfileService';
import { getInboxItemById } from './inboxService';
import { getCachedSetup } from './persistenceService';
import {
  getLetterExplanation,
  isExplainableLetter,
} from './letterExplanationService';
import { buildOrderPositionsFromInbox, parseOfferAmount } from './orderPositionFactory';
import {
  buildPositionImportKey,
  computeContractPositionsTotal,
  formatDetectedPositionDescription,
  isResolvedUnit,
  resolveOrderUnit,
} from './orderUnitMapper';
import {
  buildDedupeKey,
  proposePrimaryInboxTask,
  proposeTasksFromClassification,
  proposeTasksFromContract,
  createTasksFromProposals,
} from './taskEngineService';
import { interpretBusinessFromWorkflow } from './businessInterpretationService';
import { commitDocumentWorkResultFromAnalysis } from './documentWorkResultService';
import { buildWorkflowDecisionForInboxItem } from './workflowDecisionService';
import { assertContractPlanMutable } from './orderPlanIntegrityService';
import {
  appendOrderPositionsBulk,
  buildVorgangDraftFromInbox,
  createVorgangFromInbox,
  findSimilarVorgaenge,
  getVorgangById,
  linkInboxToExistingVorgang,
} from './vorgangService';
import { resolveDraftTruthOverrides } from './vorgangMatchingService';
import {
  resolvePrimaryTargetObjectForDocumentType,
  resolvePrimaryTargetObjectForKind,
} from './documentPrimaryTargetService';
import type { PrimaryTargetWorkflowAction } from './documentPrimaryTargetResolver';
import type {
  AnalysisConfidence,
  DetectedOrderPosition,
  DocumentClassificationResult,
  InboxItem,
  MaterialStandard,
  OrderPositionInput,
  Task,
  TaskProposal,
  Vorgang,
  VorgangDraft,
  WorkflowLetterSummary,
  WorkflowNextAction,
  WorkflowResult,
  WorkflowWarning,
} from '../types/models';

type WorkflowResultCore = Omit<WorkflowResult, 'businessInterpretation'>;

function withBusinessInterpretation(
  item: InboxItem,
  core: WorkflowResultCore,
): WorkflowResult {
  const linkedId = item.vorgangId ?? core.suggestedVorgang?.vorgangId ?? null;
  const linkedVorgang = linkedId ? getVorgangById(linkedId) ?? null : null;
  let result: WorkflowResult;
  try {
    result = {
      ...core,
      businessInterpretation: interpretBusinessFromWorkflow({
        item,
        workflow: core,
        linkedVorgang,
      }),
    };
  } catch (error) {
    // Read-only coordination must never abort intake specialists / WorkflowResult.
    console.warn('[businessInterpretation] interpretBusinessFromWorkflow failed', error);
    result = {
      ...core,
      businessInterpretation: null,
      warnings: [
        ...core.warnings,
        {
          id: 'business_interpretation_failed',
          message:
            'Betriebliche Koordination konnte nicht berechnet werden. Fachliche Spezialistenergebnisse bleiben verfügbar.',
        },
      ],
    };
  }

  const resultWithDecision = {
    ...result,
    workflowDecision: buildWorkflowDecisionForInboxItem(item, result),
  };

  try {
    // Successful analysis: merge + upsert + durable flush (DOCUMENT-WORK-RESULT-PERSISTENCE-01).
    // Unusable / failed projections keep a previous valid DWR; persist failure rolls back.
    commitDocumentWorkResultFromAnalysis(resultWithDecision, item);
  } catch (error) {
    // Snapshot commit must never abort the analysis return path.
    console.warn('[documentWorkResult] commit after analysis failed', error);
  }
  return resultWithDecision;
  return result;
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
    legalDisclaimer: explanation.legalDisclaimerKey,
    disclaimer: explanation.disclaimer,
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
    primaryTargetAction: PrimaryTargetWorkflowAction;
    suggestedVorgang: WorkflowResult['suggestedVorgang'];
    suggestedOrderPositions: DetectedOrderPosition[];
    suggestedTasks: TaskProposal[];
    contractAnalysis: WorkflowResult['contractAnalysis'];
    classification: DocumentClassificationResult | null;
  },
): WorkflowNextAction[] {
  const actions: WorkflowNextAction[] = [];
  const primaryTarget = input.classification?.classifiedKind
    ? resolvePrimaryTargetObjectForKind(input.classification.classifiedKind)
    : resolvePrimaryTargetObjectForDocumentType(item.documentType);

  if (!item.importedToArchive && input.companyRelevant) {
    actions.push({
      id: 'archive_document',
      labelKey: 'intake.action.archive',
      enabled: true,
    });
  }

  if (input.primaryTargetAction === 'link_vorgang' && input.suggestedVorgang && !item.vorgangId) {
    actions.push({
      id: 'link_vorgang',
      labelKey: 'intake.action.linkVorgang',
      enabled: true,
    });
  }

  if (input.primaryTargetAction === 'select_vorgang' && !item.vorgangId) {
    actions.push({
      id: 'select_vorgang',
      labelKey: 'vorgangIntelligence.action.select',
      enabled: true,
    });
  }

  const canCreateVorgang =
    !item.vorgangId &&
    input.companyRelevant &&
    input.primaryTargetAction === 'create_vorgang' &&
    (input.contractAnalysis?.isContract ||
      primaryTarget === 'vorgang');

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
    // Display-only: structured contracts stay reviewable; never auto-execute.
    const contractIntelligence = analyzeContractIntelligenceFromInbox(item);
    const contractOrderProposal = buildContractOrderProposal(item, contractIntelligence);

    if (!contractOrderProposal) {
      return withBusinessInterpretation(item, {
        inboxItemId,
        companyRelevant: false,
        companyRelevance,
        classifiedKind: item.classifiedKind ?? 'sonstiges',
        classificationConfidence: 'low',
        classification: null,
        documentExplanation: null,
        documentUnderstanding: null,
        documentAiActions: [],
        contractAnalysis: null,
        contractIntelligence: null,
        contractOrderProposal: null,
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
      });
    }

    return withBusinessInterpretation(item, {
      inboxItemId,
      companyRelevant: false,
      companyRelevance,
      classifiedKind:
        contractIntelligence?.classifiedKind ?? item.classifiedKind ?? 'sonstiges',
      classificationConfidence: 'low',
      classification: null,
      documentExplanation: null,
      documentUnderstanding: null,
      documentAiActions: [],
      contractAnalysis: null,
      contractIntelligence,
      contractOrderProposal,
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
    });
  }

  const classification = getClassificationForItem(item);
  const documentExplanation =
    isExplainableLetter(item) && getLetterExplanation(item)
      ? mapLetterExplanation(getLetterExplanation(item)!)
      : null;
  const contractAnalysis = analyzeContractFromInbox(item);
  // Intelligence once — proposal reuses the same result (no second BOQ/JSON pass).
  const contractIntelligence = analyzeContractIntelligenceFromInbox(item);
  const contractOrderProposal = buildContractOrderProposal(item, contractIntelligence);
  const primaryTarget = resolvePrimaryTargetForInboxItem(item);
  let suggestedVorgang = primaryTarget.suggestedVorgang;
  // Legacy heuristic remains only as fallback when no usable case match exists.
  if (!primaryTarget.hasUsableCaseMatch) {
    suggestedVorgang = getSuggestedVorgangForItem(item) ?? classification.suggestedVorgang ?? null;
  }
  const materialDefault = getCachedSetup()?.materialStandard ?? 'unclear';
  const truthOverrides = resolveDraftTruthOverrides(item);
  const draft = buildVorgangDraftFromInbox(item, materialDefault, truthOverrides);
  const similarVorgaenge = findSimilarVorgaenge(draft);
  let suggestedOrderPositions = resolveSuggestedPositions(item, contractAnalysis);
  if (contractIntelligence?.positions.length) {
    suggestedOrderPositions = contractIntelligence.positions.map(
      ({ sourcePage: _s, confidence: _c, reviewStatus: _r, ...position }) => position,
    );
  }
  const suggestedTasks = collectSuggestedTasks(item, contractAnalysis);
  const requiredDocuments = contractAnalysis.isContract ? contractAnalysis.requiredDocuments : [];
  const warnings = buildWarnings(item, true, classification);
  const understanding = buildUnderstandingFromItem(
    item,
    classification,
    contractIntelligence,
  );
  const resolvedKind =
    contractIntelligence?.classifiedKind && contractIntelligence.positions.length > 0
      ? contractIntelligence.classifiedKind
      : classification.classifiedKind;

  return withBusinessInterpretation(item, {
    inboxItemId,
    companyRelevant: true,
    companyRelevance,
    classifiedKind: resolvedKind,
    classificationConfidence: inferClassificationConfidence(classification),
    classification,
    documentExplanation,
    documentUnderstanding: understanding.summary,
    documentAiActions: understanding.actions,
    contractAnalysis: contractAnalysis.isContract ? contractAnalysis : null,
    contractIntelligence,
    contractOrderProposal,
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
      primaryTargetAction: primaryTarget.action,
      suggestedVorgang,
      suggestedOrderPositions,
      suggestedTasks,
      contractAnalysis: contractAnalysis.isContract ? contractAnalysis : null,
      classification,
    }),
  });
}

export function acceptSuggestedTasks(proposals: TaskProposal[]): Task[] {
  if (proposals.length === 0) return [];
  return createTasksFromProposals(proposals);
}

export function getContractPreviewForInbox(item: InboxItem): {
  positions: DetectedOrderPosition[];
  positionCount: number;
  contractSum: number;
  hasContractPositions: boolean;
} {
  const intelligence = analyzeContractIntelligenceFromInbox(item);
  if (intelligence && intelligence.positions.length > 0) {
    // Keep reviewStatus/confidence/sourcePage for confirm-first selection defaults.
    const positions = intelligence.positions;
    const contractSum =
      intelligence.contractTotalNet?.value ?? computeContractPositionsTotal(positions);
    return {
      positions,
      positionCount: positions.length,
      contractSum,
      hasContractPositions: true,
    };
  }

  const contractAnalysis = analyzeContractFromInbox(item);
  const positions =
    contractAnalysis.isContract && contractAnalysis.positions.length > 0
      ? contractAnalysis.positions
      : [];
  const contractSum =
    positions.length > 0
      ? computeContractPositionsTotal(positions)
      : parseOfferAmount(item.recognizedData.Angebotssumme);

  return {
    positions,
    positionCount: positions.length,
    contractSum,
    hasContractPositions: positions.length > 0,
  };
}

/**
 * Light skip signal — never re-runs contract intelligence / pageTexts / BOQ.
 * Confirmed positions or existing contract metadata are enough.
 */
function shouldSkipDefaultPositionsForContractCreate(
  item: InboxItem,
  confirmedPositions?: DetectedOrderPosition[],
): boolean {
  if (confirmedPositions && confirmedPositions.length > 0) return true;
  const kind = item.classifiedKind;
  if (kind === 'werkvertrag' || kind === 'subunternehmervertrag') return true;
  const dokumentart = item.recognizedData.Dokumentart;
  if (dokumentart === 'werkvertrag' || dokumentart === 'subunternehmervertrag') return true;
  const vertragstext = item.recognizedData._vertragstext;
  return typeof vertragstext === 'string' && vertragstext.trim().length > 0;
}

export function createVorgangFromInboxWithContract(
  item: InboxItem,
  optionalDraft?: Partial<VorgangDraft>,
  materialDefault: MaterialStandard = 'unclear',
  options?: { confirmedPositions?: DetectedOrderPosition[] },
): { vorgang: Vorgang; inbox: InboxItem } | null {
  const confirmed = options?.confirmedPositions;
  const truthOverrides = resolveDraftTruthOverrides(item);
  const effectiveOptionalDraft = truthOverrides
    ? { ...optionalDraft, ...truthOverrides }
    : optionalDraft;
  const result = createVorgangFromInbox(item, effectiveOptionalDraft, materialDefault, {
    skipDefaultPositions: shouldSkipDefaultPositionsForContractCreate(item, confirmed),
  });
  if (!result) return null;

  if (confirmed && confirmed.length > 0) {
    importSuggestedPositionsToVorgang(result.vorgang.id, confirmed);
    const refreshed = getVorgangById(result.vorgang.id);
    if (refreshed) {
      return { vorgang: refreshed, inbox: result.inbox };
    }
  }

  return result;
}

/**
 * Positions whose document unit could not be mapped onto a billable unit.
 *
 * Checks the authoritative signals, not just the possibly already normalized
 * `unit`: a position may carry `unit: 'Stück'` from an older mapping while
 * `rawUnit` still says "kg". Any of the three signals blocks.
 */
export function findUnresolvedUnitPositions(
  positions: Array<DetectedOrderPosition | EnhancedDetectedOrderPosition>,
): Array<{ positionNumber?: string; description: string; rawUnit: string }> {
  const unresolved: Array<{ positionNumber?: string; description: string; rawUnit: string }> = [];

  for (const position of positions) {
    const enhanced = position as Partial<EnhancedDetectedOrderPosition>;
    const rawUnit = enhanced.rawUnit ?? position.unit;
    const flaggedByReason = (enhanced.reviewReasons ?? []).some(
      (reason) => reason === 'unit_unknown' || reason === 'unit_ambiguous',
    );
    const unresolvedRaw = !isResolvedUnit(resolveOrderUnit(rawUnit));
    const unresolvedUnit = !isResolvedUnit(resolveOrderUnit(position.unit));

    if (flaggedByReason || unresolvedRaw || unresolvedUnit) {
      unresolved.push({
        positionNumber: position.positionNumber,
        description: position.description,
        rawUnit,
      });
    }
  }

  return unresolved;
}

export function importSuggestedPositionsToVorgang(
  vorgangId: string,
  positions: DetectedOrderPosition[],
): {
  success: boolean;
  added: number;
  skipped: number;
  errorKey?: string;
  unresolvedUnits?: Array<{ positionNumber?: string; description: string; rawUnit: string }>;
} {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { success: false, added: 0, skipped: 0 };
  }

  // Early UX check — authoritative lock is appendOrderPositionsBulk / integrity service.
  const planLock = assertContractPlanMutable(vorgang);
  if (!planLock.ok) {
    return {
      success: false,
      added: 0,
      skipped: positions.length,
      errorKey: planLock.errorKey,
    };
  }

  // Checked before any mutation: an unresolved unit must never be stored as
  // Stück, and a mixed batch must not import its clean neighbours either.
  const unresolvedUnits = findUnresolvedUnitPositions(positions);
  if (unresolvedUnits.length > 0) {
    return {
      success: false,
      added: 0,
      skipped: positions.length,
      errorKey: 'position.unitUnresolved',
      unresolvedUnits,
    };
  }

  const existingKeys = new Set(
    (vorgang.orderPositions ?? []).map((position) => {
      const match = position.description.match(/^(\d+)\s*[–-]\s*/);
      if (match) {
        return `pos:${match[1]!.toLowerCase()}`;
      }
      return `desc:${position.description.trim().toLowerCase()}`;
    }),
  );

  const toAppend: OrderPositionInput[] = [];
  let skipped = 0;

  for (const position of positions) {
    const importKey = buildPositionImportKey(position);
    if (!position.description.trim() || existingKeys.has(importKey)) {
      skipped += 1;
      continue;
    }

    const resolvedUnit = resolveOrderUnit(position.unit);
    if (!isResolvedUnit(resolvedUnit)) continue;
    toAppend.push({
      description: formatDetectedPositionDescription(position),
      plannedQuantity: position.quantity,
      unit: resolvedUnit.unit,
      unitLabel: resolvedUnit.unitLabel,
      unitPrice: position.unitPrice,
      category: 'arbeit',
      billable: true,
    });
    existingKeys.add(importKey);
  }

  if (toAppend.length === 0) {
    return { success: skipped > 0, added: 0, skipped };
  }

  const bulk = appendOrderPositionsBulk(vorgangId, toAppend);
  return {
    success: bulk.success || skipped > 0,
    added: bulk.added,
    skipped: skipped + bulk.skipped,
    errorKey: bulk.errorKey,
  };
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
  return createVorgangFromInboxWithContract(item, undefined, materialDefault);
}
