import type { TranslationKey } from '../../i18n';

export interface NavItemConfig {
  to: string;
  key: TranslationKey;
  icon: string;
  end?: boolean;
}

export const MAIN_NAV_ITEMS: NavItemConfig[] = [
  { to: '/', key: 'nav.heute', icon: '🏠', end: true },
  { to: '/vorgaenge', key: 'nav.auftraege', icon: '📋' },
  { to: '/scan', key: 'nav.scan', icon: '📷' },
  { to: '/ablage', key: 'nav.ablage', icon: '📁' },
  { to: '/mehr', key: 'nav.mehr', icon: '⋯' },
];
