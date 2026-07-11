import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import type { OcrPreviewSummary } from '../../services/ocrDocumentService';
import type { DocumentTextExtractionResult } from '../../services/ocrDocumentService';
import type { TranslationKey } from '../../i18n';

interface OcrPreviewPanelProps {
  fileName: string;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
  continueLabel: string;
  qualityHintLabel?: string;
  documentTypeLabel: string;
  senderLabel: string;
  previewTextLabel: string;
  aiActionsLabel: string;
  translate: (key: TranslationKey) => string;
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
  aiActionsLabel,
  translate,
  onContinue,
  onCancel,
  cancelLabel,
}: OcrPreviewPanelProps) {
  const understanding = preview.understanding;
  const showPreviewLines = preview.previewLines.length > 0;

  return (
    <Card className="ocr-preview-panel" data-testid="ocr-preview-panel">
      <CardTitle>{fileName}</CardTitle>
      <CardMeta>
        {extraction.sourceType === 'pdf' ? 'PDF' : 'Foto'} · {extraction.confidence}
        {extraction.extractionMethod ? ` · ${extraction.extractionMethod}` : ''}
      </CardMeta>

      {qualityHintLabel && (
        <p className="ocr-preview-panel__hint" data-testid="ocr-quality-hint">
          {qualityHintLabel}
        </p>
      )}

      {understanding && (
        <dl className="ocr-preview-panel__summary" data-testid="ocr-understanding-summary">
          <div className="ocr-preview-panel__meta">
            <span className="ocr-preview-panel__label">{documentTypeLabel}</span>
            {preview.documentTypeLabel}
            {preview.classifiedKind ? ` (${preview.classifiedKind})` : ''}
          </div>
          {understanding.sender && (
            <div className="ocr-preview-panel__meta">
              <span className="ocr-preview-panel__label">{senderLabel}</span>
              {understanding.sender}
            </div>
          )}
          {understanding.amount && (
            <div className="ocr-preview-panel__meta">
              <span className="ocr-preview-panel__label">{translate('document.intakeUnderstanding.amount')}</span>
              {understanding.amount}
            </div>
          )}
          {understanding.deadline && (
            <div className="ocr-preview-panel__meta">
              <span className="ocr-preview-panel__label">{translate('document.intakeUnderstanding.deadline')}</span>
              {understanding.deadline}
            </div>
          )}
        </dl>
      )}

      {!understanding && preview.classifiedKind && (
        <p className="ocr-preview-panel__meta">
          <span className="ocr-preview-panel__label">{documentTypeLabel}</span>
          {preview.documentTypeLabel}
          {preview.classifiedKind ? ` (${preview.classifiedKind})` : ''}
        </p>
      )}

      {!understanding && preview.sender && (
        <p className="ocr-preview-panel__meta">
          <span className="ocr-preview-panel__label">{senderLabel}</span>
          {preview.sender}
        </p>
      )}

      {preview.aiActions && preview.aiActions.length > 0 && (
        <div className="ocr-preview-panel__actions-list" data-testid="ocr-ai-actions">
          <span className="ocr-preview-panel__label">{aiActionsLabel}</span>
          <ul>
            {preview.aiActions.map((action) => (
              <li key={action.id}>
                <span aria-hidden>✓</span> {translate(action.labelKey as TranslationKey)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showPreviewLines && (
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
