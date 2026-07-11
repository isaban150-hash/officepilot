import { Button } from '../../ui/Button';
import { Card, CardTitle } from '../../ui/Card';
import type { DocumentReviewSuccessStepView } from '../../../services/documentReviewViewService';
import type { TranslationKey } from '../../../i18n';

interface DocumentReviewSuccessProps {
  steps: DocumentReviewSuccessStepView[];
  vorgangId?: string;
  translate: (key: TranslationKey) => string;
  onOpenVorgang?: () => void;
  onNextDocument: () => void;
}

export function DocumentReviewSuccess({
  steps,
  vorgangId,
  translate,
  onOpenVorgang,
  onNextDocument,
}: DocumentReviewSuccessProps) {
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
        {vorgangId && onOpenVorgang && (
          <Button fullWidth onClick={onOpenVorgang} data-testid="document-review-open-vorgang">
            {translate('reviewWorkflow.success.openOrder')}
          </Button>
        )}
        <Button variant="outline" fullWidth onClick={onNextDocument} data-testid="document-review-next-document">
          {translate('reviewWorkflow.success.nextDocument')}
        </Button>
      </div>
    </Card>
  );
}
