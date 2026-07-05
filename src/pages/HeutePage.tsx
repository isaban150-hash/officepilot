import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HeuteTodayList } from '../components/heute/HeuteTodayList';
import { Button } from '../components/ui/Button';
import { Card, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { scanDocumentLifecyclePending } from '../services/documentLifecycleService';
import { resolveHeuteQuickActionRoute } from '../services/officeActionService';
import { scanPendingItems } from '../services/pendingEngineService';
import type { TranslationKey } from '../i18n';

const QUICK_ACTION_KEYS: TranslationKey[] = [
  'heute.action.understandLetter',
  'heute.action.writeInvoice',
  'heute.action.captureExpense',
  'heute.action.openOrder',
  'heute.action.writeMessage',
  'heute.action.askOfficePilot',
];

export function HeutePage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [pendingItems] = useState(() => scanPendingItems().items);
  const [lifecycleItems] = useState(() => scanDocumentLifecyclePending());

  const quickActions = useMemo(
    () =>
      QUICK_ACTION_KEYS.map((key) => ({
        key,
        route: resolveHeuteQuickActionRoute(key),
      })).filter((entry): entry is { key: TranslationKey; route: string } => entry.route !== null),
    [],
  );

  return (
    <div className="page heute-page" data-testid="heute-page">
      <PageHeader
        title={translate('heute.title')}
        subtitle={translate('heute.subtitle')}
      />

      <section className="heute-hero" aria-label={translate('heute.scanButton')}>
        <Button
          fullWidth
          className="heute-scan-button"
          data-testid="heute-scan-button"
          onClick={() => navigate('/scan')}
        >
          {translate('heute.scanButton')}
        </Button>
      </section>

      <section className="heute-quick-actions" data-testid="heute-quick-actions">
        <h2 className="heute-section-title">{translate('heute.quickActionsTitle')}</h2>
        <div className="heute-quick-actions__grid">
          {quickActions.map(({ key, route }) => (
            <Link key={key} to={route} className="heute-quick-action">
              {translate(key)}
            </Link>
          ))}
        </div>
      </section>

      <HeuteTodayList items={pendingItems.slice(0, 10)} />

      {lifecycleItems.length > 0 && (
        <section className="heute-lifecycle-list" data-testid="heute-lifecycle-list">
          <Card>
            <CardTitle>{translate('heute.lifecycleTitle')}</CardTitle>
            <HeuteTodayList items={lifecycleItems.slice(0, 8)} />
          </Card>
        </section>
      )}
    </div>
  );
}
