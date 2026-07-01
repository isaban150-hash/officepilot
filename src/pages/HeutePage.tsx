import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HeuteTodayList } from '../components/heute/HeuteTodayList';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { scanPendingItems } from '../services/pendingEngineService';
import type { TranslationKey } from '../i18n';

const QUICK_ACTIONS: { key: TranslationKey; route: string }[] = [
  { key: 'heute.action.understandLetter', route: '/scan' },
  { key: 'heute.action.writeInvoice', route: '/vorgaenge' },
  { key: 'heute.action.captureExpense', route: '/ausgaben/neu' },
  { key: 'heute.action.openOrder', route: '/vorgaenge' },
  { key: 'heute.action.writeMessage', route: '/kommunikation' },
  { key: 'heute.action.askOfficePilot', route: '/assistent' },
];

export function HeutePage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [pendingItems] = useState(() => scanPendingItems().items);

  return (
    <div className="page heute-page" data-testid="heute-page">
      <PageHeader
        title={translate('heute.title')}
        subtitle={translate('heute.subtitle')}
      />

      <div className="heute-scan-cta">
        <Button
          fullWidth
          className="heute-scan-button"
          data-testid="heute-scan-button"
          onClick={() => navigate('/scan')}
        >
          {translate('heute.scanButton')}
        </Button>
      </div>

      <section className="heute-quick-actions" data-testid="heute-quick-actions">
        <h2 className="heute-section-title">{translate('heute.quickActionsTitle')}</h2>
        <div className="heute-quick-actions__grid">
          {QUICK_ACTIONS.map(({ key, route }) => (
            <Link key={key} to={route} className="heute-quick-action">
              {translate(key)}
            </Link>
          ))}
        </div>
      </section>

      <HeuteTodayList items={pendingItems.slice(0, 10)} />
    </div>
  );
}
