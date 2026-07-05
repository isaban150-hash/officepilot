import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { OcrPreviewPanel } from '../components/scan/OcrPreviewPanel';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  UPLOAD_DOCUMENT_KINDS,
  UPLOAD_KIND_LABELS,
} from '../services/inboxUploadFactory';
import { processUpload } from '../services/inboxService';
import {
  buildOcrPreviewSummary,
  extractDocumentText,
  type DocumentTextExtractionResult,
  type OcrPreviewSummary,
} from '../services/ocrDocumentService';
import type { UploadDocumentKind } from '../types/models';

interface PendingScan {
  file: File;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
}

export function ScanPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [selectedKind, setSelectedKind] = useState<UploadDocumentKind | null>(null);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleUploadComplete = (itemId: string) => {
    showToast(translate('scanResult.toastRecognized'));
    navigate(`/ablage/${itemId}`);
  };

  const processFile = async (file: File) => {
    setIsProcessing(true);
    try {
      const extraction = await extractDocumentText(file);
      const preview = buildOcrPreviewSummary(
        file.name,
        extraction.recognizedText,
        selectedKind ?? undefined,
      );

      if (extraction.errorCode === 'unsupported_format') {
        showToast(extraction.message ?? translate('scan.ocr.unsupportedFormat'));
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

  const confirmPendingScan = () => {
    if (!pendingScan) return;

    const recognizedText = pendingScan.extraction.recognizedText.trim() || undefined;
    const item = processUpload({
      sourceFileName: pendingScan.file.name,
      kind: selectedKind ?? undefined,
      recognizedText,
    });

    setPendingScan(null);
    handleUploadComplete(item.id);
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

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/jpeg,image/png,image/jpg,image/*,.pdf"
          capture="environment"
          className="sr-only"
          onChange={handleFileChange}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/jpg,image/*,.pdf"
          className="sr-only"
          onChange={handleFileChange}
        />

        <div className="upload-actions">
          <Button
            fullWidth
            data-testid="scan-capture-button"
            onClick={handleCapture}
            disabled={isProcessing}
          >
            {isProcessing ? translate('scan.ocr.processing') : translate('heute.scanButton')}
          </Button>
          <Button variant="outline" fullWidth onClick={handleFileSelect} disabled={isProcessing}>
            {translate('scan.uploadFile')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
