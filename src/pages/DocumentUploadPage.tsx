import { DragEvent, FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DocumentUploadErrorPanel } from '../components/documents/DocumentUploadErrorPanel';
import { OcrPreviewPanel } from '../components/scan/OcrPreviewPanel';
import { Button } from '../components/ui/Button';
import { Card, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { getPersistFailureDiagnosticForDev } from '../services/persistenceService';
import {
  isConfirmRetryableIntakeError,
  resolveUploadErrorView,
  type DocumentIntakeErrorCode,
  type DocumentUploadErrorCode,
} from '../services/documentUploadErrorService';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
  type PendingDocumentIntake,
} from '../services/pendingDocumentIntakeService';

export function DocumentUploadPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmInFlightRef = useRef(false);
  const processGenerationRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState<DocumentUploadErrorCode | null>(null);
  const [confirmError, setConfirmError] = useState<DocumentIntakeErrorCode | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingDocumentIntake | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  const handleUploadComplete = (itemId: string) => {
    showToast(translate('document.upload.addedToInbox'));
    navigate(`/ablage/${itemId}`);
  };

  const openFilePicker = () => {
    setUploadError(null);
    setConfirmError(null);
    discardPendingDocumentIntake(pendingUpload);
    setPendingUpload(null);
    inputRef.current?.click();
  };

  const processFile = async (file: File | null | undefined) => {
    if (!file) return;

    const generation = processGenerationRef.current + 1;
    processGenerationRef.current = generation;
    setUploadError(null);
    setConfirmError(null);
    discardPendingDocumentIntake(pendingUpload);
    setPendingUpload(null);
    setIsProcessing(true);

    try {
      const result = await processDocumentFileForPreview(file);
      if (processGenerationRef.current !== generation) return;

      if (!result.success) {
        setUploadError(result.error);
        return;
      }

      setPendingUpload(result.pending);

      if (result.pending.extraction.qualityHintKey) {
        showToast(translate(result.pending.extraction.qualityHintKey));
      }
    } catch {
      setUploadError('ocr_failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const confirmPendingUpload = async () => {
    if (!pendingUpload || confirmInFlightRef.current) return;

    confirmInFlightRef.current = true;
    setConfirmError(null);
    setIsConfirming(true);

    try {
      const result = await confirmPendingDocumentIntake(pendingUpload, { importSource: 'upload' });

      if (!result.success) {
        setConfirmError(result.error);
        return;
      }

      if (result.duplicate) {
        discardPendingDocumentIntake(pendingUpload);
        setPendingUpload(null);
        showToast(translate('document.upload.duplicateDetected'));
        if (result.existing?.type === 'inbox') {
          navigate(`/ablage/${result.existing.id}`);
        } else if (result.existing?.type === 'document') {
          navigate(`/dokumente/${result.existing.id}`);
        }
        return;
      }

      const itemId = result.inboxItem.id;
      discardPendingDocumentIntake(pendingUpload);
      setPendingUpload(null);
      handleUploadComplete(itemId);
    } finally {
      confirmInFlightRef.current = false;
      setIsConfirming(false);
    }
  };

  const discardUpload = () => {
    discardPendingDocumentIntake(pendingUpload);
    setPendingUpload(null);
    setConfirmError(null);
  };

  const useExistingDuplicate = () => {
    const match = pendingUpload?.storageRecommendation.duplicateMatch;
    if (!match) return;
    discardPendingDocumentIntake(pendingUpload);
    setPendingUpload(null);
    if (match.type === 'inbox') {
      navigate(`/ablage/${match.id}`);
    } else {
      navigate(`/dokumente/${match.id}`);
    }
  };

  function onInputChange(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    void processFile(file);
    event.currentTarget.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    void processFile(file);
  }

  if (uploadError) {
    return (
      <div className="page document-upload-page" data-testid="document-upload-page">
        <button type="button" className="back-link" onClick={() => navigate('/dokumente')}>
          ← {translate('common.back')}
        </button>
        <PageHeader
          title={translate('document.upload.title')}
          subtitle={translate('document.upload.subtitle')}
        />
        <DocumentUploadErrorPanel
          errorCode={uploadError}
          translate={translate}
          onRetry={() => {
            setUploadError(null);
            openFilePicker();
          }}
          onNewPhoto={() => {
            setUploadError(null);
            navigate('/scan?input=camera');
          }}
          onSelectFile={() => {
            setUploadError(null);
            openFilePicker();
          }}
        />
      </div>
    );
  }

  if (pendingUpload) {
    const confirmErrorView = confirmError ? resolveUploadErrorView(confirmError) : null;
    const persistErrorDiagnostic =
      confirmError === 'persist_failed' ? getPersistFailureDiagnosticForDev() : null;

    return (
      <div className="page document-upload-page" data-testid="document-upload-page">
        <button type="button" className="back-link" onClick={() => navigate('/dokumente')}>
          ← {translate('common.back')}
        </button>
        <PageHeader
          title={translate('document.upload.title')}
          subtitle={translate('scan.ocr.previewSubtitle')}
        />
        <OcrPreviewPanel
          fileName={pendingUpload.cachedFile.fileName}
          extraction={pendingUpload.extraction}
          preview={pendingUpload.preview}
          storageRecommendation={pendingUpload.storageRecommendation}
          pendingNoticeLabel={translate('document.intakePreview.pendingNotice')}
          continueLabel={translate('document.intakePreview.savePermanently')}
          qualityHintLabel={
            pendingUpload.extraction.qualityHintKey
              ? translate(pendingUpload.extraction.qualityHintKey)
              : undefined
          }
          documentTypeLabel={translate('scan.ocr.documentType')}
          senderLabel={translate('scan.ocr.sender')}
          previewTextLabel={translate('scan.ocr.previewText')}
          aiActionsLabel={translate('document.intakeUnderstanding.aiActions')}
          translate={translate}
          cancelLabel={translate('document.intakePreview.discard')}
          onContinue={confirmPendingUpload}
          onCancel={discardUpload}
          onUseExistingDuplicate={useExistingDuplicate}
          isConfirming={isConfirming}
          confirmErrorTitle={confirmErrorView ? translate(confirmErrorView.titleKey) : undefined}
          confirmErrorMessage={confirmErrorView ? translate(confirmErrorView.descriptionKey) : undefined}
          confirmErrorDiagnostic={persistErrorDiagnostic}
          onRetryConfirm={
            confirmError && isConfirmRetryableIntakeError(confirmError)
              ? () => void confirmPendingUpload()
              : undefined
          }
          onSelectFile={openFilePicker}
        />
      </div>
    );
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
            disabled={isProcessing}
          />
          <Button
            type="button"
            variant="outline"
            onClick={openFilePicker}
            disabled={isProcessing}
            loading={isProcessing}
            data-testid="document-upload-select"
          >
            {isProcessing
              ? translate('document.upload.processing')
              : translate('document.upload.select')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
