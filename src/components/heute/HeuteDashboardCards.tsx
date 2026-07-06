import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { HeuteDashboardStats } from '../../services/heuteDashboardService';
import type { TranslationKey } from '../../i18n';
import { HeuteActionIcon, type HeuteActionIconId } from './HeuteActionIcon';

interface DashboardCardConfig {
  key: 'openDocuments' | 'openInvoices' | 'deadlinesThisWeek' | 'tasksToday';
  route: string;
  icon: HeuteActionIconId;
  titleKey: TranslationKey;
  emptyKey: TranslationKey;
}

const DASHBOARD_CARDS: DashboardCardConfig[] = [
  {
    key: 'openDocuments',
    route: '/ablage',
    icon: 'document',
    titleKey: 'heute.dashboard.openDocuments',
    emptyKey: 'heute.dashboard.openDocumentsEmpty',
  },
  {
    key: 'openInvoices',
    route: '/rechnungen/offen',
    icon: 'invoice',
    titleKey: 'heute.dashboard.openInvoices',
    emptyKey: 'heute.dashboard.openInvoicesEmpty',
  },
  {
    key: 'deadlinesThisWeek',
    route: '/aufgaben',
    icon: 'calendar',
    titleKey: 'heute.dashboard.deadlinesWeek',
    emptyKey: 'heute.dashboard.deadlinesWeekEmpty',
  },
  {
    key: 'tasksToday',
    route: '/aufgaben',
    icon: 'task',
    titleKey: 'heute.dashboard.tasksToday',
    emptyKey: 'heute.dashboard.tasksTodayEmpty',
  },
];

interface HeuteDashboardCardsProps {
  stats: HeuteDashboardStats;
}

export function HeuteDashboardCards({ stats }: HeuteDashboardCardsProps) {
  const { translate } = useApp();

  return (
    <section className="heute-dashboard" data-testid="heute-dashboard">
      <h2 className="heute-section-title">{translate('heute.dashboardTitle')}</h2>
      <div className="heute-dashboard__grid">
        {DASHBOARD_CARDS.map(({ key, route, icon, titleKey, emptyKey }) => {
          const value = stats[key];
          const hasValue = value > 0;

          return (
            <Link key={key} to={route} className="heute-dashboard-card">
              <span className="heute-dashboard-card__icon-wrap">
                <HeuteActionIcon id={icon} />
              </span>
              <span className="heute-dashboard-card__content">
                <span className="heute-dashboard-card__label">{translate(titleKey)}</span>
                {hasValue ? (
                  <span className="heute-dashboard-card__value">{value}</span>
                ) : (
                  <span className="heute-dashboard-card__empty">{translate(emptyKey)}</span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
