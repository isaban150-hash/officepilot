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
import {
  createEditDraftFromItem,
  InboxItemEditForm,
  type InboxEditDraft,
} from '../components/inbox/InboxItemEditForm';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow } from '../components/ui/Card';
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
  createWorkflowVorgang,
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
import { getVorgangById } from '../services/vorgangService';
import type { EnhancedDetectedOrderPosition } from '../types/documentIntelligence';
import {
  importInboxDocument,
  isDuplicateDocument,
  updateDocumentFromInbox,
} from '../services/documentService';
import { resolveImportInboxDocumentOptionsFromIntakeCarry } from '../services/documentFileIntakeTransformPlanCarryContextService';
import {
  confirmDispose,
  deferItem,
  getInboxItemById,
  getPriorityLabel,
  getStatusLabel,
  markInboxAsCompanyDocument,
  markInboxImportedToArchive,
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

export function EingangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup } = useApp();
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
  const [vorgangDialogRequest, setVorgangDialogRequest] = useState(0);
  const [manualCategory, setManualCategory] = useState<ClassifiedDocumentKind>('sonstiges');
  const [intakeExecution, setIntakeExecution] = useState<WorkflowResultExecution | null>(null);
  const [isExecutingIntake, setIsExecutingIntake] = useState(false);
  const [isCreatingContractOrder, setIsCreatingContractOrder] = useState(false);
  const [deferredWorkflow, setDeferredWorkflow] = useState<WorkflowResult | null>(null);
  const [deferredStatus, setDeferredStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [analysisRetryToken, setAnalysisRetryToken] = useState(0);
  const [freeTextBridgeProposal, setFreeTextBridgeProposal] =
    useState<DocumentFieldFillFreeTextBridgeProposal | null>(null);
  const freeTextBridgeSeqRef = useRef(0);

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
      values: editDraft
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
        : {},
      dirty: Boolean(isEditing && editDraft),
    },
  });

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
      const result =
        mode === 'create'
          ? importInboxDocument(
              item,
              setup.companyName,
              resolveImportInboxDocumentOptionsFromIntakeCarry(item.id),
            )
          : updateDocumentFromInbox(existingDocumentId!, item, setup.companyName);

      if (!result.success) {
        showToast(translate(result.errorKey as TranslationKey));
        revealArchiveImportUi();
        return;
      }

      const archiveResult = markInboxImportedToArchive(item.id, result.document.id);
      if (!archiveResult) {
        showToast(translate('inbox.importToArchive.markFailed'));
        revealArchiveImportUi();
        return;
      }

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
    const duplicate = isDuplicateDocument(item, setup.companyName);
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

    const result = createWorkflowVorgang(item, setup.materialStandard);
    if (result) {
      setItem(result.inbox);
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
      } else {
        showToast(translate('vorgang.create.success'));
      }
    } else {
      setVorgangDialogRequest((n) => n + 1);
    }
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
      const duplicate = isDuplicateDocument(item, setup.companyName);
      const result = executeSmartIntake(workflow, {
        companyName: setup.companyName,
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
    if (!item || !workflow?.contractOrderProposal) return;
    if (positionsImportLocked) {
      showToast(translate('order_plan_amendment_required'));
      return;
    }
    if (!setup.companyName?.trim()) {
      showToast(translate('documentIntelligence.createOrderFailed'));
      return;
    }
    setIsCreatingContractOrder(true);
    try {
      const result = acceptContractOrderFromProposal({
        item,
        proposal: workflow.contractOrderProposal,
        selectedPositions,
        companyName: setup.companyName,
        materialStandard: setup.materialStandard,
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
        const maybeKey = result.errorKey as TranslationKey;
        showToast(
          maybeKey.includes('.') ? translate(maybeKey) : result.errorKey,
        );
        return;
      }
      setItem(result.inbox);
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
      setIsCreatingContractOrder(false);
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
      onDiscardContractProposal={handleDiscardContractProposal}
      onContractInquiry={handleContractInquiry}
      isCreatingContractOrder={isCreatingContractOrder}
      onOpenVorgang={handleOpenVorgang}
      onOpenArchive={handleOpenArchive}
      onNextDocument={goBack}
      onLinkVorgang={() => setVorgangDialogRequest((n) => n + 1)}
      onCreateTask={handleCreateTask}
      moreOptionsContent={moreOptionsContent}
      beforeMoreOptions={null}
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
