import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { NavIcon } from './NavIcon';
import { MOBILE_BOTTOM_NAV_ITEMS } from './navConfig';

export function BottomNav() {
  const { translate } = useApp();

  return (
    <nav className="bottom-nav" aria-label={translate('common.nav.main')} data-testid="bottom-nav">
      {MOBILE_BOTTOM_NAV_ITEMS.map(({ to, key, icon, end, featured }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            [
              'bottom-nav__item',
              isActive ? 'bottom-nav__item--active' : '',
              featured ? 'bottom-nav__item--featured' : '',
            ]
              .filter(Boolean)
              .join(' ')
          }
        >
          <span className="bottom-nav__icon-wrap">
            <NavIcon id={icon} className="bottom-nav__icon" />
          </span>
          <span className="bottom-nav__label">{translate(key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
