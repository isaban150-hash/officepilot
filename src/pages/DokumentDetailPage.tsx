import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentArchiveTruthFactsCard } from '../components/documents/DocumentArchiveTruthFactsCard';
import { DocumentUnderstandingCard } from '../components/documents/DocumentUnderstandingCard';
import { DocumentDetailPreview } from '../components/documents/DocumentDetailPreview';
import { DocumentDerivativeRecoveryStatusPanel } from '../components/documents/DocumentDerivativeRecoveryStatusPanel';
import { DocumentOriginalFilePanel } from '../components/documents/DocumentOriginalFilePanel';
import { DocumentFilingCard } from '../components/documents/DocumentFilingCard';
import { DocumentLifecycleCard } from '../components/documents/DocumentLifecycleCard';
import { DocumentForm } from '../components/documents/DocumentForm';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { DOCUMENT_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { DocumentFreeQuestionPanel } from '../components/documents/DocumentFreeQuestionPanel';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow } from '../components/ui/Card';
import { FileTypeIcon } from '../components/ui/FileTypeIcon';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import { deleteDocument, getDocumentById } from '../services/documentService';
import { unlinkInboxItemFromVorgang } from '../services/vorgangService';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { resolveDocumentLifecycle } from '../services/documentLifecycleService';
import { recordDocumentContext } from '../services/brain/companySessionService';
import type { CompanyDocument } from '../types/models';
import type { TranslationKey } from '../i18n';
import {
  formatSafeDocumentDate,
  formatDocumentValidUntil,
} from '../utils/documentDateDisplay';

