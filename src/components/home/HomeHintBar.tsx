import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { buildHomeHints, type HomeHint, type HomeHintSeverity } from '../../services/homeHintService';
import {
  dismissHomeHint,
  snoozeHomeHint,
  type SnoozeDuration,
} from '../../services/homeHintDismissalService';
import type { TranslationKey } from '../../i18n';

const SEVERITY_EMOJI: Record<HomeHintSeverity, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🟡',
};

const SNOOZE_OPTIONS: { duration: SnoozeDuration; key: TranslationKey }[] = [
  { duration: 'tomorrow', key: 'hints.action.snoozeTomorrow' },
  { duration: '3days', key: 'hints.action.snooze3Days' },
  { duration: 'nextweek', key: 'hints.action.snoozeNextWeek' },
];

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

function translateHint(
  translate: (key: TranslationKey) => string,
  hint: HomeHint,
): string {
  return interpolate(translate, hint.messageKey, hint.params);
}

export function HomeHintBar() {
  const { translate } = useApp();
  const [hints, setHints] = useState<HomeHint[]>(() => buildHomeHints());

  const visibleHints = useMemo(() => hints.slice(0, 3), [hints]);

  const refresh = useCallback(() => {
    setHints(buildHomeHints());
  }, []);

  const handleDone = useCallback(
    (hintId: string) => {
      dismissHomeHint(hintId, 'done');
      refresh();
    },
    [refresh],
  );

  const handleHide = useCallback(
    (hintId: string) => {
      dismissHomeHint(hintId, 'hidden');
      refresh();
    },
    [refresh],
  );

  const handleSnooze = useCallback(
    (hintId: string, duration: SnoozeDuration) => {
      snoozeHomeHint(hintId, duration);
      refresh();
    },
    [refresh],
  );

  if (visibleHints.length === 0) return null;

  return (
    <section className="home-hint-bar" data-testid="home-hint-bar" aria-label={translate('hints.barTitle')}>
      <ul className="home-hint-bar__list">
        {visibleHints.map((hint) => (
          <li key={hint.id} className="home-hint-bar__item" data-testid={`home-hint-${hint.id}`}>
            <div className="home-hint-bar__content">
              <span className="home-hint-bar__severity" aria-hidden>
                {SEVERITY_EMOJI[hint.severity]}
              </span>
              {hint.route ? (
                <Link to={hint.route} className="home-hint-bar__text">
                  {translateHint(translate, hint)}
                </Link>
              ) : (
                <span className="home-hint-bar__text">{translateHint(translate, hint)}</span>
              )}
            </div>
            <div className="home-hint-bar__actions">
              <button
                type="button"
                className="home-hint-bar__action"
                data-testid={`home-hint-done-${hint.id}`}
                onClick={() => handleDone(hint.id)}
              >
                {translate('hints.action.done')}
              </button>
              {SNOOZE_OPTIONS.map(({ duration, key }) => (
                <button
                  key={duration}
                  type="button"
                  className="home-hint-bar__action home-hint-bar__action--snooze"
                  data-testid={`home-hint-snooze-${duration}-${hint.id}`}
                  onClick={() => handleSnooze(hint.id, duration)}
                >
                  ⏰ {translate(key)}
                </button>
              ))}
              <button
                type="button"
                className="home-hint-bar__action home-hint-bar__action--muted"
                data-testid={`home-hint-hide-${hint.id}`}
                onClick={() => handleHide(hint.id)}
              >
                {translate('hints.action.hide')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
