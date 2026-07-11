import { DragEvent, FormEvent, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  formatFileSize,
  isImageUpload,
  isPdfUpload,
} from '../services/documentUploadValidation';
import { intakeDocumentFile } from '../services/documentIntakeService';
import { getDocumentFileDataUrl, getDocumentFileRefById } from '../services/documentFileStoreService';
import type { DocumentIntakeErrorCode } from '../services/documentIntakeService';
import type { InboxItem } from '../types/models';
import type { TranslationKey } from '../i18n';

const INTAKE_ERROR_KEYS: Partial<Record<DocumentIntakeErrorCode, TranslationKey>> = {
  invalid_type: 'document.upload.error.invalidType',
  file_too_large: 'document.upload.error.fileTooLarge',
  read_failed: 'document.upload.error.processFailed',
  hash_failed: 'document.upload.error.processFailed',
  persist_failed: 'document.upload.error.processFailed',
};

export function DocumentUploadPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [inboxItem, setInboxItem] = useState<InboxItem | null>(null);
  const [duplicateInfo, setDuplicateInfo] = useState<{
    title: string;
    type: 'inbox' | 'document';
    id: string;
  } | null>(null);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    setError(null);
    setDuplicateInfo(null);
    setInboxItem(null);
    setLoading(true);

    const result = await intakeDocumentFile(file, { importSource: 'upload' });
    setLoading(false);

    if (!result.success) {
      const key = INTAKE_ERROR_KEYS[result.error];
      setError(key ? translate(key) : translate('document.upload.error.processFailed'));
      return;
    }

    if (result.duplicate) {
      setDuplicateInfo({
        title: result.existing?.title ?? '',
        type: result.existing?.type ?? 'inbox',
        id: result.existing?.id ?? '',
      });
      showToast(translate('document.upload.duplicateDetected'));
      return;
    }

    setInboxItem(result.inboxItem);
    showToast(translate('document.upload.addedToInbox'));
  }

  function onInputChange(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    void handleFile(file);
    event.currentTarget.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    void handleFile(file);
  }

  const fileRef = inboxItem?.fileRefId ? getDocumentFileRefById(inboxItem.fileRefId) : undefined;
  const previewUrl = fileRef ? getDocumentFileDataUrl(fileRef) : undefined;

  return (
    <div className="page document-upload-page" data-testid="document-upload-page">
      <button type="button" className="back-link" onClick={() => navigate('/dokumente')}>
        ← {translate('common.back')}
      </button>
      <PageHeader
        title={translate('document.upload.title')}
        subtitle={translate('document.upload.subtitle')}
      />

      <Card>
        <div
          className={`document-upload-dropzone${dragActive ? ' document-upload-dropzone--active' : ''}`}
          data-testid="document-upload-dropzone"
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragActive(false);
          }}
          onDrop={onDrop}
        >
          <p className="document-upload-dropzone__title">{translate('document.upload.dropTitle')}</p>
          <p className="document-upload-dropzone__hint">{translate('document.upload.dropHint')}</p>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            className="document-upload-dropzone__input"
            data-testid="document-upload-input"
            onChange={onInputChange}
            disabled={loading}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={loading}
            data-testid="document-upload-select"
          >
            {loading
              ? translate('document.upload.processing')
              : translate('document.upload.select')}
          </Button>
        </div>

        {error ? (
          <p className="document-upload-error" role="alert" data-testid="document-upload-error">
            {error}
          </p>
        ) : null}

        {duplicateInfo ? (
          <div className="document-upload-preview" data-testid="document-upload-duplicate">
            <h2 className="document-upload-preview__title">
              {translate('document.upload.duplicateTitle')}
            </h2>
            <p>
              {translate('document.upload.duplicateMessage')} {duplicateInfo.title}
            </p>
            <div className="document-upload-preview__actions">
              {duplicateInfo.type === 'inbox' ? (
                <Link to={`/ablage/${duplicateInfo.id}`}>
                  <Button variant="primary" data-testid="document-upload-open-existing">
                    {translate('document.upload.openExisting')}
                  </Button>
                </Link>
              ) : (
                <Link to={`/dokumente/${duplicateInfo.id}`}>
                  <Button variant="primary" data-testid="document-upload-open-existing">
                    {translate('document.upload.openExisting')}
                  </Button>
                </Link>
              )}
            </div>
          </div>
        ) : null}

        {inboxItem ? (
          <div className="document-upload-preview" data-testid="document-upload-preview">
            <h2 className="document-upload-preview__title">
              {translate('document.upload.inboxPreviewTitle')}
            </h2>
            <dl className="document-upload-preview__meta">
              <div>
                <dt>{translate('document.upload.originalFileName')}</dt>
                <dd data-testid="document-upload-file-name">
                  {fileRef?.originalFileName ?? inboxItem.sourceFileName ?? inboxItem.title}
                </dd>
              </div>
              <div>
                <dt>{translate('document.upload.fileType')}</dt>
                <dd data-testid="document-upload-file-type">{fileRef?.mimeType || '—'}</dd>
              </div>
              <div>
                <dt>{translate('document.upload.fileSize')}</dt>
                <dd data-testid="document-upload-file-size">
                  {fileRef ? formatFileSize(fileRef.fileSize) : '—'}
                </dd>
              </div>
              <div>
                <dt>{translate('document.upload.inboxTitle')}</dt>
                <dd data-testid="document-upload-inbox-title">{inboxItem.title}</dd>
              </div>
            </dl>

            {previewUrl && fileRef && isImageUpload(fileRef.mimeType, fileRef.originalFileName) ? (
              <img
                src={previewUrl}
                alt={fileRef.originalFileName}
                className="document-upload-preview__image"
                data-testid="document-upload-image-preview"
              />
            ) : null}

            {previewUrl && fileRef && isPdfUpload(fileRef.mimeType, fileRef.originalFileName) ? (
              <iframe
                title={fileRef.originalFileName}
                src={previewUrl}
                className="document-upload-preview__pdf"
                data-testid="document-upload-pdf-preview"
              />
            ) : null}

            <div className="document-upload-preview__actions">
              <Link to={`/ablage/${inboxItem.id}`}>
                <Button variant="primary" data-testid="document-upload-to-inbox">
                  {translate('document.upload.openInboxReview')}
                </Button>
              </Link>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
