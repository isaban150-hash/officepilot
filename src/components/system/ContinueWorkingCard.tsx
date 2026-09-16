import { Button } from '../ui/Button';
import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import { formatUiSessionRelativeTime } from '../../services/uiSession/uiSessionRestore';
import type { TranslationKey } from '../../i18n';

type ContinueWorkingCardProps = {
  snapshot: UiSessionSnapshot;
  translate: (key: TranslationKey) => string;
  onContinue: () => void;
  onDiscard: () => void;
};

export function ContinueWorkingCard({
  snapshot,
  translate,
  onContinue,
  onDiscard,
}: ContinueWorkingCardProps) {
  const relative = formatUiSessionRelativeTime(snapshot.savedAt);

  /*
   * VISUAL-POLISH-01B — kompakter Hinweis statt Vollbreiten-Banner: eine Zeile
   * mit Kontext (Eyebrow · Titel · Zeit) und zwei kleinen Aktionen. Die
   * Wiederaufnahme-/Verwerfen-Logik ist unverändert (gleiche Test-IDs).
   */
  return (
    <div className="continue-working-card" data-testid="continue-working-card" role="status">
      <div className="continue-working-card__text">
        <p className="continue-working-card__eyebrow">
          {translate('uiSession.continue.title')}
          {relative ? (
            <>
              {' · '}
              <span className="continue-working-card__time" data-testid="continue-working-time">
                {relative}
              </span>
            </>
          ) : null}
        </p>
        <p className="continue-working-card__headline" data-testid="continue-working-headline">
          {snapshot.resumeLabel.titleText}
          {snapshot.resumeLabel.subtitleText ? (
            <span className="continue-working-card__subtitle" data-testid="continue-working-subtitle">
              {' · '}
              {snapshot.resumeLabel.subtitleText}
            </span>
          ) : null}
          {snapshot.resumeLabel.entityHint ? (
            <span className="continue-working-card__hint">{' · '}{snapshot.resumeLabel.entityHint}</span>
          ) : null}
          {snapshot.drafts.dirty ? (
            <span className="continue-working-card__drafts" data-testid="continue-working-drafts">
              {' · '}
              {translate('uiSession.continue.unsaved')}
            </span>
          ) : null}
        </p>
      </div>
      <div className="continue-working-card__actions">
        <Button size="sm" onClick={onContinue} data-testid="continue-working-accept">
          {translate('uiSession.continue.accept')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard} data-testid="continue-working-discard">
          {translate('uiSession.continue.discard')}
        </Button>
      </div>
    </div>
  );
}
