import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { NavIcon } from './NavIcon';
import { DESKTOP_NAV_ITEMS, DESKTOP_SECONDARY_NAV_ITEMS, navLinkTestId, type NavItemConfig } from './navConfig';

/**
 * UIUX-FOUNDATION-01C — Desktop-Sidebar: Hauptzone (Arbeitsbereiche) und
 * eine abgesetzte Sekundärzone. Beides aus `navConfig`; kein Hardcoding.
 * Aktiver Zustand: Klasse + `aria-current="page"` (NavLink) + Markierung.
 */
function SidebarLink({ item, secondary = false }: { item: NavItemConfig; secondary?: boolean }) {
  const { translate } = useApp();
  return (
    <NavLink
      to={item.to}
      end={item.end}
      data-testid={`sidebar-nav-link-${navLinkTestId(item)}`}
      className={({ isActive }) =>
        [
          'sidebar-nav__item',
          secondary ? 'sidebar-nav__item--secondary' : '',
          isActive ? 'sidebar-nav__item--active' : '',
        ]
          .filter(Boolean)
          .join(' ')
      }
    >
      <NavIcon id={item.icon} className="sidebar-nav__icon" />
      <span className="sidebar-nav__label">{translate(item.key)}</span>
    </NavLink>
  );
}

export function SidebarNav() {
  const { translate } = useApp();
  return (
    <nav className="sidebar-nav" aria-label={translate('common.nav.main')} data-testid="sidebar-nav">
      <div className="sidebar-nav__primary" data-testid="sidebar-nav-primary">
        {DESKTOP_NAV_ITEMS.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}
      </div>
      <div className="sidebar-nav__secondary" data-testid="sidebar-nav-secondary">
        <p className="sidebar-nav__secondary-title">{translate('nav.secondaryTitle')}</p>
        {DESKTOP_SECONDARY_NAV_ITEMS.map((item) => (
          <SidebarLink key={item.to} item={item} secondary />
        ))}
      </div>
    </nav>
  );
}
