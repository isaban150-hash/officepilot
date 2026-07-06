import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { resolveHeuteQuickActionRoute } from '../../services/officeActionService';
import type { TranslationKey } from '../../i18n';
import { HeuteActionIcon, type HeuteActionIconId } from './HeuteActionIcon';

interface QuickActionConfig {
  id: string;
  icon: HeuteActionIconId;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  route: string;
}

export function HeuteQuickActionCards() {
  const { translate } = useApp();

  const actions = useMemo<QuickActionConfig[]>(() => {
    const invoiceRoute =
      resolveHeuteQuickActionRoute('heute.action.writeInvoice') ?? '/rechnungen/offen';

    return [
      {
        id: 'scan',
        icon: 'scan',
        titleKey: 'heute.card.scan.title',
        descKey: 'heute.card.scan.desc',
        route: '/scan',
      },
      {
        id: 'understand',
        icon: 'understand',
        titleKey: 'heute.card.understand.title',
        descKey: 'heute.card.understand.desc',
        route: '/scan',
      },
      {
        id: 'invoice',
        icon: 'invoice',
        titleKey: 'heute.card.invoice.title',
        descKey: 'heute.card.invoice.desc',
        route: invoiceRoute,
      },
      {
        id: 'expense',
        icon: 'expense',
        titleKey: 'heute.card.expense.title',
        descKey: 'heute.card.expense.desc',
        route: '/ausgaben/neu',
      },
      {
        id: 'message',
        icon: 'message',
        titleKey: 'heute.card.message.title',
        descKey: 'heute.card.message.desc',
        route: '/kommunikation',
      },
      {
        id: 'search',
        icon: 'search',
        titleKey: 'heute.card.search.title',
        descKey: 'heute.card.search.desc',
        route: '/suche',
      },
    ];
  }, []);

  return (
    <section className="heute-quick-actions" data-testid="heute-quick-actions">
      <h2 className="heute-section-title">{translate('heute.quickActionsTitle')}</h2>
      <div className="heute-quick-actions__grid">
        {actions.map((action) => (
          <Link
            key={action.id}
            to={action.route}
            className="heute-action-card"
            data-testid={`heute-action-${action.id}`}
          >
            <span className="heute-action-card__icon-wrap">
              <HeuteActionIcon id={action.icon} />
            </span>
            <span className="heute-action-card__body">
              <span className="heute-action-card__title">{translate(action.titleKey)}</span>
              <span className="heute-action-card__desc">{translate(action.descKey)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
