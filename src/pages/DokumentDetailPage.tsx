import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentForm } from '../components/documents/DocumentForm';
import { Button } from '../components/ui/Button';
import { Badge, Card, DataRow, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/analysisService';
import { deleteDocument, getDocumentById } from '../services/documentService';
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

  useEffect(() => {
    if (id) {
      setDocument(getDocumentById(id));
      setIsEditing(false);
      setConfirmDelete(false);
    }
  }, [id]);

  useEffect(() => {
    if (id && !getDocumentById(id)) {
      navigate('/dokumente', { replace: true });
    }
  }, [id, navigate]);

  if (!document) return null;

  const categoryKey = `document.category.${document.category}` as TranslationKey;

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
        <PageHeader title={translate('document.editTitle')} subtitle={document.title} />
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

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => navigate('/dokumente')}>
        ← {translate('common.back')}
      </button>

      <PageHeader title={document.title} subtitle={translate(categoryKey)} />

      <Card className="document-detail__preview">
        <div className="document-detail__image" aria-hidden>
          {document.imagePreview ?? '📄'}
        </div>
        <p className="document-detail__preview-hint">{translate('document.previewHint')}</p>
      </Card>

      <Card>
        <DataRow label={translate('document.fieldCategory')} value={translate(categoryKey)} />
        <DataRow label={translate('document.fieldIssuer')} value={document.issuer || '—'} />
        <DataRow
          label={translate('document.fieldValidity')}
          value={`${formatDate(document.issueDate)} – ${formatDate(document.validUntil)}`}
        />
        <DataRow
          label={translate('document.fieldPaperFolder')}
          value={formatPaperFilingInstruction(document.paperFolder)}
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
              <Link
                to={`/vorgaenge/${document.linkedVorgang.vorgangId}/rechnungen/${document.linkedInvoiceId}`}
              >
                {translate('document.openInvoice')}
              </Link>
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
    </div>
  );
}
