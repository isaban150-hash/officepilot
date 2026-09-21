import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { formatInvoiceCurrency, formatInvoiceDate } from '../../services/invoicePrintModel';
import { getOfferById, getOfferTotals } from '../../services/offer/offerService';
import { DetailSection, SummaryList } from '../ui/Section';
import { DataRow } from '../ui/Card';
import { OfferStatusBadge } from './OfferStatusBadge';

/**
 * ANGEBOT-01B — die Archivansicht eines **eigenen** Angebots.
 *
 * OfficeTakt hat dieses Dokument selbst erzeugt und kennt Kunde, Nummer,
 * Gültigkeit und Zustand. Es gibt nichts zu erraten: Statt der heuristischen
 * Deutung für eingehende Post (Fristen, Handlungsbedarf, mögliche Kunden)
 * stehen hier die Fakten aus dem Angebot und der Weg dorthin. Die Gültigkeit
 * ist die Gültigkeit des Angebots — keine Frist, die der Betrieb einhalten
 * müsste.
 */
export function OwnOfferArchiveCard({ offerId }: { offerId: string }) {
  const { translate } = useApp();
  const offer = getOfferById(offerId);
  if (!offer) return null;
  return (
    <DetailSection title={translate('offer.archive.title')} testId="own-offer-archive-card">
      <SummaryList columns={1}>
        <DataRow label={translate('offer.number')} value={offer.offerNumber ?? translate('offer.status.entwurf')} />
        <DataRow label={translate('offer.editor.customer')} value={offer.customer.name} />
        <DataRow label={translate('offer.editor.title')} value={offer.title} />
        <DataRow label={translate('offer.validUntil')} value={formatInvoiceDate(offer.validUntil)} />
        <DataRow label={translate('offer.total')} value={formatInvoiceCurrency(getOfferTotals(offer).total)} />
        <DataRow label={translate('offer.archive.status')} value={<OfferStatusBadge offer={offer} />} />
      </SummaryList>
      <p className="form-hint">{translate('offer.archive.hint')}</p>
      <Link to={`/angebote/${offer.id}`} className="btn btn--secondary" data-testid="own-offer-archive-open">
        {translate('offer.archive.open')}
      </Link>
    </DetailSection>
  );
}
