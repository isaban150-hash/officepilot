import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { shouldRevealArchiveImportFromState } from './eingangDetailNavigation';
import { DocumentGuidancePanel } from '../components/documents/DocumentGuidancePanel';
import { DocumentOriginalFilePanel } from '../components/documents/DocumentOriginalFilePanel';
import { buildDocumentGuidance } from '../services/documentGuidanceService';
import { CompanyRelevancePanel } from '../components/inbox/CompanyRelevancePanel';
import { ContractAnalysisPanel } from '../components/inbox/ContractAnalysisPanel';
import { DocumentActionSuggestionsPanel } from '../components/inbox/DocumentActionSuggestionsPanel';
import { ImportToArchiveDialog } from '../components/inbox/ImportToArchiveDialog';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import {
  CustomerDecisionChoice,
  type CustomerDecisionMode,
} from '../components/customer/CustomerDecisionChoice';
import {
  buildCustomerDecisionFromUi,
  buildCustomerExtraFromParty,
  buildCustomerInputFromUi,
  createEmptyCustomerExtraFields,
  isCustomerDecisionIncomplete,
  loadSelectableCustomers,
  resolveNewCustomerHintKey,
  type CustomerExtraFields,
} from '../components/customer/customerDecisionUi';
import { resolveCounterpartyFromWorkflow } from '../services/businessInterpretationFacts';
import type { BusinessStructuredParty } from '../types/businessInterpretation';
import { getCustomerById } from '../services/customerStoreService';
import {
  clearCustomerAssignmentDraft,
  matchCustomerAssignmentDraft,
  readCustomerAssignmentDraft,
  writeCustomerAssignmentDraft,
} from '../services/storage/customerAssignmentDraftService';
import type { CustomerDecision } from '../services/customerService';
import type { Customer } from '../types/models';
import { LetterExplanationPanel } from '../components/inbox/LetterExplanationPanel';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { INBOX_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { SmartIntakeSummary } from '../components/inbox/SmartIntakeSummary';
import { DocumentFreeQuestionPanel } from '../components/documents/DocumentFreeQuestionPanel';
import { DocumentFieldFillConfirmPanel } from '../components/documents/DocumentFieldFillConfirmPanel';
import { DocumentFilingDecisionPanel } from '../components/documents/DocumentFilingDecisionPanel';
import { DocumentConfirmedReplyDraftPanel } from '../components/documents/DocumentConfirmedReplyDraftPanel';
import { DocumentContextualNextStepsPanel } from '../components/documents/DocumentContextualNextStepsPanel';
import { buildKommunikationPath } from '../components/communication/communicationNavigation';
import { buildDocumentFieldFillConfirmViewModel } from '../services/documentFieldFillConfirmService';
import { applyStoredOverlayToFillConfirmRows } from '../services/documentFieldFillConfirmTruthBridge';
import { isConfirmedReplyDraftSupported } from '../services/documentConfirmedReplyDraftService';
import { createDocumentReplyDraftHandoffLocationState } from '../services/documentReplyDraftHandoffService';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { DocumentFieldFillFreeTextBridgeProposal } from '../types/documentFieldFillFreeTextBridge';
import { CollapsibleReviewSection } from '../components/inbox/review/CollapsibleReviewSection';
import { DocumentReviewExperience } from '../components/inbox/review/DocumentReviewExperience';
import { DocumentFinanceReferencePanel } from '../components/inbox/DocumentFinanceReferencePanel';
import {
  confirmDocumentFinanceReference,
  isFinanceReferenceOnlyKind,
  resolveDocumentFinanceReference,
} from '../services/documentFinanceReferenceService';
import {
  createEditDraftFromItem,
  InboxItemEditForm,
  type InboxEditDraft,
} from '../components/inbox/InboxItemEditForm';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow } from '../components/ui/Card';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { useApp } from '../context/AppContext';
import { localizeStoredUserText } from '../i18n/resolveStoredText';
import { formatInboxActionToast } from '../utils/inboxActionToast';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import {
  FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE,
  isDocumentFilingDecisionConfirmed,
} from '../services/documentFilingDecisionService';
import {
  getLetterExplanation,
  letterExplanationFromWorkflow,
} from '../services/letterExplanationService';
import { getInboxExtractedDocumentText } from '../services/inboxDocumentText';
import { isClassificationKindWithTasks } from '../services/taskEngineService';
import { executeSmartIntake } from '../services/intakeExecutionService';
import { getLastPersistSuccess } from '../services/persistenceService';
import {
  acceptSuggestedTasks,
  linkWorkflowVorgang,
  processUploadedDocument,
} from '../services/intakeWorkflowService';
import {
  buildDefaultContractPositionSelections,
  confirmImportContractPositions,
  countSelectedContractPositions,
} from '../services/contractPositionImportService';
import { acceptContractOrderFromProposal } from '../services/contractOrderAcceptService';
import { isContractPlanLocked } from '../services/orderPlanIntegrityService';
import { getVorgangById, unlinkInboxItemFromVorgang } from '../services/vorgangService';
import type {
  ContractOrderProposal,
  EnhancedDetectedOrderPosition,
} from '../types/documentIntelligence';
import { pickExternalCustomerName } from '../services/customerOwnCompanyGuard';
import {
  handoffInboxItemToArchive,
  isDuplicateDocument,
} from '../services/documentService';
import { resolveImportInboxDocumentOptionsFromIntakeCarry } from '../services/documentFileIntakeTransformPlanCarryContextService';
import {
  confirmDispose,
  deferItem,
  deleteInboxItem,
  getInboxItemById,
  getPriorityLabel,
  getStatusLabel,
  markInboxAsCompanyDocument,
  saveAdvertisementAnyway,
  updateInboxItemRecognizedData,
} from '../services/inboxService';
import {
  confirmFiling,
  createContractTasksForItem,
  createTaskForItem,
} from '../services/inboxTaskService';
import { recordInboxContext } from '../services/brain/companySessionService';
import {
  buildInboxWorkflowAnalysisKey,
  itemNeedsDeferredWorkflowAnalysis,
} from '../services/inboxWorkflowAnalysisKey';
import {
  buildWorkflowResultFromDocumentWorkResult,
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
} from '../services/documentWorkResultService';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import { scheduleAfterPaint } from '../services/scheduleAfterPaint';
import {
  applyOfficeActionResult,
  executeContractAction,
} from '../services/officeActionService';
import type {
  ClassifiedDocumentKind,
  CompanyDocument,
  ContractSuggestedAction,
  InboxItem,
  Vorgang,
  WorkflowResult,
  WorkflowResultExecution,
} from '../types/models';
import type { TranslationKey } from '../i18n';
import { useReportUiSession } from '../hooks/useReportUiSession';
import { useUiSessionRestore } from '../hooks/useUiSessionRestore';

type ReviewSectionId =
  | 'document-data'
  | 'ocr-text'
  | 'communication'
  | 'tasks'
  | 'positions'
  | 'archive'
  | 'further-hints'
  | 'technical';

/**
 * Shared wording for the blocked import — used by both the confirm-import and
 * the accept path so the user sees the same message with the actual raw units.
 */
export function buildUnitUnresolvedToast(
  translate: (key: TranslationKey) => string,
  unresolvedUnits?: Array<{ rawUnit: string }>,
): string {
  const units = [...new Set((unresolvedUnits ?? []).map((entry) => entry.rawUnit))].join(', ');
  return translate('position.unitUnresolved').replace('{units}', units);
}

