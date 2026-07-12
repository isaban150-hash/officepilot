import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { buildDeskSuccesses } from '../../services/deskIntelligenceService';
import type { TranslationKey } from '../../i18n';

function interpolate(
  translate: (key: TranslationKey) => string,
  key: TranslationKey,
  count: number,
): string {
  return translate(key).replace('{count}', String(count));
}

export function DeskSuccesses() {
  const { translate } = useApp();
  const successes = useMemo(() => buildDeskSuccesses(), []);

  if (successes.length === 0) return null;

  return (
    <section className="desk-successes" data-testid="desk-successes" aria-label={translate('desk.successesTitle')}>
      <h2 className="desk-successes__title">{translate('desk.successesTitle')}</h2>
      <ul className="desk-successes__list">
        {successes.map((entry) => (
          <li key={entry.id} className="desk-successes__item" data-testid={`desk-success-${entry.id}`}>
            <span className="desk-successes__check" aria-hidden>
              ✓
            </span>
            <span>{interpolate(translate, entry.messageKey, entry.count)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
