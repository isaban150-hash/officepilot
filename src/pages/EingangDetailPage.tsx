import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentActionSuggestionsPanel } from '../components/inbox/DocumentActionSuggestionsPanel';
import { ImportToArchiveDialog } from '../components/inbox/ImportToArchiveDialog';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { LetterExplanationPanel } from '../components/inbox/LetterExplanationPanel';
import {
  createEditDraftFromItem,
  InboxItemEditForm,
  type InboxEditDraft,
} from '../components/inbox/InboxItemEditForm';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/analysisService';
import { getClassifiedKindFromItem } from '../services/documentClassificationService';
import { getLetterExplanation } from '../services/letterExplanationService';
import {
  importInboxDocument,
  isDuplicateDocument,
  updateDocumentFromInbox,
} from '../services/documentService';
import {
  confirmDispose,
  confirmFiling,
  createTaskForItem,
  deferItem,
  getInboxItemById,
  getPriorityLabel,
  getStatusLabel,
  markInboxImportedToArchive,
  saveAdvertisementAnyway,
  updateInboxItemRecognizedData,
} from '../services/inboxService';
import type { CompanyDocument, InboxItem, Vorgang } from '../types/models';
import type { TranslationKey } from '../i18n';

export function EingangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const [item, setItem] = useState<InboxItem | undefined>(() =>
    id ? getInboxItemById(id) : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<InboxEditDraft | null>(null);
  const [duplicateDocument, setDuplicateDocument] = useState<CompanyDocument | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [vorgangDialogRequest, setVorgangDialogRequest] = useState(0);

  useEffect(() => {
    if (id) {
      setItem(getInboxItemById(id));
      setIsEditing(false);
      setEditDraft(null);
    }
  }, [id]);

  useEffect(() => {
    if (id && !getInboxItemById(id)) {
      navigate('/eingang', { replace: true });
    }
  }, [id, navigate]);

  if (!item) return null;

  const docTypeKey = `docType.${item.documentType}` as TranslationKey;
  const classifiedKindKey = `classifiedKind.${getClassifiedKindFromItem(item)}` as TranslationKey;
  const actionKey = `action.${item.recommendedAction}` as TranslationKey;
  const letterExplanation = getLetterExplanation(item);

  const goBack = () => navigate('/eingang');

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
    } else {
      showToast('Für dieses Dokument ist keine Aufgabe vorgesehen.');
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

  return (
    <div className={`page ${isEditing ? 'page--editing' : ''}`}>
      <button type="button" className="back-link" onClick={goBack}>
        ← {translate('common.back')}
      </button>

      {item.isNewUpload && !isEditing && (
        <div className="upload-recognized-banner">
          {translate('inbox.uploadRecognized')}
        </div>
      )}

      <PageHeader title={item.title} subtitle={item.sender} />

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

      {isEditing && editDraft ? (
        <InboxItemEditForm
          draft={editDraft}
          onChange={setEditDraft}
          onSave={saveEditing}
          onCancel={cancelEditing}
        />
      ) : (
        <>
          <Card highlight>
            <div className="card-section-header">
              <h3 className="section__title">{translate('inbox.recognizedData')}</h3>
              <Button variant="outline" onClick={startEditing}>
                {translate('inbox.edit.start')}
              </Button>
            </div>
            {item.sourceFileName && (
              <DataRow label={translate('inbox.sourceDocument')} value={item.sourceFileName} />
            )}
            <DataRow label={translate('inbox.documentType')} value={translate(docTypeKey)} />
            <DataRow label={translate('classification.documentKind')} value={translate(classifiedKindKey)} />
            <DataRow label={translate('inbox.sender')} value={item.sender} />
            {item.vorgangTitle && (
              <DataRow label={translate('analysis.vorgang')} value={item.vorgangTitle} />
            )}
            {Object.entries(item.recognizedData).map(([key, value]) => (
              <DataRow key={key} label={key} value={value} />
            ))}
            {item.deadline && (
              <DataRow label={translate('analysis.deadline')} value={item.deadline} />
            )}
          </Card>

          {letterExplanation && <LetterExplanationPanel explanation={letterExplanation} />}

          <DocumentActionSuggestionsPanel
            item={item}
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

          <div className="security-hint">
            <strong>{translate('inbox.securityHint')}</strong>
            <p>{item.securityHint}</p>
          </div>

          <div className="action-stack">
            {!item.isAdvertisement && (
              <>
                {!item.importedToArchive && (
                  <Button
                    variant="secondary"
                    fullWidth
                    disabled={isImporting}
                    onClick={handleImportToArchive}
                  >
                    {translate('inbox.importToArchive')}
                  </Button>
                )}
                <Button fullWidth onClick={handleFiling}>
                  {translate('inbox.confirmFiling')}
                </Button>
                {item.taskTemplate && (
                  <Button variant="secondary" fullWidth onClick={handleCreateTask}>
                    {translate('inbox.createTask')}: {item.taskTemplate.title}
                  </Button>
                )}
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
