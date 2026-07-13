import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentAssistantPanel } from '../components/documents/DocumentAssistantPanel';
import { CompanyRelevancePanel } from '../components/inbox/CompanyRelevancePanel';
import { ContractAnalysisPanel } from '../components/inbox/ContractAnalysisPanel';
import { DocumentActionSuggestionsPanel } from '../components/inbox/DocumentActionSuggestionsPanel';
import { ImportToArchiveDialog } from '../components/inbox/ImportToArchiveDialog';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { LetterExplanationPanel } from '../components/inbox/LetterExplanationPanel';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { INBOX_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { AreaAiPanel } from '../components/ai/AreaAiPanel';
import { SmartIntakeSummary } from '../components/inbox/SmartIntakeSummary';
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
import { letterExplanationFromWorkflow } from '../services/letterExplanationService';
import { getInboxExtractedDocumentText } from '../services/inboxDocumentText';
import { isClassificationKindWithTasks } from '../services/taskEngineService';
import { executeSmartIntake } from '../services/intakeExecutionService';
import {
  acceptSuggestedTasks,
  createVorgangFromInboxWithContract,
  createWorkflowVorgang,
  importSuggestedPositionsToVorgang,
  linkWorkflowVorgang,
  processUploadedDocument,
} from '../services/intakeWorkflowService';
import {
  importInboxDocument,
  isDuplicateDocument,
  updateDocumentFromInbox,
} from '../services/documentService';
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
import { askDocumentAi } from '../services/document/documentAiService';
import { recordInboxContext } from '../services/brain/companySessionService';
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
  WorkflowResultExecution,
} from '../types/models';
import type { TranslationKey } from '../i18n';

type ReviewSectionId =
  | 'document-data'
  | 'ocr-text'
  | 'communication'
  | 'tasks'
  | 'positions'
  | 'archive'
  | 'technical';

