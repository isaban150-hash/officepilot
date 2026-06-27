import { NavLink } from 'react-router-dom';
import { useApp } from '../../context/AppContext';

const NAV_ITEMS = [
  { to: '/eingang', key: 'nav.eingang' as const, icon: '📥' },
  { to: '/aufgaben', key: 'nav.aufgaben' as const, icon: '✅' },
  { to: '/vorgaenge', key: 'nav.vorgaenge' as const, icon: '📋' },
  { to: '/assistent', key: 'nav.assistent' as const, icon: '💬' },
];

export function BottomNav() {
  const { translate } = useApp();

  return (
    <nav className="bottom-nav" aria-label="Hauptnavigation">
      {NAV_ITEMS.map(({ to, key, icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `bottom-nav__item ${isActive ? 'bottom-nav__item--active' : ''}`}
        >
          <span className="bottom-nav__icon" aria-hidden>{icon}</span>
          <span className="bottom-nav__label">{translate(key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
