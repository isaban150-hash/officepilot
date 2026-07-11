import { Card, CardTitle } from '../../ui/Card';
import type { DocumentReviewRecommendationView } from '../../../services/documentReviewViewService';
import type { TranslationKey } from '../../../i18n';

interface DocumentReviewRecommendationsProps {
  recommendations: DocumentReviewRecommendationView[];
  paperRegisterHint?: string;
  translate: (key: TranslationKey) => string;
}

export function DocumentReviewRecommendations({
  recommendations,
  paperRegisterHint,
  translate,
}: DocumentReviewRecommendationsProps) {
  return (
    <Card className="document-review-recommendations" data-testid="document-review-recommendations">
      <CardTitle>{translate('reviewWorkflow.recommend.title')}</CardTitle>
      <ul className="document-review-list">
        {recommendations.map((item) => (
          <li key={item.id} className="document-review-list__item">
            <span className="document-review-list__mark" aria-hidden>
              ✓
            </span>
            <span>
              {translate(item.labelKey)}
              {item.id === 'paper-register' && paperRegisterHint ? (
                <span className="document-review-list__hint"> — {paperRegisterHint}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
