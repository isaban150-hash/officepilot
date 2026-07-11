import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Badge, Card, CardMeta, CardTitle } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { getAllVorgaenge } from '../services/vorgangService';
import type { TranslationKey } from '../i18n';

const STATUS_TONE: Record<string, 'default' | 'info' | 'warning' | 'success'> = {
  neu: 'info',
  in_bearbeitung: 'warning',
  wartet: 'default',
  abgeschlossen: 'success',
};

export function VorgaengePage() {
  const { translate } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [vorgaenge, setVorgaenge] = useState(getAllVorgaenge);

  useEffect(() => {
    setVorgaenge(getAllVorgaenge());
  }, [location.pathname, location.key]);

  return (
    <div className="page">
      <PageHeader
        title={translate('vorgaenge.title')}
        subtitle={translate('vorgaenge.subtitle')}
        secondaryAction={
          <Link to="/rechnungen/offen">
            <Button variant="outline">{translate('vorgaenge.openInvoices')}</Button>
          </Link>
        }
      />

      {vorgaenge.length === 0 ? (
        <EmptyStateBlock
          title={translate('vorgaenge.empty.title')}
          description={translate('vorgaenge.empty.desc')}
          testId="vorgaenge-empty-state"
          actions={
            <Button fullWidth onClick={() => navigate('/scan')}>
              {translate('vorgaenge.empty.action')}
            </Button>
          }
        />
      ) : (
        <div className="card-list">
          {vorgaenge.map((v) => {
            const statusKey = `status.${v.status}` as TranslationKey;
            const materialKey = `material.${v.materialSource}` as TranslationKey;
            return (
              <Link key={v.id} to={`/vorgaenge/${v.id}`} className="card-link">
                <Card>
                  <CardTitle>{v.title}</CardTitle>
                  <CardMeta>{v.customer} · {v.baustelle}</CardMeta>
                  <div className="badge-row">
                    <Badge tone={STATUS_TONE[v.status]}>{translate(statusKey)}</Badge>
                    <Badge>{translate(materialKey)}</Badge>
                  </div>
                  <CardMeta>
                    {translate('vorgaenge.meta.documents').replace('{count}', String(v.documents.length))}
                    {' · '}
                    {translate('vorgaenge.meta.tasks').replace(
                      '{count}',
                      String(v.tasks.filter((t) => !t.done).length),
                    )}
                  </CardMeta>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
