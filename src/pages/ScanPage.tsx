import { useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DocumentUploadErrorPanel } from '../components/documents/DocumentUploadErrorPanel';
import { OcrPreviewPanel } from '../components/scan/OcrPreviewPanel';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  UPLOAD_DOCUMENT_KINDS,
  UPLOAD_KIND_LABEL_KEYS,
} from '../services/inboxUploadFactory';
import {
  intakeCachedDocumentFile,
} from '../services/documentIntakeService';
import { getPersistFailureDiagnosticForDev } from '../services/persistenceService';
import {
  isBlockingExtractionError,
  isConfirmRetryableIntakeError,
  resolveUploadErrorView,
  type DocumentIntakeErrorCode,
  type DocumentUploadErrorCode,
} from '../services/documentUploadErrorService';
import { isHeicUploadFile } from '../services/documentUploadValidation';
import {
  loadCachedDocumentFileFromUpload,
  type CachedDocumentFilePayload,
} from '../services/cachedDocumentFileService';
import {
  buildOcrPreviewSummary,
  extractDocumentTextFromCache,
  type DocumentTextExtractionResult,
  type OcrPreviewSummary,
} from '../services/ocrDocumentService';
import type { UploadDocumentKind } from '../types/models';

const SCAN_FILE_ACCEPT =
  'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';

interface PendingScan {
  cachedFile: CachedDocumentFilePayload;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
}

