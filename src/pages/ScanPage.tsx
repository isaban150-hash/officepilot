import { useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DocumentUploadErrorPanel } from '../components/documents/DocumentUploadErrorPanel';
import { OcrPreviewPanel } from '../components/scan/OcrPreviewPanel';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  UPLOAD_DOCUMENT_KINDS,
  UPLOAD_KIND_LABELS,
} from '../services/inboxUploadFactory';
import { intakeDocumentFile } from '../services/documentIntakeService';
import {
  isBlockingExtractionError,
  type DocumentUploadErrorCode,
} from '../services/documentUploadErrorService';
import { isHeicUploadFile } from '../services/documentUploadValidation';
import {
  buildOcrPreviewSummary,
  extractDocumentText,
  type DocumentTextExtractionResult,
  type OcrPreviewSummary,
} from '../services/ocrDocumentService';
import type { UploadDocumentKind } from '../types/models';

const SCAN_FILE_ACCEPT =
  'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';

interface PendingScan {
  file: File;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
}

export function ScanPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [selectedKind, setSelectedKind] = useState<UploadDocumentKind | null>(null);
  const [showKindPicker, setShowKindPicker] = useState(false);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [uploadError, setUploadError] = useState<DocumentUploadErrorCode | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
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
    setIsProcessing(true);
    try {
      const extraction = await extractDocumentText(file);

      if (isBlockingExtractionError(extraction.errorCode)) {
        setUploadError(extraction.errorCode ?? 'ocr_failed');
        return;
      }

      const preview = buildOcrPreviewSummary(
        file.name,
        extraction.recognizedText,
        selectedKind ?? undefined,
      );

      setPendingScan({ file, extraction, preview });

      if (extraction.qualityHint) {
        showToast(extraction.qualityHint);
      }
    } catch {
      setUploadError('ocr_failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const confirmPendingScan = async () => {
    if (!pendingScan) return;

    if (isHeicUploadFile(pendingScan.file)) {
      setUploadError('heic_unsupported');
      setPendingScan(null);
      return;
    }

    const recognizedText = pendingScan.extraction.recognizedText.trim() || undefined;
    const result = await intakeDocumentFile(pendingScan.file, {
      sourceFileName: pendingScan.file.name,
      kind: selectedKind ?? undefined,
      recognizedText,
      importSource: 'scan',
    });

    setPendingScan(null);

    if (!result.success) {
      setUploadError(result.error);
      return;
    }

    if (result.duplicate) {
      showToast(translate('document.upload.duplicateDetected'));
      if (result.existing?.type === 'inbox') {
        navigate(`/ablage/${result.existing.id}`);
      } else if (result.existing?.type === 'document') {
        navigate(`/dokumente/${result.existing.id}`);
      }
      return;
    }

    handleUploadComplete(result.inboxItem.id);
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
                  {UPLOAD_KIND_LABELS[kind]}
                </button>
              ))}
            </div>
            <Button variant="outline" fullWidth onClick={() => setShowKindPicker(false)}>
              {translate('common.back')}
            </Button>
          </Card>
        ) : null}
        <OcrPreviewPanel
          fileName={pendingScan.file.name}
          extraction={pendingScan.extraction}
          preview={pendingScan.preview}
          continueLabel={translate('scan.ocr.continue')}
          qualityHintLabel={pendingScan.extraction.qualityHint}
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
