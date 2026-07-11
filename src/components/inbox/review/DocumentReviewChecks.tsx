import { Card, CardTitle } from '../../ui/Card';
import type { DocumentReviewCheckView } from '../../../services/documentReviewViewService';
import type { TranslationKey } from '../../../i18n';

interface DocumentReviewChecksProps {
  checks: DocumentReviewCheckView[];
  complete: boolean;
  translate: (key: TranslationKey) => string;
}

export function DocumentReviewChecks({ checks, complete, translate }: DocumentReviewChecksProps) {
  return (
    <div data-testid="document-review-checks">
      <Card className="document-review-checks">
      <CardTitle>{translate('reviewWorkflow.check.title')}</CardTitle>

      {complete ? (
        <p className="card__meta" data-testid="document-review-checks-complete">
          {translate('reviewWorkflow.check.allComplete')}
        </p>
      ) : (
        <ul className="document-review-list document-review-list--checks">
          {checks.map((check) => (
            <li key={check.id} className="document-review-list__item">
              <span className="document-review-list__mark document-review-list__mark--warn" aria-hidden>
                !
              </span>
              <span>{translate(check.labelKey)}</span>
            </li>
          ))}
        </ul>
      )}
      </Card>
    </div>
  );
}
