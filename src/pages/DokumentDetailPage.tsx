import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentUnderstandingCard } from '../components/documents/DocumentUnderstandingCard';
import { DocumentForm } from '../components/documents/DocumentForm';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { DOCUMENT_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { AreaAiPanel } from '../components/ai/AreaAiPanel';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow } from '../components/ui/Card';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import { deleteDocument, getDocumentById } from '../services/documentService';
import { askDocumentAi } from '../services/document/documentAiService';
import type { CompanyDocument } from '../types/models';
import type { TranslationKey } from '../i18n';

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}

export function DokumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [document, setDocument] = useState<CompanyDocument | undefined>(() =>
    id ? getDocumentById(id) : undefined,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (id) {
      setDocument(getDocumentById(id));
      setIsEditing(false);
      setConfirmDelete(false);
      setShowDetails(false);
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

  const handleDelete = () => {
    const result = deleteDocument(document.id);
    if (result.success) {
      showToast(translate('document.deleted'));
      navigate('/dokumente', { replace: true });
    }
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

  const primaryActions = (
    <>
      <Button fullWidth onClick={() => navigate(`/kommunikation?context=document&id=${document.id}`)}>
        {translate('detail.action.writeMessage')}
      </Button>
      {document.linkedVorgang && (
        <Button
          variant="outline"
          fullWidth
          onClick={() => navigate(`/vorgaenge/${document.linkedVorgang!.vorgangId}`)}
        >
          {translate('detail.action.openOrder')}
        </Button>
      )}
    </>
  );

  const technicalPanels = (
    <>
      <Card className="document-detail__preview">
        <div className="document-detail__image" aria-hidden>
          {document.imagePreview ?? '📄'}
        </div>
        <p className="document-detail__preview-hint">{translate('document.previewHint')}</p>
      </Card>

      <Card>
        <DataRow label={translate('document.fieldCategory')} value={categoryLabel} />
        <DataRow label={translate('document.fieldIssuer')} value={document.issuer || '—'} />
        <DataRow
          label={translate('document.fieldValidity')}
          value={`${formatDate(document.issueDate)} – ${formatDate(document.validUntil)}`}
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
        {document.recognizedText && (
          <DataRow
            label={translate('document.fieldRecognizedText')}
            value={document.recognizedText}
          />
        )}
      </Card>

      <CommunicationIntegrationPanel
        contextRef={{ type: 'document', id: document.id }}
        buttonKeys={DOCUMENT_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="dokument"
      />

      <AreaAiPanel
        title={translate('detail.askDocument')}
        placeholder={translate('detail.askPlaceholder')}
        askLabel={translate('areaAi.ask')}
        loadingLabel={translate('areaAi.loading')}
        notConfiguredLabel={translate('areaAi.notConfigured')}
        testIdPrefix="document-ai"
        onAsk={(question) =>
          askDocumentAi({ source: { type: 'document', document }, question })
        }
      />

      <div className="form-actions document-detail__actions">
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          {translate('document.edit')}
        </Button>
        {!confirmDelete ? (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            {translate('document.delete')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {translate('common.cancel')}
            </Button>
            <Button variant="danger" onClick={handleDelete}>
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
        actions={primaryActions}
        testId="document-detail-experience"
      />

      <DocumentUnderstandingCard documentId={document.id} />

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
