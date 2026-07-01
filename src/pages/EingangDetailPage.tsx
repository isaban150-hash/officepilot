import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CompanyRelevancePanel } from '../components/inbox/CompanyRelevancePanel';
import { ContractAnalysisPanel } from '../components/inbox/ContractAnalysisPanel';
import { DocumentActionSuggestionsPanel } from '../components/inbox/DocumentActionSuggestionsPanel';
import { ImportToArchiveDialog } from '../components/inbox/ImportToArchiveDialog';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { LetterExplanationPanel } from '../components/inbox/LetterExplanationPanel';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { INBOX_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { AreaAiPanel } from '../components/ai/AreaAiPanel';
import { ScanResultPanel } from '../components/scan/ScanResultPanel';
import { SmartIntakeSummary } from '../components/inbox/SmartIntakeSummary';
import {
  createEditDraftFromItem,
  InboxItemEditForm,
  type InboxEditDraft,
} from '../components/inbox/InboxItemEditForm';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow, PageHeader } from '../components/ui/Card';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import { letterExplanationFromWorkflow } from '../services/letterExplanationService';
import { isClassificationKindWithTasks } from '../services/taskEngineService';
import { executeSmartIntake } from '../services/intakeExecutionService';
import {
  acceptSuggestedTasks,
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
import { buildScanResultView } from '../services/scanResultViewService';
import type {
  ClassifiedDocumentKind,
  CompanyDocument,
  InboxItem,
  Vorgang,
  WorkflowResultExecution,
} from '../types/models';
import type { TranslationKey } from '../i18n';

export function EingangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const [item, setItem] = useState<InboxItem | undefined>(() =>
    id ? getInboxItemById(id) : undefined,
  );
  const [showDetails, setShowDetails] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<InboxEditDraft | null>(null);
  const [duplicateDocument, setDuplicateDocument] = useState<CompanyDocument | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [vorgangDialogRequest, setVorgangDialogRequest] = useState(0);
  const [manualCategory, setManualCategory] = useState<ClassifiedDocumentKind>('sonstiges');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeExecution, setIntakeExecution] = useState<WorkflowResultExecution | null>(null);
  const [isExecutingIntake, setIsExecutingIntake] = useState(false);

  const workflow = useMemo(
    () => (item ? processUploadedDocument(item.id) : null),
    [item?.id, item?.status, item?.vorgangId, item?.importedToArchive, item?.markedAsCompanyDocument],
  );

  const scanResultView = useMemo(() => (item ? buildScanResultView(item) : null), [
    item?.id,
    item?.status,
    item?.isAdvertisement,
    item?.importedToArchive,
    item?.markedAsCompanyDocument,
    item?.recommendedAction,
    item?.vorgangId,
  ]);

  useEffect(() => {
    if (id) {
      setShowDetails(false);
      setIntakeOpen(false);
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

  const handleMarkAsCompanyDocument = () => {
    const updated = markInboxAsCompanyDocument(item.id, manualCategory);
    if (updated) {
      setItem(updated);
      showToast(translate('companyRelevance.markedSuccess'));
    }
  };

  const goBack = () => navigate('/ablage');

  const handleContractAction = (actionId: string) => {
    switch (actionId) {
      case 'create_vorgang':
      case 'import_positions':
        setVorgangDialogRequest((n) => n + 1);
        break;
      case 'archive_contract':
        handleImportToArchive();
        break;
      case 'send_freistellung':
        showToast(translate('contract.action.sendFreistellungHint'));
        break;
      case 'check_bg_bau':
        showToast(translate('contract.action.checkBgBauHint'));
        break;
      case 'send_aok':
        showToast(translate('contract.action.sendAokHint'));
        break;
      default:
        break;
    }
  };

  const startEditing = () => {
    setEditDraft(createEditDraftFromItem(item));
    setIsEditing(true);
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
      showToast(result.message);
      goBack();
    }
  };

  const handleDefer = () => {
    const result = deferItem(item.id);
    if (result) {
      showToast(result.message);
      goBack();
    }
  };

  const handleCreateTask = () => {
    const result = createTaskForItem(item.id);
    if (result) {
      showToast(result.message);
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
      showToast(result.message);
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
      showToast(result.message);
      goBack();
    }
  };

  const handleSaveAnyway = () => {
    const result = saveAdvertisementAnyway(item.id);
    if (result) {
      showToast(result.message);
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
    setIntakeOpen(false);
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

  const handleScanResultAction = (actionId: string) => {
    switch (actionId) {
      case 'filing':
        handleFiling();
        break;
      case 'dispose':
        handleDispose();
        break;
      case 'save':
        handleSaveAnyway();
        break;
      case 'assign':
        setVorgangDialogRequest((n) => n + 1);
        break;
      case 'invoice':
        if (item.vorgangId) {
          navigate(`/vorgaenge/${item.vorgangId}/rechnung`);
        } else {
          setVorgangDialogRequest((n) => n + 1);
        }
        break;
      case 'openOrder':
        if (item.vorgangId) navigate(`/vorgaenge/${item.vorgangId}`);
        break;
      default:
        break;
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

  const detailPanels = (
    <>
      <div className="badge-row">
        <Badge tone="warning">{getPriorityLabel(item.priority)}</Badge>
        <Badge>{getStatusLabel(item.status)}</Badge>
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

      {item.importedToArchive && item.archiveDocumentId && (
        <p className="archive-import-hint">
          {translate('inbox.importToArchive.viewDocument')}{' '}
          <Link to={`/dokumente/${item.archiveDocumentId}`}>
            {translate('inbox.importToArchive.openArchive')}
          </Link>
        </p>
      )}

      {intakeOpen && workflow && (
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
          onCancel={() => setIntakeOpen(false)}
        />
      )}

      <Card highlight>
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
            onShowToast={showToast}
          />

          <Card className="inbox-suggestion">
            <h3 className="section__title">{translate('inbox.officePilotSuggestion')}</h3>
            <p>{item.officePilotSuggestion}</p>
          </Card>

          <InboxVorgangPanel
            item={item}
            materialDefault={setup.materialStandard}
            onLinked={handleVorgangLinked}
            requestOpenDialog={vorgangDialogRequest}
          />

          <Card>
            <DataRow label={translate('inbox.nextTask')} value={item.nextTaskLabel} />
            <DataRow label={translate('inbox.recommendedAction')} value={translate(actionKey)} />
            <DataRow label={translate('analysis.digitalFolder')} value={item.digitalFolder.path} />
            <DataRow
              label={translate('analysis.paperFiling')}
              value={formatPaperFilingInstruction(item.paperFiling)}
            />
          </Card>
        </>
      )}

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

      <div className="security-hint">
        <strong>{translate('inbox.securityHint')}</strong>
        <p>{item.securityHint}</p>
      </div>

      <div className="action-stack">
        {!item.isAdvertisement && (
          <>
            {!item.importedToArchive && analysisAllowed && (
              <Button
                variant="secondary"
                fullWidth
                disabled={isImporting}
                onClick={handleImportToArchive}
              >
                {translate('inbox.importToArchive')}
              </Button>
            )}
            {canCreateTask && (
              <Button variant="secondary" fullWidth onClick={handleCreateTask}>
                {translate('inbox.createTask')}
              </Button>
            )}
            <Button fullWidth onClick={handleFiling}>
              {translate('inbox.confirmFiling')}
            </Button>
            <Button variant="outline" fullWidth onClick={handleDefer}>
              {translate('inbox.defer')}
            </Button>
          </>
        )}
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
    </>
  );

  const handleToggleDetails = () => {
    setShowDetails((open) => {
      if (!open) setIntakeOpen(true);
      return !open;
    });
  };

  return (
    <div
      className={`page ${isEditing ? 'page--editing' : ''}`}
      data-testid="ablage-detail-page"
    >
      <button type="button" className="back-link" onClick={goBack}>
        ← {translate('common.back')}
      </button>

      {scanResultView && !isEditing && (
        <ScanResultPanel view={scanResultView} onAction={handleScanResultAction} />
      )}

      {isEditing && editDraft ? (
        <InboxItemEditForm
          draft={editDraft}
          onChange={setEditDraft}
          onSave={saveEditing}
          onCancel={cancelEditing}
        />
      ) : (
        <ShowMoreSection
          expanded={showDetails}
          onToggle={handleToggleDetails}
          showLabel={translate('common.showMore')}
          hideLabel={translate('common.showLess')}
          testId="ablage-detail-show-more"
        >
          {showDetails && (
            <PageHeader title={item.title} subtitle={item.sender} />
          )}
          {detailPanels}
        </ShowMoreSection>
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