export function EingangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const [item, setItem] = useState<InboxItem | undefined>(() =>
    id ? getInboxItemById(id) : undefined,
  );
  const [moreOptionsExpanded, setMoreOptionsExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Partial<Record<ReviewSectionId, boolean>>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<InboxEditDraft | null>(null);
  const [duplicateDocument, setDuplicateDocument] = useState<CompanyDocument | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [vorgangDialogRequest, setVorgangDialogRequest] = useState(0);
  const [manualCategory, setManualCategory] = useState<ClassifiedDocumentKind>('sonstiges');
  const [intakeExecution, setIntakeExecution] = useState<WorkflowResultExecution | null>(null);
  const [isExecutingIntake, setIsExecutingIntake] = useState(false);
  const [isCreatingContractOrder, setIsCreatingContractOrder] = useState(false);

  const workflow = useMemo(
    () => (item ? processUploadedDocument(item.id) : null),
    [item?.id, item?.status, item?.vorgangId, item?.importedToArchive, item?.markedAsCompanyDocument],
  );

  useEffect(() => {
    if (id) {
      setMoreOptionsExpanded(false);
      setExpandedSections({});
      setIntakeExecution(null);
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      setItem(getInboxItemById(id));
      setIsEditing(false);
      setEditDraft(null);
    }
  }, [id]);

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

  if (!item || !workflow) return null;

  const docTypeKey = `docType.${item.documentType}` as TranslationKey;
  const actionKey = `action.${item.recommendedAction}` as TranslationKey;
  const relevance = workflow.companyRelevance;
  const analysisAllowed = workflow.companyRelevant;
  const classifiedKind = workflow.classifiedKind;
  const classifiedKindKey = `classifiedKind.${classifiedKind}` as TranslationKey;
  const canCreateTask =
    analysisAllowed &&
    (Boolean(item.taskTemplate) || isClassificationKindWithTasks(classifiedKind));
  const letterExplanation = letterExplanationFromWorkflow(workflow.documentExplanation);
  const contractAnalysis = workflow.contractAnalysis;
  const extractedText = getInboxExtractedDocumentText(item);

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

  const goBack = () => navigate('/ablage');

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
    if (result) {
      showToast(formatInboxActionToast(result, translate));
      goBack();
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
          ? importInboxDocument(item, setup.companyName)
          : updateDocumentFromInbox(existingDocumentId!, item, setup.companyName);

      if (!result.success) {
        showToast(translate(result.errorKey as TranslationKey));
        return;
      }

      const archiveResult = markInboxImportedToArchive(item.id, result.document.id);
      if (!archiveResult) {
        showToast(translate('inbox.importToArchive.markFailed'));
        return;
      }

      setItem(archiveResult.item);
      showToast(translate('inbox.importToArchive.success'));
      setDuplicateDocument(null);
      navigate(`/dokumente/${result.document.id}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportToArchive = () => {
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
    handleImportToArchive();
  };

  const handleIntakeCreateVorgang = () => {
    if (workflow?.suggestedVorgang) {
      const linked = linkWorkflowVorgang(item, workflow.suggestedVorgang.vorgangId);
      if (linked) {
        setItem(linked.inbox);
        showToast(translate('vorgang.link.success'));
        return;
      }
    }

    const result = createWorkflowVorgang(item, setup.materialStandard);
    if (result) {
      setItem(result.inbox);
      showToast(translate('vorgang.create.success'));
    } else {
      setVorgangDialogRequest((n) => n + 1);
    }
  };

  const handleIntakeImportPositions = () => {
    const vorgangId = item.vorgangId ?? workflow?.suggestedVorgang?.vorgangId;
    if (!vorgangId || !workflow) {
      setVorgangDialogRequest((n) => n + 1);
      showToast(translate('intake.positionsNeedsVorgang'));
      return;
    }
    const result = importSuggestedPositionsToVorgang(vorgangId, workflow.suggestedOrderPositions);
    if (result.success) {
      showToast(translate('intake.positionsImported').replace('{count}', String(result.added)));
      refreshWorkflowItem();
    }
  };

  const handleIntakeAcceptTasks = () => {
    if (!workflow || workflow.suggestedTasks.length === 0) return;
    const created = acceptSuggestedTasks(workflow.suggestedTasks);
    if (created.length > 0) {
      showToast(translate('intake.tasksAccepted').replace('{count}', String(created.length)));
      refreshWorkflowItem();
    }
  };

  const handleExecuteAll = () => {
    if (!workflow) return;
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
      if (result.completed) {
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

  const handleOpenVorgang = () => {
    const vorgangId = intakeExecution?.vorgangId ?? item.vorgangId;
    if (vorgangId) navigate(`/vorgaenge/${vorgangId}`);
  };

  const handleCreateContractOrder = () => {
    if (!item || !workflow?.contractOrderProposal) return;
    setIsCreatingContractOrder(true);
    try {
      const result = createVorgangFromInboxWithContract(item, undefined, setup.materialStandard);
      if (!result) {
        showToast(translate('documentIntelligence.createOrderFailed'));
        return;
      }
      setItem(result.inbox);
      setIntakeExecution({
        completed: true,
        successSteps: ['create_vorgang'],
        failedSteps: [],
        warnings: [],
        vorgangId: result.vorgang.id,
        inboxItem: result.inbox,
        tasksCreated: 0,
        positionsAdded: workflow.contractOrderProposal.positionCount,
        pendingSummary: null,
      });
      showToast(translate('documentIntelligence.createOrderSuccess').replace(
        '{count}',
        String(workflow.contractOrderProposal.positionCount),
      ));
    } finally {
      setIsCreatingContractOrder(false);
    }
  };

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

      <CollapsibleReviewSection
        id="communication"
        title={translate('reviewWorkflow.section.communication')}
        expanded={Boolean(expandedSections.communication)}
        onToggle={() => toggleSection('communication')}
      >
        <CommunicationIntegrationPanel
          contextRef={{ type: 'inbox', id: item.id }}
          buttonKeys={INBOX_COMMUNICATION_BUTTON_KEYS}
          testIdPrefix="eingang"
        />
        <AreaAiPanel
          title={translate('detail.askLetter')}
          placeholder={translate('areaAi.placeholder')}
          askLabel={translate('areaAi.ask')}
          loadingLabel={translate('areaAi.loading')}
          notConfiguredLabel={translate('areaAi.notConfigured')}
          testIdPrefix="inbox-ai"
          onAsk={(question) => askDocumentAi({ source: { type: 'inbox', item }, question })}
        />
      </CollapsibleReviewSection>

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

      {workflow.suggestedOrderPositions.length > 0 && (
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
            <Button variant="outline" fullWidth onClick={handleIntakeImportPositions}>
              {translate('intake.action.importPositions')}
            </Button>
          </Card>
        </CollapsibleReviewSection>
      )}

      <CollapsibleReviewSection
        id="archive"
        title={translate('reviewWorkflow.section.archive')}
        expanded={Boolean(expandedSections.archive)}
        onToggle={() => toggleSection('archive')}
      >
        <Card>
          <DataRow label={translate('analysis.digitalFolder')} value={item.digitalFolder.path} />
          <DataRow
            label={translate('analysis.paperFiling')}
            value={formatPaperFilingInstruction(item.paperFiling, setup.language)}
          />
          <DataRow label={translate('inbox.nextTask')} value={item.nextTaskLabel} />
          <DataRow label={translate('inbox.recommendedAction')} value={translate(actionKey)} />
          {!item.importedToArchive && analysisAllowed && (
            <Button
              variant="outline"
              fullWidth
              disabled={isImporting}
              onClick={handleImportToArchive}
            >
              {translate('inbox.importToArchive')}
            </Button>
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

        {analysisAllowed && letterExplanation && (
          <LetterExplanationPanel explanation={letterExplanation} />
        )}

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

        {analysisAllowed && (
          <>
            <DocumentActionSuggestionsPanel
              item={item}
              classification={workflow.classification ?? undefined}
              suggestedVorgang={workflow.suggestedVorgang ?? undefined}
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

            <InboxVorgangPanel
              item={item}
              materialDefault={setup.materialStandard}
              onLinked={handleVorgangLinked}
              requestOpenDialog={vorgangDialogRequest}
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
            />
          </>
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
    </>
  );

  return (
    <div
      className={`page eingang-detail-page ${isEditing ? 'page--editing' : ''}`}
      data-testid="ablage-detail-page"
    >
      <button type="button" className="back-link" onClick={goBack}>
        ← {translate('common.back')}
      </button>

      <DocumentAssistantPanel
        item={item}
        workflow={workflow}
        translate={translate}
        language={setup.language}
        showChangeType
        onChangeType={() => {
          setMoreOptionsExpanded(true);
          setExpandedSections((current) => ({ ...current, technical: true }));
        }}
        onAskAi={async (question) => {
          const answer = await askDocumentAi({ source: { type: 'inbox', item }, question });
          return { text: answer.text, uncertain: answer.source !== 'ai' };
        }}
      />

      <DocumentReviewExperience
        item={item}
        workflow={workflow}
        executionResult={intakeExecution}
        isExecuting={isExecutingIntake}
        moreOptionsExpanded={moreOptionsExpanded}
        onToggleMoreOptions={() => setMoreOptionsExpanded((open) => !open)}
        onApplySuggestion={handleApplySuggestion}
        onCreateContractOrder={handleCreateContractOrder}
        isCreatingContractOrder={isCreatingContractOrder}
        onOpenVorgang={handleOpenVorgang}
        onNextDocument={goBack}
        moreOptionsContent={moreOptionsContent}
        translate={translate}
      />

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
