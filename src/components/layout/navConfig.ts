import type { TranslationKey } from '../../i18n';
import type { NavIconId } from './NavIcon';

export interface NavItemConfig {
  to: string;
  key: TranslationKey;
  icon: NavIconId;
  end?: boolean;
  featured?: boolean;
}

/** Desktop sidebar: all 6 main areas including Steuerberater. */
export const DESKTOP_NAV_ITEMS: NavItemConfig[] = [
  { to: '/', key: 'nav.schreibtisch', icon: 'home', end: true },
  { to: '/ablage', key: 'nav.dokumente', icon: 'documents' },
  { to: '/vorgaenge', key: 'nav.auftraege', icon: 'orders' },
  { to: '/assistent', key: 'nav.officepilot', icon: 'assistant' },
  { to: '/steuerberater', key: 'nav.steuerberater', icon: 'tax' },
  { to: '/mehr', key: 'nav.mehr', icon: 'more' },
];

/** Mobile bottom nav: max 5 – Kunden & Steuerberater via Schreibtisch-Kacheln. */
export const MOBILE_BOTTOM_NAV_ITEMS: NavItemConfig[] = [
  { to: '/', key: 'nav.schreibtisch', icon: 'home', end: true },
  { to: '/ablage', key: 'nav.dokumente', icon: 'documents' },
  { to: '/vorgaenge', key: 'nav.auftraege', icon: 'orders' },
  { to: '/assistent', key: 'nav.officepilot', icon: 'assistant' },
  { to: '/mehr', key: 'nav.mehr', icon: 'more' },
];

/** @deprecated Use DESKTOP_NAV_ITEMS or MOBILE_BOTTOM_NAV_ITEMS */
export const MAIN_NAV_ITEMS = DESKTOP_NAV_ITEMS;
