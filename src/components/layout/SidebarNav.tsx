import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { NavIcon } from './NavIcon';
import { MAIN_NAV_ITEMS } from './navConfig';

export function SidebarNav() {
  const { translate } = useApp();

  return (
    <nav className="sidebar-nav" aria-label="Hauptnavigation" data-testid="sidebar-nav">
      {MAIN_NAV_ITEMS.map(({ to, key, icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `sidebar-nav__item ${isActive ? 'sidebar-nav__item--active' : ''}`
          }
        >
          <NavIcon id={icon} className="sidebar-nav__icon" />
          <span className="sidebar-nav__label">{translate(key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
