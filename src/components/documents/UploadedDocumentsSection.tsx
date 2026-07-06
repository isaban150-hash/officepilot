import { Link } from 'react-router-dom';
import { Badge, Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { formatFileSize } from '../../services/documentUploadValidation';
import type { UploadedDocument } from '../../types/uploadedDocument';

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

interface UploadedDocumentsSectionProps {
  items: UploadedDocument[];
}

export function UploadedDocumentsSection({ items }: UploadedDocumentsSectionProps) {
  const { translate } = useApp();

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="uploaded-documents-section" data-testid="uploaded-documents-section">
      <h2 className="uploaded-documents-section__title">{translate('document.upload.listTitle')}</h2>
      <div className="uploaded-documents-table-wrap">
        <table className="uploaded-documents-table" data-testid="uploaded-documents-table">
          <thead>
            <tr>
              <th>{translate('document.upload.fileName')}</th>
              <th>{translate('document.upload.fileType')}</th>
              <th>{translate('document.upload.fileSize')}</th>
              <th>{translate('document.upload.uploadedAt')}</th>
              <th>{translate('document.upload.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((doc) => (
              <tr key={doc.id} data-testid={`uploaded-document-row-${doc.id}`}>
                <td>{doc.fileName}</td>
                <td>{doc.fileType || '—'}</td>
                <td>{formatFileSize(doc.fileSize)}</td>
                <td>{formatDate(doc.uploadedAt)}</td>
                <td>
                  <Badge tone={doc.status === 'needs_review' ? 'warning' : 'info'}>{doc.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-list uploaded-documents-cards">
        {items.map((doc) => (
          <Card key={doc.id} data-testid={`uploaded-document-card-${doc.id}`}>
            <CardTitle>{doc.fileName}</CardTitle>
            <CardMeta>
              {formatFileSize(doc.fileSize)} · {formatDate(doc.uploadedAt)}
            </CardMeta>
            <Badge tone={doc.status === 'needs_review' ? 'warning' : 'info'}>{doc.status}</Badge>
          </Card>
        ))}
      </div>
    </section>
  );
}

export function UploadedDocumentsEmptyHint() {
  const { translate } = useApp();
  return (
    <p className="uploaded-documents-empty-hint">
      <Link to="/dokumente/upload">{translate('document.upload.emptyHint')}</Link>
    </p>
  );
}
