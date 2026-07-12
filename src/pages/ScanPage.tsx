import { useRef, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  resolveExtractionErrorKey,
  resolveIntakeErrorKey,
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
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
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

  const showExtractionFailure = (extraction: DocumentTextExtractionResult): boolean => {
    if (!isBlockingExtractionError(extraction.errorCode)) {
      return false;
    }
    const key = resolveExtractionErrorKey(extraction.errorCode);
    showToast(key ? translate(key) : translate('scan.ocr.failed'));
    return true;
  };

  const processFile = async (file: File) => {
    if (isHeicUploadFile(file)) {
      showToast(translate('document.upload.error.unsupportedPhotoFormat'));
      return;
    }

    setIsProcessing(true);
    try {
      const extraction = await extractDocumentText(file);
      const preview = buildOcrPreviewSummary(
        file.name,
        extraction.recognizedText,
        selectedKind ?? undefined,
      );

      if (showExtractionFailure(extraction)) {
        return;
      }

      setPendingScan({ file, extraction, preview });

      if (extraction.qualityHint) {
        showToast(extraction.qualityHint);
      }
    } catch {
      showToast(translate('scan.ocr.failed'));
    } finally {
      setIsProcessing(false);
    }
  };

  const confirmPendingScan = async () => {
    if (!pendingScan) return;

    if (isHeicUploadFile(pendingScan.file)) {
      showToast(translate('document.upload.error.unsupportedPhotoFormat'));
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
      showToast(translate(resolveIntakeErrorKey(result.error)));
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

  const handleCapture = () => {
    cameraInputRef.current?.click();
  };

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await processFile(file);
  };

  if (pendingScan) {
    return (
      <div className="page scan-page" data-testid="scan-page">
        <PageHeader title={translate('scan.title')} subtitle={translate('scan.ocr.previewSubtitle')} />
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
        <CardMeta>{translate('scan.captureHint')}</CardMeta>

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
            onClick={handleCapture}
            disabled={isProcessing}
            loading={isProcessing}
          >
            {isProcessing ? translate('scan.ocr.processing') : translate('heute.scanButton')}
          </Button>
          <Button variant="outline" fullWidth onClick={handleFileSelect} disabled={isProcessing}>
            {translate('scan.uploadFile')}
          </Button>
        </div>

        <fieldset className="form-group upload-kind-picker">
          <legend>{translate('scan.selectType')}</legend>
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
        </fieldset>
      </Card>
    </div>
  );
}
