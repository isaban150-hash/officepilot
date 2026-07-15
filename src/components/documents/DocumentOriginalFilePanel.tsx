import { useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card, DataRow } from '../ui/Card';
import { useDocumentFileObjectUrl } from '../../hooks/useDocumentFileObjectUrl';
import {
  downloadDocumentFile,
  getDocumentFileRefById,
  promoteDocumentFileRefToCommitted,
} from '../../services/documentFileStoreService';
import { countActiveReferencesToFileRef } from '../../services/documentFileReferenceService';
import { isDocumentFileRefTempExpired } from '../../services/documentFileStorageLifecycleService';
import {
  formatFileSize,
  isImageUpload,
  isPdfUpload,
} from '../../services/documentUploadValidation';
import type { TranslationKey } from '../../i18n';
import type { DocumentFileRef } from '../../types/documentFileRef';

interface DocumentOriginalFilePanelProps {
  fileRefId: string | undefined;
  translate: (key: TranslationKey) => string;
  testId?: string;
  onPromoted?: (fileRef: DocumentFileRef) => void;
}

function formatTemplate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return Object.entries(params).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function DocumentOriginalFilePanel({
  fileRefId,
  translate,
  testId = 'document-original-file-panel',
  onPromoted,
}: DocumentOriginalFilePanelProps) {
  const [refVersion, setRefVersion] = useState(0);
  const [isPromoting, setIsPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const promoteInFlightRef = useRef(false);

  const fileRef = useMemo(
    () => (fileRefId ? getDocumentFileRefById(fileRefId) : undefined),
    [fileRefId, refVersion],
  );
  const { status, objectUrl: previewUrl } = useDocumentFileObjectUrl(fileRef);
  const activeReferences = fileRefId ? countActiveReferencesToFileRef(fileRefId) : 0;
  const isTemp = fileRef?.lifecycleStatus === 'temp';
  const isExpired = fileRef ? isDocumentFileRefTempExpired(fileRef) : false;

  if (!fileRef) {
    return (
      <Card className="document-original-file-panel" data-testid={testId}>
        <p>{translate('document.original.unavailable')}</p>
      </Card>
    );
  }

  const uploadedAt = fileRef.createdAt
    ? new Date(fileRef.createdAt).toLocaleString('de-DE')
    : '—';

  const promote = () => {
    if (!fileRefId || promoteInFlightRef.current || isPromoting) return;

    if (activeReferences > 1) {
      const confirmed = window.confirm(
        formatTemplate(translate('document.original.promote.confirmShared'), {
          count: activeReferences,
        }),
      );
      if (!confirmed) return;
    }

    promoteInFlightRef.current = true;
    setIsPromoting(true);
    setPromoteError(null);

    try {
      const result = promoteDocumentFileRefToCommitted(fileRefId);
      if (!result.success) {
        const errorKey =
          result.error === 'file_ref_not_found'
            ? 'document.original.promote.error.notFound'
            : result.error === 'lifecycle_not_temp'
              ? 'document.original.promote.error.notTemp'
              : 'document.original.promote.error.persistFailed';
        setPromoteError(translate(errorKey));
        return;
      }

      setRefVersion((value) => value + 1);
      onPromoted?.(result.fileRef);
    } finally {
      promoteInFlightRef.current = false;
      setIsPromoting(false);
    }
  };

  return (
    <Card className="document-original-file-panel" data-testid={testId}>
      <h3 className="section__title">{translate('document.original.title')}</h3>
      <dl className="document-original-file-panel__meta">
        <DataRow label={translate('document.upload.originalFileName')} value={fileRef.originalFileName} />
        <DataRow label={translate('document.upload.fileType')} value={fileRef.mimeType || '—'} />
        <DataRow label={translate('document.upload.fileSize')} value={formatFileSize(fileRef.fileSize)} />
        <DataRow label={translate('document.original.uploadedAt')} value={uploadedAt} />
      </dl>

      {isTemp ? (
        <div className="document-original-file-panel__lifecycle" data-testid={`${testId}-lifecycle-temp`}>
          <p className="document-original-file-panel__lifecycle-badge" data-testid={`${testId}-temp-badge`}>
            {translate('document.original.lifecycle.temp')}
          </p>
          {isExpired ? (
            <p data-testid={`${testId}-expired-hint`}>
              {translate('document.original.lifecycle.expired')}
            </p>
          ) : null}
          {activeReferences > 1 ? (
            <p data-testid={`${testId}-shared-notice`}>
              {formatTemplate(translate('document.original.lifecycle.sharedNotice'), {
                count: activeReferences,
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {status === 'missing' ? (
        <p className="document-original-file-panel__blob-missing" data-testid={`${testId}-blob-missing`}>
          {translate('document.original.blobMissing')}
        </p>
      ) : null}

      {previewUrl && isImageUpload(fileRef.mimeType, fileRef.originalFileName) ? (
        <div className="document-original-file-panel__preview">
          <img
            src={previewUrl}
            alt={fileRef.originalFileName}
            className="document-original-file-panel__image"
            data-testid={`${testId}-image`}
          />
        </div>
      ) : null}

      {previewUrl && isPdfUpload(fileRef.mimeType, fileRef.originalFileName) ? (
        <div className="document-original-file-panel__preview document-original-file-panel__preview--pdf">
          <iframe
            title={fileRef.originalFileName}
            src={previewUrl}
            className="document-original-file-panel__pdf"
            data-testid={`${testId}-pdf`}
          />
        </div>
      ) : null}

      {promoteError ? (
        <p className="document-original-file-panel__promote-error" role="alert" data-testid={`${testId}-promote-error`}>
          {promoteError}
        </p>
      ) : null}

      <div className="document-original-file-panel__actions">
        {isTemp ? (
          <Button
            type="button"
            onClick={promote}
            data-testid={`${testId}-promote`}
            disabled={isPromoting || status === 'missing'}
            loading={isPromoting}
          >
            {translate('document.original.action.promotePermanently')}
          </Button>
        ) : null}
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
