import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { buildDeskRecommendation } from '../../services/deskIntelligenceService';
import type { TranslationKey } from '../../i18n';

function interpolate(
  translate: (key: TranslationKey) => string,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  let text = translate(key);
  if (!params) return text;
  for (const [name, value] of Object.entries(params)) {
    text = text.replace(`{${name}}`, String(value));
  }
  return text;
}

export function DeskRecommendation() {
  const { translate } = useApp();
  const recommendation = useMemo(() => buildDeskRecommendation(), []);

  if (!recommendation) return null;

  const text = interpolate(translate, recommendation.messageKey, recommendation.params);

  return (
    <section className="desk-recommendation" data-testid="desk-recommendation">
      <h2 className="desk-recommendation__title">{translate('desk.recommendationTitle')}</h2>
      {recommendation.route ? (
        <Link to={recommendation.route} className="desk-recommendation__text">
          {text}
        </Link>
      ) : (
        <p className="desk-recommendation__text">{text}</p>
      )}
    </section>
  );
}
