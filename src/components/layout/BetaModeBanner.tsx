import { useApp } from '../../context/AppContext';
import { isBetaTestMode } from '../../config/betaTestMode';

export function BetaModeBanner() {
  const { translate } = useApp();

  if (!isBetaTestMode()) return null;

  return (
    <p className="beta-mode-banner" data-testid="beta-mode-banner">
      {translate('beta.banner')}
    </p>
  );
}
