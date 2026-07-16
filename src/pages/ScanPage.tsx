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
import { getPersistFailureDiagnosticForDev } from '../services/persistenceService';
import {
  isConfirmRetryableIntakeError,
  resolveUploadErrorView,
  type DocumentIntakeErrorCode,
  type DocumentUploadErrorCode,
} from '../services/documentUploadErrorService';
import {
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
  type PendingDocumentIntake,
} from '../services/pendingDocumentIntakeService';
import {
  buildPendingDocumentDecisionActions,
  executePendingDocumentDecision,
  isDiscardedPendingDocumentDecision,
  isNavigateExistingPendingDocumentDecision,
  isPendingDocumentDecisionResultIntake,
} from '../services/pendingDocumentDecisionService';
import {
  finishDocumentSaveTrace,
  startDocumentSaveTrace,
  traceStep,
  traceStepError,
} from '../services/documentSaveTraceService';
import type { UserStorageDecision } from '../types/userStorageDecision';
import type { UploadDocumentKind } from '../types/models';

const SCAN_FILE_ACCEPT =
  'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';

export function ScanPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const confirmInFlightRef = useRef(false);
  const processGenerationRef = useRef(0);
  const [selectedKind, setSelectedKind] = useState<UploadDocumentKind | null>(null);
  const [showKindPicker, setShowKindPicker] = useState(false);
  const [pendingScan, setPendingScan] = useState<PendingDocumentIntake | null>(null);
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
    discardPendingDocumentIntake(pendingScan);
    setPendingScan(null);
    if (camera) {
      cameraInputRef.current?.click();
    } else {
      fileInputRef.current?.click();
    }
  };

  const processFile = async (file: File) => {
    const generation = processGenerationRef.current + 1;
    processGenerationRef.current = generation;
    setUploadError(null);
    setConfirmError(null);
    discardPendingDocumentIntake(pendingScan);
    setPendingScan(null);
    setIsProcessing(true);

    try {
      const result = await processDocumentFileForPreview(file, {
        selectedKind: selectedKind ?? undefined,
      });

      if (processGenerationRef.current !== generation) return;
      if (!result.success) {
        setUploadError(result.error);
        return;
      }

      setPendingScan(result.pending);

      if (result.pending.extraction.qualityHintKey) {
        showToast(translate(result.pending.extraction.qualityHintKey));
      }
    } catch {
      setUploadError('ocr_failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePendingDecision = async (decision: UserStorageDecision) => {
    if (!pendingScan || confirmInFlightRef.current) return;

    if (decision === 'discard') {
      discardScan();
      return;
    }

    const saveTraceId = startDocumentSaveTrace('scan');
    confirmInFlightRef.current = true;
    setConfirmError(null);
    setIsConfirming(true);

    try {
      traceStep(saveTraceId, 'execute_decision_start');
      const result = await executePendingDocumentDecision(pendingScan, decision, {
        kind: selectedKind ?? undefined,
        importSource: 'scan',
        saveTraceId,
      });
      traceStep(saveTraceId, 'execute_decision_resolved', {
        success: !('outcome' in result) ? result.success : true,
      });

      if (isDiscardedPendingDocumentDecision(result)) {
        setPendingScan(null);
        return;
      }

      if (isNavigateExistingPendingDocumentDecision(result)) {
        discardPendingDocumentIntake(pendingScan);
        setPendingScan(null);
        traceStep(saveTraceId, 'navigation_start');
        if (result.match.type === 'inbox') {
          navigate(`/ablage/${result.match.id}`);
        } else {
          navigate(`/dokumente/${result.match.id}`);
        }
        traceStep(saveTraceId, 'navigation_done');
        return;
      }

      if (!isPendingDocumentDecisionResultIntake(result)) return;

      if (!result.success) {
        setConfirmError(result.error);
        return;
      }

      if (result.duplicate) {
        discardPendingDocumentIntake(pendingScan);
        setPendingScan(null);
        showToast(translate('document.upload.duplicateDetected'));
        traceStep(saveTraceId, 'navigation_start');
        if (result.existing?.type === 'inbox') {
          navigate(`/ablage/${result.existing.id}`);
        } else if (result.existing?.type === 'document') {
          navigate(`/dokumente/${result.existing.id}`);
        }
        traceStep(saveTraceId, 'navigation_done');
        return;
      }

      const itemId = result.inboxItem.id;
      discardPendingDocumentIntake(pendingScan);
      setPendingScan(null);
      traceStep(saveTraceId, 'navigation_start');
      handleUploadComplete(itemId);
      traceStep(saveTraceId, 'navigation_done');
    } catch (error) {
      traceStepError(saveTraceId, 'execute_decision_rejected', error);
      throw error;
    } finally {
      traceStep(saveTraceId, 'finally_reset_loading');
      finishDocumentSaveTrace(saveTraceId);
      confirmInFlightRef.current = false;
      setIsConfirming(false);
    }
  };

  const discardScan = () => {
    discardPendingDocumentIntake(pendingScan);
    setPendingScan(null);
    setConfirmError(null);
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
          storageRecommendation={pendingScan.storageRecommendation}
          decisionActions={buildPendingDocumentDecisionActions(pendingScan)}
          pendingNoticeLabel={translate('document.intakePreview.pendingNotice')}
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
          onDecision={(decision) => void handlePendingDecision(decision)}
          onChangeType={() => setShowKindPicker(true)}
          changeTypeLabel={translate('docAssistant.changeType')}
          isConfirming={isConfirming}
          confirmErrorTitle={confirmErrorView ? translate(confirmErrorView.titleKey) : undefined}
          confirmErrorMessage={confirmErrorView ? translate(confirmErrorView.descriptionKey) : undefined}
          confirmErrorDiagnostic={persistErrorDiagnostic}
          onRetryConfirm={
            confirmError && isConfirmRetryableIntakeError(confirmError)
              ? () => void handlePendingDecision('save_permanently')
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
