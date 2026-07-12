import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { getKundenOverview } from '../services/kundenOverviewService';

export function KundenPage() {
  const { translate } = useApp();
  const [kunden] = useState(() => getKundenOverview());

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
            <Link key={kunde.name} to="/vorgaenge" className="card-link" data-testid={`kunde-${kunde.name}`}>
              <Card>
                <CardTitle>{kunde.name}</CardTitle>
                <CardMeta>
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