export function mergeReviewWorkflowWithRestoredDocumentWorkResult(
  restoredWorkflow: WorkflowResult | null | undefined,
  liveWorkflow: WorkflowResult | null | undefined,
): WorkflowResult | null {
  if (!restoredWorkflow && !liveWorkflow) return null;
  if (!restoredWorkflow) return liveWorkflow ?? null;
  if (!liveWorkflow) return restoredWorkflow;

  const mergedWarnings = [
    ...(restoredWorkflow.warnings ?? []),
    ...(liveWorkflow.warnings ?? []).filter(
      (warning) => !restoredWorkflow.warnings?.some((existing) => existing.id === warning.id),
    ),
  ];

  return {
    ...restoredWorkflow,
    ...liveWorkflow,
    inboxItemId: restoredWorkflow.inboxItemId || liveWorkflow.inboxItemId,
    companyRelevant: liveWorkflow.companyRelevant ?? restoredWorkflow.companyRelevant,
    companyRelevance: liveWorkflow.companyRelevance ?? restoredWorkflow.companyRelevance,
    classifiedKind: liveWorkflow.classifiedKind ?? restoredWorkflow.classifiedKind,
    classificationConfidence: liveWorkflow.classificationConfidence ?? restoredWorkflow.classificationConfidence,
    classification: liveWorkflow.classification ?? restoredWorkflow.classification,
    documentExplanation: liveWorkflow.documentExplanation ?? restoredWorkflow.documentExplanation,
    documentUnderstanding: liveWorkflow.documentUnderstanding ?? restoredWorkflow.documentUnderstanding,
    documentAiActions: liveWorkflow.documentAiActions ?? restoredWorkflow.documentAiActions,
    contractAnalysis: liveWorkflow.contractAnalysis ?? restoredWorkflow.contractAnalysis,
    contractIntelligence: liveWorkflow.contractIntelligence ?? restoredWorkflow.contractIntelligence,
    contractOrderProposal: liveWorkflow.contractOrderProposal ?? restoredWorkflow.contractOrderProposal,
    suggestedVorgang: liveWorkflow.suggestedVorgang ?? restoredWorkflow.suggestedVorgang,
    similarVorgaenge: liveWorkflow.similarVorgaenge ?? restoredWorkflow.similarVorgaenge,
    suggestedOrderPositions: liveWorkflow.suggestedOrderPositions ?? restoredWorkflow.suggestedOrderPositions,
    suggestedTasks: liveWorkflow.suggestedTasks ?? restoredWorkflow.suggestedTasks,
    suggestedArchiveFolder: liveWorkflow.suggestedArchiveFolder ?? restoredWorkflow.suggestedArchiveFolder,
    requiredDocuments: liveWorkflow.requiredDocuments ?? restoredWorkflow.requiredDocuments,
    pendingSummary: liveWorkflow.pendingSummary ?? restoredWorkflow.pendingSummary,
    warnings: mergedWarnings,
    nextActions: liveWorkflow.nextActions ?? restoredWorkflow.nextActions,
    businessInterpretation: liveWorkflow.businessInterpretation ?? restoredWorkflow.businessInterpretation,
    workflowDecision: liveWorkflow.workflowDecision ?? restoredWorkflow.workflowDecision,
  };
}

/**
 * CUSTOMER-FACHOBJEKT-04C — value-based reset key. Pure: no state, no store.
 * Changes with any factual change of the proposal, stays stable for an
 * identically-valued proposal that was rebuilt.
 */
export function buildContractDecisionResetKey(
  inboxId: string | undefined,
  proposal: ContractOrderProposal | null | undefined,
): string {
  let fingerprint = '';
  if (proposal) {
    try {
      fingerprint = JSON.stringify(proposal);
    } catch {
      // Non-serializable proposal: fall back to a coarse but stable marker.
      fingerprint = `unserializable:${proposal.positions.length}`;
    }
  }
  return `${inboxId ?? ''}|${fingerprint}`;
}

/**
 * CUSTOMER-FACHOBJEKT-04C — name suggestion for "new customer".
 * Pure, own-company filtered, never an automatic link.
 *
 * CUSTOMER-PREFILL-NAME-HANDOFF-02D — the securely identified counterparty wins.
 * The candidate chain below is role-based: on a contract the user commissioned
 * themselves, `proposal.customer` is the own company. Name and the six address
 * fields must therefore never come from different parties.
 */
export function resolveSuggestedCustomerName(
  item: Pick<InboxItem, 'recognizedData' | 'sender'> | null | undefined,
  proposal: ContractOrderProposal | null | undefined,
  /** The counterparty the identity-based resolver settled on, when it did. */
  counterparty?: BusinessStructuredParty,
  /**
   * Only consulted without a counterparty. False for a document whose parties
   * were recognised but could not be told apart — there an empty field beats a
   * role-based guess that may well be the own company.
   */
  allowCandidateFallback = true,
): string {
  const fromCounterparty = counterparty?.name?.trim();
  if (fromCounterparty) return fromCounterparty;
  if (!allowCandidateFallback) return '';
  return pickExternalCustomerName([
    proposal?.customer,
    item?.recognizedData?.Auftraggeber,
    item?.recognizedData?.Kunde,
    item?.sender,
  ]);
}

