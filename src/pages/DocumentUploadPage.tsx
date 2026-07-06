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
import {
  getUploadErrorMessage,
  uploadDocumentFromFile,
} from '../services/uploadedDocumentService';
import type { UploadedDocument } from '../types/uploadedDocument';

export function DocumentUploadPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedDocument | null>(null);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    setError(null);
    setLoading(true);
    const result = await uploadDocumentFromFile(file);
    setLoading(false);
    if (!result.success) {
      setUploaded(null);
      setError(getUploadErrorMessage(result.error));
      return;
    }
    setUploaded(result.document);
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
            {loading ? translate('document.upload.uploading') : translate('document.upload.select')}
          </Button>
        </div>

        {error ? (
          <p className="document-upload-error" role="alert" data-testid="document-upload-error">
            {error}
          </p>
        ) : null}

        {uploaded ? (
          <div className="document-upload-preview" data-testid="document-upload-preview">
            <h2 className="document-upload-preview__title">{translate('document.upload.previewTitle')}</h2>
            <dl className="document-upload-preview__meta">
              <div>
                <dt>{translate('document.upload.fileName')}</dt>
                <dd data-testid="document-upload-file-name">{uploaded.fileName}</dd>
              </div>
              <div>
                <dt>{translate('document.upload.fileType')}</dt>
                <dd data-testid="document-upload-file-type">{uploaded.fileType || '—'}</dd>
              </div>
              <div>
                <dt>{translate('document.upload.fileSize')}</dt>
                <dd data-testid="document-upload-file-size">{formatFileSize(uploaded.fileSize)}</dd>
              </div>
              <div>
                <dt>{translate('document.upload.status')}</dt>
                <dd data-testid="document-upload-status">{uploaded.status}</dd>
              </div>
            </dl>

            {isImageUpload(uploaded.fileType, uploaded.fileName) && uploaded.previewUrl ? (
              <img
                src={uploaded.previewUrl}
                alt={uploaded.fileName}
                className="document-upload-preview__image"
                data-testid="document-upload-image-preview"
              />
            ) : null}

            {isPdfUpload(uploaded.fileType, uploaded.fileName) ? (
              uploaded.previewUrl ? (
                <iframe
                  title={uploaded.fileName}
                  src={uploaded.previewUrl}
                  className="document-upload-preview__pdf"
                  data-testid="document-upload-pdf-preview"
                />
              ) : (
                <p className="document-upload-preview__pdf-fallback" data-testid="document-upload-pdf-fallback">
                  {translate('document.upload.pdfFallback')}
                </p>
              )
            ) : null}

            <div className="document-upload-preview__actions">
              <Link to="/dokumente">
                <Button variant="primary" data-testid="document-upload-to-list">
                  {translate('document.upload.toList')}
                </Button>
              </Link>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
