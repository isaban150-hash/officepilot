import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { buildCustomerSubline } from '../components/customer/CustomerDecisionChoice';
import { getCustomerById } from '../services/customerStoreService';
import { getKundenOverview, type KundeOverviewEntry } from '../services/kundenOverviewService';
import { buildKundenDetailPath } from '../services/kundenWorkspaceService';

export function KundenPage() {
  const { translate } = useApp();
  const [kunden] = useState(() => getKundenOverview());

  /**
   * CUSTOMER-FACHOBJEKT-04E5 — an id-customer always shows its current master
   * record via the existing subline helper; legacy and orphan keep the
   * snapshot-derived address of the overview. The id itself stays invisible.
   */
  const sublineFor = (kunde: KundeOverviewEntry): string => {
    if (kunde.kind !== 'customer') return kunde.addressLine;
    const customer = getCustomerById(kunde.key);
    if (!customer) return kunde.addressLine;
    return buildCustomerSubline(customer, translate('customerDecision.noAddress'));
  };

  return (
    <div className="page kunden-page" data-testid="kunden-page">
      <PageHeader
        title={translate('kunden.title')}
        subtitle={translate('kunden.subtitle')}
      />

      {kunden.length === 0 ? (
        <EmptyStateBlock
          title={translate('kunden.empty.title')}
          description={translate('kunden.empty.desc')}
          testId="kunden-empty-state"
          actions={
            <Link to="/vorgaenge">
              <Button fullWidth>{translate('kunden.empty.action')}</Button>
            </Link>
          }
        />
      ) : (
        <div className="card-list">
          {kunden.map((kunde) => (
            <Link
              key={`${kunde.kind}:${kunde.key}`}
              to={buildKundenDetailPath(kunde)}
              className="card-link"
              data-testid={`kunde-${kunde.kind}-${kunde.key}`}
            >
              <Card>
                {/* A nameless orphan keeps a readable title — never its customerId. */}
                <CardTitle>
                  {kunde.name ||
                    (kunde.kind === 'orphan' ? translate('kunden.orphanBadge') : kunde.name)}
                </CardTitle>
                {sublineFor(kunde) && (
                  <p className="card__meta" data-testid="kunde-address">
                    {sublineFor(kunde)}
                  </p>
                )}
                <CardMeta>
                  {kunde.kind === 'legacy' ? `${translate('kunden.legacyBadge')} · ` : ''}
                  {kunde.kind === 'orphan' ? `${translate('kunden.orphanBadge')} · ` : ''}
                  {translate('kunden.meta.orders').replace('{count}', String(kunde.orderCount))}
                  {kunde.openInvoiceCount > 0
                    ? ` · ${translate('kunden.meta.openInvoices').replace('{count}', String(kunde.openInvoiceCount))}`
                    : ''}
                </CardMeta>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
