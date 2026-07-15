import { Button } from '../ui/Button';
import { Card, DataRow } from '../ui/Card';
import { useDocumentFileObjectUrl } from '../../hooks/useDocumentFileObjectUrl';
import {
  downloadDocumentFile,
  getDocumentFileRefById,
} from '../../services/documentFileStoreService';
import {
  formatFileSize,
  isImageUpload,
  isPdfUpload,
} from '../../services/documentUploadValidation';
import type { TranslationKey } from '../../i18n';

interface DocumentOriginalFilePanelProps {
  fileRefId: string | undefined;
  translate: (key: TranslationKey) => string;
  testId?: string;
}

export function DocumentOriginalFilePanel({
  fileRefId,
  translate,
  testId = 'document-original-file-panel',
}: DocumentOriginalFilePanelProps) {
  const fileRef = fileRefId ? getDocumentFileRefById(fileRefId) : undefined;
  const { status, objectUrl: previewUrl } = useDocumentFileObjectUrl(fileRef);

  if (!fileRef) {
    return (
      <Card data-testid={testId}>
        <p>{translate('document.original.unavailable')}</p>
      </Card>
    );
  }

  const uploadedAt = fileRef.createdAt
    ? new Date(fileRef.createdAt).toLocaleString('de-DE')
    : '—';

  return (
    <Card data-testid={testId}>
      <h3 className="section__title">{translate('document.original.title')}</h3>
      <dl className="document-original-file-panel__meta">
        <DataRow label={translate('document.upload.originalFileName')} value={fileRef.originalFileName} />
        <DataRow label={translate('document.upload.fileType')} value={fileRef.mimeType || '—'} />
        <DataRow label={translate('document.upload.fileSize')} value={formatFileSize(fileRef.fileSize)} />
        <DataRow label={translate('document.original.uploadedAt')} value={uploadedAt} />
      </dl>

      {status === 'missing' ? (
        <p className="document-original-file-panel__blob-missing" data-testid={`${testId}-blob-missing`}>
          {translate('document.original.blobMissing')}
        </p>
      ) : null}

      {previewUrl && isImageUpload(fileRef.mimeType, fileRef.originalFileName) ? (
        <img
          src={previewUrl}
          alt={fileRef.originalFileName}
          className="document-original-file-panel__image"
          data-testid={`${testId}-image`}
        />
      ) : null}

      {previewUrl && isPdfUpload(fileRef.mimeType, fileRef.originalFileName) ? (
        <iframe
          title={fileRef.originalFileName}
          src={previewUrl}
          className="document-original-file-panel__pdf"
          data-testid={`${testId}-pdf`}
        />
      ) : null}

      <div className="document-original-file-panel__actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => downloadDocumentFile(fileRef)}
          data-testid={`${testId}-download`}
          disabled={status === 'missing'}
        >
          {translate('document.original.download')}
        </Button>
      </div>
    </Card>
  );
}
