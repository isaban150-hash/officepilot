import { useApp } from '../../context/AppContext';
import { Button } from '../ui/Button';

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27, X-02/X-03) — das Angebot eines Entwurfs („Fortsetzen“ / „Verwerfen“) und der
 * Hinweis auf einen verworfenen veralteten Entwurf.
 */
export function FormResumeOffer({
  pending,
  stale,
  onContinue,
  onDiscard,
  onDismissStale,
  testIdPrefix,
}: {
  pending: boolean;
  stale: boolean;
  onContinue: () => void;
  onDiscard: () => void;
  onDismissStale: () => void;
  testIdPrefix: string;
}) {
  const { translate } = useApp();
  if (!pending && !stale) return null;
  return (
    <div className="settings-form__notice form-resume-offer" role="status" data-testid={`${testIdPrefix}-resume`} data-state={pending ? 'offer' : 'stale'}>
      {pending ? (
        <>
          <p>{translate('formResume.offer')}</p>
          <div className="form-actions">
            <Button type="button" onClick={onContinue} data-testid={`${testIdPrefix}-resume-continue`}>
              {translate('formResume.continue')}
            </Button>
            <Button type="button" variant="outline" onClick={onDiscard} data-testid={`${testIdPrefix}-resume-discard`}>
              {translate('formResume.discard')}
            </Button>
          </div>
        </>
      ) : (
        <p>
          {translate('formResume.stale')}{' '}
          <Button type="button" variant="ghost" onClick={onDismissStale} data-testid={`${testIdPrefix}-resume-stale-ok`}>
            {translate('common.close')}
          </Button>
        </p>
      )}
    </div>
  );
}
