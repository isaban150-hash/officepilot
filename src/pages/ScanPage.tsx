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
import { resolvePendingDocumentContractProposal } from '../services/contractPreviewProposalService';
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
import { useReportUiSession } from '../hooks/useReportUiSession';
import {
  cleanupExpiredUploadDrafts,
  discardPendingDocumentIntakeDraft,
  forgetUploadDraftMetadata,
  loadPendingDocumentIntakeDraft,
  savePendingDocumentIntakeDraft,
} from '../services/upload/uploadDraftService';

const SCAN_FILE_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf';

/** UPLOAD-DRAFT-RESUME-01D2 — opaque resume pointer; never file content. */
const DRAFT_QUERY_PARAM = 'draft';

export function ScanPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const urlDraftId = searchParams.get(DRAFT_QUERY_PARAM);

  /** Draft currently shown; a ref so decisions never read a stale value. */
  const draftIdRef = useRef<string | null>(null);
  const [reportedDraftId, setReportedDraftId] = useState<string | null>(null);
  const restoreStartedRef = useRef(false);
  const autoPickerDoneRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const rememberDraftId = (draftId: string | null) => {
    draftIdRef.current = draftId;
    if (mountedRef.current) setReportedDraftId(draftId);
  };

  const setDraftQueryParam = (draftId: string | null) => {
    if (!mountedRef.current) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (draftId) next.set(DRAFT_QUERY_PARAM, draftId);
        else next.delete(DRAFT_QUERY_PARAM);
        return next;
      },
      { replace: true },
    );
  };

  /**
   * UPLOAD-DRAFT-RESUME-01D2 — the UI session only ever carries the opaque draft
   * id plus a human label. Never bytes, OCR text, pageTexts, classification,
   * recommendation, policy or contract data.
   */
  useReportUiSession(
    reportedDraftId && pendingScan
      ? {
          workspaceType: 'document_review',
          drafts: { values: { pendingUploadDraftId: reportedDraftId }, dirty: true },
          resumeLabel: {
            titleText: translate(pendingScan.preview.documentTypeLabelKey),
            subtitleText: pendingScan.cachedFile.fileName,
            entityHint: '',
          },
        }
      : { drafts: { values: {}, dirty: false } },
  );

  /** Opens the picker requested by ?input= exactly once. */
  const runAutoPicker = () => {
    if (autoPickerDoneRef.current) return;
    autoPickerDoneRef.current = true;
    if (inputMode === 'camera') cameraInputRef.current?.click();
    else if (inputMode === 'gallery') fileInputRef.current?.click();
  };

  /**
   * Restore a stored draft first; only without one does the requested picker open.
   * A valid camera/gallery draft must never be overwritten by an auto-opened picker.
   */
  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    let cancelled = false;
    let completed = false;
    const releaseGuardOnCleanup = () => {
      cancelled = true;
      if (!completed) restoreStartedRef.current = false;
    };

    void cleanupExpiredUploadDrafts();

    if (!urlDraftId) {
      completed = true;
      runAutoPicker();
      return releaseGuardOnCleanup;
    }

    const generationAtStart = processGenerationRef.current;
    const superseded = () =>
      cancelled || !mountedRef.current || processGenerationRef.current !== generationAtStart;

    setIsProcessing(true);
    void loadPendingDocumentIntakeDraft(urlDraftId)
      .then(async (result) => {
        if (superseded()) return;
        if (!result.success) {
          rememberDraftId(null);
          if (result.reason !== 'missing') {
            await discardPendingDocumentIntakeDraft(urlDraftId);
          }
          if (superseded()) return;
          setPendingScan(null);
          // Drop the stale pointer, keep ?input=, then open the intended picker.
          setDraftQueryParam(null);
          runAutoPicker();
          return;
        }
        rememberDraftId(result.draftId);
        setPendingScan(result.pending);
      })
      .catch(() => {
        if (superseded()) return;
        rememberDraftId(null);
        setPendingScan(null);
        setDraftQueryParam(null);
        runAutoPicker();
      })
      .finally(() => {
        if (superseded()) return;
        completed = true;
        setIsProcessing(false);
      });

    return releaseGuardOnCleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only restore
  }, []);

  const handleUploadComplete = (itemId: string) => {
    showToast(translate('scanResult.toastRecognized'));
    navigate(`/ablage/${itemId}`);
  };

  const openFilePicker = (camera = false) => {
    setUploadError(null);
    setConfirmError(null);
    // The current draft survives until a new preview has been stored: a cancelled
    // picker must leave analysis, draft and URL untouched. Safari needs the click
    // inside the user gesture, so nothing is awaited here.
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

      /**
       * UPLOAD-DRAFT-RESUME-01D2 — a visible analysis must already be resumable.
       * The draft is stored first; the preview is only rendered afterwards.
       */
      const previousDraftId = draftIdRef.current;
      const saved = await savePendingDocumentIntakeDraft(result.pending);

      if (processGenerationRef.current !== generation) {
        if (saved.success) void discardPendingDocumentIntakeDraft(saved.draftId);
        return;
      }
      if (!mountedRef.current) {
        // Page was left mid-write: no analysis was ever shown, so this draft is
        // unreachable. Remove it under the usual safety rules.
        if (saved.success) void discardPendingDocumentIntakeDraft(saved.draftId);
        return;
      }

      if (saved.success) {
        rememberDraftId(saved.draftId);
        setDraftQueryParam(saved.draftId);
        if (previousDraftId && previousDraftId !== saved.draftId) {
          void discardPendingDocumentIntakeDraft(previousDraftId);
        }
      } else {
        // Documented exception: the analysis stays usable, but nothing is secured.
        rememberDraftId(null);
        setDraftQueryParam(null);
        if (previousDraftId) void discardPendingDocumentIntakeDraft(previousDraftId);
        showToast(translate('persist.failed.userAction'));
      }

      setPendingScan(result.pending);

      if (result.pending.extraction.qualityHintKey) {
        showToast(translate(result.pending.extraction.qualityHintKey));
      }
    } catch {
      if (processGenerationRef.current === generation) setUploadError('ocr_failed');
    } finally {
      if (processGenerationRef.current === generation) setIsProcessing(false);
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
        await releaseCurrentDraft();
        setPendingScan(null);
        return;
      }

      if (isNavigateExistingPendingDocumentDecision(result)) {
        discardPendingDocumentIntake(pendingScan);
        // Metadata only — an existing committed or shared ref is never removed.
        await forgetCurrentDraftMetadata();
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
        await forgetCurrentDraftMetadata();
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
      // The ref is now committed and referenced — drop the draft metadata only.
      await forgetCurrentDraftMetadata();
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

  /** Removes draft metadata and, when safe, the temporary file. */
  const releaseCurrentDraft = async () => {
    const draftId = draftIdRef.current;
    rememberDraftId(null);
    setDraftQueryParam(null);
    if (draftId) await discardPendingDocumentIntakeDraft(draftId);
  };

  /** Removes only the draft metadata; the file stays (committed or shared). */
  const forgetCurrentDraftMetadata = async () => {
    const draftId = draftIdRef.current;
    rememberDraftId(null);
    setDraftQueryParam(null);
    if (draftId) await forgetUploadDraftMetadata(draftId);
  };

  const discardScan = () => {
    discardPendingDocumentIntake(pendingScan);
    void releaseCurrentDraft();
    setPendingScan(null);
    setConfirmError(null);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processFile(file);
  };

  /**
   * The same real inputs in every page state — only one branch renders at a time,
   * so openFilePicker works in the preview and error views too.
   */
  const captureInputs = (
    <>
      <input
        ref={cameraInputRef}
        type="file"
        accept={SCAN_FILE_ACCEPT}
        capture="environment"
        className="sr-only"
        data-testid="scan-camera-input"
        onChange={handleFileChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={SCAN_FILE_ACCEPT}
        className="sr-only"
        data-testid="scan-gallery-input"
        onChange={handleFileChange}
      />
    </>
  );

  if (uploadError) {
    return (
      <div className="page scan-page" data-testid="scan-page">
        <PageHeader title={translate('scan.title')} subtitle={translate('scan.subtitle')} />
        {captureInputs}
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
        {captureInputs}
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
          contractProposal={resolvePendingDocumentContractProposal(pendingScan)}
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

        {captureInputs}

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
