import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { ContractWorkspaceSummary } from '../inbox/review/ContractWorkspaceSummary';
import type { TranslationKey } from '../../i18n';
import type { OcrPreviewSummary } from '../../services/ocrDocumentService';
import type { DocumentTextExtractionResult } from '../../services/ocrDocumentService';
import type { PersistFailureDiagnostic } from '../../services/persistenceService';
import type { ContractOrderProposal } from '../../types/documentIntelligence';
import {
  getRecognitionStatusKey,
  getSteuerberaterHintKey,
  getStorageRecommendationLevelKey,
  translateStorageReasonKey,
} from '../../services/storageRecommendationPresentationService';
import type { StorageDecisionActionSpec } from '../../services/userStorageDecisionPresentationService';
import type { StorageRecommendation } from '../../types/storageRecommendation';
import type { UserStorageDecision } from '../../types/userStorageDecision';

function formatApproxStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


interface OcrPreviewPanelProps {
  fileName: string;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
  storageRecommendation: StorageRecommendation;
  decisionActions: StorageDecisionActionSpec[];
  pendingNoticeLabel?: string;
  qualityHintLabel?: string;
  documentTypeLabel: string;
  senderLabel: string;
  previewTextLabel: string;
  aiActionsLabel: string;
  contractProposal?: ContractOrderProposal | null;
  translate: (key: TranslationKey) => string;
  onDecision: (decision: UserStorageDecision) => void;
  isConfirming?: boolean;
  onChangeType?: () => void;
  changeTypeLabel?: string;
  confirmErrorTitle?: string;
  confirmErrorMessage?: string;
  confirmErrorDiagnostic?: PersistFailureDiagnostic | null;
  onRetryConfirm?: () => void;
  onNewPhoto?: () => void;
  onSelectFile?: () => void;
}