export function EingangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup, companyProfile } = useApp();
  /*
   * Die eigene Firmenidentität kommt aus `CompanyProfile`.
   * `setup.companyName` bleibt nur ein Legacy-Spiegel und wird hier nicht mehr
   * als aktuelle Wahrheit gelesen. `setup` selbst wird weiterhin für
   * Betriebseinstellungen wie `materialStandard` gebraucht.
   */
  const ownCompanyName = companyProfile.companyName;
  const navigate = useNavigate();
  const location = useLocation();
  const [item, setItem] = useState<InboxItem | undefined>(() =>
    id ? getInboxItemById(id) : undefined,
  );
  const restoredSession = useUiSessionRestore();
  const skipIdResetRef = useRef(Boolean(restoredSession));
  const initialRevealArchive = shouldRevealArchiveImportFromState(location.state);
  const [moreOptionsExpanded, setMoreOptionsExpanded] = useState(
    () => restoredSession?.panelState.moreOptionsExpanded ?? initialRevealArchive,
  );
  const [expandedSections, setExpandedSections] = useState<Partial<Record<ReviewSectionId, boolean>>>(
    () => {
      if (restoredSession?.expandedSections?.length) {
        const next: Partial<Record<ReviewSectionId, boolean>> = {};
        for (const key of restoredSession.expandedSections) {
          next[key as ReviewSectionId] = true;
        }
        return next;
      }
      return initialRevealArchive ? { archive: true } : {};
    },
  );
  const [isEditing, setIsEditing] = useState(() => Boolean(restoredSession?.drafts.dirty));
  const [editDraft, setEditDraft] = useState<InboxEditDraft | null>(() => {
    if (!restoredSession?.drafts.dirty || !item) return null;
    const base = createEditDraftFromItem(item);
    const values = restoredSession.drafts.values;
    return {
      ...base,
      sender: typeof values.sender === 'string' ? values.sender : base.sender,
      deadline: typeof values.deadline === 'string' ? values.deadline : base.deadline,
      vorgangTitle:
        typeof values.vorgangTitle === 'string' ? values.vorgangTitle : base.vorgangTitle,
      digitalFolderPath:
        typeof values.digitalFolderPath === 'string'
          ? values.digitalFolderPath
          : base.digitalFolderPath,
      digitalFolderName:
        typeof values.digitalFolderName === 'string'
          ? values.digitalFolderName
          : base.digitalFolderName,
      paperFilingFolderId:
        typeof values.paperFilingFolderId === 'string'
          ? values.paperFilingFolderId
          : base.paperFilingFolderId,
      paperFilingRegister:
        typeof values.paperFilingRegister === 'string'
          ? values.paperFilingRegister
          : base.paperFilingRegister,
    };
  });
  const [duplicateDocument, setDuplicateDocument] = useState<CompanyDocument | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteFailureMessage, setDeleteFailureMessage] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [unlinkFailureMessage, setUnlinkFailureMessage] = useState<string | null>(null);
  const unlinkTriggerRef = useRef<HTMLButtonElement>(null);
  const [vorgangDialogRequest, setVorgangDialogRequest] = useState(0);
  // CUSTOMER-FACHOBJEKT-04C — one decision state for all three manual accept entries.
  const [customerMode, setCustomerMode] = useState<CustomerDecisionMode | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([]);
  const [customerError, setCustomerError] = useState<string | null>(null);
  // CUSTOMER-FACHOBJEKT-05C — optional master data of a new customer.
  const [customerExtra, setCustomerExtra] = useState<CustomerExtraFields>(
    createEmptyCustomerExtraFields,
  );
  /** Synchronous lock — a second click in the same event turn must not create again. */
  const contractCreateLockRef = useRef(false);
  const [manualCategory, setManualCategory] = useState<ClassifiedDocumentKind>('sonstiges');
  const [intakeExecution, setIntakeExecution] = useState<WorkflowResultExecution | null>(null);
  const [isExecutingIntake, setIsExecutingIntake] = useState(false);
  const [isCreatingContractOrder, setIsCreatingContractOrder] = useState(false);
  /*
   * CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01B — gesetzt erst nach einem
   * erfolgreichen produktiven Abschluss. Ein Validierungs- oder Speicherfehler
   * lässt den Entwurf ausdrücklich stehen: Genau dann braucht der Nutzer seine
   * Eingaben noch.
   */
  const [customerAssignmentDone, setCustomerAssignmentDone] = useState(false);
  const [deferredWorkflow, setDeferredWorkflow] = useState<WorkflowResult | null>(null);
  const [deferredStatus, setDeferredStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [analysisRetryToken, setAnalysisRetryToken] = useState(0);
  const [freeTextBridgeProposal, setFreeTextBridgeProposal] =
    useState<DocumentFieldFillFreeTextBridgeProposal | null>(null);
  const freeTextBridgeSeqRef = useRef(0);


  const [fillConfirmRows, setFillConfirmRows] = useState<DocumentFieldFillConfirmRow[]>(() => {
    const initial = id ? getInboxItemById(id) : undefined;
    if (!initial) return [];
    const base = [...buildDocumentFieldFillConfirmViewModel(initial).rows];
    const dwr = getDocumentWorkResultForItem(initial.id);
    return applyStoredOverlayToFillConfirmRows(base, dwr?.overlay ?? null);
  });
  const [replyCoreMessage, setReplyCoreMessage] = useState('');
  const [hasReplyDraft, setHasReplyDraft] = useState(false);

  const revealArchiveImportUi = () => {
    setMoreOptionsExpanded(true);
    setExpandedSections((current) => ({ ...current, archive: true }));
  };

  useEffect(() => {
    if (!id) return;
    const reveal = shouldRevealArchiveImportFromState(location.state);
    if (skipIdResetRef.current) {
      if (reveal) {
        setMoreOptionsExpanded(true);
        setExpandedSections((current) => ({ ...current, archive: true }));
        navigate(location.pathname, { replace: true, state: {} });
      }
    } else {
      setMoreOptionsExpanded(reveal);
      setExpandedSections(reveal ? { archive: true } : {});
      if (reveal) {
        navigate(location.pathname, { replace: true, state: {} });
      }
    }
    setIntakeExecution(null);
    setAnalysisRetryToken(0);
    setFreeTextBridgeProposal(null);
    freeTextBridgeSeqRef.current = 0;
    setReplyCoreMessage('');
    setHasReplyDraft(false);
    // Only re-apply reveal when the inbox id changes (list → detail handoff).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: id-scoped reset
  }, [id]);

  useEffect(() => {
    if (id) {
      const next = getInboxItemById(id);
      setItem(next);
      if (skipIdResetRef.current) {
        skipIdResetRef.current = false;
      } else {
        setIsEditing(false);
        setEditDraft(null);
      }
      setFillConfirmRows(() => {
        if (!next) return [];
        const base = [...buildDocumentFieldFillConfirmViewModel(next).rows];
        const dwr = getDocumentWorkResultForItem(next.id);
        return applyStoredOverlayToFillConfirmRows(base, dwr?.overlay ?? null);
      });
    }
  }, [id]);

  // Light session only — never triggers contract/BOQ analysis.
  useEffect(() => {
    if (id) {
      recordInboxContext(id);
    }
  }, [id, item?.status, item?.vorgangId]);

  useEffect(() => {
    if (id && !getInboxItemById(id)) {
      navigate('/ablage', { replace: true });
    }
  }, [id, navigate]);

  // Ignore vorgangId/status — confirm/import must not clear proposal or re-run BOQ.
  const workflowAnalysisKey = buildInboxWorkflowAnalysisKey(item);
  const needsDeferredAnalysis = item ? itemNeedsDeferredWorkflowAnalysis(item) : false;

  // Restored work result (in-memory / eventually persisted) — never a live WorkflowResult.
  const restoredWorkResult = useMemo((): DocumentWorkResult | null => {
    if (!item) return null;
    const snapshot = getDocumentWorkResultForItem(item.id);
    if (!snapshot || !isDocumentWorkResultUsableForDisplay(snapshot, item)) return null;
    return snapshot;
  }, [item, workflowAnalysisKey]);

  const restoredWorkflow = useMemo<WorkflowResult | null>(() => {
    if (!item) return null;
    const snapshot = getDocumentWorkResultForItem(item.id);
    if (!snapshot || !isDocumentWorkResultUsableForDisplay(snapshot, item)) return null;
    return buildWorkflowResultFromDocumentWorkResult(snapshot, item);
  }, [item, workflowAnalysisKey]);

  // Small documents: sync workflow for first paint (no multi-page OCR payload).
  const syncWorkflow = useMemo(() => {
    if (!item || needsDeferredAnalysis) return null;
    return processUploadedDocument(item.id);
  }, [workflowAnalysisKey, needsDeferredAnalysis]);

  // Heavy analysis only after paint (double rAF + idle) — never setTimeout(0) alone.
  useEffect(() => {
    if (!item || !needsDeferredAnalysis) {
      setDeferredWorkflow(null);
      setDeferredStatus('idle');
      return;
    }

    let cancelled = false;
    setDeferredStatus('loading');
    setDeferredWorkflow(null);

    const cancelSchedule = scheduleAfterPaint(() => {
      if (cancelled) return;
      try {
        const result = processUploadedDocument(item.id);
        if (cancelled) return;
        setDeferredWorkflow(result);
        setDeferredStatus(result ? 'ready' : 'error');
      } catch {
        if (cancelled) return;
        setDeferredWorkflow(null);
        setDeferredStatus('error');
      }
    });

    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [workflowAnalysisKey, needsDeferredAnalysis, analysisRetryToken]);

  const workflow = useMemo(() => {
    return mergeReviewWorkflowWithRestoredDocumentWorkResult(restoredWorkflow, syncWorkflow ?? deferredWorkflow);
  }, [restoredWorkflow, syncWorkflow, deferredWorkflow]);
  const goBack = () => navigate('/ablage');

  // Rein berechnet und optional-sicher — muss vor dem Reset-Effekt stehen.
  const contractDecisionKey = buildContractDecisionResetKey(
    item?.id,
    workflow?.contractOrderProposal,
  );

  /**
   * CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01D — der Entwurf hängt am Dokument.
   *
   * 01B legte ihn in den Schnappschuss der UI-Sitzung. Der besitzt genau einen
   * Speicherplatz: Schon eine gescrollte Eingangsliste überschrieb ihn auf dem
   * Weg zurück, und auf dem iPhone war nach „zurück und wieder öffnen" alles
   * weg. Seitdem lebt er in einer eigenen, an Scope, Workspace und Dokument
   * gebundenen Ablage — die UI-Sitzung trägt davon nichts mehr.
   */
  const customerDraftLocator = item?.id ? { itemId: item.id } : null;

  useEffect(() => {
    setCustomerMode(null);
    setSelectedCustomerId(null);
    setCustomerError(null);
    setCustomerOptions(loadSelectableCustomers());
    /**
     * CUSTOMER-PREFILL-NAME-HANDOFF-02D — one counterparty per effect run feeds
     * both setters, so the name can never belong to a different party than the
     * address. Where several parties were recognised but none could be
     * identified as the own company, the form stays empty on both sides.
     */
    const counterparty = resolveCounterpartyFromWorkflow(workflow);
    const recognisedParties = workflow?.contractIntelligence?.parties ?? [];
    setNewCustomerName(
      resolveSuggestedCustomerName(
        item,
        workflow?.contractOrderProposal,
        counterparty,
        recognisedParties.length < 2,
      ),
    );
    setCustomerExtra(buildCustomerExtraFromParty(counterparty));

    /*
     * CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01B — ein gültiger Entwurf gewinnt.
     *
     * Er wird **nach** dem Ausgangsstand gesetzt, im selben Effektlauf: So
     * entsteht kein sichtbares Wiederherstellen-und-sofort-Zurücksetzen. Passt
     * der Ausgangsstand nicht mehr — anderes Dokument, neuer Auftragsvorschlag
     * —, liefert `readCustomerAssignmentResume` `null`, und es bleibt beim
     * frischen Vorschlag.
     */
    const match = customerDraftLocator
      ? matchCustomerAssignmentDraft({
          draft: readCustomerAssignmentDraft(customerDraftLocator),
          contractDecisionKey,
        })
      : ({ ok: false, reason: 'missing' } as const);

    if (match.ok) {
      const draft = match.draft;
      setCustomerMode(draft.mode);
      /*
       * Eine tote Kennung wird nicht wiederhergestellt: Der Kunde kann
       * inzwischen gelöscht sein. Der Modus bleibt, die Auswahl wird leer —
       * und es wird niemals ersatzweise ein anderer Kunde gewählt.
       */
      setSelectedCustomerId(
        draft.selectedCustomerId && getCustomerById(draft.selectedCustomerId)
          ? draft.selectedCustomerId
          : null,
      );
      setNewCustomerName(draft.name);
      setCustomerExtra({
        contactPerson: draft.contactPerson,
        street: draft.street,
        zip: draft.zip,
        city: draft.city,
        email: draft.email,
        phone: draft.phone,
      });
    }

    contractCreateLockRef.current = false;
    setIsCreatingContractOrder(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractDecisionKey]);

  /*
   * CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01D — der Entwurf wird geschrieben,
   * sobald eine Entscheidung vorliegt.
   *
   * Ohne gewählten Modus entsteht nichts; die blosse Auswahl „Neuer Kunde"
   * genügt aber, auch wenn der vorgeschlagene Name unverändert bleibt. Nach
   * einem erfolgreichen Abschluss wird nicht mehr geschrieben — dort ist der
   * Datensatz bereits gelöscht, und ein erneutes Schreiben würde ihn
   * wiederauferstehen lassen.
   *
   * Das ist ausdrücklich **kein** produktives Speichern: Es entsteht kein
   * Kunde, kein Auftrag, keine Zuordnung und kein Cloud-Schreibvorgang.
   */
  useEffect(() => {
    if (!customerDraftLocator || customerAssignmentDone) return;
    if (!customerMode) return;
    writeCustomerAssignmentDraft(customerDraftLocator, {
      contractDecisionKey,
      mode: customerMode,
      selectedCustomerId: selectedCustomerId ?? '',
      name: newCustomerName,
      contactPerson: customerExtra.contactPerson,
      street: customerExtra.street,
      zip: customerExtra.zip,
      city: customerExtra.city,
      email: customerExtra.email,
      phone: customerExtra.phone,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    customerAssignmentDone,
    contractDecisionKey,
    customerMode,
    selectedCustomerId,
    newCustomerName,
    customerExtra,
    item?.id,
  ]);

  useReportUiSession({
    workspaceType: 'document_review',
    activeSection: Object.entries(expandedSections).find(([, open]) => open)?.[0] ?? null,
    panelState: {
      deepWorkspaceOpen: false,
      moreOptionsExpanded,
      detailsOpen: Boolean(Object.values(expandedSections).some(Boolean)),
      assistOpen: false,
    },
    expandedSections: Object.entries(expandedSections)
      .filter(([, open]) => open)
      .map(([key]) => key),
    drafts: {
      /*
       * Zwei Entwürfe, ein Objekt: Der Metadaten-Entwurf und die
       * Kundenzuordnung liegen nebeneinander; der eigene Namensraum
       * `customerAssignment.` verhindert, dass einer den anderen überschreibt.
       */
      values: {
        ...(editDraft
          ? {
              sender: editDraft.sender,
              deadline: editDraft.deadline,
              vorgangTitle: editDraft.vorgangTitle,
              priority: editDraft.priority,
              digitalFolderPath: editDraft.digitalFolderPath,
              digitalFolderName: editDraft.digitalFolderName,
              paperFilingFolderId: editDraft.paperFilingFolderId,
              paperFilingRegister: editDraft.paperFilingRegister,
              recommendedAction: editDraft.recommendedAction,
            }
          : {}),
      },
      dirty: Boolean(isEditing && editDraft),
    },
  });

  /**
   * CORE-REALTEST-BLOCKER-01D — ab hier beginnen die frühen Returns.
   * Unterhalb dieser Stelle darf kein Hook mehr stehen: die Deferred-Shell
   * beendet den ersten Render vorzeitig, ein späterer Render würde sonst mehr
   * Hooks aufrufen und React mit „Rendered more hooks…“ abbrechen.
   */
  if (!item) {
    return (
      <div className="page" data-testid="eingang-detail-missing">
        <button type="button" className="back-link" onClick={goBack}>
          ← {translate('common.back')}
        </button>
        <Card>
          <p data-testid="eingang-detail-missing-message">{translate('common.loading')}</p>
        </Card>
      </div>
    );
  }

  const showDeferredShell =
    needsDeferredAnalysis && (deferredStatus !== 'ready' || !workflow);

  if (showDeferredShell) {
    return (
      <div className="page" data-testid="eingang-detail-analysis-pending">
        <button type="button" className="back-link" onClick={goBack}>
          ← {translate('common.back')}
        </button>
        <Card>
          <DataRow label={translate('inbox.title')} value={item.title} />
          <DataRow
            label={translate('reviewWorkflow.hero.documentType')}
            value={
              item.classifiedKind
                ? translate(`classifiedKind.${item.classifiedKind}` as TranslationKey)
                : translate('reviewWorkflow.hero.unknown')
            }
          />
          <DataRow
            label={translate('document.upload.status')}
            value={getStatusLabel(item.status, setup.language)}
          />
          {restoredWorkResult ? (
            <span
              data-testid="eingang-detail-restored-snapshot"
              data-inbox-item-id={restoredWorkResult.inboxItemId}
              hidden
            />
          ) : null}
          {deferredStatus === 'error' ? (
            <>
              <p data-testid="eingang-detail-analysis-error">
                {translate('reviewWorkflow.analysis.error')}
              </p>
              <Button
                fullWidth
                variant="outline"
                data-testid="eingang-detail-analysis-retry"
                onClick={() => setAnalysisRetryToken((token) => token + 1)}
              >
                {translate('reviewWorkflow.analysis.retry')}
              </Button>
            </>
          ) : (
            <p data-testid="eingang-detail-analysis-loading">
              {translate('reviewWorkflow.analysis.loading')}
            </p>
          )}
        </Card>
        <div data-testid="ablage-original-file">
          <DocumentOriginalFilePanel
            fileRefId={item.fileRefId}
            translate={translate}
            onPromoted={() => showToast(translate('document.original.promote.success'))}
          />
        </div>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="page" data-testid="eingang-detail-analysis-pending">
        <button type="button" className="back-link" onClick={goBack}>
          ← {translate('common.back')}
        </button>
        <Card>
          <DataRow label={translate('inbox.title')} value={item.title} />
          <DataRow
            label={translate('reviewWorkflow.hero.documentType')}
            value={
              item.classifiedKind
                ? translate(`classifiedKind.${item.classifiedKind}` as TranslationKey)
                : translate('reviewWorkflow.hero.unknown')
            }
          />
          <DataRow
            label={translate('document.upload.status')}
            value={getStatusLabel(item.status, setup.language)}
          />
          <p data-testid="eingang-detail-analysis-loading">
            {translate('reviewWorkflow.analysis.loading')}
          </p>
        </Card>
        <div data-testid="ablage-original-file">
          <DocumentOriginalFilePanel
            fileRefId={item.fileRefId}
            translate={translate}
            onPromoted={() => showToast(translate('document.original.promote.success'))}
          />
        </div>
      </div>
    );
  }

  const docTypeKey = `docType.${item.documentType}` as TranslationKey;
  const actionKey = `action.${item.recommendedAction}` as TranslationKey;
  const relevance = workflow.companyRelevance;
  const analysisAllowed = workflow.companyRelevant;
  const classifiedKind = workflow.classifiedKind;
  const classifiedKindKey = `classifiedKind.${classifiedKind}` as TranslationKey;
  const canCreateTask =
    analysisAllowed &&
    (Boolean(item.taskTemplate) || isClassificationKindWithTasks(classifiedKind));
  const letterExplanation =
    letterExplanationFromWorkflow(workflow.documentExplanation) ??
    getLetterExplanation(item, setup.language);
  const prioritizeContractWorkspace = Boolean(workflow?.contractOrderProposal);

  // A new Vorgang is only created when no valid link exists yet.
  const contractLinkedVorgangId = item?.vorgangId?.trim() ?? '';
  const contractCreatesNewVorgang =
    Boolean(workflow?.contractOrderProposal) &&
    (!contractLinkedVorgangId || !getVorgangById(contractLinkedVorgangId));
  const customerDecisionBlocked =
    contractCreatesNewVorgang &&
    isCustomerDecisionIncomplete(customerMode, newCustomerName, selectedCustomerId);
  const customerHintKey = resolveNewCustomerHintKey(customerMode, newCustomerName);

  /** Behörde / BG BAU / Mahnung / Zahlungserinnerung — consolidated assist lane. */
  const useAssistFlowConsolidate =
    isConfirmedReplyDraftSupported(item) && !prioritizeContractWorkspace;
  const contractAnalysis = workflow.contractAnalysis;
  const extractedText = getInboxExtractedDocumentText(item);
  const linkedVorgangId = item.vorgangId ?? workflow.suggestedVorgang?.vorgangId ?? null;
  const linkedVorgang = linkedVorgangId ? getVorgangById(linkedVorgangId) : undefined;
  const positionsImportLocked = Boolean(
    linkedVorgang && isContractPlanLocked(linkedVorgang),
  );

  const toggleSection = (sectionId: ReviewSectionId) => {
    setExpandedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  };

  const handleMarkAsCompanyDocument = () => {
    const updated = markInboxAsCompanyDocument(item.id, manualCategory);
    if (updated) {
      setItem(updated);
      showToast(translate('companyRelevance.markedSuccess'));
    }
  };

  const handleContractAction = (actionId: ContractSuggestedAction['id']) => {
    applyOfficeActionResult(executeContractAction(actionId, item, contractAnalysis ?? undefined), {
      navigate,
      translate,
      showToast,
      onItemUpdated: setItem,
      delegates: {
        importArchive: handleImportToArchive,
        openVorgangDialog: () => setVorgangDialogRequest((n) => n + 1),
      },
    });
  };

  const startEditing = () => {
    setEditDraft(createEditDraftFromItem(item));
    setIsEditing(true);
    setMoreOptionsExpanded(true);
    setExpandedSections((current) => ({ ...current, 'document-data': true }));
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditDraft(null);
  };

  const saveEditing = () => {
    if (!editDraft) return;
    const updated = updateInboxItemRecognizedData(item.id, {
      sender: editDraft.sender,
      deadline: editDraft.deadline || null,
      vorgangTitle: editDraft.vorgangTitle,
      priority: editDraft.priority,
      recognizedData: editDraft.recognizedData,
      digitalFolderPath: editDraft.digitalFolderPath,
      digitalFolderName: editDraft.digitalFolderName,
      paperFilingFolderId: editDraft.paperFilingFolderId,
      paperFilingRegister: editDraft.paperFilingRegister,
      recommendedAction: editDraft.recommendedAction,
    });
    if (updated) {
      setItem(updated);
      setIsEditing(false);
      setEditDraft(null);
      showToast(translate('inbox.edit.saved'));
    }
  };

  const handleFiling = () => {
    const result = confirmFiling(item.id);
    if (!result) return;
    showToast(formatInboxActionToast(result, translate));
    if (result.success) {
      goBack();
    } else if (result.messageKey === 'inbox.toast.filingRequiresArchive') {
      revealArchiveImportUi();
    }
  };

  const handleDefer = () => {
    const result = deferItem(item.id);
    if (result) {
      showToast(formatInboxActionToast(result, translate));
      goBack();
    }
  };

  const handleCreateTask = () => {
    const result = createTaskForItem(item.id);
    if (result) {
      showToast(formatInboxActionToast(result, translate));
      setItem(getInboxItemById(item.id));
    } else if (!analysisAllowed) {
      showToast(translate('taskEngine.blockedByRelevance'));
    } else {
      showToast(translate('taskEngine.noTaskAvailable'));
    }
  };

  const handleCreateContractTasks = () => {
    const result = createContractTasksForItem(item.id);
    if (result) {
      showToast(formatInboxActionToast(result, translate));
      setItem(getInboxItemById(item.id));
    } else if (!analysisAllowed) {
      showToast(translate('taskEngine.blockedByRelevance'));
    } else {
      showToast(translate('taskEngine.noContractTasks'));
    }
  };

  const handleDispose = () => {
    const result = confirmDispose(item.id);
    if (result) {
      showToast(formatInboxActionToast(result, translate));
      goBack();
    }
  };

  /** DOCUMENT-INBOX-DELETE-01 — false keeps the dialog open and shows the reason. */
  const handleConfirmDeleteInboxItem = async (): Promise<boolean> => {
    const result = await deleteInboxItem(item.id);
    if (!result) {
      setDeleteFailureMessage(translate('inbox.delete.failed'));
      return false;
    }
    if (!result.success) {
      setDeleteFailureMessage(formatInboxActionToast(result, translate));
      return false;
    }
    setDeleteConfirmOpen(false);
    setDeleteFailureMessage(null);
    showToast(formatInboxActionToast(result, translate));
    goBack();
    return true;
  };

  /**
   * DOCUMENT-UNLINK-DELETE-01E — löst nur die aktive Zuordnung. Der Vorgang,
   * seine Positionen und ein bestätigter Auftrag bleiben unverändert; gelöscht
   * wird nichts. Erst nach ausdrücklicher Bestätigung.
   */
  const handleConfirmUnlinkVorgang = (): boolean => {
    const result = unlinkInboxItemFromVorgang(item.id);
    if (!result.success) {
      setUnlinkFailureMessage(translate(result.errorKey as TranslationKey));
      return false;
    }
    setItem(result.inbox);
    setUnlinkConfirmOpen(false);
    setUnlinkFailureMessage(null);
    showToast(translate('inbox.unlinkVorgang.success'));
    return true;
  };

  const handleSaveAnyway = () => {
    const result = saveAdvertisementAnyway(item.id);
    if (result) {
      showToast(formatInboxActionToast(result, translate));
      goBack();
    }
  };

  const handleVorgangLinked = (updatedInbox: InboxItem, _vorgang: Vorgang) => {
    setItem(updatedInbox);
  };

  const finishArchiveImport = (mode: 'create' | 'update', existingDocumentId?: string) => {
    setIsImporting(true);
    try {
      // R02: one shared handoff — archive write plus inbox marking. A repeated attempt
      // reuses an existing archive document for this inbox item instead of duplicating.
      const result = handoffInboxItemToArchive(item, ownCompanyName, {
        ...resolveImportInboxDocumentOptionsFromIntakeCarry(item.id),
        ...(mode === 'update' && existingDocumentId ? { existingDocumentId } : {}),
      });

      if (!result.success) {
        showToast(translate(result.errorKey as TranslationKey));
        revealArchiveImportUi();
        return;
      }

      const archiveResult = { item: result.item };
      setItem(archiveResult.item);
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
        setDuplicateDocument(null);
        return;
      }
      showToast(translate('inbox.importToArchive.success'));
      setDuplicateDocument(null);
      navigate(`/dokumente/${result.document.id}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportToArchive = () => {
    if (!isDocumentFilingDecisionConfirmed(item)) {
      showToast(translate('filingDecision.confirmRequired'));
      revealArchiveImportUi();
      return;
    }
    const duplicate = isDuplicateDocument(item, ownCompanyName);
    if (duplicate) {
      setDuplicateDocument(duplicate);
      return;
    }
    finishArchiveImport('create');
  };

  const refreshWorkflowItem = () => {
    const latest = getInboxItemById(item.id);
    if (latest) setItem(latest);
  };

  const handleIntakeArchive = () => {
    if (!isDocumentFilingDecisionConfirmed(item)) {
      showToast(translate('filingDecision.confirmRequired'));
      revealArchiveImportUi();
      return;
    }
    handleImportToArchive();
  };

  const handleIntakeCreateVorgang = () => {
    // UI-VALIDIERUNG-01: contract proposal → same Accept-Orchestrator (no parallel create).
    if (workflow?.contractOrderProposal) {
      handleCreateContractOrder(workflow.contractOrderProposal.positions);
      return;
    }

    if (workflow?.suggestedVorgang) {
      const linked = linkWorkflowVorgang(item, workflow.suggestedVorgang.vorgangId);
      if (linked) {
        setItem(linked.inbox);
        if (!getLastPersistSuccess()) {
          showToast(translate('persist.failed.userAction'));
        } else {
          showToast(translate('vorgang.link.success'));
        }
        return;
      }
    }

    // CUSTOMER-FACHOBJEKT-04B — a new Vorgang always goes through the dialog so
    // the customer decision is made explicitly. Nothing is created before that.
    setVorgangDialogRequest((n) => n + 1);
  };

  const handleIntakeImportPositions = () => {
    if (!workflow) return;
    if (positionsImportLocked) {
      showToast(translate('order_plan_amendment_required'));
      return;
    }

    // Prefer the shared confirm-first Proposal UI when available.
    if (workflow.contractOrderProposal) {
      document
        .querySelector('[data-testid="contract-order-proposal"]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast(translate('documentIntelligence.proposal.confirmBelow'));
      return;
    }

    const vorgangId = item.vorgangId ?? workflow.suggestedVorgang?.vorgangId;
    if (!vorgangId) {
      setVorgangDialogRequest((n) => n + 1);
      showToast(translate('intake.positionsNeedsVorgang'));
      return;
    }

    const selections = buildDefaultContractPositionSelections(workflow.suggestedOrderPositions);
    const result = confirmImportContractPositions(
      vorgangId,
      workflow.suggestedOrderPositions,
      selections,
    );
    if (result.success) {
      showToast(translate('intake.positionsImported').replace('{count}', String(result.added)));
      refreshWorkflowItem();
    } else if (result.errorKey === 'order_plan_amendment_required') {
      showToast(translate('order_plan_amendment_required'));
    } else if (result.errorKey === 'position.unitUnresolved') {
      // Import wurde vollständig blockiert — das darf nicht lautlos passieren.
      showToast(buildUnitUnresolvedToast(translate, result.unresolvedUnits));
    }
  };

  const handleIntakeAcceptTasks = () => {
    if (!workflow) return;
    const taskProposals = workflow.workflowDecision!.taskProposals;
    if (taskProposals.length === 0) return;
    const created = acceptSuggestedTasks(taskProposals);
    if (created.length > 0) {
      showToast(translate('intake.tasksAccepted').replace('{count}', String(created.length)));
      refreshWorkflowItem();
    }
  };

  const handleExecuteAll = () => {
    if (!workflow) return;
    // UI-VALIDIERUNG-01: contract proposal → Accept-Orchestrator (Sprint A–D), not Smart Intake.
    if (workflow.contractOrderProposal) {
      handleCreateContractOrder(workflow.contractOrderProposal.positions);
      return;
    }
    if (!isDocumentFilingDecisionConfirmed(item)) {
      showToast(translate('filingDecision.confirmRequired'));
      revealArchiveImportUi();
      return;
    }
    setIsExecutingIntake(true);
    try {
      const duplicate = isDuplicateDocument(item, ownCompanyName);
      const result = executeSmartIntake(workflow, {
        companyName: ownCompanyName,
        materialStandard: setup.materialStandard,
        duplicateMode: duplicate ? 'update' : 'create',
      });
      setIntakeExecution(result);
      if (result.inboxItem) setItem(result.inboxItem);
      const filingBlocked = result.failedSteps.some(
        (step) =>
          step.step === 'archive_document' &&
          step.message === FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE,
      );
      if (filingBlocked) {
        showToast(translate('filingDecision.confirmRequired'));
        revealArchiveImportUi();
      } else if (result.completed) {
        showToast(translate('intake.execute.success'));
      } else if (result.failedSteps.length > 0) {
        showToast(translate('intake.execute.partial'));
      }
    } finally {
      setIsExecutingIntake(false);
    }
  };

  const handleApplySuggestion = () => {
    if (item.isAdvertisement) {
      setMoreOptionsExpanded(true);
      setExpandedSections((current) => ({ ...current, technical: true }));
      return;
    }
    handleExecuteAll();
  };

  const handleOpenVorgang = (matchedVorgangId?: string) => {
    const vorgangId =
      matchedVorgangId ?? intakeExecution?.vorgangId ?? item.vorgangId;
    if (vorgangId) navigate(`/vorgaenge/${vorgangId}`);
  };

  const handleOpenArchive = () => {
    const archiveDocumentId =
      intakeExecution?.archiveDocumentId ?? item.archiveDocumentId;
    if (archiveDocumentId) navigate(`/dokumente/${archiveDocumentId}`);
  };

  const handleCreateContractOrder = (selectedPositions: EnhancedDetectedOrderPosition[]) => {
    if (!item || !workflow?.contractOrderProposal || contractCreateLockRef.current) return;

    // CUSTOMER-FACHOBJEKT-04C — shared gate for all three manual entries.
    let customerDecision: CustomerDecision | undefined;
    if (contractCreatesNewVorgang) {
      if (customerDecisionBlocked) {
        showToast(translate(customerHintKey ?? 'customerDecision.required'));
        setMoreOptionsExpanded(true);
        return;
      }
      const built = buildCustomerDecisionFromUi(
        customerMode,
        buildCustomerInputFromUi(newCustomerName, customerExtra),
        selectedCustomerId,
      );
      if (!built) {
        showToast(translate('customerDecision.required'));
        return;
      }
      if (built.kind === 'existing' && !getCustomerById(built.customerId)) {
        setCustomerError(translate('customerDecision.missing'));
        showToast(translate('customerDecision.missing'));
        return;
      }
      customerDecision = built;
    }
    if (positionsImportLocked) {
      showToast(translate('order_plan_amendment_required'));
      return;
    }
    if (!ownCompanyName?.trim()) {
      showToast(translate('documentIntelligence.createOrderFailed'));
      return;
    }
    // Locked synchronously; released only after this event turn.
    contractCreateLockRef.current = true;
    setIsCreatingContractOrder(true);
    try {
      const result = acceptContractOrderFromProposal({
        item,
        proposal: workflow.contractOrderProposal,
        selectedPositions,
        companyName: ownCompanyName,
        materialStandard: setup.materialStandard,
        customerDecision,
      });
      if (!result.success) {
        if (result.errorKey === 'order_plan_amendment_required') {
          showToast(translate('order_plan_amendment_required'));
          return;
        }
        if (
          result.errorKey === FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE ||
          result.errorKey === 'document.filingDecisionRequired'
        ) {
          showToast(translate('filingDecision.confirmRequired'));
          return;
        }
        if (result.errorKey === 'position.unitUnresolved') {
          showToast(buildUnitUnresolvedToast(translate, result.unresolvedUnits));
          return;
        }
        const maybeKey = result.errorKey as TranslationKey;
        showToast(
          maybeKey.includes('.') ? translate(maybeKey) : result.errorKey,
        );
        return;
      }
      setItem(result.inbox);
      // Der Entwurf ist erledigt — er darf beim naechsten Oeffnen nicht wiederkommen.
      setCustomerAssignmentDone(true);
      if (customerDraftLocator) clearCustomerAssignmentDraft(customerDraftLocator);
      setIntakeExecution({
        completed: true,
        successSteps: result.successSteps,
        failedSteps: [],
        warnings: [],
        vorgangId: result.vorgang.id,
        archiveDocumentId: result.archiveDocumentId,
        inboxItem: result.inbox,
        tasksCreated: 0,
        positionsAdded: result.positionsAdded,
        pendingSummary: null,
      });
      showToast(
        translate('documentIntelligence.createOrderSuccess').replace(
          '{count}',
          String(result.positionsAdded),
        ),
      );
      navigate(`/vorgaenge/${result.vorgang.id}`);
    } finally {
      // Never released synchronously — a second event of the same turn must not pass.
      queueMicrotask(() => {
        contractCreateLockRef.current = false;
        setIsCreatingContractOrder(false);
      });
    }
  };

  const handleDiscardContractProposal = () => {
    showToast(translate('documentIntelligence.proposal.discarded'));
  };

  const handleContractInquiry = () => {
    setMoreOptionsExpanded(true);
    setExpandedSections((current) => ({ ...current, communication: true }));
    showToast(translate('auftragskarte.inquiryHint'));
  };

  // DOCUMENT-EXPERIENCE-02B: LetterExplanation / Guidance live in Experience Details (E), not here.
  const overlappingHintPanels = analysisAllowed ? (
    <>
      <DocumentActionSuggestionsPanel
        item={item}
        classification={workflow.classification ?? undefined}
        suggestedVorgang={workflow.suggestedVorgang ?? undefined}
        availableDocumentActions={
          workflow.workflowDecision?.officeActionContext.availableDocumentActions ?? []
        }
        translate={translate}
        onVorgangLinked={handleVorgangLinked}
        onConfirmFiling={handleFiling}
        onImportArchive={handleImportToArchive}
        onCreateTask={handleCreateTask}
        onOpenVorgangDialog={() => setVorgangDialogRequest((n) => n + 1)}
        onItemUpdated={setItem}
        navigate={navigate}
        showToast={showToast}
      />
      <SmartIntakeSummary
        workflow={workflow}
        item={item}
        executionResult={intakeExecution}
        isExecuting={isExecutingIntake}
        onExecuteAll={handleExecuteAll}
        onArchive={handleIntakeArchive}
        onCreateVorgang={handleIntakeCreateVorgang}
        onImportPositions={handleIntakeImportPositions}
        onAcceptTasks={handleIntakeAcceptTasks}
        onCancel={() => undefined}
        importPositionsLocked={positionsImportLocked}
      />
    </>
  ) : null;

  const communicationPanel = (
    <CommunicationIntegrationPanel
      contextRef={{ type: 'inbox', id: item.id }}
      buttonKeys={INBOX_COMMUNICATION_BUTTON_KEYS}
      testIdPrefix="eingang"
    />
  );

  const moreOptionsContent = (
    <>
      <CollapsibleReviewSection
        id="document-data"
        title={translate('reviewWorkflow.section.documentData')}
        expanded={Boolean(expandedSections['document-data'])}
        onToggle={() => toggleSection('document-data')}
      >
        {isEditing && editDraft ? (
          <InboxItemEditForm
            draft={editDraft}
            onChange={setEditDraft}
            onSave={saveEditing}
            onCancel={cancelEditing}
          />
        ) : (
          <Card>
            <div className="card-section-header">
              <h3 className="section__title">{translate('ablage.recognizedSummary')}</h3>
              <Button variant="outline" onClick={startEditing}>
                {translate('inbox.edit.start')}
              </Button>
            </div>
            {item.sourceFileName && (
              <DataRow label={translate('inbox.sourceDocument')} value={item.sourceFileName} />
            )}
            <DataRow label={translate('inbox.documentType')} value={translate(docTypeKey)} />
            {analysisAllowed && (
              <DataRow label={translate('classification.documentKind')} value={translate(classifiedKindKey)} />
            )}
            <DataRow label={translate('inbox.sender')} value={item.sender} />
            {item.vorgangTitle && (
              <DataRow label={translate('analysis.vorgang')} value={item.vorgangTitle} />
            )}
            {Object.entries(item.recognizedData)
              .filter(([key]) => !key.startsWith('_'))
              .map(([key, value]) => (
                <DataRow key={key} label={key} value={value} />
              ))}
            {item.deadline && (
              <DataRow label={translate('analysis.deadline')} value={item.deadline} />
            )}
          </Card>
        )}
      </CollapsibleReviewSection>

      {extractedText && (
        <CollapsibleReviewSection
          id="ocr-text"
          title={translate('reviewWorkflow.section.ocrText')}
          expanded={Boolean(expandedSections['ocr-text'])}
          onToggle={() => toggleSection('ocr-text')}
          testId="document-review-ocr-section"
        >
          <Card data-testid="document-review-ocr-content">
            <p className="document-review-ocr-text">{extractedText}</p>
          </Card>
        </CollapsibleReviewSection>
      )}

      {!useAssistFlowConsolidate ? (
        <CollapsibleReviewSection
          id="communication"
          title={translate('reviewWorkflow.section.communication')}
          expanded={Boolean(expandedSections.communication)}
          onToggle={() => toggleSection('communication')}
        >
          {communicationPanel}
        </CollapsibleReviewSection>
      ) : null}

      <CollapsibleReviewSection
        id="tasks"
        title={translate('reviewWorkflow.section.tasks')}
        expanded={Boolean(expandedSections.tasks)}
        onToggle={() => toggleSection('tasks')}
      >
        <div className="action-stack">
          {canCreateTask && (
            <Button variant="outline" fullWidth onClick={handleCreateTask}>
              {translate('inbox.createTask')}
            </Button>
          )}
          <Button variant="outline" fullWidth onClick={handleDefer}>
            {translate('inbox.defer')}
          </Button>
          {item.isAdvertisement && (
            <>
              <Button variant="outline" fullWidth onClick={handleDispose}>
                {translate('inbox.confirmDispose')}
              </Button>
              <Button variant="ghost" fullWidth onClick={handleSaveAnyway}>
                {translate('inbox.saveAnyway')}
              </Button>
            </>
          )}
        </div>
      </CollapsibleReviewSection>

      {workflow.suggestedOrderPositions.length > 0 && !workflow.contractOrderProposal && (
        <CollapsibleReviewSection
          id="positions"
          title={translate('reviewWorkflow.section.positions')}
          expanded={Boolean(expandedSections.positions)}
          onToggle={() => toggleSection('positions')}
        >
          <Card>
            <p>
              {translate('intake.check.positionsCount').replace(
                '{count}',
                String(workflow.suggestedOrderPositions.length),
              )}
            </p>
            <p className="contract-order-proposal__hint">
              {translate('documentIntelligence.proposal.onlySelectedHint')}
            </p>
            {!positionsImportLocked ? (
              <Button
                variant="outline"
                fullWidth
                data-testid="intake-import-positions"
                onClick={handleIntakeImportPositions}
              >
                {translate('documentIntelligence.action.confirmSelectedPositions').replace(
                  '{count}',
                  String(
                    countSelectedContractPositions(
                      workflow.suggestedOrderPositions,
                      buildDefaultContractPositionSelections(workflow.suggestedOrderPositions),
                    ),
                  ),
                )}
              </Button>
            ) : (
              <p className="muted" data-testid="intake-import-plan-locked">
                {translate('orderPlan.confirmedHint')}
              </p>
            )}
          </Card>
        </CollapsibleReviewSection>
      )}

      <CollapsibleReviewSection
        id="archive"
        title={translate('reviewWorkflow.section.archive')}
        expanded={Boolean(expandedSections.archive)}
        onToggle={() => toggleSection('archive')}
      >
        <DocumentFilingDecisionPanel
          item={item}
          onConfirmed={(updated) => {
            setItem(updated);
            showToast(translate('filingDecision.confirmedToast'));
          }}
        />
        <Card>
          <DataRow label={translate('analysis.digitalFolder')} value={item.digitalFolder.path} />
          <DataRow
            label={translate('analysis.paperFiling')}
            value={formatPaperFilingInstruction(item.paperFiling, setup.language)}
          />
          <DataRow label={translate('inbox.nextTask')} value={item.nextTaskLabel} />
          <DataRow label={translate('inbox.recommendedAction')} value={translate(actionKey)} />
          {!item.importedToArchive && analysisAllowed && !item.isAdvertisement ? (
            <div
              className="document-review-experience__archive-cta"
              data-testid="inbox-import-to-archive-primary"
            >
              <Button
                variant="outline"
                fullWidth
                disabled={isImporting}
                data-testid="inbox-import-to-archive-primary-button"
                onClick={handleImportToArchive}
              >
                {translate('inbox.importToArchive')}
              </Button>
            </div>
          ) : null}
          {!item.importedToArchive &&
            analysisAllowed &&
            !isDocumentFilingDecisionConfirmed(item) && (
              <p className="muted" data-testid="filing-decision-archive-blocked">
                {translate('filingDecision.confirmRequired')}
              </p>
            )}
          {item.importedToArchive && item.archiveDocumentId && (
            <p className="archive-import-hint">
              {translate('inbox.importToArchive.viewDocument')}{' '}
              <Link to={`/dokumente/${item.archiveDocumentId}`}>
                {translate('inbox.importToArchive.openArchive')}
              </Link>
            </p>
          )}
        </Card>
      </CollapsibleReviewSection>

      <CollapsibleReviewSection
        id="technical"
        title={translate('reviewWorkflow.section.technical')}
        expanded={Boolean(expandedSections.technical)}
        onToggle={() => toggleSection('technical')}
      >
        <div className="badge-row">
          <Badge tone="warning">{getPriorityLabel(item.priority, setup.language)}</Badge>
          <Badge>{getStatusLabel(item.status, setup.language)}</Badge>
          {item.isNewUpload && !item.userModified && (
            <Badge tone="info">{translate('inboxStatus.neu')}</Badge>
          )}
          {item.userModified && (
            <Badge tone="success">{translate('inbox.manuallyReviewed')}</Badge>
          )}
          {(item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created') && (
            <Badge tone="info">{translate('vorgang.linkedBadge')}</Badge>
          )}
          {item.markedAsCompanyDocument && (
            <Badge tone="success">{translate('companyRelevance.manualBadge')}</Badge>
          )}
          {item.importedToArchive && (
            <Badge tone="success">{translate('inbox.importToArchive.badge')}</Badge>
          )}
        </div>

        <CompanyRelevancePanel
          relevance={relevance}
          translate={translate}
          markedAsCompanyDocument={Boolean(item.markedAsCompanyDocument)}
          selectedCategory={manualCategory}
          onCategoryChange={setManualCategory}
          onMarkAsCompanyDocument={handleMarkAsCompanyDocument}
        />

        {analysisAllowed && contractAnalysis && (
          <ContractAnalysisPanel
            analysis={contractAnalysis}
            item={item}
            translate={translate}
            onAction={handleContractAction}
            onCreateContractTasks={
              contractAnalysis.requiredDocuments.length > 0 ? handleCreateContractTasks : undefined
            }
          />
        )}

        {!useAssistFlowConsolidate && overlappingHintPanels}

        {analysisAllowed && !workflow?.contractOrderProposal && (
          <InboxVorgangPanel
            item={item}
            materialDefault={setup.materialStandard}
            onLinked={handleVorgangLinked}
            requestOpenDialog={vorgangDialogRequest}
          />
        )}

        <div className="security-hint">
          <strong>{translate('inbox.securityHint')}</strong>
          <p>{localizeStoredUserText(item.securityHint, setup.language)}</p>
        </div>

        {!item.isAdvertisement && (
          <Button fullWidth onClick={handleFiling}>
            {translate('inbox.confirmFiling')}
          </Button>
        )}
      </CollapsibleReviewSection>

      {useAssistFlowConsolidate ? (
        <CollapsibleReviewSection
          id="further-hints"
          title="Weitere Hinweise"
          expanded={Boolean(expandedSections['further-hints'])}
          onToggle={() => toggleSection('further-hints')}
          testId="review-section-further-hints"
        >
          {overlappingHintPanels}
          {communicationPanel}
        </CollapsibleReviewSection>
      ) : null}
    </>
  );

  /** Remount assist session surfaces when the inbox document changes (SPA reuse). */
  const assistSessionKey = item.id;

  const freeQuestionPanel = (
    <DocumentFreeQuestionPanel
      key={`document-free-question-${assistSessionKey}`}
      source={{
        type: 'inbox',
        item,
        liveWorkflow: workflow,
        sessionFillConfirmRows: fillConfirmRows,
      }}
      testIdPrefix="document-free-question"
      onFieldStatementProposal={(statement) => {
        freeTextBridgeSeqRef.current += 1;
        setFreeTextBridgeProposal({
          id: freeTextBridgeSeqRef.current,
          fieldKey: statement.fieldKey,
          value: statement.value,
        });
      }}
    />
  );
  const fieldFillConfirmPanel = (
    <DocumentFieldFillConfirmPanel
      key={`document-field-fill-confirm-${assistSessionKey}`}
      item={item}
      testIdPrefix="document-field-fill-confirm"
      freeTextBridgeProposal={freeTextBridgeProposal}
      rows={fillConfirmRows}
      onRowsChange={setFillConfirmRows}
      onPersistFailed={(message) => showToast(message)}
    />
  );
  const contextualNextStepsPanel = useAssistFlowConsolidate ? (
    <DocumentContextualNextStepsPanel
      key={`document-contextual-next-steps-${assistSessionKey}`}
      rows={fillConfirmRows}
      coreMessage={replyCoreMessage}
      hasReplyDraft={hasReplyDraft}
      testIdPrefix="document-contextual-next-steps"
    />
  ) : null;
  const confirmedReplyDraftPanel = isConfirmedReplyDraftSupported(item) ? (
    <DocumentConfirmedReplyDraftPanel
      key={`document-confirmed-reply-draft-${assistSessionKey}`}
      item={item}
      rows={fillConfirmRows}
      testIdPrefix="document-confirmed-reply-draft"
      onHandoffToCommunication={(payload) => {
        navigate(buildKommunikationPath(payload.contextRef), {
          state: createDocumentReplyDraftHandoffLocationState(payload),
        });
      }}
      onCoreMessageChange={setReplyCoreMessage}
      onReplyDraftPresenceChange={setHasReplyDraft}
    />
  ) : null;
  const originalFilePanel = item.fileRefId ? (
    <div data-testid="ablage-original-file">
      <DocumentOriginalFilePanel
        fileRefId={item.fileRefId}
        translate={translate}
        onPromoted={() => showToast(translate('document.original.promote.success'))}
      />
    </div>
  ) : null;
  const experienceDetailsExtra = (
    <div data-testid="document-experience-details-extra">
      {letterExplanation ? (
        <div data-testid="document-experience-letter">
          <LetterExplanationPanel explanation={letterExplanation} />
        </div>
      ) : null}
      <div data-testid="document-experience-guidance">
        <DocumentGuidancePanel
          guidance={buildDocumentGuidance(item, workflow, setup.language, {
            sessionFillConfirmRows: fillConfirmRows,
          })}
          translate={translate}
        />
      </div>
    </div>
  );

  /*
   * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — Mahnung und Zahlungserinnerung
   * verweisen auf einen bestehenden Beleg. Statt einer Erfassungsaktion zeigt
   * die Seite, welcher Beleg gemeint ist und wie er dasteht. Verknüpft wird
   * erst nach ausdrücklicher Bestätigung; gebucht wird hier nie.
   */
  const financeReferenceKind = isFinanceReferenceOnlyKind(
    workflow?.classifiedKind ?? item.classifiedKind,
  );
  const financeReferenceMatch = financeReferenceKind
    ? resolveDocumentFinanceReference(item)
    : null;
  const financeReferencePanel = financeReferenceMatch ? (
    <DocumentFinanceReferencePanel
      match={financeReferenceMatch}
      translate={translate}
      onOpenTarget={(targetId) => navigate(`/ausgaben/${targetId}`)}
      onConfirmLink={(targetId) => {
        const result = confirmDocumentFinanceReference(item.id, {
          targetType: 'expense',
          targetId,
        });
        if (!result.ok) {
          showToast(translate('financeReference.conflict'));
          return;
        }
        setItem(result.item);
        showToast(translate('financeReference.linked'));
      }}
    />
  ) : null;

  const reviewExperience = (
    <DocumentReviewExperience
      item={item}
      workflow={workflow}
      executionResult={intakeExecution}
      isExecuting={isExecutingIntake}
      moreOptionsExpanded={moreOptionsExpanded}
      onToggleMoreOptions={() => setMoreOptionsExpanded((open) => !open)}
      onApplySuggestion={handleApplySuggestion}
      onCreateContractOrder={handleCreateContractOrder}
      customerDecisionBlocked={customerDecisionBlocked}
      customerDecisionSlot={
        contractCreatesNewVorgang ? (
          <div data-testid="contract-customer-decision">
            <CustomerDecisionChoice
              mode={customerMode}
              onModeChange={(next) => {
                setCustomerMode(next);
                setSelectedCustomerId(null);
                setCustomerError(null);
              }}
              customers={customerOptions}
              selectedCustomerId={selectedCustomerId}
              onSelectCustomer={(id) => {
                setSelectedCustomerId(id);
                setCustomerError(null);
              }}
              hint={customerHintKey ? translate(customerHintKey) : customerError}
              extraFields={customerExtra}
              onExtraFieldChange={(field, value) => {
                setCustomerExtra((prev) => ({ ...prev, [field]: value }));
                setCustomerError(null);
              }}
            />
            {customerMode === 'new' && (
              <label className="edit-field">
                <span className="edit-field__label">{translate('kunden.edit.name')}</span>
                <input
                  type="text"
                  className="input"
                  value={newCustomerName}
                  data-testid="contract-customer-name-input"
                  onChange={(e) => {
                    setNewCustomerName(e.target.value);
                    setCustomerError(null);
                  }}
                />
              </label>
            )}
          </div>
        ) : null
      }
      onDiscardContractProposal={handleDiscardContractProposal}
      onContractInquiry={handleContractInquiry}
      isCreatingContractOrder={isCreatingContractOrder}
      onOpenVorgang={handleOpenVorgang}
      onOpenArchive={handleOpenArchive}
      onNextDocument={goBack}
      onLinkVorgang={() => setVorgangDialogRequest((n) => n + 1)}
      onCreateTask={handleCreateTask}
      moreOptionsContent={moreOptionsContent}
      beforeMoreOptions={financeReferencePanel}
      experienceDetailsExtra={experienceDetailsExtra}
      letterExplanation={letterExplanation}
      translate={translate}
      sessionFillConfirmRows={fillConfirmRows}
    />
  );

  return (
    <div
      className={`page eingang-detail-page ${isEditing ? 'page--editing' : ''}`}
      data-testid="ablage-detail-page"
    >
      <button type="button" className="back-link" onClick={goBack}>
        ← {translate('common.back')}
      </button>

      {/* DOCUMENT-UNLINK-DELETE-01E — die Wege, auf die der Löschhinweis verweist. */}
      {item.vorgangId?.trim() ? (
        <div className="eingang-detail-page__unlink">
          <Button
            ref={unlinkTriggerRef}
            variant="ghost"
            onClick={() => {
              setUnlinkFailureMessage(null);
              setUnlinkConfirmOpen(true);
            }}
            data-testid="inbox-unlink-vorgang-trigger"
          >
            {translate('inbox.unlinkVorgang.action')}
          </Button>
        </div>
      ) : null}

      {item.archiveDocumentId?.trim() ? (
        <div className="eingang-detail-page__archive-link">
          <Link to={`/dokumente/${item.archiveDocumentId}`} data-testid="inbox-open-archive-document">
            {translate('inbox.openArchiveDocument')}
          </Link>
        </div>
      ) : null}

      <div className="eingang-detail-page__delete">
        <Button
          ref={deleteTriggerRef}
          variant="ghost"
          onClick={() => {
            setDeleteFailureMessage(null);
            setDeleteConfirmOpen(true);
          }}
          data-testid="inbox-delete-trigger"
        >
          {translate('inbox.delete.action')}
        </Button>
      </div>

      <SimpleConfirmDialog
        open={deleteConfirmOpen}
        title={translate('inbox.delete.confirmTitle')}
        message={translate('inbox.delete.confirmMessage')}
        confirmLabel={translate('inbox.delete.confirmButton')}
        cancelLabel={translate('common.cancel')}
        failureMessage={deleteFailureMessage ?? undefined}
        returnFocusRef={deleteTriggerRef}
        dialogTestId="inbox-delete-dialog"
        confirmTestId="inbox-delete-confirm"
        cancelTestId="inbox-delete-cancel"
        onConfirm={handleConfirmDeleteInboxItem}
        onCancel={() => {
          setDeleteConfirmOpen(false);
          setDeleteFailureMessage(null);
        }}
      />

      <SimpleConfirmDialog
        open={unlinkConfirmOpen}
        title={translate('inbox.unlinkVorgang.confirmTitle')}
        message={translate('inbox.unlinkVorgang.confirmMessage')}
        confirmLabel={translate('inbox.unlinkVorgang.confirmButton')}
        cancelLabel={translate('common.cancel')}
        failureMessage={unlinkFailureMessage ?? undefined}
        returnFocusRef={unlinkTriggerRef}
        dialogTestId="inbox-unlink-dialog"
        confirmTestId="inbox-unlink-confirm"
        cancelTestId="inbox-unlink-cancel"
        onConfirm={handleConfirmUnlinkVorgang}
        onCancel={() => {
          setUnlinkConfirmOpen(false);
          setUnlinkFailureMessage(null);
        }}
      />

      {prioritizeContractWorkspace ? (
        <>
          {/* DOCUMENT-EXPERIENCE-02: Experience first; Guidance/Letter in Details */}
          {reviewExperience}
          {originalFilePanel}
          {freeQuestionPanel}
          {fieldFillConfirmPanel}
          {confirmedReplyDraftPanel}
        </>
      ) : useAssistFlowConsolidate ? (
        <div
          className="eingang-assist-flow"
          data-testid="eingang-assist-flow"
          data-assist-flow="consolidated"
        >
          {reviewExperience}
          {fieldFillConfirmPanel}
          {freeQuestionPanel}
          {contextualNextStepsPanel}
          {confirmedReplyDraftPanel}
          {originalFilePanel}
        </div>
      ) : (
        <>
          {reviewExperience}
          {freeQuestionPanel}
          {fieldFillConfirmPanel}
          {confirmedReplyDraftPanel}
          {originalFilePanel}
        </>
      )}

      {duplicateDocument && (
        <ImportToArchiveDialog
          existingDocument={duplicateDocument}
          isImporting={isImporting}
          onSaveNew={() => finishArchiveImport('create')}
          onUpdateExisting={() => finishArchiveImport('update', duplicateDocument.id)}
          onCancel={() => setDuplicateDocument(null)}
        />
      )}
    </div>
  );
}
