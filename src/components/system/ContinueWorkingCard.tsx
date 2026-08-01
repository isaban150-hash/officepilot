import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
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

  return (
    <Card className="continue-working-card" data-testid="continue-working-card" highlight>
      <p className="continue-working-card__eyebrow">
        {translate('uiSession.continue.title')}
      </p>
      <h2 className="continue-working-card__headline" data-testid="continue-working-headline">
        {snapshot.resumeLabel.titleText}
      </h2>
      {snapshot.resumeLabel.subtitleText ? (
        <p className="continue-working-card__subtitle" data-testid="continue-working-subtitle">
          {snapshot.resumeLabel.subtitleText}
        </p>
      ) : null}
      {snapshot.resumeLabel.entityHint ? (
        <p className="continue-working-card__hint">{snapshot.resumeLabel.entityHint}</p>
      ) : null}
      {relative ? (
        <p className="continue-working-card__time" data-testid="continue-working-time">
          {relative}
        </p>
      ) : null}
      {snapshot.drafts.dirty ? (
        <p className="continue-working-card__drafts" data-testid="continue-working-drafts">
          {translate('uiSession.continue.unsaved')}
        </p>
      ) : null}
      <div className="continue-working-card__actions">
        <Button fullWidth onClick={onContinue} data-testid="continue-working-accept">
          {translate('uiSession.continue.accept')}
        </Button>
        <Button
          fullWidth
          variant="ghost"
          onClick={onDiscard}
          data-testid="continue-working-discard"
        >
          {translate('uiSession.continue.discard')}
        </Button>
      </div>
    </Card>
  );
}
