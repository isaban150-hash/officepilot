import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { NavIcon } from '../layout/NavIcon';

export function HomeMoreCard() {
  const { translate } = useApp();

  return (
    <Link to="/mehr" className="mobile-home-card mobile-home-card--link mobile-home-card--more" data-testid="home-card-more">
      <NavIcon id="more" className="mobile-home-card__icon" />
      <div className="mobile-home-card__content">
        <span className="mobile-home-card__title">{translate('mobile.home.moreTitle')}</span>
        <span className="mobile-home-card__desc">{translate('mobile.home.moreDesc')}</span>
      </div>
      <span className="mobile-home-card__chevron" aria-hidden>
        ›
      </span>
    </Link>
  );
}
