import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import type { DocumentUploadErrorCode } from '../../services/documentUploadErrorService';
import { resolveUploadErrorView } from '../../services/documentUploadErrorService';

interface DocumentUploadErrorPanelProps {
  errorCode: DocumentUploadErrorCode;
  translate: (key: TranslationKey) => string;
  onRetry?: () => void;
  onNewPhoto?: () => void;
  onSelectFile?: () => void;
  testId?: string;
}

export function DocumentUploadErrorPanel({
  errorCode,
  translate,
  onRetry,
  onNewPhoto,
  onSelectFile,
  testId = 'document-upload-error-panel',
}: DocumentUploadErrorPanelProps) {
  const view = resolveUploadErrorView(errorCode);

  return (
    <Card className="document-upload-error-panel" data-testid={testId}>
      <div role="alert">
      <CardTitle>{translate(view.titleKey)}</CardTitle>
      <CardMeta>{translate(view.descriptionKey)}</CardMeta>
      {view.hintKey ? <p className="document-upload-error-panel__hint">{translate(view.hintKey)}</p> : null}

      <div className="document-upload-error-panel__actions">
        {view.allowRetry && onRetry ? (
          <Button fullWidth onClick={onRetry} data-testid="document-error-retry">
            {translate('docAssistant.error.retry')}
          </Button>
        ) : null}
        {view.allowNewPhoto && onNewPhoto ? (
          <Button variant="outline" fullWidth onClick={onNewPhoto} data-testid="document-error-new-photo">
            {translate('docAssistant.error.newPhoto')}
          </Button>
        ) : null}
        {view.allowSelectFile && onSelectFile ? (
          <Button variant="outline" fullWidth onClick={onSelectFile} data-testid="document-error-select-file">
            {translate('docAssistant.error.selectFile')}
          </Button>
        ) : null}
      </div>
      </div>
    </Card>
  );
}
