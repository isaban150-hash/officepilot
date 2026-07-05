import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import type { OcrPreviewSummary } from '../../services/ocrDocumentService';
import type { DocumentTextExtractionResult } from '../../services/ocrDocumentService';

interface OcrPreviewPanelProps {
  fileName: string;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
  continueLabel: string;
  qualityHintLabel?: string;
  documentTypeLabel: string;
  senderLabel: string;
  previewTextLabel: string;
  onContinue: () => void;
  onCancel: () => void;
  cancelLabel: string;
}

export function OcrPreviewPanel({
  fileName,
  extraction,
  preview,
  continueLabel,
  qualityHintLabel,
  documentTypeLabel,
  senderLabel,
  previewTextLabel,
  onContinue,
  onCancel,
  cancelLabel,
}: OcrPreviewPanelProps) {
  return (
    <Card className="ocr-preview-panel" data-testid="ocr-preview-panel">
      <CardTitle>{fileName}</CardTitle>
      <CardMeta>
        {extraction.sourceType === 'pdf' ? 'PDF' : 'Foto'} · {extraction.confidence}
      </CardMeta>

      {qualityHintLabel && (
        <p className="ocr-preview-panel__hint" data-testid="ocr-quality-hint">
          {qualityHintLabel}
        </p>
      )}

      {preview.classifiedKind && (
        <p className="ocr-preview-panel__meta">
          <span className="ocr-preview-panel__label">{documentTypeLabel}</span>
          {preview.documentTypeLabel}
          {preview.classifiedKind ? ` (${preview.classifiedKind})` : ''}
        </p>
      )}

      {preview.sender && (
        <p className="ocr-preview-panel__meta">
          <span className="ocr-preview-panel__label">{senderLabel}</span>
          {preview.sender}
        </p>
      )}

      {preview.previewLines.length > 0 && (
        <div className="ocr-preview-panel__text">
          <span className="ocr-preview-panel__label">{previewTextLabel}</span>
          {preview.previewLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      <div className="ocr-preview-panel__actions">
        <Button fullWidth data-testid="ocr-continue-button" onClick={onContinue}>
          {continueLabel}
        </Button>
        <Button variant="outline" fullWidth onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </Card>
  );
}
