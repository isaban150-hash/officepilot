import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { NavIcon } from './NavIcon';
import { MOBILE_BOTTOM_NAV_ITEMS, navLinkTestId } from './navConfig';

/**
 * UIUX-FOUNDATION-01C — Mobile Bottom-Navigation: exakt fünf Ziele aus
 * `navConfig` (vier Hauptbereiche + „Mehr“). Aktiver Zustand über Farbe,
 * Icon-Fläche, Textgewicht und `aria-current` — nicht nur Farbe.
 */
export function BottomNav() {
  const { translate } = useApp();
  return (
    <nav className="bottom-nav" aria-label={translate('common.nav.main')} data-testid="bottom-nav">
      {MOBILE_BOTTOM_NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          data-testid={`bottom-nav-link-${navLinkTestId(item)}`}
          className={({ isActive }) =>
            [
              'bottom-nav__item',
              isActive ? 'bottom-nav__item--active' : '',
              item.featured ? 'bottom-nav__item--featured' : '',
            ]
              .filter(Boolean)
              .join(' ')
          }
        >
          <span className="bottom-nav__icon-wrap">
            <NavIcon id={item.icon} className="bottom-nav__icon" />
          </span>
          <span className="bottom-nav__label">{translate(item.key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
