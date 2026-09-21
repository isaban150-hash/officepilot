import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { DeskRecommendation } from '../../services/deskIntelligenceService';
import type { HomeHint, HomeHintSeverity } from '../../services/homeHintService';
import {
  dismissHomeHint,
  snoozeHomeHint,
  type SnoozeDuration,
} from '../../services/homeHintDismissalService';
import type { TranslationKey } from '../../i18n';
import { Button } from '../ui/Button';
import { DropdownMenu, type DropdownMenuItem } from '../ui/DropdownMenu';
import { Icon } from '../ui/Icon';

/**
 * STARTSEITE-04B — die grosse Fokusfläche: die eine wichtigste Priorität.
 *
 * Die Reihenfolge kommt aus `buildDeskPriorities()` und wird hier nicht neu
 * bewertet. Der kurze Satz unter der Aussage leitet sich allein aus der
 * Dringlichkeit des Hinweises ab (`severity`); er behauptet keine Aktion,
 * die es für den Hinweis nicht gibt. „Jetzt ansehen" erscheint nur, wenn
 * der Hinweis ein Ziel hat. Später/Erledigt sind die bestehenden Dienste.
 */
const SNOOZE_OPTIONS: { duration: SnoozeDuration; key: TranslationKey }[] = [
  { duration: 'tomorrow', key: 'hints.action.snoozeTomorrow' },
  { duration: '3days', key: 'hints.action.snooze3Days' },
  { duration: 'nextweek', key: 'hints.action.snoozeNextWeek' },
];

const SUB_KEY: Record<HomeHintSeverity, TranslationKey> = {
  critical: 'heute.work.subCritical',
  warning: 'heute.work.subWarning',
  info: 'heute.work.subInfo',
};

export function fillHint(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let out = text;
  for (const [name, value] of Object.entries(params)) {
    out = out.replace(`{${name}}`, String(value));
  }
  return out;
}

interface HomeFocusTaskProps {
  current: HomeHint | undefined;
  /** Nur im Leerzustand — bereits betragsfrei und mit Ziel geprüft. */
  recommendation: DeskRecommendation | null;
  onChange: () => void;
}

export function HomeFocusTask({ current, recommendation, onChange }: HomeFocusTaskProps) {
  const { translate } = useApp();

  if (!current) {
    const empfehlung = recommendation
      ? fillHint(translate(recommendation.messageKey), recommendation.params)
      : null;
    return (
      <section className="heute-focus heute-focus--calm" data-testid="heute-section-attention">
        <span className="heute-focus__kicker">
          <i aria-hidden /> {translate('heute.work.nowLabel')}
        </span>
        <h2 className="heute-focus__title" data-testid="home-current-task-empty">
          {translate('heute.work.noneNeeded')}
        </h2>
        {empfehlung && recommendation?.route ? (
          <div className="heute-focus__actions">
            <Link to={recommendation.route} className="heute-focus__go" data-testid="home-current-task-recommendation">
              <Button variant="secondary">{translate('heute.work.ifTime').replace('{text}', empfehlung)}</Button>
            </Link>
          </div>
        ) : null}
      </section>
    );
  }

  const laterItems: DropdownMenuItem[] = SNOOZE_OPTIONS.map(({ duration, key }) => ({
    id: `snooze-${duration}`,
    label: translate(key),
    onSelect: () => {
      snoozeHomeHint(current.id, duration);
      onChange();
    },
    testId: `home-current-task-snooze-${duration}`,
  }));

  return (
    <section
      className="heute-focus"
      data-testid="heute-section-attention"
      aria-label={translate('desk.prioritiesTitle')}
      data-hint-id={current.id}
    >
      <span className="heute-focus__kicker">
        <i aria-hidden /> {translate('heute.work.nowLabel')}
      </span>
      <h2 className="heute-focus__title">{fillHint(translate(current.messageKey), current.params)}</h2>
      <p className="heute-focus__sub">{translate(SUB_KEY[current.severity])}</p>
      <div className="heute-focus__actions" data-testid="home-current-task">
        {current.route ? (
          <Link to={current.route} className="heute-focus__go" data-testid="home-current-task-go">
            <Button>
              {translate('heute.work.open')}
              <Icon id="arrow-right" size="sm" />
            </Button>
          </Link>
        ) : null}
        <DropdownMenu
          testId="home-current-task-later"
          ariaLabel={translate('heute.work.later')}
          align="start"
          trigger={<span className="heute-focus__quiet">{translate('heute.work.later')}</span>}
          items={laterItems}
        />
        <button
          type="button"
          className="heute-focus__quiet"
          data-testid="home-current-task-done"
          onClick={() => {
            dismissHomeHint(current.id, 'done');
            onChange();
          }}
        >
          {translate('heute.work.done')}
        </button>
      </div>
      <div className="heute-focus__stack" aria-hidden>
        <span style={{ ['--r' as string]: '-8deg' }} />
        <span style={{ ['--r' as string]: '-2deg' }} />
        <span style={{ ['--r' as string]: '5deg' }} />
      </div>
    </section>
  );
}
