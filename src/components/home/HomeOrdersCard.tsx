import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { getAllVorgaenge } from '../../services/vorgangService';

export function HomeOrdersCard() {
  const { translate } = useApp();
  const orderCount = getAllVorgaenge().length;

  return (
    <Link to="/vorgaenge" className="mobile-home-card mobile-home-card--link" data-testid="home-card-orders">
      <span className="mobile-home-card__emoji" aria-hidden>
        📂
      </span>
      <div className="mobile-home-card__content">
        <span className="mobile-home-card__title">{translate('mobile.home.ordersTitle')}</span>
        <span className="mobile-home-card__desc">
          {orderCount > 0
            ? translate('mobile.home.ordersCount').replace('{count}', String(orderCount))
            : translate('mobile.home.ordersEmpty')}
        </span>
      </div>
      <span className="mobile-home-card__chevron" aria-hidden>
        ›
      </span>
    </Link>
  );
}