export function ScanPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const confirmInFlightRef = useRef(false);
  const [selectedKind, setSelectedKind] = useState<UploadDocumentKind | null>(null);
  const [showKindPicker, setShowKindPicker] = useState(false);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [uploadError, setUploadError] = useState<DocumentUploadErrorCode | null>(null);
  const [confirmError, setConfirmError] = useState<DocumentIntakeErrorCode | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const inputMode = searchParams.get('input');

  useEffect(() => {
    if (inputMode === 'camera') {
      cameraInputRef.current?.click();
    } else if (inputMode === 'gallery') {
      fileInputRef.current?.click();
    }
  }, [inputMode]);

  const handleUploadComplete = (itemId: string) => {
    showToast(translate('scanResult.toastRecognized'));
    navigate(`/ablage/${itemId}`);
  };

  const openFilePicker = (camera = false) => {
    setUploadError(null);
    setConfirmError(null);
    setPendingScan(null);
    if (camera) {
      cameraInputRef.current?.click();
    } else {
      fileInputRef.current?.click();
    }
  };

  const processFile = async (file: File) => {
    if (isHeicUploadFile(file)) {
      setUploadError('heic_unsupported');
      return;
    }

    setUploadError(null);
    setConfirmError(null);
    setPendingScan(null);
    setIsProcessing(true);
    try {
      const loaded = await loadCachedDocumentFileFromUpload(file);
      if (!loaded.success) {
        if (loaded.error === 'unsupported_photo_format') {
          setUploadError('heic_unsupported');
        } else if (loaded.error === 'file_too_large') {
          setUploadError('file_too_large');
        } else {
          setUploadError('file_read_failed');
        }
        return;
      }

      const extraction = await extractDocumentTextFromCache(loaded.payload);

      if (isBlockingExtractionError(extraction.errorCode)) {
        setUploadError(extraction.errorCode ?? 'ocr_failed');
        return;
      }

      const preview = buildOcrPreviewSummary(
        loaded.payload.fileName,
        extraction.recognizedText,
        selectedKind ?? undefined,
      );

      setPendingScan({ cachedFile: loaded.payload, extraction, preview });

      if (extraction.qualityHintKey) {
        showToast(translate(extraction.qualityHintKey));
      }
    } catch {
      setUploadError('ocr_failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const confirmPendingScan = async () => {
    if (!pendingScan || confirmInFlightRef.current) return;

    confirmInFlightRef.current = true;
    setConfirmError(null);
    setIsConfirming(true);

    try {
      const recognizedText = pendingScan.extraction.recognizedText.trim() || undefined;
      const result = await intakeCachedDocumentFile(pendingScan.cachedFile, {
        sourceFileName: pendingScan.cachedFile.fileName,
        kind: selectedKind ?? undefined,
        recognizedText,
        importSource: 'scan',
      });

      if (!result.success) {
        setConfirmError(result.error);
        return;
      }

      if (result.duplicate) {
        setPendingScan(null);
        showToast(translate('document.upload.duplicateDetected'));
        if (result.existing?.type === 'inbox') {
          navigate(`/ablage/${result.existing.id}`);
        } else if (result.existing?.type === 'document') {
          navigate(`/dokumente/${result.existing.id}`);
        }
        return;
      }

      setPendingScan(null);
      handleUploadComplete(result.inboxItem.id);
    } finally {
      confirmInFlightRef.current = false;
      setIsConfirming(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processFile(file);
  };

  if (uploadError) {
    return (
      <div className="page scan-page" data-testid="scan-page">
        <PageHeader title={translate('scan.title')} subtitle={translate('scan.subtitle')} />
        <DocumentUploadErrorPanel
          errorCode={uploadError}
          translate={translate}
          onRetry={() => {
            setUploadError(null);
            openFilePicker(false);
          }}
          onNewPhoto={() => {
            setUploadError(null);
            openFilePicker(true);
          }}
          onSelectFile={() => {
            setUploadError(null);
            openFilePicker(false);
          }}
        />
      </div>
    );
  }

  if (pendingScan) {
    const confirmErrorView = confirmError ? resolveUploadErrorView(confirmError) : null;
    const persistErrorDiagnostic =
      confirmError === 'persist_failed' ? getPersistFailureDiagnosticForDev() : null;

    return (
      <div className="page scan-page" data-testid="scan-page">
        <PageHeader title={translate('scan.title')} subtitle={translate('scan.ocr.previewSubtitle')} />
        {showKindPicker ? (
          <Card className="upload-kind-picker-card">
            <CardTitle>{translate('docAssistant.changeType')}</CardTitle>
            <div className="chip-group">
              <button
                type="button"
                className={`chip ${selectedKind === null ? 'chip--active' : ''}`}
                onClick={() => setSelectedKind(null)}
              >
                {translate('scan.typeAuto')}
              </button>
              {UPLOAD_DOCUMENT_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`chip ${selectedKind === kind ? 'chip--active' : ''}`}
                  onClick={() => setSelectedKind(kind)}
                >
                  {translate(UPLOAD_KIND_LABEL_KEYS[kind])}
                </button>
              ))}
            </div>
            <Button variant="outline" fullWidth onClick={() => setShowKindPicker(false)}>
              {translate('common.back')}
            </Button>
          </Card>
        ) : null}
        <OcrPreviewPanel
          fileName={pendingScan.cachedFile.fileName}
          extraction={pendingScan.extraction}
          preview={pendingScan.preview}
          continueLabel={translate('scan.ocr.continue')}
          qualityHintLabel={
            pendingScan.extraction.qualityHintKey
              ? translate(pendingScan.extraction.qualityHintKey)
              : undefined
          }
          documentTypeLabel={translate('scan.ocr.documentType')}
          senderLabel={translate('scan.ocr.sender')}
          previewTextLabel={translate('scan.ocr.previewText')}
          aiActionsLabel={translate('document.intakeUnderstanding.aiActions')}
          translate={translate}
          cancelLabel={translate('common.cancel')}
          onContinue={confirmPendingScan}
          onCancel={() => setPendingScan(null)}
          onChangeType={() => setShowKindPicker(true)}
          changeTypeLabel={translate('docAssistant.changeType')}
          isConfirming={isConfirming}
          confirmErrorTitle={confirmErrorView ? translate(confirmErrorView.titleKey) : undefined}
          confirmErrorMessage={confirmErrorView ? translate(confirmErrorView.descriptionKey) : undefined}
          confirmErrorDiagnostic={persistErrorDiagnostic}
          onRetryConfirm={
            confirmError && isConfirmRetryableIntakeError(confirmError)
              ? () => void confirmPendingScan()
              : undefined
          }
          onNewPhoto={() => openFilePicker(true)}
          onSelectFile={() => openFilePicker(false)}
        />
      </div>
    );
  }

  return (
    <div className="page scan-page" data-testid="scan-page">
      <PageHeader
        title={translate('scan.title')}
        subtitle={translate('scan.subtitle')}
      />

      <Card className="upload-card upload-card--capture">
        <CardTitle>{translate('scan.captureTitle')}</CardTitle>
        <CardMeta>{translate('docAssistant.autoDetect')}</CardMeta>

        <input
          ref={cameraInputRef}
          type="file"
          accept={SCAN_FILE_ACCEPT}
          capture="environment"
          className="sr-only"
          onChange={handleFileChange}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={SCAN_FILE_ACCEPT}
          className="sr-only"
          onChange={handleFileChange}
        />

        <div className="upload-actions">
          <Button
            fullWidth
            data-testid="scan-capture-button"
            onClick={() => openFilePicker(true)}
            disabled={isProcessing}
            loading={isProcessing}
          >
            {isProcessing ? translate('scan.ocr.processing') : translate('heute.scanButton')}
          </Button>
          <Button variant="outline" fullWidth onClick={() => openFilePicker(false)} disabled={isProcessing}>
            {translate('scan.uploadFile')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
