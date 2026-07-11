import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HeuteDashboardCards } from '../components/heute/HeuteDashboardCards';
import { HeuteOpenItems } from '../components/heute/HeuteOpenItems';
import { HeuteQuickActionCards } from '../components/heute/HeuteQuickActionCards';
import { HeuteWelcomeState } from '../components/heute/HeuteWelcomeState';
import { Button } from '../components/ui/Button';
import { useApp } from '../context/AppContext';
import { scanDocumentLifecyclePending } from '../services/documentLifecycleService';
import {
  getHeuteDashboardStats,
  isHeuteFirstRunState,
} from '../services/heuteDashboardService';

export function HeutePage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const [{ dashboardStats, isFirstRun, openItems }] = useState(() => {
    const firstRun = isHeuteFirstRunState();
    return {
      dashboardStats: getHeuteDashboardStats(),
      isFirstRun: firstRun,
      openItems: firstRun ? [] : scanDocumentLifecyclePending().slice(0, 5),
    };
  });

  const showOpenItems = useMemo(
    () => !isFirstRun && openItems.length > 0,
    [isFirstRun, openItems.length],
  );

  return (
    <div className="page heute-page" data-testid="heute-page">
      <section className="heute-hero" data-testid="heute-hero">
        <div className="heute-hero__copy">
          <h1 className="heute-hero__title">{translate('heute.hero.title')}</h1>
          <p className="heute-hero__subtitle">{translate('heute.hero.subtitle')}</p>
        </div>
        <div className="heute-hero__actions">
          <Button
            fullWidth
            size="lg"
            variant="on-dark"
            data-testid="heute-scan-button"
            onClick={() => navigate('/scan')}
          >
            {translate('heute.hero.scan')}
          </Button>
          <Button
            fullWidth
            size="lg"
            variant="on-dark-outline"
            data-testid="heute-ask-button"
            onClick={() => navigate('/assistent')}
          >
            {translate('heute.hero.ask')}
          </Button>
        </div>
      </section>

      <HeuteDashboardCards stats={dashboardStats} />

      {isFirstRun ? <HeuteWelcomeState /> : null}

      <HeuteQuickActionCards />

      {showOpenItems ? <HeuteOpenItems items={openItems} /> : null}
    </div>
  );
}
