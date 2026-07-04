import type { TranslationKey } from '../../i18n';
import type { NavIconId } from './NavIcon';

export interface NavItemConfig {
  to: string;
  key: TranslationKey;
  icon: NavIconId;
  end?: boolean;
  featured?: boolean;
}

export const MAIN_NAV_ITEMS: NavItemConfig[] = [
  { to: '/', key: 'nav.heute', icon: 'home', end: true },
  { to: '/vorgaenge', key: 'nav.auftraege', icon: 'orders' },
  { to: '/scan', key: 'nav.scan', icon: 'scan', featured: true },
  { to: '/ablage', key: 'nav.ablage', icon: 'archive' },
  { to: '/mehr', key: 'nav.mehr', icon: 'more' },
];
