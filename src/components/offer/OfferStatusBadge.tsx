import { useApp } from '../../context/AppContext';
import { isOfferExpired } from '../../services/offer/offerService';
import type { Offer, OfferStatus } from '../../types/offer';
import { StatusBadge } from '../ui/Badge';
import type { TranslationKey } from '../../i18n';
import type { StatusTone } from '../../services/ui/statusTone';

/**
 * ANGEBOT-01B — der Zustand eines Angebots in einem Wort.
 * „Abgelaufen" ist berechnet (Gültigkeit vorbei, keine Entscheidung), nie gespeichert.
 */
const TONE: Record<OfferStatus | 'abgelaufen', StatusTone> = {
  entwurf: 'neutral',
  freigegeben: 'info',
  versendet: 'info',
  angenommen: 'success',
  abgelehnt: 'critical',
  storniert: 'neutral',
  ersetzt: 'neutral',
  abgelaufen: 'warning',
};

export function OfferStatusBadge({ offer }: { offer: Pick<Offer, 'status' | 'validUntil'> }) {
  const { translate } = useApp();
  const key: OfferStatus | 'abgelaufen' = isOfferExpired(offer) ? 'abgelaufen' : offer.status;
  return (
    <StatusBadge
      tone={TONE[key]}
      label={translate(`offer.status.${key}` as TranslationKey)}
      icon={false}
      data-testid="offer-status"
    />
  );
}
