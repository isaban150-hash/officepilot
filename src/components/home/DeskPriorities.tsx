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
import { DropdownMenu, type DropdownMenuItem } from '../ui/DropdownMenu';
import { Icon } from '../ui/Icon';
import { StatusBadge } from '../ui/Badge';

/** VISUAL-POLISH-01B — Statuswort je Dringlichkeit statt farbigem Punkt. */
const SEVERITY_TONE: Record<HomeHintSeverity, 'critical' | 'warning' | 'info'> = {
  critical: 'critical',
  warning: 'warning',
  info: 'info',
};

const SEVERITY_LABEL_KEY: Record<HomeHintSeverity, TranslationKey> = {
  critical: 'priority.kritisch',
  warning: 'priority.hoch',
  info: 'priority.mittel',
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

interface DeskPrioritiesProps {
  /** Sichtbare Zeilen (Desktop 5, Mobil 3); der Rest ist über „Alle anzeigen" erreichbar. */
  limit?: number;
}

export function DeskPriorities({ limit = 5 }: DeskPrioritiesProps = {}) {
  const { translate } = useApp();
  const [priorities, setPriorities] = useState<HomeHint[]>(() => buildDeskPriorities());

  const visiblePriorities = useMemo(() => priorities.slice(0, limit), [priorities, limit]);
  const hiddenCount = Math.max(0, priorities.length - visiblePriorities.length);

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
          {translate('desk.noPriorities')}
        </p>
      </section>
    );
  }

  /*
   * VISUAL-POLISH-01B — eine ruhige Fläche statt einer Karte pro Punkt:
   * Statuswort, Aussage, rechts zwei kleine Symbolaktionen (Erledigt, Weitere).
   * Snooze/Erledigt/Ausblenden bleiben fachlich unverändert.
   */
  return (
    <section className="desk-priorities priority-list" data-testid="desk-priorities" aria-label={translate('desk.prioritiesTitle')}>
      <ul className="desk-priorities__list priority-list__list">
        {visiblePriorities.map((hint) => {
          const moreItems: DropdownMenuItem[] = [
            ...SNOOZE_OPTIONS.map(({ duration, key }) => ({
              id: `snooze-${duration}`,
              label: translate(key),
              onSelect: () => handleSnooze(hint.id, duration),
              testId: `desk-priority-snooze-${duration}-${hint.id}`,
            })),
            {
              id: 'hide',
              label: translate('hints.action.hide'),
              onSelect: () => handleHide(hint.id),
              destructive: true,
              testId: `desk-priority-hide-${hint.id}`,
            },
          ];

          return (
            <li key={hint.id} className={`desk-priorities__item priority-list__item priority-list__item--${hint.severity}`} data-testid={`desk-priority-${hint.id}`}>
              <div className="desk-priorities__content priority-list__content">
                <span
                  className={`desk-priorities__severity priority-list__status desk-priorities__severity--${hint.severity}`}
                  data-severity={hint.severity}
                  data-testid={`desk-priority-severity-${hint.id}`}
                >
                  <StatusBadge tone={SEVERITY_TONE[hint.severity]} label={translate(SEVERITY_LABEL_KEY[hint.severity])} icon={false} />
                </span>
                {hint.route ? (
                  <Link to={hint.route} className="desk-priorities__text">
                    {translateHint(translate, hint)}
                  </Link>
                ) : (
                  <span className="desk-priorities__text">{translateHint(translate, hint)}</span>
                )}
              </div>
              <div className="desk-priorities__actions priority-list__actions">
                <button
                  type="button"
                  className="priority-list__icon-action"
                  data-testid={`desk-priority-done-${hint.id}`}
                  onClick={() => handleDone(hint.id)}
                  aria-label={translate('hints.action.done')}
                  title={translate('hints.action.done')}
                >
                  <Icon id="check" size="sm" />
                  <span className="sr-only">{translate('hints.action.done')}</span>
                </button>
                <DropdownMenu
                  testId={`desk-priority-more-${hint.id}`}
                  ariaLabel={translate('invoice.moreActions')}
                  align="end"
                  trigger={
                    <span className="priority-list__icon-action priority-list__icon-action--more" title={translate('invoice.moreActions')}>
                      <Icon id="more" size="sm" />
                      <span className="sr-only">{translate('invoice.moreActions')}</span>
                    </span>
                  }
                  items={moreItems}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 ? (
        <Link to="/aufgaben" className="priority-list__more" data-testid="desk-priorities-show-all">
          {translate('desk.showAllPriorities').replace('{count}', String(hiddenCount))}
        </Link>
      ) : null}
    </section>
  );
}
