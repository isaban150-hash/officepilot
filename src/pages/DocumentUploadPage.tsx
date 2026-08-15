import { DragEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { resolvePendingDocumentContractProposal } from '../services/contractPreviewProposalService';
import {
  cleanupExpiredUploadDrafts,
  discardPendingDocumentIntakeDraft,
  forgetUploadDraftMetadata,
  loadPendingDocumentIntakeDraft,
  savePendingDocumentIntakeDraft,
} from '../services/upload/uploadDraftService';

/** UPLOAD-DRAFT-RESUME-01B1 — opaque resume pointer; never file content. */
const DRAFT_QUERY_PARAM = 'draft';

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
  /** Draft write in flight — decisions stay blocked through the existing loading path. */
  const [isSavingDraft, setIsSavingDraft] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
  const urlDraftId = searchParams.get(DRAFT_QUERY_PARAM);
  /** Draft currently shown; kept in a ref so decisions never read a stale value. */
  const draftIdRef = useRef<string | null>(null);
  const restoreStartedRef = useRef(false);
  const savingDraftRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const handleUploadComplete = (itemId: string) => {
    showToast(translate('document.upload.addedToInbox'));
    navigate(`/ablage/${itemId}`);
  };

  /**
   * Restore an existing draft on mount and clean expired ones. No analysis runs
   * here: the stored preview is rebuilt from stored metadata and stored bytes.
   */
  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    let cancelled = false;
    // Guards the StrictMode double invoke: an aborted, unfinished run must hand
    // the work back, otherwise nobody ever clears the loading state.
    let completed = false;
    const releaseGuardOnCleanup = () => {
      cancelled = true;
      if (!completed) restoreStartedRef.current = false;
    };

    void cleanupExpiredUploadDrafts();

    if (!urlDraftId) {
      completed = true;
      return releaseGuardOnCleanup;
    }

    // A file picked meanwhile must win over a late restore.
    const generationAtStart = processGenerationRef.current;
    const superseded = () =>
      cancelled || !mountedRef.current || processGenerationRef.current !== generationAtStart;

    setIsProcessing(true);
    void loadPendingDocumentIntakeDraft(urlDraftId)
      .then(async (result) => {
        if (superseded()) return;
        if (!result.success) {
          // Missing, expired or damaged. A foreign draft reports `missing` and is
          // left completely untouched; only our own broken record is cleaned up.
          draftIdRef.current = null;
          if (result.reason !== 'missing') {
            await discardPendingDocumentIntakeDraft(urlDraftId);
          }
          if (superseded()) return;
          setPendingUpload(null);
          setDraftQueryParam(null);
          return;
        }
        draftIdRef.current = result.draftId;
        setPendingUpload(result.pending);
      })
      .catch(() => {
        if (superseded()) return;
        draftIdRef.current = null;
        setPendingUpload(null);
        setDraftQueryParam(null);
      })
      .finally(() => {
        // Only the currently valid run may clear the spinner — a stale run must
        // never switch off the loading state of a newer one.
        if (superseded()) return;
        completed = true;
        setIsProcessing(false);
      });

    return releaseGuardOnCleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only restore
  }, []);

  const openFilePicker = () => {
    setUploadError(null);
    setConfirmError(null);
    // Safari: click must stay inside the user gesture — no await, and the current
    // draft survives until a new preview has been stored successfully.
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

      // Store the draft right after the preview: iOS may abort async writes that
      // only start on visibilitychange / pagehide. Decisions stay blocked while
      // the write runs, so no confirmation can race an unsaved draft.
      const previousDraftId = draftIdRef.current;
      savingDraftRef.current = true;
      setIsSavingDraft(true);
      let saved: Awaited<ReturnType<typeof savePendingDocumentIntakeDraft>>;
      try {
        saved = await savePendingDocumentIntakeDraft(result.pending);
      } finally {
        savingDraftRef.current = false;
        if (processGenerationRef.current === generation) setIsSavingDraft(false);
      }

      if (processGenerationRef.current !== generation) {
        // A newer file won the race — this draft must not linger or claim the URL.
        if (saved.success) void discardPendingDocumentIntakeDraft(saved.draftId);
        return;
      }

      if (saved.success) {
        draftIdRef.current = saved.draftId;
        setDraftQueryParam(saved.draftId);
        if (previousDraftId && previousDraftId !== saved.draftId) {
          void discardPendingDocumentIntakeDraft(previousDraftId);
        }
      } else {
        // The preview stays usable and the decision stays possible; only the
        // resume capability is lost. UI and URL must not point at different
        // documents, so the stale pointer goes with it.
        draftIdRef.current = null;
        setDraftQueryParam(null);
        if (previousDraftId) void discardPendingDocumentIntakeDraft(previousDraftId);
        showToast(translate('persist.failed.userAction'));
      }

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
    if (!pendingUpload || confirmInFlightRef.current || savingDraftRef.current) return;

    if (decision === 'discard') {
      discardUpload();
      return;
    }

    const saveTraceId = startDocumentSaveTrace('upload');
    confirmInFlightRef.current = true;
    setConfirmError(null);
    setIsConfirming(true);

    try {
      traceStep(saveTraceId, 'execute_decision_start');
      const result = await executePendingDocumentDecision(pendingUpload, decision, {
        importSource: 'upload',
        saveTraceId,
      });
      traceStep(saveTraceId, 'execute_decision_resolved', {
        success: !('outcome' in result) ? result.success : true,
      });

      if (isDiscardedPendingDocumentDecision(result)) {
        await releaseCurrentDraft();
        setPendingUpload(null);
        return;
      }

      if (isNavigateExistingPendingDocumentDecision(result)) {
        discardPendingDocumentIntake(pendingUpload);
        // Draft metadata only — an existing committed ref is never removed.
        await forgetCurrentDraftMetadata();
        setPendingUpload(null);
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
        discardPendingDocumentIntake(pendingUpload);
        await forgetCurrentDraftMetadata();
        setPendingUpload(null);
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
      discardPendingDocumentIntake(pendingUpload);
      // The ref is now committed and referenced — drop the draft metadata only.
      await forgetCurrentDraftMetadata();
      setPendingUpload(null);
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
    draftIdRef.current = null;
    setDraftQueryParam(null);
    if (draftId) await discardPendingDocumentIntakeDraft(draftId);
  };

  /** Removes only the draft metadata; the file stays (committed or shared). */
  const forgetCurrentDraftMetadata = async () => {
    const draftId = draftIdRef.current;
    draftIdRef.current = null;
    setDraftQueryParam(null);
    if (draftId) await forgetUploadDraftMetadata(draftId);
  };

  const discardUpload = () => {
    discardPendingDocumentIntake(pendingUpload);
    void releaseCurrentDraft();
    setPendingUpload(null);
    setConfirmError(null);
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

  /**
   * UPLOAD-DRAFT-RESUME-01B1B — the same real file input in every page state.
   * Only one branch renders at a time, so exactly one input carries inputRef and
   * openFilePicker works in preview and error views too.
   */
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
      className="document-upload-dropzone__input"
      data-testid="document-upload-input"
      onChange={onInputChange}
      disabled={isProcessing}
    />
  );

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
        {fileInput}
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

    const uploadContractProposal = resolvePendingDocumentContractProposal(pendingUpload);

    return (
      <div className="page document-upload-page" data-testid="document-upload-page">
        <button type="button" className="back-link" onClick={() => navigate('/dokumente')}>
          ← {translate('common.back')}
        </button>
        <PageHeader
          title={translate('document.upload.title')}
          subtitle={translate('scan.ocr.previewSubtitle')}
        />
        {fileInput}
        <OcrPreviewPanel
          fileName={pendingUpload.cachedFile.fileName}
          extraction={pendingUpload.extraction}
          preview={pendingUpload.preview}
          contractProposal={uploadContractProposal}
          storageRecommendation={pendingUpload.storageRecommendation}
          decisionActions={buildPendingDocumentDecisionActions(pendingUpload)}
          pendingNoticeLabel={translate('document.intakePreview.pendingNotice')}
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
          onDecision={(decision) => void handlePendingDecision(decision)}
          isConfirming={isConfirming || isSavingDraft}
          confirmErrorTitle={confirmErrorView ? translate(confirmErrorView.titleKey) : undefined}
          confirmErrorMessage={confirmErrorView ? translate(confirmErrorView.descriptionKey) : undefined}
          confirmErrorDiagnostic={persistErrorDiagnostic}
          onRetryConfirm={
            confirmError && isConfirmRetryableIntakeError(confirmError)
              ? () => void handlePendingDecision('save_permanently')
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
          {fileInput}
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