export function DokumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const [document, setDocument] = useState<CompanyDocument | undefined>(() =>
    id ? getDocumentById(id) : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);

  useEffect(() => {
    if (id) {
      setDocument(getDocumentById(id));
      setIsEditing(false);
      setConfirmDelete(false);
      setShowDetails(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      recordDocumentContext(id);
    }
  }, [id]);

  useEffect(() => {
    if (id && !getDocumentById(id)) {
      navigate('/dokumente', { replace: true });
    }
  }, [id, navigate]);

  if (!document) return null;

  const categoryKey = `document.category.${document.category}` as TranslationKey;
  const categoryLabel = translate(categoryKey);
  const paperInstruction = formatPaperFilingInstruction(document.paperFolder);

  /**
   * DOCUMENT-UNLINK-DELETE-01G — derselbe atomare Service wie im Eingang, nur
   * hier erreichbar: ein archiviertes Dokument ist dort ausgeblendet, der
   * Nutzer steht auf dieser Seite. Gelöst wird nur die Zuordnung; der Vorgang
   * und ein bestätigter Auftrag bleiben unverändert, gelöscht wird nichts.
   */
  const handleConfirmUnlinkVorgang = (): boolean => {
    const origin = document.sourceInboxItemId?.trim();
    if (!origin) return false;

    const result = unlinkInboxItemFromVorgang(origin);
    if (!result.success) {
      setUnlinkError(translate(result.errorKey as TranslationKey));
      return false;
    }
    // Der Store ist die Wahrheit — die Seite liest ihn neu, statt zu raten.
    setDocument(getDocumentById(document.id));
    setUnlinkConfirmOpen(false);
    setUnlinkError(null);
    showToast(translate('inbox.unlinkVorgang.success'));
    return true;
  };

  const handleDelete = () => {
    const result = deleteDocument(document.id);
    if (result.success) {
      showToast(translate('document.deleted'));
      navigate('/dokumente', { replace: true });
      return;
    }
    // Der Guard im Service ist die Wahrheit — hier wird sein Grund nur sichtbar.
    setDeleteError(translate(result.errorKey as TranslationKey));
    setConfirmDelete(false);
  };

  if (isEditing) {
    return (
      <div className="page">
        <button type="button" className="back-link" onClick={() => setIsEditing(false)}>
          ← {translate('common.back')}
        </button>
        <DetailExperienceCard
          recognizedTitle={document.title}
          recognizedSummary={categoryLabel}
          assistantMessage={translate('document.experience.editing')}
          paperInstruction={paperInstruction}
          testId="document-detail-experience"
        />
        <DocumentForm
          mode="edit"
          document={document}
          onSaved={(updated) => {
            setDocument(updated);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      </div>
    );
  }

  const lifecycle = resolveDocumentLifecycle({ documentId: document.id });
  const openReasons = lifecycle?.openReasons ?? [];
  const lifecycleResolved = lifecycle != null;
  const replyOpen = lifecycleResolved && openReasons.includes('reply_open');
  const fileOriginalOpen = lifecycleResolved && openReasons.includes('file_original');
  const otherOpen =
    lifecycleResolved && openReasons.length > 0 && !replyOpen && !fileOriginalOpen;
  /** Fallback when lifecycle cannot be resolved: keep previous Experience reply CTA. */
  const showReplyPrimary = replyOpen || !lifecycleResolved;
  const filingMarkPrimary = Boolean(fileOriginalOpen && !replyOpen);

  const openOrderButton = document.linkedVorgang ? (
    <Button
      key="open-order"
      variant="outline"
      fullWidth
      data-testid="document-detail-open-order"
      onClick={() => navigate(`/vorgaenge/${document.linkedVorgang!.vorgangId}`)}
    >
      {translate('detail.action.openOrder')}
    </Button>
  ) : null;

  const replyButton = (
    <Button
      key="reply"
      fullWidth
      data-testid="document-detail-reply-action"
      onClick={() => navigate(`/kommunikation?context=document&id=${document.id}`)}
    >
      {translate('detail.action.writeMessage')}
    </Button>
  );

  let experienceActions: ReactNode;
  if (showReplyPrimary) {
    experienceActions = (
      <>
        {replyButton}
        {openOrderButton}
      </>
    );
  } else if (fileOriginalOpen) {
    experienceActions = openOrderButton;
  } else if (otherOpen) {
    experienceActions = (
      <>
        <p
          className="detail-experience-section__value detail-experience-section__value--assistant"
          data-testid="document-detail-next-step"
        >
          {lifecycle.nextStep}
        </p>
        {openOrderButton}
      </>
    );
  } else {
    experienceActions = openOrderButton;
  }

  const technicalPanels = (
    <>
      <Card className="document-detail__preview">
        <DocumentDetailPreview documentId={document.id} revision={previewRevision} />
        {document.fileRefId ? (
          <DocumentOriginalFilePanel
            fileRefId={document.fileRefId}
            translate={translate}
            onPromoted={() => showToast(translate('document.original.promote.success'))}
          />
        ) : (
          <>
            <div className="document-detail__image">
              {document.imagePreview ? (
                <span aria-hidden>{document.imagePreview}</span>
              ) : (
                <FileTypeIcon
                  mimeType={document.mimeType}
                  fileName={document.title}
                  size="lg"
                />
              )}
            </div>
            <p className="document-detail__preview-hint">{translate('document.previewHint')}</p>
          </>
        )}
      </Card>

      <DocumentDerivativeRecoveryStatusPanel
        documentId={document.id}
        onRecovered={() => setPreviewRevision((value) => value + 1)}
      />

      <Card>
        <DataRow label={translate('document.fieldCategory')} value={categoryLabel} />
        <DataRow label={translate('document.fieldIssuer')} value={document.issuer || '—'} />
        <DataRow
          label={translate('document.fieldValidity')}
          value={`${
            document.issueDate
              ? formatSafeDocumentDate(
                  document.issueDate,
                  setup.language,
                  translate('document.date.unrecognized'),
                )
              : '—'
          } – ${
            formatDocumentValidUntil(document.validUntil, setup.language) ?? '—'
          }`}
        />
        <DataRow
          label={translate('document.fieldDigitalFolder')}
          value={`${document.digitalFolder.name} (${document.digitalFolder.path})`}
        />
        {document.linkedCompany && (
          <DataRow label={translate('document.fieldLinkedCompany')} value={document.linkedCompany} />
        )}
        {document.linkedVorgang && (
          <DataRow
            label={translate('document.fieldLinkedVorgang')}
            value={
              <Link to={`/vorgaenge/${document.linkedVorgang.vorgangId}`}>
                {document.linkedVorgang.vorgangTitle}
              </Link>
            }
          />
        )}
        {document.linkedInvoiceId && document.linkedVorgang && (
          <DataRow
            label={translate('document.fieldLinkedInvoice')}
            value={
              <>
                <Link
                  to={`/vorgaenge/${document.linkedVorgang.vorgangId}/rechnungen/${document.linkedInvoiceId}?from=overview`}
                >
                  {translate('document.openInvoice')}
                </Link>
                {' · '}
                <Link to="/rechnungen/offen">{translate('overview.title')}</Link>
              </>
            }
          />
        )}
        {document.tags.length > 0 && (
          <div className="badge-row document-detail__tags">
            {document.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
        {/*
          Der erkannte Rohtext wird hier bewusst nicht mehr ausgegeben: Er war
          für den Nutzer keine Information, sondern eine Wand, durch die er bis
          zu den Aktionen scrollen musste. Der Text bleibt vollständig auf der
          Entität — Klassifikation, Suche, Contract Intelligence und die freien
          Dokumentfragen lesen ihn dort. Korrigieren lässt er sich weiterhin im
          Bearbeiten-Modus (DocumentForm).
        */}
      </Card>

      <DocumentLifecycleCard documentId={document.id} revision={detailRevision} />

      <CommunicationIntegrationPanel
        contextRef={{ type: 'document', id: document.id }}
        buttonKeys={DOCUMENT_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="dokument"
      />

      {deleteError ? (
        <p className="error-text" data-testid="document-delete-blocked">
          {deleteError}
        </p>
      ) : null}
      {/* Nur wenn es eine aktive Zuordnung gibt und der Eingangsbezug bekannt ist. */}
      {document.linkedVorgang && document.sourceInboxItemId?.trim() ? (
        <div className="form-actions document-detail__unlink">
          <Button
            variant="ghost"
            onClick={() => {
              setUnlinkError(null);
              setUnlinkConfirmOpen(true);
            }}
            data-testid="document-unlink-vorgang-trigger"
          >
            {translate('inbox.unlinkVorgang.action')}
          </Button>
        </div>
      ) : null}
      <SimpleConfirmDialog
        open={unlinkConfirmOpen}
        title={translate('inbox.unlinkVorgang.confirmTitle')}
        message={translate('inbox.unlinkVorgang.confirmMessage')}
        confirmLabel={translate('inbox.unlinkVorgang.confirmButton')}
        cancelLabel={translate('common.cancel')}
        failureMessage={unlinkError ?? undefined}
        dialogTestId="document-unlink-dialog"
        confirmTestId="document-unlink-confirm"
        cancelTestId="document-unlink-cancel"
        onConfirm={handleConfirmUnlinkVorgang}
        onCancel={() => {
          setUnlinkConfirmOpen(false);
          setUnlinkError(null);
        }}
      />
      <div className="form-actions document-detail__actions">
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          {translate('document.edit')}
        </Button>
        {!confirmDelete ? (
          <Button
            variant="danger"
            data-testid="document-detail-delete-trigger"
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
          >
            {translate('document.delete')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {translate('common.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="document-detail-delete-confirm"
              onClick={handleDelete}
            >
              {translate('document.deleteConfirm')}
            </Button>
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="page document-detail-page" data-testid="document-detail-page">
      <button type="button" className="back-link" onClick={() => navigate('/dokumente')}>
        ← {translate('common.back')}
      </button>

      <DetailExperienceCard
        recognizedTitle={document.title}
        recognizedSummary={categoryLabel}
        assistantMessage={translate('document.experience.saved')}
        paperInstruction={paperInstruction}
        actions={experienceActions}
        testId="document-detail-experience"
      />

      <DocumentArchiveTruthFactsCard document={document} />

      <DocumentUnderstandingCard documentId={document.id} />

      <DocumentFilingCard
        documentId={document.id}
        markFiledVariant={filingMarkPrimary ? 'primary' : 'outline'}
        onChanged={() => setDetailRevision((value) => value + 1)}
      />

      <DocumentFreeQuestionPanel
        source={{ type: 'document', document }}
        testIdPrefix="document-free-question"
      />

      <ShowMoreSection
        expanded={showDetails}
        onToggle={() => setShowDetails((open) => !open)}
        showLabel={translate('common.showMore')}
        hideLabel={translate('common.showLess')}
        testId="document-detail-show-more"
      >
        {technicalPanels}
      </ShowMoreSection>
    </div>
  );
}
