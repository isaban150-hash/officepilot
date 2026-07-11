import { Card, CardMeta, CardTitle } from '../../ui/Card';
import type { DocumentReviewHeroView } from '../../../services/documentReviewViewService';
import type { TranslationKey } from '../../../i18n';

interface DocumentReviewHeroProps {
  hero: DocumentReviewHeroView;
  translate: (key: TranslationKey) => string;
}

export function DocumentReviewHero({ hero, translate }: DocumentReviewHeroProps) {
  return (
    <div data-testid="document-review-hero">
      <Card className="document-review-hero" highlight>
      <CardTitle>{translate('reviewWorkflow.hero.title')}</CardTitle>
      <CardMeta>{translate(hero.introKey)}</CardMeta>

      <dl className="document-review-hero__facts">
        <div className="document-review-hero__row">
          <dt>{translate('reviewWorkflow.hero.documentType')}</dt>
          <dd data-testid="document-review-hero-type">{translate(hero.documentTypeKey)}</dd>
        </div>
        <div className="document-review-hero__row">
          <dt>{translate(hero.contextLabelKey)}</dt>
          <dd data-testid="document-review-hero-context">
            {hero.contextValue || translate('reviewWorkflow.hero.unknown')}
          </dd>
        </div>
      </dl>
      </Card>
    </div>
  );
}
