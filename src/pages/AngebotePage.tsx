/**
 * ANGEBOT-01B — die Angebote des Betriebs, erreichbar aus dem Bereich Aufträge.
 *
 * Kein eigener Hauptmenüpunkt: Ein Angebot ist die Vorstufe eines Auftrags
 * und lebt deshalb neben den Aufträgen und in der Kundenakte. Eine ruhige
 * Liste — Betreff, Kunde, Datum, Zustand — mit der einen Handlung oben.
 */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page } from '../components/ui/Page';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { OfferStatusBadge } from '../components/offer/OfferStatusBadge';
import { useApp } from '../context/AppContext';
import { formatInvoiceCurrency } from '../services/invoicePrintModel';
import { getOfferTotals, listOffers } from '../services/offer/offerService';

export function AngebotePage() {
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const angebote = useMemo(() => listOffers(), []);
  const datum = (wert: string) => (wert ? new Date(wert).toLocaleDateString(language === 'de' ? 'de-DE' : undefined) : '');

  return (
    <Page className="angebote-page" testId="angebote-page">
      <PageHeader
        title={translate('offer.area.title')}
        subtitle={translate('offer.area.subtitle')}
        primaryAction={
          <Button type="button" onClick={() => navigate('/angebote/neu')} data-testid="offer-new">
            {translate('offer.area.new')}
          </Button>
        }
        secondaryAction={
          <Link to="/vorgaenge" className="btn btn--ghost" data-testid="offer-to-orders">
            {translate('offer.area.tabOrders')}
          </Link>
        }
      />

      {angebote.length === 0 ? (
        <EmptyStateBlock title={translate('offer.area.empty')} description={translate('offer.area.emptyHint')} testId="offer-empty" />
      ) : (
        <BusinessList testId="offer-list">
          {angebote.map((offer) => (
            <BusinessListItem
              key={offer.id}
              testId={`offer-row-${offer.id}`}
              linkTestId={`offer-open-${offer.id}`}
              to={`/angebote/${offer.id}`}
              title={`${offer.offerNumber ? `${offer.offerNumber} · ` : ''}${offer.title || translate('offer.status.entwurf')}`}
              subtitle={`${offer.customer.name}${offer.customer.name ? ' · ' : ''}${formatInvoiceCurrency(getOfferTotals(offer).total)}`}
              date={datum(offer.offerDate)}
              status={<OfferStatusBadge offer={offer} />}
            />
          ))}
        </BusinessList>
      )}
    </Page>
  );
}
