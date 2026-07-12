import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { buildDeskPriorities } from '../../services/deskIntelligenceService';
import type { HomeHint, HomeHintSeverity } from '../../services/homeHintService';
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

export function DeskPriorities() {
  const { translate } = useApp();
  const [priorities, setPriorities] = useState<HomeHint[]>(() => buildDeskPriorities());

  const visiblePriorities = useMemo(() => priorities.slice(0, 3), [priorities]);

  const refresh = useCallback(() => {
    setPriorities(buildDeskPriorities());
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

  if (visiblePriorities.length === 0) {
    return (
      <section className="desk-priorities desk-priorities--empty" data-testid="desk-priorities">
        <p className="desk-priorities__empty" data-testid="desk-priorities-empty">
          <span aria-hidden>🟢</span> {translate('desk.noPriorities')}
        </p>
      </section>
    );
  }

  return (
    <section className="desk-priorities" data-testid="desk-priorities" aria-label={translate('desk.prioritiesTitle')}>
      <ul className="desk-priorities__list">
        {visiblePriorities.map((hint) => (
          <li key={hint.id} className="desk-priorities__item" data-testid={`desk-priority-${hint.id}`}>
            <div className="desk-priorities__content">
              <span className="desk-priorities__severity" aria-hidden>
                {SEVERITY_EMOJI[hint.severity]}
              </span>
              {hint.route ? (
                <Link to={hint.route} className="desk-priorities__text">
                  {translateHint(translate, hint)}
                </Link>
              ) : (
                <span className="desk-priorities__text">{translateHint(translate, hint)}</span>
              )}
            </div>
            <div className="desk-priorities__actions">
              <button
                type="button"
                className="desk-priorities__action"
                data-testid={`desk-priority-done-${hint.id}`}
                onClick={() => handleDone(hint.id)}
              >
                {translate('hints.action.done')}
              </button>
              {SNOOZE_OPTIONS.map(({ duration, key }) => (
                <button
                  key={duration}
                  type="button"
                  className="desk-priorities__action desk-priorities__action--snooze"
                  data-testid={`desk-priority-snooze-${duration}-${hint.id}`}
                  onClick={() => handleSnooze(hint.id, duration)}
                >
                  ⏰ {translate(key)}
                </button>
              ))}
              <button
                type="button"
                className="desk-priorities__action desk-priorities__action--muted"
                data-testid={`desk-priority-hide-${hint.id}`}
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
