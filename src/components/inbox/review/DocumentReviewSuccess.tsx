import { Button } from '../../ui/Button';
import { Card, CardTitle } from '../../ui/Card';
import type { DocumentReviewSuccessStepView } from '../../../services/documentReviewViewService';
import { resolveDocumentLifecycle } from '../../../services/documentLifecycleService';
import type { TranslationKey } from '../../../i18n';

interface DocumentReviewSuccessProps {
  steps: DocumentReviewSuccessStepView[];
  vorgangId?: string;
  archiveDocumentId?: string;
  translate: (key: TranslationKey) => string;
  onOpenVorgang?: () => void;
  onOpenArchive?: () => void;
  onNextDocument: () => void;
}

type ArchiveCtaKind = 'reply' | 'filing' | 'open';

function resolveArchiveCtaKind(archiveDocumentId: string | undefined): ArchiveCtaKind | null {
  if (!archiveDocumentId) return null;
  const lifecycle = resolveDocumentLifecycle({ documentId: archiveDocumentId });
  if (!lifecycle) return 'open';
  if (lifecycle.openReasons.includes('reply_open')) return 'reply';
  if (lifecycle.openReasons.includes('file_original')) return 'filing';
  return 'open';
}

export function DocumentReviewSuccess({
  steps,
  vorgangId,
  archiveDocumentId,
  translate,
  onOpenVorgang,
  onOpenArchive,
  onNextDocument,
}: DocumentReviewSuccessProps) {
  const archiveCtaKind = resolveArchiveCtaKind(archiveDocumentId);
  const showArchiveCta = Boolean(archiveDocumentId && onOpenArchive && archiveCtaKind);
  const archiveIsPrimary = archiveCtaKind === 'reply' || archiveCtaKind === 'filing';

  const archiveLabelKey: TranslationKey =
    archiveCtaKind === 'reply'
      ? 'reviewWorkflow.success.continueReply'
      : archiveCtaKind === 'filing'
        ? 'reviewWorkflow.success.continueFiling'
        : 'reviewWorkflow.success.openArchive';

  const archiveTestId =
    archiveCtaKind === 'reply'
      ? 'document-review-continue-reply'
      : archiveCtaKind === 'filing'
        ? 'document-review-continue-filing'
        : 'document-review-open-archive';

  return (
    <Card className="document-review-success" highlight data-testid="document-review-success">
      <CardTitle>{translate('reviewWorkflow.success.title')}</CardTitle>
      <ul className="document-review-list">
        {steps.map((step) => (
          <li key={step.id} className="document-review-list__item">
            <span className="document-review-list__mark" aria-hidden>
              ✓
            </span>
            <span>{translate(step.labelKey)}</span>
          </li>
        ))}
      </ul>

      <div className="document-review-success__actions">
        {showArchiveCta && archiveIsPrimary && (
          <Button
            fullWidth
            onClick={onOpenArchive}
            data-testid={archiveTestId}
          >
            {translate(archiveLabelKey)}
          </Button>
        )}
        {vorgangId && onOpenVorgang && (
          <Button
            fullWidth
            variant={archiveIsPrimary ? 'outline' : 'primary'}
            onClick={onOpenVorgang}
            data-testid="document-review-open-vorgang"
          >
            {translate('reviewWorkflow.success.openOrder')}
          </Button>
        )}
        {showArchiveCta && !archiveIsPrimary && (
          <Button
            fullWidth
            variant="outline"
            onClick={onOpenArchive}
            data-testid={archiveTestId}
          >
            {translate(archiveLabelKey)}
          </Button>
        )}
        <Button
          variant="outline"
          fullWidth
          onClick={onNextDocument}
          data-testid="document-review-next-document"
        >
          {translate('reviewWorkflow.success.nextDocument')}
        </Button>
      </div>
    </Card>
  );
}
