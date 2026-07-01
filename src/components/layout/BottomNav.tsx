import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { MAIN_NAV_ITEMS } from './navConfig';

export function BottomNav() {
  const { translate } = useApp();

  return (
    <nav className="bottom-nav" aria-label="Hauptnavigation" data-testid="bottom-nav">
      {MAIN_NAV_ITEMS.map(({ to, key, icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `bottom-nav__item ${isActive ? 'bottom-nav__item--active' : ''}`
          }
        >
          <span className="bottom-nav__icon" aria-hidden>
            {icon}
          </span>
          <span className="bottom-nav__label">{translate(key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
