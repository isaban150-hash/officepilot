import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Badge, Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
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
  const [vorgaenge, setVorgaenge] = useState(getAllVorgaenge);

  useEffect(() => {
    setVorgaenge(getAllVorgaenge());
  }, [location.pathname, location.key]);

  return (
    <div className="page">
      <PageHeader title={translate('vorgaenge.title')} subtitle={translate('vorgaenge.subtitle')} />

      <div className="page-header__actions">
        <Link to="/rechnungen/offen">
          <Button variant="outline" fullWidth>
            {translate('vorgaenge.openInvoices')}
          </Button>
        </Link>
      </div>

      {vorgaenge.length === 0 ? (
        <p className="empty-state">{translate('vorgaenge.empty')}</p>
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
                    {v.documents.length} Dok. · {v.tasks.filter((t) => !t.done).length} Aufgaben
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