export function OcrPreviewPanel({
  fileName,
  preview,
  storageRecommendation,
  decisionActions,
  pendingNoticeLabel,
  qualityHintLabel,
  documentTypeLabel,
  senderLabel,
  previewTextLabel,
  aiActionsLabel,
  contractProposal,
  translate,
  onDecision,
  onChangeType,
  changeTypeLabel,
  isConfirming = false,
  confirmErrorTitle,
  confirmErrorMessage,
  confirmErrorDiagnostic,
  onRetryConfirm,
  onNewPhoto,
  onSelectFile,
}: OcrPreviewPanelProps) {
  const understanding = preview.understanding;
  const resolvedContractProposal = contractProposal ?? null;
  const showContractSummary = Boolean(resolvedContractProposal);
  const showPreviewLines = preview.previewLines.length > 0 || preview.previewPartialHint;
  const ocrFastPath = decisionActions.some((action) => action.ocrFastPathPrimary);
  const persistingDecisions = new Set<UserStorageDecision>([
    'save_permanently',
    'keep_temporarily',
    'save_duplicate_anyway',
  ]);

  return (
    <Card className="ocr-preview-panel" data-testid="ocr-preview-panel">
      <CardTitle>{fileName}</CardTitle>
      <CardMeta data-testid="ocr-extraction-meta">
        {translate('docAssistant.recognized')}: {translate(preview.documentTypeLabelKey)}
      </CardMeta>

      {pendingNoticeLabel ? (
        <p className="ocr-preview-panel__pending-notice" data-testid="ocr-pending-notice">
          {pendingNoticeLabel}
        </p>
      ) : null}

      <div className="ocr-preview-panel__storage-recommendation" data-testid="storage-recommendation">
        <p className="ocr-preview-panel__storage-level" data-testid="storage-recommendation-level">
          {translate(getStorageRecommendationLevelKey(storageRecommendation.level))}
        </p>
        <ul className="ocr-preview-panel__storage-reasons" data-testid="storage-recommendation-reasons">
          {storageRecommendation.reasonKeys.map((reasonKey) => (
            <li key={reasonKey}>{translateStorageReasonKey(reasonKey, translate)}</li>
          ))}
        </ul>
        {storageRecommendation.recommendedFolder ? (
          <p className="ocr-preview-panel__storage-folder" data-testid="storage-recommendation-folder">
            <span className="ocr-preview-panel__label">
              {translate('storageRecommendation.folderLabel')}
            </span>
            {storageRecommendation.recommendedFolder.path}
          </p>
        ) : null}
        {storageRecommendation.recognitionStatus ? (
          <p className="ocr-preview-panel__storage-recognition" data-testid="storage-recommendation-recognition">
            {translate(getRecognitionStatusKey(storageRecommendation.recognitionStatus))}
          </p>
        ) : null}
        {storageRecommendation.steuerberaterHint &&
        storageRecommendation.steuerberaterHint !== 'not_relevant' ? (
          <p className="ocr-preview-panel__storage-tax" data-testid="storage-recommendation-tax">
            {translate(getSteuerberaterHintKey(storageRecommendation.steuerberaterHint))}
          </p>
        ) : null}
        {storageRecommendation.duplicateMatch ? (
          <p className="ocr-preview-panel__storage-duplicate" data-testid="storage-recommendation-duplicate">
            {storageRecommendation.duplicateMatch.title}
          </p>
        ) : null}
        {storageRecommendation.disclaimerKey ? (
          <p className="ocr-preview-panel__storage-disclaimer" data-testid="storage-recommendation-disclaimer">
            {translate(storageRecommendation.disclaimerKey as TranslationKey)}
          </p>
        ) : null}
      </div>

      {qualityHintLabel && (
        <p className="ocr-preview-panel__hint" data-testid="ocr-quality-hint">
          {qualityHintLabel}
        </p>
      )}

      {confirmErrorTitle && confirmErrorMessage ? (
        <div className="ocr-preview-panel__confirm-error" role="alert" data-testid="ocr-confirm-error">
          <p className="ocr-preview-panel__confirm-error-title">{confirmErrorTitle}</p>
          <p>{confirmErrorMessage}</p>
          {confirmErrorDiagnostic ? (
            <dl
              className="ocr-preview-panel__confirm-error-diagnostic"
              data-testid="ocr-confirm-error-diagnostic"
            >
              <div>
                <dt>Phase</dt>
                <dd>{confirmErrorDiagnostic.phase}</dd>
              </div>
              <div>
                <dt>Fehler</dt>
                <dd>{confirmErrorDiagnostic.errorName}</dd>
              </div>
              <div>
                <dt>Meldung</dt>
                <dd>{confirmErrorDiagnostic.errorMessage}</dd>
              </div>
              <div>
                <dt>Größe</dt>
                <dd>
                  {formatApproxStorageSize(confirmErrorDiagnostic.payloadBytesApprox)} (
                  {confirmErrorDiagnostic.payloadCharacters.toLocaleString()} Zeichen)
                </dd>
              </div>
              {confirmErrorDiagnostic.existingStoredCharacters !== undefined ? (
                <div>
                  <dt>Bereits gespeichert</dt>
                  <dd>{confirmErrorDiagnostic.existingStoredCharacters.toLocaleString()} Zeichen</dd>
                </div>
              ) : null}
              <div>
                <dt>Storage-Key</dt>
                <dd>{confirmErrorDiagnostic.storageKey}</dd>
              </div>
            </dl>
          ) : null}
          <div className="ocr-preview-panel__confirm-error-actions">
            {onRetryConfirm ? (
              <Button fullWidth onClick={onRetryConfirm} data-testid="ocr-confirm-retry">
                {translate('docAssistant.error.retry')}
              </Button>
            ) : null}
            {onNewPhoto ? (
              <Button variant="outline" fullWidth onClick={onNewPhoto} data-testid="ocr-confirm-new-photo">
                {translate('docAssistant.error.newPhoto')}
              </Button>
            ) : null}
            {onSelectFile ? (
              <Button variant="outline" fullWidth onClick={onSelectFile} data-testid="ocr-confirm-select-file">
                {translate('docAssistant.error.selectFile')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showContractSummary && resolvedContractProposal ? (
        <ContractWorkspaceSummary proposal={resolvedContractProposal} translate={translate} />
      ) : null}

      {understanding && !showContractSummary && (
        <dl className="ocr-preview-panel__summary" data-testid="ocr-understanding-summary">
          <div className="ocr-preview-panel__meta">
            <span className="ocr-preview-panel__label">{documentTypeLabel}</span>
            {translate(preview.documentTypeLabelKey)}
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

      {preview.aiActions && preview.aiActions.length > 0 && (
        <div className="ocr-preview-panel__actions-list" data-testid="ocr-ai-actions">
          <span className="ocr-preview-panel__label">{aiActionsLabel}</span>
          <ul>
            {preview.aiActions.slice(0, 3).map((action) => (
              <li key={action.id}>
                <span aria-hidden>✓</span> {translate(action.labelKey as TranslationKey)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showPreviewLines && (
        <details className="ocr-preview-panel__details">
          <summary>{previewTextLabel}</summary>
          <div className="ocr-preview-panel__text">
            {preview.previewPartialHint ? (
              <p>{translate('scan.ocr.partialHint')}</p>
            ) : null}
            {preview.previewLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </details>
      )}

      <div
        className="ocr-preview-panel__actions"
        data-testid="ocr-storage-decision-actions"
        data-ocr-fast-path={ocrFastPath ? 'true' : 'false'}
      >
        {decisionActions.map((action) => (
          <Button
            key={action.decision}
            fullWidth
            variant={action.variant === 'primary' ? undefined : 'outline'}
            data-testid={action.testId}
            data-ocr-fast-path-primary={action.ocrFastPathPrimary ? 'true' : undefined}
            onClick={() => onDecision(action.decision)}
            disabled={isConfirming}
            loading={isConfirming && persistingDecisions.has(action.decision)}
          >
            {isConfirming && persistingDecisions.has(action.decision)
              ? translate('scan.ocr.processing')
              : translate(action.labelKey)}
          </Button>
        ))}
        {onChangeType && changeTypeLabel ? (
          <Button
            variant="outline"
            fullWidth
            onClick={onChangeType}
            data-testid="ocr-change-type-button"
            disabled={isConfirming}
          >
            {changeTypeLabel}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
